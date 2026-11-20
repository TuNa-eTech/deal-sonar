// Ruleset JSON shapes shared by the catalog commands:
//  * the engine DSL body stored in `rulesets.body` (crates/rules `RulesetBody`),
//  * the UI body returned by `ruleset_list` / accepted by `ruleset_save_user`
//    (crates/core/src/dto/system.rs `RulesetBody`),
//  * the lossless converters between them (crates/core/src/dto/ruleset_convert.rs),
//  * the built-in `bds-vi-v1` seed (crates/rules/src/seed.rs).
//
// The engine itself (validation, execution benchmark, holdout gate) is NOT ported here; it is
// injected through `RulesEngine` (see catalog-runtime.ts).

import {
  type Decoder,
  type PlainObject,
  SerdeError,
  dAny,
  dBool,
  dEnum,
  dF64,
  dMap,
  dString,
  dU32,
  dUsize,
  dVec,
  isPlainObject,
  opt,
  req,
  sortedJson,
  struct,
  tryDecode,
  typeError,
  withDefault,
} from "./catalog-serde";
import { dFilterOperator, type FilterOperator } from "./catalog-types";

// ---- engine DSL types --------------------------------------------------------------------------

export type RuleCondition =
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition }
  | { kw_any: string[] }
  | { kw_none: string[] }
  | { re: string }
  | { has_field: string }
  | { len_lt: number }
  | { len_gt: number }
  | { lang_in: string[] }
  | { field_cmp: { field: string; op: FilterOperator; value: unknown } };

export type RegexCast = "string" | "int" | "float" | "bool";
const REGEX_CASTS = ["string", "int", "float", "bool"] as const;

export type ExtractorConfig =
  | { extractor: "vn_money"; near: string[]; window: number }
  | { extractor: "vn_phone" }
  | { extractor: "vn_area" }
  | { extractor: "gazetteer"; dict: string; scope: string | null }
  | { extractor: "number"; units: string[]; prefixes: string[]; multipliers: Record<string, number> }
  | { extractor: "date_vi" }
  | { extractor: "enum_kw"; map: Record<string, string[]>; multi: boolean }
  | { extractor: "regex"; pattern: string; group: number; cast: RegexCast };

export type EngineExtractRule = { field: string } & ExtractorConfig;

export interface EngineClassifyRule {
  id: string;
  when: RuleCondition;
  verdict: "match" | "no_match";
  confidence: number;
  set: Record<string, unknown>;
}

export interface EnginePrefilter {
  any: string[];
  none: string[];
  min_len: number | null;
}

export interface EngineRulesetBody {
  dsl: number;
  prefilter: EnginePrefilter | null;
  classify: EngineClassifyRule[];
  extract: EngineExtractRule[];
  thresholds: { accept: number; reject: number };
}

/** `DEFAULT_MONEY_WINDOW` (crates/rules/src/extractors/money.rs). */
export const DEFAULT_MONEY_WINDOW = 40;

// ---- engine decoders (serde parity for `serde_json::from_value::<RulesetBody>`) ---------------

const CONDITION_VARIANTS = [
  "all",
  "any",
  "not",
  "kw_any",
  "kw_none",
  "re",
  "has_field",
  "len_lt",
  "len_gt",
  "lang_in",
  "field_cmp",
] as const;

const dFieldCmp = struct<{ field: string; op: FilterOperator; value: unknown }>("FieldCmp", {
  field: req(dString),
  op: req(dFilterOperator),
  value: withDefault(dAny, () => null),
});

