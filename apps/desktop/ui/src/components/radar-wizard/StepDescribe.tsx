// Step 1: describe the need (template or blank).

import React from "react";
import type { RadarTemplate, WantIntent } from "../../types/ipc";
import { BLANK_EXAMPLES } from "./constants";
import type { RadarWizardModel } from "./useRadarWizard";

export const StepDescribe: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    templates,
    templatesOpen,
    setTemplatesOpen,
    mode,
    setMode,
    selectedTemplate,
    setSelectedTemplate,
    placeholderValues,
    radarName,
    setRadarName,
    description,
    setDescription,
    userProfession,
    setUserProfession,
    wantIntent,
    setWantIntent,
    excludePeers,
    setExcludePeers,
    setFields,
    selectTemplate,
    handlePlaceholderChange,
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
      <div className="toolbar-row">
        <button
          type="button"
          className={`btn ${mode === "template" ? "btn-primary" : ""}`}
          onClick={() => {
            setMode("template");
            setTemplatesOpen(true);
            if (!selectedTemplate && templates[0]) selectTemplate(templates[0]);
          }}
        >
          Chọn mẫu theo ngành ({templates.length})
        </button>
        <button
          type="button"
          className={`btn ${mode === "blank" ? "btn-primary" : ""}`}
          onClick={() => {
            setMode("blank");
            setSelectedTemplate(null);
          }}
        >
          Bắt đầu từ trang trắng
        </button>
      </div>

      {mode === "template" && (
        <div style={{ marginBottom: 14 }}>
          {selectedTemplate&&!templatesOpen&&<div className="radar-selected-template"><div><span className="field-hint">Mẫu đang dùng · {selectedTemplate.industry}</span><strong>{selectedTemplate.name}</strong></div><button type="button" className="btn btn-sm" onClick={()=>setTemplatesOpen(true)}>Đổi mẫu</button></div>}
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
                  <span className="badge badge-primary">{tpl.industry}</span>
                  {tpl.seed_ruleset && (
                    <span className="badge badge-success">Có sẵn bộ luật</span>
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
            </div>
          )}
        </div>
      )}

      {mode === "blank" && (
        <div style={{ marginBottom: 14 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Ba ví dụ mô tả tốt để tham khảo (bấm để chép mẫu):
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
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
        </div>
      )}

      <div className="field-group">
        <label className="field-label" htmlFor="radar-desc-textarea">
          Câu mô tả chi tiết thứ cần tìm
        </label>
        <textarea
          id="radar-desc-textarea"
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Mô tả rõ đối tượng, khu vực, tầm giá hoặc đặc điểm tin bạn muốn bắt…"
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field-group">
          <label className="field-label" htmlFor="radar-name-input">
            Tên gọi Radar
          </label>
          <input
            id="radar-name-input"
            type="text"
            className="input"
            value={radarName}
            onChange={(e) => setRadarName(e.target.value)}
            placeholder="Ví dụ: Khách thuê căn hộ Cầu Giấy"
          />
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="user-profession-input">
            Bạn làm nghề gì?
          </label>
          <input
            id="user-profession-input"
            type="text"
            className="input"
            value={userProfession}
            onChange={(e) => setUserProfession(e.target.value)}
            placeholder="Ví dụ: môi giới bất động sản, thợ điện nước…"
          />
          <span className="field-hint">
            Để hệ thống nhận ra và loại bài của người cùng nghề đăng tìm khách.
          </span>
        </div>
      </div>


      <details className="radar-advanced"><summary>Đối tượng bài viết & Loại trừ người cùng nghề</summary><div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="field-label">Ý định bài viết cần bắt:</span>
          <select
            aria-label="Ý định bài viết cần bắt"
            className="select"
            style={{ width: 240 }}
            value={wantIntent}
            onChange={(e) => setWantIntent(e.target.value as WantIntent)}
          >
            <option value="demand">Khách cần mua / thuê / tìm</option>
            <option value="supply">Người bán / cho thuê / tìm việc</option>
            <option value="any">Cả hai chiều / ghép chuyến</option>
          </select>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={excludePeers}
            onChange={(e) => setExcludePeers(e.target.checked)}
          />
          <span>Loại bài chào bán của người cùng nghề</span>
        </label>
      </div></details>
    </div>
  );
};
