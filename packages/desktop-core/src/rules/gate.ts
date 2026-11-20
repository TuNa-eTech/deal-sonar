// Port of crates/rules/src/gate.rs (candidate -> shadow lifecycle gate).

import {
  compileRulesetUnchecked,
  validateRuleset,
  type RulesetBody,
  type ValidateOptions,
} from "./engine";
import { foldWithSpans, normalizeText } from "./normalize";
import { valuesEquivalent } from "./postfilter";
import type { FieldDef } from "./types";

export const GATE_MAX_FALSE_NEGATIVE_RATE = 0.02;
export const GATE_MIN_ACCEPT_PRECISION = 0.95;
export const GATE_MIN_FIELD_ACCURACY = 0.9;

export interface LabeledSample {
  post_text: string;
  ref_ts_ms: number;
  is_match: boolean;
  expected_fields: Record<string, unknown>;
}

export interface GateReport {
  passed: boolean;
  validation_error: string | null;
  total_samples: number;
  false_negative_rate: number;
  accept_precision: number;
  self_handled_rate: number;
  field_accuracies: Record<string, number>;
  dropped_fields: string[];
  pruned_ruleset: RulesetBody;
}

const DEFAULT_REF_TS = 1_794_384_000_000;
const clone = <T>(v: T): T => structuredClone(v);

export function evaluateGate(ruleset: RulesetBody, samples: readonly LabeledSample[], opts?: ValidateOptions): GateReport {
  return evaluateGateWithFields(ruleset, [], samples, opts);
}

export function evaluateGateWithFields(
  ruleset: RulesetBody,
  fieldDefs: readonly FieldDef[],
  samples: readonly LabeledSample[],
  opts: ValidateOptions = {},
): GateReport {
  let initial;
  try {
    initial = validateRuleset(ruleset, opts);
  } catch (err) {
    return {
      passed: false,
      validation_error: err instanceof Error ? err.message : String(err),
      total_samples: samples.length,
      false_negative_rate: 1.0,
      accept_precision: 0.0,
      self_handled_rate: 0.0,
      field_accuracies: {},
      dropped_fields: [],
      pruned_ruleset: clone(ruleset),
    };
  }
  if (samples.length === 0) {
    return {
      passed: false,
      validation_error: "labeled_samples must not be empty",
      total_samples: 0,
      false_negative_rate: 0.0,
      accept_precision: 1.0,
      self_handled_rate: 0.0,
      field_accuracies: {},
      dropped_fields: [],
      pruned_ruleset: clone(ruleset),
    };
  }

  const prepared = samples.map((s) => {
    const norm = normalizeText(s.post_text);
    return { s, norm, folded: foldWithSpans(norm.text_norm), ts: s.ref_ts_ms > 0 ? s.ref_ts_ms : DEFAULT_REF_TS };
  });

  const candidateKeys: string[] = [];
  for (const ext of ruleset.extract) if (!candidateKeys.includes(ext.field)) candidateKeys.push(ext.field);
  const trials = new Map<string, [number, number]>(candidateKeys.map((k) => [k, [0, 0]]));

  for (const { s, norm, folded, ts } of prepared) {
    if (!s.is_match && Object.keys(s.expected_fields).length === 0) continue;
    const extracted = initial.runExtractors(norm, folded, ts);
    for (const key of candidateKeys) {
      const expRaw = Object.prototype.hasOwnProperty.call(s.expected_fields, key) ? s.expected_fields[key] : undefined;
      const exp = expRaw === null || expRaw === undefined ? undefined : expRaw;
      const actRaw = Object.prototype.hasOwnProperty.call(extracted, key) ? extracted[key].value : undefined;
      const act = actRaw === null || actRaw === undefined ? undefined : actRaw;
      const entry = trials.get(key) ?? [0, 0];
      trials.set(key, entry);
      if (exp === undefined && act === undefined) continue;
      entry[1] += 1;
      if (exp !== undefined && act !== undefined && valuesEquivalent(act, exp)) entry[0] += 1;
    }
  }

  const fieldAccuracies: Record<string, number> = {};
  const dropped = new Set<string>();
  const droppedFields: string[] = [];
  const anyLabels = samples.some((s) => Object.keys(s.expected_fields).length > 0);
  for (const key of candidateKeys) {
    const [correct, total] = trials.get(key) ?? [0, 0];
    const acc = total > 0 ? correct / total : anyLabels ? 0.0 : 1.0;
    fieldAccuracies[key] = acc;
    if (acc + 1e-12 < GATE_MIN_FIELD_ACCURACY) {
      dropped.add(key);
      droppedFields.push(key);
    }
  }
  // BTreeMap key order for the persisted/serialized report.
  const orderedAccuracies = Object.fromEntries(Object.entries(fieldAccuracies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const pruned = clone(ruleset);
  if (dropped.size > 0) pruned.extract = pruned.extract.filter((e) => !dropped.has(e.field));
  const compiledPruned = compileRulesetUnchecked(pruned);

  let totalPositives = 0;
  let falseNegatives = 0;
  let definiteMatches = 0;
  let trueDefiniteMatches = 0;
  let selfHandled = 0;
  for (const { s, norm, folded, ts } of prepared) {
    if (s.is_match) totalPositives += 1;
    const outcome = compiledPruned.evaluateWithFolded(norm, folded, fieldDefs, ts);
    if (outcome.kind === "prefilter_reject" || outcome.kind === "definite_no_match") {
      selfHandled += 1;
      if (s.is_match) falseNegatives += 1;
    } else if (outcome.kind === "definite_match") {
      selfHandled += 1;
      definiteMatches += 1;
      if (s.is_match) trueDefiniteMatches += 1;
    }
  }
  const falseNegativeRate = totalPositives > 0 ? falseNegatives / totalPositives : 0;
  const acceptPrecision = definiteMatches > 0 ? trueDefiniteMatches / definiteMatches : 1;
  const passed =
    falseNegativeRate <= GATE_MAX_FALSE_NEGATIVE_RATE + 1e-12 && acceptPrecision + 1e-12 >= GATE_MIN_ACCEPT_PRECISION;

  return {
    passed,
    validation_error: null,
    total_samples: prepared.length,
    false_negative_rate: falseNegativeRate,
    accept_precision: acceptPrecision,
    self_handled_rate: selfHandled / prepared.length,
    field_accuracies: orderedAccuracies,
    dropped_fields: droppedFields,
    pruned_ruleset: pruned,
  };
}
