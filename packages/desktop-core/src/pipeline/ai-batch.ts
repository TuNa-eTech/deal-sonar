// Port of crates/core/src/pipeline/ai_batch.rs: T5 AI batch evaluation jobs, prompt context and
// ruleset auto-compile scheduling. The AI bridge itself is injected (`PipelineHooks.ai`).

import { CoreError } from "../backend/wire";
import type { RadarVersionRecord } from "../store/radars";
import type { PendingAiEvaluationItem } from "../store/leads";
import { extractedFieldAiToRules, extractedFieldStoreToRules } from "./dto";
import { finalizeCandidateEvaluation } from "./finalize";
import type { PipelineRuntime } from "./runtime";
import { reconcileShadowWithAiTruth } from "./shadow";
import {
  AiHookError,
  type AiCallTelemetry,
  type AiHooks,
  type AiWantIntent,
  type BatchConfig,
  type CandidateDecision,
  type EvalMode,
  type PipelineAuthorRole,
  type PostPromptInput,
  type RadarPromptContext,
} from "./types";

export const LIVE_BATCH: BatchConfig = { max_posts: 20, preview: false };
export const PREVIEW_BATCH: BatchConfig = { max_posts: 10, preview: true };

/** `CoreError::Ai` for a thrown AI failure (Display = `lỗi AI Bridge: <detail>`). */
export function aiCoreError(err: unknown): CoreError {
  const detail = err instanceof Error ? err.message : String(err);
  return new CoreError("ai", `lỗi AI Bridge: ${detail}`);
}

export function requireAi(rt: PipelineRuntime): AiHooks {
  const ai = rt.hooks.ai;
  if (!ai) throw new CoreError("ai", "lỗi AI Bridge: AI bridge chưa được cấu hình trong bản Electron");
  return ai;
}

export function callStatusOf(err: unknown): AiCallTelemetry["status"] {
  return err instanceof AiHookError ? err.callStatus() : "error";
}

/** Persist the telemetry of every provider call; returns the id of the last one. */
export function recordAiCalls(rt: PipelineRuntime, calls: readonly AiCallTelemetry[], now: number, taskOverride?: string): string | null {
  let last: string | null = null;
  for (const c of calls) {
    const saved = rt.store.aiCalls.record({
      id: null,
      provider: c.provider,
      model: c.model,
      task: taskOverride ?? c.task,
      radar_version_id: c.radar_version_id,
      item_count: c.item_count,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      cost_usd: c.cost_usd,
      duration_ms: c.duration_ms,
      status: c.status,
      error: c.error,
      now_ms: now,
    });
    last = saved.id;
  }
  return last;
}

/** Persist attempts attached by the AI bridge when a task aborts. */
export function recordFailedAiCalls(rt: PipelineRuntime, err: unknown, now: number): string | null {
  return err instanceof AiHookError ? recordAiCalls(rt, err.calls, now) : null;
}

/** Schedule or wake `evaluate_batch:<radar_version_id>` (`05-pipeline-rules.md §7`). */
export function scheduleEvaluateBatchJob(rt: PipelineRuntime, radarVersionId: string, immediate: boolean, now: number): void {
  const pending = rt.store.leads.listPendingAiForVersion(radarVersionId, false, rt.config.batchTriggerCount + 1);
  if (pending.length === 0) return;
  const oldest = Math.min(...pending.map((p) => p.evaluation.created_at));
  const readyNow = immediate || pending.length >= rt.config.batchTriggerCount || now - oldest >= rt.config.batchMaxWaitMs;
  const runAt = readyNow ? now : oldest + rt.config.batchMaxWaitMs;
  rt.store.jobs.enqueue("evaluate_batch", `evaluate_batch:${radarVersionId}`, { radar_version_id: radarVersionId, silent: immediate }, runAt, now);
  if (readyNow) rt.wakeJobs();
}

