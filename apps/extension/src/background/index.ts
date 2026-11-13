// Background Service Worker (`01-protocol.md §3, §5, §7` & `02-extension.md §5–9`).
// Manages persistent Native Messaging port, durable IndexedDB outbound queue,
// crawl scheduler with immutable hard safety caps, active crawl tabs, and popup/content IPC.

import { detectSessionFromUrl } from "../content/drive";
import {
  DEFAULT_EXTRACTOR_PROFILE,
  extractGroupSlugOrIdFromUrl,
  resolveSessionMarkers,
} from "../content/extract";
import type {
  BgCrawlExecuteMessage,
  ContentInitResponse,
  CrawlPageResult,
  PopupStatusSnapshot,
  PageContextResponse,
  RuntimeMessage,
} from "../messages";
import {
  createEnvelope,
  generateUlid,
  NATIVE_HOST,
  parseDesktopEnvelope,
  PROTOCOL_VERSION,
  replyEnvelope,
  type CrawlReason,
  type DesktopEnvelope,
  type ExtEnvelope,
  type ExtractionStrategy,
  type RawPost,
  type SessionState,
  type SourceRef,
} from "../protocol";
import { isQuickScanOptions, type QuickScanOptions } from "../scan-options";
import { OutboundQueue } from "./queue";
import {
  applyConfigUpdate,
  applyDesktopPause,
  applyDesktopResume,
  applySessionSignal,
  checkCrawlEligibility,
  countLoadsInLastHour,
  getEffectiveMaxLoadsPerHour,
  getNextScheduledTimestamp,
  recordCrawlOutcome,
  recordPageLoad,
  refreshExpiredPauseState,
  selectNextDueSource,
} from "./scheduler";
import { StorageManager, type ExtensionStorageState } from "./storage";

const ALARM_KEEPALIVE = "dealsonar:keepalive";
const ALARM_SCHEDULER = "dealsonar:scheduler";
const ALARM_QUEUE_RETRY = "dealsonar:queue-retry";
const ALARM_TAB_SAFETY_PREFIX = "dealsonar:tab-close:";

const PING_IDLE_INTERVAL_MS = 25_000; // 25s idle ping (`01-protocol.md §4.1`)
const MAX_TAB_LIFETIME_MS = 60_000; // Hard 60s tab lifetime cap (`02-extension.md §5.6`)
const CRAWL_EXECUTION_DEADLINE_MS = 54_000; // Leave 6s headroom before 60s hard tab close

const storage = new StorageManager();
let outboundQueue: OutboundQueue | null = null;

function getQueue(): OutboundQueue {
  if (!outboundQueue) {
    outboundQueue = new OutboundQueue();
  }
  return outboundQueue;
}

// ── Native Messaging Port Management (`01-protocol.md §1, §3, §7`) ──

let nativePort: chrome.runtime.Port | null = null;
let lastPortTrafficAt = 0;
let pingIntervalId: ReturnType<typeof setInterval> | null = null;
let fastReconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let activeCrawlAbort: AbortController | null = null;
let flushingQueue = false;

function stopFastReconnect(): void {
  if (fastReconnectTimerId !== null) {
    clearTimeout(fastReconnectTimerId);
    fastReconnectTimerId = null;
  }
}

function scheduleFastReconnect(delayMs: number = 5_000): void {
  if (fastReconnectTimerId !== null) return;
  fastReconnectTimerId = setTimeout(() => {
    fastReconnectTimerId = null;
    void ensureNativeConnected(false);
  }, delayMs);
}

function detectBrowserString(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const match = /Chrom(?:e|ium)\/(\d+)/i.exec(ua);
  return match?.[1] ? `chrome/${match[1]}` : "chrome/116";
}

function getExtensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version || "0.2.0";
  } catch {
    return "0.2.0";
  }
}

async function updateActionBadge(state?: ExtensionStorageState): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action?.setBadgeText) return;
  try {
    const s = state ?? (await storage.read());
    if (!s.connection.connected || !s.connection.desktop_available) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
      return;
    }
    if (s.session.state !== "ok") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
      return;
    }
    if (s.pause.paused) {
      await chrome.action.setBadgeText({ text: "II" });
      await chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
      return;
    }
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Ignore badge API errors in headless/test contexts
  }
}

