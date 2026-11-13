// Load counting and crawl eligibility checks.

import { type ExtensionStorageState, pruneLoadTimestamps } from "../storage";
import { isWithinActiveHours, snapToActiveHours } from "./active-hours";
import {
  getEffectiveMaxLoadsPerDay,
  getEffectiveMaxLoadsPerHour,
  HARD_MIN_SOURCE_INTERVAL_MS,
  ONE_DAY_MS,
  ONE_HOUR_MS,
} from "./limits";
import { refreshExpiredPauseState } from "./state-transitions";

// ── Hard Cap & Eligibility Checks (`02-extension.md §5 & §6.3`) ──

export type CrawlBlockReason =
  | "desktop_disconnected"
  | "session_not_ok"
  | "checkpoint_requires_desktop_resume"
  | "paused"
  | "network_backoff"
  | "already_crawling"
  | "hourly_cap_reached"
  | "daily_cap_reached"
  | "outside_active_hours"
  | "user_not_idle"
  | "source_inaccessible"
  | "source_min_interval";

export type CrawlEligibility =
  | { allowed: true }
  | { allowed: false; reason: CrawlBlockReason; retryAt?: number };

export function countLoadsInLastHour(
  loadTimestamps: readonly number[],
  now: number,
): number {
  const cutoff = now - ONE_HOUR_MS;
  let count = 0;
  for (const ts of loadTimestamps) {
    if (ts > cutoff && ts <= now) count++;
  }
  return count;
}

export function countLoadsInLastDay(
  loadTimestamps: readonly number[],
  now: number,
): number {
  const cutoff = now - ONE_DAY_MS;
  let count = 0;
  for (const ts of loadTimestamps) {
    if (ts > cutoff && ts <= now) count++;
  }
  return count;
}

export function checkCrawlEligibility(
  state: ExtensionStorageState,
  now: number,
  options?: {
    bypassScheduleWindow?: boolean; // true for `crawl.request` (`manual`/`preview`)
    sourceExternalId?: string;
    requiresNewPageLoad?: boolean;
    isIdle?: boolean;
    ignoreDesktopConnection?: boolean;
  },
): CrawlEligibility {
  refreshExpiredPauseState(state, now);

  if (
    !options?.ignoreDesktopConnection &&
    (!state.connection.connected || !state.connection.desktop_available)
  ) {
    return { allowed: false, reason: "desktop_disconnected" };
  }

  // Immutable Hard Cap #3: Immediate halt when `session.state !== "ok"`
  if (state.session.state !== "ok") {
    return { allowed: false, reason: "session_not_ok" };
  }

  if (state.pause.requires_desktop_resume) {
    return { allowed: false, reason: "checkpoint_requires_desktop_resume" };
  }

  if (state.pause.paused) {
    return {
      allowed: false,
      reason: "paused",
      retryAt: state.pause.until ?? undefined,
    };
  }

  if (
    state.anomalies.network_backoff_until !== null &&
    now < state.anomalies.network_backoff_until
  ) {
    return {
      allowed: false,
      reason: "network_backoff",
      retryAt: state.anomalies.network_backoff_until,
    };
  }

  if (state.active_crawl !== null) {
    return { allowed: false, reason: "already_crawling" };
  }

  const policy = state.config.policy;
  const needsPageLoad = options?.requiresNewPageLoad ?? true;

  if (needsPageLoad) {
    // Immutable Hard Cap #1: Max 90 loads/hour & 900 loads/day regardless of config.update
    const pruned = pruneLoadTimestamps(state.load_timestamps, now);
    const maxHour = getEffectiveMaxLoadsPerHour(policy);
    const maxDay = getEffectiveMaxLoadsPerDay(policy);

    const hourTimestamps = pruned
      .filter((ts) => ts > now - ONE_HOUR_MS)
      .sort((a, b) => a - b);
    if (hourTimestamps.length >= maxHour) {
      return {
        allowed: false,
        reason: "hourly_cap_reached",
        retryAt: (hourTimestamps[0] ?? now) + ONE_HOUR_MS,
      };
    }

    const dayTimestamps = pruned.sort((a, b) => a - b);
    if (dayTimestamps.length >= maxDay) {
      return {
        allowed: false,
        reason: "daily_cap_reached",
        retryAt: (dayTimestamps[0] ?? now) + ONE_DAY_MS,
      };
    }
  }

  // Scheduled crawls respect `active_hours` and `only_when_idle` (`crawl.request` bypasses schedule window)
  if (!options?.bypassScheduleWindow) {
    if (!isWithinActiveHours(now, policy.active_hours)) {
      return {
        allowed: false,
        reason: "outside_active_hours",
        retryAt: snapToActiveHours(now, policy.active_hours),
      };
    }
    if (policy.only_when_idle && options?.isIdle === false) {
      return { allowed: false, reason: "user_not_idle" };
    }
  }

  // Immutable Hard Cap #2: Min 4 minutes (240s) interval per source
  if (options?.sourceExternalId) {
    const srcState = state.source_states[options.sourceExternalId];
    if (srcState?.inaccessible && !options.bypassScheduleWindow) {
      return { allowed: false, reason: "source_inaccessible" };
    }
    if (
      needsPageLoad &&
      srcState?.last_crawl_at !== null &&
      srcState?.last_crawl_at !== undefined
    ) {
      const elapsed = now - srcState.last_crawl_at;
      if (elapsed < HARD_MIN_SOURCE_INTERVAL_MS) {
        return {
          allowed: false,
          reason: "source_min_interval",
          retryAt: srcState.last_crawl_at + HARD_MIN_SOURCE_INTERVAL_MS,
        };
      }
    }
  }

  return { allowed: true };
}
