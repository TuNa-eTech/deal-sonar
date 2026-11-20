// Port of crates/core/src/pipeline/evaluate.rs: T3 blocklist + basic prefilter and T4 ruleset
// evaluation per `(post, radar_version)`.

import { compileRulesetUnchecked, parseRulesetBody, type CompiledRuleset } from "../rules/engine";
import type { NormalizedText } from "../rules/normalize";
import { runBasicPrefilter, type PrefilterRejectReason } from "../rules/prefilter";
import { sortedEntries } from "../rules/types";
import type { NotifyConfig } from "../store/domain";
import type { EvaluationRecord, FieldMap } from "../store/leads";
import type { PostRecord } from "../store/posts";
import type { RadarVersionRecord, RulesetRecord } from "../store/radars";
import { extractedFieldRulesToStore } from "./dto";
import { finalizeCandidateEvaluation } from "./finalize";
import { scheduleEvaluateBatchJob } from "./ai-batch";
import type { PipelineRuntime } from "./runtime";
import { enqueueAuditSample, recordShadowPrediction, shouldSampleForAudit } from "./shadow";
import { isPreview, type EvalMode, type PostIntent } from "./types";

const compiledCache = new Map<string, CompiledRuleset | null>();

/** Compile a stored ruleset body once per ruleset id (bodies are immutable); null when invalid. */
export function compiledRuleset(rec: RulesetRecord): CompiledRuleset | null {
  if (compiledCache.has(rec.id)) {
    const hit = compiledCache.get(rec.id) ?? null;
    compiledCache.delete(rec.id);
    compiledCache.set(rec.id, hit);
    return hit;
  }
  let compiled: CompiledRuleset | null = null;
  try {
    compiled = compileRulesetUnchecked(parseRulesetBody(rec.body));
  } catch {
    compiled = null;
  }
  compiledCache.set(rec.id, compiled);
  if (compiledCache.size > 64) {
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) compiledCache.delete(oldest);
  }
  return compiled;
}

/** Rust `{:?}` of `PrefilterRejectReason` as written into the evaluation reason. */
function debugReason(r: PrefilterRejectReason): string {
  switch (r.kind) {
    case "blocked":
      return `Blocked(${r.blocklist.charAt(0).toUpperCase()}${r.blocklist.slice(1)})`;
    case "too_short":
      return "TooShort";
    case "url_only":
      return "UrlOnly";
    case "ruleset_prefilter":
      return "RulesetPrefilter";
  }
}

export function buildRuleMatchSummary(textNorm: string): string {
  const lines = textNorm.split(/\r\n|\n/);
  const trimmedAll = textNorm.trim();
  const first = lines.map((l) => l.trim()).find((l) => l.length > 0) ?? trimmedAll;
  const chars = Array.from(first);
  return chars.length <= 120 ? first : `${chars.slice(0, 119).join("")}…`;
}

function toStoreFields(fields: Record<string, import("../rules/types").ExtractedField>): FieldMap {
  const out: FieldMap = {};
  for (const [k, v] of sortedEntries(fields)) out[k] = extractedFieldRulesToStore(v);
  return out;
}

/**
 * Run T3 and T4 synchronously for `(post, radar_version)`.
 * - `DefiniteMatch` proceeds through T6-T7 without AI.
 * - `DefiniteNoMatch` / `PrefilterReject` finalize as `done / no_match`.
 * - `Uncertain` (or no usable ruleset) stores `pending_ai` with rule hint fields and schedules T5.
 */
