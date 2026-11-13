// Mock handlers: posts and rejected evaluations.

import { removeVietnameseDiacritics } from "../../format";
import type { MockCommandTable } from "./types";
import { state } from "../store";

export const postCommands: MockCommandTable = {
  post_get: async (args) => {
    const id = String(args.id ?? "");
    const post = state.posts.find((p) => p.id === id);
    if (!post) throw new Error(`Không tìm thấy bài viết: ${id}`);
    return structuredClone(post);
  },

  post_search: async (args) => {
    const q = removeVietnameseDiacritics(String(args.query ?? "").trim()).toLowerCase();
    const sourceId = args.source_id ? String(args.source_id) : null;
    const limit = Number(args.limit ?? 30);
    let matched = state.posts.filter((p) => p.text !== null);
    if (sourceId) {
      matched = matched.filter((p) => p.source_id === sourceId);
    }
    if (q) {
      matched = matched.filter((p) =>
        removeVietnameseDiacritics(`${p.text ?? ""} ${p.author_name}`).toLowerCase().includes(q)
      );
    }
    return structuredClone(matched.slice(0, limit));
  },

  evaluation_list_rejected: async (args) => {
    const radarId = String(args.radar_id ?? "");
    const items = radarId
      ? state.rejectedEvaluations.filter((e) => e.radar_id === radarId)
      : state.rejectedEvaluations;
    return structuredClone(items);
  },
};