/** Radar context with up to 8 balanced feedback examples (`06-ai-bridge.md §5.2`). */
export function buildRadarPromptContext(rt: PipelineRuntime, ver: RadarVersionRecord): RadarPromptContext {
  let examples: ReturnType<PipelineRuntime["store"]["leads"]["getPromptFeedbackExamples"]> = [];
  try {
    examples = rt.store.leads.getPromptFeedbackExamples(ver.id, 8);
  } catch {
    examples = [];
  }
  const wantIntent: AiWantIntent =
    ver.match_policy.want_intent === "demand" ? "demand" : ver.match_policy.want_intent === "supply" ? "supply" : "any";
  return {
    radar_version_id: ver.id,
    description: ver.description,
    user_profession: ver.user_profession,
    language_hint: ver.language_hint,
    want_intent: wantIntent,
    exclude_roles: ver.match_policy.exclude_roles.map((r): PipelineAuthorRole => (r === "peer" ? "peer" : r === "end_user" ? "end_user" : "unknown")),
    fields: ver.fields,
    feedback_examples: examples.map((fb) => ({
      is_positive: fb.expected_match,
      label: fb.label,
      post_text: fb.post_text,
      author_role: fb.label === "peer" ? "peer" : null,
      corrected_fields: fb.corrected_fields
        ? Object.fromEntries(Object.keys(fb.corrected_fields).sort().map((k) => [k, (fb.corrected_fields ?? {})[k].value]))
        : null,
    })),
  };
}

/** Privacy-sanitized prompt posts (no author external id / permalink). */
export function toPromptPosts(items: readonly PendingAiEvaluationItem[]): PostPromptInput[] {
  return items.map((item, idx) => {
    const hints = item.evaluation.fields;
    const ruleHints =
      hints && Object.keys(hints).length > 0
        ? Object.fromEntries(Object.keys(hints).sort().map((k) => [k, hints[k].value]))
        : null;
    return {
      post_id: item.post.id,
      ref: idx + 1,
      group_name: item.source_name,
      author_name: item.author_name,
      created_at_ms: item.post.created_at,
      text: item.post.text_norm ?? item.post.text ?? "",
      rule_hints: ruleHints,
    };
  });
}

/** Merge T4 hints with AI fields (AI wins per key; T6 renormalization lets built-in extractors override). */
export function mergeCandidateFields(
  item: PendingAiEvaluationItem,
  aiFields: Record<string, { raw: string | null; value: unknown; confidence: number }>,
): CandidateDecision["candidateFields"] {
  const merged: CandidateDecision["candidateFields"] = {};
  for (const [k, v] of Object.entries(item.evaluation.fields ?? {})) {
    const rf = extractedFieldStoreToRules(v);
    if (rf) merged[k] = rf;
  }
  for (const [k, c] of Object.entries(aiFields)) {
    const ef = extractedFieldAiToRules(c);
    if (ef) merged[k] = ef;
  }
  return merged;
}

