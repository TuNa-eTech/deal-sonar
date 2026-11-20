// Port of crates/rules/src/postfilter.rs (T6: evidence verification, renormalization, hard filters).

import { extractDateVi } from "./extractors/date-vi";
import { extractGazetteer } from "./extractors/gazetteer";
import { extractVnArea } from "./extractors/area";
import { extractVnMoney } from "./extractors/money";
import { parseStandaloneNumber } from "./extractors/number";
import { extractVnPhone } from "./extractors/phone";
import { foldText, isControl } from "./normalize";
import { isWhitespace } from "../store/util";
import { rustTrim } from "./prefilter";
import { sortedEntries, type ExtractedField, type ExtractedFields, type FieldDef, type FilterOp, type HardFilter } from "./types";

export const MISSING_REQUIRED_EVIDENCE_PENALTY = 0.2;

export interface RenormalizeResult {
  value: unknown;
  overridden: boolean;
  confidence_factor: number;
}

/** Adjusted confidence in `[0.05, 1.0]`, strictly lower when overridden. */
export function applyConfidence(r: RenormalizeResult, original: number): number {
  const clamped = Math.min(1, Math.max(0, original));
  if (r.overridden) {
    const hi = Math.max(clamped - 0.05, 0.05);
    return Math.min(hi, Math.max(0.05, clamped * r.confidence_factor));
  }
  return clamped;
}

export interface PostprocessFieldsResult {
  fields: ExtractedFields;
  dropped_keys: string[];
  dropped_required_count: number;
  score_penalty: number;
}

export interface PeerSignals {
  author_posts_7d: number;
  cluster_source_count: number;
  phone_distinct_authors: number;
}

export type LeadDisposition = "create_and_notify" | "create_weak_only" | "discard";

function isInvisibleEvidenceChar(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  );
}

function compactForEvidence(s: string): string {
  let out = "";
  for (const c of s.normalize("NFC")) {
    const cp = c.codePointAt(0)!;
    if (isWhitespace(cp) || isControl(cp) || isInvisibleEvidenceChar(cp)) continue;
    switch (c) {
      case "–": case "—": case "−": case "‒": case "―":
        out += "-";
        break;
      case "’": case "‘":
        out += "'";
        break;
      case "“": case "”":
        out += '"';
        break;
      default:
        out += c.toLowerCase();
    }
  }
  return out;
}

