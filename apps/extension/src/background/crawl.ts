// Active crawl execution, result finalization, and passive capture (`02-extension.md §5`).

import {
  type SourceRef,
  type CrawlReason,
  generateUlid,
  type ExtractionStrategy,
  type SessionState,
  type RawPost,
} from "../protocol";
import type { QuickScanOptions } from "../scan-options";
import { checkCrawlEligibility, recordPageLoad, recordCrawlOutcome } from "./scheduler";
import { detectSessionFromUrl } from "../content/drive";
import { resolveSessionMarkers } from "../content/extract";
import type { BgCrawlExecuteMessage, CrawlPageResult } from "../messages";
import { updateActionBadge } from "./badge";
import {
  ALARM_TAB_SAFETY_PREFIX,
  CRAWL_EXECUTION_DEADLINE_MS,
  getQueue,
  MAX_TAB_LIFETIME_MS,
  runtime,
  storage,
} from "./context";
import { emitSessionStatusDirect, flushOutboundQueue } from "./native-port";
import { syncSchedulerAlarm } from "./scheduler-tick";
import {
  findCurrentGroupTab,
  findExistingUserGroupTab,
  queryUserIdleState,
  safeCloseTab,
  sleepWithAbort,
  waitForTabComplete,
} from "./tabs";

export async function cleanupOrphanedCrawlTab(now: number = Date.now()): Promise<void> {
  const state = await storage.read(now);
  if (!state.active_crawl) return;

  const age = now - state.active_crawl.opened_at;
  if (age >= MAX_TAB_LIFETIME_MS || runtime.activeCrawlAbort === null) {
    const orphanTabId = state.active_crawl.owned_tab
      ? state.active_crawl.tab_id
      : null;
    await storage.update((s) => {
      s.active_crawl = null;
    }, now);
    await safeCloseTab(orphanTabId);
  }
}

function crawlBlockMessage(reason: string | undefined): string {
  const messages: Record<string, string> = {
    desktop_disconnected: "Hãy mở DealSonar trên máy tính và kết nối lại.",
    session_not_ok: "Hãy kiểm tra đăng nhập hoặc xác minh trên Facebook.",
    checkpoint_requires_desktop_resume: "Hãy tiếp tục quét trong ứng dụng DealSonar sau khi xác minh.",
    paused: "Đang tạm dừng. Hãy bấm Tiếp tục quét trước.",
    network_backoff: "Kết nối đang gặp lỗi. Vui lòng thử lại sau.",
    already_crawling: "Đang có một lượt quét khác. Vui lòng chờ.",
    hourly_cap_reached: "Đã đạt giới hạn tải trang trong giờ. Vui lòng thử lại sau.",
    daily_cap_reached: "Đã đạt giới hạn tải trang trong ngày. Vui lòng thử lại sau.",
    source_min_interval: "Nhóm này vừa được quét. Hãy chờ ít nhất 4 phút giữa các lần tải mới.",
  };
  return messages[reason ?? ""] ?? "Chưa thể quét lúc này. Vui lòng thử lại sau.";
}

