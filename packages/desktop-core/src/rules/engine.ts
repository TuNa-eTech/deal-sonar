// Port of crates/rules/src/engine/{mod,types,compiled,compile,eval,describe}.rs: Declarative
// Ruleset DSL v1 (parse, validate/compile, evaluate, describe).

import { foldText, foldWithSpans, normalizeText, canonicalLangCode, type FoldedText, type NormalizedText } from "./normalize";
import { compareFieldValue } from "./postfilter";
import { kwContainsFolded } from "./prefilter";
import { extractVnAreaFromFolded } from "./extractors/area";
import { extractDateViFromFolded } from "./extractors/date-vi";
import {
  compileEnumPatterns,
  extractEnumKwCompiled,
  matchesAnyEnumKw,
  type CompiledEnumPatterns,
} from "./extractors/enum-kw";
import { extractGazetteerFromFolded } from "./extractors/gazetteer";
import { DEFAULT_MONEY_WINDOW, extractVnMoneyFromFolded } from "./extractors/money";
import { extractNumberFromFolded, type NumberExtractorConfig } from "./extractors/number";
import { extractVnPhoneFirst } from "./extractors/phone";
import {
  compileSafeRegex,
  extractCompiledRegex,
  RegexSafetyError,
  type CompiledRegex,
  type RegexCast,
} from "./extractors/regex-ext";
import {
  intoExtractedField,
  sortedEntries,
  type ExtractedFields,
  type ExtractionMatch,
  type FieldDef,
  type FilterOp,
} from "./types";

export const SUPPORTED_DSL_VERSION = 1;
export const MAX_CONDITION_DEPTH = 16;
/** Rust budget is 1 ms. A V8 interpreter+regex pass is slower on the same 5,000-char post; see `ValidateOptions`. */
export const MAX_RULESET_EXEC_MS = 25;

// ---------- DSL types ----------

export type RuleVerdict = "match" | "no_match";
export interface FieldCmp {
  field: string;
  op: FilterOp;
  value: unknown;
}
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { kw_any: string[] }
  | { kw_none: string[] }
  | { re: string }
  | { has_field: string }
  | { len_lt: number }
  | { len_gt: number }
  | { lang_in: string[] }
  | { field_cmp: FieldCmp };

export interface PrefilterSpec {
  any: string[];
  none: string[];
  min_len: number | null;
}
export interface ClassifyRule {
  id: string;
  when: Condition;
  verdict: RuleVerdict;
  confidence: number;
  set: Record<string, unknown>;
}
export type ExtractorConfig =
  | { extractor: "vn_money"; near: string[]; window: number }
  | { extractor: "vn_phone" }
  | { extractor: "vn_area" }
  | { extractor: "gazetteer"; dict: string; scope: string | null }
  | { extractor: "number"; units: string[]; prefixes: string[]; multipliers: Record<string, number> }
  | { extractor: "date_vi" }
  | { extractor: "enum_kw"; map: Record<string, string[]>; multi: boolean }
  | { extractor: "regex"; pattern: string; group: number; cast: RegexCast };
export type ExtractRule = { field: string } & ExtractorConfig;
export interface Thresholds {
  accept: number;
  reject: number;
}
export interface RulesetBody {
  dsl: number;
  prefilter: PrefilterSpec | null;
  classify: ClassifyRule[];
  extract: ExtractRule[];
  thresholds: Thresholds;
}

export type RulesetOutcome =
  | { kind: "prefilter_reject" }
  | { kind: "definite_match"; rule_id: string; confidence: number; fields: ExtractedFields; set: Record<string, unknown> }
  | { kind: "definite_no_match"; rule_id: string; confidence: number; set: Record<string, unknown> }
  | {
      kind: "uncertain";
      hint_fields: ExtractedFields;
      matched_rule_id: string | null;
      verdict: RuleVerdict | null;
      confidence: number | null;
      set: Record<string, unknown>;
    };

export interface RulesetSummary {
  accept_keywords: string[];
  reject_keywords: string[];
  extracted_fields: string[];
}

/** Schema, regex safety, or latency error. `message` equals the Rust `Display` string. */
export class RulesetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetValidationError";
  }
}
const rve = (m: string): RulesetValidationError => new RulesetValidationError(m);

