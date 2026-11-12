import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatExactTime, formatRelativeTime } from "../lib/format";
import type { AiUsageStats, CrawlRun, FunnelStats, HealthStatus } from "../types/ipc";
import { FunnelChart } from "../components/FunnelChart";

interface HealthScreenProps {
  health: HealthStatus | null;
  onRefreshHealth: () => Promise<void>;
}

export const HealthScreen: React.FC<HealthScreenProps> = ({
  health,
  onRefreshHealth,
}) => {
  const [crawlRuns, setCrawlRuns] = useState<CrawlRun[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsageStats | null>(null);
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);
  const [checking, setChecking] = useState(false);
  const [diagMsg, setDiagMsg] = useState<string | null>(null);
  const [customExtId, setCustomExtId] = useState("");
  const [pairingMsg, setPairingMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [runs, usage, fn] = await Promise.all([
      api.crawlRunList(null, 30),
      api.aiUsageGet(7),
      api.radarStats(null, 7),
    ]);
    setCrawlRuns(runs);
    setAiUsage(usage);
    setFunnel(fn);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleRecheck = async () => {
    setChecking(true);
    try {
      await api.chromeConnect(
        customExtId.trim() ? { extension_id: customExtId.trim() } : undefined
      );
      await api.aiProbe();
      await onRefreshHealth();
      await loadAll();
    } finally {
      setChecking(false);
    }
  };

  const handlePairExtensionId = async () => {
    setChecking(true);
    setPairingMsg(null);
    try {
      const res = await api.chromeConnect(
        customExtId.trim() ? { extension_id: customExtId.trim() } : undefined
      );
      setPairingMsg(`${res.message} (${res.manifest_path})`);
      await onRefreshHealth();
    } catch (err) {
      setPairingMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleCreateBundle = async () => {
    const res = await api.diagnosticBundleCreate();
    setDiagMsg(
      `Đã tạo gói chẩn đoán (đã xoá token & nội dung bài): ${res.path} (${Math.round(
        res.size_bytes / 1024
      )} KB)`
    );
  };

  const maxDailyItems = Math.max(
    1,
    ...(aiUsage?.daily.map((d) => d.items) ?? [1])
  );

  return (
    <div>
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Sức khoẻ hệ thống & Nhật ký vận hành</h1>
          <p className="screen-subtitle">
            Giám sát 4 thành phần cốt lõi, nhật ký quét group và hạn mức gọi CLI AI theo ngày
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            disabled={checking}
            onClick={() => void handleRecheck()}
          >
            {checking ? "Đang kiểm tra…" : "↻ Chạy lại kiểm tra"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleCreateBundle()}>
            📦 Tạo gói chẩn đoán
          </button>
        </div>
      </div>

      {diagMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 14 }}>
          <span>{diagMsg}</span>
        </div>
      )}

      {/* 4 Status Lamps (`03-ux-flows.md §3`) */}
      <div className="lamp-grid">
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className={`status-dot ${health?.extension_connected ? "ok" : "err"}`} />
            <strong>1. Chrome Extension</strong>
          </div>
          <div>
            {health?.extension_connected
              ? `Đang kết nối (v${health.extension_version ?? "0.2.0"})`
              : "Mất kết nối — cần mở Chrome / bấm Thử lại trong popup tiện ích"}
          </div>
          {!health?.extension_connected && (
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <input
                type="text"
                className="input"
                style={{ fontSize: 12, padding: "4px 8px" }}
                placeholder="Extension ID tuỳ chỉnh (tuỳ chọn)"
                value={customExtId}
                onChange={(e) => setCustomExtId(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={checking}
                onClick={() => void handlePairExtensionId()}
              >
                Ghép nối
              </button>
            </div>
          )}
          {pairingMsg && (
            <div className="field-hint" style={{ marginTop: 6 }}>
              {pairingMsg}
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className={`status-dot ${health?.facebook_session === "ok" ? "ok" : "err"}`} />
            <strong>2. Phiên Facebook</strong>
          </div>
          <div>
            {health?.facebook_session === "ok"
              ? "Đang hoạt động bình thường"
              : `Cần kiểm tra (${health?.facebook_session})`}
          </div>
          <div className="field-hint">
            Tải trang: {health?.page_loads_last_hour ?? 0}/90 giờ · {health?.page_loads_today ?? 0}
            /900 ngày
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span
              className={`status-dot ${
                health?.ai_state === "ok"
                  ? "ok"
                  : health?.ai_state === "not_configured"
                    ? "warn"
                    : "err"
              }`}
            />
            <strong>3. CLI AI ({health?.ai_provider ?? "chưa chọn"})</strong>
          </div>
          <div>
            {health?.ai_state === "ok"
              ? "Sẵn sàng chấm bài"
              : `Trạng thái: ${health?.ai_state}`}
          </div>
          <div className="field-hint">
            Bài đang chờ AI: {health?.pending_ai_posts ?? 0} bài
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span
              className={`status-dot ${
                health?.telegram_state === "ok"
                  ? "ok"
                  : health?.telegram_state === "not_configured"
                    ? "warn"
                    : "err"
              }`}
            />
            <strong>4. Kênh Telegram</strong>
          </div>
          <div>
            {health?.telegram_state === "ok"
              ? `${health.telegram_channel_count} kênh đang nhận tin`
              : "Chưa cấu hình hoặc lỗi token"}
          </div>
          <div className="field-hint">
            Hộp gửi đi chờ: {health?.outbox_pending ?? 0} · Lỗi: {health?.outbox_failed ?? 0}
          </div>
        </div>
      </div>

      {/* AI Daily Usage & Funnel */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14, marginBottom: 16 }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>Mức dùng AI theo ngày (7 ngày qua)</strong>
            {aiUsage && (
              <span className="badge badge-primary">
                Hôm nay: {aiUsage.today_items.toLocaleString("vi-VN")} /{" "}
                {aiUsage.daily_cap.toLocaleString("vi-VN")} bài
              </span>
            )}
          </div>

          {aiUsage && (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-end",
                  height: 84,
                  marginBottom: 12,
                  padding: "6px 8px",
                  background: "var(--bg-subtle)",
                  borderRadius: 6,
                }}
              >
                {[...aiUsage.daily].reverse().map((d) => (
                  <div
                    key={d.date}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 38,
                        height: `${Math.max(8, Math.round((d.items / maxDailyItems) * 54))}px`,
                        background: "var(--primary)",
                        borderRadius: "4px 4px 0 0",
                      }}
                      title={`${d.date}: ${d.items} bài (${d.calls} lời gọi)`}
                    />
                    <span style={{ fontSize: 11 }} className="text-muted">
                      {d.date.slice(5)}
                    </span>
                  </div>
                ))}
              </div>

              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Ngày</th>
                    <th>Lời gọi</th>
                    <th>Bài chấm</th>
                    <th>Token (vào / ra)</th>
                    <th>Tỉ lệ lên AI</th>
                  </tr>
                </thead>
                <tbody>
                  {aiUsage.daily.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{d.calls}</td>
                      <td>{d.items.toLocaleString("vi-VN")}</td>
                      <td>
                        {d.input_tokens.toLocaleString("vi-VN")} /{" "}
                        {d.output_tokens.toLocaleString("vi-VN")}
                      </td>
                      <td>{d.ai_escalation_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <FunnelChart stats={funnel} title="Phễu xử lý toàn hệ thống (7 ngày)" />
      </div>

      {/* Crawl Runs Log */}
      <div className="card">
        <strong style={{ display: "block", marginBottom: 10, fontSize: 14 }}>
          Nhật ký các lần quét Group gần nhất (`crawl_runs`)
        </strong>
        <div className="table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Thời điểm</th>
                <th>Group</th>
                <th>Lý do</th>
                <th>Chiến lược trích</th>
                <th>Bài thấy / Bài mới</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {crawlRuns.map((run) => (
                <tr key={run.id}>
                  <td title={formatExactTime(run.started_at)}>
                    {formatRelativeTime(run.started_at)}
                  </td>
                  <td>{run.source_name}</td>
                  <td>{run.reason}</td>
                  <td>
                    <span className="badge">{run.strategy ?? "—"}</span>
                  </td>
                  <td>
                    {run.posts_seen} thấy · <strong>{run.posts_new} mới</strong>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        run.status === "ok" ? "badge-success" : "badge-warning"
                      }`}
                    >
                      {run.status}
                    </span>
                    {run.error && <div className="field-hint">{run.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
