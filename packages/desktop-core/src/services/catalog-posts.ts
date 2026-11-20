// `post_get`, `post_list_by_source`, `post_search`, `evaluation_list_rejected`
// (crates/core/src/service/posts.rs).

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { ANONYMOUS_AUTHOR, postDetailToDto } from "./catalog-convert";
import { getEvalFeedbackLabels } from "./catalog-runtime";
import { dString, dUsize, parseArg, parseOptArg } from "./catalog-serde";
import {
  type PostDto,
  type RejectedEvaluationDto,
  type SourcePostCursor,
  type SourcePostPageDto,
  dSourcePostCursor,
  decidedByFromDb,
  rejectReasonFromDb,
} from "./catalog-types";

/** `PAGE_SIZE` of `post_list_by_source`. */
export const SOURCE_POST_PAGE_SIZE = 30;

export function postGet(ctx: RuntimeContext, id: string): PostDto {
  const detail = ctx.store.posts.get(id);
  if (!detail) throw CoreError.notFound("post", id);
  return postDetailToDto(detail);
}

export function postListBySource(
  ctx: RuntimeContext,
  sourceId: string,
  before: SourcePostCursor | null,
): SourcePostPageDto {
  const rows = ctx.store.posts.listBySource(
    sourceId,
    before ? [before.at, before.id] : null,
    SOURCE_POST_PAGE_SIZE + 1,
  );
  const hasMore = rows.length > SOURCE_POST_PAGE_SIZE;
  rows.length = Math.min(rows.length, SOURCE_POST_PAGE_SIZE);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(postDetailToDto),
    next_cursor: hasMore && last ? { at: last.created_at ?? last.captured_at, id: last.id } : null,
  };
}

export function postSearch(ctx: RuntimeContext, query: string, sourceId: string | null, limit: number): PostDto[] {
  return ctx.store.posts.search(query, sourceId, limit).map(postDetailToDto);
}

export function evaluationListRejected(ctx: RuntimeContext, radarId: string, limit: number): RejectedEvaluationDto[] {
  const items = ctx.store.posts.listRejectedEvaluations(radarId, limit);
  const labels = getEvalFeedbackLabels(ctx);
  return items.map((it): RejectedEvaluationDto => {
    const dto: RejectedEvaluationDto = {
      evaluation_id: it.evaluation_id,
      post_id: it.post_id,
      radar_id: radarId,
      radar_version_id: it.radar_version_id,
      decided_by: decidedByFromDb(it.decided_by),
      reject_reason: rejectReasonFromDb(it.reject_reason),
      score: it.score,
      reason: it.reason,
      source_name: it.source_name,
      author_name: it.author_name ?? ANONYMOUS_AUTHOR,
      permalink: it.permalink,
      post_text: it.post_text ?? "",
      captured_at: it.created_at,
    };
    if (labels[it.evaluation_id] === "missed") dto.marked_missed = true;
    return dto;
  });
}

export function createPostHandlers(): HandlerTable {
  return {
    post_get: (ctx, args) => postGet(ctx, parseArg(args, "id", dString)),
    post_list_by_source: (ctx, args) =>
      postListBySource(
        ctx,
        parseArg(args, "source_id", dString),
        parseOptArg(args, "before", dSourcePostCursor),
      ),
    post_search: (ctx, args) => {
      const query = parseArg(args, "query", dString);
      const sourceId = parseOptArg(args, "source_id", dString);
      const limit = parseOptArg(args, "limit", dUsize);
      return postSearch(ctx, query, sourceId, limit ?? 30);
    },
    evaluation_list_rejected: (ctx, args) => {
      const radarId = parseArg(args, "radar_id", dString);
      const limit = parseOptArg(args, "limit", dUsize);
      return evaluationListRejected(ctx, radarId, limit ?? 30);
    },
  };
}
