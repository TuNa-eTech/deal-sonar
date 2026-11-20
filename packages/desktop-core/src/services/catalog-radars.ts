// `radar_list/get/create_draft/update/stats` and `template_list/get`
// (crates/core/src/service/radars.rs). `radar_set_status`, `radar_suggest_fields` and the preview
// commands belong to the pipeline/AI ports.

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import type { RadarRecord, RadarWithVersion } from "../store/radars";
import { nowMs } from "../store/util";
import {
  applyNotifyPatch,
  matchPolicyToStore,
  notifyFromStore,
  notifyToStore,
  radarVersionFromStore,
} from "./catalog-convert";
import { seedRuleset } from "./catalog-rules";
import {
  type CatalogServices,
  defaultNotifyMode,
  ensureNotShuttingDown,
  getFloodAutoDigestRadars,
  monotonicRadarNowMs,
  planDebug,
} from "./catalog-runtime";
import { dString, dU32, parseArg, parseOptArg } from "./catalog-serde";
import { getTemplate, loadTemplates } from "./catalog-templates";
import {
  type CreateRadarDraftInput,
  type FunnelStatsDto,
  type RadarDetailDto,
  type RadarDto,
  type RadarNotifyConfigDto,
  type RadarTemplateDto,
  type RadarUpdateResultDto,
  type UpdateRadarInput,
  dCreateRadarDraftInput,
  dUpdateRadarInput,
  radarStatusFromDb,
} from "./catalog-types";

interface RadarMetrics {
  leads_24h?: number;
  false_positive_rate?: number;
  evaluated_posts_total?: number;
  rule_handled_pct: number;
  auto_digest_flood: boolean;
}

function toRadarDto(radar: RadarRecord, sourceIds: string[], m: RadarMetrics): RadarDto {
  const dto: RadarDto = {
    id: radar.id,
    name: radar.name,
    status: radarStatusFromDb(radar.status),
    template_id: radar.template_id,
    current_version: radar.current_version,
    source_ids: [...sourceIds],
    notify: notifyFromStore(radar.notify),
    created_at: radar.created_at,
    updated_at: radar.updated_at,
  };
  if (m.leads_24h !== undefined) dto.leads_24h = m.leads_24h;
  if (m.false_positive_rate !== undefined) dto.false_positive_rate = m.false_positive_rate;
  if (m.evaluated_posts_total !== undefined) dto.evaluated_posts_total = m.evaluated_posts_total;
  dto.rule_handled_pct = m.rule_handled_pct;
  if (m.auto_digest_flood) dto.auto_digest_flood = true;
  return dto;
}

export function radarList(ctx: RuntimeContext): RadarDto[] {
  const now = nowMs();
  const items = ctx.store.radars.list(false, now);
  const flood = getFloodAutoDigestRadars(ctx);
  return items.map((item) => {
    const stats = ctx.store.radars.stats(item.radar.id, now);
    return toRadarDto(item.radar, item.source_ids, {
      leads_24h: item.leads_24h,
      false_positive_rate: item.false_positive_rate,
      evaluated_posts_total: item.evaluated_posts_total,
      rule_handled_pct: stats.rule_handled_ratio * 100,
      auto_digest_flood: flood.has(item.radar.id),
    });
  });
}

export function buildRadarDetailDto(ctx: RuntimeContext, rw: RadarWithVersion, now: number): RadarDetailDto {
  const stats = ctx.store.radars.stats(rw.radar.id, now);
  const flood = getFloodAutoDigestRadars(ctx);
  const meta = ctx.store.radars.list(true, now).find((i) => i.radar.id === rw.radar.id);
  return {
    radar: toRadarDto(rw.radar, rw.source_ids, {
      leads_24h: meta?.leads_24h,
      false_positive_rate: meta?.false_positive_rate,
      evaluated_posts_total: meta?.evaluated_posts_total,
      rule_handled_pct: stats.rule_handled_ratio * 100,
      auto_digest_flood: flood.has(rw.radar.id),
    }),
    current_version_data: radarVersionFromStore(rw.current_version),
    pending_version_data: rw.candidate_version ? radarVersionFromStore(rw.candidate_version) : null,
    versions: ctx.store.radars.versions(rw.radar.id).map(radarVersionFromStore),
  };
}