/** Execute T5 AI batch evaluation for `radarVersionId`. Returns the number of posts finalized. */
export async function runEvaluateBatchForVersion(rt: PipelineRuntime, radarVersionId: string, forceSilent: boolean): Promise<number> {
  if (rt.shuttingDown) throw CoreError.shuttingDown();
  const now = rt.now();

  // Honor an active rate-limit backoff window.
  if (rt.aiHealth.rateLimitResetAt !== null && rt.aiHealth.rateLimitResetAt > now) {
    rt.store.jobs.enqueue(
      "evaluate_batch",
      `evaluate_batch:${radarVersionId}`,
      { radar_version_id: radarVersionId, silent: forceSilent },
      rt.aiHealth.rateLimitResetAt,
      now,
    );
    return 0;
  }

  const settings = rt.loadSettings();
  const dailyCap = settings.daily_ai_post_cap;
  const usedToday = rt.store.aiCalls.countItemsToday(now);
  if (usedToday >= dailyCap) {
    const d = new Date(now);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (rt.aiHealth.dailyCapReachedDate !== today) {
      rt.aiHealth.dailyCapReachedDate = today;
      await rt.emitHealthIfChanged(now).catch(() => undefined);
    }
    return 0;
  }

  const remainingBudget = Math.max(dailyCap - usedToday, 1);
  const maxFetch = Math.min(remainingBudget, 60);
  const pendingItems = rt.store.leads.listPendingAiForVersion(radarVersionId, false, maxFetch);
  if (pendingItems.length === 0) return 0;

  const radarVer = rt.store.radars.getVersion(radarVersionId);
  if (!radarVer) return 0;
  const rw = rt.store.radars.get(radarVer.radar_id);
  if (!rw) return 0;

  const ai = requireAi(rt);
  const promptCtx = buildRadarPromptContext(rt, radarVer);
  const promptPosts = toPromptPosts(pendingItems);

  let report;
  try {
    report = await rt.withInflightAi(() => ai.judgeExtractAll(promptCtx, promptPosts, LIVE_BATCH));
  } catch (err) {
    const decidedNow = rt.now();
    if (recordFailedAiCalls(rt, err, decidedNow) === null) {
      rt.store.aiCalls.record({
        id: null,
        provider: ai.providerId(),
        model: null,
        task: "judge_extract",
        radar_version_id: radarVersionId,
        item_count: pendingItems.length,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        duration_ms: 0,
        status: callStatusOf(err),
        error: err instanceof Error ? err.message : String(err),
        now_ms: decidedNow,
      });
    }
    if (err instanceof AiHookError && err.kind === "rate_limited") {
      const waitMs = Math.max(err.retryAfterMs ?? 60_000, 1_000);
      rt.aiHealth.rateLimitResetAt = decidedNow + waitMs;
    } else {
      rt.aiHealth.lastError = err instanceof Error ? err.message : String(err);
      if (rt.aiHealth.firstUnavailableAt === null) rt.aiHealth.firstUnavailableAt = decidedNow;
    }
    await rt.emitHealthIfChanged(decidedNow).catch(() => undefined);
    throw aiCoreError(err);
  }

  const decidedNow = rt.now();
  const lastCallId = recordAiCalls(rt, report.calls, decidedNow);

  // Clear AI error state and recover prior `ai_failed` items.
  rt.aiHealth.lastError = null;
  rt.aiHealth.rateLimitResetAt = null;
  rt.aiHealth.firstUnavailableAt = null;
  const wasAlerted = rt.incidents.aiUnavailableAlerted;
  rt.incidents.aiUnavailableAlerted = false;
  if (wasAlerted) rt.queueSystemIncident({ kind: "ai_unavailable", pending_posts: 0 }, true, decidedNow);
  rt.store.leads.requeueAiFailedEvaluations();
  await rt.emitHealthIfChanged(decidedNow).catch(() => undefined);

  const byPostId = new Map(pendingItems.map((it) => [it.post.id, it]));
  let processed = 0;
  for (const outcome of report.outcomes) {
    if (outcome.state === "ai_failed") {
      const item = byPostId.get(outcome.post_id);
      if (item) rt.store.leads.markEvaluationAiFailed(item.evaluation.id, lastCallId, outcome.error, decidedNow);
      continue;
    }
    const item = byPostId.get(outcome.post_id);
    if (!item) continue;
    const result = outcome.result;

    const shadow = rt.store.radars.getShadowRuleset(radarVersionId);
    if (shadow) {
      try {
        reconcileShadowWithAiTruth(rt, shadow, outcome.post_id, result.match, decidedNow);
      } catch {
        // `let _ =` in Rust: shadow bookkeeping never blocks lead creation.
      }
    }

    const mode: EvalMode = forceSilent ? { kind: "backfill_silent" } : { kind: "live", repostAfter72h: !item.post.is_cluster_head };
    finalizeCandidateEvaluation(
      rt,
      item.evaluation.id,
      item.post,
      item.post.text_norm ?? item.post.text ?? "",
      rw.radar.id,
      rw.radar.name,
      rw.radar.status,
      rw.radar.notify,
      radarVer,
      {
        decidedBy: "ai",
        rulesetId: null,
        aiCallId: lastCallId,
        isMatch: result.match,
        rawScore: result.score,
        intent: result.intent,
        authorRole: result.author_role,
        isSpam: result.is_spam,
        summary: result.summary,
        reason: result.reason,
        candidateFields: mergeCandidateFields(item, result.fields),
      },
      mode,
      decidedNow,
    );
    processed += 1;
  }

  if (rt.store.leads.listPendingAiForVersion(radarVersionId, false, 1).length > 0) {
    scheduleEvaluateBatchJob(rt, radarVersionId, forceSilent, decidedNow);
  }
  maybeScheduleAutoCompileRuleset(rt, radarVersionId, decidedNow);
  return processed;
}

/** Pro plan: >= 150 AI evaluations, >= 20 matches, >= 30 new since the last compile. */
export function maybeScheduleAutoCompileRuleset(rt: PipelineRuntime, radarVersionId: string, now: number): void {
  if (!rt.licenseLimits(now).allow_auto_rulesets) return;
  const [totalAi, matchedAi] = rt.store.leads.countAiEvaluationsForVersion(radarVersionId);
  if (totalAi < rt.config.autoCompileMinAiEvals || matchedAi < rt.config.autoCompileMinMatches) return;
  const key = `runtime.last_compile_ai_count.${radarVersionId}`;
  const last = rt.store.settings.get<number>(key) ?? 0;
  if (last > 0 && totalAi - last < 30) return;
  rt.store.settings.set(key, totalAi);
  rt.enqueueAndWakeJob("compile_ruleset", `compile_ruleset:${radarVersionId}`, { radar_version_id: radarVersionId }, now);
}
