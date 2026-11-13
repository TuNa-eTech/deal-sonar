// Immutable hard safety caps and the effective limits derived from policy.

import type { CrawlPolicy, CrawlPlanEntry } from "../../protocol";
import type { ExtensionStorageState } from "../storage";

// ── Immutable Hard Safety Caps (`02-extension.md §6.3` — NEVER overridden by `config.update`) ──

export const HARD_MAX_LOADS_PER_HOUR = 90;
export const HARD_MAX_LOADS_PER_DAY = 900;
export const HARD_MIN_SOURCE_INTERVAL_S = 240; // 4 minutes
export const HARD_MIN_SOURCE_INTERVAL_MS = HARD_MIN_SOURCE_INTERVAL_S * 1000;

// ── Anomaly Recovery Constants (`02-extension.md §6.4`) ──

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
export const RATE_LIMIT_PAUSE_MS = 24 * ONE_HOUR_MS; // 24 hours
export const RATE_LIMIT_DOUBLE_INTERVAL_MS = 7 * ONE_DAY_MS; // 7 days after resuming
export const NETWORK_ERROR_BACKOFF_STEPS_MS = [
  5 * 60 * 1000, // 3rd consecutive error -> 5m
  15 * 60 * 1000, // 4th consecutive error -> 15m
  60 * 60 * 1000, // 5th+ consecutive error -> 60m
] as const;
export const EMPTY_STREAK_DISTINCT_SOURCES_THRESHOLD = 3;

export function getEffectiveMaxLoadsPerHour(policy: CrawlPolicy): number {
  const requested = Number.isFinite(policy.max_loads_per_hour)
    ? Math.max(1, Math.floor(policy.max_loads_per_hour))
    : 60;
  return Math.min(requested, HARD_MAX_LOADS_PER_HOUR);
}

export function getEffectiveMaxLoadsPerDay(policy: CrawlPolicy): number {
  const requested = Number.isFinite(policy.max_loads_per_day)
    ? Math.max(1, Math.floor(policy.max_loads_per_day))
    : 600;
  return Math.min(requested, HARD_MAX_LOADS_PER_DAY);
}

export function isRateLimitRecoveryActive(
  state: ExtensionStorageState,
  now: number,
): boolean {
  return (
    state.anomalies.rate_limit_recovery_until !== null &&
    now < state.anomalies.rate_limit_recovery_until
  );
}

export function getEffectiveSourceIntervalS(
  entry: CrawlPlanEntry,
  state: ExtensionStorageState,
  now: number,
): number {
  const rawInterval = Number.isFinite(entry.interval_s) ? entry.interval_s : 900;
  const multiplied = isRateLimitRecoveryActive(state, now)
    ? rawInterval * 2
    : rawInterval;
  return Math.max(multiplied, HARD_MIN_SOURCE_INTERVAL_S);
}
