// Store <-> UI DTO converters used by the pipeline (crates/core/src/dto/{convert,ruleset_convert}.rs
// and the lead/preview/radar builders in pipeline/finalize.rs, preview.rs, service/radars.rs).

import type { ExtractedField as StoreExtractedField } from "../store/domain";
import type { LeadDetail, PendingAiEvaluationItem } from "../store/leads";
import type { RadarListItem, RadarRecord, RadarWithVersion, RulesetRecord } from "../store/radars";
import {
  parseRulesetBody,
  type ClassifyRule,
  type Condition,
  type ExtractRule,
  type PrefilterSpec,
  type RulesetBody as EngineRulesetBody,
} from "../rules/engine";
import { DEFAULT_MONEY_WINDOW } from "../rules/extractors/money";
import type { ExtractedField as RulesExtractedField } from "../rules/types";
import type {
  DecidedBy,
  ExtractedFieldDto,
  FeedbackLabel,
  LeadDto,
  PipelineAuthorRole,
  PostIntent,
  PreviewItem,
  RadarDto,
  RadarNotifyConfigDto,
  RadarStatus,
} from "./types";

export const FEEDBACK_LABELS: readonly FeedbackLabel[] = ["correct", "irrelevant", "wrong_fields", "peer", "duplicate", "spam", "missed"];
export const feedbackLabelFromDb = (s: string | null | undefined): FeedbackLabel | null =>
  s !== null && s !== undefined && (FEEDBACK_LABELS as readonly string[]).includes(s) ? (s as FeedbackLabel) : null;

export function decidedByFromDb(s: string | null | undefined): DecidedBy {
  switch (s) {
    case "dedup": case "prefilter": case "rule": case "postfilter":
      return s;
    default:
      return "ai";
  }
}
export const postIntentFromDb = (s: string | null | undefined): PostIntent => (s === "demand" || s === "supply" ? s : "other");
export const authorRoleFromDb = (s: string | null | undefined): PipelineAuthorRole => (s === "end_user" || s === "peer" ? s : "unknown");
export function radarStatusFromDb(s: string): RadarStatus {
  return s === "active" || s === "paused" || s === "archived" ? s : "draft";
}

export const extractedFieldFromStore = (ef: StoreExtractedField): ExtractedFieldDto => ({
  value: ef.value,
  raw: ef.raw ?? null,
  confidence: ef.confidence,
  source: ef.source,
});

/** `extracted_field_rules_to_store` */
export const extractedFieldRulesToStore = (ef: RulesExtractedField): StoreExtractedField => ({
  value: ef.value,
  raw: ef.raw ?? "",
  confidence: ef.confidence,
  source: ef.source,
});

/** `extracted_field_store_to_rules`: fields without evidence text are dropped. */
export function extractedFieldStoreToRules(ef: StoreExtractedField): RulesExtractedField | null {
  const raw = ef.raw ?? "";
  if (raw.trim().length === 0) return null;
  return { value: ef.value, raw, confidence: ef.confidence, source: ef.source };
}

/** `extracted_field_ai_to_rules` for a validated AI candidate. */
export function extractedFieldAiToRules(c: { raw: string | null; value: unknown; confidence: number }): RulesExtractedField | null {
  const raw = c.raw;
  if (raw === null || raw.trim().length === 0 || c.value === null || c.value === undefined) return null;
  return { value: c.value, raw, confidence: Math.min(1, Math.max(0, c.confidence)), source: "ai" };
}

export const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();
export function sortRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(sortedKeys(r).map((k) => [k, r[k]]));
}

// ---- leads --------------------------------------------------------------------------------------

/** Instant after which a lead is no longer worth acting on. */
export function leadExpiresAt(postCreatedAt: number | null, capturedAt: number, ttlHours: number | null | undefined): number | null {
  return ttlHours === null || ttlHours === undefined ? null : (postCreatedAt ?? capturedAt) + ttlHours * 3_600_000;
}

