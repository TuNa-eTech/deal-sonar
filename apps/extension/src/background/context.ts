// Shared background constants, singletons, and mutable service-worker state.

import { StorageManager } from "./storage";
import { OutboundQueue } from "./queue";

export const ALARM_KEEPALIVE = "dealsonar:keepalive";
export const ALARM_SCHEDULER = "dealsonar:scheduler";
export const ALARM_QUEUE_RETRY = "dealsonar:queue-retry";
export const ALARM_TAB_SAFETY_PREFIX = "dealsonar:tab-close:";

export const PING_IDLE_INTERVAL_MS = 25_000; // 25s idle ping (`01-protocol.md §4.1`)
export const MAX_TAB_LIFETIME_MS = 60_000; // Hard 60s tab lifetime cap (`02-extension.md §5.6`)
export const CRAWL_EXECUTION_DEADLINE_MS = 54_000; // Leave 6s headroom before 60s hard tab close

export const storage = new StorageManager();
let outboundQueue: OutboundQueue | null = null;

export function getQueue(): OutboundQueue {
  if (!outboundQueue) {
    outboundQueue = new OutboundQueue();
  }
  return outboundQueue;
}

/** Mutable service-worker state shared by the background modules. */
export const runtime: {
  nativePort: chrome.runtime.Port | null;
  lastPortTrafficAt: number;
  pingIntervalId: ReturnType<typeof setInterval> | null;
  fastReconnectTimerId: ReturnType<typeof setTimeout> | null;
  activeCrawlAbort: AbortController | null;
  flushingQueue: boolean;
} = {
  nativePort: null,
  lastPortTrafficAt: 0,
  pingIntervalId: null,
  fastReconnectTimerId: null,
  activeCrawlAbort: null,
  flushingQueue: false,
};
