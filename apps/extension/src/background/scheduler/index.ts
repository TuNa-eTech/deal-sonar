// Crawl Scheduler & Immutable Hard Safety Caps (`02-extension.md §5–6` & P2–P4 safety).
// Enforces hard caps (`90/hr`, `900/day`, `4m` min interval, halt on `session.state !== "ok"`)
// strictly and independently of any `config.update` received from desktop.

export {
  HARD_MAX_LOADS_PER_HOUR,
  HARD_MAX_LOADS_PER_DAY,
  HARD_MIN_SOURCE_INTERVAL_S,
  HARD_MIN_SOURCE_INTERVAL_MS,
  ONE_HOUR_MS,
  ONE_DAY_MS,
  RATE_LIMIT_PAUSE_MS,
  RATE_LIMIT_DOUBLE_INTERVAL_MS,
  NETWORK_ERROR_BACKOFF_STEPS_MS,
  EMPTY_STREAK_DISTINCT_SOURCES_THRESHOLD,
  getEffectiveMaxLoadsPerHour,
  getEffectiveMaxLoadsPerDay,
  isRateLimitRecoveryActive,
  getEffectiveSourceIntervalS,
} from "./limits";
export { isWithinActiveHours, snapToActiveHours, computeNextDueAt } from "./active-hours";
export {
  refreshExpiredPauseState,
  applyConfigUpdate,
  applySessionSignal,
  applyDesktopPause,
  applyDesktopResume,
} from "./state-transitions";
export { countLoadsInLastHour, countLoadsInLastDay, checkCrawlEligibility } from "./eligibility";
export type { CrawlBlockReason, CrawlEligibility } from "./eligibility";
export { selectNextDueSource, getNextScheduledTimestamp } from "./selection";
export { recordPageLoad, recordCrawlOutcome } from "./outcome";
export type { CrawlOutcomeInput, CrawlOutcomeSummary } from "./outcome";
