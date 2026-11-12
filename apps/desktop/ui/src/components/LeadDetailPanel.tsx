import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  formatExactTime,
  formatExtractedFieldValue,
  formatRelativeTime,
  LEAD_STATUS_LABELS,
} from "../lib/format";
import {
  isSafeFacebookPermalink,
  openFacebookPermalink,
  renderHighlightedPostText,
} from "../lib/security";
import type { FeedbackLabel, FieldDef, LeadDetail, LeadStatus } from "../types/ipc";

interface LeadDetailPanelProps {
  leadId: string;
  onUpdated: () => void;
  onClose?: () => void;
}

export const LeadDetailPanel: React.FC<LeadDetailPanelProps> = ({
  leadId,
  onUpdated,
  onClose,
}) => {
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [editingFieldVal, setEditingFieldVal] = useState<string>("");

  const [wrongMenuOpen, setWrongMenuOpen] = useState(false);
  const [peerPromptOpen, setPeerPromptOpen] = useState(false);
  const [batchFieldEditOpen, setBatchFieldEditOpen] = useState(false);
  const [batchFieldDrafts, setBatchFieldDrafts] = useState<Record<string, string>>({});

  const [noteInput, setNoteInput] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [actionAlert, setActionAlert] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadDetail = async (id: string) => {
    setLoading(true);
    setActionAlert(null);
    try {
      const res = await api.leadGet(id);
      setDetail(res);
      setNoteInput(res.lead.note ?? "");
      setTagsInput(res.lead.tags.join(", "));
      setFollowUpInput(
        res.lead.follow_up_at
          ? new Date(res.lead.follow_up_at).toISOString().slice(0, 16)
          : ""
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDetail(leadId);
  }, [leadId]);

  if (loading || !detail) {
    return <div className="text-muted">Đang tải chi tiết tin…</div>;
  }

  const { lead, post, radar_fields } = detail;

  const rawSpans = radar_fields
    .map((fd) => {
      const ef = lead.fields[fd.key];
      return ef?.raw ? { raw: ef.raw, fieldLabel: fd.label } : null;
    })
    .filter((x): x is { raw: string; fieldLabel: string } => Boolean(x));

  const parseEditedValue = (fd: FieldDef, textVal: string): unknown => {
    const trimmed = textVal.trim();
    if (!trimmed) return null;
    if (fd.type === "number") {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : trimmed;
    }
    if (fd.type === "boolean") {
      return trimmed.toLowerCase() === "true" || trimmed.toLowerCase() === "có";
    }
    if (fd.type === "money") {
      const n = Number(trimmed.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n) && n > 0) {
        const prev = lead.fields[fd.key]?.value as Record<string, unknown> | undefined;
        return {
          min: n,
          max: n,
          currency: (prev?.currency as string) ?? "VND",
          period: (prev?.period as string | null) ?? null,
        };
      }
    }
    if (fd.type === "multi_enum") {
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return trimmed;
  };

  const handleSaveInlineField = async (fd: FieldDef) => {
    const updated = await api.leadUpdateField(
      lead.id,
      fd.key,
      parseEditedValue(fd, editingFieldVal)
    );
    setDetail(updated);
    setEditingFieldKey(null);
    setActionAlert({ kind: "ok", text: `Đã lưu giá trị sửa tay cho trường «${fd.label}».` });
    onUpdated();
  };

  const handleFeedback = async (
    label: FeedbackLabel,
    opts?: { blockAuthor?: boolean; corrected?: Record<string, unknown> }
  ) => {
    setWrongMenuOpen(false);
    setPeerPromptOpen(false);
    await api.leadFeedback({
      evaluation_id: lead.evaluation_id,
      lead_id: lead.id,
      post_id: lead.post_id,
      radar_version_id: lead.radar_version_id,
      label,
      block_author: opts?.blockAuthor ?? false,
      corrected_fields: opts?.corrected ?? null,
      origin: "app",
    });
    await loadDetail(lead.id);
    setActionAlert({
      kind: "ok",
      text:
        label === "correct"
          ? "Đã ghi nhận phản hồi «Đúng» làm ví dụ chuẩn cho AI."
          : opts?.blockAuthor
            ? "Đã ẩn tin người cùng nghề và thêm tác giả vào Danh sách chặn."
            : `Đã ghi nhận phản hồi (${label}).`,
    });
    onUpdated();
  };

  const handleOpenFacebook = () => {
    const res = openFacebookPermalink(lead.permalink);
    if (!res.opened && res.error) {
      setActionAlert({ kind: "err", text: res.error });
    }
  };

  const handleBlockAuthorDirect = async () => {
    await api.blocklistAdd(
      "author",
      lead.author_id ?? lead.author_name,
      `Chặn trực tiếp từ tin ${lead.id}`
    );
    await api.leadSetStatus(lead.id, "ignored");
    await loadDetail(lead.id);
    setActionAlert({ kind: "ok", text: `Đã chặn tác giả «${lead.author_name}».` });
    onUpdated();
  };

  const handleSaveCrmNotes = async () => {
    const tags = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const followUpMs = followUpInput ? new Date(followUpInput).getTime() : null;
    const updated = await api.leadSetStatus(lead.id, lead.status, {
      note: noteInput,
      tags,
      follow_up_at: Number.isFinite(followUpMs) ? followUpMs : null,
    });
    setDetail(updated);
    setActionAlert({ kind: "ok", text: "Đã lưu ghi chú CRM, nhãn và lịch nhắc." });
    onUpdated();
  };

  const permalinkSafe = isSafeFacebookPermalink(lead.permalink);

  return (
    <div>
      {/* Header (`03-ux-flows.md §3.1`) */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="badge badge-primary">{lead.radar_name}</span>
            <span className={`badge ${lead.is_weak_match ? "badge-warning" : "badge-success"}`}>
              Điểm khớp {(lead.score * 100).toFixed(0)}%
              {lead.is_weak_match ? " · Khớp yếu" : ""}
            </span>
            <span className="badge">{LEAD_STATUS_LABELS[lead.status]}</span>
          </div>
          <h3 style={{ margin: "8px 0 4px", fontSize: 15.5 }}>{lead.summary}</h3>
          <div className="field-hint">
            Group: <strong>{lead.source_name}</strong> · Tác giả:{" "}
            <strong>{lead.author_name}</strong> · Đăng{" "}
            <span title={formatExactTime(lead.post_created_at)}>
              {formatRelativeTime(lead.post_created_at)} ({formatExactTime(lead.post_created_at)})
            </span>
          </div>
        </div>
        {onClose && (
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Đóng ✕
          </button>
        )}
      </div>

      {actionAlert && (
        <div
          role="alert"
          className={`health-banner ${actionAlert.kind === "err" ? "danger" : "info"}`}
          style={{ borderRadius: 6, marginBottom: 10 }}
        >
          <span>{actionAlert.text}</span>
        </div>
      )}

      {/* Action Bar (`03-ux-flows.md §3.1`) */}
      <div
        className="toolbar-row"
        style={{
          padding: "10px 12px",
          background: "var(--bg-subtle)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          position: "relative",
        }}
      >
        <button
          type="button"
          className={`btn btn-sm ${permalinkSafe ? "btn-primary" : "btn-danger"}`}
          onClick={handleOpenFacebook}
          title={
            permalinkSafe
              ? lead.permalink
              : "Cảnh báo: liên kết không thuộc tên miền Facebook hợp lệ"
          }
        >
          Mở trên Facebook ↗
        </button>

        <button
          type="button"
          className={`btn btn-sm ${lead.feedback_label === "correct" ? "btn-success" : ""}`}
          onClick={() => void handleFeedback("correct")}
        >
          ✅ Đúng
        </button>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setWrongMenuOpen((v) => !v)}
          >
            ❌ Sai ▾
          </button>
          {wrongMenuOpen && (
            <div
              className="card"
              style={{
                position: "absolute",
                top: "110%",
                left: 0,
                zIndex: 30,
                minWidth: 230,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: 8,
              }}
            >
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => void handleFeedback("irrelevant")}
              >
                Không liên quan
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => {
                  setWrongMenuOpen(false);
                  const init: Record<string, string> = {};
                  for (const fd of radar_fields) {
                    init[fd.key] = formatExtractedFieldValue(fd, lead.fields[fd.key]);
                    if (init[fd.key] === "—") init[fd.key] = "";
                  }
                  setBatchFieldDrafts(init);
                  setBatchFieldEditOpen(true);
                }}
              >
                Trích sai trường (sửa lại)…
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => {
                  setWrongMenuOpen(false);
                  setPeerPromptOpen(true);
                }}
              >
                Người cùng nghề…
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => void handleFeedback("duplicate")}
              >
                Trùng bài đã có
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => void handleFeedback("spam")}
              >
                Rác / Quảng cáo
              </button>
            </div>
          )}
        </div>

        <button type="button" className="btn btn-sm" onClick={handleBlockAuthorDirect}>
          🚫 Chặn tác giả
        </button>

        <select
          aria-label="Đổi trạng thái tin"
          className="select"
          style={{ width: 165, padding: "4px 8px", fontSize: 12 }}
          value={lead.status}
          onChange={async (e) => {
            const nextStatus = e.target.value as LeadStatus;
            const updated = await api.leadSetStatus(lead.id, nextStatus);
            setDetail(updated);
            onUpdated();
          }}
        >
          {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).map((st) => (
            <option key={st} value={st}>
              Trạng thái: {LEAD_STATUS_LABELS[st]}
            </option>
          ))}
        </select>
      </div>

      {/* Prompt when marking "Người cùng nghề" (`01-prd.md US-4`, `02-radar-spec.md §6`) */}
      {peerPromptOpen && (
        <div
          className="card"
          style={{ background: "#fffbeb", borderColor: "#fde68a", marginBottom: 12 }}
        >
          <strong>Đánh dấu «Người cùng nghề» — Chặn luôn tác giả «{lead.author_name}»?</strong>
          <div className="field-hint" style={{ margin: "4px 0 8px" }}>
            Nếu chặn, mọi bài đăng sau này của tác giả này sẽ bị loại ngay ở tầng lọc sơ bộ mà không
            tốn lượt gọi AI.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void handleFeedback("peer", { blockAuthor: true })}
            >
              Chặn luôn tác giả này
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handleFeedback("peer", { blockAuthor: false })}
            >
              Chỉ ẩn tin này, không chặn
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPeerPromptOpen(false)}
            >
              Huỷ
            </button>
          </div>
        </div>
      )}

      {/* Form when marking "Trích sai trường" (`02-radar-spec.md §6`) */}
      {batchFieldEditOpen && (
        <div className="card" style={{ marginBottom: 12, background: "#eff6ff" }}>
          <strong>Sửa lại giá trị đúng cho các trường bị trích sai:</strong>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 8,
              marginTop: 8,
            }}
          >
            {radar_fields.map((fd) => (
              <div key={fd.key}>
                <label className="field-hint">{fd.label}</label>
                <input
                  type="text"
                  aria-label={`Sửa trường ${fd.label}`}
                  className="input"
                  value={batchFieldDrafts[fd.key] ?? ""}
                  onChange={(e) =>
                    setBatchFieldDrafts((prev) => ({ ...prev, [fd.key]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                const corrected: Record<string, unknown> = {};
                for (const fd of radar_fields) {
                  if (batchFieldDrafts[fd.key]?.trim()) {
                    corrected[fd.key] = parseEditedValue(fd, batchFieldDrafts[fd.key]!);
                  }
                }
                setBatchFieldEditOpen(false);
                void handleFeedback("wrong_fields", { corrected });
              }}
            >
              Lưu giá trị đúng & Gửi phản hồi
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setBatchFieldEditOpen(false)}
            >
              Huỷ
            </button>
          </div>
        </div>
      )}

      {/* Extracted Fields Block — Click-to-edit (`03-ux-flows.md §3.1`) */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <strong>Các trường đã trích xuất</strong>
          <span className="field-hint">Bấm vào giá trị bất kỳ để sửa tay (`source: user`)</span>
        </div>

        <table className="crm-table">
          <tbody>
            {radar_fields.map((fd) => {
              const ef = lead.fields[fd.key];
              const isEditing = editingFieldKey === fd.key;
              return (
                <tr key={fd.key}>
                  <td style={{ width: 160, fontWeight: 600 }}>{fd.label}</td>
                  <td>
                    {isEditing ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="text"
                          aria-label={`Giá trị mới cho ${fd.label}`}
                          className="input"
                          value={editingFieldVal}
                          onChange={(e) => setEditingFieldVal(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => void handleSaveInlineField(fd)}
                        >
                          Lưu
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditingFieldKey(null)}
                        >
                          Huỷ
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        style={{
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          cursor: "pointer",
                          textAlign: "left",
                          fontWeight: 500,
                        }}
                        title="Bấm để sửa tay trường này"
                        onClick={() => {
                          setEditingFieldKey(fd.key);
                          const cur = formatExtractedFieldValue(fd, ef);
                          setEditingFieldVal(cur === "—" ? "" : cur);
                        }}
                      >
                        {formatExtractedFieldValue(fd, ef)} ✎
                      </button>
                    )}
                  </td>
                  <td style={{ width: 180 }}>
                    {ef ? (
                      <span
                        className={`badge ${
                          ef.source === "user"
                            ? "badge-primary"
                            : ef.source === "rule"
                              ? "badge-success"
                              : ""
                        }`}
                      >
                        {ef.source === "user"
                          ? "Sửa tay (user)"
                          : ef.source === "rule"
                            ? "Bộ luật"
                            : "AI"}
                        {ef.raw ? ` · "${ef.raw}"` : ""}
                      </span>
                    ) : (
                      <span className="field-hint">Chưa có</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Original Post Text with plain-text `raw` highlights (`03-risks-compliance.md §4`) */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
          <strong style={{ fontSize: 13 }}>Nội dung bài viết gốc (văn bản thuần an toàn)</strong>
          <span className="field-hint">Đoạn tô vàng là bằng chứng `raw` trích nguyên văn</span>
        </div>
        <div className="post-plain-text" data-testid="lead-post-plaintext">
          {renderHighlightedPostText(post.text, rawSpans)}
        </div>
      </div>

      {/* Also Seen In (`03-ux-flows.md §3.1`, `01-prd.md US-3`) */}
      {lead.also_seen_in.length > 0 && (
        <div className="card" style={{ marginBottom: 12, background: "var(--bg-subtle)" }}>
          <strong>🔁 Cũng xuất hiện ở {lead.also_seen_in.length} group khác:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {lead.also_seen_in.map((dup) => (
              <li key={`${dup.source_id}-${dup.captured_at}`}>
                {dup.source_name} ({formatRelativeTime(dup.captured_at)})
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* CRM Notes, Tags & Follow-up Reminder */}
      <div className="card" style={{ marginBottom: 12 }}>
        <strong style={{ display: "block", marginBottom: 8 }}>Ghi chú CRM, Nhãn & Nhắc việc</strong>
        <div className="field-group">
          <textarea
            className="textarea"
            style={{ minHeight: 60 }}
            placeholder="Ghi chú trao đổi với khách (chỉ lưu trên máy bạn)…"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 220px auto", gap: 8, alignItems: "end" }}>
          <div>
            <label className="field-hint">Nhãn (cách nhau dấu phẩy)</label>
            <input
              type="text"
              className="input"
              placeholder="khách nét, gọi chiều nay"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>
          <div>
            <label className="field-hint">Nhắc liên hệ lại</label>
            <input
              type="datetime-local"
              className="input"
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={handleSaveCrmNotes}>
            Lưu ghi chú
          </button>
        </div>
      </div>

      {/* Provenance Footer (`03-ux-flows.md §3.1`) */}
      <div className="field-hint" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        Nguồn gốc đánh giá:{" "}
        <strong>{lead.decided_by === "rule" ? "Bộ luật tự động (Ruleset)" : "Mô hình AI"}</strong> ·
        Phiên bản Radar: <strong>v{lead.radar_version}</strong>
        {lead.reason ? ` · Giải thích: ${lead.reason}` : ""}
        {lead.notified_at ? ` · Đã báo Telegram lúc ${formatExactTime(lead.notified_at)}` : ""}
      </div>
    </div>
  );
};
