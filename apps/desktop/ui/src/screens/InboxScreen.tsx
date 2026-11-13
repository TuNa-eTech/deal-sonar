import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../lib/workspace";
import { api } from "../lib/api";
import {
  formatRelativeTime,
  LEAD_STATUS_LABELS,
  REJECT_REASON_LABELS,
} from "../lib/format";
import { renderHighlightedPostText } from "../lib/security";
import type {
  Lead,
  LeadStatus,
  Radar,
  RadarTemplate,
  RejectedEvaluation,
} from "../types/ipc";
import { LeadDetailPanel } from "../components/LeadDetailPanel";

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
  const [selectedRadarId, setSelectedRadarId] = useWorkspace<string>("opportunity-radar", "");
  const [statusFilter, setStatusFilter] = useWorkspace<LeadStatus | "all">("opportunity-status", "all");
  const [includeWeak, setIncludeWeak] = useWorkspace<boolean>("opportunity-weak", false);
  const [search, setSearch] = useWorkspace<string>("opportunity-search", "");

  const [cursor, setCursor]=useState<string|null>(null);
  const [pages,setPages]=useState<(string|null)[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [total,setTotal]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [unread,setUnread]=useWorkspace("opportunity-unread",false);
  const request=useRef(0);
  useEffect(()=>{setCursor(null);setPages([]);},[selectedRadarId,statusFilter,includeWeak,search,unread]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const [rejectedOpen, setRejectedOpen] = useState<boolean>(false);
  const [rejectedItems, setRejectedItems] = useState<RejectedEvaluation[]>([]);

  const fetchLeads = useCallback(async () => {
    const seq=++request.current;
    setError(null);
    if (radars.length === 0) {
      setLeads([]);
      setSelectedLeadId(null);
      return;
    }
    setLoading(true);
    try {
      const res = await api.leadList({
        radar_id: selectedRadarId || null,
        status: statusFilter === "all" ? undefined : [statusFilter],
        include_weak: includeWeak,
        search: search.trim() || null,
        sort: { by: "created_at", dir: "desc" },
        limit: 50, cursor, unread_only:unread,
      });
      if (seq!==request.current) return;
      setTotal(res.total);setNextCursor(res.next_cursor);
      setLeads(res.items);
      setSelectedLeadId((prev) => {
        if (prev && res.items.some((x) => x.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch (err) {if(seq===request.current)setError(String(err));} finally {
      if(seq===request.current)setLoading(false);
    }
  }, [radars.length, selectedRadarId, statusFilter, includeWeak, search, cursor, unread]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads, refreshToken]);

  const openRejectedModal = async () => {
    setError(null);
    try {
      const ids=selectedRadarId?[selectedRadarId]:radars.map(r=>r.id);
      const lists=await Promise.all(ids.map(id=>api.evaluationListRejected(id,100)));
      setRejectedItems(lists.flat().sort((a,b)=>b.captured_at-a.captured_at));
      setRejectedOpen(true);
    } catch(err) {setError(String(err));}

  };

  const handleMarkMissed = async (ev: RejectedEvaluation) => {
    const result = await api.leadFeedback({
      evaluation_id: ev.evaluation_id,
      post_id: ev.post_id,
      radar_version_id: ev.radar_version_id,
      label: "missed",
      origin: "app",
    });
    if(result.updated_lead) {setSelectedLeadId(result.updated_lead.id);setRejectedOpen(false);await fetchLeads();onLeadChanged();}
    setRejectedItems((prev) =>
      prev.map((x) =>
        x.evaluation_id === ev.evaluation_id ? { ...x, marked_missed: true } : x
      )
    );
  };

  // Empty State 1: 0 radars -> Industry Starter Template Grid (`03-ux-flows.md §5`)
  if (radars.length === 0) {
    return (
      <div className="opportunity-start">
        <div className="screen-header">
          <div>
            <h1 className="screen-title">Cơ hội: Tạo radar đầu tiên</h1>
            <p className="screen-subtitle">
              Chọn một mẫu radar theo ngành bên dưới hoặc tạo từ trang trắng để bắt đầu đón tin.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onCreateRadarFromTemplate(null)}
          >
            + Bắt đầu từ trang trắng
          </button>
        </div>

        <div className="template-grid">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="template-card"
              onClick={() => onCreateRadarFromTemplate(tpl)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <span className="badge badge-primary">{tpl.industry}</span>
                {tpl.seed_ruleset && <span className="badge badge-success">Có sẵn bộ luật</span>}
              </div>
              <strong style={{ fontSize: 14 }}>{tpl.name}</strong>
              <span className="field-hint">{tpl.description_template}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const totalEvaluatedPosts = radars.filter(r=>!selectedRadarId||r.id===selectedRadarId).reduce(
    (sum, r) => sum + (r.evaluated_posts_total ?? 0),
    0
  );

  return (
    <div className="opportunity-workspace">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Cơ hội</h1>
          <p className="screen-subtitle">
            Đọc nhu cầu, kiểm tra bằng chứng và quyết định việc tiếp theo.
          </p>
        </div>
        <div className="screen-actions">
          <button type="button" className="btn" onClick={() => void openRejectedModal()}>
            Xem các bài bị loại gần nhất
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onCreateRadarFromTemplate(null)}
          >
            + Tạo radar
          </button>
        </div>
      </div>

      {error&&<div role="alert" className="health-banner danger">{error}<button className="btn" onClick={()=>void fetchLeads()}>Thử lại</button></div>}
      <div className="view-summary"><span>{total.toLocaleString("vi-VN")} cơ hội</span><label><input type="checkbox" checked={unread} onChange={e=>setUnread(e.target.checked)}/> Chỉ chưa đọc</label><button className="btn btn-sm" onClick={()=>{setSelectedRadarId("");setStatusFilter("all");setSearch("");setIncludeWeak(false);setUnread(false);}}>Xoá bộ lọc</button></div>
      {/* Filter Bar */}
      <div className="toolbar-row opportunity-filters">
        <select
          aria-label="Lọc theo radar"
          className="select"
          
          value={selectedRadarId}
          onChange={(e) => setSelectedRadarId(e.target.value)}
        >
          <option value="">Tất cả Radar ({radars.length})</option>
          {radars.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Lọc theo trạng thái CRM"
          className="select"
          
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "all")}
        >
          <option value="all">Mọi trạng thái CRM</option>
          {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).filter(st=>st!=="viewed").map((st) => (
            <option key={st} value={st}>
              {LEAD_STATUS_LABELS[st]}
            </option>
          ))}
        </select>

        <input
          type="search"
          className="input"
          
          aria-label="Tìm cơ hội"
          placeholder="Tìm theo nội dung, ghi chú, tên…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeWeak}
            onChange={(e) => setIncludeWeak(e.target.checked)}
          />
          <span>Bao gồm cơ hội cần xem thêm</span>
        </label>
      </div>

      {/* Empty State 2: Active radars, 0 leads (`03-ux-flows.md §5`) */}
      {!loading && leads.length === 0 ? (
        <div className="opportunity-empty">
          <h3 style={{ marginTop: 0 }}>
            Đã đọc {totalEvaluatedPosts.toLocaleString("vi-VN")} bài, chưa bài nào khớp bộ lọc hiện
            tại
          </h3>
          <p className="text-muted">
            Bạn có thể kiểm tra danh sách các bài vừa bị hệ thống loại để chắc chắn không bỏ sót
            khách thật.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void openRejectedModal()}>
            Xem các bài bị loại gần nhất
          </button>
        </div>
      ) : (
        <div className={`inbox-split ${selectedLeadId?"has-selection":""}`}>
          <div className="lead-list-pane" aria-label="Danh sách cơ hội" aria-busy={loading}>
            {loading && <div className="queue-loading" role="status">Đang tải cơ hội…</div>}
            {leads.map((lead) => (
              <button type="button"
                key={lead.id}
                className={`lead-row-item ${selectedLeadId === lead.id ? "selected" : ""}`}
                aria-pressed={selectedLeadId === lead.id}
                onClick={() => setSelectedLeadId(lead.id)}
              >
                <div className="queue-row-top">
                  <span className="queue-radar">
                    {lead.radar_name}
                  </span>
                  <span className="field-hint">{formatRelativeTime(lead.post_created_at)}</span>
                </div>
                <div
                  style={{
                    fontWeight: !lead.read_at ? 700 : 500,
                    margin: "var(--space-xs) 0",
                  }}
                >
                  {lead.summary}
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                  }}
                >
                  <span className="queue-byline"><span>{lead.author_name}</span><span>{lead.source_name}</span></span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <span
                      className={`badge ${lead.is_weak_match ? "badge-warning" : "badge-success"}`}
                    >
                      {(lead.score * 100).toFixed(0)}%
                    </span>
                    <span className="badge">{LEAD_STATUS_LABELS[lead.status]}</span>
                  </div>
                </div>
              </button>
            ))}
            <div className="pagination"><button className="btn btn-sm" disabled={!pages.length||loading} onClick={()=>{setCursor(pages[pages.length-1]??null);setPages(p=>p.slice(0,-1));}}>Trang trước</button><button className="btn btn-sm" disabled={!nextCursor||loading} onClick={()=>{setPages(p=>[...p,cursor]);setCursor(nextCursor);}}>Trang tiếp</button></div>
          </div>

          <div className="lead-detail-pane" aria-label="Chi tiết cơ hội">
            {selectedLeadId ? (
              <LeadDetailPanel
                key={selectedLeadId}
                leadId={selectedLeadId}
                onClose={()=>setSelectedLeadId(null)}
                onUpdated={() => {
                  void fetchLeads();
                  onLeadChanged();
                }}
              />
            ) : (
              <div className="text-muted">Chọn một tin bên trái để xem chi tiết.</div>
            )}
          </div>
        </div>
      )}

      {/* Rejected Posts Modal with "Đánh dấu bỏ sót" (`04-data-model.md §2.4`, `03-risks-compliance.md R-13`) */}
      {rejectedOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Các bài bị loại gần nhất">
          <div className="modal-panel" style={{ maxWidth: 820 }}>
            <div className="modal-header">
              <div>
                <h3 style={{ margin: 0 }}>Các bài bị loại gần nhất</h3>
                <div className="field-hint">
                  Phạm vi: {selectedRadarId?radars.find(r=>r.id===selectedRadarId)?.name:"Tất cả radar"}. Tối đa 100 bài gần nhất mỗi radar. Đánh dấu bỏ sót để đưa bài về Cơ hội.
                </div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setRejectedOpen(false)}>
                Đóng
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rejectedItems.length === 0 ? (
                <div className="text-muted">Chưa có bài bị loại nào được ghi nhận.</div>
              ) : (
                rejectedItems.map((ev) => (
                  <div key={ev.evaluation_id} className="card">
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <span className="badge">{radars.find(r=>r.id===ev.radar_id)?.name}</span>
                        <span className="badge badge-warning">
                          {REJECT_REASON_LABELS[ev.reject_reason]}
                        </span>
                        <span className="badge">
                          Tầng quyết định: {ev.decided_by === "rule" ? "Bộ luật" : ev.decided_by}
                        </span>
                      </div>
                      <span className="field-hint">
                        {ev.author_name} · {ev.source_name}
                      </span>
                    </div>
                    {ev.reason && (
                      <div className="field-hint" style={{ marginBottom: 6 }}>
                        Giải thích: {ev.reason}
                      </div>
                    )}
                    <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                      {renderHighlightedPostText(ev.post_text, [])}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className={`btn btn-sm ${ev.marked_missed ? "btn-success" : ""}`}
                        disabled={Boolean(ev.marked_missed)}
                        onClick={() => void handleMarkMissed(ev).catch(err=>setError(String(err)))}
                      >
                        {ev.marked_missed ? "Đã đánh dấu bỏ sót" : "Đánh dấu bỏ sót"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
