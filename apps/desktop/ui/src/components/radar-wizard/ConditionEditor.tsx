// Editor for `match_policy.condition`: nhóm "tất cả" / "ít nhất một" và ngoại lệ, chọn theo tên trường.

import React from "react";
import {
  OP_LABELS, children, countIncomplete, exprKind, leafIncomplete, newException, newGroup, newLeaf,
  opsForField, prune, setGroupKind, unknownFieldKeys,
  type GroupKind,
} from "../../lib/conditionTree";
import { parseVietnameseNumber } from "../../lib/fieldValues";
import { describeCondition } from "../../lib/versionDiff";
import type { FieldDef, FilterExpr, FilterOperator, HardFilter } from "../../types/ipc";
import { Button, Input, Select } from "../ui";

interface Props {
  condition: FilterExpr | null;
  fields: FieldDef[];
  onChange: (next: FilterExpr | null) => void;
  onError: (message: string) => void;
}

const isNumericType = (f?: FieldDef) => f?.type === "money" || f?.type === "number" || f?.type === "range";

function parseScalar(field: FieldDef | undefined, raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  return isNumericType(field) ? parseVietnameseNumber(text) : text;
}

function showScalar(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Ô nhập giá trị, theo kiểu trường và phép so sánh. Không cần viết JSON. */
const ValueInput: React.FC<{
  label: string; filter: HardFilter; field?: FieldDef;
  onValue: (value: unknown) => void; onError: (m: string) => void;
}> = ({ label, filter, field, onValue, onError }) => {
  const { op, value } = filter;
  const guard = (fn: () => unknown) => {
    try { onValue(fn()); } catch (e) { onValue(null); onError(e instanceof Error ? e.message : String(e)); }
  };
  if (op === "is_empty") {
    return <Select aria-label={`${label}: trạng thái`} value={value === false ? "no" : "yes"}
      onChange={e => onValue(e.target.value === "yes")}>
      <option value="yes">Chưa có thông tin</option>
      <option value="no">Đã có thông tin</option>
    </Select>;
  }
  if (field?.type === "boolean" && (op === "eq" || op === "ne")) {
    return <Select aria-label={`${label}: giá trị`} value={value === true ? "yes" : value === false ? "no" : ""}
      onChange={e => onValue(e.target.value === "" ? null : e.target.value === "yes")}>
      <option value="">Chọn…</option>
      <option value="yes">Có</option>
      <option value="no">Không</option>
    </Select>;
  }
  const options = field?.options ?? [];
  if (options.length && (op === "eq" || op === "ne")) {
    return <Select aria-label={`${label}: giá trị`} value={typeof value === "string" ? value : ""}
      onChange={e => onValue(e.target.value || null)}>
      <option value="">Chọn…</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </Select>;
  }
  if (options.length && op === "in") {
    const picked = Array.isArray(value) ? value.map(String) : [];
    return <fieldset className="condition-options" aria-label={`${label}: các giá trị`}>
      {options.map(o => <label key={o}>
        <input type="checkbox" checked={picked.includes(o)} onChange={e =>
          onValue(options.filter(x => (x === o ? e.target.checked : picked.includes(x))))} />
        {o}
      </label>)}
    </fieldset>;
  }
  if (op === "between") {
    const [lo, hi] = Array.isArray(value) ? value : [null, null];
    const commit = (i: 0 | 1) => (e: React.FocusEvent<HTMLInputElement>) => guard(() => {
      const next = [lo ?? null, hi ?? null];
      next[i] = parseScalar(field, e.target.value);
      return next[0] === null && next[1] === null ? null : next;
    });
    return <span className="condition-between">
      <Input aria-label={`${label}: từ`} placeholder="Từ" key={`lo-${showScalar(lo)}`}
        defaultValue={showScalar(lo)} onBlur={commit(0)} />
      <Input aria-label={`${label}: đến`} placeholder="Đến" key={`hi-${showScalar(hi)}`}
        defaultValue={showScalar(hi)} onBlur={commit(1)} />
    </span>;
  }
  if (op === "in") {
    const text = Array.isArray(value) ? value.join(", ") : "";
    return <Input aria-label={`${label}: các giá trị`} placeholder="giá trị 1, giá trị 2" key={text}
      defaultValue={text} onBlur={e => guard(() => {
        const items = e.target.value.split(",").map(s => parseScalar(field, s)).filter(v => v !== null);
        return items.length ? items : null;
      })} />;
  }
  const text = showScalar(value);
  return <Input aria-label={`${label}: giá trị`} key={text} defaultValue={text}
    placeholder={field?.type === "date" ? "YYYY-MM-DD" : undefined}
    onBlur={e => guard(() => (op === "contains" ? e.target.value.trim() || null : parseScalar(field, e.target.value)))} />;
};

const LeafRow: React.FC<{
  filter: HardFilter; fields: FieldDef[]; label: string;
  onChange: (f: HardFilter) => void; onRemove: () => void; onError: (m: string) => void;
}> = ({ filter, fields, label, onChange, onRemove, onError }) => {
  const field = fields.find(f => f.key === filter.field);
  const ops = opsForField(field?.type, filter.op);
  const setOp = (op: FilterOperator) => onChange({ ...filter, op, value: op === "is_empty" ? true : null });
  return <div className="condition-leaf" data-testid="condition-leaf">
    <Select aria-label={`${label}: trường`} value={filter.field}
      onChange={e => {
        const next = fields.find(f => f.key === e.target.value);
        const nextOps = opsForField(next?.type);
        onChange({ ...filter, field: e.target.value, op: nextOps.includes(filter.op) ? filter.op : nextOps[0]!, value: null });
      }}>
      {!field && <option value={filter.field}>{`(trường đã xóa: ${filter.field})`}</option>}
      {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
    </Select>
    <Select aria-label={`${label}: so sánh`} value={filter.op} onChange={e => setOp(e.target.value as FilterOperator)}>
      {ops.map(op => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
    </Select>
    <ValueInput label={label} filter={filter} field={field} onError={onError}
      onValue={value => onChange({ ...filter, value })} />
    <Select aria-label={`${label}: khi thiếu thông tin`} value={filter.when_missing}
      onChange={e => onChange({ ...filter, when_missing: e.target.value as HardFilter["when_missing"] })}>
      <option value="fail">Thiếu thông tin: không thỏa</option>
      <option value="pass">Thiếu thông tin: coi là thỏa</option>
    </Select>
    <Button size="sm" aria-label={`Bỏ ${label}`} onClick={onRemove}>Bỏ</Button>
    {leafIncomplete(filter) && <span className="field-hint condition-warn" role="status">Chưa nhập giá trị.</span>}
  </div>;
};

interface NodeProps {
  expr: FilterExpr; fields: FieldDef[]; label: string; depth: number;
  /** `null` nghĩa là bỏ nút này. */
  onChange: (next: FilterExpr | null) => void; onError: (m: string) => void;
}

const Node: React.FC<NodeProps> = ({ expr, fields, label, depth, onChange, onError }) => {
  const kind = exprKind(expr);
  if (kind === "filter") {
    return <LeafRow filter={expr as HardFilter} fields={fields} label={label} onError={onError}
      onChange={f => onChange(f)} onRemove={() => onChange(null)} />;
  }
  const kids = children(expr);
  const setChild = (index: number, next: FilterExpr | null) => {
    const items = kids.map((k, i) => (i === index ? next : k)).filter((k): k is FilterExpr => k !== null);
    if (!items.length) return onChange(null);
    onChange(kind === "all" ? { all: items } : kind === "any" ? { any: items } : { not: items[0]! });
  };
  const append = (item: FilterExpr) => onChange(kind === "all" ? { all: [...kids, item] } : { any: [...kids, item] });
  if (kind === "not") {
    return <div className="condition-group condition-exception" role="group" aria-label={label}>
      <div className="condition-head">
        <strong>Loại bài nếu thỏa (ngoại lệ)</strong>
        <Button size="sm" aria-label={`Bỏ ${label}`} onClick={() => onChange(null)}>Bỏ ngoại lệ</Button>
      </div>
      <Node expr={(expr as { not: FilterExpr }).not} fields={fields} depth={depth + 1}
        label={`${label}, điều kiện loại`} onError={onError} onChange={next => setChild(0, next)} />
    </div>;
  }
  return <div className="condition-group" role="group" aria-label={label}>
    <div className="condition-head">
      <Select aria-label={`${label}: kiểu nhóm`} value={kind}
        onChange={e => onChange(setGroupKind(expr, e.target.value as GroupKind))}>
        <option value="all">Bài phải thỏa TẤT CẢ điều kiện sau</option>
        <option value="any">Bài chỉ cần thỏa ÍT NHẤT MỘT điều kiện sau</option>
      </Select>
      <Button size="sm" aria-label={`Bỏ ${label}`} onClick={() => onChange(null)}>Bỏ nhóm</Button>
    </div>
    <div className="condition-children">
      {kids.map((child, i) => <Node key={i} expr={child} fields={fields} depth={depth + 1}
        label={`${label} › ${i + 1}`} onError={onError} onChange={next => setChild(i, next)} />)}
    </div>
    <div className="condition-actions">
      <Button size="sm" onClick={() => append(newLeaf(fields))}>+ Điều kiện</Button>
      <Button size="sm" onClick={() => append(newGroup("any", fields))}>+ Nhóm “ít nhất một”</Button>
      <Button size="sm" onClick={() => append(newGroup("all", fields))}>+ Nhóm “tất cả”</Button>
      <Button size="sm" onClick={() => append(newException(fields))}>+ Ngoại lệ</Button>
    </div>
  </div>;
};

export const ConditionEditor: React.FC<Props> = ({ condition, fields, onChange, onError }) => {
  const labels = new Map(fields.map(f => [f.key, f.label]));
  const emit = (next: FilterExpr | null) => onChange(prune(next));
  const stale = unknownFieldKeys(condition, fields);
  const incomplete = countIncomplete(condition);
  return <section className="condition-editor" aria-label="Nhóm điều kiện và ngoại lệ">
    <h4>Nhóm điều kiện và ngoại lệ</h4>
    <p className="field-hint">
      Dùng khi bài có thể đạt theo nhiều cách (ví dụ “xe lạnh” hoặc “xe thường có thùng kín”) hoặc cần loại trừ.
      Áp dụng cùng các điều kiện bắt buộc ở trên.
    </p>
    {condition
      ? <Node expr={condition} fields={fields} label="Nhóm điều kiện" depth={0} onChange={emit} onError={onError} />
      : <div className="condition-actions">
          <Button size="sm" onClick={() => emit({ any: [newLeaf(fields)] })}>+ Thêm nhóm điều kiện</Button>
          <Button size="sm" onClick={() => emit(newException(fields))}>+ Thêm ngoại lệ</Button>
        </div>}
    {condition && <p className="condition-summary" data-testid="condition-summary">
      Tóm tắt: {describeCondition(condition, labels)}
    </p>}
    {stale.length > 0 && <p className="field-hint condition-warn" role="alert">
      Điều kiện đang dùng trường không còn tồn tại ({stale.join(", ")}). Hãy chọn lại trường hoặc bỏ điều kiện.
    </p>}
    {incomplete > 0 && <p className="field-hint condition-warn" role="status">
      Còn {incomplete} điều kiện chưa nhập giá trị; cần điền hoặc bỏ trước khi lưu.
    </p>}
  </section>;
};
