// Active-hours window math and next-due computation.

import type { ActiveHours, CrawlPlanEntry, CrawlPolicy } from "../../protocol";
import type { ExtensionStorageState } from "../storage";
import { getEffectiveSourceIntervalS, HARD_MIN_SOURCE_INTERVAL_MS } from "./limits";

// ── Active Hours Helpers (`01-protocol.md §4.3`, local machine clock) ──

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function isWithinActiveHours(nowMs: number, activeHours: ActiveHours): boolean {
  const fromMin = parseHHMM(activeHours.from);
  const toMin = parseHHMM(activeHours.to);
  if (fromMin === null || toMin === null || fromMin === toMin) {
    return true;
  }

  const d = new Date(nowMs);
  const currentMin = d.getHours() * 60 + d.getMinutes();

  if (fromMin < toMin) {
    return currentMin >= fromMin && currentMin < toMin;
  }
  // Overnight window (e.g., 22:00 -> 06:00)
  return currentMin >= fromMin || currentMin < toMin;
}

export function snapToActiveHours(targetMs: number, activeHours: ActiveHours): number {
  if (isWithinActiveHours(targetMs, activeHours)) {
    return targetMs;
  }
  const fromMin = parseHHMM(activeHours.from);
  if (fromMin === null) return targetMs;

  const d = new Date(targetMs);
  const targetFromToday = new Date(d);
  targetFromToday.setHours(Math.floor(fromMin / 60), fromMin % 60, 0, 0);

  if (targetFromToday.getTime() > targetMs) {
    return targetFromToday.getTime();
  }

  const targetFromTomorrow = new Date(targetFromToday);
  targetFromTomorrow.setDate(targetFromTomorrow.getDate() + 1);
  return targetFromTomorrow.getTime();
}

/**
 * Compute next due timestamp for a source with `±jitter` (default `±30%`),
 * strictly clamped to `>= HARD_MIN_SOURCE_INTERVAL_MS` (`4m`) and snapped to `active_hours`.
 */
export function computeNextDueAt(
  now: number,
  entry: CrawlPlanEntry,
  policy: CrawlPolicy,
  state: ExtensionStorageState,
  rng: () => number = Math.random,
): number {
  const baseIntervalMs = getEffectiveSourceIntervalS(entry, state, now) * 1000;
  const jitterRatio = Number.isFinite(policy.jitter)
    ? Math.max(0, Math.min(policy.jitter, 0.9))
    : 0.3;
  const factor = 1 + (rng() * 2 - 1) * jitterRatio;
  const jitteredMs = Math.max(
    HARD_MIN_SOURCE_INTERVAL_MS,
    Math.round(baseIntervalMs * factor),
  );
  return snapToActiveHours(now + jitteredMs, policy.active_hours);
}
