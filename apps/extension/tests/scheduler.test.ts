import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRACTOR_PROFILE } from "../src/content/extract";
import {
  applyConfigUpdate,
  applyDesktopResume,
  applySessionSignal,
  checkCrawlEligibility,
  computeNextDueAt,
  HARD_MAX_LOADS_PER_DAY,
  HARD_MAX_LOADS_PER_HOUR,
  HARD_MIN_SOURCE_INTERVAL_MS,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  RATE_LIMIT_DOUBLE_INTERVAL_MS,
  RATE_LIMIT_PAUSE_MS,
  recordCrawlOutcome,
  recordPageLoad,
  selectNextDueSource,
} from "../src/background/scheduler";
import {
  createInitialStorageState,
  createMemoryBackend,
  StorageManager,
  type ExtensionStorageState,
} from "../src/background/storage";
import type { ConfigUpdatePayload } from "../src/protocol";

function makeConnectedState(now: number): ExtensionStorageState {
  const state = createInitialStorageState(now);
  state.connection = {
    connected: true,
    desktop_available: true,
    desktop_version: "0.2.0",
    last_seen_at: now,
  };

  const cfg: ConfigUpdatePayload = {
    rev: 1,
    plan: {
      entries: [
        {
          source_ref: { platform: "facebook", kind: "group", external_id: "g_normal" },
          interval_s: 900, // 15m
          priority: 0,
          max_posts_per_visit: 30,
        },
        {
          source_ref: { platform: "facebook", kind: "group", external_id: "g_priority" },
          interval_s: 300, // 5m
          priority: 1,
          max_posts_per_visit: 30,
        },
      ],
    },
    policy: {
      // Intentionally exceed hard caps in config to prove hard caps CANNOT be overridden
      max_loads_per_hour: 500,
      max_loads_per_day: 5000,
      active_hours: { from: "00:00", to: "24:00" },
      jitter: 0.3,
      max_scroll_steps: 3,
      only_when_idle: false,
    },
    extractor: DEFAULT_EXTRACTOR_PROFILE,
  };

  applyConfigUpdate(state, cfg, now);
  return state;
}

