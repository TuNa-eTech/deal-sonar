// Step 4: preview on real posts, notification setup, and feedback.

import React from "react";
import { OperationStatus } from "../OperationStatus";
import { formatExtractedFieldValue } from "../../lib/format";
import { renderHighlightedPostText } from "../../lib/security";
import type { RadarWizardModel } from "./useRadarWizard";

export const StepPreview: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    editRadar,
    health,
    channels,
    notify,
    setNotify,
    hardFilters,
    readyAck,
    setReadyAck,
    previewTab,
    setPreviewTab,
    isEditingActive,
    step,
    mode,
    fields,
    setFields,
    selectedSourceIds,
    requiresVersionConfirm,
    confirmedUpgrade,
    setConfirmedUpgrade,
    previewState,
    previewLoading,
    saving,
    previewSeconds,
    previewSyncError,
    previewRunning,
    previewBusy,
    stopPreview,
    startPreviewRun,
    handlePreviewFeedback,
    matchedPreviewItems,
    unmatchedPreviewItems,
  } = w;

  return (
    <div>
      <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>
            Kết quả xem thử trên bài thật{" "}
            {previewState &&
              `(${previewState.evaluated_posts} / ${previewState.total_posts} bài)`}
          </strong>
          <div className="field-hint">
            Không tạo cơ hội thật hoặc gửi thông báo. Phản hồi được lưu làm ví dụ; chạy lại để kiểm tra kết quả mới.
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={previewBusy || saving}
          onClick={() => void startPreviewRun()}
        >
          {previewLoading ? "Đang chấm thử…" : "↻ Chạy lại xem thử"}
        </button>
      </div>

      {previewRunning && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>
            {previewState?.status === "crawling"
              ? "Đang lấy bài từ Chrome; chờ tối đa 30 giây…"
              : `Đang chấm AI theo lô: đã chấm ${previewState?.evaluated_posts}/${previewState?.total_posts} bài. Lô đầu có thể mất tới 2 phút.`}
            {` Đã chờ ${previewSeconds} giây.`}
          </span>
        </div>
      )}

      {previewRunning && (
        <button type="button" className="btn btn-sm" disabled={previewLoading} onClick={() => void stopPreview()}>
          Dừng xem thử
        </button>
      )}
      {previewSyncError && <div role="status" className="health-banner warning">{previewSyncError}</div>}
      {previewState?.status === "error" && (
        <div role="alert" className="health-banner danger">
          {previewState.error || "Không chấm được bài. Hãy kiểm tra kết nối AI rồi chạy lại."}
          {` Đã chấm ${previewState.evaluated_posts}/${previewState.total_posts} bài; ${previewState.failed_posts ?? 0} bài lỗi.`}
        </div>
      )}

      {/* Quality warnings (`02-radar-spec.md §5`) */}
      {previewState?.warnings.map((w, idx) => (
        <div
          key={`${w.code}-${idx}`}
          className="health-banner warning"
          style={{ borderRadius: 6, marginBottom: 10 }}
        >
          <span>{w.message}</span>
          {w.code === "missing_required_field" && w.field_key && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const updated = fields.map((f) =>
                  f.key === w.field_key ? { ...f, required: false } : f
                );
                setFields(updated);
                void startPreviewRun(updated);
              }}
            >
              Bỏ bắt buộc «{w.field_label}» & Chạy lại
            </button>
          )}
        </div>
      ))}

      {/* Active radar version-upgrade confirmation (`02-radar-spec.md §4`) */}
      {isEditingActive && requiresVersionConfirm && (
        <label
          className="card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--primary-soft)",
            borderColor: "var(--border-strong)",
            marginBottom: 12,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={confirmedUpgrade}
            onChange={(e) => setConfirmedUpgrade(e.target.checked)}
          />
          <span>
            <strong>Xác nhận nâng cấp phiên bản Radar đang chạy:</strong> Trong lúc xem thử,
            radar vẫn đang chạy phiên bản cũ (v{editRadar?.radar.current_version}). Đánh dấu
            để áp dụng phiên bản mới (v{(editRadar?.radar.current_version ?? 1) + 1}) từ thời
            điểm này trở đi.
          </span>
        </label>
      )}

      <OperationStatus health={health}/>
      <div className="card notification-setup"><h3>Khi bật radar này</h3><p>{selectedSourceIds.length} nhóm, {fields.length} thông tin, {hardFilters.length} điều kiện bắt buộc. {editRadar?`Đang chỉnh radar “${editRadar.radar.name}”; chỉ áp dụng khi bấm nút cuối.`:"Bản nháp chưa tự thu thập bài."}</p>
        <label>Chế độ thông báo<select className="select" value={notify.mode} onChange={e=>setNotify(n=>({...n,mode:e.target.value as "instant"|"digest"}))}><option value="instant">Báo ngay</option><option value="digest">Gửi gộp</option></select></label>
        <label>Điểm tối thiểu để báo<input className="input" type="number" min={0.4} max={1} step={0.05} value={notify.min_score} onChange={e=>setNotify(n=>({...n,min_score:Number(e.target.value)}))}/></label>
        <p className="field-hint">Điểm phù hợp dùng để ưu tiên, không phải xác suất đúng. Cơ hội dưới ngưỡng vẫn có thể xem trong ứng dụng.</p>
        <fieldset><legend>Kênh nhận của radar này</legend>{channels.map(c=><label key={c.id}><input type="checkbox" checked={notify.channel_ids.includes(c.id)} onChange={e=>setNotify(n=>({...n,channel_ids:e.target.checked?[...n.channel_ids,c.id]:n.channel_ids.filter(id=>id!==c.id)}))}/>{c.name} {c.state!=="ok"?"(cần kết nối lại)":""}</label>)}{channels.length===0&&<p>Chưa có kênh ngoài. Xem cơ hội trong ứng dụng và dùng thông báo màn hình theo Cài đặt.</p>}</fieldset>
        {(health?.automatic_scanning!==true||!health?.extension_connected||health?.crawl_paused)&&<label><input type="checkbox" checked={readyAck} onChange={e=>setReadyAck(e.target.checked)}/> Tôi hiểu radar đã bật chưa đồng nghĩa đang quét. Tôi sẽ mở tiện ích và bật quét tự động hoặc quét thủ công.</label>}
      </div>
      <div className="section-tabs"><button className={`btn ${previewTab==="match"?"btn-primary":""}`} onClick={()=>setPreviewTab("match")}>Khớp ({matchedPreviewItems.length})</button><button className={`btn ${previewTab==="no_match"?"btn-primary":""}`} onClick={()=>setPreviewTab("no_match")}>Bị loại ({unmatchedPreviewItems.length})</button></div>
      <div className="preview-columns">
        {/* Column 1: KHỚP */}
        <div hidden={previewTab!=="match"}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <strong style={{ color: "var(--success)" }}>
              ✓ Khớp ({matchedPreviewItems.length})
            </strong>
            <span className="field-hint">Sắp xếp theo điểm giảm dần</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {matchedPreviewItems.map((it) => {
              const spans = fields
                .map((fd) => {
                  const ef = it.fields[fd.key];
                  return ef?.raw ? { raw: ef.raw, fieldLabel: fd.label } : null;
                })
                .filter((x): x is { raw: string; fieldLabel: string } => Boolean(x));

              return (
                <div key={it.evaluation_id} className="card">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span className="badge badge-success">
                      Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                      {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                    </span>
                    <span className="field-hint">
                      {it.author_name} · {it.source_name}
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, margin: "6px 0 4px" }}>{it.summary}</div>
                  <div className="field-hint" style={{ marginBottom: 6 }}>
                    Lý do: {it.reason}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginBottom: 8,
                    }}
                  >
                    {fields.map((fd) => {
                      const ef = it.fields[fd.key];
                      if (!ef) return null;
                      return (
                        <span key={fd.key} className="badge badge-primary">
                          {fd.label}: {formatExtractedFieldValue(fd, ef)}
                        </span>
                      );
                    })}
                  </div>

                  <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                    {renderHighlightedPostText(it.post_text, spans)}
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${
                        it.feedback_label === "correct" ? "btn-success" : ""
                      }`}
                      onClick={() => void handlePreviewFeedback(it, "correct")}
                    >
                      Đúng
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${
                        it.feedback_label === "irrelevant" ? "btn-danger" : ""
                      }`}
                      onClick={() => void handlePreviewFeedback(it, "irrelevant")}
                    >
                      Chấm sai
                    </button>
                  </div>
                </div>
              );
            })}
            {matchedPreviewItems.length === 0 && (
              <div className="card text-muted">Chưa có bài khớp nào trong tập xem thử.</div>
            )}
          </div>
        </div>

        {/* Column 2: KHÔNG KHỚP */}
        <div hidden={previewTab!=="no_match"}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <strong style={{ color: "var(--text-secondary)" }}>
              ✕ Không khớp ({unmatchedPreviewItems.length})
            </strong>
            <span className="field-hint">Đã loại tự động</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {unmatchedPreviewItems.map((it) => (
              <div key={it.evaluation_id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span className="badge">
                    Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                    {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                  </span>
                  <span className="field-hint">
                    {it.author_name} · {it.source_name}
                  </span>
                </div>
                <div style={{ fontWeight: 600, margin: "6px 0 4px" }}>{it.summary}</div>
                <div className="field-hint" style={{ marginBottom: 6 }}>
                  Lý do loại: {it.reason}
                </div>
                <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                  {renderHighlightedPostText(it.post_text, [])}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${
                      it.feedback_label === "correct" ? "btn-success" : ""
                    }`}
                    onClick={() => void handlePreviewFeedback(it, "correct")}
                  >
                    Loại đúng
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handlePreviewFeedback(it, "missed")}
                  >
                    Đáng lẽ phải khớp
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
