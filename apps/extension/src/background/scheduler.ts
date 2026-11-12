// Crawl Scheduler & Immutable Hard Safety Caps (`02-extension.md §5–6` & P2–P4 safety).
// Enforces hard caps (`90/hr`, `900/day`, `4m` min interval, halt on `session.state !== "ok"`)
// strictly and independently of any `config.update` received from desktop.

import type {
  ActiveHours,
  ConfigUpdatePayload,
  CrawlPlanEntry,
  CrawlPolicy,
  CrawlStatus,
  SessionState,
} from "../protocol";
import {
  appendSeenPostIds,
  pruneLoadTimestamps,
  type ExtensionStorageState,
  type SourceRuntimeState,
} from "./storage";

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

// ── State Transitions & Pause Expiration ──

/** Expire timed pauses (including 24h `rate_limited` pause) when `now >= until` unless locked by `checkpoint`. */
export function refreshExpiredPauseState(state: ExtensionStorageState, now: number): void {
  if (
    state.anomalies.network_backoff_until !== null &&
    now >= state.anomalies.network_backoff_until
  ) {
    state.anomalies.network_backoff_until = null;
  }

  if (
    state.anomalies.rate_limit_recovery_until !== null &&
    now >= state.anomalies.rate_limit_recovery_until
  ) {
    state.anomalies.rate_limit_recovery_until = null;
  }

  if (!state.pause.paused || state.pause.requires_desktop_resume) {
    return;
  }

  if (state.pause.until !== null && now >= state.pause.until) {
    const wasRateLimit = state.pause.reason === "rate_limited";
    state.pause = {
      paused: false,
      until: null,
      reason: null,
      requires_desktop_resume: false,
    };
    // After completing the mandatory 24h rate-limit pause, allow resuming at 2x intervals for 7 days
    if (wasRateLimit && state.session.state === "rate_limited") {
      state.session = {
        state: "ok",
        updated_at: now,
      };
    }
  }
}

export function applyConfigUpdate(
  state: ExtensionStorageState,
  update: ConfigUpdatePayload,
  now: number,
): void {
  state.config = update;
  for (const entry of update.plan.entries) {
    const extId = entry.source_ref.external_id;
    const existing = state.source_states[extId];
    if (!existing) {
      state.source_states[extId] = {
        last_crawl_at: null,
        next_due_at: snapToActiveHours(now, update.policy.active_hours),
        inaccessible: false,
      };
    }
  }
  // Remove optimistic IDs that are now persisted in the official plan
  const planIds = new Set(update.plan.entries.map((e) => e.source_ref.external_id));
  state.optimistic_followed_ids = state.optimistic_followed_ids.filter(
    (id) => !planIds.has(id),
  );
}

/** Apply Facebook session state transitions & anomaly halts (`02-extension.md §6.4`). */
export function applySessionSignal(
  state: ExtensionStorageState,
  nextState: SessionState,
  detail: string | undefined,
  now: number,
): { stateChanged: boolean } {
  const prevState = state.session.state;
  state.session = {
    state: nextState,
    updated_at: now,
  };
  if (detail !== undefined) {
    state.session.detail = detail;
  }

  if (nextState === "logged_out") {
    state.pause = {
      paused: true,
      until: null,
      reason: "logged_out",
      requires_desktop_resume: state.pause.requires_desktop_resume,
    };
  } else if (nextState === "checkpoint") {
    // Checkpoint MUST NOT auto-resume; requires explicit desktop `crawl.resume`
    state.pause = {
      paused: true,
      until: null,
      reason: "checkpoint",
      requires_desktop_resume: true,
    };
  } else if (nextState === "rate_limited") {
    const pauseUntil = now + RATE_LIMIT_PAUSE_MS;
    state.pause = {
      paused: true,
      until: pauseUntil,
      reason: "rate_limited",
      requires_desktop_resume: state.pause.requires_desktop_resume,
    };
    state.anomalies.rate_limit_recovery_until =
      pauseUntil + RATE_LIMIT_DOUBLE_INTERVAL_MS;
  } else if (nextState === "ok") {
    // Auto-clear `logged_out` pause when user signs back in, NEVER auto-clear `checkpoint`!
    if (
      state.pause.paused &&
      state.pause.reason === "logged_out" &&
      !state.pause.requires_desktop_resume
    ) {
      state.pause = {
        paused: false,
        until: null,
        reason: null,
        requires_desktop_resume: false,
      };
    }
  }

  return { stateChanged: prevState !== nextState };
}

