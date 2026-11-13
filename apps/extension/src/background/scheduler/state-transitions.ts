// Pause, session, and config state transitions applied to storage state.

import type { ExtensionStorageState } from "../storage";
import type { ConfigUpdatePayload, SessionState } from "../../protocol";
import { snapToActiveHours } from "./active-hours";
import { RATE_LIMIT_DOUBLE_INTERVAL_MS, RATE_LIMIT_PAUSE_MS } from "./limits";

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
