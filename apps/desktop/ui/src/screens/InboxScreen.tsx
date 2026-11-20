import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../lib/workspace";
import { useHotkeys } from "../lib/hotkeys";
import { api } from "../lib/api";
import { formatExactTime, LEAD_STATUS_LABELS, REJECT_REASON_LABELS } from "../lib/format";
import { AgeChip } from "../components/AgeChip";
import { renderHighlightedPostText } from "../lib/security";
import type {
  Lead,
  LeadFilterQuery,
  Radar,
  RadarTemplate,
  RejectedEvaluation,
} from "../types/ipc";
import { LeadDetailPanel } from "../components/LeadDetailPanel";
import { Badge, Button, Card, Input, Modal, ModalBody, ModalHeader, Select } from "../components/ui";

export type LeadQueue = "new" | "working" | "due" | "overdue" | "upcoming" | "expired" | "done" | "all";

const QUEUES: Array<{ key: LeadQueue; label: string; empty: string }> = [
  { key: "new", label: "Chưa xử lý", empty: "Không còn tin cần xử lý." },
  { key: "working", label: "Đang xử lý", empty: "Chưa có khách nào đang trao đổi. Bấm «Đã liên hệ» sau khi gọi để theo dõi tại đây." },
  { key: "due", label: "Hẹn hôm nay", empty: "Không có lịch gọi lại đến hạn hôm nay." },
  { key: "overdue", label: "Hẹn quá hạn", empty: "Không có lịch hẹn quá hạn." },
  { key: "upcoming", label: "Hẹn sắp tới", empty: "Không có lịch hẹn sau hôm nay." },
  { key: "expired", label: "Tin hết hạn", empty: "Không có tin hết hạn mà chưa xử lý." },
  { key: "done", label: "Đã xong", empty: "Chưa có tin nào được chốt, bỏ qua hoặc đánh sai." },
  { key: "all", label: "Tất cả", empty: "Chưa có tin nào khớp bộ lọc." },
];

function endOfToday(): number {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}


function queueQuery(queue: LeadQueue, now: number): Partial<LeadFilterQuery> {
  switch (queue) {
    case "new":
      // A lead past its radar's lifetime (sold car, departed truck) is noise in the work queue.
      return { status: ["new", "viewed"], expired: false };
    case "expired":
      return { status: ["new", "viewed"], expired: true };
    case "working":
      return { status: ["contacted", "negotiating"] };
    case "due":
      return { follow_up_after: now, follow_up_before: endOfToday(), sort: { by: "follow_up_at", dir: "asc" } };
    case "overdue":
      return { follow_up_before: now - 1, sort: { by: "follow_up_at", dir: "asc" } };
    case "upcoming":
      return { follow_up_after: endOfToday() + 1, sort: { by: "follow_up_at", dir: "asc" } };
    case "done":
      return { status: ["won", "lost", "ignored"] };
    default:
      return {};
  }
}

interface InboxScreenProps {
  radars: Radar[];
  templates: RadarTemplate[];
  refreshToken: number;
  onCreateRadarFromTemplate: (tpl: RadarTemplate | null) => void;
  onLeadChanged: () => void;
}