export function applyDesktopPause(
  state: ExtensionStorageState,
  until: number | null,
  reason: string,
): void {
  state.pause = {
    paused: true,
    until,
    reason,
    requires_desktop_resume: state.pause.requires_desktop_resume,
  };
}

/** Explicit `crawl.resume` from desktop clears pause AND unlocks `checkpoint` hold. */
export function applyDesktopResume(state: ExtensionStorageState, now: number): void {
  const wasCheckpointOrSession =
    state.pause.requires_desktop_resume || state.session.state !== "ok";
  state.pause = {
    paused: false,
    until: null,
    reason: null,
    requires_desktop_resume: false,
  };
  if (wasCheckpointOrSession && state.session.state !== "ok") {
    state.session = {
      state: "ok",
      updated_at: now,
    };
  }
}

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

/**
 * Pick the next due source from `config.plan.entries` (`02-extension.md §5.1`):
 * earliest `next_due_at` first; higher `priority` breaks ties; skips inaccessible
 * or `< 4 min` cooldown sources.
 */
export function selectNextDueSource(
  state: ExtensionStorageState,
  now: number,
): CrawlPlanEntry | null {
  const candidates: Array<{ entry: CrawlPlanEntry; dueAt: number }> = [];

  for (const entry of state.config.plan.entries) {
    const extId = entry.source_ref.external_id;
    const srcState: SourceRuntimeState = state.source_states[extId] ?? {
      last_crawl_at: null,
      next_due_at: 0,
      inaccessible: false,
    };

    if (srcState.inaccessible) continue;

    const minAllowedAt =
      srcState.last_crawl_at !== null
        ? srcState.last_crawl_at + HARD_MIN_SOURCE_INTERVAL_MS
        : 0;
    const effectiveDueAt = Math.max(srcState.next_due_at, minAllowedAt);

    if (effectiveDueAt <= now) {
      candidates.push({ entry, dueAt: effectiveDueAt });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return b.entry.priority - a.entry.priority;
  });

  return candidates[0]?.entry ?? null;
}

/** Compute the earliest upcoming scheduled crawl timestamp across all accessible sources. */
export function getNextScheduledTimestamp(
  state: ExtensionStorageState,
  now: number,
): number | null {
  if (state.config.plan.entries.length === 0) return null;
  if (state.session.state !== "ok" || state.pause.requires_desktop_resume) {
    return null;
  }
  if (state.pause.paused && state.pause.until === null) {
    return null;
  }

  let earliest: number | null = null;
  for (const entry of state.config.plan.entries) {
    const extId = entry.source_ref.external_id;
    const srcState = state.source_states[extId];
    if (srcState?.inaccessible) continue;

    const minAllowed =
      srcState?.last_crawl_at != null
        ? srcState.last_crawl_at + HARD_MIN_SOURCE_INTERVAL_MS
        : now;
    const due = Math.max(srcState?.next_due_at ?? now, minAllowed, now);
    const snapped = snapToActiveHours(due, state.config.policy.active_hours);
    if (earliest === null || snapped < earliest) {
      earliest = snapped;
    }
  }

  if (earliest === null) return null;
  if (state.pause.paused && state.pause.until !== null) {
    earliest = Math.max(earliest, state.pause.until);
  }
  if (state.anomalies.network_backoff_until !== null) {
    earliest = Math.max(earliest, state.anomalies.network_backoff_until);
  }
  return earliest;
}

export function recordPageLoad(state: ExtensionStorageState, now: number): void {
  state.load_timestamps = pruneLoadTimestamps([...state.load_timestamps, now], now);
}

// ── Recording Completed Crawl Outcomes & Anomalies ──

export type CrawlOutcomeInput = {
  sourceExternalId: string;
  status: CrawlStatus;
  postsSeen: number;
  seenPostIdsFromRun: readonly string[];
  session?: { state: SessionState; detail?: string };
  inaccessible?: boolean;
  networkError?: boolean;
  error?: string;
  isPassive?: boolean;
};

export type CrawlOutcomeSummary = {
  reportStatus: CrawlStatus;
  newPostIds: string[];
  sessionChanged: boolean;
  extractorBrokenAlert: boolean;
};