export function evaluatePostForRadarSync(
  rt: PipelineRuntime,
  post: PostRecord,
  norm: NormalizedText,
  radarId: string,
  radarName: string,
  radarStatus: string,
  radarNotify: NotifyConfig,
  radarVersion: RadarVersionRecord,
  mode: EvalMode,
  now: number,
): EvaluationRecord {
  const preview = isPreview(mode);
  const base = {
    id: null,
    post_id: post.id,
    radar_version_id: radarVersion.id,
    is_preview: preview,
    created_at: now,
  };

  // T3.1 blocklist
  const blocked = rt.store.blocklist.findMatching(radarId, post.author_id, post.extracted_phones, norm.text_fold);
  if (blocked) {
    return rt.store.leads.upsertEvaluation({
      ...base,
      state: "done",
      decided_by: "prefilter",
      verdict: "no_match",
      reject_reason: "blocked",
      score: 0.0,
      intent: null,
      author_role: null,
      summary: null,
      reason: `Chặn theo danh sách chặn (${blocked.kind}: ${blocked.value})`,
      fields: null,
      ruleset_id: null,
      ai_call_id: null,
      decided_at: now,
    });
  }

  // T3.2 basic prefilter
  const attachments = post.attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const basic = runBasicPrefilter(
    { author_id: post.author_id, text_norm: norm.text_norm, text_fold: norm.text_fold, has_attachments: hasAttachments },
    [],
  );
  if (basic) {
    return rt.store.leads.upsertEvaluation({
      ...base,
      state: "done",
      decided_by: "prefilter",
      verdict: "no_match",
      reject_reason: "prefilter",
      score: 0.0,
      intent: null,
      author_role: null,
      summary: null,
      reason: `Loại ở T3 lọc sơ bộ (${debugReason(basic)})`,
      fields: null,
      ruleset_id: null,
      ai_call_id: null,
      decided_at: now,
    });
  }

  const fieldDefs = radarVersion.fields;
  const refTsMs = post.created_at ?? post.captured_at;

  // T4 shadow ruleset (non-preview)
  if (!preview) {
    const shadow = rt.store.radars.getShadowRuleset(radarVersion.id);
    if (shadow) {
      const compiledShadow = compiledRuleset(shadow);
      if (compiledShadow) recordShadowPrediction(rt, shadow.id, post.id, compiledShadow.evaluate(norm, fieldDefs, refTsMs));
    }
  }

  // T4 active ruleset
  let hintFields: FieldMap | null = null;
  const active = rt.store.radars.getActiveRuleset(radarVersion.id);
  const compiled = active ? compiledRuleset(active) : null;
  if (active && compiled) {
    const outcome = compiled.evaluate(norm, fieldDefs, refTsMs);
    switch (outcome.kind) {
      case "prefilter_reject":
        return rt.store.leads.upsertEvaluation({
          ...base,
          state: "done",
          decided_by: "prefilter",
          verdict: "no_match",
          reject_reason: "prefilter",
          score: 0.0,
          intent: null,
          author_role: null,
          summary: null,
          reason: "Loại bởi lọc sơ bộ của bộ quy tắc",
          fields: null,
          ruleset_id: active.id,
          ai_call_id: null,
          decided_at: now,
        });
      case "definite_no_match": {
        const roleStr = typeof outcome.set.author_role === "string" ? outcome.set.author_role : "unknown";
        const rejectReason = roleStr === "peer" ? "peer" : outcome.set.is_spam === true ? "spam" : "irrelevant";
        const evalRec = rt.store.leads.upsertEvaluation({
          ...base,
          state: "done",
          decided_by: "rule",
          verdict: "no_match",
          reject_reason: rejectReason,
          score: Math.min(0.39, Math.max(0, 1 - outcome.confidence)),
          intent: typeof outcome.set.intent === "string" ? outcome.set.intent : null,
          author_role: roleStr,
          summary: null,
          reason: `Loại chắc bởi luật '${outcome.rule_id}'`,
          fields: null,
          ruleset_id: active.id,
          ai_call_id: null,
          decided_at: now,
        });
        if (!preview && shouldSampleForAudit(post.id, rt.config.auditSamplePercent)) {
          enqueueAuditSample(rt, radarVersion.id, active.id, evalRec.id, now);
        }
        return evalRec;
      }
      case "definite_match": {
        const setIntent = outcome.set.intent;
        const intent: PostIntent =
          setIntent === "demand" || setIntent === "supply" || setIntent === "other"
            ? setIntent
            : radarVersion.match_policy.want_intent === "supply"
              ? "supply"
              : "demand";
        const setRole = outcome.set.author_role;
        const authorRole = setRole === "peer" ? "peer" : "end_user";
        const isSpam = outcome.set.is_spam === true;
        const placeholder = rt.store.leads.upsertEvaluation({
          ...base,
          state: "pending_ai",
          decided_by: "rule",
          verdict: null,
          reject_reason: null,
          score: null,
          intent: null,
          author_role: null,
          summary: null,
          reason: null,
          fields: null,
          ruleset_id: active.id,
          ai_call_id: null,
          decided_at: null,
        });
        const finalized = finalizeCandidateEvaluation(
          rt,
          placeholder.id,
          post,
          norm.text_norm,
          radarId,
          radarName,
          radarStatus,
          radarNotify,
          radarVersion,
          {
            decidedBy: "rule",
            rulesetId: active.id,
            aiCallId: null,
            isMatch: true,
            rawScore: outcome.confidence,
            intent,
            authorRole,
            isSpam,
            summary: buildRuleMatchSummary(norm.text_norm),
            reason: `Khớp chắc bởi luật '${outcome.rule_id}'`,
            candidateFields: outcome.fields,
          },
          mode,
          now,
        );
        if (!preview && shouldSampleForAudit(post.id, rt.config.auditSamplePercent)) {
          enqueueAuditSample(rt, radarVersion.id, active.id, finalized.id, now);
        }
        return finalized;
      }
      case "uncertain":
        if (Object.keys(outcome.hint_fields).length > 0) hintFields = toStoreFields(outcome.hint_fields);
        break;
    }
  }

  // T5 queue
  const pending = rt.store.leads.upsertEvaluation({
    ...base,
    state: "pending_ai",
    decided_by: null,
    verdict: null,
    reject_reason: null,
    score: null,
    intent: null,
    author_role: null,
    summary: null,
    reason: null,
    fields: hintFields,
    ruleset_id: null,
    ai_call_id: null,
    decided_at: null,
  });
  if (!preview) scheduleEvaluateBatchJob(rt, radarVersion.id, mode.kind === "backfill_silent", now);
  return pending;
}
