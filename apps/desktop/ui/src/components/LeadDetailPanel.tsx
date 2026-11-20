import React, { useEffect, useRef, useState } from "react";
import { FieldValueInput } from "./FieldValueInput";
import { localDateTime, parseFieldValue, editFieldText } from "../lib/fieldValues";
import { readWorkspace, saveWorkspace } from "../lib/workspace";
import { useHotkeys } from "../lib/hotkeys";
import { offerUndo } from "./UndoCenter";
import { api } from "../lib/api";
import {
  domesticPhoneDigits,
  formatDomesticPhone,
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
import type { FeedbackLabel, FieldDef, LeadDetail, LeadStatus, PosterActivity } from "../types/ipc";
import { Button, Input, Select, Textarea } from "./ui";
import { AgeChip } from "./AgeChip";

/**
 * "Who is this person?" from the same behaviour signals the pipeline uses to spot peers
 * (crates/store/src/posts/peers.rs): heavy posting, the same text in many groups, a phone
 * number shared by several accounts. Lets the user tell a first-time customer from a broker.
 */
function PosterNote({ poster }: { poster: PosterActivity }) {
  const facts: string[] = [];
  if (poster.posts_7d <= 1) facts.push("Lần đầu thấy người này trong 7 ngày qua");
  else facts.push(`${poster.posts_7d} bài trong 7 ngày, ở ${poster.groups_7d} group`);
  if (poster.same_post_groups > 1) facts.push(`bài này đăng ở ${poster.same_post_groups} group`);
  if (poster.phone_shared_by_authors > 1)
    facts.push(`SĐT dùng chung với ${poster.phone_shared_by_authors} tài khoản`);
  const suspicious =
    poster.looks_like_peer ||
    poster.posts_7d >= 5 ||
    poster.same_post_groups >= 4 ||
    poster.phone_shared_by_authors >= 3;
  return (
    <p className={`poster-note${suspicious ? " warn" : ""}`} aria-label="Lịch sử người đăng">
      {poster.looks_like_peer && <strong>Có vẻ là người cùng nghề. </strong>}
      {facts.join(" · ")}
    </p>
  );
}

interface LeadDetailPanelProps {
  leadId: string;
  onUpdated: () => void;
  closeLabel?: string;
  onClose?: () => void;
  /** Called after a decision that finishes this lead, so the queue can move to the next one. */
  onAdvance?: (message: string) => void;
  /** Enables single-letter shortcuts. Only the main triage queue turns this on. */
  hotkeys?: boolean;
}

const WRONG_REASONS: Array<{ key: string; label: string; feedback?: FeedbackLabel; kind?: "fields" | "peer" }> = [
  { key: "1", label: "Không liên quan", feedback: "irrelevant" },
  { key: "2", label: "Trích sai trường (sửa lại)…", kind: "fields" },
  { key: "3", label: "Người cùng nghề…", kind: "peer" },
  { key: "4", label: "Trùng bài đã có", feedback: "duplicate" },
  { key: "5", label: "Rác / Quảng cáo", feedback: "spam" },
];

const EVENT_LABELS: Record<string, string> = {
  created: "Tạo cơ hội",
  status_changed: "Đổi trạng thái",
  field_edited: "Sửa thông tin",
  notified: "Gửi thông báo",
  noted: "Lưu ghi chú / lịch",
  feedback: "Ghi nhận phản hồi",
  follow_up_due: "Đã phát nhắc liên hệ",
};

function followUpPresets(now = new Date()): Array<{ label: string; at: number }> {
  const presets = [{ label: "1 giờ nữa", at: now.getTime() + 3600000 }];
  const evening = new Date(now);
  evening.setHours(17, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 3600000) presets.push({ label: "17:00 hôm nay", at: evening.getTime() });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({ label: "9:00 sáng mai", at: tomorrow.getTime() });
  return presets;
}

const Kbd: React.FC<{ k: string }> = ({ k }) => <kbd className="kbd" aria-hidden="true">{k}</kbd>;

export const LeadDetailPanel: React.FC<LeadDetailPanelProps> = ({
  leadId,
  onUpdated,
  onClose,
  closeLabel = "Đóng",
  onAdvance,
  hotkeys = false,
}) => {
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [editingFieldVal, setEditingFieldVal] = useState<string>("");

  const [wrongMenuOpen, setWrongMenuOpen] = useState(false);
  const [peerPromptOpen, setPeerPromptOpen] = useState(false);
  const [batchFieldEditOpen, setBatchFieldEditOpen] = useState(false);
  const [batchFieldDrafts, setBatchFieldDrafts] = useState<Record<string, string>>({});

  const [notesOpen, setNotesOpen] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [actionAlert, setActionAlert] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const requestRef = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadDetail = async (id: string) => {
    const request = ++requestRef.current;
    setLoadError(null);
    setLoading(true);
    try {
      let res = await api.leadGet(id);
      if (!res.lead.read_at) res = await api.leadMarkRead(id);
      if (request !== requestRef.current) return;
      setDetail(res);
      const saved = readWorkspace<{ note: string; tags: string; follow: string } | null>(`lead-${id}`, null);
      setNoteInput(saved?.note ?? res.lead.note ?? "");
      setTagsInput(saved?.tags ?? res.lead.tags.join(", "));
      setFollowUpInput(saved?.follow ?? localDateTime(res.lead.follow_up_at));
      setNotesOpen((open) => open || Boolean(saved || res.lead.note || res.lead.follow_up_at));
    } catch (err) {
      if (request === requestRef.current) setLoadError(String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    setActionAlert(null);
    void loadDetail(leadId);
    return () => {
      requestRef.current++;
    };
  }, [leadId]);

  const lead = detail?.lead;
  const radarFields = detail?.radar_fields ?? [];
  const phones = lead
    ? radarFields
        .filter((fd) => fd.type === "phone")
        .map((fd) => lead.fields[fd.key]?.value)
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];

  const safely = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setActionAlert({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  /** Finishes a decision: in the triage queue move on, elsewhere refresh in place. */
  const finish = async (message: string) => {
    onUpdated();
    if (onAdvance) {
      onAdvance(message);
      return;
    }
    await loadDetail(leadId);
    setActionAlert({ kind: "ok", text: message });
  };

  const handleFeedback = async (
    label: FeedbackLabel,
    opts?: { blockAuthor?: boolean; corrected?: Record<string, unknown> }
  ) => {
    if (!lead) return;
    setWrongMenuOpen(false);
    setPeerPromptOpen(false);
    const previousBlocks = new Set((await api.blocklistList()).map((b) => b.id));
    const feedback = await api.leadFeedback({
      evaluation_id: lead.evaluation_id,
      lead_id: lead.id,
      post_id: lead.post_id,
      radar_version_id: lead.radar_version_id,
      label,
      block_author: opts?.blockAuthor ?? false,
      corrected_fields: opts?.corrected ?? null,
      origin: "app",
    });
    if (feedback.blocked_entry && !previousBlocks.has(feedback.blocked_entry.id)) {
      const id = feedback.blocked_entry.id;
      offerUndo(`Đã chặn ${lead.author_name}`, async () => {
        await api.blocklistRemove(id);
        onUpdated();
      });
    }
    // Correcting fields keeps the lead open: the user is still working on it.
    if (label === "wrong_fields") {
      await loadDetail(lead.id);
      setActionAlert({ kind: "ok", text: "Đã lưu giá trị đúng. Radar sẽ học từ lần sửa này." });
      onUpdated();
      return;
    }
    await finish(
      label === "correct"
        ? "Đã ghi nhận «Đúng». Radar sẽ dùng tin này làm ví dụ tốt."
        : opts?.blockAuthor
          ? "Đã ẩn tin và chặn tác giả."
          : "Đã ghi nhận «Sai». Radar sẽ học từ phản hồi này."
    );
  };

  const setStatus = async (next: LeadStatus, opts: { advance: boolean; message: string }) => {
    if (!lead) return;
    const previous = lead.status;
    const updated = await api.leadSetStatus(lead.id, next);
    offerUndo(opts.message, async () => {
      await api.leadSetStatus(lead.id, previous);
      onUpdated();
    });
    if (opts.advance) {
      await finish(opts.message);
      return;
    }
    setDetail(updated);
    onUpdated();
  };

  const markContacted = () =>
    safely(async () => {
      await setStatus("contacted", { advance: false, message: `Đã liên hệ: ${lead?.summary ?? ""}` });
      setNotesOpen(true);
      setActionAlert({ kind: "ok", text: "Đã chuyển sang «Đã liên hệ». Ghi lại nội dung trao đổi hoặc hẹn lần gọi tiếp bên dưới." });
      requestAnimationFrame(() => noteRef.current?.focus());
    });

  const skipLead = () =>
    safely(() => setStatus("ignored", { advance: true, message: `Đã bỏ qua: ${lead?.summary ?? ""}` }));

  const handleOpenFacebook = () => {
    if (!lead) return;
    const res = openFacebookPermalink(lead.permalink);
    if (!res.opened && res.error) setActionAlert({ kind: "err", text: res.error });
  };

  const copyPhone = async (phone: string) => {
    const digits = domesticPhoneDigits(phone);
    try {
      await navigator.clipboard.writeText(digits);
      setActionAlert({ kind: "ok", text: `Đã chép số ${formatDomesticPhone(phone)}.` });
    } catch {
      setActionAlert({ kind: "err", text: "Không chép được tự động. Hãy bôi đen số điện thoại và chép tay." });
    }
  };

  const chooseWrongReason = (reason: (typeof WRONG_REASONS)[number]) => {
    if (!lead) return;
    setWrongMenuOpen(false);
    if (reason.kind === "peer") {
      setPeerPromptOpen(true);
      return;
    }
    if (reason.kind === "fields") {
      const init: Record<string, string> = {};
      for (const fd of radarFields) {
        init[fd.key] = editFieldText(fd, lead.fields[fd.key]);
        if (init[fd.key] === "—") init[fd.key] = "";
      }
      setBatchFieldDrafts(init);
      setBatchFieldEditOpen(true);
      return;
    }
    void safely(() => handleFeedback(reason.feedback!));
  };

  const keys: Record<string, () => void> = {};
  if (lead && !busy) {
    if (wrongMenuOpen) {
      for (const r of WRONG_REASONS) keys[r.key] = () => chooseWrongReason(r);
      keys.Escape = () => setWrongMenuOpen(false);
      keys.s = () => setWrongMenuOpen(false);
    } else if (!peerPromptOpen && !batchFieldEditOpen) {
      keys.d = () => void safely(() => handleFeedback("correct"));
      keys.s = () => setWrongMenuOpen(true);
      keys.b = skipLead;
      keys.l = markContacted;
      keys.o = handleOpenFacebook;
      if (phones[0]) keys.c = () => void copyPhone(phones[0]!);
      keys.n = () => {
        setNotesOpen(true);
        requestAnimationFrame(() => noteRef.current?.focus());
      };
    }
  }
  useHotkeys(hotkeys, keys);

  if (loadError)
    return (
      <div role="alert">
        {loadError}
        <Button onClick={() => void loadDetail(leadId)}>Thử lại</Button>
      </div>
    );
  if (loading || !detail || !lead) {
    return <div className="text-muted">Đang tải chi tiết tin…</div>;
  }

  const { post } = detail;
  const rawSpans = radarFields
    .map((fd) => {
      const ef = lead.fields[fd.key];
      return ef?.raw ? { raw: ef.raw, fieldLabel: fd.label } : null;
    })
    .filter((x): x is { raw: string; fieldLabel: string } => Boolean(x));

  const parseEditedValue = (fd: FieldDef, text: string): unknown =>
    parseFieldValue(fd, text, lead.fields[fd.key]?.value);

  const handleSaveInlineField = async (fd: FieldDef) => {
    const updated = await api.leadUpdateField(lead.id, fd.key, parseEditedValue(fd, editingFieldVal));
    setDetail(updated);
    setEditingFieldKey(null);
    setActionAlert({ kind: "ok", text: `Đã lưu giá trị sửa tay cho trường «${fd.label}».` });
    onUpdated();
  };

  const handleBlockAuthorDirect = async () => {
    const before = new Set((await api.blocklistList()).map((b) => b.id));
    const added = await api.blocklistAdd("author", lead.author_id ?? lead.author_name, `Chặn trực tiếp từ tin ${lead.id}`);
    await api.leadSetStatus(lead.id, "ignored");
    offerUndo(`Đã chặn ${lead.author_name}`, async () => {
      if (!before.has(added.id)) await api.blocklistRemove(added.id);
      const current = await api.leadGet(lead.id);
      if (current.lead.status === "ignored") await api.leadSetStatus(lead.id, lead.status);
      onUpdated();
    });
    await finish(`Đã chặn tác giả «${lead.author_name}».`);
  };

  const saveCrm = async (followOverride?: number | null) => {
    const tags = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const typed = followUpInput ? new Date(followUpInput).getTime() : null;
    const followUpMs = followOverride !== undefined ? followOverride : typed;
    const updated = await api.leadSetStatus(lead.id, lead.status, {
      note: noteInput,
      tags,
      follow_up_at: followUpMs != null && Number.isFinite(followUpMs) ? followUpMs : null,
    });
    saveWorkspace(`lead-${lead.id}`, null);
    setDetail(updated);
    setFollowUpInput(localDateTime(updated.lead.follow_up_at));
    setActionAlert({
      kind: "ok",
      text: updated.lead.follow_up_at
        ? `Đã lưu. Nhắc liên hệ lúc ${formatExactTime(updated.lead.follow_up_at)}, xem lịch trong «Hẹn hôm nay» hoặc «Hẹn sắp tới».`
        : "Đã lưu ghi chú.",
    });
    onUpdated();
  };

  const draft = (patch: Partial<{ note: string; tags: string; follow: string }>) =>
    saveWorkspace(`lead-${lead.id}`, { note: noteInput, tags: tagsInput, follow: followUpInput, ...patch });

  const permalinkSafe = isSafeFacebookPermalink(lead.permalink);
  const postedAt = lead.post_created_at ?? lead.created_at;
  const isOpenStatus = lead.status === "new" || lead.status === "viewed";

  return (
    <div className="lead-detail-content">
      <header className="lead-head">
        <div className="lead-head-meta">
          <AgeChip postedAt={postedAt} expiresAt={lead.expires_at} />
          <span className="lead-head-radar">{lead.radar_name}</span>
          <span className="lead-head-score">
            Khớp {(lead.score * 100).toFixed(0)}%{lead.is_weak_match ? " · cần xem thêm" : ""}
          </span>
          {!isOpenStatus && <span className={`status-pill status-${lead.status}`}>{LEAD_STATUS_LABELS[lead.status]}</span>}
          {lead.feedback_label === "correct" && <span className="status-pill status-won">Bạn đã đánh Đúng</span>}
          {onClose && (
            <Button size="sm" className="lead-head-close" onClick={onClose}>
              {closeLabel}
            </Button>
          )}
        </div>
        <h2 className="lead-detail-title">{lead.summary}</h2>
        <p className="lead-byline">
          <span>{lead.author_name}</span>
          <span>{lead.source_name}</span>
          <span title={formatExactTime(postedAt)}>{formatRelativeTime(postedAt)}</span>
        </p>
      </header>

      {actionAlert && (
        <div role="alert" className={`lead-alert ${actionAlert.kind}`}>
          {actionAlert.text}
        </div>
      )}

      <section className="contact-card" aria-label="Liên hệ">
        {phones.length > 0 ? (
          phones.map((phone, i) => (
            <div className="contact-phone" key={phone}>
              <span className="phone-number">{formatDomesticPhone(phone)}</span>
              <Button size="sm" onClick={() => void copyPhone(phone)}>
                Chép số {i === 0 && <Kbd k="C" />}
              </Button>
            </div>
          ))
        ) : (
          <p className="contact-none">Bài không ghi số điện thoại. Liên hệ qua bình luận hoặc nhắn tin trên Facebook.</p>
        )}
        <div className="contact-actions">
          <Button
            variant={permalinkSafe ? (phones.length ? "default" : "primary") : "danger"}
            size="sm"
            onClick={handleOpenFacebook}
            title={permalinkSafe ? lead.permalink : "Cảnh báo: liên kết không thuộc tên miền Facebook hợp lệ"}
          >
            Mở trên Facebook <Kbd k="O" />
          </Button>
          {lead.also_seen_in.length > 0 && (
            <span className="field-hint" title={lead.also_seen_in.map((d) => d.source_name).join(", ")}>
              Cũng đăng ở {lead.also_seen_in.length} group khác
            </span>
          )}
        </div>
        {detail?.poster && <PosterNote poster={detail.poster} />}
      </section>

      {peerPromptOpen && (
        <div className="inline-prompt warning">
          <strong>Đánh dấu «Người cùng nghề»: Chặn luôn tác giả «{lead.author_name}»?</strong>
          <p className="field-hint">Nếu chặn, mọi bài sau này của tác giả này bị loại ngay mà không tốn lượt gọi AI.</p>
          <div className="inline-prompt-actions">
            <Button variant="danger" size="sm" onClick={() => void safely(() => handleFeedback("peer", { blockAuthor: true }))}>
              Chặn luôn tác giả này
            </Button>
            <Button size="sm" onClick={() => void safely(() => handleFeedback("peer", { blockAuthor: false }))}>
              Chỉ ẩn tin này, không chặn
            </Button>
            <Button size="sm" onClick={() => setPeerPromptOpen(false)}>
              Huỷ
            </Button>
          </div>
        </div>
      )}

      {batchFieldEditOpen && (
        <div className="inline-prompt">
          <strong>Sửa lại giá trị đúng cho các trường bị trích sai:</strong>
          <div className="batch-field-grid">
            {radarFields.map((fd) => (
              <div key={fd.key}>
                <label className="field-hint">{fd.label}</label>
                <FieldValueInput
                  field={fd}
                  label={`Sửa trường ${fd.label}`}
                  value={batchFieldDrafts[fd.key] ?? ""}
                  previous={lead.fields[fd.key]?.value}
                  onChange={(v) => setBatchFieldDrafts((prev) => ({ ...prev, [fd.key]: v }))}
                />
              </div>
            ))}
          </div>
          <div className="inline-prompt-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                void safely(async () => {
                  const corrected: Record<string, unknown> = {};
                  for (const fd of radarFields) {
                    if (batchFieldDrafts[fd.key] !== editFieldText(fd, lead.fields[fd.key])) {
                      corrected[fd.key] = parseEditedValue(fd, batchFieldDrafts[fd.key]!);
                    }
                  }
                  setBatchFieldEditOpen(false);
                  await handleFeedback("wrong_fields", { corrected });
                })
              }
            >
              Lưu giá trị đúng & Gửi phản hồi
            </Button>
            <Button size="sm" onClick={() => setBatchFieldEditOpen(false)}>
              Huỷ
            </Button>
          </div>
        </div>
      )}

      <section aria-label="Thông tin đã trích">
        <dl className="lead-fields">
          {radarFields.map((fd) => {
            const ef = lead.fields[fd.key];
            const isEditing = editingFieldKey === fd.key;
            const origin = ef
              ? `${ef.source === "user" ? "Bạn đã sửa" : ef.source === "rule" ? "Bộ luật" : "AI"}${ef.raw ? ` · trích từ "${ef.raw}"` : ""}`
              : "Chưa có";
            return (
              <div key={fd.key} className={`lead-field ${ef ? "" : "empty"}`}>
                <dt>{fd.label}</dt>
                <dd>
                  {isEditing ? (
                    <div className="lead-field-edit">
                      <FieldValueInput
                        field={fd}
                        label={`Giá trị mới cho ${fd.label}`}
                        value={editingFieldVal}
                        previous={ef?.value}
                        onChange={setEditingFieldVal}
                      />
                      <Button variant="primary" size="sm" onClick={() => void safely(() => handleSaveInlineField(fd))}>
                        Lưu
                      </Button>
                      <Button size="sm" onClick={() => setEditingFieldKey(null)}>
                        Huỷ
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="lead-field-value"
                      title="Bấm để sửa tay trường này"
                      onClick={() => {
                        setEditingFieldKey(fd.key);
                        const cur = editFieldText(fd, ef);
                        setEditingFieldVal(cur === "—" ? "" : cur);
                      }}
                    >
                      <span>{formatExtractedFieldValue(fd, ef)}</span>
                      {ef?.source === "user" ? (
                        <span className="field-origin user">Bạn đã sửa</span>
                      ) : (
                        <span className="field-origin" aria-label={origin} title={origin}>
                          ✎
                        </span>
                      )}
                    </button>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="lead-post" aria-label="Bài viết gốc">
        <div className="lead-post-head">
          <strong>Bài viết gốc</strong>
          {rawSpans.length > 0 && <span className="field-hint">Đoạn tô sáng là thông tin đã trích</span>}
        </div>
        <div className="post-plain-text" data-testid="lead-post-plaintext">
          {renderHighlightedPostText(post.text, rawSpans)}
        </div>
      </section>

      <details className="lead-fold" open={notesOpen} onToggle={(e) => setNotesOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          Ghi chú & hẹn lại
          {lead.follow_up_at ? <span className="fold-meta">Hẹn {formatExactTime(lead.follow_up_at)}</span> : lead.note ? <span className="fold-meta">Có ghi chú</span> : <Kbd k="N" />}
        </summary>
        <div className="lead-fold-body">
          <Textarea
            ref={noteRef}
            aria-label="Ghi chú trao đổi"
            placeholder="Nội dung đã trao đổi với khách (chỉ lưu trên máy bạn)…"
            value={noteInput}
            onChange={(e) => {
              setNoteInput(e.target.value);
              draft({ note: e.target.value });
            }}
          />
          <div className="follow-presets" role="group" aria-label="Hẹn gọi lại nhanh">
            <span className="field-hint">Hẹn gọi lại:</span>
            {followUpPresets().map((p) => (
              <Button key={p.label} size="sm" onClick={() => void safely(() => saveCrm(p.at))}>
                {p.label}
              </Button>
            ))}
            {lead.follow_up_at && (
              <Button size="sm" onClick={() => void safely(() => saveCrm(null))}>
                Xong, bỏ lịch hẹn
              </Button>
            )}
          </div>
          <div className="crm-grid">
            <label>
              <span className="field-hint">Nhãn (cách nhau dấu phẩy)</span>
              <Input
                type="text"
                placeholder="khách nét, gọi chiều nay"
                aria-label="Nhãn cơ hội"
                value={tagsInput}
                onChange={(e) => {
                  setTagsInput(e.target.value);
                  draft({ tags: e.target.value });
                }}
              />
            </label>
            <label>
              <span className="field-hint">Hoặc chọn giờ cụ thể</span>
              <Input
                type="datetime-local"
                aria-label="Nhắc liên hệ lại"
                value={followUpInput}
                onChange={(e) => {
                  setFollowUpInput(e.target.value);
                  draft({ follow: e.target.value });
                }}
              />
            </label>
            <Button variant="primary" onClick={() => void safely(() => saveCrm())}>
              Lưu ghi chú
            </Button>
          </div>
        </div>
      </details>

      <details className="lead-fold">
        <summary>Chi tiết & thao tác khác</summary>
        <div className="lead-fold-body">
          <p className="field-hint">
            Đánh giá bởi <strong>{lead.decided_by === "rule" ? "bộ luật tự động" : "AI"}</strong> · radar phiên bản{" "}
            <strong>v{lead.radar_version}</strong>
            {lead.reason ? ` · Lý do: ${lead.reason}` : ""}
            {lead.notified_at ? ` · Đã gửi thông báo lúc ${formatExactTime(lead.notified_at)}` : ""}
          </p>
          {lead.also_seen_in.length > 0 && (
            <ul className="also-seen">
              {lead.also_seen_in.map((dup) => (
                <li key={`${dup.source_id}-${dup.captured_at}`}>
                  Cũng ở {dup.source_name} ({formatRelativeTime(dup.captured_at)})
                </li>
              ))}
            </ul>
          )}
          <div className="activity-history">
            {detail.events
              .slice()
              .reverse()
              .map((ev) => (
                <div key={ev.id} className="activity-row">
                  <time>{formatExactTime(ev.created_at)}</time> · {EVENT_LABELS[ev.kind] ?? ev.kind}
                </div>
              ))}
          </div>
          <div className="inline-prompt-actions">
            <Button size="sm" onClick={() => void safely(handleBlockAuthorDirect)}>
              Chặn tác giả ở mọi radar
            </Button>
            <Select
              aria-label="Đổi trạng thái tin"
              value={lead.status}
              onChange={(e) => {
                const next = e.target.value as LeadStatus;
                void safely(async () => {
                  const updated = await api.leadSetStatus(lead.id, next);
                  setDetail(updated);
                  onUpdated();
                });
              }}
            >
              {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[])
                .filter((st) => st !== "viewed")
                .map((st) => (
                  <option key={st} value={st}>
                    Trạng thái: {LEAD_STATUS_LABELS[st]}
                  </option>
                ))}
            </Select>
          </div>
        </div>
      </details>

      <div className="triage-bar" role="toolbar" aria-label="Quyết định cho tin này">
        <Button
          variant={lead.feedback_label === "correct" ? "success" : "default"}
          disabled={busy}
          onClick={() => void safely(() => handleFeedback("correct"))}
        >
          Đúng <Kbd k="D" />
        </Button>
        <div className="wrong-menu">
          <Button disabled={busy} aria-expanded={wrongMenuOpen} onClick={() => setWrongMenuOpen((v) => !v)}>
            Sai <Kbd k="S" /> ▾
          </Button>
          {wrongMenuOpen && (
            <div className="wrong-menu-list" role="menu">
              {WRONG_REASONS.map((r) => (
                <button key={r.key} type="button" role="menuitem" onClick={() => chooseWrongReason(r)}>
                  <span>{r.label}</span>
                  <Kbd k={r.key} />
                </button>
              ))}
            </div>
          )}
        </div>
        <Button disabled={busy} onClick={skipLead}>
          Bỏ qua <Kbd k="B" />
        </Button>
        <Button
          variant={lead.status === "contacted" ? "success" : "primary"}
          disabled={busy}
          className="triage-primary"
          onClick={markContacted}
        >
          Đã liên hệ <Kbd k="L" />
        </Button>
      </div>
    </div>
  );
};