/** T6.1: `raw` must occur (case/whitespace-insensitively) in `text_norm`. */
export function verifyEvidence(textNorm: string, raw: string): boolean {
  const needle = compactForEvidence(raw);
  if (needle.length === 0) return false;
  return compactForEvidence(textNorm).includes(needle);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function normalizeEnumOption(aiValue: unknown, options: readonly string[] | null): unknown | undefined {
  if (!options || typeof aiValue !== "string") return undefined;
  const s = rustTrim(aiValue);
  if (options.includes(s)) return s;
  const sFold = foldText(s);
  const canonical = options.find((o) => foldText(o) === sFold);
  return canonical;
}

function normalizeMultiEnumOptions(aiValue: unknown, options: readonly string[] | null): unknown | undefined {
  if (!options || !Array.isArray(aiValue)) return undefined;
  const out: unknown[] = [];
  for (const item of aiValue) {
    const mapped = normalizeEnumOption(item, options);
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** T6.2: re-run the built-in extractor on `raw`; extractor wins on disagreement. */
export function renormalizeField(def: FieldDef, raw: string, aiValue: unknown, refTsMs: number): RenormalizeResult {
  let ext: unknown | undefined;
  switch (def.type) {
    case "money":
      ext = extractVnMoney(raw, null, null)[0]?.value;
      break;
    case "phone":
      ext = extractVnPhone(raw)[0]?.value;
      break;
    case "location": {
      const m = extractGazetteer(raw, null)[0];
      if (m && isObj(m.value)) ext = { ...m.value, raw: rustTrim(raw) };
      break;
    }
    case "range":
      ext = extractVnArea(raw)[0]?.value;
      break;
    case "number": {
      const n = parseStandaloneNumber(raw);
      ext = n === null ? undefined : n;
      break;
    }
    case "date":
      ext = extractDateVi(raw, refTsMs)[0]?.value;
      break;
    case "enum":
      ext = normalizeEnumOption(aiValue, def.options);
      break;
    case "multi_enum":
      ext = normalizeMultiEnumOptions(aiValue, def.options);
      break;
    default:
      ext = undefined;
  }
  if (ext !== undefined) {
    return valuesEquivalent(ext, aiValue)
      ? { value: ext, overridden: false, confidence_factor: 1.0 }
      : { value: ext, overridden: true, confidence_factor: 0.75 };
  }
  return { value: aiValue, overridden: false, confidence_factor: 1.0 };
}

export function renormalizeExtractedField(def: FieldDef, field: ExtractedField, refTsMs: number): ExtractedField {
  const res = renormalizeField(def, field.raw ?? "", field.value, refTsMs);
  return { value: res.value, raw: field.raw, confidence: applyConfidence(res, field.confidence), source: field.source };
}

/** T6.1 + T6.2 over all candidate fields (BTreeMap iteration order). */
export function postprocessFields(
  textNorm: string,
  fieldDefs: readonly FieldDef[],
  candidates: ExtractedFields,
  refTsMs: number,
): PostprocessFieldsResult {
  const verified: ExtractedFields = {};
  const droppedKeys: string[] = [];
  let droppedRequired = 0;
  for (const [key, field] of sortedEntries(candidates)) {
    const def = fieldDefs.find((d) => d.key === key);
    if (!verifyEvidence(textNorm, field.raw ?? "")) {
      droppedKeys.push(key);
      if (def?.required) droppedRequired += 1;
      continue;
    }
    verified[key] = def ? renormalizeExtractedField(def, field, refTsMs) : { ...field };
  }
  return {
    fields: verified,
    dropped_keys: droppedKeys,
    dropped_required_count: droppedRequired,
    score_penalty: droppedRequired * MISSING_REQUIRED_EVIDENCE_PENALTY,
  };
}

function optFieldEq(a: unknown, b: unknown): boolean {
  const sa = typeof a === "string" ? foldText(a) : null;
  const sb = typeof b === "string" ? foldText(b) : null;
  return sa === sb;
}

/** Semantic equality of two normalized field values. */
export function valuesEquivalent(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  if (typeof a === "string" && typeof b === "string") {
    const ta = rustTrim(a);
    const tb = rustTrim(b);
    return asciiLower(ta) === asciiLower(tb) || ta === tb;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEquivalent(v, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const isLocation = "province" in a || "district" in a || "province" in b || "district" in b;
    if (isLocation) {
      return optFieldEq(a.province, b.province) && optFieldEq(a.district, b.district) && optFieldEq(a.ward, b.ward);
    }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && valuesEquivalent(a[k], b[k]));
  }
  return false;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Rust `str::parse::<f64>` for the forms DSL values can take. */
function rustParseF64(s: string): number | null {
  if (/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  if (/^[+-]?(?:inf|infinity)$/.test(lower)) return lower.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(lower)) return Number.NaN;
  return null;
}

function valueAsF64(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") return rustParseF64(rustTrim(v));
  return null;
}

function isValueEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return rustTrim(v).length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

function extractNumericBounds(v: unknown): [number, number] | null {
  const n = valueAsF64(v);
  if (n !== null) return [n, n];
  if (!isObj(v)) return null;
  const min = valueAsF64(v.min);
  const max = valueAsF64(v.max);
  return min !== null && max !== null ? [min, max] : null;
}

function valueMatchesEq(fieldVal: unknown, target: unknown): boolean {
  const bounds = extractNumericBounds(fieldVal);
  const t = valueAsF64(target);
  if (bounds && t !== null) return Math.abs(bounds[0] - t) <= 1e-6 && Math.abs(bounds[1] - t) <= 1e-6;
  if (isObj(fieldVal) && typeof target === "string") {
    const tf = foldText(target);
    if (tf.length === 0) return false;
    for (const key of ["province", "district", "ward", "raw"]) {
      const s = fieldVal[key];
      if (typeof s === "string" && foldText(s) === tf) return true;
    }
    return false;
  }
  if (typeof fieldVal === "string" && typeof target === "string") return foldText(fieldVal) === foldText(target);
  return valuesEquivalent(fieldVal, target);
}

const isIsoDateStr = (s: string): boolean => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s);

function compareNumericOrDate(
  fieldVal: unknown,
  target: unknown,
  pred: (vmin: number, vmax: number, t: number) => boolean,
): boolean {
  const bounds = extractNumericBounds(fieldVal);
  const t = valueAsF64(target);
  if (bounds && t !== null) return pred(bounds[0], bounds[1], t);
  if (typeof fieldVal === "string" && typeof target === "string" && isIsoDateStr(fieldVal) && isIsoDateStr(target)) {
    const ord = fieldVal < target ? -1 : fieldVal > target ? 1 : 0;
    return pred(ord, ord, 0);
  }
  return false;
}

function extractBetweenBounds(target: unknown): [unknown, unknown] | null {
  if (Array.isArray(target) && target.length === 2) return [target[0], target[1]];
  if (isObj(target) && "min" in target && "max" in target) return [target.min, target.max];
  return null;
}

function valueContains(fieldVal: unknown, target: unknown): boolean {
  if (typeof fieldVal === "string") {
    if (typeof target !== "string") return false;
    const nf = foldText(target);
    return nf.length > 0 && foldText(fieldVal).includes(nf);
  }
  if (Array.isArray(fieldVal)) return fieldVal.some((item) => valueMatchesEq(item, target) || valueContains(item, target));
  if (isObj(fieldVal)) {
    if (typeof target !== "string") return false;
    const nf = foldText(target);
    if (nf.length === 0) return false;
    return ["raw", "province", "district", "ward"].some((k) => {
      const s = fieldVal[k];
      return typeof s === "string" && foldText(s).includes(nf);
    });
  }
  return false;
}

/** Compare an extracted value against `target` (hard filters and DSL `field_cmp`). */
export function compareFieldValue(fieldVal: unknown, op: FilterOp, target: unknown): boolean {
  switch (op) {
    case "is_empty": {
      const empty = isValueEmpty(fieldVal);
      return typeof target === "boolean" ? empty === target : empty;
    }
    case "eq":
      return valueMatchesEq(fieldVal, target);
    case "ne":
      return !valueMatchesEq(fieldVal, target);
    case "in": {
      if (!Array.isArray(target)) return false;
      if (Array.isArray(fieldVal)) return fieldVal.some((item) => target.some((t) => valueMatchesEq(item, t)));
      return target.some((t) => valueMatchesEq(fieldVal, t));
    }
    case "lt":
      return compareNumericOrDate(fieldVal, target, (_a, vmax, t) => vmax < t);
    case "lte":
      return compareNumericOrDate(fieldVal, target, (_a, vmax, t) => vmax <= t);
    case "gt":
      return compareNumericOrDate(fieldVal, target, (vmin, _b, t) => vmin > t);
    case "gte":
      return compareNumericOrDate(fieldVal, target, (vmin, _b, t) => vmin >= t);
    case "between": {
      const b = extractBetweenBounds(target);
      if (!b) return false;
      return (
        compareNumericOrDate(fieldVal, b[0], (vmin, _m, lo) => vmin >= lo) &&
        compareNumericOrDate(fieldVal, b[1], (_m, vmax, hi) => vmax <= hi)
      );
    }
    case "contains":
      return valueContains(fieldVal, target);
  }
}

export function evaluateSingleFilter(filter: HardFilter, fields: ExtractedFields): boolean {
  const ef = Object.prototype.hasOwnProperty.call(fields, filter.field) ? fields[filter.field] : undefined;
  const fieldVal = ef && ef.value !== null && ef.value !== undefined ? ef.value : undefined;
  if (filter.op === "is_empty") {
    const empty = fieldVal === undefined ? true : isValueEmpty(fieldVal);
    return typeof filter.value === "boolean" ? empty === filter.value : empty;
  }
  if (fieldVal === undefined) return filter.when_missing !== "fail";
  return compareFieldValue(fieldVal, filter.op, filter.value);
}

/** T6.4 */
export function evaluateHardFilters(filters: readonly HardFilter[], fields: ExtractedFields): boolean {
  return filters.every((f) => evaluateSingleFilter(f, fields));
}

/** T6.3: two or more behavioral signals override `author_role` to `peer`. */
export function shouldOverridePeer(s: PeerSignals): boolean {
  let count = 0;
  if (s.author_posts_7d >= 5) count += 1;
  if (s.cluster_source_count >= 4) count += 1;
  if (s.phone_distinct_authors >= 3) count += 1;
  return count >= 2;
}

/** T6.5 */
export function classifyLeadTier(score: number, minScore: number): LeadDisposition {
  const effectiveMin = Math.max(minScore, 0.4);
  if (score >= effectiveMin) return "create_and_notify";
  if (score >= 0.4) return "create_weak_only";
  return "discard";
}