export function leadDetailToLeadDto(
  detail: LeadDetail,
  minScore: number,
  leadTtlHours: number | null | undefined,
  feedbackLabel: FeedbackLabel | null,
): LeadDto {
  const fields: Record<string, ExtractedFieldDto> = {};
  for (const k of sortedKeys(detail.lead.fields)) fields[k] = extractedFieldFromStore(detail.lead.fields[k]);
  return {
    id: detail.lead.id,
    radar_id: detail.lead.radar_id,
    radar_name: detail.radar_name,
    radar_version_id: detail.lead.radar_version_id,
    radar_version: detail.evaluation.radar_version,
    post_id: detail.lead.post_id,
    evaluation_id: detail.lead.evaluation_id,
    contact_id: detail.lead.contact_id,
    status: leadStatusFromDb(detail.lead.status),
    read_at: detail.lead.read_at,
    score: detail.lead.score,
    is_weak_match: detail.lead.score < minScore,
    summary: detail.lead.summary,
    reason: detail.evaluation.reason,
    decided_by: decidedByFromDb(detail.evaluation.decided_by),
    fields,
    source_id: detail.source_id,
    source_name: detail.source_name,
    author_id: detail.author_id,
    author_name: detail.author_name ?? "Ẩn danh",
    permalink: detail.permalink,
    post_created_at: detail.post_created_at,
    expires_at: leadExpiresAt(detail.post_created_at, detail.post_captured_at, leadTtlHours),
    also_seen_in: detail.lead.also_seen_in.map((e) => ({
      source_id: e.source_id,
      source_name: e.source_name,
      permalink: e.permalink,
      captured_at: e.captured_at,
    })),
    notified_at: detail.lead.notified_at,
    follow_up_at: detail.lead.follow_up_at,
    note: detail.lead.note,
    tags: detail.lead.tags,
    feedback_label: feedbackLabel,
    created_at: detail.lead.created_at,
    updated_at: detail.lead.updated_at,
  };
}

export function leadStatusFromDb(s: string): string {
  return ["viewed", "contacted", "negotiating", "won", "lost", "ignored"].includes(s) ? s : "new";
}

// ---- previews -----------------------------------------------------------------------------------

export function previewEvalItemToDto(item: PendingAiEvaluationItem): PreviewItem {
  const fields: Record<string, ExtractedFieldDto> = {};
  const src = item.evaluation.fields ?? {};
  for (const k of sortedKeys(src)) fields[k] = extractedFieldFromStore(src[k]);
  return {
    evaluation_id: item.evaluation.id,
    post_id: item.post.id,
    verdict: item.evaluation.verdict ?? "no_match",
    score: item.evaluation.score ?? 0,
    intent: postIntentFromDb(item.evaluation.intent),
    author_role: authorRoleFromDb(item.evaluation.author_role),
    summary: item.evaluation.summary ?? "",
    reason: item.evaluation.reason ?? "",
    decided_by: decidedByFromDb(item.evaluation.decided_by),
    fields,
    source_name: item.source_name,
    author_name: item.author_name ?? "Ẩn danh",
    permalink: item.post.permalink,
    post_text: item.post.text ?? "",
    post_created_at: item.post.created_at,
    feedback_label: null,
  };
}

// ---- radars -------------------------------------------------------------------------------------

export function notifyFromStore(n: RadarRecord["notify"]): RadarNotifyConfigDto {
  const out: RadarNotifyConfigDto = {
    channel_ids: n.channel_ids,
    mode: n.mode === "digest" ? "digest" : "instant",
    min_score: n.min_score,
    quiet_hours: n.quiet_hours ? { from: n.quiet_hours.from, to: n.quiet_hours.to } : null,
    lead_ttl_hours: n.lead_ttl_hours && n.lead_ttl_hours > 0 ? n.lead_ttl_hours : null,
  };
  if (n.inherit_channels !== undefined) out.inherit_channels = n.inherit_channels;
  return out;
}

/** `Radar` DTO (field order of the Rust struct; optional stats omitted when unknown). */
export function radarToDto(
  rw: RadarWithVersion,
  meta: RadarListItem | undefined,
  ruleHandledRatio: number,
  isFlood: boolean,
): RadarDto {
  const out: RadarDto = {
    id: rw.radar.id,
    name: rw.radar.name,
    status: radarStatusFromDb(rw.radar.status),
    template_id: rw.radar.template_id,
    current_version: rw.radar.current_version,
    source_ids: rw.source_ids,
    notify: notifyFromStore(rw.radar.notify),
    created_at: rw.radar.created_at,
    updated_at: rw.radar.updated_at,
  };
  if (meta) {
    out.leads_24h = meta.leads_24h;
    out.false_positive_rate = meta.false_positive_rate;
    out.evaluated_posts_total = meta.evaluated_posts_total;
  }
  out.rule_handled_pct = ruleHandledRatio * 100;
  if (isFlood) out.auto_digest_flood = true;
  return out;
}

// ---- rulesets (engine <-> UI body) --------------------------------------------------------------

