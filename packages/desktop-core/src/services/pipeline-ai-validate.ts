// Semantic validators and response mappers for the pipeline AI tasks. Port of
// crates/ai-bridge/src/schema/semantic.rs plus the serde deserialization of the task outputs.
// Every failure is an `AiError` of kind `invalid_output` (retryable once, bisectable for batches).

import { AiError } from "../ai/types";
import { compileSafeRegex } from "../rules/extractors/regex-ext";
import type { FieldDef } from "../store/domain";
import type {
  AiFieldCandidate,
  AiWantIntent,
  JudgeItemResult,
  PipelineAuthorRole,
  PostIntent,
  SuggestFieldsBridgeOutput,
} from "../pipeline/types";

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: JsonObject, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const bad = (detail: string): AiError => AiError.invalidOutput(detail);

const FIELD_TYPES = ["text", "number", "money", "phone", "location", "enum", "multi_enum", "boolean", "date", "range", "url"];
const WANT_INTENTS: readonly AiWantIntent[] = ["demand", "supply", "any"];
const INTENTS: readonly PostIntent[] = ["demand", "supply", "other"];
const ROLES: readonly PipelineAuthorRole[] = ["end_user", "peer", "unknown"];
const U32_MAX = 4_294_967_295;

// ---- serde-like readers (`<task> deserialization error: ...`) --------------------------------------

class Reader {
  constructor(private readonly task: string) {}

  error(detail: string): AiError {
    return bad(`${this.task} deserialization error: ${detail}`);
  }
  fail(detail: string): never {
    throw this.error(detail);
  }
  obj(v: Json, what: string): JsonObject {
    if (!isObject(v)) throw this.error(`invalid type for ${what}: expected a map`);
    return v;
  }
  arr(v: Json, what: string): Json[] {
    if (!Array.isArray(v)) throw this.error(`invalid type for ${what}: expected a sequence`);
    return v;
  }
  str(o: JsonObject, k: string): string {
    if (!has(o, k)) throw this.error(`missing field \`${k}\``);
    const v = o[k];
    if (typeof v !== "string") throw this.error(`invalid type for \`${k}\`: expected a string`);
    return v;
  }
  num(o: JsonObject, k: string): number {
    if (!has(o, k)) throw this.error(`missing field \`${k}\``);
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw this.error(`invalid type for \`${k}\`: expected a number`);
    return v;
  }
  bool(o: JsonObject, k: string, dflt?: boolean): boolean {
    if (!has(o, k)) {
      if (dflt !== undefined) return dflt;
      throw this.error(`missing field \`${k}\``);
    }
    const v = o[k];
    if (typeof v !== "boolean") throw this.error(`invalid type for \`${k}\`: expected a boolean`);
    return v;
  }
  oneOf<T extends string>(o: JsonObject, k: string, allowed: readonly T[]): T {
    const v = this.str(o, k);
    if (!(allowed as readonly string[]).includes(v)) throw this.error(`unknown variant \`${v}\` for \`${k}\``);
    return v as T;
  }
  /** `Option<Vec<String>>` (missing and null are both `None`). */
  optStrArray(o: JsonObject, k: string): string[] | null {
    if (!has(o, k) || o[k] === null) return null;
    return this.strArray(o[k], k);
  }
  /** `Vec<String>` with `#[serde(default)]`. */
  strArrayDefault(o: JsonObject, k: string): string[] {
    if (!has(o, k) || o[k] === null) return [];
    return this.strArray(o[k], k);
  }
  strArray(v: Json, what: string): string[] {
    const a = this.arr(v, what);
    if (a.some((s) => typeof s !== "string")) throw this.error(`invalid type in \`${what}\`: expected a string`);
    return a as string[];
  }
}

// ---- suggest_fields -----------------------------------------------------------------------------

