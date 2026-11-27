// Pure helpers for editing and explaining `match_policy.condition` (all / any / not groups).

import type { FieldDef, FieldType, FilterExpr, FilterOperator, FilterTrace, HardFilter } from "../types/ipc";

export type GroupKind = "all" | "any";
export type ExprKind = GroupKind | "not" | "filter";

export const exprKind = (e: FilterExpr): ExprKind =>
  "all" in e ? "all" : "any" in e ? "any" : "not" in e ? "not" : "filter";

export const OP_LABELS: Record<FilterOperator, string> = {
  eq: "Bằng", ne: "Khác", lt: "Dưới", lte: "Không quá", gt: "Trên", gte: "Ít nhất",
  between: "Trong khoảng", in: "Thuộc danh sách", contains: "Chứa", is_empty: "Để trống",
};

const NUMERIC_OPS: FilterOperator[] = ["eq", "lt", "lte", "gt", "gte", "between", "is_empty"];
const TEXT_OPS: FilterOperator[] = ["eq", "ne", "contains", "in", "is_empty"];

/** Phép so sánh hợp lý theo kiểu trường; luôn giữ phép đang lưu để mở lại không bị đổi. */
export function opsForField(type: FieldType | undefined, current?: FilterOperator): FilterOperator[] {
  let ops: FilterOperator[];
  switch (type) {
    case "boolean": ops = ["eq", "ne", "is_empty"]; break;
    case "enum": ops = ["eq", "ne", "in", "is_empty"]; break;
    case "multi_enum": ops = ["contains", "in", "is_empty"]; break;
    case "money": case "number": case "range": case "date": ops = NUMERIC_OPS; break;
    default: ops = TEXT_OPS;
  }
  return current && !ops.includes(current) ? [...ops, current] : ops;
}

export function newLeaf(fields: FieldDef[]): HardFilter {
  return { field: fields[0]?.key ?? "", op: opsForField(fields[0]?.type)[0]!, value: null, when_missing: "fail" };
}
export const newGroup = (kind: GroupKind, fields: FieldDef[]): FilterExpr =>
  kind === "all" ? { all: [newLeaf(fields)] } : { any: [newLeaf(fields)] };
/** Ngoại lệ là nhóm "tất cả" nên người dùng có thể thêm nhiều điều kiện vào cùng ngoại lệ. */
export const newException = (fields: FieldDef[]): FilterExpr => ({ not: { all: [newLeaf(fields)] } });

export function children(e: FilterExpr): FilterExpr[] {
  return "all" in e ? e.all : "any" in e ? e.any : "not" in e ? [e.not] : [];
}

export function setGroupKind(e: FilterExpr, kind: GroupKind): FilterExpr {
  if (!("all" in e) && !("any" in e)) return e;
  const items = "all" in e ? e.all : e.any;
  return kind === "all" ? { all: items } : { any: items };
}

/** Bỏ nhóm rỗng và ngoại lệ rỗng (backend từ chối chúng). `null` nghĩa là không còn gì. */
export function prune(e: FilterExpr | null | undefined): FilterExpr | null {
  if (!e) return null;
  if ("all" in e || "any" in e) {
    const items = ("all" in e ? e.all : e.any).map(prune).filter((x): x is FilterExpr => x !== null);
    if (!items.length) return null;
    return "all" in e ? { all: items } : { any: items };
  }
  if ("not" in e) {
    const inner = prune(e.not);
    return inner ? { not: inner } : null;
  }
  return e;
}

/** Điều kiện đơn chưa đủ giá trị để lưu (backend sẽ từ chối). */
export function leafIncomplete(f: HardFilter): boolean {
  const v = f.value;
  switch (f.op) {
    case "is_empty": return false;
    case "in": return !Array.isArray(v) || v.length === 0;
    case "between": return !Array.isArray(v) || v.length !== 2 || v.some(x => x === null || x === "");
    case "contains": return typeof v !== "string" || !v.trim();
    default: return v === null || v === undefined || v === "";
  }
}

export function countIncomplete(e: FilterExpr | null | undefined): number {
  if (!e) return 0;
  if ("all" in e || "any" in e || "not" in e) return children(e).reduce((n, c) => n + countIncomplete(c), 0);
  return leafIncomplete(e) ? 1 : 0;
}

/** Khóa trường đang được điều kiện tham chiếu nhưng không còn trong danh sách trường. */
export function unknownFieldKeys(e: FilterExpr | null | undefined, fields: FieldDef[]): string[] {
  const known = new Set(fields.map(f => f.key));
  const out = new Set<string>();
  const walk = (x: FilterExpr) => {
    if ("all" in x || "any" in x || "not" in x) children(x).forEach(walk);
    else if (!known.has(x.field)) out.add(x.field);
  };
  if (e) walk(e);
  return [...out];
}

/** Trường bài còn thiếu, theo từng điều kiện đơn bị `missing` trong giải thích. */
export function missingFieldKeys(t: FilterTrace | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (x: FilterTrace) => {
    if (x.kind === "filter") { if (x.missing && x.field) out.add(x.field); }
    else (x.children ?? []).forEach(walk);
  };
  if (t) walk(t);
  return [...out];
}
