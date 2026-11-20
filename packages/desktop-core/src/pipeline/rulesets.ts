// Port of crates/core/src/preview_rules/rulesets.rs: ruleset lifecycle (compile -> shadow,
// user save, audit and demotion; `05-pipeline-rules.md §6.4`).

import { CoreError } from "../backend/wire";
import {
  parseRulesetBody,
  rulesetBodyToJson,
  validateRuleset,
  RulesetParseError,
  RulesetValidationError,
  type RulesetBody,
} from "../rules/engine";
import { evaluateGateWithFields, type LabeledSample as GateLabeledSample } from "../rules/gate";
import type { LabeledSample as StoreLabeledSample } from "../store/leads";
import type { RulesetRecord } from "../store/radars";
import {
  aiCoreError,
  buildRadarPromptContext,
  callStatusOf,
  LIVE_BATCH,
  recordAiCalls,
  recordFailedAiCalls,
  requireAi,
} from "./ai-batch";
import { dtoRulesetBodyToRules, rulesetRecordToDto, type DtoRulesetBody, type RulesetDto, type RulesetMetrics } from "./dto";
import type { PipelineRuntime } from "./runtime";
import type { CompileRulesBridgeInput, PipelineAuthorRole } from "./types";

interface AuditHistoryEntry {
  ts_ms: number;
  disagreed: boolean;
}

const roleOf = (r: string | null): PipelineAuthorRole | null =>
  r === null ? null : r === "peer" ? "peer" : r === "end_user" ? "end_user" : "unknown";

const sortedFieldValues = (fields: StoreLabeledSample["fields"]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fields ?? {}).sort()) out[k] = (fields ?? {})[k].value;
  return out;
};

const toGateSample = (s: StoreLabeledSample, refTsMs: number): GateLabeledSample => ({
  post_text: s.post_text,
  ref_ts_ms: refTsMs,
  is_match: s.is_match,
  expected_fields: sortedFieldValues(s.fields),
});

function metricsFrom(selfHandledRate: number, precision: number, falseNegativeRate: number, samples: number): RulesetMetrics {
  const pct = Math.round(selfHandledRate * 100);
  return {
    rule_handled_pct: pct,
    ai_handled_pct: Math.max(100 - pct, 0),
    accept_precision: precision,
    false_negative_rate: falseNegativeRate,
    sample_size: samples,
  };
}

/** Parse AI output into an engine body; schema violations surface as a JSON error. */
function parseCompiledBody(output: unknown): RulesetBody {
  try {
    return parseRulesetBody(output);
  } catch (err) {
    if (err instanceof RulesetParseError) throw new CoreError("json", `lỗi dữ liệu JSON: ${err.message}`);
    throw err;
  }
}

/**
 * Compile a ruleset through the AI bridge, split labeled samples 80/20, gate the candidate on the
 * 20% holdout (auto-pruning < 90% fields) and promote it to `shadow` on pass, else `retired`.
 */