export const dCondition: Decoder<RuleCondition> = (v) => {
  if (typeof v === "string") {
    if ((CONDITION_VARIANTS as readonly string[]).includes(v)) {
      throw new SerdeError("invalid type: unit variant, expected newtype variant");
    }
    throw new SerdeError(`unknown variant \`${v}\`, expected one of ${CONDITION_VARIANTS.map((x) => `\`${x}\``).join(", ")}`);
  }
  if (!isPlainObject(v)) throw typeError(v, "string or map");
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new SerdeError("expected map with a single key");
  const tag = keys[0];
  const inner = v[tag];
  switch (tag) {
    case "all":
      return { all: dVec(dCondition)(inner) };
    case "any":
      return { any: dVec(dCondition)(inner) };
    case "not":
      return { not: dCondition(inner) };
    case "kw_any":
      return { kw_any: dVec(dString)(inner) };
    case "kw_none":
      return { kw_none: dVec(dString)(inner) };
    case "re":
      return { re: dString(inner) };
    case "has_field":
      return { has_field: dString(inner) };
    case "len_lt":
      return { len_lt: dUsize(inner) };
    case "len_gt":
      return { len_gt: dUsize(inner) };
    case "lang_in":
      return { lang_in: dVec(dString)(inner) };
    case "field_cmp":
      return { field_cmp: dFieldCmp(inner) };
    default:
      throw new SerdeError(
        `unknown variant \`${tag}\`, expected one of ${CONDITION_VARIANTS.map((x) => `\`${x}\``).join(", ")}`,
      );
  }
};

const EXTRACTORS = ["vn_money", "vn_phone", "vn_area", "gazetteer", "number", "date_vi", "enum_kw", "regex"] as const;
const dRegexCast = dEnum(REGEX_CASTS);

const dEngineExtractRule: Decoder<EngineExtractRule> = (v) => {
  if (!isPlainObject(v)) throw typeError(v, "struct ExtractRule");
  const obj: PlainObject = v;
  const field = req(dString).read(obj, "field");
  const tag = req(dString).read(obj, "extractor");
  const read = <T>(f: { read(o: PlainObject, k: string): T }, key: string): T => f.read(obj, key);
  switch (tag) {
    case "vn_money":
      return {
        field,
        extractor: "vn_money",
        near: read(withDefault(dVec(dString), (): string[] => []), "near"),
        window: read(withDefault(dUsize, () => DEFAULT_MONEY_WINDOW), "window"),
      };
    case "vn_phone":
    case "vn_area":
    case "date_vi":
      return { field, extractor: tag };
    case "gazetteer":
      return {
        field,
        extractor: "gazetteer",
        dict: read(withDefault(dString, () => "vn_admin"), "dict"),
        scope: read(opt(dString), "scope"),
      };
    case "number":
      return {
        field,
        extractor: "number",
        units: read(withDefault(dVec(dString), (): string[] => []), "units"),
        prefixes: read(withDefault(dVec(dString), (): string[] => []), "prefixes"),
        multipliers: read(withDefault(dMap(dF64), (): Record<string, number> => ({})), "multipliers"),
      };
    case "enum_kw":
      return {
        field,
        extractor: "enum_kw",
        map: read(req(dMap(dVec(dString))), "map"),
        multi: read(withDefault(dBool, () => false), "multi"),
      };
    case "regex":
      return {
        field,
        extractor: "regex",
        pattern: read(req(dString), "pattern"),
        group: read(withDefault(dUsize, () => 0), "group"),
        cast: read(withDefault(dRegexCast, (): RegexCast => "string"), "cast"),
      };
    default:
      throw new SerdeError(
        `unknown variant \`${tag}\`, expected one of ${EXTRACTORS.map((x) => `\`${x}\``).join(", ")}`,
      );
  }
};

const dEnginePrefilter: Decoder<EnginePrefilter> = struct<EnginePrefilter>("PrefilterSpec", {
  any: withDefault(dVec(dString), (): string[] => []),
  none: withDefault(dVec(dString), (): string[] => []),
  min_len: opt(dUsize),
});

const dEngineClassifyRule: Decoder<EngineClassifyRule> = struct<EngineClassifyRule>("ClassifyRule", {
  id: req(dString),
  when: req(dCondition),
  verdict: req(dEnum(["match", "no_match"] as const)),
  confidence: req(dF64),
  set: withDefault(dMap(dAny), (): Record<string, unknown> => ({})),
});

const dEngineThresholds: Decoder<{ accept: number; reject: number }> = struct<{ accept: number; reject: number }>(
  "Thresholds",
  { accept: withDefault(dF64, () => 0.9), reject: withDefault(dF64, () => 0.9) },
);

/** `serde_json::from_value::<dealsonar_rules::RulesetBody>`. */
export const dEngineRulesetBody: Decoder<EngineRulesetBody> = struct<EngineRulesetBody>("RulesetBody", {
  dsl: withDefault(dU32, () => 1),
  prefilter: opt(dEnginePrefilter),
  classify: withDefault(dVec(dEngineClassifyRule), (): EngineClassifyRule[] => []),
  extract: withDefault(dVec(dEngineExtractRule), (): EngineExtractRule[] => []),
  thresholds: withDefault(dEngineThresholds, () => ({ accept: 0.9, reject: 0.9 })),
});

// ---- UI (DTO) ruleset body ---------------------------------------------------------------------

export interface RulesetExtractorRuleDto {
  field: string;
  extractor: string;
  near: string[] | null;
  window: number | null;
  dict: string | null;
  scope: string | null;
  units: string[] | null;
  prefixes: string[] | null;
  multipliers: Record<string, number> | null;
  pattern: string | null;
  group: number | null;
  cast: RegexCast | null;
  map: Record<string, string[]> | null;
  multi: boolean | null;
}

export interface RulesetClassifyRuleDto {
  id: string;
  description: string | null;
  kw_any: string[] | null;
  kw_none: string[] | null;
  has_field: string | null;
  when: RuleCondition | null;
  verdict: string;
  confidence: number;
  set: Record<string, unknown> | null;
}

export interface RulesetBodyDto {
  dsl: number;
  prefilter: { any: string[]; none: string[]; min_len: number | null };
  classify: RulesetClassifyRuleDto[];
  extract: RulesetExtractorRuleDto[];
  thresholds: { accept: number; reject: number };
}

export interface RulesetMetricsDto {
  rule_handled_pct: number;
  ai_handled_pct: number;
  accept_precision: number;
  false_negative_rate: number;
  sample_size: number;
}

export interface RulesetDto {
  id: string;
  radar_version_id: string;
  revision: number;
  state: string;
  origin: string;
  body: RulesetBodyDto;
  metrics: RulesetMetricsDto | null;
  created_at: number;
  activated_at: number | null;
}

const dExtractorRuleDto: Decoder<RulesetExtractorRuleDto> = struct<RulesetExtractorRuleDto>("RulesetExtractorRule", {
  field: req(dString),
  extractor: req(dString),
  near: opt(dVec(dString)),
  window: opt(dUsize),
  dict: opt(dString),
  scope: opt(dString),
  units: opt(dVec(dString)),
  prefixes: opt(dVec(dString)),
  multipliers: opt(dMap(dF64)),
  pattern: opt(dString),
  group: opt(dUsize),
  cast: opt(dRegexCast),
  map: opt(dMap(dVec(dString))),
  multi: opt(dBool),
});

const dClassifyRuleDto: Decoder<RulesetClassifyRuleDto> = struct<RulesetClassifyRuleDto>("RulesetClassifyRule", {
  id: req(dString),
  description: opt(dString),
  kw_any: opt(dVec(dString)),
  kw_none: opt(dVec(dString)),
  has_field: opt(dString),
  when: opt(dCondition),
  verdict: req(dString),
  confidence: req(dF64),
  set: opt(dMap(dAny)),
});

const dPrefilterDto = struct<{ any: string[]; none: string[]; min_len: number | null }>("RulesetPrefilter", {
  any: withDefault(dVec(dString), (): string[] => []),
  none: withDefault(dVec(dString), (): string[] => []),
  min_len: opt(dUsize),
});

const dThresholdsDto = struct<{ accept: number; reject: number }>("RulesetThresholds", {
  accept: req(dF64),
  reject: req(dF64),
});

const emptyDtoBody = (): RulesetBodyDto => ({
  dsl: 1,
  prefilter: { any: [], none: [], min_len: null },
  classify: [],
  extract: [],
  thresholds: { accept: 0.9, reject: 0.9 },
});

export const dRulesetBodyDto: Decoder<RulesetBodyDto> = struct<RulesetBodyDto>("RulesetBody", {
  dsl: withDefault(dU32, () => 1),
  prefilter: withDefault(dPrefilterDto, () => ({ any: [] as string[], none: [] as string[], min_len: null })),
  classify: withDefault(dVec(dClassifyRuleDto), (): RulesetClassifyRuleDto[] => []),
  extract: withDefault(dVec(dExtractorRuleDto), (): RulesetExtractorRuleDto[] => []),
  thresholds: withDefault(dThresholdsDto, () => ({ accept: 0.9, reject: 0.9 })),
});

const dRulesetMetricsDto: Decoder<RulesetMetricsDto> = struct<RulesetMetricsDto>("RulesetMetrics", {
  rule_handled_pct: req(dF64),
  ai_handled_pct: req(dF64),
  accept_precision: req(dF64),
  false_negative_rate: req(dF64),
  sample_size: req(dUsize),
});

// ---- converters --------------------------------------------------------------------------------

/** `extract_flat_condition_hints`. */
function flatHints(cond: RuleCondition, kwAny: string[], kwNone: string[], hasField: { value: string | null }): void {
  if ("kw_any" in cond) {
    for (const kw of cond.kw_any) if (!kwAny.includes(kw)) kwAny.push(kw);
  } else if ("kw_none" in cond) {
    for (const kw of cond.kw_none) if (!kwNone.includes(kw)) kwNone.push(kw);
  } else if ("has_field" in cond) {
    if (hasField.value === null) hasField.value = cond.has_field;
  } else if ("all" in cond) {
    for (const child of cond.all) flatHints(child, kwAny, kwNone, hasField);
  }
}

const nonEmptyOrNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null);
const sameList = (a: string[] | null, b: string[] | null): boolean =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]));
const blankToNull = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

function extractorToDto(rule: EngineExtractRule): RulesetExtractorRuleDto {
  const base: RulesetExtractorRuleDto = {
    field: rule.field,
    extractor: rule.extractor,
    near: null,
    window: null,
    dict: null,
    scope: null,
    units: null,
    prefixes: null,
    multipliers: null,
    pattern: null,
    group: null,
    cast: null,
    map: null,
    multi: null,
  };
  switch (rule.extractor) {
    case "vn_money":
      return { ...base, near: nonEmptyOrNull(rule.near), window: rule.window };
    case "gazetteer":
      return { ...base, dict: rule.dict, scope: rule.scope };
    case "number":
      return { ...base, units: rule.units, prefixes: rule.prefixes, multipliers: rule.multipliers };
    case "enum_kw":
      return { ...base, map: rule.map, multi: rule.multi };
    case "regex":
      return { ...base, pattern: rule.pattern, group: rule.group, cast: rule.cast };
    default:
      return base;
  }
}

/** `rules_to_dto_ruleset_body`. */
export function engineBodyToDto(body: EngineRulesetBody): RulesetBodyDto {
  return {
    dsl: body.dsl,
    prefilter: body.prefilter
      ? { any: [...body.prefilter.any], none: [...body.prefilter.none], min_len: body.prefilter.min_len }
      : { any: [], none: [], min_len: null },
    classify: body.classify.map((rule): RulesetClassifyRuleDto => {
      const kwAny: string[] = [];
      const kwNone: string[] = [];
      const hasField = { value: null as string | null };
      flatHints(rule.when, kwAny, kwNone, hasField);
      return {
        id: rule.id,
        description: null,
        kw_any: nonEmptyOrNull(kwAny),
        kw_none: nonEmptyOrNull(kwNone),
        has_field: hasField.value,
        when: rule.when,
        verdict: rule.verdict,
        confidence: rule.confidence,
        set: Object.keys(rule.set).length > 0 ? rule.set : null,
      };
    }),
    extract: body.extract.map(extractorToDto),
    thresholds: { accept: body.thresholds.accept, reject: body.thresholds.reject },
  };
}

function extractorFromDto(er: RulesetExtractorRuleDto): EngineExtractRule {
  const field = er.field;
  switch (er.extractor) {
    case "vn_money":
      return { field, extractor: "vn_money", near: er.near ?? [], window: er.window ?? DEFAULT_MONEY_WINDOW };
    case "vn_area":
      return { field, extractor: "vn_area" };
    case "gazetteer":
      return { field, extractor: "gazetteer", dict: er.dict ?? "vn_admin", scope: er.scope };
    case "number":
      return {
        field,
        extractor: "number",
        units: er.units ?? [],
        prefixes: er.prefixes ?? [],
        multipliers: er.multipliers ?? {},
      };
    case "date_vi":
      return { field, extractor: "date_vi" };
    case "enum_kw":
      return { field, extractor: "enum_kw", map: er.map ?? {}, multi: er.multi ?? false };
    case "regex":
      return { field, extractor: "regex", pattern: er.pattern ?? "", group: er.group ?? 0, cast: er.cast ?? "string" };
    default:
      return { field, extractor: "vn_phone" };
  }
}

/** `dto_ruleset_body_to_rules`: flat UI hints never clobber an existing complex `when` tree. */
export function dtoBodyToEngine(dto: RulesetBodyDto): EngineRulesetBody {
  const pf = dto.prefilter;
  const prefilter =
    pf.any.length === 0 && pf.none.length === 0 && pf.min_len === null
      ? null
      : { any: [...pf.any], none: [...pf.none], min_len: pf.min_len };

  const classify = dto.classify.map((r): EngineClassifyRule => {
    const curAny = r.kw_any && r.kw_any.length > 0 ? r.kw_any : null;
    const curNone = r.kw_none && r.kw_none.length > 0 ? r.kw_none : null;
    const curHf = blankToNull(r.has_field);

    let preserveExisting = false;
    if (r.when) {
      const origAny: string[] = [];
      const origNone: string[] = [];
      const origHf = { value: null as string | null };
      flatHints(r.when, origAny, origNone, origHf);
      preserveExisting =
        (sameList(curAny, nonEmptyOrNull(origAny)) &&
          sameList(curNone, nonEmptyOrNull(origNone)) &&
          curHf === blankToNull(origHf.value)) ||
        (curAny === null && curNone === null && curHf === null);
    }

    let when: RuleCondition;
    if (preserveExisting && r.when) {
      when = r.when;
    } else {
      const clauses: RuleCondition[] = [];
      if (curAny) clauses.push({ kw_any: curAny });
      if (curNone) clauses.push({ kw_none: curNone });
      if (curHf) clauses.push({ has_field: curHf });
      if (clauses.length === 0) when = r.when ?? { len_gt: 0 };
      else if (clauses.length === 1) when = clauses[0];
      else when = { all: clauses };
    }
    return {
      id: r.id,
      when,
      verdict: r.verdict === "no_match" ? "no_match" : "match",
      confidence: r.confidence,
      set: r.set ?? {},
    };
  });

  return {
    dsl: dto.dsl,
    prefilter,
    classify,
    extract: dto.extract.map(extractorFromDto),
    thresholds: { accept: dto.thresholds.accept, reject: dto.thresholds.reject },
  };
}

/** Wire form of the UI body: absent `Option`s are omitted (`skip_serializing_if`). */
export function rulesetBodyDtoToWire(body: RulesetBodyDto): unknown {
  const pf: PlainObject = { any: body.prefilter.any, none: body.prefilter.none };
  if (body.prefilter.min_len !== null) pf.min_len = body.prefilter.min_len;
  return {
    dsl: body.dsl,
    prefilter: pf,
    classify: body.classify.map((r) => omitNulls({ ...r })),
    extract: body.extract.map((r) => omitNulls({ ...r })),
    thresholds: body.thresholds,
  };
}

export function omitNulls<T extends object>(obj: T): T {
  const out: PlainObject = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

export interface StoredRuleset {
  id: string;
  radar_version_id: string;
  revision: number;
  state: string;
  origin: string;
  body: unknown;
  metrics: unknown | null;
  created_at: number;
  activated_at: number | null;
}

/** `ruleset_record_to_dto`, serialized as the wire object. */
export function rulesetRecordToWire(rec: StoredRuleset): unknown {
  const engine = tryDecode(dEngineRulesetBody, rec.body);
  const dtoBody: RulesetBodyDto = engine
    ? engineBodyToDto(engine)
    : (tryDecode(dRulesetBodyDto, rec.body) ?? emptyDtoBody());
  const metrics = rec.metrics === null || rec.metrics === undefined ? null : tryDecode(dRulesetMetricsDto, rec.metrics);
  return {
    id: rec.id,
    radar_version_id: rec.radar_version_id,
    revision: rec.revision,
    state: rec.state,
    origin: rec.origin,
    body: rulesetBodyDtoToWire(dtoBody),
    metrics,
    created_at: rec.created_at,
    activated_at: rec.activated_at,
  };
}

export const SEED_BDS_VI_V1 = "bds-vi-v1";

/** `seed_ruleset("bds-vi-v1")` serialized as `serde_json::to_value` (sorted keys). */
export function seedRuleset(id: string): EngineRulesetBody | null {
  if (id.trim() !== SEED_BDS_VI_V1) return null;
  const body: EngineRulesetBody = {
    dsl: 1,
    prefilter: {
      any: [
        "thue",
        "mua",
        "ban",
        "can ho",
        "chung cu",
        "phong",
        "nha",
        "mat bang",
        "dat",
        "biet thu",
        "so do",
        "chinh chu",
        String.raw`re:\b\d+\s*(?:pn|m2)\b`,
      ],
      none: [
        "tuyen dung nhan vien",
        "tuyen sale bds",
        "tuyen cong tac vien",
        "vay von ngan hang",
        "rut tien the tin dung",
      ],
      min_len: 15,
    },
    classify: [
      {
        id: "reject_broker_inventory",
        when: {
          kw_any: [
            "ben em co quy can",
            "quy can gia tot",
            "nhan ky gui",
            "hoa hong cho moi gioi",
            "ket hop anh em moi gioi",
          ],
        },
        verdict: "no_match",
        confidence: 0.93,
        set: { author_role: "peer" },
      },
      {
        id: "accept_clear_tenant_demand",
        when: {
          all: [
            { kw_any: ["can thue", "tim thue", "muon thue", "can tim phong", "can tim can ho"] },
            {
              kw_none: [
                "cho thue",
                "chinh chu cho thue",
                "ben em co",
                "quy can",
                "hoa hong",
                "ky gui",
                "ib em gui anh",
              ],
            },
            { has_field: "location" },
          ],
        },
        verdict: "match",
        confidence: 0.92,
        set: { intent: "demand", author_role: "end_user" },
      },
    ],
    extract: [
      {
        field: "deal_type",
        extractor: "enum_kw",
        map: {
          rent: ["can thue", "tim thue", "muon thue", "cho thue", "tim phong", "thue"],
          buy: ["can mua", "tim mua", "can ban", "chinh chu ban", "mua", "ban", "sang nhuong"],
        },
        multi: false,
      },
      {
        field: "property_type",
        extractor: "enum_kw",
        map: {
          apartment: ["chung cu mini", "ccmn", "can ho", "chung cu", "studio", "duplex", "penthouse"],
          house: ["nha nguyen can", "nha rieng", "nha mat pho", "nha pho", "biet thu", "lien ke"],
          room: ["phong tro", "phong khep kin", "nha tro"],
          land: ["dat nen", "dat tho cu", "manh dat", "lo dat"],
          commercial: ["mat bang", "van phong", "kho xuong", "cua hang", "shophouse"],
        },
        multi: false,
      },
      { field: "location", extractor: "gazetteer", dict: "vn_admin", scope: null },
      {
        field: "price",
        extractor: "vn_money",
        near: ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach", "tc", "thue", "mua", "ban"],
        window: DEFAULT_MONEY_WINDOW + 10,
      },
      { field: "area", extractor: "vn_area" },
      {
        field: "bedrooms",
        extractor: "regex",
        pattern: String.raw`(\d+)\s*(?:pn|phong ngu|p\.ngu)\b`,
        group: 1,
        cast: "int",
      },
      { field: "phone", extractor: "vn_phone" },
    ],
    thresholds: { accept: 0.9, reject: 0.9 },
  };
  return sortedJson(body);
}