/** JSON that does not satisfy the serde schema of `RulesetBody` (a `serde_json::Error`). */
export class RulesetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetParseError";
  }
}

// ---------- serde-compatible parsing ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const perr = (m: string): RulesetParseError => new RulesetParseError(m);

function asObj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw perr(`invalid type: expected ${what} as a map`);
  return v;
}
function strArr(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw perr(`invalid type for ${what}: expected a sequence of strings`);
  return v as string[];
}
function usize(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw perr(`invalid value for ${what}: expected unsigned integer`);
  return v;
}
function f64(v: unknown, what: string): number {
  if (typeof v !== "number") throw perr(`invalid type for ${what}: expected f64`);
  return v;
}

const FILTER_OPS = ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"];

export function parseCondition(v: unknown): Condition {
  const o = asObj(v, "Condition");
  const keys = Object.keys(o);
  if (keys.length !== 1) throw perr("expected externally tagged Condition with a single key");
  const k = keys[0];
  const x = o[k];
  switch (k) {
    case "all":
    case "any":
      if (!Array.isArray(x)) throw perr(`invalid type for ${k}: expected a sequence`);
      return (k === "all" ? { all: x.map(parseCondition) } : { any: x.map(parseCondition) }) as Condition;
    case "not":
      return { not: parseCondition(x) };
    case "kw_any":
      return { kw_any: strArr(x, k) };
    case "kw_none":
      return { kw_none: strArr(x, k) };
    case "re":
      if (typeof x !== "string") throw perr("invalid type for re: expected a string");
      return { re: x };
    case "has_field":
      if (typeof x !== "string") throw perr("invalid type for has_field: expected a string");
      return { has_field: x };
    case "len_lt":
      return { len_lt: usize(x, k) };
    case "len_gt":
      return { len_gt: usize(x, k) };
    case "lang_in":
      return { lang_in: strArr(x, k) };
    case "field_cmp": {
      const c = asObj(x, "FieldCmp");
      if (typeof c.field !== "string") throw perr("missing field `field`");
      if (typeof c.op !== "string" || !FILTER_OPS.includes(c.op)) throw perr("unknown variant for `op`");
      return { field_cmp: { field: c.field, op: c.op as FilterOp, value: c.value === undefined ? null : c.value } };
    }
    default:
      throw perr(`unknown variant \`${k}\``);
  }
}

function parseExtractRule(v: unknown): ExtractRule {
  const o = asObj(v, "ExtractRule");
  if (typeof o.field !== "string") throw perr("missing field `field`");
  const field = o.field;
  const tag = o.extractor;
  if (typeof tag !== "string") throw perr("missing field `extractor`");
  switch (tag) {
    case "vn_money":
      return {
        field,
        extractor: "vn_money",
        near: o.near === undefined ? [] : strArr(o.near, "near"),
        window: o.window === undefined ? DEFAULT_MONEY_WINDOW : usize(o.window, "window"),
      };
    case "vn_phone":
      return { field, extractor: "vn_phone" };
    case "vn_area":
      return { field, extractor: "vn_area" };
    case "gazetteer":
      if (o.dict !== undefined && typeof o.dict !== "string") throw perr("invalid type for dict");
      if (o.scope !== undefined && o.scope !== null && typeof o.scope !== "string") throw perr("invalid type for scope");
      return { field, extractor: "gazetteer", dict: (o.dict as string | undefined) ?? "vn_admin", scope: (o.scope as string | null | undefined) ?? null };
    case "number": {
      const multipliers: Record<string, number> = {};
      if (o.multipliers !== undefined) {
        for (const [mk, mv] of Object.entries(asObj(o.multipliers, "multipliers"))) multipliers[mk] = f64(mv, `multipliers.${mk}`);
      }
      return {
        field,
        extractor: "number",
        units: o.units === undefined ? [] : strArr(o.units, "units"),
        prefixes: o.prefixes === undefined ? [] : strArr(o.prefixes, "prefixes"),
        multipliers,
      };
    }
    case "date_vi":
      return { field, extractor: "date_vi" };
    case "enum_kw": {
      const map: Record<string, string[]> = {};
      for (const [mk, mv] of Object.entries(asObj(o.map, "map"))) map[mk] = strArr(mv, `map.${mk}`);
      if (o.multi !== undefined && typeof o.multi !== "boolean") throw perr("invalid type for multi");
      return { field, extractor: "enum_kw", map, multi: (o.multi as boolean | undefined) ?? false };
    }
    case "regex": {
      if (typeof o.pattern !== "string") throw perr("missing field `pattern`");
      const cast = o.cast === undefined ? "string" : o.cast;
      if (cast !== "string" && cast !== "int" && cast !== "float" && cast !== "bool") throw perr("unknown variant for `cast`");
      return { field, extractor: "regex", pattern: o.pattern, group: o.group === undefined ? 0 : usize(o.group, "group"), cast };
    }
    default:
      throw perr(`unknown variant \`${tag}\` for extractor`);
  }
}