describe("Crawl Scheduler & Immutable Hard Safety Caps (`02-extension.md §5–6`)", () => {
  it("enforces immutable 90/hour hard cap even when `config.update` requests 500/hour", () => {
    const t0 = new Date("2026-11-12T10:00:00").getTime();
    const state = makeConnectedState(t0);

    for (let i = 0; i < HARD_MAX_LOADS_PER_HOUR; i++) {
      recordPageLoad(state, t0 + i * 1_000);
    }

    const now = t0 + 120_000;
    const blocked = checkCrawlEligibility(state, now);
    expect(blocked).toEqual({
      allowed: false,
      reason: "hourly_cap_reached",
      retryAt: t0 + ONE_HOUR_MS,
    });

    // Once 1 hour passes since the oldest load, one slot opens up
    const afterWindow = t0 + ONE_HOUR_MS + 1;
    expect(checkCrawlEligibility(state, afterWindow)).toEqual({ allowed: true });
  });

  it("enforces immutable 900/day hard cap even when `config.update` requests 5000/day", () => {
    const t0 = new Date("2026-11-12T08:00:00").getTime();
    const state = makeConnectedState(t0);

    // Spread 900 loads across 15 hours (60/hr, so hourly cap is NOT hit, only daily 900 cap!)
    for (let h = 0; h < 15; h++) {
      for (let j = 0; j < 60; j++) {
        recordPageLoad(state, t0 + h * ONE_HOUR_MS + j * 10_000);
      }
    }
    expect(state.load_timestamps).toHaveLength(HARD_MAX_LOADS_PER_DAY);

    const checkAt = t0 + 15 * ONE_HOUR_MS + 30 * 60_000;
    const blocked = checkCrawlEligibility(state, checkAt);
    expect(blocked).toEqual({
      allowed: false,
      reason: "daily_cap_reached",
      retryAt: t0 + ONE_DAY_MS,
    });
  });

  it("enforces immutable 4-minute (240s) minimum source interval even with short config interval or negative jitter", () => {
    const t0 = new Date("2026-11-12T10:00:00").getTime();
    const state = makeConnectedState(t0);

    // Configure an aggressive 30s interval in config.update
    state.config.plan.entries[0]!.interval_s = 30;

    recordCrawlOutcome(
      state,
      {
        sourceExternalId: "g_normal",
        status: "ok",
        postsSeen: 5,
        seenPostIdsFromRun: ["p1", "p2"],
      },
      t0,
      () => 0, // Maximum negative jitter (-30%)
    );

    // Next due time MUST still be at least t0 + 240_000ms (4 minutes)
    expect(state.source_states["g_normal"]!.next_due_at).toBeGreaterThanOrEqual(
      t0 + HARD_MIN_SOURCE_INTERVAL_MS,
    );

    // Even a manual crawl.request (`bypassScheduleWindow: true`) within 4 minutes is blocked by hard cap
    const earlyManual = checkCrawlEligibility(state, t0 + 60_000, {
      bypassScheduleWindow: true,
      sourceExternalId: "g_normal",
      requiresNewPageLoad: true,
    });
    expect(earlyManual).toEqual({
      allowed: false,
      reason: "source_min_interval",
      retryAt: t0 + HARD_MIN_SOURCE_INTERVAL_MS,
    });

    // Allowed once 4 minutes have elapsed
    const after4m = checkCrawlEligibility(state, t0 + HARD_MIN_SOURCE_INTERVAL_MS, {
      bypassScheduleWindow: true,
      sourceExternalId: "g_normal",
      requiresNewPageLoad: true,
    });
    expect(after4m).toEqual({ allowed: true });
  });

  it("selects priority source first on tie and snaps schedules into `active_hours`", () => {
    const duePicked = makeConnectedState(new Date("2026-11-12T10:00:00").getTime());
    const chosen = selectNextDueSource(
      duePicked,
      new Date("2026-11-12T10:00:00").getTime(),
    );
    expect(chosen?.source_ref.external_id).toBe("g_priority");

    // Outside active_hours (23:30 when active_hours is 07:00-23:00)
    const lateNight = new Date("2026-11-12T23:30:00").getTime();
    duePicked.config.policy.active_hours = { from: "07:00", to: "23:00" };
    const nightCheck = checkCrawlEligibility(duePicked, lateNight);
    expect(nightCheck.allowed).toBe(false);
    if (!nightCheck.allowed) {
      expect(nightCheck.reason).toBe("outside_active_hours");
      const retryDate = new Date(nightCheck.retryAt!);
      expect(retryDate.getHours()).toBe(7);
      expect(retryDate.getMinutes()).toBe(0);
    }
  });

  it("halts immediately on `logged_out` and `checkpoint`, and requires explicit desktop `crawl.resume` after `checkpoint`", () => {
    const t0 = 1_794_384_000_000;
    const state = makeConnectedState(t0);

    // 1. logged_out halts immediately
    applySessionSignal(state, "logged_out", "Login form", t0);
    expect(checkCrawlEligibility(state, t0)).toEqual({
      allowed: false,
      reason: "session_not_ok",
    });

    // Signing back in clears `logged_out`
    applySessionSignal(state, "ok", undefined, t0 + 10_000);
    expect(checkCrawlEligibility(state, t0 + 10_000)).toEqual({ allowed: true });

    // 2. checkpoint halts AND sets `requires_desktop_resume = true`
    applySessionSignal(state, "checkpoint", "Security check", t0 + 20_000);
    expect(checkCrawlEligibility(state, t0 + 20_000)).toEqual({
      allowed: false,
      reason: "session_not_ok",
    });

    // Even if page session becomes "ok" later, checkpoint MUST NOT auto-resume!
    applySessionSignal(state, "ok", undefined, t0 + 60_000);
    expect(checkCrawlEligibility(state, t0 + 60_000)).toEqual({
      allowed: false,
      reason: "checkpoint_requires_desktop_resume",
    });

    // Explicit `crawl.resume` from desktop unlocks crawling
    applyDesktopResume(state, t0 + 120_000);
    expect(checkCrawlEligibility(state, t0 + 120_000)).toEqual({ allowed: true });
  });

  it("pauses 24h on `rate_limited` and doubles crawl intervals for 7 days after resuming", () => {
    const t0 = new Date("2026-11-12T10:00:00").getTime();
    const state = makeConnectedState(t0);

    applySessionSignal(state, "rate_limited", "Temporary block", t0);

    // Blocked during the 24h cooldown
    expect(checkCrawlEligibility(state, t0 + 12 * ONE_HOUR_MS).allowed).toBe(false);

    // At 24h + 1s: 24h pause expires and crawling resumes in 2x interval recovery mode
    const after24h = t0 + RATE_LIMIT_PAUSE_MS + 1_000;
    expect(checkCrawlEligibility(state, after24h)).toEqual({ allowed: true });

    const entry = state.config.plan.entries[0]!; // base interval_s = 900s (15m)
    const nextDueRecovery = computeNextDueAt(
      after24h,
      entry,
      state.config.policy,
      state,
      () => 0.5, // zero jitter
    );
    // Doubled: 900s * 2 = 1800s (30m)
    expect(nextDueRecovery - after24h).toBe(1_800 * 1_000);

    // After 7 more days, normal 900s interval is restored
    const after7Days = t0 + RATE_LIMIT_PAUSE_MS + RATE_LIMIT_DOUBLE_INTERVAL_MS + 1_000;
    expect(checkCrawlEligibility(state, after7Days)).toEqual({ allowed: true });
    const nextDueNormal = computeNextDueAt(
      after7Days,
      entry,
      state.config.policy,
      state,
      () => 0.5,
    );
    expect(nextDueNormal - after7Days).toBe(900 * 1_000);
  });

  it("handles inaccessible groups, 3 consecutive network errors (5m/15m/60m backoff), and 3 empty crawls across sources", async () => {
    const storage = new StorageManager(createMemoryBackend());
    const t0 = new Date("2026-11-12T10:00:00").getTime();

    await storage.update((s) => {
      Object.assign(s, makeConnectedState(t0));
      s.config.plan.entries.push({
        source_ref: { platform: "facebook", kind: "group", external_id: "g_third" },
        interval_s: 900,
        priority: 0,
        max_posts_per_visit: 30,
      });
      applyConfigUpdate(s, s.config, t0);
    }, t0);

    // 1. Inaccessible group marked & skipped in future schedules
    await storage.update((s) => {
      const res = recordCrawlOutcome(
        s,
        {
          sourceExternalId: "g_priority",
          status: "error",
          postsSeen: 0,
          seenPostIdsFromRun: [],
          inaccessible: true,
          error: "Group deleted",
        },
        t0,
      );
      expect(res.reportStatus).toBe("error");
    }, t0);

    const stateAfterInaccessible = await storage.read(t0);
    expect(stateAfterInaccessible.source_states["g_priority"]?.inaccessible).toBe(true);
    expect(selectNextDueSource(stateAfterInaccessible, t0)?.source_ref.external_id).toBe(
      "g_normal",
    );

    // 2. Three consecutive network errors -> 5m, 15m, 60m progressive backoff
    await storage.update((s) => {
      recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "error", postsSeen: 0, seenPostIdsFromRun: [], networkError: true },
        t0 + 1_000,
      );
      expect(s.anomalies.network_backoff_until).toBeNull();

      recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "error", postsSeen: 0, seenPostIdsFromRun: [], networkError: true },
        t0 + 2_000,
      );
      expect(s.anomalies.network_backoff_until).toBeNull();

      // 3rd error -> +5m
      recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "error", postsSeen: 0, seenPostIdsFromRun: [], networkError: true },
        t0 + 3_000,
      );
      expect(s.anomalies.network_backoff_until).toBe(t0 + 3_000 + 5 * 60_000);

      // 4th error -> +15m
      recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "error", postsSeen: 0, seenPostIdsFromRun: [], networkError: true },
        t0 + 4_000,
      );
      expect(s.anomalies.network_backoff_until).toBe(t0 + 4_000 + 15 * 60_000);

      // 5th error -> +60m
      recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "error", postsSeen: 0, seenPostIdsFromRun: [], networkError: true },
        t0 + 5_000,
      );
      expect(s.anomalies.network_backoff_until).toBe(t0 + 5_000 + 60 * 60_000);
    }, t0 + 5_000);

    // 3. Three consecutive `empty` crawls across distinct sources -> `status: "empty"` & `extractorBrokenAlert: true`
    await storage.update((s) => {
      s.source_states["g_priority"]!.inaccessible = false;

      const e1 = recordCrawlOutcome(
        s,
        { sourceExternalId: "g_normal", status: "empty", postsSeen: 0, seenPostIdsFromRun: [] },
        t0 + 4 * ONE_HOUR_MS,
      );
      expect(e1.reportStatus).toBe("empty");
      expect(e1.extractorBrokenAlert).toBe(false);

      const e2 = recordCrawlOutcome(
        s,
        { sourceExternalId: "g_priority", status: "empty", postsSeen: 0, seenPostIdsFromRun: [] },
        t0 + 4 * ONE_HOUR_MS + 1_000,
      );
      expect(e2.reportStatus).toBe("empty");
      expect(e2.extractorBrokenAlert).toBe(false);

      const e3 = recordCrawlOutcome(
        s,
        { sourceExternalId: "g_third", status: "empty", postsSeen: 0, seenPostIdsFromRun: [] },
        t0 + 4 * ONE_HOUR_MS + 2_000,
      );
      expect(e3.reportStatus).toBe("empty");
      expect(e3.extractorBrokenAlert).toBe(true);
    }, t0 + 4 * ONE_HOUR_MS + 2_000);
  });
});
