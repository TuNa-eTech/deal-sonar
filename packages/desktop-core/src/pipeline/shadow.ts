// Port of crates/core/src/pipeline/shadow.rs: shadow-ruleset tracking and audit sampling.

import { GATE_MAX_FALSE_NEGATIVE_RATE, GATE_MIN_ACCEPT_PRECISION } from "../rules/gate";
import type { RulesetOutcome } from "../rules/engine";
import type { RulesetRecord } from "../store/radars";
import type { PipelineRuntime } from "./runtime";
import type { RulesetMetrics } from "./dto";

export interface ShadowTrackerState {
  total_evaluated: number;
  rule_self_handled: number;
  definite_match_total: number;
  definite_match_correct: number;
  positive_truth_total: number;
  positive_falsely_rejected: number;
  pending_predictions: Record<string, string>;
}

const emptyTracker = (): ShadowTrackerState => ({
  total_evaluated: 0,
  rule_self_handled: 0,
  definite_match_total: 0,
  definite_match_correct: 0,
  positive_truth_total: 0,
  positive_falsely_rejected: 0,
  pending_predictions: {},
});

/** Deterministic audit sampler: FNV-1a over the UTF-8 bytes of `postId`, modulo 100. */
export function shouldSampleForAudit(postId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 0xcbf29ce484222325n;
  for (const b of Buffer.from(postId, "utf8")) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash % 100n < BigInt(percent);
}

/** Record a shadow ruleset's T4 prediction so it can be compared against T5 AI truth. */
export function recordShadowPrediction(rt: PipelineRuntime, shadowRulesetId: string, postId: string, outcome: RulesetOutcome): void {
  const key = `runtime.shadow.${shadowRulesetId}`;
  const tracker = rt.store.settings.get<ShadowTrackerState>(key) ?? emptyTracker();
  tracker.pending_predictions ??= {};
  const pred = outcome.kind === "definite_match" ? "match" : outcome.kind === "uncertain" ? "uncertain" : "no_match";
  if (Object.keys(tracker.pending_predictions).length >= 1_000) tracker.pending_predictions = {};
  tracker.pending_predictions[postId] = pred;
  rt.store.settings.set(key, tracker);
}

/**
 * Compare the shadow prediction with the AI verdict and promote `shadow -> active` once the sample
 * size/age gate is met and precision/false-negative thresholds hold (`05-pipeline-rules.md §6.4`).
 */
export function reconcileShadowWithAiTruth(
  rt: PipelineRuntime,
  shadowRec: RulesetRecord,
  postId: string,
  aiIsMatch: boolean,
  now: number,
): boolean {
  const key = `runtime.shadow.${shadowRec.id}`;
  const tracker = rt.store.settings.get<ShadowTrackerState>(key) ?? emptyTracker();
  tracker.pending_predictions ??= {};
  const pred = tracker.pending_predictions[postId];
  if (pred === undefined) return false;
  delete tracker.pending_predictions[postId];

  tracker.total_evaluated += 1;
  if (pred !== "uncertain") tracker.rule_self_handled += 1;
  if (pred === "match") {
    tracker.definite_match_total += 1;
    if (aiIsMatch) tracker.definite_match_correct += 1;
  }
  if (aiIsMatch) {
    tracker.positive_truth_total += 1;
    if (pred === "no_match") tracker.positive_falsely_rejected += 1;
  }

  const rulePct = tracker.total_evaluated > 0 ? Math.round((tracker.rule_self_handled / tracker.total_evaluated) * 100) : 0;
  const acceptPrecision = tracker.definite_match_total > 0 ? tracker.definite_match_correct / tracker.definite_match_total : 1;
  const falseNegativeRate = tracker.positive_truth_total > 0 ? tracker.positive_falsely_rejected / tracker.positive_truth_total : 0;
  const metrics: RulesetMetrics = {
    rule_handled_pct: rulePct,
    ai_handled_pct: Math.max(100 - rulePct, 0),
    accept_precision: acceptPrecision,
    false_negative_rate: falseNegativeRate,
    sample_size: tracker.total_evaluated,
  };
  rt.store.settings.set(key, tracker);

  const readyByCount = tracker.total_evaluated >= rt.config.shadowMinPosts;
  const readyByAge = tracker.total_evaluated >= 10 && now - shadowRec.created_at >= rt.config.shadowMinAgeMs;
  if (readyByCount || readyByAge) {
    if (acceptPrecision >= GATE_MIN_ACCEPT_PRECISION && falseNegativeRate <= GATE_MAX_FALSE_NEGATIVE_RATE) {
      rt.store.radars.updateRulesetState(shadowRec.id, "active", metrics, now);
      return true;
    }
    if (readyByCount) {
      rt.store.radars.updateRulesetState(shadowRec.id, "retired", metrics, now);
      return false;
    }
  }
  rt.store.radars.updateRulesetState(shadowRec.id, "shadow", metrics, now);
  return false;
}

/** Queue an evaluation for the daily rule audit and (re)schedule the `audit_ruleset` job. */
export function enqueueAuditSample(
  rt: PipelineRuntime,
  radarVersionId: string,
  rulesetId: string,
  evaluationId: string,
  now: number,
): void {
  const key = `runtime.audit_queue.${rulesetId}`;
  const queue = rt.store.settings.get<string[]>(key) ?? [];
  if (queue.length < 30 && !queue.includes(evaluationId)) {
    queue.push(evaluationId);
    rt.store.settings.set(key, queue);
  }
  rt.store.jobs.enqueue(
    "audit_ruleset",
    `audit_ruleset:${rulesetId}`,
    { radar_version_id: radarVersionId, ruleset_id: rulesetId },
    now + 60_000,
    now,
  );
}
