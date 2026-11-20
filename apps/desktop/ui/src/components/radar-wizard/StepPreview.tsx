// Preview on real posts, notification setup, and feedback.

import React from "react";
import { OperationStatus } from "../OperationStatus";
import { lifetimeOptions } from "../../lib/format";
import { formatExtractedFieldValue } from "../../lib/format";
import { renderHighlightedPostText } from "../../lib/security";
import type { RadarWizardModel } from "./useRadarWizard";
import { Badge, Button, Card, Input, Select } from "../ui";

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
    sources,
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

  const channelScope = (notify.inherit_channels ?? (notify.channel_ids.length === 0))
    ? "default" : notify.channel_ids.length ? "selected" : "local";
  const activeChannels = channels.filter(c => c.state === "ok");
  const selectedSourceNames = sources.filter(source => selectedSourceIds.includes(source.id)).map(source => source.name);
  return (
    <div>
      <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>
            Kết quả xem thử trên bài thật{" "}
            {previewState &&
              `(${previewState.evaluated_posts} / ${previewState.total_posts} bài)`}
          </strong>
          {previewState && (!editRadar || editRadar.radar.status === "draft") &&
            <span className="radar-preview-draft"><Badge>Bản nháp</Badge></span>}
          {selectedSourceNames.length > 0 && <div className="field-hint">{selectedSourceNames.join(" · ")}</div>}
          <div className="field-hint">
            Không tạo cơ hội thật hoặc gửi thông báo. Phản hồi được lưu làm ví dụ; chạy lại để kiểm tra kết quả mới.
          </div>
        </div>
        <Button
          disabled={previewBusy || saving}
          onClick={() => void startPreviewRun()}
        >
          {previewLoading ? "Đang chấm thử…" : "↻ Chạy lại xem thử"}
        </Button>
      </div>

      {previewState?.status === "done" && previewState.total_posts > 0 && previewState.total_posts < 5 && (
        <p className="field-hint" role="status">Mẫu xem thử còn ít. Đã chấm {previewState.total_posts} bài.</p>
      )}
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
        <Button size="sm" disabled={previewLoading} onClick={() => void stopPreview()}>
          Dừng xem thử
        </Button>
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
            <Button
              size="sm"
              onClick={() => {
                const updated = fields.map((f) =>
                  f.key === w.field_key ? { ...f, required: false } : f
                );
                setFields(updated);
                void startPreviewRun(updated);
              }}
            >
              Bỏ bắt buộc «{w.field_label}» & Chạy lại
            </Button>
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

      <details className="radar-preview-settings">
        <summary>Cài đặt khi bật Radar</summary>
      <OperationStatus health={health}/>
      <Card className="notification-setup"><h3>Khi bật radar này</h3><p>{selectedSourceIds.length} nhóm, {fields.length} thông tin, {hardFilters.length} điều kiện bắt buộc. {editRadar?`Đang chỉnh radar “${editRadar.radar.name}”; chỉ áp dụng khi bấm nút cuối.`:"Bản nháp chưa tự thu thập bài."}</p>
        <label>Chế độ thông báo<Select value={notify.mode} onChange={e=>setNotify(n=>({...n,mode:e.target.value as "instant"|"digest"}))}><option value="instant">Báo ngay</option><option value="digest">Gửi gộp</option></Select></label>
        <label>Tin còn giá trị trong<Select aria-label="Tin còn giá trị trong" value={notify.lead_ttl_hours ?? ""} onChange={e=>setNotify(n=>({...n,lead_ttl_hours:e.target.value?Number(e.target.value):null}))}>{lifetimeOptions(notify.lead_ttl_hours).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</Select></label>
        <p className="field-hint">Tin hết hạn rời hàng chờ «Chưa xử lý» và dừng gửi thông báo. Xem lại tại «Tin hết hạn».</p>
        <label>Điểm tối thiểu để báo<Input type="number" min={0.4} max={1} step={0.05} value={notify.min_score} onChange={e=>setNotify(n=>({...n,min_score:Number(e.target.value)}))}/></label>
        <p className="field-hint">Điểm phù hợp dùng để ưu tiên, không phải xác suất đúng. Cơ hội dưới ngưỡng vẫn có thể xem trong ứng dụng.</p>
        <fieldset>
          <legend>Kênh nhận của radar này</legend>
          <Select aria-label="Phạm vi nhận thông báo" value={channelScope} onChange={e => {
            const scope = e.target.value;
            setNotify(n => ({
              ...n, inherit_channels: scope === "default",
              channel_ids: scope === "selected" ? activeChannels.map(c => c.id) : [],
            }));
          }}>
            <option value="local">Chỉ nhận trên máy này</option>
            <option value="default">Dùng tất cả kênh mặc định</option>
            <option value="selected" disabled={!activeChannels.length}>Chọn kênh cho radar này</option>
          </Select>
          {channelScope === "selected" && channels.map(c => <label key={c.id}>
            <input type="checkbox" checked={notify.channel_ids.includes(c.id)} onChange={e =>
              setNotify(n => ({...n, inherit_channels:false, channel_ids:e.target.checked
                ? [...n.channel_ids,c.id] : n.channel_ids.filter(id=>id!==c.id)}))}/>
            {c.name} {c.state!=="ok"?"(cần kết nối lại)":""}
          </label>)}
          <p className="field-hint">Kênh ngoài nhận tin: {activeChannels.filter(c =>
            channelScope === "default" || (channelScope === "selected" && notify.channel_ids.includes(c.id))
          ).map(c => c.name).join(", ") || "Không có"}.</p>
        </fieldset>

      </Card>
      </details>
      {health && (health.automatic_scanning !== true || !health.extension_connected ||
        health.facebook_session !== "ok" || health.crawl_paused) && (
        <label className="radar-preview-limited">
          <input type="checkbox" checked={readyAck} onChange={event => setReadyAck(event.target.checked)} />
          Tôi hiểu Radar sẽ hoạt động ở chế độ giới hạn cho đến khi Chrome sẵn sàng quét.
        </label>
      )}
      <div className="section-tabs"><Button variant={previewTab==="match" ? "primary" : "default"} onClick={()=>setPreviewTab("match")}>Khớp ({matchedPreviewItems.length})</Button><Button variant={previewTab==="no_match" ? "primary" : "default"} onClick={()=>setPreviewTab("no_match")}>Bị loại ({unmatchedPreviewItems.length})</Button></div>
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
                <Card key={it.evaluation_id} >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <Badge tone="success">
                      Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                      {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                    </Badge>
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
                        <Badge key={fd.key} tone="primary">
                          {fd.label}: {formatExtractedFieldValue(fd, ef)}
                        </Badge>
                      );
                    })}
                  </div>

                  <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                    {renderHighlightedPostText(it.post_text, spans)}
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <Button
                      variant={it.feedback_label === "correct" ? "success" : "default"} size="sm"
                      onClick={() => void handlePreviewFeedback(it, "correct")}
                    >
                      Đúng
                    </Button>
                    <Button
                      variant={it.feedback_label === "irrelevant" ? "danger" : "default"} size="sm"
                      onClick={() => void handlePreviewFeedback(it, "irrelevant")}
                    >
                      Chấm sai
                    </Button>
                  </div>
                </Card>
              );
            })}
            {matchedPreviewItems.length === 0 && (
              <Card className="text-muted">Chưa có bài khớp nào trong tập xem thử.</Card>
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
              <Card key={it.evaluation_id} >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <Badge >
                    Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                    {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                  </Badge>
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
                  <Button
                    variant={it.feedback_label === "correct" ? "success" : "default"} size="sm"
                    onClick={() => void handlePreviewFeedback(it, "correct")}
                  >
                    Loại đúng
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handlePreviewFeedback(it, "missed")}
                  >
                    Đáng lẽ phải khớp
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