export function recordCrawlOutcome(
  state: ExtensionStorageState,
  outcome: CrawlOutcomeInput,
  now: number,
  rng: () => number = Math.random,
): CrawlOutcomeSummary {
  const extId = outcome.sourceExternalId;
  const planEntry = state.config.plan.entries.find(
    (e) => e.source_ref.external_id === extId,
  );

  const srcState: SourceRuntimeState = state.source_states[extId] ?? {
    last_crawl_at: null,
    next_due_at: now,
    inaccessible: false,
  };
  state.source_states[extId] = srcState;

  // Deduplicate against 200 recent `post_id`s stored per source (`02-extension.md §5.4`)
  const prevSeen = new Set(state.seen_post_ids[extId] ?? []);
  const newPostIds: string[] = [];
  for (const id of outcome.seenPostIdsFromRun) {
    if (id && !prevSeen.has(id)) {
      prevSeen.add(id);
      newPostIds.push(id);
    }
  }
  if (outcome.seenPostIdsFromRun.length > 0) {
    state.seen_post_ids[extId] = appendSeenPostIds(
      state.seen_post_ids[extId],
      outcome.seenPostIdsFromRun,
    );
  }

  let sessionChanged = false;
  if (outcome.session && outcome.session.state !== "ok") {
    const res = applySessionSignal(
      state,
      outcome.session.state,
      outcome.session.detail,
      now,
    );
    sessionChanged = res.stateChanged;
    return {
      reportStatus: "blocked",
      newPostIds,
      sessionChanged,
      extractorBrokenAlert: false,
    };
  }

  if (outcome.inaccessible) {
    srcState.inaccessible = true;
    srcState.last_error = outcome.error ?? "group_inaccessible";
    state.anomalies.consecutive_network_errors = 0;
    return {
      reportStatus: "error",
      newPostIds: [],
      sessionChanged: false,
      extractorBrokenAlert: false,
    };
  }

  if (outcome.networkError) {
    state.anomalies.consecutive_network_errors += 1;
    srcState.last_error = outcome.error ?? "network_error";
    if (state.anomalies.consecutive_network_errors >= 3) {
      const idx = Math.min(
        state.anomalies.consecutive_network_errors - 3,
        NETWORK_ERROR_BACKOFF_STEPS_MS.length - 1,
      );
      const backoffMs = NETWORK_ERROR_BACKOFF_STEPS_MS[idx]!;
      state.anomalies.network_backoff_until = now + backoffMs;
    }
    if (planEntry && !outcome.isPassive) {
      srcState.last_crawl_at = now;
      srcState.next_due_at = computeNextDueAt(
        now,
        planEntry,
        state.config.policy,
        state,
        rng,
      );
    }
    return {
      reportStatus: "error",
      newPostIds: [],
      sessionChanged: false,
      extractorBrokenAlert: false,
    };
  }

  // Page loaded cleanly without network error
  state.anomalies.consecutive_network_errors = 0;
  state.anomalies.network_backoff_until = null;
  delete srcState.last_error;

  if (!outcome.isPassive) {
    srcState.last_crawl_at = now;
    state.last_crawl_at = now;
    if (planEntry) {
      srcState.next_due_at = computeNextDueAt(
        now,
        planEntry,
        state.config.policy,
        state,
        rng,
      );
    }
  } else {
    state.last_crawl_at = now;
  }

  if (outcome.postsSeen === 0 || outcome.status === "empty") {
    if (!outcome.isPassive) {
      state.anomalies.empty_streak_count += 1;
      if (!state.anomalies.empty_streak_sources.includes(extId)) {
        state.anomalies.empty_streak_sources.push(extId);
      }
      if (
        state.anomalies.empty_streak_sources.length >=
        EMPTY_STREAK_DISTINCT_SOURCES_THRESHOLD
      ) {
        state.anomalies.extractor_broken = true;
      }
    }
    return {
      reportStatus: "empty",
      newPostIds: [],
      sessionChanged: false,
      extractorBrokenAlert: state.anomalies.extractor_broken,
    };
  }

  // Posts successfully extracted -> clear empty streak
  state.anomalies.empty_streak_count = 0;
  state.anomalies.empty_streak_sources = [];
  state.anomalies.extractor_broken = false;

  return {
    reportStatus: "ok",
    newPostIds,
    sessionChanged: false,
    extractorBrokenAlert: false,
  };
}