export async function runCompileRulesetForVersion(rt: PipelineRuntime, radarVersionId: string): Promise<RulesetRecord | null> {
  const radarVer = rt.store.radars.getVersion(radarVersionId);
  if (!radarVer) return null;
  const allSamples = rt.store.leads.getLabeledDataset(radarVersionId);
  if (allSamples.length < 5) return null;

  const train: StoreLabeledSample[] = [];
  const holdout: StoreLabeledSample[] = [];
  allSamples.forEach((s, idx) => {
    if (idx % 5 === 4) holdout.push(s);
    else train.push(s);
  });
  if (holdout.length === 0) {
    const last = train.pop();
    if (last) holdout.push(last);
  }

  const currentRuleset = (rt.store.radars.getActiveRuleset(radarVersionId) ?? rt.store.radars.getShadowRuleset(radarVersionId))?.body ?? null;
  const compileInput: CompileRulesBridgeInput = {
    radar: buildRadarPromptContext(rt, radarVer),
    labeled_samples: train.slice(0, 120).map((s) => ({
      post_text: s.post_text,
      is_match: s.is_match,
      author_role: roleOf(s.author_role),
      expected_fields: sortedFieldValues(s.fields),
    })),
    current_ruleset: currentRuleset,
    current_ruleset_errors: [],
  };

  const ai = requireAi(rt);
  let result;
  try {
    result = await rt.withInflightAi(() => ai.compileRules(compileInput));
  } catch (err) {
    const now = rt.now();
    if (recordFailedAiCalls(rt, err, now) === null) {
      rt.store.aiCalls.record({
        id: null,
        provider: ai.providerId(),
        model: null,
        task: "compile_rules",
        radar_version_id: radarVersionId,
        item_count: compileInput.labeled_samples.length,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        duration_ms: 0,
        status: callStatusOf(err),
        error: err instanceof Error ? err.message : String(err),
        now_ms: now,
      });
    }
    throw aiCoreError(err);
  }

  const now = rt.now();
  recordAiCalls(rt, result.calls, now);

  const candidate = parseCompiledBody(result.output);
  const gate = evaluateGateWithFields(candidate, radarVer.fields, holdout.map((s) => toGateSample(s, now)));
  const metrics = metricsFrom(gate.self_handled_rate, gate.accept_precision, gate.false_negative_rate, gate.total_samples);

  const inserted = rt.store.radars.insertRuleset({
    id: null,
    radar_version_id: radarVersionId,
    state: "candidate",
    origin: "compiled",
    body: rulesetBodyToJson(gate.pruned_ruleset),
    metrics,
    now_ms: now,
  });
  return rt.store.radars.updateRulesetState(inserted.id, gate.passed ? "shadow" : "retired", metrics, now);
}

/**
 * Save a user-edited ruleset (`origin = "user"`): validates schema + regex safety + latency, then
 * gates on the labeled dataset when at least 10 samples exist (`active` on pass, else `shadow`).
 */
export function saveUserRuleset(rt: PipelineRuntime, radarVersionId: string, dtoBody: DtoRulesetBody, now: number): RulesetDto {
  const radarVer = rt.store.radars.getVersion(radarVersionId);
  if (!radarVer) throw CoreError.notFound("radar_version", radarVersionId);

  const engineBody = dtoRulesetBodyToRules(dtoBody);
  try {
    validateRuleset(engineBody);
  } catch (err) {
    if (err instanceof RulesetValidationError) throw new CoreError("validation", `dữ liệu đầu vào không hợp lệ: ${err.message}`);
    throw err;
  }

  const labeled = rt.store.leads.getLabeledDataset(radarVersionId);
  let state = "active";
  let finalBody = engineBody;
  let metrics: RulesetMetrics | null = null;
  if (labeled.length >= 10) {
    const gate = evaluateGateWithFields(engineBody, radarVer.fields, labeled.map((s) => toGateSample(s, now)));
    metrics = metricsFrom(gate.self_handled_rate, gate.accept_precision, gate.false_negative_rate, gate.total_samples);
    state = gate.passed ? "active" : "shadow";
    finalBody = gate.pruned_ruleset;
  }
  const saved = rt.store.radars.insertRuleset({
    id: null,
    radar_version_id: radarVersionId,
    state,
    origin: "user",
    body: rulesetBodyToJson(finalBody),
    metrics,
    now_ms: now,
  });
  return rulesetRecordToDto(saved);
}

/**
 * Audit a batch of rule-decided evaluations against AI truth. When the 7-day disagreement rate
 * exceeds the threshold the `active` ruleset is demoted to `shadow` and a recompile is queued.
 */
