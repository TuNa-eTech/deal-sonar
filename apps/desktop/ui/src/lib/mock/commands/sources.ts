// Mock handlers: sources.

import type { CrawlRun } from "../../../types/ipc";
import type { MockCommandTable } from "./types";
import { emitMockEvent } from "../events";
import { nextId } from "../ids";
import { state } from "../store";

export const sourceCommands: MockCommandTable = {
  source_list: async () => {
    return structuredClone(state.sources);
  },

  source_follow: async (args) => {
    const id = String(args.id ?? "");
    const src = state.sources.find((s) => s.id === id);
    if (!src) throw new Error(`Không tìm thấy group: ${id}`);
    if (!src.followed) {
      const followedCount = state.sources.filter((s) => s.followed).length;
      if (followedCount >= state.license.limits.max_followed_groups) {
        throw new Error(
          `Đã chạm giới hạn ${state.license.limits.max_followed_groups} group theo dõi của gói hiện tại.`
        );
      }
      src.followed = true;
    }
    return structuredClone(src);
  },

  source_unfollow: async (args) => {
    const id = String(args.id ?? "");
    const src = state.sources.find((s) => s.id === id);
    if (!src) throw new Error(`Không tìm thấy group: ${id}`);
    src.followed = false;
    src.priority = false;
    return structuredClone(src);
  },

  source_set_priority: async (args) => {
    const id = String(args.id ?? "");
    const priority = Boolean(args.priority);
    const src = state.sources.find((s) => s.id === id);
    if (!src) throw new Error(`Không tìm thấy group: ${id}`);
    if (priority && !src.priority) {
      const prioCount = state.sources.filter((s) => s.priority).length;
      if (prioCount >= 3) {
        throw new Error("Tối đa 3 group được đặt chế độ ưu tiên (quét mỗi 5 phút).");
      }
    }
    src.priority = priority;
    return structuredClone(src);
  },

  source_crawl_now: async (args) => {
    const id = String(args.id ?? "");
    const src = state.sources.find((s) => s.id === id);
    if (!src) throw new Error(`Không tìm thấy group: ${id}`);
    const now = Date.now();
    const run: CrawlRun = {
      id: nextId("01JCFC"),
      source_id: src.id,
      source_name: src.name,
      reason: (args.reason as "manual" | "preview") ?? "manual",
      status: "ok",
      started_at: now - 1500,
      ended_at: now,
      posts_seen: 18,
      posts_new: 4,
      page_loads: 1,
      strategy: "network",
      error: null,
    };
    src.last_crawl_at = now;
    src.stored_post_count += 4;
    state.crawlRuns.unshift(run);
    emitMockEvent("crawl:finished", structuredClone(run));
    return { queued: true, run_id: run.id };
  },
};