/** serde `Deserialize` of `RulesetBody` (defaults applied, unknown keys ignored). */
export function parseRulesetBody(v: unknown): RulesetBody {
  const o = asObj(v, "RulesetBody");
  let prefilter: PrefilterSpec | null = null;
  if (o.prefilter !== undefined && o.prefilter !== null) {
    const p = asObj(o.prefilter, "PrefilterSpec");
    prefilter = {
      any: p.any === undefined ? [] : strArr(p.any, "any"),
      none: p.none === undefined ? [] : strArr(p.none, "none"),
      min_len: p.min_len === undefined || p.min_len === null ? null : usize(p.min_len, "min_len"),
    };
  }
  const classifyRaw = o.classify === undefined ? [] : o.classify;
  if (!Array.isArray(classifyRaw)) throw perr("invalid type for classify: expected a sequence");
  const classify = classifyRaw.map((r): ClassifyRule => {
    const c = asObj(r, "ClassifyRule");
    if (typeof c.id !== "string") throw perr("missing field `id`");
    if (c.verdict !== "match" && c.verdict !== "no_match") throw perr("unknown variant for `verdict`");
    return {
      id: c.id,
      when: parseCondition(c.when),
      verdict: c.verdict,
      confidence: f64(c.confidence, "confidence"),
      set: c.set === undefined ? {} : { ...asObj(c.set, "set") },
    };
  });
  const extractRaw = o.extract === undefined ? [] : o.extract;
  if (!Array.isArray(extractRaw)) throw perr("invalid type for extract: expected a sequence");
  let thresholds: Thresholds = { accept: 0.9, reject: 0.9 };
  if (o.thresholds !== undefined) {
    const t = asObj(o.thresholds, "Thresholds");
    thresholds = {
      accept: t.accept === undefined ? 0.9 : f64(t.accept, "accept"),
      reject: t.reject === undefined ? 0.9 : f64(t.reject, "reject"),
    };
  }
  let dsl = SUPPORTED_DSL_VERSION;
  if (o.dsl !== undefined) {
    if (typeof o.dsl !== "number" || !Number.isInteger(o.dsl) || o.dsl < 0 || o.dsl > 4_294_967_295) throw perr("invalid value for dsl");
    dsl = o.dsl;
  }
  return { dsl, prefilter, classify, extract: extractRaw.map(parseExtractRule), thresholds };
}

/** serde `Serialize` of `RulesetBody` (struct field order, externally tagged conditions). */
export function rulesetBodyToJson(b: RulesetBody): unknown {
  return {
    dsl: b.dsl,
    prefilter: b.prefilter ? { any: b.prefilter.any, none: b.prefilter.none, min_len: b.prefilter.min_len } : null,
    classify: b.classify.map((r) => ({ id: r.id, when: r.when, verdict: r.verdict, confidence: r.confidence, set: sortRecord(r.set) })),
    extract: b.extract.map(extractRuleToJson),
    thresholds: { accept: b.thresholds.accept, reject: b.thresholds.reject },
  };
}

function sortRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(sortedEntries(r));
}

function extractRuleToJson(e: ExtractRule): unknown {
  switch (e.extractor) {
    case "vn_money":
      return { field: e.field, extractor: e.extractor, near: e.near, window: e.window };
    case "gazetteer":
      return { field: e.field, extractor: e.extractor, dict: e.dict, scope: e.scope };
    case "number":
      return { field: e.field, extractor: e.extractor, units: e.units, prefixes: e.prefixes, multipliers: sortRecord(e.multipliers) };
    case "enum_kw":
      return { field: e.field, extractor: e.extractor, map: sortRecord(e.map), multi: e.multi };
    case "regex":
      return { field: e.field, extractor: e.extractor, pattern: e.pattern, group: e.group, cast: e.cast };
    default:
      return { field: e.field, extractor: e.extractor };
  }
}

