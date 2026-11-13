// Dynamic lead field filter matching for `lead_list`.

import type { ExtractedField, Lead, DynamicFieldFilter } from "../../types/ipc";
import { removeVietnameseDiacritics } from "../format";

export function getNumericComparable(extracted: ExtractedField | undefined, mode: "min" | "max" | "scalar"): number | null {
  if (!extracted || extracted.value === null || extracted.value === undefined) return null;
  const v = extracted.value;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (mode === "min" && typeof obj.min === "number") return obj.min;
    if (mode === "max" && typeof obj.max === "number") return obj.max;
    if (typeof obj.max === "number") return obj.max;
    if (typeof obj.min === "number") return obj.min;
  }
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getStringComparableValues(extracted: ExtractedField | undefined): string[] {
  if (!extracted || extracted.value === null || extracted.value === undefined) return [];
  const v = extracted.value;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return [obj.district, obj.province, obj.ward, obj.raw]
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return [String(v)];
}

export function matchesDynamicFilter(lead: Lead, filter: DynamicFieldFilter): boolean {
  const extracted = lead.fields[filter.field];
  const isEmpty = !extracted || extracted.value === null || extracted.value === undefined || extracted.value === "";

  if (filter.op === "is_empty") {
    return filter.value === false ? !isEmpty : isEmpty;
  }
  if (isEmpty) return false;

  const strCandidates = getStringComparableValues(extracted).map((s) =>
    removeVietnameseDiacritics(s).toLowerCase()
  );
  const rawVal = extracted.value;

  switch (filter.op) {
    case "eq": {
      if (typeof rawVal === "boolean") {
        return rawVal === Boolean(filter.value);
      }
      if (typeof filter.value === "number") {
        const n = getNumericComparable(extracted, "scalar");
        return n === filter.value;
      }
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return strCandidates.some((c) => c === target || c.includes(target));
    }
    case "ne": {
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return !strCandidates.some((c) => c === target);
    }
    case "contains": {
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return strCandidates.some((c) => c.includes(target));
    }
    case "in": {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      const normalizedList = list.map((item) =>
        removeVietnameseDiacritics(String(item ?? "")).toLowerCase()
      );
      return strCandidates.some((c) => normalizedList.some((t) => c === t || c.includes(t)));
    }
    case "lte": {
      const limit = Number(filter.value);
      const minNum = getNumericComparable(extracted, "min");
      return minNum !== null && minNum <= limit;
    }
    case "lt": {
      const limit = Number(filter.value);
      const minNum = getNumericComparable(extracted, "min");
      return minNum !== null && minNum < limit;
    }
    case "gte": {
      const limit = Number(filter.value);
      const maxNum = getNumericComparable(extracted, "max");
      return maxNum !== null && maxNum >= limit;
    }
    case "gt": {
      const limit = Number(filter.value);
      const maxNum = getNumericComparable(extracted, "max");
      return maxNum !== null && maxNum > limit;
    }
    case "between": {
      if (!Array.isArray(filter.value) || filter.value.length < 2) return true;
      const low = Number(filter.value[0]);
      const high = Number(filter.value[1]);
      const minNum = getNumericComparable(extracted, "min");
      const maxNum = getNumericComparable(extracted, "max");
      if (minNum === null || maxNum === null) return false;
      return maxNum >= low && minNum <= high;
    }
    default:
      return true;
  }
}
