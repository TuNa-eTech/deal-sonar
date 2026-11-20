// Port of crates/store/src/leads/dynamic_filter.rs: SQL builder for dynamic extracted-field
// filters and sort expressions. The generated SQL and parameter order mirror the Rust builder
// clause for clause; every JSON path and value is bound as a parameter (field keys are
// pre-validated against ^[a-z][a-z0-9_]{0,30}$ and the radar's field whitelist).

import type { FieldDef, FilterOp } from "./domain";
import { StoreError } from "./errors";

export interface LeadFieldFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

/** Positional parameter accumulator; `push` returns the `?N` placeholder. */
export class SqlParams {
  readonly values: Array<string | number | bigint | null> = [];
  push(value: string | number | bigint | null): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/** Rust `{:?}` of `FilterOp`. */
const OP_DEBUG: Record<FilterOp, string> = {
  eq: "Eq",
  ne: "Ne",
  in: "In",
  lt: "Lt",
  lte: "Lte",
  gt: "Gt",
  gte: "Gte",
  between: "Between",
  contains: "Contains",
  is_empty: "IsEmpty",
};

const invalid = (field: string, op: string, message: string): StoreError =>
  StoreError.invalidFilterValue(field, op, message);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Rust `str::parse::<f64>`: no surrounding whitespace, accepts inf/infinity/nan, `5.` and `.5`. */
export function parseRustF64(s: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
  if (m) {
    if (m[2].toLowerCase() === "nan") return Number.NaN;
    return m[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return null;
}

export function extractF64(val: unknown, field: string, op: FilterOp): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const parsed = parseRustF64(val);
    if (parsed !== null) return parsed;
  }
  throw invalid(field, OP_DEBUG[op], "expected numeric value");
}

export function extractStr(val: unknown, field: string, op: FilterOp): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  throw invalid(field, OP_DEBUG[op], "expected string/scalar value");
}

function extractBetween<T>(
  val: unknown,
  field: string,
  pick: (v: unknown, field: string, op: FilterOp) => T,
  message: string,
): [T, T] {
  if (Array.isArray(val) && val.length === 2) {
    return [pick(val[0], field, "between"), pick(val[1], field, "between")];
  }
  if (isObject(val) && "min" in val && "max" in val) {
    return [pick(val.min, field, "between"), pick(val.max, field, "between")];
  }
  throw invalid(field, "Between", message);
}

const extractBetweenF64 = (val: unknown, field: string): [number, number] =>
  extractBetween(val, field, extractF64, "expected [min, max] array or {min, max} object");
const extractBetweenStr = (val: unknown, field: string): [string, string] =>
  extractBetween(val, field, extractStr, "expected [low, high] array or {min, max} object");

/** `Bool(b) => b`, everything else (including Null) => true. */
export function isEmptyExpected(val: unknown): boolean {
  return typeof val === "boolean" ? val : true;
}

function cmpOpSql(op: FilterOp): string {
  switch (op) {
    case "eq":
      return "=";
    case "ne":
      return "!=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    default:
      return "=";
  }
}

function parseBoolFilter(val: unknown, field: string, op: FilterOp): boolean {
  const fail = (): never => {
    throw invalid(field, OP_DEBUG[op], "expected boolean");
  };
  if (typeof val === "boolean") return val;
  if (typeof val === "number") {
    if (val === 0) return false;
    if (val === 1) return true;
    return fail();
  }
  if (typeof val === "string") {
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
    return fail();
  }
  return fail();
}

export function buildDynamicSortExpr(fdef: FieldDef, params: SqlParams): string {
  const key = fdef.key;
  switch (fdef.type) {
    case "money":
    case "range": {
      const pMin = params.push(`$.${key}.value.min`);
      const pAmt = params.push(`$.${key}.value.amount`);
      const pVal = params.push(`$.${key}.value`);
      return (
        `CAST(COALESCE(json_extract(l.fields, ${pMin}), json_extract(l.fields, ${pAmt}), ` +
        `CASE WHEN json_type(l.fields, ${pVal}) IN ('integer', 'real') THEN json_extract(l.fields, ${pVal}) END) AS REAL)`
      );
    }
    case "number": {
      const pVal = params.push(`$.${key}.value`);
      return `CAST(json_extract(l.fields, ${pVal}) AS REAL)`;
    }
    case "location": {
      const pDist = params.push(`$.${key}.value.district`);
      const pProv = params.push(`$.${key}.value.province`);
      const pRaw = params.push(`$.${key}.value.raw`);
      return `COALESCE(json_extract(l.fields, ${pDist}), json_extract(l.fields, ${pProv}), json_extract(l.fields, ${pRaw}))`;
    }
    default: {
      const pVal = params.push(`$.${key}.value`);
      return `json_extract(l.fields, ${pVal})`;
    }
  }
}