export const InboxScreen: React.FC<InboxScreenProps> = ({
  radars,
  templates,
  refreshToken,
  onCreateRadarFromTemplate,
  onLeadChanged,
}) => {
  const [queue, setQueue] = useWorkspace<LeadQueue>("opportunity-queue", "new");
  const [selectedRadarId, setSelectedRadarId] = useWorkspace<string>("opportunity-radar", "");
  const [includeWeak, setIncludeWeak] = useWorkspace<boolean>("opportunity-weak", false);
  const [search, setSearch] = useWorkspace<string>("opportunity-search", "");

  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<(string | null)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Partial<Record<LeadQueue, number>>>({});
  const [decisionMessage, setDecisionMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [transitioningPage, setTransitioningPage] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [rejectedOpen, setRejectedOpen] = useState<boolean>(false);
  const [rejectedItems, setRejectedItems] = useState<RejectedEvaluation[]>([]);

  const [compact, setCompact] = useState(() => window.matchMedia?.("(max-width: 960px)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 960px)");
    if (!mq) return;
    const change = () => { setCompact(mq.matches); if (mq.matches) setSelectedLeadId(null); };
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const request = useRef(0);
  const leadsRef = useRef<Lead[]>([]);
  leadsRef.current = leads;
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setCursor(null);
    setPages([]);
    setSelectedLeadId(null);
  }, [queue, selectedRadarId, includeWeak, search]);

  const baseQuery = useCallback(
    (): LeadFilterQuery => ({
      radar_id: selectedRadarId || null,
      include_weak: includeWeak,
      search: search.trim() || null,
    }),
    [selectedRadarId, includeWeak, search]
  );

  const fetchLeads = useCallback(async () => {
    const seq = ++request.current;
    setError(null);
    if (radars.length === 0) {
      setLeads([]);
      setSelectedLeadId(null);
      return;
    }
    setLoading(true);
    try {
      const [res, ...countRes] = await Promise.all([
        api.leadList({
          ...baseQuery(),
          sort: { by: "created_at", dir: "desc" },
          ...queueQuery(queue, now),
          limit: 50,
          cursor,
        }),
        ...(["new", "working", "due", "expired", "overdue", "upcoming"] as LeadQueue[]).map((q) =>
          api.leadList({ ...baseQuery(), ...queueQuery(q, now), limit: 1 })
        ),
      ]);
      if (seq !== request.current) return;
      setNextCursor(res.next_cursor);
      setLeads(res.items);
      setCounts({ new: countRes[0]!.total, working: countRes[1]!.total, due: countRes[2]!.total, expired: countRes[3]!.total, overdue: countRes[4]!.total, upcoming: countRes[5]!.total, [queue]: res.total });
      // Keep the open lead on screen even after a decision moves it out of this queue.
      setSelectedLeadId((prev) => prev ?? (compact ? null : res.items[0]?.id ?? null));
    } catch (err) {
      if (seq === request.current) setError(String(err));
    } finally {
      if (seq === request.current) { setLoading(false); setTransitioningPage(false); }
    }
  }, [radars.length, baseQuery, queue, cursor, compact, now]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads, refreshToken]);

  const select = (id: string | null) => {
    setSelectedLeadId(id);
    if (id && !compact) rowRefs.current.get(id)?.scrollIntoView?.({ block: "nearest" });
  };

  const move = (delta: 1 | -1) => {
    const list = leadsRef.current;
    if (loading || list.length === 0) return;
    const idx = list.findIndex((l) => l.id === selectedLeadId);
    const next = idx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, idx + delta));
    select(list[next]!.id);
  };

  /** After a decision, open the next lead in the queue (or the previous one at the end). */
  const advance = (message: string) => {
    setDecisionMessage(message);
    const list = leadsRef.current;
    const idx = list.findIndex((l) => l.id === selectedLeadId);
    const next = idx < 0 ? list[0] : (list[idx + 1] ?? list[idx - 1]);
    select(next?.id ?? null);
  };

  useHotkeys(true, {
    j: () => move(1),
    k: () => move(-1),
    "/": () => searchRef.current?.focus(),
  });

  const openRejectedModal = async () => {
    setError(null);
    try {
      const ids = selectedRadarId ? [selectedRadarId] : radars.map((r) => r.id);
      const lists = await Promise.all(ids.map((id) => api.evaluationListRejected(id, 100)));
      setRejectedItems(lists.flat().sort((a, b) => b.captured_at - a.captured_at));
      setRejectedOpen(true);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleMarkMissed = async (ev: RejectedEvaluation) => {
    const result = await api.leadFeedback({
      evaluation_id: ev.evaluation_id,
      post_id: ev.post_id,
      radar_version_id: ev.radar_version_id,
      label: "missed",
      origin: "app",
    });
    if (result.updated_lead) {
      setSelectedLeadId(result.updated_lead.id);
      setRejectedOpen(false);
      await fetchLeads();
      onLeadChanged();
    }
    setRejectedItems((prev) =>
      prev.map((x) => (x.evaluation_id === ev.evaluation_id ? { ...x, marked_missed: true } : x))
    );
  };

  if (radars.length === 0) {
    return (
      <div className="opportunity-start">
        <div className="screen-header">
          <div>
            <h1 className="screen-title">Cơ hội: Tạo radar đầu tiên</h1>
            <p className="screen-subtitle">
              Chọn một mẫu theo ngành của bạn. Bạn sẽ thấy radar chấm thử trên bài thật trước khi bật.
            </p>
          </div>
          <Button variant="primary" onClick={() => onCreateRadarFromTemplate(null)}>
            + Bắt đầu từ trang trắng
          </Button>
        </div>
        <div className="template-grid">
          {templates.map((tpl) => (
            <button key={tpl.id} type="button" className="template-card" onClick={() => onCreateRadarFromTemplate(tpl)}>
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <Badge tone="primary">{tpl.industry}</Badge>
                {tpl.seed_ruleset && <Badge tone="success">Chạy được không cần AI</Badge>}
              </div>
              <strong style={{ fontSize: 14 }}>{tpl.name}</strong>
              <span className="field-hint">{tpl.description_template}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const totalEvaluatedPosts = radars
    .filter((r) => !selectedRadarId || r.id === selectedRadarId)
    .reduce((sum, r) => sum + (r.evaluated_posts_total ?? 0), 0);
  const queueInfo = QUEUES.find((q) => q.key === queue)!;
  const filtered = Boolean(selectedRadarId || search.trim() || includeWeak);

  return (
    <div className="opportunity-workspace triage">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Cơ hội</h1>
          <p className="screen-subtitle">Tin mới nhất ở trên. Gọi sớm, quyết định nhanh, radar học từ mỗi lần bạn đánh Đúng hoặc Sai.</p>
        </div>
        <div className="screen-actions">
          <Button onClick={() => void openRejectedModal()}>Xem các bài bị loại gần nhất</Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="health-banner danger">
          {error}
          <Button onClick={() => void fetchLeads()}>Thử lại</Button>
        </div>
      )}

      <div className="triage-toolbar">
        <div className="queue-tabs" role="group" aria-label="Hàng chờ">
          {QUEUES.filter((q) => q.key !== "expired" || queue === "expired" || (counts.expired ?? 0) > 0).map((q) => (
            <button
              key={q.key}
              type="button"
              className={`queue-tab ${queue === q.key ? "active" : ""} ${q.key === "due" && (counts.due ?? 0) > 0 ? "attention" : ""}`}
              aria-pressed={queue === q.key}
              onClick={() => setQueue(q.key)}
            >
              {q.label}
              {counts[q.key] != null && q.key !== "all" && q.key !== "done" && <span className="queue-count">{counts[q.key]}</span>}
            </button>
          ))}
        </div>
        <div className="triage-filters">
          <Select aria-label="Lọc theo radar" value={selectedRadarId} onChange={(e) => setSelectedRadarId(e.target.value)}>
            <option value="">Mọi radar ({radars.length})</option>
            {radars.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Input
            ref={searchRef}
            type="search"
            aria-label="Tìm cơ hội"
            placeholder="Tìm nội dung, ghi chú, tên…  ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="weak-toggle">
            <input type="checkbox" checked={includeWeak} onChange={(e) => setIncludeWeak(e.target.checked)} />
            <span>Gồm tin khớp yếu</span>
          </label>
          {filtered && (
            <Button
              size="sm"
              onClick={() => {
                setSelectedRadarId("");
                setSearch("");
                setIncludeWeak(false);
              }}
            >
              Xoá lọc
            </Button>
          )}
        </div>
      </div>

      {!loading && leads.length === 0 && !selectedLeadId ? (
        <div className="opportunity-empty">
          <h3 style={{ marginTop: 0 }}>{queueInfo.empty}</h3>
          {queue === "new" && (
            <>
              <p className="text-muted">
                Radar đã đọc {totalEvaluatedPosts.toLocaleString("vi-VN")} bài. Nếu nghi bị bỏ sót khách thật, hãy kiểm tra các bài vừa bị loại.
              </p>
              <Button variant="primary" onClick={() => void openRejectedModal()}>
                Kiểm tra bài bị loại
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className={`inbox-split ${selectedLeadId ? "has-selection" : ""}`}>
          <div className="lead-list-pane" aria-label="Danh sách cơ hội" aria-busy={loading} onKeyDown={event => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const id = [...rowRefs.current].find(([, row]) => row === event.target)?.[0];
            const index = leads.findIndex(lead => lead.id === id);
            if (index < 0) return;
            event.preventDefault();
            const next = leads[Math.max(0, Math.min(leads.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
            if (next) { select(next.id); rowRefs.current.get(next.id)?.focus(); }
          }}>
            {loading && leads.length === 0 && <div className="queue-loading" role="status">Đang tải cơ hội…</div>}
            {!transitioningPage && leads.map((lead) => {
              const postedAt = lead.post_created_at ?? lead.created_at;
              const unread = !lead.read_at;
              return (
                <button
                  type="button"
                  key={lead.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(lead.id, el);
                    else rowRefs.current.delete(lead.id);
                  }}
                  className={`lead-row-item ${selectedLeadId === lead.id ? "selected" : ""} ${unread ? "unread" : ""}`}
                  aria-pressed={selectedLeadId === lead.id}
                  onClick={() => select(lead.id)}
                >
                  <AgeChip postedAt={postedAt} expiresAt={lead.expires_at} />
                  <span className="lead-row-body">
                    <span className="lead-row-summary">{lead.summary}</span>
                    <span className="lead-row-meta">
                      <span>{lead.radar_name}</span>
                      <span>{lead.source_name}</span>
                      {lead.feedback_label === "correct" && <span>Đã xác nhận khớp</span>}
                      {lead.is_weak_match && <span>khớp yếu</span>}
                    </span>
                  </span>
                  <span className="lead-row-side">
                    {["due", "overdue", "upcoming"].includes(queue) && lead.follow_up_at ? (
                      <span className="status-pill status-negotiating">{formatExactTime(lead.follow_up_at)}</span>
                    ) : lead.status !== "new" && lead.status !== "viewed" ? (
                      <span className={`status-pill status-${lead.status}`}>{LEAD_STATUS_LABELS[lead.status]}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {(pages.length > 0 || nextCursor) && (
              <div className="pagination">
                <Button
                  size="sm"
                  disabled={!pages.length || loading}
                  onClick={() => {
                    setTransitioningPage(true);
                    setSelectedLeadId(null);
                    setCursor(pages[pages.length - 1] ?? null);
                    setPages((p) => p.slice(0, -1));
                  }}
                >
                  Trang trước
                </Button>
                <Button
                  size="sm"
                  disabled={!nextCursor || loading}
                  onClick={() => {
                    setTransitioningPage(true);
                    setSelectedLeadId(null);
                    setPages((p) => [...p, cursor]);
                    setCursor(nextCursor);
                  }}
                >
                  Trang tiếp
                </Button>
              </div>
            )}
            <p className="shortcut-hint" aria-hidden="true">
              <kbd className="kbd">J</kbd>/<kbd className="kbd">K</kbd> chuyển tin · <kbd className="kbd">D</kbd> đúng ·{" "}
              <kbd className="kbd">S</kbd> sai · <kbd className="kbd">B</kbd> bỏ qua · <kbd className="kbd">L</kbd> đã liên hệ ·{" "}
              <kbd className="kbd">C</kbd> chép số · <kbd className="kbd">O</kbd> mở Facebook
            </p>
          </div>

          <div className="lead-detail-pane" aria-label="Chi tiết cơ hội">
            {decisionMessage && <p role="status" className="field-hint decision-message">{decisionMessage}</p>}
            {compact && selectedLeadId && <div className="toolbar-row compact-lead-nav">
              <Button onClick={() => move(-1)}>Tin trước</Button>
              <Button onClick={() => move(1)}>Tin tiếp</Button>
            </div>}
            {selectedLeadId ? (
              <LeadDetailPanel
                key={selectedLeadId}
                leadId={selectedLeadId}
                hotkeys
                onAdvance={advance}
                onClose={() => {
                  const id = selectedLeadId;
                  setSelectedLeadId(null);
                  requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
                }}
                closeLabel={compact ? "Về danh sách" : "Đóng"}
                onUpdated={() => {
                  void fetchLeads();
                  onLeadChanged();
                }}
              />
            ) : (
              <div className="text-muted">{compact ? "Chọn một tin trong danh sách." : "Chọn một tin bên trái, hoặc bấm J để mở tin đầu tiên."}</div>
            )}
          </div>
        </div>
      )}

      {rejectedOpen && (
        <Modal label="Các bài bị loại gần nhất" size="lg">
          <ModalHeader>
            <div>
              <h3 style={{ margin: 0 }}>Các bài bị loại gần nhất</h3>
              <div className="field-hint">
                Phạm vi: {selectedRadarId ? radars.find((r) => r.id === selectedRadarId)?.name : "Tất cả radar"}. Tối đa 100 bài gần nhất mỗi radar. Đánh dấu bỏ sót để đưa bài về Cơ hội và dạy radar.
              </div>
            </div>
            <Button size="sm" onClick={() => setRejectedOpen(false)}>
              Đóng
            </Button>
          </ModalHeader>
          <ModalBody style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rejectedItems.length === 0 ? (
              <div className="text-muted">Chưa có bài bị loại nào được ghi nhận.</div>
            ) : (
              rejectedItems.map((ev) => (
                <Card key={ev.evaluation_id}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Badge>{radars.find((r) => r.id === ev.radar_id)?.name}</Badge>
                      <Badge tone="warning">{REJECT_REASON_LABELS[ev.reject_reason]}</Badge>
                      <Badge>{ev.decided_by === "rule" ? "Bộ luật" : ev.decided_by === "ai" ? "AI" : "Lọc sơ bộ"}</Badge>
                    </div>
                    <span className="field-hint">
                      {ev.author_name} · {ev.source_name}
                    </span>
                  </div>
                  {ev.reason && (
                    <div className="field-hint" style={{ marginBottom: 6 }}>
                      Lý do: {ev.reason}
                    </div>
                  )}
                  <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                    {renderHighlightedPostText(ev.post_text, [])}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Button
                      variant={ev.marked_missed ? "success" : "default"}
                      size="sm"
                      disabled={Boolean(ev.marked_missed)}
                      onClick={() => void handleMarkMissed(ev).catch((err) => setError(String(err)))}
                    >
                      {ev.marked_missed ? "Đã đánh dấu bỏ sót" : "Đánh dấu bỏ sót"}
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </ModalBody>
        </Modal>
      )}
    </div>
  );
};