function requireRadar(ctx: RuntimeContext, id: string): RadarWithVersion {
  const rw = ctx.store.radars.get(id);
  if (!rw) throw CoreError.notFound("radar", id);
  return rw;
}

export function radarGet(ctx: RuntimeContext, id: string): RadarDetailDto {
  return buildRadarDetailDto(ctx, requireRadar(ctx, id), nowMs());
}

function assertFieldLimit(services: CatalogServices, ctx: RuntimeContext, count: number, now: number): void {
  const license = services.licenseView(ctx, now);
  if (count > license.limits.max_fields_per_radar) {
    throw CoreError.licenseLimit(
      `Current ${planDebug(license.plan)} plan allows at most ${license.limits.max_fields_per_radar} fields per radar (got ${count})`,
    );
  }
}

/** `persist_radar_draft`: validation, license field limit, notify defaults, seed ruleset. */
export function persistRadarDraft(
  ctx: RuntimeContext,
  services: CatalogServices,
  input: CreateRadarDraftInput,
  id: string | null,
): { rw: RadarWithVersion; now: number } {
  if (input.name.trim() === "") throw CoreError.validation("Radar name cannot be empty");
  if (input.description.trim() === "") throw CoreError.validation("Radar description cannot be empty");

  const now = monotonicRadarNowMs();
  assertFieldLimit(services, ctx, input.fields.length, now);

  let baseNotify: RadarNotifyConfigDto = {
    channel_ids: [],
    mode: defaultNotifyMode(ctx),
    min_score: 0.6,
    quiet_hours: null,
    lead_ttl_hours: null,
  };
  if (input.notify) baseNotify = applyNotifyPatch(input.notify, baseNotify);

  // Without explicit channels, deliver to every healthy channel so alerts work out of the box.
  if (!input.notify?.channel_ids && baseNotify.inherit_channels === undefined) {
    baseNotify.channel_ids = ctx.store.channels
      .list()
      .filter((c) => c.state === "ok")
      .map((c) => c.id);
  }

  const rw = ctx.store.radars.createDraft({
    id,
    name: input.name.trim(),
    template_id: input.template_id,
    description: input.description,
    language_hint: input.language_hint ?? "vi",
    user_profession: input.user_profession,
    fields: input.fields,
    match_policy: matchPolicyToStore(input.match_policy),
    source_ids: input.source_ids,
    notify: notifyToStore(baseNotify),
    now_ms: now,
  });

  // Attach the template's seed ruleset (`05-pipeline-rules.md §6.3`).
  if (input.template_id) {
    let seedName: string | null = null;
    try {
      seedName = getTemplate(input.template_id).seed_ruleset;
    } catch (err) {
      if (!(err instanceof CoreError) || err.kind !== "not_found") throw err;
    }
    const seed = seedName ? seedRuleset(seedName) : null;
    if (seed) {
      ctx.store.radars.insertRuleset({
        id: null,
        radar_version_id: rw.current_version.id,
        state: "active",
        origin: "seed",
        body: seed,
        metrics: null,
        now_ms: now,
      });
    }
  }
  return { rw, now };
}

export function radarCreateDraft(ctx: RuntimeContext, services: CatalogServices, input: CreateRadarDraftInput): RadarDetailDto {
  ensureNotShuttingDown(ctx);
  const { rw, now } = persistRadarDraft(ctx, services, input, null);
  return buildRadarDetailDto(ctx, rw, now);
}