// ---------- compiled structures ----------

type PatternItem = { kind: "keyword"; value: string } | { kind: "regex"; re: CompiledRegex };

class CompiledPatternList {
  readonly keywordItems: string[] = [];
  readonly regexItems: CompiledRegex[] = [];
  readonly kwPatterns: CompiledEnumPatterns | null;
  constructor(items: PatternItem[]) {
    for (const it of items) {
      if (it.kind === "keyword") this.keywordItems.push(it.value);
      else this.regexItems.push(it.re);
    }
    this.kwPatterns = this.keywordItems.length >= 3 ? compileEnumPatterns({ _: this.keywordItems }) : null;
  }
  isEmpty(): boolean {
    return this.keywordItems.length === 0 && this.regexItems.length === 0;
  }
  matchesAny(folded: FoldedText): boolean {
    const kw = this.kwPatterns
      ? matchesAnyEnumKw(folded, this.kwPatterns)
      : this.keywordItems.some((k) => kwContainsFolded(folded.text_fold, k));
    return kw || this.regexItems.some((r) => r.test.test(folded.text_fold));
  }
}

type CompiledCondition =
  | { t: "all" | "any"; items: CompiledCondition[] }
  | { t: "not"; inner: CompiledCondition }
  | { t: "kw_any" | "kw_none"; list: CompiledPatternList }
  | { t: "re"; re: CompiledRegex }
  | { t: "has_field"; field: string }
  | { t: "len_lt" | "len_gt"; n: number }
  | { t: "lang_in"; langs: string[] }
  | { t: "field_cmp"; cmp: FieldCmp };

type CompiledExtractor =
  | { t: "vn_money"; nearFolded: string[]; window: number }
  | { t: "vn_phone" }
  | { t: "vn_area" }
  | { t: "gazetteer"; scope: string | null }
  | { t: "number"; cfg: NumberExtractorConfig }
  | { t: "date_vi" }
  | { t: "enum_kw"; patterns: CompiledEnumPatterns; multi: boolean }
  | { t: "regex"; regex: CompiledRegex; group: number; cast: RegexCast };

interface CompiledPrefilter {
  any: CompiledPatternList;
  none: CompiledPatternList;
  minLen: number | null;
}

const charCount = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n += 1;
  }
  return n;
};

export function isValidRulesetFieldKey(key: string): boolean {
  return key.length > 0 && key.length <= 64 && /^[a-z][a-z0-9_]*$/.test(key);
}

function regexError(context: string, e: unknown): RulesetValidationError {
  if (e instanceof RegexSafetyError) return rve(`regex error in ${context}: ${e.message}`);
  throw e;
}

function compilePatternItem(raw: string, context: string): PatternItem {
  if (raw.startsWith("re:")) {
    try {
      return { kind: "regex", re: compileSafeRegex(raw.slice(3)) };
    } catch (e) {
      throw regexError(context, e);
    }
  }
  const folded = foldText(raw);
  if (folded.length === 0) throw rve("empty condition list or keyword list in `keyword`");
  return { kind: "keyword", value: folded };
}

function conditionEvalCost(c: CompiledCondition): number {
  switch (c.t) {
    case "has_field":
    case "len_lt":
    case "len_gt":
    case "lang_in":
    case "field_cmp":
      return 0;
    case "not":
      return Math.min(255, conditionEvalCost(c.inner) + 1);
    case "all":
    case "any":
      return Math.max(1, ...c.items.map(conditionEvalCost));
    default:
      return 3;
  }
}

