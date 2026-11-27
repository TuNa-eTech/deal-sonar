import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatExactTime } from "../lib/format";
import type { AccountIncidentKind, AccountSafetyReport, HealthStatus } from "../types/ipc";
import { Button } from "./ui";

export const INCIDENT_LABELS: Record<AccountIncidentKind, string> = {
  checkpoint: "Facebook yêu cầu xác minh",
  logged_out: "Bị đăng xuất bất thường",
  rate_limited: "Facebook báo giới hạn tốc độ",
  unknown: "Phiên Facebook không rõ trạng thái",
};

/**
 * Every time Facebook asked the account for attention: when, what, and how many pages DealSonar
 * had loaded in the 24 hours before. Scanning stops on each of these until the session is healthy
 * (and, after a verification, until the user resumes it).
 */
export function AccountSafetyLog({ health }: { health: HealthStatus | null }) {
  const [report, setReport] = useState<AccountSafetyReport | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await api.accountSafetyReport(30));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, health?.facebook_session, health?.crawl_paused]);

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <p role="alert">{error}</p>;
  if (!report) return null;
  const newest = [...report.incidents].reverse();

  return (
    <section className="account-safety" aria-label="Nhật ký an toàn tài khoản">
      <header className="news-flow-head">
        <div>
          <h3>An toàn tài khoản Facebook ({report.window_days} ngày)</h3>
          <p className="field-hint">
            {report.incidents.length === 0
              ? "Chưa ghi nhận lần xác minh, đăng xuất bất thường hay giới hạn nào."
              : `${report.incidents.length} sự cố. Quét tự động dừng ở mỗi sự cố cho tới khi phiên Facebook ổn định.`}
            {" "}Có quét trong {report.active_days.length} ngày · {report.followed_groups} nhóm đang theo dõi · chu kỳ nhóm {report.crawl_policy.group_interval_minutes} phút.
          </p>
        </div>
        <Button size="sm" onClick={() => void copy()}>{copied ? "Đã sao chép" : "Sao chép báo cáo JSON"}</Button>
      </header>
      {newest.length > 0 && (
        <ol className="news-flow-journey">
          {newest.map((incident) => (
            <li key={incident.id} data-kind={incident.kind}>
              <strong>{INCIDENT_LABELS[incident.kind]}</strong>
              <span>
                {formatExactTime(incident.occurred_at)} · {incident.page_loads_24h} lượt tải trong 24 giờ trước
                {" "}({incident.page_loads_1h} trong 1 giờ trước)
                {incident.resolved_at ? ` · phiên ổn định lại ${formatExactTime(incident.resolved_at)}` : " · chưa ổn định"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
