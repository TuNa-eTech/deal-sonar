// MCP agent operations: a port of `crates/core/src/service/agent.rs`.
//
// The native-host package already frames the request, bounds its size, validates the envelope and
// compares the access token in constant time (`handleAgentFrame`), then calls
// `HostAgentBackend.handle(method, args)`. This module is that backend: the four operations plus
// the shutdown check that follows authentication in Rust.
//
// Safety properties (kept from Rust, covered by tests):
//  * Agents only ever create or inspect DRAFT radars. Activation is user-only, inside the app.
//  * Responses carry counts and radar metadata, never post bodies, authors or permalinks.
//  * Every failure becomes `AgentError(<CoreError display text>)`, so internals never leak.
//
// Radar persistence, the license and the preview engine belong to other ports and are injected
// through `AgentHooks`.

import type { HostAgentBackend, AgentMethodName } from "../backend/host";
import type { RuntimeContext } from "../backend/runtime";
import { CoreError, toWireError } from "../backend/wire";
import {
  DomainShapeError,
  type FieldDef,
  type MatchPolicy,
  normalizeFieldDef,
  normalizeHardFilter,
  normalizeMatchPolicy,
} from "../store/domain";
import type { RadarWithVersion } from "../store/radars";
import type { SourceListItem, SourceRecord } from "../store/sources";
import { newUlid } from "../store/util";
import { PLATFORM_FACEBOOK, SOURCE_KIND_GROUP } from "./protocol-types";

export interface AgentLicenseLimits {
  max_fields_per_radar: number;
  max_followed_groups: number;
}

export type AgentPreviewStatus = "crawling" | "evaluating" | "done" | "error";

/** The slice of `PreviewRunState` agents may see summarized. */
export interface AgentPreviewState {
  /** `"restored"` marks a preview that was never started in this session. */
  preview_id: string;
  status: AgentPreviewStatus;
  total_posts: number;
  evaluated_posts: number;
  failed_posts: number;
  items: ReadonlyArray<{ verdict: string }>;
  warnings: readonly unknown[];
}

/** `CreateRadarDraftInput` as agents build it: no template, language hint or notify patch. */
export interface AgentRadarDraft {
  name: string;
  description: string;
  user_profession: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicy;
  source_ids: string[];
}

/** Ports owned by the license, catalog and preview workers. */
export interface AgentHooks {
  /** `current_license_status(now).limits`. */
  licenseLimits(now: number): AgentLicenseLimits;
  /** `persist_radar_draft(rt, draft, Some(id))`: creates the draft radar with `id`. */
  persistRadarDraft(draft: AgentRadarDraft, id: string): RadarWithVersion;
  /** `get_radar_preview(rt, id, None)`. */
  getRadarPreview(radarId: string): AgentPreviewState;
  /** `start_radar_preview(rt, { radar_id })`. */
  startRadarPreview(radarId: string): Promise<AgentPreviewState>;
}

export interface AgentBackendDeps {
  hooks: AgentHooks;
  /** `HostBindings.AgentError`: the only error type whose message reaches the MCP client. */
  AgentError: new (message: string) => Error;
  now?: () => number;
}

type AgentContext = Pick<RuntimeContext, "store" | "emit" | "isShuttingDown">;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const REVIEW_IN = "DealSonar → Radar";
const REVIEW_RESULTS_IN = "DealSonar → Radar → Xem kết quả";

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "sequence";
  switch (typeof v) {
    case "string":
      return `string ${JSON.stringify(v)}`;
    case "boolean":
      return `boolean \`${v}\``;
    case "number":
      return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
    default:
      return "map";
  }
}

const argError = (detail: string): CoreError => CoreError.validation(detail);

/** `serde(deny_unknown_fields)` struct reader. Unknown keys are rejected in document order. */
function strictStruct(args: unknown, name: string, known: readonly string[]): Rec {
  if (!isRec(args)) throw argError(`invalid type: ${describe(args)}, expected struct ${name}`);
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      throw argError(`unknown field \`${key}\`, expected one of ${known.map((k) => `\`${k}\``).join(", ")}`);
    }
  }
  return args;
}

function reqString(o: Rec, key: string): string {
  if (o[key] === undefined) throw argError(`missing field \`${key}\``);
  if (typeof o[key] !== "string") throw argError(`invalid type: ${describe(o[key])}, expected a string`);
  return o[key];
}

function stringList(o: Rec, key: string, required: boolean): string[] {
  const v = o[key];
  if (v === undefined) {
    if (required) throw argError(`missing field \`${key}\``);
    return [];
  }
  if (!Array.isArray(v)) throw argError(`invalid type: ${describe(v)}, expected a sequence`);
  return v.map((item) => {
    if (typeof item !== "string") throw argError(`invalid type: ${describe(item)}, expected a string`);
    return item;
  });
}

function shape<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DomainShapeError) throw argError(err.message);
    throw err;
  }
}