function postOverNativePort(envelope: ExtEnvelope): boolean {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(envelope);
    lastPortTrafficAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function emitSessionStatusDirect(
  sessionState: SessionState,
  detail?: string,
): Promise<void> {
  const local = await storage.read();
  const payload = {
    runtime: {automatic_scanning:local.automatic_scanning,paused:local.pause.paused,next_crawl_at:local.automatic_scanning?getNextScheduledTimestamp(local,Date.now()):null,last_crawl_at:local.last_crawl_at},
    ...(detail ? {detail} : {}),
    platform: "facebook" as const,
    state: sessionState,
  };

  postOverNativePort(createEnvelope("session.status", payload));
}

function abortActiveCrawlIfRunning(): void {
  if (activeCrawlAbort) {
    activeCrawlAbort.abort();
  }
}

function startIdlePingLoop(): void {
  if (pingIntervalId !== null) clearInterval(pingIntervalId);
  pingIntervalId = setInterval(() => {
    if (nativePort) void storage.read().then(s=>emitSessionStatusDirect(s.session.state, s.session.detail));
    if (!nativePort) return;
    const now = Date.now();
    if (now - lastPortTrafficAt >= PING_IDLE_INTERVAL_MS) {
      postOverNativePort(createEnvelope("ping", {}, { ts: now }));
    }
  }, 5_000);
}

function stopIdlePingLoop(): void {
  if (pingIntervalId !== null) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
}

async function scheduleQueueRetryAlarm(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  try {
    const records = await getQueue().getAllRecords();
    if (records.length === 0) {
      await chrome.alarms.clear(ALARM_QUEUE_RETRY);
      return;
    }
    const now = Date.now();
    let earliest = now + 30_000;
    for (const r of records) {
      const candidate = r.in_flight
        ? (r.ack_deadline_at ?? now + 30_000)
        : Math.max(now + 5_000, r.next_retry_at);
      if (candidate < earliest) earliest = candidate;
    }
    await chrome.alarms.create(ALARM_QUEUE_RETRY, {
      when: Math.max(now + 5_000, earliest),
    });
  } catch {
    // Ignore
  }
}

async function flushOutboundQueue(): Promise<void> {
  if (flushingQueue || !nativePort) return;
  flushingQueue = true;
  try {
    const state = await storage.read();
    if (!state.connection.connected || !state.connection.desktop_available) {
      return;
    }
    const now = Date.now();
    const ready = await getQueue().getReadyRecords(now);
    for (const item of ready) {
      const sent = postOverNativePort(item.envelope);
      if (!sent) break;
      await getQueue().markSent(item.id, Date.now());
    }
    await scheduleQueueRetryAlarm();
  } catch {
    // Keep SW resilient
  } finally {
    flushingQueue = false;
  }
}

async function handleDesktopEnvelope(env: DesktopEnvelope): Promise<void> {
  const now = Date.now();

  switch (env.type) {
    case "hello.ok": {
      stopFastReconnect();
      const updated = await storage.update((state) => {
        state.connection = {
          connected: true,
          desktop_available: true,
          desktop_version: env.payload.desktop_version,
          last_seen_at: now,
        };
        return state;
      }, now);
      await updateActionBadge(updated);
      await flushOutboundQueue();
      void runSchedulerTick();
      return;
    }

    case "config.update": {
      const updated = await storage.update((state) => {
        applyConfigUpdate(state, env.payload, now);
        state.connection.last_seen_at = now;
        return state;
      }, now);
      await updateActionBadge(updated);
      await syncSchedulerAlarm(updated, now);
      void runSchedulerTick();
      return;
    }

    case "crawl.request": {
      const state = await storage.read(now);
      if (state.active_crawl !== null || activeCrawlAbort !== null) {
        postOverNativePort(
          replyEnvelope(env.id, "error", {
            code: "busy",
            message: "Đang thực hiện một lần quét khác",
            retryable: true,
          }),
        );
        return;
      }
      void executeActiveCrawl({
        sourceRef: env.payload.source_ref,
        reason: env.payload.reason,
        maxPosts: env.payload.max_posts,
        bypassScheduleWindow: true,
      });
      return;
    }

    case "crawl.pause": {
      const updated = await storage.update((state) => {
        applyDesktopPause(state, env.payload.until, env.payload.reason);
        return state;
      }, now);
      abortActiveCrawlIfRunning();
      await updateActionBadge(updated);
      await syncSchedulerAlarm(updated, now);
      return;
    }

    case "crawl.resume": {
      const updated = await storage.update((state) => {
        applyDesktopResume(state, now);
        return state;
      }, now);
      await updateActionBadge(updated);
      await syncSchedulerAlarm(updated, now);
      void runSchedulerTick();
      return;
    }

    case "ack": {
      await storage.update((state) => {
        state.connection.last_seen_at = now;
      }, now);
      await getQueue().ack(env.reply_to);
      await flushOutboundQueue();
      return;
    }

    case "pong": {
      await storage.update((state) => {
        state.connection.last_seen_at = now;
      }, now);
      return;
    }

    case "error": {
      if (env.payload.code === "desktop_unavailable") {
        const updated = await storage.update((state) => {
          state.connection.desktop_available = false;
          state.connection.last_error =
            env.payload.message || "Ứng dụng DealSonar Desktop chưa sẵn sàng";
          return state;
        }, now);
        abortActiveCrawlIfRunning();
        await updateActionBadge(updated);
        await getQueue().markErrorReply(env.reply_to, true, now);
        await scheduleQueueRetryAlarm();
        scheduleFastReconnect(5_000);
        return;
      }

      if (env.payload.code === "protocol_mismatch") {
        const updated = await storage.update((state) => {
          state.connection.desktop_available = false;
          state.connection.last_error =
            "Phiên bản giao thức không khớp — vui lòng cập nhật DealSonar";
          return state;
        }, now);
        abortActiveCrawlIfRunning();
        await updateActionBadge(updated);
        return;
      }

      await getQueue().markErrorReply(env.reply_to, env.payload.retryable, now);
      await scheduleQueueRetryAlarm();
      return;
    }
  }
}

async function handleRawPortMessage(raw: unknown): Promise<void> {
  lastPortTrafficAt = Date.now();
  const parsed = parseDesktopEnvelope(raw);

  if (!parsed.ok) {
    if (parsed.id) {
      postOverNativePort(
        replyEnvelope(parsed.id, "error", {
          code: parsed.code,
          message: parsed.message,
          retryable: false,
        }),
      );
    } else {
      postOverNativePort(
        createEnvelope("error", {
          code: parsed.code,
          message: parsed.message,
          retryable: false,
        }),
      );
    }

    if (parsed.code === "protocol_mismatch") {
      const updated = await storage.update((state) => {
        state.connection.desktop_available = false;
        state.connection.last_error = parsed.message;
        return state;
      });
      abortActiveCrawlIfRunning();
      await updateActionBadge(updated);
    }
    return;
  }

  await handleDesktopEnvelope(parsed.envelope);
}

async function ensureNativeConnected(forceReconnect: boolean = false): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) return;

  if (nativePort && !forceReconnect) {
    const state = await storage.read();
    if (!state.connection.desktop_available) {
      // Probe native host in case Desktop IPC just came online
      postOverNativePort(createEnvelope("ping", {}));
    }
    return;
  }

  if (nativePort && forceReconnect) {
    try {
      nativePort.disconnect();
    } catch {
      // Ignore
    }
    nativePort = null;
  }

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    lastPortTrafficAt = Date.now();

    port.onMessage.addListener((msg: unknown) => {
      void handleRawPortMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      // Consume runtime.lastError to prevent Chrome console noise
      const lastErr = chrome.runtime.lastError?.message;
      if (nativePort === port) {
        nativePort = null;
      }
      stopIdlePingLoop();
      abortActiveCrawlIfRunning();

      void (async () => {
        const now = Date.now();
        await getQueue().releaseInFlightOnDisconnect(now);
        const updated = await storage.update((state) => {
          state.connection.connected = false;
          state.connection.desktop_available = false;
          state.connection.last_error =
            lastErr || "Mất kết nối tới DealSonar Native Host";
          return state;
        }, now);
        await updateActionBadge(updated);
        scheduleFastReconnect(5_000);
      })();
    });

    startIdlePingLoop();

    const state = await storage.read();
    postOverNativePort(
      createEnvelope("hello", {
        profile_id: state.profile_id,
        ext_version: getExtensionVersion(),
        browser: detectBrowserString(),
        config_rev: state.config.rev,
      }),
    );
  } catch (err) {
    nativePort = null;
    const updated = await storage.update((state) => {
      state.connection.connected = false;
      state.connection.desktop_available = false;
      state.connection.last_error =
        err instanceof Error ? err.message : String(err);
      return state;
    });
    await updateActionBadge(updated);
    scheduleFastReconnect(5_000);
  }
}

