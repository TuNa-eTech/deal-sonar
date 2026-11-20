// Command handlers owned by the pipeline worker. Each is a port of the matching arm of
// apps/desktop/src/commands/dispatch.rs. Compose with:
//
//   const handlers: HandlerTable = { ...DEFAULT_HANDLERS, ...PIPELINE_HANDLERS };
//
// Handlers resolve the memoized `PipelineService.for(ctx)`; install hooks and start background
// loops before the first request (see ./pipeline).

import { CommandError, optArg, requireArg, type Args } from "../backend/wire";
import type { CommandHandler, HandlerTable } from "../backend/runtime";
import {
  PipelineService,
  RADAR_STATUSES,
  parsePreviewStartInput,
  parseSuggestFieldsInput,
} from "./pipeline";
import type { RadarStatus } from "../pipeline/types";

const bad = (key: string, detail: string): CommandError =>
  new CommandError("validation_error", `tham số '${key}' không hợp lệ: ${detail}`);

function argString(args: Args, key: string): string {
  const v = requireArg(args, key);
  if (typeof v !== "string") throw bad(key, "invalid type: expected a string");
  return v;
}
function optString(args: Args, key: string): string | null {
  const v = optArg(args, key);
  if (v === null) return null;
  if (typeof v !== "string") throw bad(key, "invalid type: expected a string");
  return v;
}
function optUint(args: Args, key: string): number | null {
  const v = optArg(args, key);
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(key, "invalid value: expected an unsigned integer");
  return v;
}

export const PIPELINE_COMMANDS = [
  "source_crawl_now",
  "radar_suggest_fields",
  "radar_set_status",
  "radar_preview_start",
  "radar_preview_get",
  "radar_preview_cancel",
  "ruleset_compile_now",
  "health_get",
  "crawl_run_list",
  "backend:toggle_crawl_paused",
] as const;

const handlers: Record<(typeof PIPELINE_COMMANDS)[number], CommandHandler> = {
  source_crawl_now: (ctx, args) => PipelineService.for(ctx).sourceCrawlNow(argString(args, "id"), optString(args, "reason")),

  radar_suggest_fields: (ctx, args) =>
    PipelineService.for(ctx).radarSuggestFields(parseSuggestFieldsInput(requireArg(args, "input"))),

  radar_set_status: (ctx, args) => {
    const id = argString(args, "id");
    const status = requireArg(args, "status");
    if (typeof status !== "string" || !(RADAR_STATUSES as readonly string[]).includes(status)) {
      throw bad("status", `unknown variant \`${String(status)}\`, expected one of \`draft\`, \`active\`, \`paused\`, \`archived\``);
    }
    const previewId = typeof args.preview_id === "string" ? args.preview_id : null;
    return PipelineService.for(ctx).radarSetStatusFromDesktop(id, status as RadarStatus, previewId);
  },

  radar_preview_start: (ctx, args) =>
    PipelineService.for(ctx).radarPreviewStart(parsePreviewStartInput(requireArg(args, "input"))),

  radar_preview_get: (ctx, args) =>
    PipelineService.for(ctx).radarPreviewGet(argString(args, "radar_id"), optString(args, "preview_id")),

  radar_preview_cancel: (ctx, args) =>
    PipelineService.for(ctx).radarPreviewCancel(argString(args, "radar_id"), argString(args, "preview_id")),

  ruleset_compile_now: (ctx, args) => PipelineService.for(ctx).rulesetCompileNow(argString(args, "radar_id")),

  health_get: (ctx) => PipelineService.for(ctx).healthGet(),

  crawl_run_list: (ctx, args) =>
    PipelineService.for(ctx).crawlRunList(optString(args, "source_id"), optUint(args, "limit") ?? 50),

  "backend:toggle_crawl_paused": (ctx) => PipelineService.for(ctx).toggleCrawlPaused(),
};

/** Handler table for the commands this worker owns (exactly {@link PIPELINE_COMMANDS}). */
export const PIPELINE_HANDLERS: HandlerTable = handlers;