/** Deserialize and semantically validate a `suggest_fields` response. */
export function validateSuggestFieldsOutput(val: Json): SuggestFieldsBridgeOutput {
  const r = new Reader("suggest_fields");
  const root = r.obj(val, "output");

  const fields = r.arr(has(root, "fields") ? root.fields : r.fail("missing field `fields`"), "fields").map((item) => {
    const f = r.obj(item, "field");
    const type = r.oneOf(f, "type", FIELD_TYPES);
    const options = r.optStrArray(f, "options");
    const out: SuggestFieldsBridgeOutput["fields"][number] = {
      key: r.str(f, "key"),
      label: r.str(f, "label"),
      type,
      description: r.str(f, "description"),
      required: r.bool(f, "required"),
    };
    if (options !== null) out.options = options;
    return out;
  });

  const hardFilters = (has(root, "hard_filters") && root.hard_filters !== null ? r.arr(root.hard_filters, "hard_filters") : []).map((item) => {
    const h = r.obj(item, "hard_filter");
    if (!has(h, "value")) r.fail("missing field `value`");
    return {
      field: r.str(h, "field"),
      op: r.str(h, "op"),
      value: h.value,
      when_missing: has(h, "when_missing") && h.when_missing !== null ? r.str(h, "when_missing") : "pass",
    };
  });

  let prefilterHint: SuggestFieldsBridgeOutput["prefilter_hint"] = null;
  if (has(root, "prefilter_hint") && root.prefilter_hint !== null) {
    const p = r.obj(root.prefilter_hint, "prefilter_hint");
    prefilterHint = { any: r.strArrayDefault(p, "any"), none: r.strArrayDefault(p, "none") };
  }

  const out: SuggestFieldsBridgeOutput = {
    suggested_name: r.str(root, "suggested_name"),
    want_intent: r.oneOf(root, "want_intent", WANT_INTENTS),
    fields,
    hard_filters: hardFilters,
    clarifying_questions: r.strArrayDefault(root, "clarifying_questions"),
    prefilter_hint: prefilterHint,
    suggested_source_ids: r.strArrayDefault(root, "suggested_source_ids"),
  };

  const seen = new Set<string>();
  for (const f of out.fields) {
    if (seen.has(f.key)) throw bad(`duplicate suggested field key '${f.key}'`);
    seen.add(f.key);
    if ((f.type === "enum" || f.type === "multi_enum") && (!f.options || f.options.length === 0)) {
      throw bad(`field '${f.key}' of type '${f.type}' must include non-empty options`);
    }
  }
  return out;
}

// ---- judge_extract ------------------------------------------------------------------------------

/**
 * Exactly one result per sent `ref`, no unknown or duplicate `ref`, only radar field keys
 * (`06-ai-bridge.md §4` step 3). Returns the results in response order.
 */
export function validateJudgeExtractOutput(val: Json, expectedRefs: readonly number[], radarFields: readonly FieldDef[]): JudgeItemResult[] {
  const r = new Reader("judge_extract");
  const root = r.obj(val, "output");
  const rawResults = r.arr(has(root, "results") ? root.results : r.fail("missing field `results`"), "results");

  const results: JudgeItemResult[] = rawResults.map((item) => {
    const o = r.obj(item, "result");
    const ref = r.num(o, "ref");
    if (!Number.isInteger(ref) || ref < 0 || ref > U32_MAX) r.fail("invalid value for `ref`: expected u32");
    const fieldsObj = r.obj(has(o, "fields") ? o.fields : r.fail("missing field `fields`"), "fields");
    const fields: Record<string, AiFieldCandidate> = {};
    for (const [key, cand] of Object.entries(fieldsObj)) {
      const c = r.obj(cand, `fields.${key}`);
      if (!has(c, "value")) r.fail("missing field `value`");
      const raw = has(c, "raw") && c.raw !== null ? r.str(c, "raw") : null;
      fields[key] = { raw, value: c.value, confidence: r.num(c, "confidence") };
    }
    return {
      ref,
      match: r.bool(o, "match"),
      score: r.num(o, "score"),
      intent: r.oneOf(o, "intent", INTENTS),
      author_role: r.oneOf(o, "author_role", ROLES),
      is_spam: r.bool(o, "is_spam", false),
      summary: r.str(o, "summary"),
      reason: r.str(o, "reason"),
      fields,
    };
  });

  if (results.length !== expectedRefs.length) {
    throw bad(`expected ${expectedRefs.length} results for batch refs [${expectedRefs.join(", ")}], got ${results.length}`);
  }
  const expected = new Set(expectedRefs);
  const allowed = new Set(radarFields.map((f) => f.key));
  const seenRefs = new Set<number>();
  for (const item of results) {
    if (!expected.has(item.ref)) {
      throw bad(`unknown ref ${item.ref} in judge_extract output (expected [${expectedRefs.join(", ")}])`);
    }
    if (seenRefs.has(item.ref)) throw bad(`duplicate ref ${item.ref} in judge_extract output`);
    seenRefs.add(item.ref);
    for (const key of Object.keys(item.fields)) {
      if (!allowed.has(key)) throw bad(`unknown field key '${key}' for ref ${item.ref}`);
    }
  }
  return results;
}