function requireArray(filter: LeadFieldFilter, key: string, message: string): unknown[] {
  if (!Array.isArray(filter.value)) throw invalid(key, "In", message);
  return filter.value;
}

export function buildDynamicFilterClause(fdef: FieldDef, filter: LeadFieldFilter, params: SqlParams): string {
  const key = fdef.key;
  const op = filter.op;
  const value = filter.value === undefined ? null : filter.value;

  switch (fdef.type) {
    case "money":
    case "range": {
      const pMin = params.push(`$.${key}.value.min`);
      const pMax = params.push(`$.${key}.value.max`);
      const pAmt = params.push(`$.${key}.value.amount`);
      const pVal = params.push(`$.${key}.value`);
      const minExpr =
        `COALESCE(json_extract(l.fields, ${pMin}), json_extract(l.fields, ${pAmt}), ` +
        `CASE WHEN json_type(l.fields, ${pVal}) IN ('integer', 'real') THEN json_extract(l.fields, ${pVal}) END)`;
      const maxExpr =
        `COALESCE(json_extract(l.fields, ${pMax}), json_extract(l.fields, ${pAmt}), ` +
        `CASE WHEN json_type(l.fields, ${pVal}) IN ('integer', 'real') THEN json_extract(l.fields, ${pVal}) END)`;

      switch (op) {
        case "lte": {
          const px = params.push(extractF64(value, key, op));
          return `CAST(${maxExpr} AS REAL) <= ${px}`;
        }
        case "lt": {
          const px = params.push(extractF64(value, key, op));
          return `CAST(${maxExpr} AS REAL) < ${px}`;
        }
        case "gte": {
          const px = params.push(extractF64(value, key, op));
          return `CAST(${minExpr} AS REAL) >= ${px}`;
        }
        case "gt": {
          const px = params.push(extractF64(value, key, op));
          return `CAST(${minExpr} AS REAL) > ${px}`;
        }
        case "eq": {
          const x = extractF64(value, key, op);
          const px1 = params.push(x);
          const px2 = params.push(x);
          return `(CAST(${minExpr} AS REAL) <= ${px1} AND CAST(${maxExpr} AS REAL) >= ${px2})`;
        }
        case "ne": {
          const x = extractF64(value, key, op);
          const px1 = params.push(x);
          const px2 = params.push(x);
          return `(${minExpr} IS NOT NULL AND NOT (CAST(${minExpr} AS REAL) <= ${px1} AND CAST(${maxExpr} AS REAL) >= ${px2}))`;
        }
        case "between": {
          const [lo, hi] = extractBetweenF64(value, key);
          const plo = params.push(lo);
          const phi = params.push(hi);
          return `(CAST(${minExpr} AS REAL) >= ${plo} AND CAST(${maxExpr} AS REAL) <= ${phi})`;
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of numbers");
          if (arr.length === 0) return "0 = 1";
          const disj = arr.map((item) => {
            const x = extractF64(item, key, op);
            const px1 = params.push(x);
            const px2 = params.push(x);
            return `(CAST(${minExpr} AS REAL) <= ${px1} AND CAST(${maxExpr} AS REAL) >= ${px2})`;
          });
          return `(${disj.join(" OR ")})`;
        }
        case "contains": {
          const needle = extractStr(value, key, op);
          const pRaw = params.push(`$.${key}.raw`);
          const pn = params.push(needle);
          return `dealsonar_fold_contains(COALESCE(json_extract(l.fields, ${pRaw}), CAST(json_extract(l.fields, ${pVal}) AS TEXT)), ${pn}) = 1`;
        }
        case "is_empty":
          return isEmptyExpected(value)
            ? `(${minExpr} IS NULL AND ${maxExpr} IS NULL)`
            : `(${minExpr} IS NOT NULL OR ${maxExpr} IS NOT NULL)`;
      }
      break;
    }

    case "location": {
      const pProv = params.push(`$.${key}.value.province`);
      const pDist = params.push(`$.${key}.value.district`);
      const pWard = params.push(`$.${key}.value.ward`);
      const pRaw = params.push(`$.${key}.value.raw`);
      const pVal = params.push(`$.${key}.value`);
      const prov = `json_extract(l.fields, ${pProv})`;
      const dist = `json_extract(l.fields, ${pDist})`;
      const ward = `json_extract(l.fields, ${pWard})`;
      const raw = `json_extract(l.fields, ${pRaw})`;
      const scalar = `(CASE WHEN json_type(l.fields, ${pVal}) = 'text' THEN json_extract(l.fields, ${pVal}) END)`;

      switch (op) {
        case "eq": {
          const ps = params.push(extractStr(value, key, op));
          return `(${prov} = ${ps} OR ${dist} = ${ps} OR ${ward} = ${ps} OR ${raw} = ${ps} OR ${scalar} = ${ps})`;
        }
        case "ne": {
          const ps = params.push(extractStr(value, key, op));
          return (
            `(json_extract(l.fields, ${pVal}) IS NOT NULL ` +
            `AND COALESCE(${prov}, '') != ${ps} ` +
            `AND COALESCE(${dist}, '') != ${ps} ` +
            `AND COALESCE(${ward}, '') != ${ps} ` +
            `AND COALESCE(${raw}, '') != ${ps} ` +
            `AND COALESCE(${scalar}, '') != ${ps})`
          );
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of location strings");
          if (arr.length === 0) return "0 = 1";
          const list = arr.map((item) => params.push(extractStr(item, key, op))).join(", ");
          return `(${prov} IN (${list}) OR ${dist} IN (${list}) OR ${ward} IN (${list}) OR ${raw} IN (${list}) OR ${scalar} IN (${list}))`;
        }
        case "contains": {
          const ps = params.push(extractStr(value, key, op));
          return (
            `dealsonar_fold_contains(` +
            `COALESCE(${prov}, '') || ' ' || COALESCE(${dist}, '') || ' ' || ` +
            `COALESCE(${ward}, '') || ' ' || COALESCE(${raw}, '') || ' ' || COALESCE(${scalar}, ''), ` +
            `${ps}) = 1`
          );
        }
        case "is_empty":
          return isEmptyExpected(value)
            ? `(json_extract(l.fields, ${pVal}) IS NULL ` +
                `OR (${prov} IS NULL AND ${dist} IS NULL AND ${ward} IS NULL AND ${raw} IS NULL AND ${scalar} IS NULL))`
            : `(json_extract(l.fields, ${pVal}) IS NOT NULL ` +
                `AND (${prov} IS NOT NULL OR ${dist} IS NOT NULL OR ${ward} IS NOT NULL OR ${raw} IS NOT NULL OR ${scalar} IS NOT NULL))`;
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          const ps = params.push(extractStr(value, key, op));
          return `COALESCE(${dist}, ${prov}, ${raw}, ${scalar}) ${cmpOpSql(op)} ${ps}`;
        }
        case "between": {
          const [lo, hi] = extractBetweenStr(value, key);
          const plo = params.push(lo);
          const phi = params.push(hi);
          return `COALESCE(${dist}, ${prov}, ${raw}, ${scalar}) BETWEEN ${plo} AND ${phi}`;
        }
      }
      break;
    }

    case "multi_enum": {
      const pVal = params.push(`$.${key}.value`);
      switch (op) {
        case "eq": {
          const ps = params.push(extractStr(value, key, op));
          return (
            `(json_type(l.fields, ${pVal}) = 'array' AND EXISTS (` +
            `SELECT 1 FROM json_each(json_extract(l.fields, ${pVal})) je WHERE je.value = ${ps}))`
          );
        }
        case "ne": {
          const ps = params.push(extractStr(value, key, op));
          return (
            `(json_type(l.fields, ${pVal}) = 'array' AND NOT EXISTS (` +
            `SELECT 1 FROM json_each(json_extract(l.fields, ${pVal})) je WHERE je.value = ${ps}))`
          );
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of strings");
          if (arr.length === 0) return "0 = 1";
          const ph = arr.map((item) => params.push(extractStr(item, key, op)));
          return (
            `(json_type(l.fields, ${pVal}) = 'array' AND EXISTS (` +
            `SELECT 1 FROM json_each(json_extract(l.fields, ${pVal})) je WHERE je.value IN (${ph.join(", ")})))`
          );
        }
        case "contains": {
          const ps = params.push(extractStr(value, key, op));
          return (
            `(json_type(l.fields, ${pVal}) = 'array' AND EXISTS (` +
            `SELECT 1 FROM json_each(json_extract(l.fields, ${pVal})) je ` +
            `WHERE dealsonar_fold_contains(CAST(je.value AS TEXT), ${ps}) = 1))`
          );
        }
        case "is_empty":
          return isEmptyExpected(value)
            ? `(json_extract(l.fields, ${pVal}) IS NULL ` +
                `OR (json_type(l.fields, ${pVal}) = 'array' AND json_array_length(json_extract(l.fields, ${pVal})) = 0))`
            : `(json_type(l.fields, ${pVal}) = 'array' AND json_array_length(json_extract(l.fields, ${pVal})) > 0)`;
        default:
          throw invalid(key, OP_DEBUG[op], "unsupported operator for multi_enum field");
      }
    }

    case "number": {
      const pVal = params.push(`$.${key}.value`);
      const valExpr = `json_extract(l.fields, ${pVal})`;
      const numExpr = `CAST(${valExpr} AS REAL)`;
      switch (op) {
        case "eq":
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          const px = params.push(extractF64(value, key, op));
          return `(${valExpr} IS NOT NULL AND ${numExpr} ${cmpOpSql(op)} ${px})`;
        }
        case "ne": {
          const px = params.push(extractF64(value, key, op));
          return `(${valExpr} IS NOT NULL AND ${numExpr} != ${px})`;
        }
        case "between": {
          const [lo, hi] = extractBetweenF64(value, key);
          const plo = params.push(lo);
          const phi = params.push(hi);
          return `(${valExpr} IS NOT NULL AND ${numExpr} BETWEEN ${plo} AND ${phi})`;
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of numbers");
          if (arr.length === 0) return "0 = 1";
          const ph = arr.map((item) => params.push(extractF64(item, key, op)));
          return `(${valExpr} IS NOT NULL AND ${numExpr} IN (${ph.join(", ")}))`;
        }
        case "contains": {
          const ps = params.push(extractStr(value, key, op));
          return `dealsonar_fold_contains(CAST(${valExpr} AS TEXT), ${ps}) = 1`;
        }
        case "is_empty":
          return isEmptyExpected(value) ? `${valExpr} IS NULL` : `${valExpr} IS NOT NULL`;
      }
      break;
    }

    case "boolean": {
      const pVal = params.push(`$.${key}.value`);
      const valExpr = `json_extract(l.fields, ${pVal})`;
      switch (op) {
        case "is_empty":
          return isEmptyExpected(value) ? `${valExpr} IS NULL` : `${valExpr} IS NOT NULL`;
        case "eq":
        case "ne": {
          const b = parseBoolFilter(value, key, op);
          const pb = params.push(b ? 1 : 0);
          return op === "eq" ? `${valExpr} = ${pb}` : `(${valExpr} IS NOT NULL AND ${valExpr} != ${pb})`;
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of booleans");
          if (arr.length === 0) return "0 = 1";
          const ph = arr.map((item) => params.push(parseBoolFilter(item, key, op) ? 1 : 0));
          return `${valExpr} IN (${ph.join(", ")})`;
        }
        default:
          throw invalid(key, OP_DEBUG[op], "unsupported operator for boolean field");
      }
    }

    case "text":
    case "phone":
    case "enum":
    case "date":
    case "url": {
      const pVal = params.push(`$.${key}.value`);
      const valExpr = `json_extract(l.fields, ${pVal})`;
      switch (op) {
        case "eq":
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          const ps = params.push(extractStr(value, key, op));
          return `${valExpr} ${cmpOpSql(op)} ${ps}`;
        }
        case "ne": {
          const ps = params.push(extractStr(value, key, op));
          return `(${valExpr} IS NOT NULL AND ${valExpr} != ${ps})`;
        }
        case "between": {
          const [lo, hi] = extractBetweenStr(value, key);
          const plo = params.push(lo);
          const phi = params.push(hi);
          return `${valExpr} BETWEEN ${plo} AND ${phi}`;
        }
        case "in": {
          const arr = requireArray({ ...filter, value }, key, "expected array of scalar values");
          if (arr.length === 0) return "0 = 1";
          const ph = arr.map((item) => params.push(extractStr(item, key, op)));
          return `${valExpr} IN (${ph.join(", ")})`;
        }
        case "contains": {
          const ps = params.push(extractStr(value, key, op));
          return `dealsonar_fold_contains(CAST(${valExpr} AS TEXT), ${ps}) = 1`;
        }
        case "is_empty":
          return isEmptyExpected(value)
            ? `(${valExpr} IS NULL OR ${valExpr} = '')`
            : `(${valExpr} IS NOT NULL AND ${valExpr} != '')`;
      }
      break;
    }
  }
  throw invalid(key, OP_DEBUG[op], "unsupported field type");
}