const PREPARE_FIELDS = [
  "draft_id",
  "name",
  "description",
  "user_profession",
  "source_ids",
  "fields",
  "want_intent",
  "hard_filters",
  "exclude_peers",
] as const;

interface PrepareInput {
  draft_id: string;
  name: string;
  description: string;
  user_profession: string | null;
  source_ids: string[];
  fields: FieldDef[];
  want_intent: "demand" | "supply" | "any";
  hard_filters: MatchPolicy["hard_filters"];
  exclude_peers: boolean;
}

function parsePrepareInput(args: unknown): PrepareInput {
  const o = strictStruct(args, "PrepareInput", PREPARE_FIELDS);
  const intent = o.want_intent;
  if (intent === undefined) throw argError("missing field `want_intent`");
  if (intent !== "demand" && intent !== "supply" && intent !== "any") {
    throw argError(
      typeof intent === "string"
        ? `unknown variant \`${intent}\`, expected one of \`demand\`, \`supply\`, \`any\``
        : `invalid type: ${describe(intent)}, expected a string`,
    );
  }
  const professionRaw = o.user_profession;
  if (professionRaw !== undefined && professionRaw !== null && typeof professionRaw !== "string") {
    throw argError(`invalid type: ${describe(professionRaw)}, expected a string`);
  }
  const rawFields = o.fields;
  if (rawFields === undefined) throw argError("missing field `fields`");
  if (!Array.isArray(rawFields)) throw argError(`invalid type: ${describe(rawFields)}, expected a sequence`);
  const rawFilters: unknown = o.hard_filters ?? [];
  if (!Array.isArray(rawFilters)) throw argError(`invalid type: ${describe(rawFilters)}, expected a sequence`);
  const peers = o.exclude_peers;
  if (peers !== undefined && typeof peers !== "boolean") {
    throw argError(`invalid type: ${describe(peers)}, expected a boolean`);
  }
  return {
    draft_id: reqString(o, "draft_id"),
    name: reqString(o, "name"),
    description: reqString(o, "description"),
    user_profession: (professionRaw as string | null | undefined) ?? null,
    source_ids: stringList(o, "source_ids", true),
    fields: shape(() => rawFields.map(normalizeFieldDef)),
    want_intent: intent,
    hard_filters: shape(() =>
      rawFilters.map((f) => {
        const filter = normalizeHardFilter(f);
        if (filter.when_missing !== "pass" && filter.when_missing !== "fail") {
          throw new DomainShapeError(
            `unknown variant \`${filter.when_missing}\`, expected \`pass\` or \`fail\``,
          );
        }
        return filter;
      }),
    ),
    exclude_peers: peers ?? true,
  };
}

