import React, { useState } from "react";
import {offerUndo} from "../components/UndoCenter";
import { api } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { openSafeSetupUrl, renderHighlightedPostText } from "../lib/security";
import type { LicenseStatus, Post, Source } from "../types/ipc";

interface SourcesScreenProps {
  sources: Source[];
  license: LicenseStatus;
  onChanged: () => void;
}

export const SourcesScreen: React.FC<SourcesScreenProps> = ({
  sources,
  license,
  onChanged,
}) => {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const [ftsOpen, setFtsOpen] = useState(false);
  const [ftsQuery, setFtsQuery] = useState("");
  const [ftsPosts, setFtsPosts] = useState<Post[]>([]);

  const followedCount = sources.filter((s) => s.followed).length;
  const priorityCount = sources.filter((s) => s.priority).length;

  const handleToggleFollow = async (s: Source) => {
    setErrorMsg(null);
    try {
      if (s.followed) {
        const radars=await api.radarList();
        const affected=radars.filter(r=>r.source_ids.includes(s.id));
        if(affected.length&&!window.confirm(`Bỏ theo dõi “${s.name}” ảnh hưởng ${affected.map(r=>r.name).join(", ")}. Bạn có thể hoàn tác sau thao tác. Tiếp tục?`))return;
        await api.sourceUnfollow(s.id);
        offerUndo(`Đã bỏ theo dõi ${s.name}`,async()=>{await api.sourceFollow(s.id);if(s.priority)await api.sourceSetPriority(s.id,true);onChanged();});
      } else {
        await api.sourceFollow(s.id);
      }
      onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePriority = async (s: Source) => {
    setErrorMsg(null);
    try {
      await api.sourceSetPriority(s.id, !s.priority);
      onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCrawlNow = async (s: Source) => {
    setErrorMsg(null);
    const result=await api.sourceCrawlNow(s.id, "manual");
    if(!result.queued){setErrorMsg("Chưa có tiện ích kết nối để nhận lệnh. Mở Chrome rồi thử lại.");return;}
    setInfoMsg(`Đã gửi lệnh quét ngay cho group «${s.name}». Hãy xem lần quét cuối và số bài lưu để xác nhận kết quả.`);
    onChanged();
  };

  const runPostSearch = async () => {
    const res = await api.postSearch(ftsQuery, null, 30);
    setFtsPosts(res);
  };

  return (
    <div className="sources-workspace">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Nguồn Group Facebook</h1>
          <p className="screen-subtitle">
            Đang theo dõi {followedCount} / {license.limits.max_followed_groups} group. Group ưu
            tiên: {priorityCount} / 3 (chu kỳ 5 phút).
          </p>
        </div>

        <div className="management-header-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFtsOpen(true);
              void runPostSearch();
            }}
          >
            Tìm bài viết thô trong kho (FTS)
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            + Mở trang group của tôi trên Facebook
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{errorMsg}</span>
        </div>
      )}
      {infoMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{infoMsg}</span>
        </div>
      )}

      <div className="table-wrap source-directory">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Tên Group</th>
              <th>Quyền riêng tư</th>
              <th>Thành viên</th>
              <th>Lần quét cuối</th>
              <th>Tốc độ bài</th>
              <th>Trạng thái</th>
              <th>Ưu tiên</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  <div className="field-hint">
                    Đã lưu {s.stored_post_count.toLocaleString("vi-VN")} bài trong kho
                  </div>
                </td>
                <td>
                  <span className="badge">
                    {s.privacy === "private" ? "Group kín" : "Công khai"}
                  </span>
                </td>
                <td>{s.member_count ? s.member_count.toLocaleString("vi-VN") : "—"}</td>
                <td>{s.last_crawl_at ? formatRelativeTime(s.last_crawl_at) : "Chưa quét"}</td>
                <td>~{s.posts_per_day} bài/ngày</td>
                <td>
                  <span
                    className={`badge ${
                      s.state === "ok" ? "badge-success" : "badge-danger"
                    }`}
                  >
                    {s.state === "ok"
                      ? "Ổn định"
                      : s.state === "inaccessible"
                        ? "Không truy cập được"
                        : "Lỗi"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className={`btn btn-sm ${s.priority ? "priority-selected" : ""}`}
                    disabled={!s.followed}
                    onClick={() => void handleTogglePriority(s)}
                  >
                    {s.priority ? "Ưu tiên" : "Thường"}
                  </button>
                </td>
                <td>
                  <div className="management-row-actions">
                    <button
                      type="button"
                      className={`btn btn-sm ${s.followed ? "" : "btn-primary"}`}
                      onClick={() => void handleToggleFollow(s)}
                    >
                      {s.followed ? "Bỏ theo dõi" : "Theo dõi"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!s.followed}
                      onClick={() => void handleCrawlNow(s).catch(e=>setErrorMsg(String(e)))}
                    >
                      Quét ngay
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Raw Post FTS Search Drawer (`post_search`) */}
      {ftsOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Tìm kiếm bài thô trong kho">
          <div className="modal-panel" style={{ maxWidth: 820 }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>Tìm kiếm toàn văn trên kho bài thô (FTS5 không phân biệt dấu)</h3>
              <button type="button" className="btn btn-sm" onClick={() => setFtsOpen(false)}>
                Đóng
              </button>
            </div>
            <div className="modal-body">
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input
                  type="search"
                  className="input"
                  placeholder="Gõ từ khoá (ví dụ: cau giay, 2pn, vios)…"
                  value={ftsQuery}
                  onChange={(e) => setFtsQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runPostSearch();
                  }}
                />
                <button type="button" className="btn btn-primary" onClick={() => void runPostSearch()}>
                  Tìm bài
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ftsPosts.map((p) => (
                  <div key={p.id} className="card">
                    <div className="management-row-heading">
                      <strong>{p.author_name}</strong>
                      <span className="field-hint">
                        {p.source_name}, {formatRelativeTime(p.created_at)}, chiến lược: {p.strategy}
                      </span>
                    </div>
                    <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                      {renderHighlightedPostText(p.text, ftsQuery ? [ftsQuery] : [])}
                    </div>
                  </div>
                ))}
                {ftsPosts.length === 0 && (
                  <div className="text-muted">Không có bài viết nào khớp từ khoá.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
