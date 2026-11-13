// Handlers for envelopes received from the Desktop app over the native port.

import { type DesktopEnvelope, replyEnvelope } from "../protocol";
import { applyConfigUpdate, applyDesktopPause, applyDesktopResume } from "./scheduler";
import { updateActionBadge } from "./badge";
import { getQueue, runtime, storage } from "./context";
import { executeActiveCrawl } from "./crawl";
import {
  abortActiveCrawlIfRunning,
  flushOutboundQueue,
  postOverNativePort,
  scheduleFastReconnect,
  scheduleQueueRetryAlarm,
  stopFastReconnect,
} from "./native-port";
import { runSchedulerTick, syncSchedulerAlarm } from "./scheduler-tick";

export async function handleDesktopEnvelope(env: DesktopEnvelope): Promise<void> {
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
      if (state.active_crawl !== null || runtime.activeCrawlAbort !== null) {
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