export interface DtoRulesetExtractorRule {
  field: string;
  extractor: string;
  near?: string[];
  window?: number;
  dict?: string;
  scope?: string;
  units?: string[];
  prefixes?: string[];
  multipliers?: Record<string, number>;
  pattern?: string;
  group?: number;
  cast?: string;
  map?: Record<string, string[]>;
  multi?: boolean;
}
export interface DtoRulesetClassifyRule {
  id: string;
  description?: string;
  kw_any?: string[];
  kw_none?: string[];
  has_field?: string;
  when?: Condition;
  verdict: string;
  confidence: number;
  set?: Record<string, unknown>;
}
export interface DtoRulesetBody {
  dsl: number;
  prefilter: { any: string[]; none: string[]; min_len?: number };
  classify: DtoRulesetClassifyRule[];
  extract: DtoRulesetExtractorRule[];
  thresholds: { accept: number; reject: number };
}
export interface RulesetMetrics {
  rule_handled_pct: number;
  ai_handled_pct: number;
  accept_precision: number;
  false_negative_rate: number;
  sample_size: number;
}
export interface RulesetDto {
  id: string;
  radar_version_id: string;
  revision: number;
  state: string;
  origin: string;
  body: DtoRulesetBody;
  metrics: RulesetMetrics | null;
  created_at: number;
  activated_at: number | null;
}

function extractFlatConditionHints(c: Condition, kwAny: string[], kwNone: string[], hasField: { v: string | null }): void {
  if ("kw_any" in c) {
    for (const kw of c.kw_any) if (!kwAny.includes(kw)) kwAny.push(kw);
  } else if ("kw_none" in c) {
    for (const kw of c.kw_none) if (!kwNone.includes(kw)) kwNone.push(kw);
  } else if ("has_field" in c) {
    if (hasField.v === null) hasField.v = c.has_field;
  } else if ("all" in c) {
    for (const child of c.all) extractFlatConditionHints(child, kwAny, kwNone, hasField);
  }
}

export function rulesToDtoRulesetBody(body: EngineRulesetBody): DtoRulesetBody {
  const pf = body.prefilter;
  const prefilter: DtoRulesetBody["prefilter"] = pf
    ? { any: pf.any, none: pf.none, ...(pf.min_len !== null ? { min_len: pf.min_len } : {}) }
    : { any: [], none: [] };
  const classify = body.classify.map((rule): DtoRulesetClassifyRule => {
    const kwAny: string[] = [];
    const kwNone: string[] = [];
    const hf = { v: null as string | null };
    extractFlatConditionHints(rule.when, kwAny, kwNone, hf);
    return {
      id: rule.id,
      ...(kwAny.length > 0 ? { kw_any: kwAny } : {}),
      ...(kwNone.length > 0 ? { kw_none: kwNone } : {}),
      ...(hf.v !== null ? { has_field: hf.v } : {}),
      when: rule.when,
      verdict: rule.verdict,
      confidence: rule.confidence,
      ...(Object.keys(rule.set).length > 0 ? { set: rule.set } : {}),
    };
  });
  const extract = body.extract.map((er): DtoRulesetExtractorRule => {
    switch (er.extractor) {
      case "vn_money":
        return { field: er.field, extractor: "vn_money", ...(er.near.length > 0 ? { near: er.near } : {}), window: er.window };
      case "gazetteer":
        return { field: er.field, extractor: "gazetteer", dict: er.dict, ...(er.scope !== null ? { scope: er.scope } : {}) };
      case "number":
        return { field: er.field, extractor: "number", units: er.units, prefixes: er.prefixes, multipliers: er.multipliers };
      case "enum_kw":
        return { field: er.field, extractor: "enum_kw", map: er.map, multi: er.multi };
      case "regex":
        return { field: er.field, extractor: "regex", pattern: er.pattern, group: er.group, cast: er.cast };
      default:
        return { field: er.field, extractor: er.extractor };
    }
  });
  return { dsl: body.dsl, prefilter, classify, extract, thresholds: { accept: body.thresholds.accept, reject: body.thresholds.reject } };
}

