// Port of crates/rules/src/types.rs. Field contracts are shared with the store (`store/domain`).

import type { ExtractedField, FieldDef, FieldSource, FieldType, FilterOp, HardFilter } from "../store/domain";

export type { ExtractedField, FieldDef, FieldSource, FieldType, FilterOp, HardFilter };

/** Deterministic key -> field map. Rust uses `BTreeMap`; iterate with `sortedEntries`. */
export type ExtractedFields = Record<string, ExtractedField>;

export function sortedEntries<T>(map: Record<string, T>): Array<[string, T]> {
  return Object.keys(map)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, map[k]]);
}

/** Single extractor match. `start`/`end` are offsets into `text_norm` (UTF-16 code units). */
export interface ExtractionMatch {
  value: unknown;
  raw: string;
  start: number;
  end: number;
  confidence: number;
}

export function intoExtractedField(m: ExtractionMatch, source: FieldSource): ExtractedField {
  return { value: m.value, raw: m.raw, confidence: m.confidence, source };
}

export type MoneyPeriod = "day" | "month" | "year";
export interface MoneyValue {
  min: number;
  max: number;
  currency: string;
  period: MoneyPeriod | null;
}
export interface LocationValue {
  raw: string;
  province: string | null;
  district: string | null;
  ward: string | null;
}
export interface RangeValue {
  min: number;
  max: number;
  unit: string;
}

export type WhenMissing = "pass" | "fail";
export type Intent = "demand" | "supply" | "other";
export type AuthorRole = "end_user" | "peer" | "unknown";
export type RulesetState = "candidate" | "shadow" | "active" | "retired";
export type RulesetOrigin = "seed" | "compiled" | "user";

/** `"+84912345678"` -> `"0912 345 678"` (07-notifications-export.md §2.2). */
export function formatDomesticPhone(phone: string): string {
  const trimmed = phone.trim();
  const onlyDigits = (s: string): string => s.replace(/[^0-9]/g, "");
  let digits: string;
  if (trimmed.startsWith("+84")) {
    digits = `0${onlyDigits(trimmed.slice(3))}`;
  } else if (trimmed.startsWith("84")) {
    const rest = onlyDigits(trimmed.slice(2));
    digits = rest.length === 9 || (rest.startsWith("2") && rest.length === 10) ? `0${rest}` : onlyDigits(trimmed);
  } else {
    digits = onlyDigits(trimmed);
  }
  if (!digits.startsWith("0")) return trimmed;
  const landline = digits.startsWith("024") || digits.startsWith("028");
  if (digits.length === 10) {
    return landline
      ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`
      : `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 10)}`;
  }
  if (digits.length === 11) {
    if (landline) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7, 11)}`;
    if (digits.startsWith("02")) return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  }
  return trimmed;
}