function compileCondition(cond: Condition, depth: number, ruleId: string): CompiledCondition {
  if (depth > MAX_CONDITION_DEPTH) throw rve(`condition tree exceeds maximum nesting depth of ${MAX_CONDITION_DEPTH}`);
  if ("all" in cond || "any" in cond) {
    const name = "all" in cond ? "all" : "any";
    const items = "all" in cond ? cond.all : (cond as { any: Condition[] }).any;
    if (items.length === 0) throw rve(`empty condition list or keyword list in \`${name}\``);
    const out = items.map((c) => compileCondition(c, depth + 1, ruleId));
    // Stable sort: O(1) predicates first so conjunctions short-circuit.
    const sorted = out.map((c, i) => [c, i] as const).sort((a, b) => conditionEvalCost(a[0]) - conditionEvalCost(b[0]) || a[1] - b[1]);
    return { t: name, items: sorted.map(([c]) => c) };
  }
  if ("not" in cond) return { t: "not", inner: compileCondition(cond.not, depth + 1, ruleId) };
  if ("kw_any" in cond || "kw_none" in cond) {
    const name = "kw_any" in cond ? "kw_any" : "kw_none";
    const kws = "kw_any" in cond ? cond.kw_any : (cond as { kw_none: string[] }).kw_none;
    if (kws.length === 0) throw rve(`empty condition list or keyword list in \`${name}\``);
    return { t: name, list: new CompiledPatternList(kws.map((k) => compilePatternItem(k, `rule \`${ruleId}\` ${name}`))) };
  }
  if ("re" in cond) {
    try {
      return { t: "re", re: compileSafeRegex(cond.re) };
    } catch (e) {
      throw regexError(`rule \`${ruleId}\` re`, e);
    }
  }
  if ("has_field" in cond) {
    if (!isValidRulesetFieldKey(cond.has_field)) throw rve(`invalid field name \`${cond.has_field}\``);
    return { t: "has_field", field: cond.has_field };
  }
  if ("len_lt" in cond) return { t: "len_lt", n: cond.len_lt };
  if ("len_gt" in cond) return { t: "len_gt", n: cond.len_gt };
  if ("lang_in" in cond) {
    if (cond.lang_in.length === 0) throw rve("empty condition list or keyword list in `lang_in`");
    return { t: "lang_in", langs: cond.lang_in.map((l) => canonicalLangCode(l)) };
  }
  if (!isValidRulesetFieldKey(cond.field_cmp.field)) throw rve(`invalid field name \`${cond.field_cmp.field}\``);
  return { t: "field_cmp", cmp: cond.field_cmp };
}

function compileExtractor(field: string, cfg: ExtractorConfig): CompiledExtractor {
  switch (cfg.extractor) {
    case "vn_money":
      return { t: "vn_money", nearFolded: cfg.near.map((s) => foldText(s)).filter((s) => s.length > 0), window: cfg.window };
    case "vn_phone":
      return { t: "vn_phone" };
    case "vn_area":
      return { t: "vn_area" };
    case "gazetteer":
      if (cfg.dict !== "vn_admin") throw rve(`unsupported gazetteer dictionary \`${cfg.dict}\` (expected \`vn_admin\`)`);
      return { t: "gazetteer", scope: cfg.scope };
    case "number":
      return { t: "number", cfg: { units: cfg.units, prefixes: cfg.prefixes, multipliers: cfg.multipliers } };
    case "date_vi":
      return { t: "date_vi" };
    case "enum_kw": {
      const values = Object.values(cfg.map);
      if (values.length === 0 || values.some((k) => k.length === 0)) throw rve(`empty \`enum_kw\` map on field \`${field}\``);
      return { t: "enum_kw", patterns: compileEnumPatterns(cfg.map), multi: cfg.multi };
    }
    case "regex": {
      let regex: CompiledRegex;
      try {
        regex = compileSafeRegex(cfg.pattern);
      } catch (e) {
        throw regexError(`extract \`${field}\``, e);
      }
      if (cfg.group > regex.captureCount) {
        throw regexError(`extract \`${field}\``, RegexSafetyError.invalidCaptureGroup(cfg.group, regex.captureCount));
      }
      return { t: "regex", regex, group: cfg.group, cast: cfg.cast };
    }
  }
}

interface CompiledClassify {
  id: string;
  when: CompiledCondition;
  verdict: RuleVerdict;
  confidence: number;
  set: Record<string, unknown>;
}

/** Precompiled, executable ruleset. */
export class CompiledRuleset {
  constructor(
    private readonly prefilter: CompiledPrefilter | null,
    private readonly classify: CompiledClassify[],
    private readonly extract: Array<{ field: string; extractor: CompiledExtractor }>,
    private readonly thresholds: Thresholds,
  ) {}