export async function runAuditRuleset(rt: PipelineRuntime, radarVersionId: string, rulesetId: string): Promise<boolean> {
  const radarVer = rt.store.radars.getVersion(radarVersionId);
  if (!radarVer) return false;

  const queueKey = `runtime.audit_queue.${rulesetId}`;
  const evalIds = rt.store.settings.get<string[]>(queueKey) ?? [];
  if (evalIds.length === 0) return false;

  const batchIds = evalIds.slice(0, 30);
  const batchSet = new Set(batchIds);
  const pairs: Array<[NonNullable<ReturnType<PipelineRuntime["store"]["leads"]["getEvaluation"]>>, NonNullable<ReturnType<PipelineRuntime["store"]["posts"]["get"]>>]> = [];
  for (const eid of batchIds) {
    const ev = rt.store.leads.getEvaluation(eid);
    if (!ev) continue;
    const pd = rt.store.posts.get(ev.post_id);
    if (pd) pairs.push([ev, pd]);
  }

  const dequeue = (now: number): void => {
    const latest = (rt.store.settings.get<string[]>(queueKey) ?? []).filter((id) => !batchSet.has(id));
    if (latest.length === 0) {
      rt.store.settings.delete(queueKey);
    } else {
      rt.store.settings.set(queueKey, latest);
      rt.store.jobs.enqueue(
        "audit_ruleset",
        `audit_ruleset:${rulesetId}`,
        { radar_version_id: radarVersionId, ruleset_id: rulesetId },
        now + 60_000,
        now,
      );
    }
  };

  if (pairs.length === 0) {
    dequeue(rt.now());
    return false;
  }

  const ai = requireAi(rt);
  const ctx = buildRadarPromptContext(rt, radarVer);
  const promptPosts = pairs.map(([, pd], idx) => ({
    post_id: pd.id,
    ref: idx + 1,
    group_name: pd.source_name,
    author_name: pd.author_name,
    created_at_ms: pd.created_at,
    text: pd.text_norm ?? pd.text ?? "",
    rule_hints: null,
  }));
  let report;
  try {
    report = await rt.withInflightAi(() => ai.judgeExtractAll(ctx, promptPosts, LIVE_BATCH));
  } catch (err) {
    recordFailedAiCalls(rt, err, rt.now());
    throw aiCoreError(err);
  }

  const now = rt.now();
  // Dequeue only after the AI call succeeded, preserving IDs beyond `take(30)` and IDs appended meanwhile.
  dequeue(now);
  recordAiCalls(rt, report.calls, now);

  const ruleVerdictByPost = new Map(pairs.map(([ev, pd]) => [pd.id, ev.verdict === "match"] as const));
  const entries: AuditHistoryEntry[] = [];
  for (const outcome of report.outcomes) {
    if (outcome.state !== "done") continue;
    const ruleMatched = ruleVerdictByPost.get(outcome.post_id);
    if (ruleMatched !== undefined) entries.push({ ts_ms: now, disagreed: ruleMatched !== outcome.result.match });
  }
  return recordAuditEntriesAndMaybeDemote(rt, radarVersionId, rulesetId, entries, now);
}

/** Immediate audit trigger for negative user feedback on a rule-decided evaluation. */
export function handleNegativeFeedbackOnRuleEval(
  rt: PipelineRuntime,
  evaluation: { decided_by: string | null; ruleset_id: string | null; radar_version_id: string },
  now: number,
): boolean {
  if (evaluation.decided_by !== "rule") return false;
  const rulesetId = evaluation.ruleset_id ?? rt.store.radars.getActiveRuleset(evaluation.radar_version_id)?.id ?? null;
  if (rulesetId === null) return false;
  const demoted = recordAuditEntriesAndMaybeDemote(rt, evaluation.radar_version_id, rulesetId, [{ ts_ms: now, disagreed: true }], now);
  if (!demoted) {
    rt.enqueueAndWakeJob(
      "audit_ruleset",
      `audit_ruleset:${rulesetId}`,
      { radar_version_id: evaluation.radar_version_id, ruleset_id: rulesetId },
      now,
    );
  }
  return demoted;
}

export function recordAuditEntriesAndMaybeDemote(
  rt: PipelineRuntime,
  radarVersionId: string,
  rulesetId: string,
  newEntries: AuditHistoryEntry[],
  now: number,
): boolean {
  if (newEntries.length === 0) return false;
  const key = `runtime.audit_history.${rulesetId}`;
  const since7d = now - 7 * 86_400_000;
  const hist = (rt.store.settings.get<AuditHistoryEntry[]>(key) ?? []).filter((e) => e.ts_ms >= since7d);
  hist.push(...newEntries);
  rt.store.settings.set(key, hist);

  if (hist.length < rt.config.auditMinSamples) return false;
  const rate = hist.filter((e) => e.disagreed).length / hist.length;
  if (rate > rt.config.auditDisagreementDemoteThreshold) {
    const active = rt.store.radars.getActiveRuleset(radarVersionId);
    if (active && active.id === rulesetId) {
      rt.store.radars.updateRulesetState(rulesetId, "shadow", null, now);
      rt.enqueueAndWakeJob("compile_ruleset", `compile_ruleset:${radarVersionId}`, { radar_version_id: radarVersionId }, now);
      return true;
    }
  }
  return false;
}
