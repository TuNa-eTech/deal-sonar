// Step 1: describe the need (template or blank).

import React from "react";
import type { RadarTemplate, WantIntent } from "../../types/ipc";
import { BLANK_EXAMPLES } from "./constants";
import { formatLifetime } from "../../lib/format";
import type { RadarWizardModel } from "./useRadarWizard";
import { Badge, Button, Input, Textarea } from "../ui";

export const StepDescribe: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    templates,
    templatesOpen,
    setTemplatesOpen,
    mode,
    setMode,
    selectedTemplate,
    placeholderValues,
    radarName,
    setRadarName,
    description,
    setDescription,
    userProfession,
    setUserProfession,
    setWantIntent,
    setFields,
    selectTemplate,
    goalTemplate,
    startBlank,
    handlePlaceholderChange,
    runSuggestFields,
    suggesting,
    notify,
  } = w;

  const renderInlineTemplateEditor = (tpl: RadarTemplate) => {
    const parts = tpl.description_template.split(/(\{[^}]+\})/g);
    return (
      <div className="placeholder-sentence">
        {parts.map((part, idx) => {
          if (part.startsWith("{") && part.endsWith("}")) {
            const key = part.slice(1, -1);
            const ph = tpl.placeholders.find((p) => p.key === key);
            return (
              <input
                key={`${key}-${idx}`}
                type="text"
                aria-label={`Điền ${key}`}
                className="placeholder-inline-input"
                placeholder={ph?.hint ?? key}
                value={placeholderValues[key] ?? ""}
                onChange={(e) => handlePlaceholderChange(key, e.target.value)}
              />
            );
          }
          return <span key={`txt-${idx}`}>{part}</span>;
        })}
      </div>
    );
  };

  return (
    <div>
      <div className="field-group">
        <label className="field-label" htmlFor="radar-desc-textarea">
          Mô tả nhu cầu
        </label>
        <Textarea
          id="radar-desc-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ví dụ: Tìm người cần thuê căn hộ ở Tân Phú, dưới 8 triệu/tháng…"
        />
      </div>
      {mode === "blank" && goalTemplate && <p>
        <Button onClick={() => selectTemplate(goalTemplate)}>Dùng mẫu gợi ý · {goalTemplate.name}</Button>
      </p>}
      <div className="toolbar-row">
        <Button disabled={!description.trim() || suggesting} onClick={() => void runSuggestFields(true)}>
          Cập nhật tiêu chí
        </Button>
        <Button
          variant={mode === "template" ? "primary" : "default"}
          onClick={() => {
            setMode("template");
            setTemplatesOpen(true);

          }}
        >
          Chọn mẫu theo ngành ({templates.length})
        </Button>
        {mode !== "blank" && <Button onClick={startBlank}>Bắt đầu từ trang trắng</Button>}
      </div>

      {mode === "template" && (
        <div style={{ marginBottom: 14 }}>
          {selectedTemplate&&!templatesOpen&&<div className="radar-selected-template"><div><span className="field-hint">Mẫu đang dùng · {selectedTemplate.industry}</span><strong>{selectedTemplate.name}</strong></div><Button size="sm" onClick={()=>setTemplatesOpen(true)}>Đổi mẫu</Button></div>}
          <div className="template-grid radar-template-grid" hidden={!templatesOpen} style={{ marginBottom: 14 }}>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                aria-pressed={selectedTemplate?.id===tpl.id}
                className={`template-card ${selectedTemplate?.id === tpl.id ? "selected" : ""}`}
                onClick={() => selectTemplate(tpl)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                  <Badge tone="primary">{tpl.industry}</Badge>
                  {tpl.seed_ruleset && (
                    <Badge tone="success">Có sẵn bộ luật</Badge>
                  )}
                </div>
                <strong style={{ fontSize: 13.5 }}>{tpl.name}</strong>
                <span className="field-hint">{tpl.description_template}</span>
              </button>
            ))}
          </div>

          {selectedTemplate && (
            <div className="field-group">
              <span className="field-label">
                Điền nhanh vào câu mẫu «{selectedTemplate.name}»:
              </span>
              {renderInlineTemplateEditor(selectedTemplate)}
              <dl className="radar-template-lifetime">
                <dt>Tin còn giá trị</dt><dd>{formatLifetime(notify.lead_ttl_hours)}</dd>
              </dl>
            </div>
          )}
        </div>
      )}

      {mode === "blank" && (
        <details className="radar-advanced">
          <summary>Xem ví dụ mô tả</summary>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            {BLANK_EXAMPLES.map((ex) => (
              <button
                key={ex.title}
                type="button"
                className="template-card"
                onClick={() => {
                  setRadarName(ex.title);
                  setDescription(ex.description);
                  setUserProfession(ex.profession);
                  setWantIntent(ex.intent);
                  setFields([]);
                }}
              >
                <strong>{ex.title}</strong>
                <span className="field-hint">{ex.description}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      <details className="radar-advanced"><summary>Tên Radar và công việc của bạn</summary><div className="radar-identity-fields">
        <div className="field-group">
          <label className="field-label" htmlFor="radar-name-input">
            Tên gọi Radar
          </label>
          <Input
            id="radar-name-input"
            type="text"
            value={radarName}
            onChange={(e) => setRadarName(e.target.value)}
            placeholder="Ví dụ: Khách thuê căn hộ Cầu Giấy"
          />
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="user-profession-input">
            Bạn làm nghề gì?
          </label>
          <Input
            id="user-profession-input"
            type="text"
            value={userProfession}
            onChange={(e) => setUserProfession(e.target.value)}
            placeholder="Ví dụ: môi giới bất động sản, thợ điện nước…"
          />
          <span className="field-hint">
            Để hệ thống nhận ra và loại bài của người cùng nghề đăng tìm khách.
          </span>
        </div>
      </div></details>

    </div>
  );
};