  evaluate(post: NormalizedText, fieldDefs: readonly FieldDef[], refTsMs: number): RulesetOutcome {
    return this.evaluateWithFolded(post, foldWithSpans(post.text_norm), fieldDefs, refTsMs);
  }

  evaluateWithFolded(post: NormalizedText, folded: FoldedText, fieldDefs: readonly FieldDef[], refTsMs: number): RulesetOutcome {
    if (this.prefilter && !evalPrefilter(this.prefilter, post.text_norm, folded)) return { kind: "prefilter_reject" };
    const extracted = this.runExtractors(post, folded, refTsMs);
    return this.classifyExtracted(post, folded, fieldDefs, extracted);
  }

  /** Runs prefilter, every extractor and every classify rule (no short-circuit) for the latency check. */
  benchmarkFullPass(post: NormalizedText, folded: FoldedText, refTsMs: number): number {
    const pfOk = this.prefilter ? evalPrefilter(this.prefilter, post.text_norm, folded) : true;
    const extracted = this.runExtractors(post, folded, refTsMs);
    for (const rule of this.classify) evalCondition(rule.when, post, folded, extracted);
    return Number(pfOk) + Object.keys(extracted).length;
  }

  runExtractors(post: NormalizedText, folded: FoldedText, refTsMs: number): ExtractedFields {
    const out: ExtractedFields = {};
    for (const item of this.extract) {
      if (Object.prototype.hasOwnProperty.call(out, item.field)) continue;
      const first = this.firstMatch(item.extractor, post, folded, refTsMs);
      if (first) out[item.field] = intoExtractedField(first, "rule");
    }
    return out;
  }

  private firstMatch(ex: CompiledExtractor, post: NormalizedText, folded: FoldedText, refTsMs: number): ExtractionMatch | undefined {
    const t = post.text_norm;
    switch (ex.t) {
      case "vn_money":
        return extractVnMoneyFromFolded(t, folded, ex.nearFolded, ex.window, true)[0];
      case "vn_phone":
        return extractVnPhoneFirst(t) ?? undefined;
      case "vn_area":
        return extractVnAreaFromFolded(t, folded, true)[0];
      case "gazetteer":
        return extractGazetteerFromFolded(t, folded, ex.scope, true)[0];
      case "number":
        return extractNumberFromFolded(t, folded, ex.cfg)[0];
      case "date_vi":
        return extractDateViFromFolded(t, folded, refTsMs)[0];
      case "enum_kw":
        return extractEnumKwCompiled(t, folded, ex.patterns, ex.multi, true)[0];
      case "regex":
        return extractCompiledRegex(t, folded, ex.regex, ex.group, ex.cast, true)[0];
    }
  }

  private classifyExtracted(
    post: NormalizedText,
    folded: FoldedText,
    fieldDefs: readonly FieldDef[],
    extracted: ExtractedFields,
  ): RulesetOutcome {
    for (const rule of this.classify) {
      if (!evalCondition(rule.when, post, folded, extracted)) continue;
      if (rule.verdict === "match") {
        const allRequired = fieldDefs.filter((d) => d.required).every((d) => Object.prototype.hasOwnProperty.call(extracted, d.key));
        if (rule.confidence >= this.thresholds.accept && allRequired) {
          return { kind: "definite_match", rule_id: rule.id, confidence: rule.confidence, fields: extracted, set: rule.set };
        }
        return { kind: "uncertain", hint_fields: extracted, matched_rule_id: rule.id, verdict: "match", confidence: rule.confidence, set: rule.set };
      }
      if (rule.confidence >= this.thresholds.reject) {
        return { kind: "definite_no_match", rule_id: rule.id, confidence: rule.confidence, set: rule.set };
      }
      return { kind: "uncertain", hint_fields: extracted, matched_rule_id: rule.id, verdict: "no_match", confidence: rule.confidence, set: rule.set };
    }
    return { kind: "uncertain", hint_fields: extracted, matched_rule_id: null, verdict: null, confidence: null, set: {} };
  }
}

