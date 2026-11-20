import React, { useEffect, useState } from "react";
import {offerUndo} from "../components/UndoCenter";
import { api } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { openSafeSetupUrl, renderHighlightedPostText } from "../lib/security";
import type { LicenseStatus, Post, Source, SourcePostCursor, SourcePostPage } from "../types/ipc";
import { Badge, Button, Card, Input, Modal, ModalBody, ModalHeader } from "../components/ui";

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
  const [scans, setScans] = useState<Record<string, {runId?: string; started?: number; text: string; busy: boolean}>>({});

  useEffect(() => {
    const pending = Object.entries(scans).filter(([, scan]) => scan.busy && scan.runId);
    if (!pending.length) return;
    let cancelled = false;
    const refresh = async () => {
      for (const [id, scan] of pending) {
        try {
          const runs = await api.crawlRunList(id, 10);
          if (cancelled) return;
          const result = runs.find(run => run.id === scan.runId);
          if (!result && Date.now() - (scan.started ?? 0) < 90_000) continue;
          const text = result
            ? result.status === "ok" || result.status === "empty"
              ? `Quét hoàn tất · ${result.posts_new} bài mới`
              : `Quét chưa hoàn tất · ${result.error ?? "kiểm tra kết nối và quyền truy cập nhóm"}`
            : "Chưa nhận kết quả. Kiểm tra tiện ích DealSonar trong Chrome.";
          setScans(current => current[id]?.runId === scan.runId
            ? { ...current, [id]: { text, busy: false } }
            : current);
        } catch (error) {
          if (!cancelled) setScans(current => current[id]?.runId === scan.runId
            ? { ...current, [id]: {text: `Chưa đọc được lượt quét. ${String(error)}`, busy: false} }
            : current);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [scans]);

  const [ftsOpen, setFtsOpen] = useState(false);
  const [ftsQuery, setFtsQuery] = useState("");
  const [ftsPosts, setFtsPosts] = useState<Post[]>([]);
  const [viewingSource, setViewingSource] = useState<Source | null>(null);

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
    setScans(current => ({...current, [s.id]: {text: "Đang gửi lệnh…", busy: true}}));
    try {
      const result = await api.sourceCrawlNow(s.id, "manual");
      setScans(current => ({...current, [s.id]: result.queued
        ? {runId: result.run_id, started: Date.now(), text: "Đã gửi lệnh · đang chờ tiện ích báo kết quả", busy: true}
        : {text: "Chưa gửi được. Mở Chrome có tiện ích DealSonar rồi thử lại.", busy: false}}));
    } catch (error) {
      setScans(current => ({...current, [s.id]: {text: String(error), busy: false}}));
    }
  };

  const runPostSearch = async () => {
    const res = await api.postSearch(ftsQuery, null, 30);
    setFtsPosts(res);
  };

  return (
    <div className="sources-workspace">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Group Facebook</h1>
          <p className="screen-subtitle">
            Đang theo dõi {followedCount} / {license.limits.max_followed_groups} group. Group ưu
            tiên: {priorityCount} / 3 (chu kỳ 5 phút).
          </p>
        </div>

        <div className="management-header-actions">
          <Button
            onClick={() => {
              setFtsOpen(true);
              void runPostSearch();
            }}
          >
            Tìm bài viết thô trong kho (FTS)
          </Button>
          <Button
            variant="primary"
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            + Mở trang group của tôi trên Facebook
          </Button>
        </div>
      </div>

      {errorMsg && (
        <div className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{errorMsg}</span>
        </div>
      )}
      {sources.length === 0 && <Card>
        <h2>Chưa có nhóm Facebook</h2>
        <p>Mở danh sách nhóm Facebook trong Chrome có tiện ích DealSonar, rồi chờ đồng bộ. Nếu chưa thấy nhóm, kiểm tra kết nối Chrome và làm mới danh sách.</p>
        <Button onClick={onChanged}>Làm mới danh sách</Button>
        <Button onClick={() => { location.hash = "health"; }}>Kiểm tra kết nối Chrome</Button>
      </Card>}

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
                  <Badge >
                    {s.privacy === "private" ? "Group kín" : "Công khai"}
                  </Badge>
                </td>
                <td>{s.member_count ? s.member_count.toLocaleString("vi-VN") : "—"}</td>
                <td>{s.last_crawl_at ? formatRelativeTime(s.last_crawl_at) : "Chưa quét"}</td>
                <td>~{s.posts_per_day} bài/ngày</td>
                <td>
                  <Badge
                  >
                    {s.state === "ok"
                      ? "Ổn định"
                      : s.state === "inaccessible"
                        ? "Không truy cập được"
                        : "Lỗi"}
                  </Badge>
                </td>
                <td>
                  <Button
                    size="sm"
                    className={s.priority ? "priority-selected" : undefined}
                    disabled={!s.followed}
                    onClick={() => void handleTogglePriority(s)}
                  >
                    {s.priority ? "Ưu tiên" : "Thường"}
                  </Button>
                </td>
                <td>
                  <div className="management-row-actions">
                    <Button
                      variant={s.followed ? "default" : "primary"} size="sm"
                      onClick={() => void handleToggleFollow(s)}
                    >
                      {s.followed ? "Bỏ theo dõi" : "Theo dõi"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!s.followed || scans[s.id]?.busy}
                      onClick={() => void handleCrawlNow(s).catch(e=>setErrorMsg(String(e)))}
                    >
                      Quét ngay
                    </Button>
                    <Button size="sm" onClick={() => setViewingSource(s)}>
                      Xem bài đã quét
                    </Button>
                    {scans[s.id] && <small role="status">{scans[s.id]?.text}</small>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewingSource && (
        <SourcePostsDialog
          key={viewingSource.id}
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}

      {/* Raw Post FTS Search Drawer (`post_search`) */}
      {ftsOpen && (
        <Modal label="Tìm kiếm bài thô trong kho" size="lg">
            <ModalHeader>
              <h3 style={{ margin: 0 }}>Tìm kiếm toàn văn trên kho bài thô (FTS5 không phân biệt dấu)</h3>
              <Button size="sm" onClick={() => setFtsOpen(false)}>
                Đóng
              </Button>
            </ModalHeader>
            <ModalBody>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <Input
                  type="search"
                  placeholder="Gõ từ khoá (ví dụ: cau giay, 2pn, vios)…"
                  value={ftsQuery}
                  onChange={(e) => setFtsQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runPostSearch();
                  }}
                />
                <Button variant="primary" onClick={() => void runPostSearch()}>
                  Tìm bài
                </Button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ftsPosts.map((p) => (
                  <Card key={p.id} >
                    <div className="management-row-heading">
                      <strong>{p.author_name}</strong>
                      <span className="field-hint">
                        {p.source_name}, {formatRelativeTime(p.created_at)}, chiến lược: {p.strategy}
                      </span>
                    </div>
                    <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                      {renderHighlightedPostText(p.text, ftsQuery ? [ftsQuery] : [])}
                    </div>
                  </Card>
                ))}
                {ftsPosts.length === 0 && (
                  <div className="text-muted">Không có bài viết nào khớp từ khoá.</div>
                )}
              </div>
            </ModalBody>
          </Modal>
      )}
    </div>
  );
};

function SourcePostsDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const [page, setPage] = useState<SourcePostPage | null>(null);
  const [request, setRequest] = useState<{ before: SourcePostCursor | null }>({ before: null });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.postListBySource(source.id, request.before)
      .then((result) => {
        if (cancelled) return;
        setPage((current) => ({
          items: request.before && current ? [...current.items, ...result.items] : result.items,
          next_cursor: result.next_cursor,
        }));
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source.id, request]);

  const load = (before: SourcePostCursor | null) => {
    setLoading(true);
    setFailed(false);
    setRequest({ before });
  };

  const nextCursor = page?.next_cursor;
  return (
    <Modal label={`Bài đã quét · ${source.name}`} size="lg">
      <ModalHeader>
        <h3>Bài đã quét · {source.name}</h3>
        <Button size="sm" autoFocus onClick={onClose}>Đóng</Button>
      </ModalHeader>
      <ModalBody>
        {page?.items.length === 0 && <p className="text-muted">Group này chưa có bài đã lưu.</p>}
        {!!page?.items.length && (
          <ul className="source-posts">
            {page.items.map((post) => (
              <li key={post.id}>
                <Card>
                  <div className="management-row-heading">
                    <strong>{post.author_name}</strong>
                    <span className="field-hint">
                      {post.created_at === null ? "Đã quét" : "Đăng"} {formatRelativeTime(post.created_at ?? post.captured_at)}
                    </span>
                  </div>
                  <div className="post-plain-text">{renderHighlightedPostText(post.text)}</div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {loading && <p role="status" className="text-muted">Đang tải bài đã quét…</p>}
        {failed && (
          <>
            <p role="alert">Không tải được bài đã quét.</p>
            <Button onClick={() => load(request.before)}>Thử lại</Button>
          </>
        )}
        {!failed && nextCursor && (
          <Button disabled={loading} onClick={() => load(nextCursor)}>Xem thêm bài</Button>
        )}
      </ModalBody>
    </Modal>
  );
}
