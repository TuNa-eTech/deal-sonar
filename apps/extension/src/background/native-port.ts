// Native Messaging port management (`01-protocol.md §1, §3, §7`).

import {
  type ExtEnvelope,
  type SessionState,
  createEnvelope,
  parseDesktopEnvelope,
  replyEnvelope,
  NATIVE_HOST,
} from "../protocol";
import { getNextScheduledTimestamp } from "./scheduler";
import { updateActionBadge } from "./badge";
import { ALARM_QUEUE_RETRY, getQueue, PING_IDLE_INTERVAL_MS, runtime, storage } from "./context";
import { handleDesktopEnvelope } from "./desktop-envelope";

export function stopFastReconnect(): void {
  if (runtime.fastReconnectTimerId !== null) {
    clearTimeout(runtime.fastReconnectTimerId);
    runtime.fastReconnectTimerId = null;
  }
}

export function scheduleFastReconnect(delayMs: number = 5_000): void {
  if (runtime.fastReconnectTimerId !== null) return;
  runtime.fastReconnectTimerId = setTimeout(() => {
    runtime.fastReconnectTimerId = null;
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

export function postOverNativePort(envelope: ExtEnvelope): boolean {
  if (!runtime.nativePort) return false;
  try {
    runtime.nativePort.postMessage(envelope);
    runtime.lastPortTrafficAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

export async function emitSessionStatusDirect(
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

export function abortActiveCrawlIfRunning(): void {
  if (runtime.activeCrawlAbort) {
    runtime.activeCrawlAbort.abort();
  }
}

function startIdlePingLoop(): void {
  if (runtime.pingIntervalId !== null) clearInterval(runtime.pingIntervalId);
  runtime.pingIntervalId = setInterval(() => {
    if (runtime.nativePort) void storage.read().then(s=>emitSessionStatusDirect(s.session.state, s.session.detail));
    if (!runtime.nativePort) return;
    const now = Date.now();
    if (now - runtime.lastPortTrafficAt >= PING_IDLE_INTERVAL_MS) {
      postOverNativePort(createEnvelope("ping", {}, { ts: now }));
    }
  }, 5_000);
}

function stopIdlePingLoop(): void {
  if (runtime.pingIntervalId !== null) {
    clearInterval(runtime.pingIntervalId);
    runtime.pingIntervalId = null;
  }
}

export async function scheduleQueueRetryAlarm(): Promise<void> {
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

export async function flushOutboundQueue(): Promise<void> {
  if (runtime.flushingQueue || !runtime.nativePort) return;
  runtime.flushingQueue = true;
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
    runtime.flushingQueue = false;
  }
}

async function handleRawPortMessage(raw: unknown): Promise<void> {
  runtime.lastPortTrafficAt = Date.now();
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

export async function ensureNativeConnected(forceReconnect: boolean = false): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) return;

  if (runtime.nativePort && !forceReconnect) {
    const state = await storage.read();
    if (!state.connection.desktop_available) {
      // Probe native host in case Desktop IPC just came online
      postOverNativePort(createEnvelope("ping", {}));
    }
    return;
  }

  if (runtime.nativePort && forceReconnect) {
    try {
      runtime.nativePort.disconnect();
    } catch {
      // Ignore
    }
    runtime.nativePort = null;
  }

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    runtime.nativePort = port;
    runtime.lastPortTrafficAt = Date.now();

    port.onMessage.addListener((msg: unknown) => {
      void handleRawPortMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      // Consume runtime.lastError to prevent Chrome console noise
      const lastErr = chrome.runtime.lastError?.message;
      if (runtime.nativePort === port) {
        runtime.nativePort = null;
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
    runtime.nativePort = null;
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