function evalPrefilter(pf: CompiledPrefilter, textNorm: string, folded: FoldedText): boolean {
  if (pf.minLen !== null && charCount(textNorm) < pf.minLen) return false;
  if (!pf.any.isEmpty() && !pf.any.matchesAny(folded)) return false;
  if (pf.none.matchesAny(folded)) return false;
  return true;
}

function evalCondition(c: CompiledCondition, post: NormalizedText, folded: FoldedText, extracted: ExtractedFields): boolean {
  switch (c.t) {
    case "all":
      return c.items.every((x) => evalCondition(x, post, folded, extracted));
    case "any":
      return c.items.some((x) => evalCondition(x, post, folded, extracted));
    case "not":
      return !evalCondition(c.inner, post, folded, extracted);
    case "kw_any":
      return c.list.matchesAny(folded);
    case "kw_none":
      return !c.list.matchesAny(folded);
    case "re":
      return c.re.test.test(folded.text_fold) || (!/^[\x00-\x7f]*$/.test(c.re.source) && c.re.test.test(post.text_norm));
    case "has_field": {
      const ef = Object.prototype.hasOwnProperty.call(extracted, c.field) ? extracted[c.field] : undefined;
      return ef !== undefined && ef.value !== null && ef.value !== undefined;
    }
    case "len_lt":
      return charCount(post.text_norm) < c.n;
    case "len_gt":
      return charCount(post.text_norm) > c.n;
    case "lang_in": {
      const lang = canonicalLangCode(post.lang);
      return c.langs.includes(lang);
    }
    case "field_cmp": {
      const ef = Object.prototype.hasOwnProperty.call(extracted, c.cmp.field) ? extracted[c.cmp.field] : undefined;
      return ef !== undefined && compareFieldValue(ef.value, c.cmp.op, c.cmp.value);
    }
  }
}

// ---------- compile / validate ----------

export function compileRulesetUnchecked(ruleset: RulesetBody): CompiledRuleset {
  if (ruleset.dsl !== SUPPORTED_DSL_VERSION) {
    throw rve(`unsupported DSL version ${ruleset.dsl} (expected ${SUPPORTED_DSL_VERSION})`);
  }
  const { accept, reject } = ruleset.thresholds;
  if (!Number.isFinite(accept) || accept <= 0 || accept > 1 || !Number.isFinite(reject) || reject <= 0 || reject > 1) {
    throw rve(`invalid thresholds: accept=${fmtF64(accept)}, reject=${fmtF64(reject)} (must be in (0.0, 1.0])`);
  }
  let prefilter: CompiledPrefilter | null = null;
  if (ruleset.prefilter) {
    prefilter = {
      any: new CompiledPatternList(ruleset.prefilter.any.map((i) => compilePatternItem(i, "prefilter.any"))),
      none: new CompiledPatternList(ruleset.prefilter.none.map((i) => compilePatternItem(i, "prefilter.none"))),
      minLen: ruleset.prefilter.min_len,
    };
  }
  const seen = new Set<string>();
  const classify: CompiledClassify[] = [];
  for (const rule of ruleset.classify) {
    const id = rule.id.trim();
    if (id.length === 0) throw rve("classify rule has empty id");
    if (seen.has(id)) throw rve(`duplicate classify rule id \`${id}\``);
    seen.add(id);
    if (!Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1) {
      throw rve(`invalid confidence ${fmtF64(rule.confidence)} on rule \`${id}\` (must be in [0.0, 1.0])`);
    }
    classify.push({ id, when: compileCondition(rule.when, 0, id), verdict: rule.verdict, confidence: rule.confidence, set: rule.set });
  }
  const extract: Array<{ field: string; extractor: CompiledExtractor }> = [];
  for (const ext of ruleset.extract) {
    if (!isValidRulesetFieldKey(ext.field)) throw rve(`invalid field name \`${ext.field}\``);
    extract.push({ field: ext.field, extractor: compileExtractor(ext.field, ext) });
  }
  return new CompiledRuleset(prefilter, classify, extract, { ...ruleset.thresholds });
}

/** Rust `{}` of an f64 (always a decimal point for integral values only under `{:?}`; Display omits it). */
function fmtF64(v: number): string {
  return String(v);
}