// ---- compile_rules ------------------------------------------------------------------------------

const MAX_REGEX_BYTES = 512;
const ALLOWED_CONDITION_KEYS = ["all", "any", "not", "kw_any", "kw_none", "re", "has_field", "len_lt", "len_gt", "lang_in", "field_cmp"];

/** Port of `has_nested_quantifier`: a quantified group directly followed by another quantifier. */
export function hasNestedQuantifier(pattern: string): boolean {
  const cs = Array.from(pattern);
  const groupHasQuantifier: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < cs.length; i += 1) {
    const ch = cs[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    switch (ch) {
      case "[":
        inClass = true;
        break;
      case "(":
        groupHasQuantifier.push(false);
        break;
      case "+":
      case "*":
      case "{":
        if (groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        break;
      case ")": {
        const inner = groupHasQuantifier.pop() ?? false;
        const next = cs[i + 1];
        if (inner && (next === "+" || next === "*" || next === "{")) return true;
        if (inner && groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        break;
      }
      default:
    }
  }
  return false;
}

/** Length, nested-quantifier and compile checks; the compile step also applies the TS engine's safety rules. */
export function validateSafeRegex(pattern: string, path: string): void {
  if (Buffer.byteLength(pattern, "utf8") > MAX_REGEX_BYTES) throw bad(`${path}: regex exceeds max length of ${MAX_REGEX_BYTES} bytes`);
  if (hasNestedQuantifier(pattern)) throw bad(`${path}: regex '${pattern}' contains nested quantifiers`);
  try {
    compileSafeRegex(pattern);
  } catch (err) {
    throw bad(`${path}: invalid regex '${pattern}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

function validateConditionTree(cond: Json, allowedFields: ReadonlySet<string>, path: string): void {
  if (!isObject(cond)) throw bad(`${path}: condition must be an object`);
  const entries = Object.entries(cond);
  if (entries.length === 0) throw bad(`${path}: condition object cannot be empty`);
  for (const [k, v] of entries) {
    if (!ALLOWED_CONDITION_KEYS.includes(k)) throw bad(`${path}: unknown DSL condition predicate '${k}'`);
    switch (k) {
      case "all":
      case "any": {
        if (!Array.isArray(v)) throw bad(`${path}.${k}: must be an array`);
        v.forEach((sub, i) => validateConditionTree(sub, allowedFields, `${path}.${k}[${i}]`));
        break;
      }
      case "not":
        validateConditionTree(v, allowedFields, `${path}.not`);
        break;
      case "re":
        if (typeof v !== "string") throw bad(`${path}.re: must be a regex string`);
        validateSafeRegex(v, `${path}.re`);
        break;
      case "has_field":
        if (typeof v !== "string") throw bad(`${path}.has_field: must be a field key string`);
        if (allowedFields.size > 0 && !allowedFields.has(v)) throw bad(`${path}.has_field: unknown field '${v}'`);
        break;
      default:
    }
  }
}

/** DSL v1 structure, condition keys and safe regex patterns (`06-ai-bridge.md §5.3`). */
export function validateCompileRulesOutput(val: Json, radarFields: readonly FieldDef[]): void {
  const allowedFields = new Set(radarFields.map((f) => f.key));
  const root = isObject(val) ? val : {};

  if (isObject(root.prefilter)) {
    for (const arrKey of ["any", "none"]) {
      const arr = root.prefilter[arrKey];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (typeof entry === "string" && entry.startsWith("re:")) validateSafeRegex(entry.slice(3), `$.prefilter.${arrKey}`);
      }
    }
  }

  if (Array.isArray(root.classify)) {
    root.classify.forEach((rule, idx) => {
      if (isObject(rule) && has(rule, "when")) validateConditionTree(rule.when, allowedFields, `$.classify[${idx}].when`);
    });
  }

  if (Array.isArray(root.extract)) {
    root.extract.forEach((ext, idx) => {
      const e = isObject(ext) ? ext : {};
      const field = typeof e.field === "string" ? e.field : "";
      if (allowedFields.size > 0 && !allowedFields.has(field)) {
        throw bad(`$.extract[${idx}]: field '${field}' is not in radar definition`);
      }
      if (e.extractor === "regex") {
        if (typeof e.pattern !== "string") throw bad(`$.extract[${idx}]: regex extractor requires 'pattern'`);
        validateSafeRegex(e.pattern, `$.extract[${idx}].pattern`);
      }
    });
  }
}
