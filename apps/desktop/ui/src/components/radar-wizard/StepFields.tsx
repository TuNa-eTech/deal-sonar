// Step 2: confirm intent, hard filters, and extracted fields.

import React from "react";
import { parseFieldValue } from "../../lib/fieldValues";
import { describeCondition } from "../../lib/versionDiff";
import { FIELD_TYPE_LABELS, slugifyFieldKey } from "../../lib/format";
import type { HardFilter, FieldType } from "../../types/ipc";
import type { RadarWizardModel } from "./useRadarWizard";
import { Button, Card, Input, Select } from "../ui";

export const StepFields: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    license,
    hardFilters,
    setHardFilters,
    condition,
    showFields,
    setShowFields,
    answers,
    setAnswers,
    setDescription,
    wantIntent,
    excludePeers,
    fields,
    clarifyingQuestions,
    clarifyingDismissed,
    setClarifyingDismissed,
    setErrorMsg,
    setWantIntent,
    setExcludePeers,
    maxFields,
    updateField,
    moveField,
    addField,
    removeField,
  } = w;

  return (
    <div>
      {!clarifyingDismissed && clarifyingQuestions.length > 0 && (
        <Card style={{ background: "var(--warning-soft)", borderColor: "var(--warning)", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Gợi ý làm rõ thêm từ AI (không bắt buộc):</strong>
            <Button
              size="sm"
              onClick={() => setClarifyingDismissed(true)}
            >
              Bỏ qua gợi ý
            </Button>
          </div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {clarifyingQuestions.map((q) => (
              <li key={q}><label>{q}<Input value={answers[clarifyingQuestions.indexOf(q)]??""} onChange={e=>setAnswers(a=>({...a,[clarifyingQuestions.indexOf(q)]:e.target.value}))}/></label></li>
            ))}
          </ul>
          <Button size="sm" onClick={()=>{setDescription(d=>d+"\n"+clarifyingQuestions.map((q,i)=>answers[i]?`${q}: ${answers[i]}`:"").filter(Boolean).join("\n"));setClarifyingDismissed(true);}}>Bổ sung vào mô tả</Button>
        </Card>
      )}

      {!fields.length && <p className="field-hint">Tiêu chí sẽ hiện sau khi AI đọc mô tả.</p>}
      {fields.length > 0 && <div className="radar-criteria-fields">
        <label className="field-group">
          <span className="field-label">Loại bài</span>
          <Select value={wantIntent} onChange={event => setWantIntent(event.target.value as typeof wantIntent)}>
            <option value="demand">Người cần mua / thuê / tìm</option>
            <option value="supply">Người bán / cho thuê / cung cấp</option>
            <option value="any">Cả hai chiều</option>
          </Select>
        </label>
        <label className="radar-peer-scope">
          <input type="checkbox" checked={excludePeers} onChange={event => setExcludePeers(event.target.checked)} />
          Loại bài chào bán của người cùng nghề
        </label>
        <h4>Điều kiện bắt buộc</h4>
        {condition && <p className="field-hint" data-testid="radar-condition">
          Điều kiện nhóm (tất cả / ít nhất một / ngoại lệ), áp dụng cùng các điều kiện bên dưới:{" "}
          {describeCondition(condition, new Map(fields.map(candidate => [candidate.key, candidate.label])))}
        </p>}
        {hardFilters.map((filter, index) => {
          const field = fields.find(candidate => candidate.key === filter.field);
          const update = (patch: Partial<HardFilter>) => setHardFilters(items =>
            items.map((item, row) => row === index ? { ...item, ...patch } : item));
          return <div className="hard-filter-row" key={index}>
            <Select aria-label={`Trường điều kiện ${index + 1}`} value={filter.field}
              onChange={event => update({ field: event.target.value, value: null })}>
              {fields.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
            </Select>
            <Select aria-label={`So sánh ${index + 1}`} value={filter.op}
              onChange={event => update({ op: event.target.value as HardFilter["op"], value: null })}>
              <option value="eq">Bằng</option>
              <option value="ne">Khác</option>
              <option value="lt">Dưới</option>
              <option value="lte">Không quá</option>
              <option value="gt">Trên</option>
              <option value="gte">Ít nhất</option>
              <option value="between">Trong khoảng</option>
              <option value="in">Thuộc danh sách</option>
              <option value="contains">Chứa</option>
              <option value="is_empty">Chưa có thông tin</option>
            </Select>
            {filter.op !== "is_empty" && <Input key={JSON.stringify(filter.value)}
              aria-label={`Giá trị điều kiện ${index + 1}`}
              defaultValue={typeof filter.value === "object" && filter.value !== null
                ? JSON.stringify(filter.value) : String(filter.value ?? "")}
              placeholder={filter.op === "between" ? "[từ, đến]" : filter.op === "in" ? '["giá trị"]' : undefined}
              onBlur={event => {
                const raw = event.target.value.trim();
                try {
                  let value: HardFilter["value"] = raw || null;
                  if (raw && (filter.op === "between" || filter.op === "in")) {
                    value = JSON.parse(raw);
                    if (!Array.isArray(value) || !value.length || (filter.op === "between" && value.length !== 2)) {
                      throw new Error("Nhập các giá trị trong ngoặc vuông. Khoảng cần hai giá trị.");
                    }
                  } else if (raw && field && ["money", "number", "range"].includes(field.type)) {
                    value = parseFieldValue({ ...field, type: "number" }, raw);
                  }
                  update({ value });
                } catch (error) {
                  update({ value: null });
                  setErrorMsg(String(error));
                }
              }} />}
            <Select aria-label={`Khi thiếu thông tin ${index + 1}`} value={filter.when_missing}
              onChange={event => update({ when_missing: event.target.value as HardFilter["when_missing"] })}>
              <option value="pass">Thiếu thông tin: giữ lại</option>
              <option value="fail">Thiếu thông tin: loại</option>
            </Select>
            <Button size="sm" onClick={() => setHardFilters(items => items.filter((_, row) => row !== index))}>Bỏ</Button>
          </div>;
        })}
        <Button size="sm" onClick={() => setHardFilters(items =>
          [...items,{ field: fields[0]!.key, op: "eq", value: null, when_missing: "fail" }])}>+ Điều kiện bắt buộc</Button>
      </div>}
      <div className="radar-field-disclosure">
        <Button aria-expanded={showFields} onClick={() => setShowFields(value => !value)}>
          {showFields ? "Thu gọn" : "Tùy chỉnh"} thông tin cần lấy ({fields.length})
        </Button>
      </div>
      <div hidden={!showFields}>
        <div className="toolbar-row">
          <span className="field-hint">{fields.length} / {maxFields} trường · Gói {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"}</span>
          <Button disabled={fields.length >= maxFields} onClick={addField}>+ Thêm trường</Button>
        </div>
      <div className="table-wrap">
        <table className="crm-table">
          <thead>
            <tr>
              <th style={{ width: 68 }}>Thứ tự</th>
              <th style={{ width: 170 }}>Tên trường</th>
              <th style={{ width: 165 }}>Kiểu dữ liệu</th>
              <th>Mô tả cho AI & Lựa chọn</th>
              <th style={{ width: 85 }}>Bắt buộc</th>
              <th style={{ width: 105 }}>Báo Telegram</th>
              <th style={{ width: 65 }}>Xoá</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, idx) => (
              <tr key={`${f.key}-${idx}`}>
                <td>
                  <div style={{ display: "flex", gap: 3 }}>
                    <Button
                      size="sm"
                      aria-label={`Đưa trường ${f.label} lên`}
                      disabled={idx === 0}
                      onClick={() => moveField(idx, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Đưa trường ${f.label} xuống`}
                      disabled={idx === fields.length - 1}
                      onClick={() => moveField(idx, 1)}
                    >
                      ↓
                    </Button>
                  </div>
                </td>
                <td>
                  <Input
                    type="text"
                    aria-label={`Tên trường ${idx + 1}`}
                    value={f.label}
                    onChange={(e) =>
                      updateField(idx, {
                        label: e.target.value,
                        key: f.key.startsWith("custom_field_")
                          ? slugifyFieldKey(e.target.value, idx + 1)
                          : f.key,
                      })
                    }
                  />
                  <div className="field-hint">
                    <code>{f.key}</code>
                  </div>
                </td>
                <td>
                  <Select
                    aria-label={`Kiểu trường ${f.label}`}
                    value={f.type}
                    onChange={(e) => updateField(idx, { type: e.target.value as FieldType })}
                  >
                    {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((ft) => (
                      <option key={ft} value={ft}>
                        {FIELD_TYPE_LABELS[ft]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <Input
                    type="text"
                    aria-label={`Mô tả trường ${f.label}`}
                    value={f.description}
                    onChange={(e) => updateField(idx, { description: e.target.value })}
                  />
                  {(f.type === "enum" || f.type === "multi_enum") && (
                    <Input
                      type="text"
                      aria-label={`Các lựa chọn cho ${f.label}`}
                      style={{ marginTop: 5 }}
                      placeholder="Các giá trị cách nhau bằng dấu phẩy: thuê, mua"
                      value={(f.options ?? []).join(", ")}
                      onChange={(e) =>
                        updateField(idx, {
                          options: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  )}
                </td>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={`Bắt buộc ${f.label}`}
                    checked={f.required}
                    onChange={(e) => updateField(idx, { required: e.target.checked })}
                  />
                </td>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={`Hiện trong tin báo ${f.label}`}
                    checked={f.show_in_alert}
                    onChange={(e) => updateField(idx, { show_in_alert: e.target.checked })}
                  />
                </td>
                <td>
                  <Button
                    size="sm"
                    aria-label={`Xoá trường ${f.label}`}
                    onClick={() => removeField(idx)}
                  >
                    Xoá
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field-hint" style={{ marginTop: 8 }}>
        Trường hệ thống luôn có sẵn (không tính vào giới hạn): <code>summary</code> (tóm tắt
        1 dòng), <code>intent</code>, <code>author_role</code>, <code>score</code>,{" "}
        <code>reason</code>.
      </div>
      </div>
    </div>
  );
};