/** UI body -> canonical engine body (`dto_ruleset_body_to_rules`). */
export function dtoRulesetBodyToRules(dto: DtoRulesetBody): EngineRulesetBody {
  const pf = dto.prefilter;
  const prefilter: PrefilterSpec | null =
    pf.any.length === 0 && pf.none.length === 0 && pf.min_len === undefined
      ? null
      : { any: pf.any, none: pf.none, min_len: pf.min_len ?? null };

  const classify = dto.classify.map((r): ClassifyRule => {
    const curAny = r.kw_any && r.kw_any.length > 0 ? r.kw_any : null;
    const curNone = r.kw_none && r.kw_none.length > 0 ? r.kw_none : null;
    const curHfRaw = r.has_field?.trim() ?? "";
    const curHf = curHfRaw.length > 0 ? curHfRaw : null;
    let preserve = false;
    if (r.when) {
      const oa: string[] = [];
      const on: string[] = [];
      const oh = { v: null as string | null };
      extractFlatConditionHints(r.when, oa, on, oh);
      const origAny = oa.length > 0 ? oa : null;
      const origNone = on.length > 0 ? on : null;
      const hfTrim = oh.v?.trim() ?? "";
      const origHf = hfTrim.length > 0 ? hfTrim : null;
      const same = JSON.stringify(curAny) === JSON.stringify(origAny) && JSON.stringify(curNone) === JSON.stringify(origNone) && curHf === origHf;
      preserve = same || (curAny === null && curNone === null && curHf === null);
    }
    let when: Condition;
    if (preserve && r.when) {
      when = r.when;
    } else {
      const clauses: Condition[] = [];
      if (curAny) clauses.push({ kw_any: curAny });
      if (curNone) clauses.push({ kw_none: curNone });
      if (curHf) clauses.push({ has_field: curHf });
      if (clauses.length === 0) when = r.when ?? { len_gt: 0 };
      else if (clauses.length === 1) when = clauses[0];
      else when = { all: clauses };
    }
    return {
      id: r.id,
      when,
      verdict: r.verdict === "no_match" ? "no_match" : "match",
      confidence: r.confidence,
      set: r.set ?? {},
    };
  });

  const extract = dto.extract.map((er): ExtractRule => {
    const f = er.field;
    switch (er.extractor) {
      case "vn_money":
        return { field: f, extractor: "vn_money", near: er.near ?? [], window: er.window ?? DEFAULT_MONEY_WINDOW };
      case "vn_phone":
        return { field: f, extractor: "vn_phone" };
      case "vn_area":
        return { field: f, extractor: "vn_area" };
      case "gazetteer":
        return { field: f, extractor: "gazetteer", dict: er.dict ?? "vn_admin", scope: er.scope ?? null };
      case "number":
        return { field: f, extractor: "number", units: er.units ?? [], prefixes: er.prefixes ?? [], multipliers: er.multipliers ?? {} };
      case "date_vi":
        return { field: f, extractor: "date_vi" };
      case "enum_kw":
        return { field: f, extractor: "enum_kw", map: er.map ?? {}, multi: er.multi ?? false };
      case "regex":
        return {
          field: f,
          extractor: "regex",
          pattern: er.pattern ?? "",
          group: er.group ?? 0,
          cast: (er.cast as "string" | "int" | "float" | "bool" | undefined) ?? "string",
        };
      default:
        return { field: f, extractor: "vn_phone" };
    }
  });

  return { dsl: dto.dsl, prefilter, classify, extract, thresholds: { accept: dto.thresholds.accept, reject: dto.thresholds.reject } };
}

function emptyDtoBody(): DtoRulesetBody {
  return { dsl: 1, prefilter: { any: [], none: [] }, classify: [], extract: [], thresholds: { accept: 0.9, reject: 0.9 } };
}

function lenientDtoBody(v: unknown): DtoRulesetBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return emptyDtoBody();
  const o = v as Record<string, unknown>;
  const pf = (o.prefilter ?? {}) as Record<string, unknown>;
  const th = (o.thresholds ?? {}) as Record<string, unknown>;
  const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  try {
    return {
      dsl: typeof o.dsl === "number" ? o.dsl : 1,
      prefilter: { any: arr(pf.any), none: arr(pf.none), ...(typeof pf.min_len === "number" ? { min_len: pf.min_len } : {}) },
      classify: Array.isArray(o.classify) ? (o.classify as DtoRulesetClassifyRule[]) : [],
      extract: Array.isArray(o.extract) ? (o.extract as DtoRulesetExtractorRule[]) : [],
      thresholds: { accept: typeof th.accept === "number" ? th.accept : 0.9, reject: typeof th.reject === "number" ? th.reject : 0.9 },
    };
  } catch {
    return emptyDtoBody();
  }
}

function metricsFromJson(v: unknown): RulesetMetrics | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  const keys = ["rule_handled_pct", "ai_handled_pct", "accept_precision", "false_negative_rate", "sample_size"] as const;
  if (!keys.every((k) => typeof m[k] === "number")) return null;
  return {
    rule_handled_pct: m.rule_handled_pct as number,
    ai_handled_pct: m.ai_handled_pct as number,
    accept_precision: m.accept_precision as number,
    false_negative_rate: m.false_negative_rate as number,
    sample_size: m.sample_size as number,
  };
}

export function rulesetRecordToDto(rec: RulesetRecord): RulesetDto {
  let body: DtoRulesetBody;
  try {
    body = rulesToDtoRulesetBody(parseRulesetBody(rec.body));
  } catch {
    body = lenientDtoBody(rec.body);
  }
  return {
    id: rec.id,
    radar_version_id: rec.radar_version_id,
    revision: rec.revision,
    state: rec.state,
    origin: rec.origin,
    body,
    metrics: metricsFromJson(rec.metrics),
    created_at: rec.created_at,
    activated_at: rec.activated_at,
  };
}