export async function executeActiveCrawl(params: {
  sourceRef: SourceRef;
  reason: CrawlReason;
  maxPosts: number;
  bypassScheduleWindow: boolean;
  manualOptions?: QuickScanOptions;
}): Promise<{ ok: boolean; error?: string }> {
  if (runtime.activeCrawlAbort !== null) return { ok: false, error: "Đang có một lượt quét khác. Vui lòng chờ." };

  const startedAt = Date.now();
  const runId = generateUlid(startedAt);
  const extId = params.sourceRef.external_id;

  const existingTab = params.manualOptions?.mode === "background" ? null
    : params.manualOptions?.mode === "current_tab" ? await findCurrentGroupTab(extId)
    : await findExistingUserGroupTab(extId);
  if (params.manualOptions?.mode === "current_tab" && !existingTab) {
    return { ok: false, error: "Hãy mở đúng nhóm đã chọn ở tab hiện tại hoặc chọn quét bằng tab nền." };
  }
  const ownedTab = existingTab === null;
  const isIdle = await queryUserIdleState();

  const reservation = await storage.update((state) => {
    if (params.reason === "scheduled" && !state.automatic_scanning) {
      return { allowed: false as const, state, reason: "automatic_disabled" };
    }
    const eligibility = checkCrawlEligibility(state, startedAt, {
      bypassScheduleWindow: params.bypassScheduleWindow,
      sourceExternalId: extId,
      requiresNewPageLoad: ownedTab,
      isIdle,
    });
    if (!eligibility.allowed) {
      return { allowed: false as const, state, reason: eligibility.reason };
    }
    if (ownedTab) {
      recordPageLoad(state, startedAt);
    }
    state.active_crawl = {
      run_id: runId,
      source_external_id: extId,
      tab_id: existingTab?.id ?? null,
      owned_tab: ownedTab,
      opened_at: startedAt,
    };
    return { allowed: true as const, state };
  }, startedAt);

  if (!reservation.allowed) {
    await syncSchedulerAlarm(reservation.state, startedAt);
    return { ok: false, error: crawlBlockMessage(reservation.reason) };
  }

  const abortController = new AbortController();
  runtime.activeCrawlAbort = abortController;
  const deadlineTimer = setTimeout(
    () => abortController.abort(),
    CRAWL_EXECUTION_DEADLINE_MS,
  );

  let tabId: number | null = existingTab?.id ?? null;
  const pageLoads = ownedTab ? 1 : 0;
  const configSnapshot = reservation.state.config;
  const seenBefore = reservation.state.seen_post_ids[extId] ?? [];
  const defaultStrategy: ExtractionStrategy =
    configSnapshot.extractor.strategies[0] ?? "network";

  try {
    if (ownedTab) {
      const targetUrl = `https://www.facebook.com/groups/${encodeURIComponent(extId)}/?sorting_setting=CHRONOLOGICAL`;
      const createdTab = await chrome.tabs.create({
        url: targetUrl,
        active: false,
      });
      tabId = createdTab.id ?? null;
      if (tabId === null) {
        throw new Error("Không thể mở tab quét nền");
      }

      // Persist tabId & arm 60s alarm safety net (`02-extension.md §5.6`)
      await storage.update((s) => {
        if (s.active_crawl && s.active_crawl.run_id === runId) {
          s.active_crawl.tab_id = tabId;
        }
      });
      await chrome.alarms.create(`${ALARM_TAB_SAFETY_PREFIX}${tabId}`, {
        when: startedAt + MAX_TAB_LIFETIME_MS,
      });

      const loadedTab = await waitForTabComplete(
        tabId,
        25_000,
        abortController.signal,
      );

      // Check URL-level login/checkpoint redirects (`02-extension.md §2`)
      const urlSession = detectSessionFromUrl(
        loadedTab.url ?? "",
        resolveSessionMarkers(configSnapshot.extractor.session_markers),
      );
      if (urlSession && urlSession.state !== "ok") {
        const endedAt = Date.now();
        await finalizeCrawlResult({
          runId,
          sourceRef: params.sourceRef,
          reason: params.reason,
          startedAt,
          endedAt,
          pageLoads,
          result: {
            status: "blocked",
            session: urlSession,
            posts: [],
            strategy: defaultStrategy,
            error: urlSession.detail,
          },
          networkError: false,
        });
        return { ok: true };
      }

      // Wait random 2–5s jitter after document_idle (`02-extension.md §5.4`)
      const jitterWaitMs = Math.round(2_000 + Math.random() * 3_000);
      await sleepWithAbort(jitterWaitMs, abortController.signal);
    }

    if (tabId === null) {
      throw new Error("Không tìm thấy tab group hợp lệ");
    }

    // Reusing a user's open tab never scrolls their viewport (`maxScrollSteps: 0`)
    const maxScrollSteps = ownedTab
      ? Math.max(0, Math.min(params.manualOptions?.maxScrollSteps ?? configSnapshot.policy.max_scroll_steps, 5))
      : 0;

    const execMsg: BgCrawlExecuteMessage = {
      kind: "dealsonar:crawl-execute",
      sourceRef: params.sourceRef,
      maxPosts: params.maxPosts,
      maxScrollSteps,
      seenPostIds: seenBefore,
      extractor: configSnapshot.extractor,
    };

    const pageResult = (await chrome.tabs.sendMessage(
      tabId,
      execMsg,
    )) as CrawlPageResult | undefined;

    if (!pageResult) {
      throw new Error("Content script không phản hồi");
    }

    const endedAt = Date.now();
    await finalizeCrawlResult({
      runId,
      sourceRef: params.sourceRef,
      reason: ownedTab ? params.reason : "passive",
      startedAt,
      endedAt,
      pageLoads,
      result: pageResult,
      networkError: false,
    });
  } catch (err) {
    const endedAt = Date.now();
    const errMsg = err instanceof Error ? err.message : String(err);

    // Check if failure was actually due to redirect outside `/groups/*` (where content script doesn't inject)
    let redirectSession: { state: SessionState; detail?: string } | null = null;
    if (tabId !== null) {
      try {
        const latestTab = await chrome.tabs.get(tabId);
        redirectSession = detectSessionFromUrl(
          latestTab.url ?? "",
          resolveSessionMarkers(configSnapshot.extractor.session_markers),
        );
      } catch {
        // Tab already closed
      }
    }

    if (redirectSession && redirectSession.state !== "ok") {
      await finalizeCrawlResult({
        runId,
        sourceRef: params.sourceRef,
        reason: params.reason,
        startedAt,
        endedAt,
        pageLoads,
        result: {
          status: "blocked",
          session: redirectSession,
          posts: [],
          strategy: defaultStrategy,
          error: redirectSession.detail,
        },
        networkError: false,
      });
    } else {
      await finalizeCrawlResult({
        runId,
        sourceRef: params.sourceRef,
        reason: params.reason,
        startedAt,
        endedAt,
        pageLoads,
        result: {
          status: "error",
          session: { state: "ok" },
          posts: [],
          strategy: defaultStrategy,
          error: errMsg,
        },
        networkError: errMsg !== "crawl_aborted",
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    runtime.activeCrawlAbort = null;
    if (ownedTab) {
      await safeCloseTab(tabId);
    }
    const finalState = await storage.update((s) => {
      if (s.active_crawl?.run_id === runId) {
        s.active_crawl = null;
      }
      return s;
    });
    await updateActionBadge(finalState);
    await syncSchedulerAlarm(finalState, Date.now());
  }
  return { ok: true };
}

async function finalizeCrawlResult(args: {
  runId: string;
  sourceRef: SourceRef;
  reason: CrawlReason;
  startedAt: number;
  endedAt: number;
  pageLoads: number;
  result: CrawlPageResult;
  networkError: boolean;
}): Promise<void> {
  const { runId, sourceRef, reason, startedAt, endedAt, pageLoads, result } = args;
  const extId = sourceRef.external_id;

  const { summary, newPosts } = await storage.update((state) => {
    const prevSeenSet = new Set(state.seen_post_ids[extId] ?? []);
    const freshPosts = result.posts.filter((p) => !prevSeenSet.has(p.post_id));

    const outcomeSummary = recordCrawlOutcome(
      state,
      {
        sourceExternalId: extId,
        status: result.status,
        postsSeen: result.posts.length,
        seenPostIdsFromRun: result.posts.map((p) => p.post_id),
        session: result.session,
        inaccessible: result.inaccessible,
        networkError: args.networkError,
        error: result.error,
        isPassive: reason === "passive",
      },
      endedAt,
    );

    state.last_scan = {
      sourceExternalId: extId, status: outcomeSummary.reportStatus,
      postsSeen: result.posts.length, postsNew: freshPosts.length,
      endedAt, error: result.error,
    };
    return { summary: outcomeSummary, newPosts: freshPosts };
  }, endedAt);

  // Send `session.status` on any session error (`01-protocol.md §4.1`)
  if (result.session.state !== "ok") {
    await emitSessionStatusDirect(result.session.state, result.session.detail);
  }

  // Enqueue new posts via durable IndexedDB queue (`<= 100` posts & `<= 512 KB` chunks)
  if (newPosts.length > 0 && summary.reportStatus === "ok") {
    await getQueue().enqueuePostsPush(runId, sourceRef, newPosts, endedAt);
  }

  // Enqueue `crawl.report` via durable IndexedDB queue
  await getQueue().enqueueCrawlReport(
    {
      run_id: runId,
      source_ref: sourceRef,
      reason,
      status: summary.reportStatus,
      started_at: startedAt,
      ended_at: endedAt,
      posts_seen: result.posts.length,
      posts_new: newPosts.length,
      page_loads: pageLoads,
      strategy: result.strategy,
      ...(result.error ? { error: result.error } : {}),
    },
    endedAt,
  );

  await flushOutboundQueue();
}

export async function handlePassiveCapture(
  sourceRef: SourceRef,
  posts: RawPost[],
  strategy: ExtractionStrategy,
): Promise<number> {
  const now = Date.now();
  const runId = generateUlid(now);
  const extId = sourceRef.external_id;

  const freshPosts = await storage.update((state) => {
    const seen = new Set(state.seen_post_ids[extId] ?? []);
    const fresh = posts.filter((p) => !seen.has(p.post_id));
    recordCrawlOutcome(
      state,
      {
        sourceExternalId: extId,
        status: posts.length > 0 ? "ok" : "empty",
        postsSeen: posts.length,
        seenPostIdsFromRun: posts.map((p) => p.post_id),
        isPassive: true,
      },
      now,
    );
    return fresh;
  }, now);

  if (freshPosts.length === 0) return 0;

  await getQueue().enqueuePostsPush(runId, sourceRef, freshPosts, now);
  await getQueue().enqueueCrawlReport(
    {
      run_id: runId,
      source_ref: sourceRef,
      reason: "passive",
      status: "ok",
      started_at: now,
      ended_at: now,
      posts_seen: posts.length,
      posts_new: freshPosts.length,
      page_loads: 0,
      strategy,
    },
    now,
  );
  await flushOutboundQueue();
  return freshPosts.length;
}
