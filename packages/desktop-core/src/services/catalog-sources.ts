// `source_list`, `source_follow`, `source_unfollow`, `source_set_priority`
// (crates/core/src/service/sources.rs). `source_crawl_now` belongs to the pipeline port.

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { nowMs } from "../store/util";
import { sourceToDto } from "./catalog-convert";
import {
  type CatalogServices,
  ensureNotShuttingDown,
  getSourceLastErrors,
  planDebug,
} from "./catalog-runtime";
import { dBool, dString, parseArg } from "./catalog-serde";
import type { SourceDto } from "./catalog-types";

/** Pinned fast-interval sources (`scheduler::MAX_PRIORITY_SOURCES`). */
export const MAX_PRIORITY_SOURCES = 3;

export function sourceList(ctx: RuntimeContext): SourceDto[] {
  const items = ctx.store.sources.list(nowMs());
  const lastErrors = getSourceLastErrors(ctx);
  return items.map((item) => sourceToDto(item, lastErrors[item.id] ?? null));
}

export function getSourceDto(ctx: RuntimeContext, id: string): SourceDto {
  const found = sourceList(ctx).find((s) => s.id === id);
  if (!found) throw CoreError.notFound("source", id);
  return found;
}

function requireSource(ctx: RuntimeContext, id: string) {
  const source = ctx.store.sources.get(id);
  if (!source) throw CoreError.notFound("source", id);
  return source;
}

export function sourceFollow(ctx: RuntimeContext, services: CatalogServices, id: string): SourceDto {
  ensureNotShuttingDown(ctx);
  const now = nowMs();
  const existing = requireSource(ctx, id);
  if (!existing.followed) {
    const license = services.licenseView(ctx, now);
    const followed = Math.max(0, ctx.store.sources.countFollowed());
    if (followed >= license.limits.max_followed_groups) {
      throw CoreError.licenseLimit(
        `Current ${planDebug(license.plan)} plan allows following at most ${license.limits.max_followed_groups} groups`,
      );
    }
    ctx.store.sources.follow(id);
    services.configChanged(ctx);
  }
  return getSourceDto(ctx, id);
}

export function sourceUnfollow(ctx: RuntimeContext, services: CatalogServices, id: string): SourceDto {
  ensureNotShuttingDown(ctx);
  requireSource(ctx, id);
  ctx.store.sources.unfollow(id);
  services.configChanged(ctx);
  return getSourceDto(ctx, id);
}

export function sourceSetPriority(
  ctx: RuntimeContext,
  services: CatalogServices,
  id: string,
  priority: boolean,
): SourceDto {
  ensureNotShuttingDown(ctx);
  const existing = requireSource(ctx, id);
  if (priority && existing.priority <= 0) {
    const others = ctx.store.sources.list(nowMs()).filter((s) => s.priority > 0 && s.id !== id).length;
    if (others >= MAX_PRIORITY_SOURCES) {
      throw CoreError.validation(
        `Maximum ${MAX_PRIORITY_SOURCES} priority groups allowed (\`02-extension.md §6.2\`)`,
      );
    }
  }
  ctx.store.sources.setPriority(id, priority ? 1 : 0);
  services.configChanged(ctx);
  return getSourceDto(ctx, id);
}

export function createSourceHandlers(services: CatalogServices): HandlerTable {
  return {
    source_list: (ctx) => sourceList(ctx),
    source_follow: (ctx, args) => sourceFollow(ctx, services, parseArg(args, "id", dString)),
    source_unfollow: (ctx, args) => sourceUnfollow(ctx, services, parseArg(args, "id", dString)),
    source_set_priority: (ctx, args) =>
      sourceSetPriority(ctx, services, parseArg(args, "id", dString), parseArg(args, "priority", dBool)),
  };
}
