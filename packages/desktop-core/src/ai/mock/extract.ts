// Heuristic per-field extraction for the mock `judge_extract` engine (port of
// crates/ai-bridge/src/adapters/mock/{extract,judge}.rs). Money, phone, area and location reuse the
// production rules extractors; enum/boolean/number/date/url follow the Rust mock heuristics.
// Every returned `raw` is a verbatim substring of the post text (evidence contract).

import { extractGazetteer } from "../../rules/extractors/gazetteer";
import { extractVnArea } from "../../rules/extractors/area";
import { extractVnMoney } from "../../rules/extractors/money";
import { extractVnPhone } from "../../rules/extractors/phone";
import { normalizeNfcClean } from "../../rules/normalize";
import type { ExtractionMatch, LocationValue } from "../../rules/types";
import { FoldIndex, type JsonObject, foldVi, isJsonObject, verbatimSpan } from "./text";

export interface FieldExtraction {
  raw: string | null;
  value: unknown;
  confidence: number;
}

const NONE: FieldExtraction = { raw: null, value: null, confidence: 0 };
const none = (): FieldExtraction => ({ ...NONE });

const URL_RE = /https?:\/\/[^\s)\]>]+/;
const ISO_DATE_RE = /(?<![\p{L}\p{N}_])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}_])/u;
const BEDROOM_RE = /(?<![\p{L}\p{N}_])(\d+)\s*(?:pn|phòng ngủ|phong ngu|ngủ|ngu)(?![\p{L}\p{N}_])/iu;
const GENERIC_NUMBER_RE = /(?<![\p{L}\p{N}_])\d+(?:\.\d+)?(?![\p{L}\p{N}_])/u;

/** Enum synonyms of the Rust mock for the standard template enums. */
const ENUM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  rent: ["can thue", "cho thue", "thue"],
  buy: ["can mua", "mua"],
  apartment: ["can ho", "chung cu"],
  house: ["nha nguyen can", "nha rieng"],
};

/** A post prepared once for every field extraction. */
export class PostText {
  readonly norm: string;
  private foldIndex: FoldIndex | null = null;

  constructor(readonly text: string) {
    this.norm = normalizeNfcClean(text);
  }

  /** First whole-word, diacritic-insensitive occurrence of `needleFolded` in the original text. */
  find(needleFolded: string): string | null {
    this.foldIndex ??= new FoldIndex(this.text);
    return this.foldIndex.find(needleFolded);
  }

  /** Verbatim slice of the post equivalent to a `text_norm` extractor span. */
  verbatim(raw: string): string | null {
    return verbatimSpan(this.text, raw);
  }
}

function firstMatch(post: PostText, matches: readonly ExtractionMatch[]): { raw: string; match: ExtractionMatch } | null {
  for (const match of matches) {
    const raw = post.verbatim(match.raw);
    if (raw !== null) return { raw, match };
  }
  return null;
}

export function extractMoneyField(post: PostText): FieldExtraction {
  const hit = firstMatch(post, extractVnMoney(post.norm));
  return hit ? { raw: hit.raw, value: hit.match.value, confidence: 0.93 } : none();
}

/** Location of `text` (district-bearing matches win over province-only ones, like the Rust table order). */
export function detectLocation(post: PostText): { raw: string; value: LocationValue } | null {
  const matches = extractGazetteer(post.norm);
  const withDistrict = matches.filter((m) => (m.value as LocationValue).district !== null);
  for (const match of [...withDistrict, ...matches]) {
    const raw = post.verbatim(match.raw);
    if (raw === null) continue;
    const loc = match.value as LocationValue;
    return { raw, value: { raw, province: loc.province, district: loc.district, ward: loc.ward } };
  }
  return null;
}

function extractAreaField(post: PostText): FieldExtraction {
  const hit = firstMatch(post, extractVnArea(post.norm));
  return hit ? { raw: hit.raw, value: hit.match.value, confidence: 0.9 } : none();
}

function extractPhoneField(post: PostText): FieldExtraction {
  const hit = firstMatch(post, extractVnPhone(post.norm));
  return hit ? { raw: hit.raw, value: hit.match.value, confidence: 0.96 } : none();
}