// ── Active Crawl Tab Lifecycle (`02-extension.md §5`) ──

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("crawl_aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("crawl_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function queryUserIdleState(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.idle?.queryState) return true;
  try {
    const idleState = await chrome.idle.queryState(60);
    return idleState === "idle" || idleState === "locked";
  } catch {
    return true;
  }
}

async function findExistingUserGroupTab(
  externalId: string,
): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  try {
    const tabs = await chrome.tabs.query({
      url: "https://www.facebook.com/groups/*",
    });
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const slug = extractGroupSlugOrIdFromUrl(tab.url);
      if (slug && slug.toLowerCase() === externalId.toLowerCase()) {
        return tab;
      }
    }
  } catch {
    // Ignore tab query error
  }
  return null;
}

// Explicit current-tab mode must never select another open tab or silently create one.
async function findCurrentGroupTab(externalId: string): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return null;
  const slug = extractGroupSlugOrIdFromUrl(tab.url);
  if (!slug) return null;
  if (slug.toLowerCase() === externalId.toLowerCase()) return tab;
  try {
    const context = await chrome.tabs.sendMessage(tab.id, {
      kind: "dealsonar:get-page-context",
    }) as PageContextResponse | undefined;
    // Facebook can expose a numeric group ID on a tab with a vanity slug URL.
    if (context?.groupInfo?.external_id.toLowerCase() === externalId.toLowerCase()) return tab;
  } catch { /* Content script unavailable: fail without touching a different tab. */ }
  return null;
}

