// Port of crates/store/src/field_values.rs: validate manual corrections at the persistence
// boundary, including IPC callers.

import type { FieldDef } from "./domain";
import { StoreError } from "./errors";
import { isWhitespace } from "./util";

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: Json): v is number => typeof v === "number" && Number.isFinite(v);
/** serde_json `value["k"]`: missing keys and non-objects index to Null. */
const idx = (v: Json, key: string): Json => (isObject(v) && key in v ? v[key] : null);
const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");

export function validateFieldValue(field: FieldDef, value: Json): void {
  if (value === null || value === undefined) return;

  const option = (v: Json): boolean =>
    typeof v === "string" && (field.options == null || field.options.length === 0 || field.options.includes(v));

  let valid: boolean;
  switch (field.type) {
    case "number":
      valid = isFiniteNumber(value);
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "enum":
      valid = option(value);
      break;
    case "multi_enum":
      valid = Array.isArray(value) && value.every(option);
      break;
    case "money":
    case "range": {
      const min = isObject(value) && "min" in value ? value.min : undefined;
      const max = isObject(value) && "max" in value ? value.max : undefined;
      const bounds =
        min !== undefined && max !== undefined && isFiniteNumber(min) && isFiniteNumber(max) && min <= max;
      if (!bounds) {
        valid = false;
      } else if (field.type === "money") {
        const currency = idx(value, "currency");
        const period = idx(value, "period");
        valid =
          (min as number) >= 0 &&
          typeof currency === "string" &&
          utf8Len(currency) === 3 &&
          /^[A-Z]{3}$/.test(currency) &&
          (period === null || period === "month" || period === "year" || period === "day");
      } else {
        valid = typeof idx(value, "unit") === "string";
      }
      break;
    }
    case "location":
      valid =
        typeof idx(value, "raw") === "string" &&
        ["province", "district", "ward"].every((k) => {
          const v = idx(value, k);
          return v === null || typeof v === "string";
        });
      break;
    case "date":
      valid = typeof value === "string" && validDate(value);
      break;
    case "url":
      valid =
        typeof value === "string" &&
        (value.startsWith("https://") || value.startsWith("http://")) &&
        ![...value].some((ch) => isWhitespace(ch.codePointAt(0)!)) &&
        (value.split("://")[1] ?? "") !== "";
      break;
    case "text":
    case "phone":
      valid = typeof value === "string";
      break;
    default:
      valid = false;
  }

  if (!valid) {
    throw StoreError.invalidArgument(
      `Giá trị không đúng kiểu dữ liệu của trường ‘${field.label}’. Thay đổi chưa được lưu.`,
    );
  }
}

/** Rust `str::parse::<u32>`: optional leading `+`, ASCII digits only. */
function parseU32(s: string): number | null {
  if (!/^\+?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return n <= 4_294_967_295 ? n : null;
}

function validDate(s: string): boolean {
  const parts = s.split("-");
  if (parts.length !== 3 || utf8Len(parts[0]) !== 4 || utf8Len(parts[1]) !== 2 || utf8Len(parts[2]) !== 2) {
    return false;
  }
  const y = parseU32(parts[0]);
  const m = parseU32(parts[1]);
  const d = parseU32(parts[2]);
  if (y === null || m === null || d === null) return false;
  let days: number;
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      days = 31;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      days = 30;
      break;
    case 2:
      days = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
      break;
    default:
      days = 0;
  }
  return y > 0 && d > 0 && d <= days;
}
