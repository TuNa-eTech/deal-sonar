// Giải thích vì sao bộ lọc chọn hoặc loại một bài: nhánh đạt, nhánh trượt, trường còn thiếu.

import React from "react";
import { OP_LABELS, missingFieldKeys } from "../../lib/conditionTree";
import type { FieldDef, FilterTrace } from "../../types/ipc";

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) return v.map(show).join(" – ");
  if (typeof v === "boolean") return v ? "Có" : "Không";
  if (typeof v === "number") return v.toLocaleString("vi-VN");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

const GROUP_TITLE: Record<"all" | "any" | "not", (passed: boolean) => string> = {
  all: (p) => (p ? "Thỏa tất cả điều kiện" : "Chưa thỏa tất cả điều kiện"),
  any: (p) => (p ? "Có ít nhất một nhánh đạt" : "Không nhánh nào đạt"),
  not: (p) => (p ? "Không vướng ngoại lệ" : "Bị loại bởi ngoại lệ"),
};

const TraceNode: React.FC<{ node: FilterTrace; labels: Map<string, string> }> = ({ node, labels }) => {
  if (node.kind === "filter") {
    const name = labels.get(node.field ?? "") ?? node.field ?? "";
    const value = show(node.value);
    const text = `${name} ${OP_LABELS[node.op ?? "eq"].toLowerCase()}${value ? ` ${value}` : ""}`;
    const status = node.missing
      ? `thiếu thông tin → ${node.when_missing === "pass" ? "coi là thỏa" : "coi là không thỏa"}`
      : node.passed ? "thỏa" : "không thỏa";
    return <li className={`trace-leaf ${node.passed ? "trace-pass" : "trace-fail"}`} data-testid="trace-leaf">
      <span aria-hidden="true">{node.passed ? "✓" : "✕"}</span> {text}
      {" "}<em>({status})</em>
      {node.missing && <span className="trace-missing"> · thiếu «{name}»</span>}
    </li>;
  }
  return <li className={`trace-group ${node.passed ? "trace-pass" : "trace-fail"}`} data-testid={`trace-${node.kind}`}>
    <span aria-hidden="true">{node.passed ? "✓" : "✕"}</span> <strong>{GROUP_TITLE[node.kind](node.passed)}</strong>
    <ul>{(node.children ?? []).map((c, i) => <TraceNode key={i} node={c} labels={labels} />)}</ul>
  </li>;
};

export const FilterTraceView: React.FC<{ trace: FilterTrace; fields: FieldDef[] }> = ({ trace, fields }) => {
  const labels = new Map(fields.map((f) => [f.key, f.label]));
  const missing = missingFieldKeys(trace).map((k) => labels.get(k) ?? k);
  return <details className="filter-trace" open={!trace.passed}>
    <summary>{trace.passed ? "Điều kiện lọc: đạt" : "Điều kiện lọc: không đạt"}
      {missing.length > 0 && ` · thiếu thông tin: ${missing.join(", ")}`}</summary>
    <ul className="filter-trace-tree"><TraceNode node={trace} labels={labels} /></ul>
  </details>;
};
