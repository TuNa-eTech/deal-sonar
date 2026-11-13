// Background Service Worker (`01-protocol.md §3, §5, §7` & `02-extension.md §5–9`).
// Manages persistent Native Messaging port, durable IndexedDB outbound queue,
// crawl scheduler with immutable hard safety caps, active crawl tabs, and popup/content IPC.

import type { RuntimeMessage } from "../messages";
import { PROTOCOL_VERSION } from "../protocol";
import {
  ALARM_KEEPALIVE,
  ALARM_QUEUE_RETRY,
  ALARM_SCHEDULER,
  ALARM_TAB_SAFETY_PREFIX,
} from "./context";
import { ensureNativeConnected, flushOutboundQueue } from "./native-port";
import { handleRuntimeMessage } from "./runtime-messages";
import { runSchedulerTick } from "./scheduler-tick";
import { safeCloseTab } from "./tabs";

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