export function radarUpdate(ctx: RuntimeContext, services: CatalogServices, input: UpdateRadarInput): RadarUpdateResultDto {
  ensureNotShuttingDown(ctx);
  const now = monotonicRadarNowMs();
  const existing = requireRadar(ctx, input.id);

  if (input.fields) assertFieldLimit(services, ctx, input.fields.length, now);

  const nextNotify = input.notify
    ? notifyToStore(applyNotifyPatch(input.notify, notifyFromStore(existing.radar.notify)))
    : null;

  const noDefinitionEdits =
    input.description === null &&
    input.user_profession === undefined &&
    input.fields === null &&
    input.match_policy === null;

  // Case A: confirm an existing candidate version without definition edits.
  if (input.confirm_version_upgrade === true && noDefinitionEdits && existing.candidate_version) {
    const candidateVersion = existing.candidate_version.version;
    if (input.name !== null || input.notify !== null || input.source_ids !== null) {
      ctx.store.radars.update(input.id, {
        name: input.name,
        notify: nextNotify,
        source_ids: input.source_ids,
        description: null,
        language_hint: null,
        fields: null,
        match_policy: null,
        activate_immediately: true,
        now_ms: now,
      });
    }
    const confirmed = ctx.store.radars.confirmVersion(input.id, candidateVersion, now);
    if (confirmed.radar.status === "active") services.configChanged(ctx);
    return {
      detail: buildRadarDetailDto(ctx, confirmed, now),
      created_new_version: false,
      requires_confirmation: false,
    };
  }

  const activateImmediately = existing.radar.status !== "active" || input.confirm_version_upgrade === true;

  const result = ctx.store.radars.update(input.id, {
    name: input.name,
    notify: nextNotify,
    source_ids: input.source_ids,
    description: input.description,
    language_hint: null,
    user_profession: input.user_profession,
    fields: input.fields,
    match_policy: input.match_policy ? matchPolicyToStore(input.match_policy) : null,
    activate_immediately: activateImmediately,
    now_ms: now,
  });

  if (result.radar.radar.status === "active" && input.source_ids !== null) services.configChanged(ctx);

  return {
    detail: buildRadarDetailDto(ctx, result.radar, now),
    created_new_version: result.version_created !== null,
    requires_confirmation: result.pending_confirmation,
  };
}

export function radarStats(ctx: RuntimeContext, radarId: string | null, days: number): FunnelStatsDto {
  const s = ctx.store.radars.stats(radarId, nowMs());
  return {
    days: Math.max(days, 1),
    posts_captured: s.total_evaluated,
    dedup_dropped: s.dedup_rejected,
    prefilter_dropped: s.prefilter_rejected,
    rule_decided: s.rule_decided,
    rule_matched: s.rule_matched,
    ai_decided: s.ai_decided,
    ai_matched: s.ai_matched,
    leads_created: s.leads_total,
    leads_notified: s.leads_notified,
    leads_weak: s.leads_weak_match,
    false_positives: s.false_positive_count,
  };
}

export const templateList = (): RadarTemplateDto[] => loadTemplates();
export const templateGet = (id: string): RadarTemplateDto => getTemplate(id);

export function createRadarHandlers(services: CatalogServices): HandlerTable {
  return {
    radar_list: (ctx) => radarList(ctx),
    radar_get: (ctx, args) => radarGet(ctx, parseArg(args, "id", dString)),
    radar_create_draft: (ctx, args) =>
      radarCreateDraft(ctx, services, parseArg(args, "input", dCreateRadarDraftInput)),
    radar_update: (ctx, args) => radarUpdate(ctx, services, parseArg(args, "input", dUpdateRadarInput)),
    radar_stats: (ctx, args) => {
      const radarId = parseOptArg(args, "radar_id", dString);
      const days = parseOptArg(args, "days", dU32);
      return radarStats(ctx, radarId, days ?? 7);
    },
    template_list: () => templateList(),
    template_get: (_ctx, args) => templateGet(parseArg(args, "id", dString)),
  };
}
