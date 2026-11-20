import React, { useEffect, useState } from "react";
import type { HealthStatus } from "../types/ipc";
import { formatExactTime, formatRelativeTime } from "../lib/format";
import { operationState } from "./OperationStatus";

/** True when nothing needs the user's attention: scanning runs on schedule and AI is usable. */
export function isWatching(health: HealthStatus | null, activeRadars: number, followedGroups: number): boolean {
  return (
    activeRadars > 0 && followedGroups > 0 &&
    Boolean(health?.extension_connected) &&
    health?.facebook_session === "ok" &&
    health?.automatic_scanning === true &&
    !health?.crawl_paused &&
    (health?.ai_state === "ok" || health?.ai_state === "not_configured")
  );
}

/**
 * Always-visible pulse of the system. The radar only runs while this machine, Chrome and
 * DealSonar are on, so "when did we last look" is the most important operational fact.
 */
export function Heartbeat({
  health,
  followedGroups,
  activeRadars,
  onOpen,
}: {
  health: HealthStatus | null;
  followedGroups: number;
  activeRadars: number;
  onOpen: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const watching = isWatching(health, activeRadars, followedGroups);
  const state = operationState(health);
  const lastScan = health?.last_crawl_at ? `quét ${formatRelativeTime(health.last_crawl_at)}` : "chưa quét lần nào";
  const late = Boolean(health?.next_crawl_at && health.next_crawl_at < Date.now() - 15 * 60_000);
  const hasSchedule = Boolean(health?.next_crawl_at);
  const label = !activeRadars ? "Chưa bật radar" : !followedGroups ? "Chưa theo dõi nhóm"
    : watching ? (late ? "Quét trễ lịch" : hasSchedule ? "Đang canh" : "Chờ lịch quét") : state.label;
  const schedule = health?.next_crawl_at
    ? `Lịch dự kiến ${formatExactTime(health.next_crawl_at)}.`
    : state.detail;
  const detail = `${activeRadars} radar · ${lastScan} · ${followedGroups} nhóm`;

  return (
    <button
      type="button"
      className={`heartbeat ${watching && hasSchedule && !late ? "ok" : "warning"}`}
      onClick={onOpen}
      title={`${label}. ${detail}. ${schedule}`}
      aria-label={`Trạng thái: ${label}. ${detail}. Mở Kết nối`}
    >
      <span className="heartbeat-dot" aria-hidden="true" />
      <strong>{label}</strong>
      <span className="heartbeat-detail">{detail}</span>
    </button>
  );
}
