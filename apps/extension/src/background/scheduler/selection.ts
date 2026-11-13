// Selecting the next due source and the next scheduled timestamp.

import type { ExtensionStorageState, SourceRuntimeState } from "../storage";
import type { CrawlPlanEntry } from "../../protocol";
import { snapToActiveHours } from "./active-hours";
import { HARD_MIN_SOURCE_INTERVAL_MS } from "./limits";

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
