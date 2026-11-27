import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatExactTime } from "../lib/format";
import { explainNoNews, formatDuration, journeySteps } from "../lib/newsFlow";
import type { FirstNewsStatus, HealthStatus } from "../types/ipc";
import { Button } from "./ui";

/**
 * Explains, in four separate situations, why no lead has arrived, with the last time each step
 * worked and the next action; and (full view) the first-run journey with install time kept apart
 * from Radar creation time.
 */
export function NewsFlowStatus({
  health,
  compact = false,
}: {
  health: HealthStatus | null;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<FirstNewsStatus | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.firstNewsStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, health?.checked_at]);

  // Counts and times only: no post text, group names or account identity. For the pilot owner.
  const copyPilotSnapshot = async () => {
    if (!status) return;
    try {
      const usage = await api.aiUsageGet(30);
      const snapshot = {
        schema: 1,
        taken_on: new Date().toISOString().slice(0, 10),
        first_news: status,
        ai_usage: {
          total_calls: usage.total_calls,
          total_items: usage.total_items,
          total_input_tokens: usage.total_input_tokens,
          total_output_tokens: usage.total_output_tokens,
          total_cost_usd: usage.total_cost_usd,
        },
      };
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <p role="alert">{error}</p>;
  if (!status) return <p role="status">Đang kiểm tra vì sao chưa có tin…</p>;

  const report = explainNoNews(status, health);
  const steps = journeySteps(status);

  return (
    <section className="news-flow" aria-label="Vì sao chưa có tin">
      <header className="news-flow-head">
        <div>
          <h3>Tin đang dừng ở đâu?</h3>
          <p className={`operation-status ${report.tone}`} role="status">{report.headline}</p>
        </div>
        <Button size="sm" onClick={() => void load()}>Kiểm tra lại</Button>
      </header>
      <ol className="news-flow-stages">
        {report.stages.map((stage) => (
          <li key={stage.id} data-stage={stage.id} data-active={stage.active}>
            <strong>{stage.title}</strong>
            <span className="news-flow-state">{stage.active ? "Đang xảy ra" : "Không có vấn đề"}</span>
            <p>{stage.summary}</p>
            <small>
              Lần thành công gần nhất: {stage.lastSuccess}
              {stage.lastSuccessAt ? ` (${formatExactTime(stage.lastSuccessAt)})` : ""}
            </small>
            {stage.next && (
              <p>
                <Button size="sm" onClick={() => { location.hash = stage.next!.hash; }}>
                  {stage.next.label}
                </Button>
              </p>
            )}
          </li>
        ))}
      </ol>
      {!compact && (
        <>
          <h4>Hành trình từ lúc cài đến tin đầu tiên</h4>
          <p className="field-hint">
            Thời gian cài là lần đầu mở DealSonar, tách riêng với lúc tạo Radar.
          </p>
          <Button size="sm" onClick={() => void copyPilotSnapshot()}>
            {copied ? "Đã sao chép" : "Sao chép số liệu pilot (JSON)"}
          </Button>
          <ol className="news-flow-journey">
            {steps.map((step) => (
              <li key={step.id} data-step={step.id} data-reached={step.at != null}>
                <strong>{step.label}</strong>
                {step.at == null ? (
                  <span>Chưa xảy ra</span>
                ) : (
                  <span>
                    {formatExactTime(step.at)}
                    {step.id !== "installed" && step.sinceInstallMs != null && ` · ${formatDuration(step.sinceInstallMs)} sau khi cài`}
                    {step.sinceRadarCreatedMs != null && ` · ${formatDuration(step.sinceRadarCreatedMs)} sau khi tạo Radar`}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