async function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<chrome.tabs.Tab> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) throw new Error("crawl_aborted");
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleepWithAbort(350, signal);
  }
  return chrome.tabs.get(tabId);
}

async function safeCloseTab(tabId: number | null): Promise<void> {
  if (tabId === null || typeof chrome === "undefined" || !chrome.tabs?.remove) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already have been closed by user or safety alarm
  }
  try {
    await chrome.alarms?.clear(`${ALARM_TAB_SAFETY_PREFIX}${tabId}`);
  } catch {
    // Ignore
  }
}

async function cleanupOrphanedCrawlTab(now: number = Date.now()): Promise<void> {
  const state = await storage.read(now);
  if (!state.active_crawl) return;

  const age = now - state.active_crawl.opened_at;
  if (age >= MAX_TAB_LIFETIME_MS || activeCrawlAbort === null) {
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

async function executeActiveCrawl(params: {
  sourceRef: SourceRef;
  reason: CrawlReason;
  maxPosts: number;
  bypassScheduleWindow: boolean;
  manualOptions?: QuickScanOptions;
}): Promise<{ ok: boolean; error?: string }> {
  if (activeCrawlAbort !== null) return { ok: false, error: "Đang có một lượt quét khác. Vui lòng chờ." };

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
  activeCrawlAbort = abortController;
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
    activeCrawlAbort = null;
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

// ── Scheduler Alarm & Tick ──

async function syncSchedulerAlarm(
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

async function runSchedulerTick(): Promise<void> {
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

// ── Popup & Content Script Message Handlers ──

async function buildPopupStatus(now: number = Date.now()): Promise<PopupStatusSnapshot> {
  const state = await storage.update((s) => {
    refreshExpiredPauseState(s, now);
    return s;
  }, now);

  const planIds = state.config.plan.entries.map((e) => e.source_ref.external_id);
  const allFollowedIds = Array.from(
    new Set([...planIds, ...state.optimistic_followed_ids]),
  );

  let queuedPostsCount = 0;
  try {
    queuedPostsCount = await getQueue().countQueuedPosts();
  } catch {
    queuedPostsCount = 0;
  }

  return {
    connected: state.connection.connected,
    desktopAvailable: state.connection.desktop_available,
    desktopVersion: state.connection.desktop_version,
    connectionError: state.connection.last_error,
    extensionId: typeof chrome !== "undefined" ? chrome.runtime?.id : undefined,
    session: {
      state: state.session.state,
      detail: state.session.detail,
      updatedAt: state.session.updated_at,
    },
    lastCrawlAt: state.last_crawl_at,
    nextCrawlAt: state.automatic_scanning ? getNextScheduledTimestamp(state, now) : null,
    automaticScanning: state.automatic_scanning,
    scanOptions: state.quick_scan_options,
    activeCrawl: state.active_crawl ? { sourceExternalId: state.active_crawl.source_external_id } : null,
    lastScan: state.last_scan,
    scanSources: state.config.plan.entries.map((entry) => entry.source_ref),
    followedGroupsCount: allFollowedIds.length,
    followedExternalIds: allFollowedIds,
    loadsLastHour: countLoadsInLastHour(state.load_timestamps, now),
    maxLoadsPerHour: getEffectiveMaxLoadsPerHour(state.config.policy),
    pause: {
      paused: state.pause.paused,
      until: state.pause.until,
      reason: state.pause.reason,
      requiresDesktopResume: state.pause.requires_desktop_resume,
    },
    queuedPostsCount,
  };
}

async function handlePassiveCapture(
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

async function handleRuntimeMessage(
  msg: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const now = Date.now();

  switch (msg.kind) {
    case "content:init": {
      const slugFromUrl = extractGroupSlugOrIdFromUrl(msg.url);
      let sessionChanged = false;

      const initData = await storage.update((state) => {
        const sRes = applySessionSignal(
          state,
          msg.session.state,
          msg.session.detail,
          now,
        );
        sessionChanged = sRes.stateChanged;

        const candidates = new Set<string>();
        if (slugFromUrl) candidates.add(slugFromUrl.toLowerCase());
        if (msg.groupInfo?.external_id) {
          candidates.add(msg.groupInfo.external_id.toLowerCase());
        }

        const matchedEntry = state.config.plan.entries.find((e) =>
          candidates.has(e.source_ref.external_id.toLowerCase()),
        );
        const isActiveCrawlTab =
          sender.tab?.id !== undefined &&
          state.active_crawl?.tab_id === sender.tab.id;
        const sourceRef = matchedEntry?.source_ref ?? null;
        const seenPostIds = sourceRef
          ? (state.seen_post_ids[sourceRef.external_id] ?? [])
          : [];

        return {
          extractor: state.config.extractor ?? DEFAULT_EXTRACTOR_PROFILE,
          isFollowedGroup: Boolean(matchedEntry),
          sourceRef,
          isActiveCrawlTab,
          seenPostIds,
          stateSnapshot: state,
        };
      }, now);

      await updateActionBadge(initData.stateSnapshot);
      if (sessionChanged || msg.session.state !== "ok") {
        await emitSessionStatusDirect(msg.session.state, msg.session.detail);
      }

      const response: ContentInitResponse = {
        extractor: initData.extractor,
        isFollowedGroup: initData.isFollowedGroup,
        sourceRef: initData.sourceRef,
        isActiveCrawlTab: initData.isActiveCrawlTab,
        seenPostIds: initData.seenPostIds,
      };
      return response;
    }

    case "content:session-status": {
      let changed = false;
      const updated = await storage.update((state) => {
        const res = applySessionSignal(
          state,
          msg.session.state,
          msg.session.detail,
          now,
        );
        changed = res.stateChanged;
        return state;
      }, now);
      await updateActionBadge(updated);
      if (changed || msg.session.state !== "ok") {
        await emitSessionStatusDirect(msg.session.state, msg.session.detail);
      }
      return { ok: true };
    }

    case "content:sources-discovered": {
      if (msg.sources.length > 0) {
        await getQueue().enqueueSourcesDiscovered(
          {
            sources: msg.sources,
            ...(msg.follow !== undefined ? { follow: msg.follow } : {}),
          },
          now,
        );
        await flushOutboundQueue();
      }
      return { ok: true };
    }

    case "content:passive-capture": {
      const acceptedNew = await handlePassiveCapture(
        msg.sourceRef,
        msg.posts,
        msg.strategy,
      );
      return { ok: true, acceptedNew };
    }

    case "popup:set-automatic": {
      if (typeof msg.enabled !== "boolean") throw new Error("Chế độ quét không hợp lệ");
      const state = await storage.update((s) => { s.automatic_scanning = msg.enabled; return s; });
      await syncSchedulerAlarm(state, now);
      await emitSessionStatusDirect(state.session.state, state.session.detail);
      return buildPopupStatus(now);
    }

    case "popup:set-scan-options": {
      if (!isQuickScanOptions(msg.options)) {
        throw new Error("Tùy chọn không hợp lệ: số bài từ 1–100, số lần cuộn từ 0–5.");
      }
      await storage.update((state) => {
        state.quick_scan_options = {
          mode: msg.options.mode, maxPosts: msg.options.maxPosts, maxScrollSteps: msg.options.maxScrollSteps,
        };
      });
      return buildPopupStatus();
    }

    case "popup:scan-now": {
      const source = msg.source;
      if (source?.platform !== "facebook" || source.kind !== "group" ||
          typeof source.external_id !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(source.external_id)) {
        return { ok: false, error: "Hãy chọn một nhóm Facebook hợp lệ.", status: await buildPopupStatus() };
      }
      if (msg.options !== undefined && !isQuickScanOptions(msg.options)) {
        return { ok: false, error: "Tùy chọn quét không hợp lệ.", status: await buildPopupStatus() };
      }
      // Capture visible settings for this run, even if another panel saves different defaults.
      const options = msg.options ?? (await storage.read()).quick_scan_options;
      const result = await executeActiveCrawl({
        sourceRef: source, reason: "manual", maxPosts: options.maxPosts,
        bypassScheduleWindow: true, manualOptions: options,
      });
      return { ...result, status: await buildPopupStatus() };
    }

    case "popup:get-status": {
      if (!nativePort) {
        void ensureNativeConnected(false);
      }
      return buildPopupStatus(now);
    }

    case "popup:reconnect": {
      await ensureNativeConnected(true);
      await new Promise((r) => setTimeout(r, 300));
      return buildPopupStatus(Date.now());
    }

    case "popup:pause": {
      const until = msg.durationMs !== null ? now + msg.durationMs : null;
      const updated = await storage.update((state) => {
        applyDesktopPause(state, until, "user_popup");
        return state;
      }, now);
      abortActiveCrawlIfRunning();
      await updateActionBadge(updated);
      await syncSchedulerAlarm(updated, now);
      return buildPopupStatus(now);
    }

    case "popup:resume": {
      const updated = await storage.update((state) => {
        if (!state.pause.requires_desktop_resume) {
          state.pause = {
            paused: false,
            until: null,
            reason: null,
            requires_desktop_resume: false,
          };
        }
        return state;
      }, now);
      await updateActionBadge(updated);
      await syncSchedulerAlarm(updated, now);
      void runSchedulerTick();
      return buildPopupStatus(now);
    }

    case "popup:follow-group": {
      await storage.update((state) => {
        if (!state.optimistic_followed_ids.includes(msg.group.external_id)) {
          state.optimistic_followed_ids.push(msg.group.external_id);
        }
      }, now);
      await getQueue().enqueueSourcesDiscovered(
        { sources: [msg.group], follow: true },
        now,
      );
      await flushOutboundQueue();
      return {
        ok: true,
        status: await buildPopupStatus(now),
      };
    }
  }
}

// ── Service Worker Bootstrap (`02-extension.md §9`) ──

function bootstrapServiceWorker(): void {
  if (typeof chrome === "undefined" || !chrome.runtime) return;

  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  const setupKeepaliveAlarm = () => {
    chrome.alarms?.create(ALARM_KEEPALIVE, { periodInMinutes: 1 });
  };

  chrome.runtime.onInstalled?.addListener(() => {
    setupKeepaliveAlarm();
    void ensureNativeConnected(false);
  });

  chrome.runtime.onStartup?.addListener(() => {
    setupKeepaliveAlarm();
    void ensureNativeConnected(false);
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(ALARM_TAB_SAFETY_PREFIX)) {
      const tabId = Number(alarm.name.slice(ALARM_TAB_SAFETY_PREFIX.length));
      if (Number.isFinite(tabId)) {
        void safeCloseTab(tabId);
      }
      return;
    }

    if (alarm.name === ALARM_KEEPALIVE) {
      void (async () => {
        await ensureNativeConnected(false);
        await flushOutboundQueue();
        await runSchedulerTick();
      })();
      return;
    }

    if (alarm.name === ALARM_QUEUE_RETRY) {
      void (async () => {
        await ensureNativeConnected(false);
        await flushOutboundQueue();
      })();
      return;
    }

    if (alarm.name === ALARM_SCHEDULER) {
      void runSchedulerTick();
    }
  });

  chrome.runtime.onMessage?.addListener(
    (msg: RuntimeMessage, sender, sendResponse) => {
      if (!msg || typeof msg !== "object" || !("kind" in msg)) {
        return false;
      }
      handleRuntimeMessage(msg, sender)
        .then(sendResponse)
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    },
  );

  setupKeepaliveAlarm();
  void ensureNativeConnected(false);
  console.log(`DealSonar background ready, protocol v${PROTOCOL_VERSION}`);
}

bootstrapServiceWorker();