const BENCH_PARAGRAPH =
  "Cần thuê căn hộ chung cư 2 phòng ngủ ở khu vực Dịch Vọng, Cầu Giấy, Hà Nội. " +
  "Gia đình trẻ ở sạch sẽ giữ gìn đồ đạc, tài chính tầm 12 - 15 triệu/tháng, diện tích khoảng " +
  "65m2 - 75m2, dọn vào đầu tháng sau hoặc ngày 15/11/2026. Liên hệ chính chủ không qua trung gian " +
  "theo số 0912.345.678. Yêu cầu có ban công thoáng mát, nội thất cơ bản điều hoà nóng lạnh tủ bếp, " +
  "gần trường học và công viên Cầu Giấy. ";

let benchCache: { norm: NormalizedText; folded: FoldedText } | null = null;
function benchmarkPost(): { norm: NormalizedText; folded: FoldedText } {
  if (!benchCache) {
    let buf = "";
    while (Array.from(buf).length < 5000) buf += BENCH_PARAGRAPH;
    const norm = normalizeText(Array.from(buf).slice(0, 5000).join(""));
    benchCache = { norm, folded: foldWithSpans(norm.text_norm) };
  }
  return benchCache;
}

export interface ValidateOptions {
  /** Median latency budget in ms (Rust: 1 ms; default here {@link MAX_RULESET_EXEC_MS}). `Infinity` disables the check. */
  maxMedianMs?: number;
}

function measureMedian5(compiled: CompiledRuleset, norm: NormalizedText, folded: FoldedText, refTsMs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    compiled.benchmarkFullPass(norm, folded, refTsMs);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

/** Compile and verify the median latency on a 5,000-char Vietnamese post (05-pipeline-rules.md §6.4). */
export function validateRuleset(ruleset: RulesetBody, opts: ValidateOptions = {}): CompiledRuleset {
  const compiled = compileRulesetUnchecked(ruleset);
  const budget = opts.maxMedianMs ?? MAX_RULESET_EXEC_MS;
  if (!Number.isFinite(budget)) return compiled;
  const { norm, folded } = benchmarkPost();
  const refTsMs = 1_794_384_000_000;
  compiled.benchmarkFullPass(norm, folded, refTsMs);
  let median = measureMedian5(compiled, norm, folded, refTsMs);
  for (let i = 0; i < 3 && median >= budget; i += 1) {
    median = Math.min(median, measureMedian5(compiled, norm, folded, refTsMs));
  }
  if (median >= budget) {
    throw rve(`ruleset median execution time ${Math.round(median * 1000)}µs exceeded ${Math.round(budget * 1000)}µs budget on 5,000-char post`);
  }
  return compiled;
}

export function evaluateRuleset(
  ruleset: RulesetBody,
  post: NormalizedText,
  fieldDefs: readonly FieldDef[],
  refTsMs: number,
): RulesetOutcome {
  return compileRulesetUnchecked(ruleset).evaluate(post, fieldDefs, refTsMs);
}

// ---------- describe ----------

function pushUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function collectConditionKeywords(cond: Condition, positive: boolean, accept: string[], reject: string[]): void {
  if ("all" in cond || "any" in cond) {
    const items = "all" in cond ? cond.all : (cond as { any: Condition[] }).any;
    for (const item of items) collectConditionKeywords(item, positive, accept, reject);
  } else if ("not" in cond) {
    collectConditionKeywords(cond.not, !positive, accept, reject);
  } else if ("kw_any" in cond) {
    for (const kw of cond.kw_any) pushUnique(positive ? accept : reject, kw);
  } else if ("kw_none" in cond) {
    for (const kw of cond.kw_none) pushUnique(positive ? reject : accept, kw);
  }
}

export function describeRuleset(ruleset: RulesetBody): RulesetSummary {
  const accept: string[] = [];
  const reject: string[] = [];
  if (ruleset.prefilter) {
    for (const kw of ruleset.prefilter.any) pushUnique(accept, kw);
    for (const kw of ruleset.prefilter.none) pushUnique(reject, kw);
  }
  for (const rule of ruleset.classify) collectConditionKeywords(rule.when, rule.verdict === "match", accept, reject);
  const fields: string[] = [];
  for (const e of ruleset.extract) pushUnique(fields, e.field);
  return { accept_keywords: accept, reject_keywords: reject, extracted_fields: fields };
}