/** Canonical (upper-case Crockford) form of a ULID, or null when `ulid::Ulid::from_str` would fail. */
export function parseUlid(text: string): string | null {
  if (text.length !== 26) return null;
  const upper = text.toUpperCase().replaceAll("I", "1").replaceAll("L", "1").replaceAll("O", "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(upper)) return null;
  // The first character carries only 3 bits: values above '7' overflow 128 bits.
  if (upper[0]! > "7") return null;
  return upper;
}

const eligibleSource = (s: SourceRecord): boolean =>
  s.platform === PLATFORM_FACEBOOK && s.kind === SOURCE_KIND_GROUP && s.state === "ok";

const stable = (value: unknown): string => JSON.stringify(value);

/** Builds the `HostAgentBackend` the runtime passes to `bindIpcServer`. */
export function createAgentBackend(ctx: AgentContext, deps: AgentBackendDeps): HostAgentBackend {
  const { hooks } = deps;
  const nowFn = deps.now ?? Date.now;

  const listSources = () => {
    const now = nowFn();
    const limits = hooks.licenseLimits(now);
    const sources = ctx.store.sources
      .list(now)
      .filter((item: SourceListItem) => eligibleSource(item))
      .map((item) => ({
        id: item.id,
        name: item.name,
        followed: item.followed,
        stored_post_count: item.stored_post_count,
        recent_post_count: item.posts_last_24h,
      }));
    return {
      draft_id: newUlid(now),
      sources,
      max_fields: limits.max_fields_per_radar,
      max_groups: limits.max_followed_groups,
    };
  };

  const validateSources = (sourceIds: readonly string[]): void => {
    if (sourceIds.length === 0) throw CoreError.validation("Chọn ít nhất một group phù hợp từ list_radar_sources.");
    const now = nowFn();
    const limit = hooks.licenseLimits(now).max_followed_groups;
    const sources = ctx.store.sources.list(now);
    const followed = new Set(sources.filter((row) => row.followed).map((row) => row.id));
    for (const id of sourceIds) {
      if (!sources.some((item) => item.id === id && eligibleSource(item))) {
        throw CoreError.validation(`Group ${id} không còn sẵn sàng. Hãy lấy lại danh sách nguồn.`);
      }
      followed.add(id);
    }
    if (followed.size > limit) {
      throw CoreError.licenseLimit(`Gói hiện tại cho phép tối đa ${limit} group theo dõi.`);
    }
  };

  const summarize = (radar: RadarWithVersion, preview: AgentPreviewState) => {
    const status = preview.preview_id === "restored" ? "not_started" : preview.status;
    const matches = preview.items.filter((item) => item.verdict === "match").length;
    const error =
      preview.status === "error" && preview.total_posts === 0
        ? "Chưa có bài để xem thử. Kiểm tra nhóm nguồn và Chrome Extension trong DealSonar."
        : preview.status === "error"
          ? "Xem thử chưa hoàn tất. Mở Radar trong DealSonar để xem chi tiết."
          : null;
    return {
      radar_id: radar.radar.id,
      name: radar.radar.name,
      source_ids: radar.source_ids,
      status,
      total_posts: preview.total_posts,
      evaluated_posts: preview.evaluated_posts,
      matched_posts: matches,
      failed_posts: preview.failed_posts,
      warnings: preview.warnings,
      error,
      review_in: REVIEW_RESULTS_IN,
    };
  };

  const previewSummary = async (radar: RadarWithVersion, retry: boolean) => {
    const id = radar.radar.id;
    const current = hooks.getRadarPreview(id);
    if (!retry || current.status === "crawling" || current.status === "evaluating") {
      return summarize(radar, current);
    }
    try {
      validateSources(radar.source_ids);
      const state = await hooks.startRadarPreview(id);
      return summarize(radar, state);
    } catch (err) {
      return {
        radar_id: id,
        name: radar.radar.name,
        status: "error",
        error: toWireError(err).message,
        review_in: REVIEW_IN,
      };
    }
  };

  const prepareRadar = async (args: unknown) => {
    const input = parsePrepareInput(args);
    const id = parseUlid(input.draft_id);
    if (id === null) throw CoreError.validation("Hãy dùng draft_id từ list_radar_sources.");
    if (input.fields.length === 0) throw CoreError.validation("Chọn ít nhất một thông tin cần trích xuất.");
    if (input.hard_filters.some((filter) => !input.fields.some((field) => field.key === filter.field))) {
      throw CoreError.validation("Mỗi điều kiện bắt buộc phải dùng một key trong fields.");
    }

    const draft: AgentRadarDraft = {
      name: input.name,
      description: input.description,
      user_profession: input.user_profession?.trim() ? input.user_profession.trim() : null,
      fields: input.fields.map((field, index) => ({ ...field, order: index + 1 })),
      match_policy: normalizeMatchPolicy({
        want_intent: input.want_intent,
        exclude_roles: input.exclude_peers ? ["peer"] : [],
        hard_filters: input.hard_filters,
      }),
      source_ids: [...new Set(input.source_ids)].sort(),
    };

    const existing = ctx.store.radars.get(id);
    if (existing) {
      const version = existing.current_version;
      const savedSources = [...existing.source_ids].sort();
      if (
        existing.radar.status !== "draft" ||
        existing.radar.name !== draft.name.trim() ||
        version.description !== draft.description ||
        version.user_profession !== draft.user_profession ||
        stable(version.match_policy) !== stable(draft.match_policy) ||
        stable(version.fields) !== stable(draft.fields) ||
        stable(savedSources) !== stable(draft.source_ids)
      ) {
        throw CoreError.validation("Radar này đã thay đổi hoặc mã nháp đã được dùng cho yêu cầu khác.");
      }
      const preview = hooks.getRadarPreview(id);
      if (preview.preview_id !== "restored") return summarize(existing, preview);
      return previewSummary(existing, true);
    }

    validateSources(draft.source_ids);
    const saved = hooks.persistRadarDraft(draft, id);
    ctx.emit("radar:draft-created", saved.radar.id);
    return previewSummary(saved, true);
  };

  const previewRadar = async (args: unknown, retry: boolean) => {
    const o = strictStruct(args, "PreviewInput", ["radar_id"]);
    const radarId = reqString(o, "radar_id");
    const radar = ctx.store.radars.get(radarId);
    if (!radar || radar.radar.status !== "draft") {
      throw CoreError.validation("Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.");
    }
    return previewSummary(radar, retry);
  };

  return {
    async handle(method: AgentMethodName, args: unknown): Promise<unknown> {
      try {
        // Token, size and request-shape checks already ran in the host (`handleAgentFrame`).
        if (ctx.isShuttingDown()) throw CoreError.shuttingDown();
        switch (method) {
          case "list_radar_sources":
            return listSources();
          case "prepare_radar":
            return await prepareRadar(args);
          case "check_radar_preview":
            return await previewRadar(args, false);
          case "retry_radar_preview":
            return await previewRadar(args, true);
        }
      } catch (err) {
        if (err instanceof deps.AgentError) throw err;
        throw new deps.AgentError(toWireError(err).message);
      }
      throw new deps.AgentError(CoreError.validation("Yêu cầu agent không hợp lệ.").message);
    },
  };
}