function matchEnumOption(options: readonly unknown[], post: PostText): { raw: string; chosen: string } | null {
  for (const opt of options) {
    if (typeof opt !== "string") continue;
    const direct = post.find(foldVi(opt));
    if (direct !== null) return { raw: direct, chosen: opt };
    for (const syn of ENUM_SYNONYMS[opt] ?? []) {
      const raw = post.find(syn);
      if (raw !== null) return { raw, chosen: opt };
    }
  }
  return null;
}

function extractNumberField(fieldKey: string, post: PostText): FieldExtraction {
  const key = fieldKey.toLowerCase();
  if (key.includes("bed") || key.includes("phong_ngu") || key.includes("pn")) {
    const m = BEDROOM_RE.exec(post.text);
    if (m) return { raw: m[0], value: Number(m[1]), confidence: 0.92 };
  }
  const m = GENERIC_NUMBER_RE.exec(post.text);
  return m ? { raw: m[0], value: Number(m[0]), confidence: 0.92 } : none();
}

/** Enum / multi-enum value schemas arrive as `anyOf` branches (or directly on the value schema). */
function extractEnumField(valueSchema: JsonObject, post: PostText): FieldExtraction | null {
  const branches: unknown[] = Array.isArray(valueSchema.anyOf) ? valueSchema.anyOf : [valueSchema];
  for (const branch of branches) {
    if (!isJsonObject(branch)) continue;
    if (Array.isArray(branch.enum)) {
      const hit = matchEnumOption(branch.enum, post);
      return hit ? { raw: hit.raw, value: hit.chosen, confidence: 0.88 } : none();
    }
    if (branch.type === "array") {
      const items = isJsonObject(branch.items) ? branch.items : null;
      if (items && Array.isArray(items.enum)) {
        const values: string[] = [];
        let firstRaw: string | null = null;
        for (const opt of items.enum) {
          if (typeof opt !== "string") continue;
          const raw = post.find(foldVi(opt));
          if (raw === null) continue;
          firstRaw ??= raw;
          values.push(opt);
        }
        if (firstRaw !== null) return { raw: firstRaw, value: values, confidence: 0.86 };
      }
      return none();
    }
  }
  return null;
}

/**
 * Port of `extract_field_for_schema`: pick an extractor from the shape of the field's `value` schema
 * (money / location / range / enum / boolean / number / date) and then from the field key.
 */
export function extractFieldForSchema(fieldKey: string, valueSchema: unknown, post: PostText): FieldExtraction {
  const schemaStr = valueSchema === undefined ? "" : (JSON.stringify(valueSchema) ?? "");

  if (schemaStr.includes('"currency"')) return extractMoneyField(post);

  if (schemaStr.includes('"province"')) {
    const loc = detectLocation(post);
    return loc ? { raw: loc.raw, value: loc.value, confidence: 0.91 } : none();
  }

  if (schemaStr.includes('"unit"')) return extractAreaField(post);

  if (isJsonObject(valueSchema)) {
    const found = extractEnumField(valueSchema, post);
    if (found !== null) return found;
  }

  if (schemaStr.includes('"boolean"')) {
    const key = fieldKey.toLowerCase();
    const keywords = key.includes("owner") || key.includes("chinh_chu") ? ["chinh chu"] : ["can gap", "gap"];
    for (const kw of keywords) {
      const raw = post.find(kw);
      if (raw !== null) return { raw, value: true, confidence: 0.9 };
    }
    return none();
  }

  if (schemaStr.includes('"number"')) return extractNumberField(fieldKey, post);

  if (schemaStr.includes("d{4}-")) {
    const m = ISO_DATE_RE.exec(post.text);
    return m ? { raw: m[0], value: m[0], confidence: 0.95 } : none();
  }

  const key = fieldKey.toLowerCase();
  if (key.includes("phone") || key.includes("sdt") || key.includes("tel")) return extractPhoneField(post);

  if (key.includes("url") || key.includes("link")) {
    const m = URL_RE.exec(post.text);
    return m ? { raw: m[0], value: m[0], confidence: 0.95 } : none();
  }

  return none();
}
