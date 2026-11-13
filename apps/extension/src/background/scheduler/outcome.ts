// Recording page loads and crawl outcomes.

import {
  type ExtensionStorageState,
  pruneLoadTimestamps,
  type SourceRuntimeState,
  appendSeenPostIds,
} from "../storage";
import type { CrawlStatus, SessionState } from "../../protocol";
import { computeNextDueAt } from "./active-hours";
import { EMPTY_STREAK_DISTINCT_SOURCES_THRESHOLD, NETWORK_ERROR_BACKOFF_STEPS_MS } from "./limits";
import { applySessionSignal } from "./state-transitions";

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
