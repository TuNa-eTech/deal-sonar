// Step 2: confirm intent, hard filters, and extracted fields.

import React from "react";
import { parseFieldValue } from "../../lib/fieldValues";
import { FIELD_TYPE_LABELS, slugifyFieldKey } from "../../lib/format";
import type { HardFilter, FieldType } from "../../types/ipc";
import type { RadarWizardModel } from "./useRadarWizard";

export const StepFields: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    license,
    hardFilters,
    setHardFilters,
    showFields,
    setShowFields,
    answers,
    setAnswers,
    description,
    setDescription,
    wantIntent,
    excludePeers,
    fields,
    suggesting,
    clarifyingQuestions,
    clarifyingDismissed,
    setClarifyingDismissed,
    setErrorMsg,
    maxFields,
    runSuggestFields,
    updateField,
    moveField,
    addField,
    removeField,
  } = w;

  return (
    <div>
      <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Danh sách trường thông tin sẽ trích từ mỗi bài khớp</strong>
          <div className="field-hint">
            Giới hạn gói {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"}:{" "}
            <strong>
              {fields.length} / {maxFields} trường
            </strong>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            disabled={suggesting}
            onClick={() => void runSuggestFields(true)}
          >
            {suggesting ? "⏳ AI đang phân tích mô tả…" : "✨ Đề xuất lại bằng AI"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={fields.length >= maxFields}
            title={
              fields.length >= maxFields
                ? `Gói hiện tại giới hạn tối đa ${maxFields} trường`
                : "Thêm trường tuỳ chỉnh"
            }
            onClick={addField}
          >
            + Thêm trường
          </button>
        </div>
      </div>

      {suggesting && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>Đang gọi AI đề xuất các trường phù hợp với câu mô tả của bạn (2–10 giây)…</span>
        </div>
      )}

      {!clarifyingDismissed && clarifyingQuestions.length > 0 && (
        <div className="card" style={{ background: "var(--warning-soft)", borderColor: "var(--warning)", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Gợi ý làm rõ thêm từ AI (không bắt buộc):</strong>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setClarifyingDismissed(true)}
            >
              Bỏ qua gợi ý
            </button>
          </div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {clarifyingQuestions.map((q) => (
              <li key={q}><label>{q}<input className="input" value={answers[clarifyingQuestions.indexOf(q)]??""} onChange={e=>setAnswers(a=>({...a,[clarifyingQuestions.indexOf(q)]:e.target.value}))}/></label></li>
            ))}
          </ul>
          <button className="btn btn-sm" onClick={()=>{setDescription(d=>d+"\n"+clarifyingQuestions.map((q,i)=>answers[i]?`${q}: ${answers[i]}`:"").filter(Boolean).join("\n"));setClarifyingDismissed(true);}}>Bổ sung vào mô tả</button>
        </div>
      )}

      <div className="intent-summary"><h3>Radar sẽ tìm điều gì?</h3><p>{description}</p><p>Hướng tìm: <strong>{wantIntent==="demand"?"Khách có nhu cầu":wantIntent==="supply"?"Người cung cấp / người bán":"Cả hai chiều"}</strong> · {excludePeers?"Loại bài người cùng nghề":"Giữ mọi vai trò"}</p>
        <h4>Điều kiện bắt buộc</h4><p className="field-hint">Mô tả giúp AI hiểu nhu cầu. Điều kiện bên dưới là giới hạn bắt buộc sau khi trích xuất.</p>
        {hardFilters.map((filter,index)=>{const fd=fields.find(f=>f.key===filter.field);return <div className="hard-filter-row" key={index}><select className="select" aria-label={`Trường điều kiện ${index+1}`} value={filter.field} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,field:e.target.value,value:null}:x))}>{fields.map(f=><option key={f.key} value={f.key}>{f.label}</option>)}</select><select className="select" aria-label={`So sánh ${index+1}`} value={filter.op} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,op:e.target.value as HardFilter["op"]}:x))}>{["eq","ne","lte","gte","contains","is_empty"].map(op=><option key={op} value={op}>{({eq:"Bằng",ne:"Khác",lte:"Không quá",gte:"Ít nhất",contains:"Chứa",is_empty:"Chưa có thông tin"} as Record<string,string>)[op]}</option>)}</select><input className="input" aria-label={`Giá trị điều kiện ${index+1}`} defaultValue={typeof filter.value==="object"?JSON.stringify(filter.value):String(filter.value??"")} onBlur={e=>{try{const raw=e.target.value;const val=fd&&["money","number","range"].includes(fd.type)?parseFieldValue({...fd,type:"number"},raw):raw;setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,value:val}:x));}catch(err){setErrorMsg(String(err));}}}/><select className="select" aria-label={`Khi thiếu thông tin ${index+1}`} value={filter.when_missing} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,when_missing:e.target.value as "pass"|"fail"}:x))}><option value="pass">Thiếu thông tin: giữ lại</option><option value="fail">Thiếu thông tin: loại</option></select><button className="btn btn-sm" onClick={()=>setHardFilters(xs=>xs.filter((_,i)=>i!==index))}>Bỏ</button></div>;})}
        <button className="btn btn-sm" disabled={!fields.length} onClick={()=>setHardFilters(xs=>[...xs,{field:fields[0]!.key,op:"eq",value:"",when_missing:"pass"}])}>+ Điều kiện bắt buộc</button>
      </div>
      <button className="btn" aria-expanded={showFields} onClick={()=>setShowFields(v=>!v)}>{showFields?"Thu gọn":"Tùy chỉnh"} thông tin cần lấy ({fields.length} trường)</button>
      <div hidden={!showFields}>
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
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Đưa trường ${f.label} lên`}
                      disabled={idx === 0}
                      onClick={() => moveField(idx, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Đưa trường ${f.label} xuống`}
                      disabled={idx === fields.length - 1}
                      onClick={() => moveField(idx, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td>
                  <input
                    type="text"
                    aria-label={`Tên trường ${idx + 1}`}
                    className="input"
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
                  <select
                    aria-label={`Kiểu trường ${f.label}`}
                    className="select"
                    value={f.type}
                    onChange={(e) => updateField(idx, { type: e.target.value as FieldType })}
                  >
                    {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((ft) => (
                      <option key={ft} value={ft}>
                        {FIELD_TYPE_LABELS[ft]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="text"
                    aria-label={`Mô tả trường ${f.label}`}
                    className="input"
                    value={f.description}
                    onChange={(e) => updateField(idx, { description: e.target.value })}
                  />
                  {(f.type === "enum" || f.type === "multi_enum") && (
                    <input
                      type="text"
                      aria-label={`Các lựa chọn cho ${f.label}`}
                      className="input"
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
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Xoá trường ${f.label}`}
                    onClick={() => removeField(idx)}
                  >
                    Xoá
                  </button>
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
