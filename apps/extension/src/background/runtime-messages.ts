// Popup and content-script runtime message handlers.

import type { PopupStatusSnapshot, RuntimeMessage, ContentInitResponse } from "../messages";
import {
  refreshExpiredPauseState,
  getNextScheduledTimestamp,
  countLoadsInLastHour,
  getEffectiveMaxLoadsPerHour,
  applySessionSignal,
  applyDesktopPause,
} from "./scheduler";
import { extractGroupSlugOrIdFromUrl, DEFAULT_EXTRACTOR_PROFILE } from "../content/extract";
import { isQuickScanOptions } from "../scan-options";
import { updateActionBadge } from "./badge";
import { getQueue, runtime, storage } from "./context";
import { executeActiveCrawl, handlePassiveCapture } from "./crawl";
import {
  abortActiveCrawlIfRunning,
  emitSessionStatusDirect,
  ensureNativeConnected,
  flushOutboundQueue,
} from "./native-port";
import { runSchedulerTick, syncSchedulerAlarm } from "./scheduler-tick";

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

export async function handleRuntimeMessage(
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
      if (!runtime.nativePort) {
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
