// Scheduler alarm sync and periodic tick.

import type { ExtensionStorageState } from "./storage";
import {
  getNextScheduledTimestamp,
  refreshExpiredPauseState,
  checkCrawlEligibility,
  selectNextDueSource,
} from "./scheduler";
import { ALARM_SCHEDULER, storage } from "./context";
import { cleanupOrphanedCrawlTab, executeActiveCrawl } from "./crawl";
import { queryUserIdleState } from "./tabs";

// ── Scheduler Alarm & Tick ──

export async function syncSchedulerAlarm(
  state: ExtensionStorageState,
  now: number,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  const nextTs = state.automatic_scanning ? getNextScheduledTimestamp(state, now) : null;
  if (nextTs === null) {
    await chrome.alarms.clear(ALARM_SCHEDULER);
    return;
  }
  await chrome.alarms.create(ALARM_SCHEDULER, {
    when: Math.max(now + 2_000, nextTs),
  });
}

export async function runSchedulerTick(): Promise<void> {
  const now = Date.now();
  await cleanupOrphanedCrawlTab(now);

  const isIdle = await queryUserIdleState();
  const state = await storage.update((s) => {
    refreshExpiredPauseState(s, now);
    return s;
  }, now);

  if (!state.automatic_scanning) return;

  const eligibility = checkCrawlEligibility(state, now, { isIdle });
  if (!eligibility.allowed) {
    if (eligibility.retryAt && typeof chrome !== "undefined" && chrome.alarms) {
      await chrome.alarms.create(ALARM_SCHEDULER, {
        when: Math.max(now + 5_000, eligibility.retryAt),
      });
    }
    return;
  }

  const dueEntry = selectNextDueSource(state, now);
  if (!dueEntry) {
    await syncSchedulerAlarm(state, now);
    return;
  }

  void executeActiveCrawl({
    sourceRef: dueEntry.source_ref,
    reason: "scheduled",
    maxPosts: dueEntry.max_posts_per_visit || 30,
    bypassScheduleWindow: false,
  });
}
