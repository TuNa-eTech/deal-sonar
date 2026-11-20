// `lead_list/get/mark_read/set_status/update_field/feedback`
// (crates/core/src/service/leads.rs and apps/desktop/src/commands/leads.rs).
// `lead_export` is a separate port (needs the CSV/XLSX writers).

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CommandError, CoreError } from "../backend/wire";
import type { EvaluationRecord, LeadListQuery } from "../store/leads";
import { validateFieldValue } from "../store/field-values";
import type { ExtractedField } from "../store/domain";
import { nowMs } from "../store/util";
import {
  blocklistRecordToDto,
  leadDetailToLeadDto,
  loadLeadDto,
  postDetailToDto,
} from "./catalog-convert";
import {
  type CatalogServices,
  ensureNotShuttingDown,
  getEvalFeedbackLabels,
  readSetting,
  setEvalFeedbackLabel,
} from "./catalog-runtime";
import {
  type Decoder,
  SerdeError,
  dAny,
  dBool,
  dI64,
  dString,
  dVec,
  isPlainObject,
  parseArg,
  parseOptArg,
  struct,
  req,
} from "./catalog-serde";
import {
  type FeedbackLabel,
  type LeadCrmPatch,
  type LeadDetailDto,
  type LeadDto,
  type LeadEventDto,
  type LeadFeedbackInput,
  type LeadFeedbackResultDto,
  type LeadFilterQuery,
  type LeadListResponseDto,
  type LeadStatus,
  type PosterActivityDto,
  dLeadFeedbackInput,
  dLeadFilterQuery,
  dLeadStatus,
  feedbackLabelFromDb,
} from "./catalog-types";

/** `audit_min_samples` and `audit_disagreement_demote_threshold` of `CoreConfig::default()`. */
export const AUDIT_MIN_SAMPLES = 10;
export const AUDIT_DISAGREEMENT_DEMOTE_THRESHOLD = 0.08;

const NEGATIVE_LABELS: readonly FeedbackLabel[] = ["irrelevant", "peer", "duplicate", "spam"];
const DAY_MS = 86_400_000;

// ---- list --------------------------------------------------------------------------------------

/** `build_store_lead_query`. */
export function buildStoreLeadQuery(q: LeadFilterQuery): LeadListQuery {
  return {
    unread_only: q.unread_only,
    follow_up_before: q.follow_up_before,
    follow_up_after: q.follow_up_after,
    exclude_weak: q.include_weak === false,
    radar_id: q.radar_id,
    status: q.status,
    since: q.since,
    min_score: null,
    search: q.search,
    filters: (q.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value })),
    sort: q.sort ? { by: q.sort.by, dir: /^asc$/i.test(q.sort.dir) ? "asc" : "desc" } : null,
    limit: Math.min(500, Math.max(1, q.limit ?? 50)),
    cursor: q.cursor,
    expiry: q.expired !== null ? { expired: q.expired, now_ms: nowMs() } : null,
  };
}

export function leadList(ctx: RuntimeContext, query: LeadFilterQuery): LeadListResponseDto {
  const page = ctx.store.leads.list(buildStoreLeadQuery(query));
  const items: LeadDto[] = [];
  for (const item of page.items) {
    const dto = loadLeadDto(ctx, item.lead.id);
    if (!dto) continue;
    if (query.include_weak === false && dto.is_weak_match) continue;
    items.push(dto);
  }
  return { items, total: page.total, next_cursor: page.next_cursor };
}

// ---- detail ------------------------------------------------------------------------------------

function sortedObject(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

export function leadGet(ctx: RuntimeContext, id: string): LeadDetailDto {
  const detail = ctx.store.leads.leadGet(id);
  if (!detail) throw CoreError.notFound("lead", id);

  const rw = ctx.store.radars.get(detail.lead.radar_id);
  const minScore = rw ? rw.radar.notify.min_score : 0.6;
  const ttl = rw ? (rw.radar.notify.lead_ttl_hours ?? null) : null;
  const version = ctx.store.radars.getVersion(detail.lead.radar_version_id);
  const radarFields = version ? version.fields.map((f) => ({ ...f, options: f.options ? [...f.options] : null })) : [];

  const stored = getEvalFeedbackLabels(ctx)[detail.lead.evaluation_id];
  const feedbackLabel = stored === undefined ? null : feedbackLabelFromDb(stored);
  const lead = leadDetailToLeadDto(detail, minScore, ttl, feedbackLabel);

  const postRecord = ctx.store.posts.get(detail.lead.post_id);
  if (!postRecord) throw CoreError.notFound("post", detail.lead.post_id);

  const events: LeadEventDto[] = detail.events.map((ev) => ({
    id: ev.id,
    lead_id: ev.lead_id,
    kind: ev.kind,
    data: sortedObject(ev.data),
    created_at: ev.created_at,
  }));

  // Best effort: a missing author or signal query must not hide the lead itself.
  const leadPhones: string[] = [];
  for (const f of radarFields) {
    if (f.type !== "phone") continue;
    const value = lead.fields[f.key]?.value;
    if (typeof value === "string") leadPhones.push(value);
  }
  let poster: PosterActivityDto | null = null;
  try {
    const s = ctx.store.posts.getPeerSignals(detail.lead.post_id, leadPhones, nowMs());
    poster = {
      posts_7d: s.author_followed_posts_7d,
      groups_7d: s.author_group_count_7d,
      same_post_groups: s.cluster_source_count,
      phone_shared_by_authors: s.max_distinct_authors_for_phone,
      looks_like_peer: s.is_peer_override,
    };
  } catch {
    poster = null;
  }

  return { lead, post: postDetailToDto(postRecord), radar_fields: radarFields, events, poster };
}

function emitLeadUpdated(ctx: RuntimeContext, detail: LeadDetailDto): LeadDetailDto {
  ctx.emit("lead:updated", detail.lead);
  return detail;
}

export function leadMarkRead(ctx: RuntimeContext, id: string): LeadDetailDto {
  ctx.store.leads.markRead(id, nowMs());
  return emitLeadUpdated(ctx, leadGet(ctx, id));
}

export function leadSetStatus(
  ctx: RuntimeContext,
  id: string,
  status: LeadStatus,
  crm: LeadCrmPatch | null,
): LeadDetailDto {
  ensureNotShuttingDown(ctx);
  const now = nowMs();
  const existing = ctx.store.leads.leadGet(id);
  if (!existing) throw CoreError.notFound("lead", id);

  ctx.store.leads.setStatus(id, status, now);

  if (crm && (crm.note !== undefined || crm.tags !== undefined || crm.follow_up_at !== undefined)) {
    const note = crm.note !== undefined ? crm.note : existing.lead.note;
    const tags = crm.tags !== undefined ? crm.tags : existing.lead.tags;
    const followUp = crm.follow_up_at !== undefined ? crm.follow_up_at : existing.lead.follow_up_at;
    ctx.store.leads.setNoteTagsFollowUp(id, note, tags, followUp, now);
  }
  return emitLeadUpdated(ctx, leadGet(ctx, id));
}

export function leadUpdateField(
  ctx: RuntimeContext,
  id: string,
  fieldKey: string,
  value: unknown,
  raw: string | null,
): LeadDetailDto {
  ensureNotShuttingDown(ctx);
  ctx.store.leads.updateField(id, fieldKey, value, raw, nowMs());
  return emitLeadUpdated(ctx, leadGet(ctx, id));
}

// ---- lead_set_status payload (`parse_lead_set_status_payload`) --------------------------------

function crmField<T>(map: Record<string, unknown>, key: string, dec: Decoder<T>): T | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const raw = map[key];
  if (raw === null) return null;
  try {
    return dec(raw);
  } catch (err) {
    if (err instanceof SerdeError) throw new CommandError("validation_error", `${key} không hợp lệ: ${err.message}`);
    throw err;
  }
}

export function parseLeadSetStatusPayload(raw: unknown): { id: string; status: LeadStatus; crm: LeadCrmPatch | null } {
  if (!isPlainObject(raw)) {
    throw new CommandError("validation_error", "dữ liệu đầu vào lead_set_status phải là đối tượng JSON");
  }
  if (typeof raw.id !== "string") throw new CommandError("validation_error", "thiếu tham số 'id'");
  if (!Object.prototype.hasOwnProperty.call(raw, "status") || raw.status === undefined) {
    throw new CommandError("validation_error", "thiếu tham số 'status'");
  }
  let status: LeadStatus;
  try {
    status = dLeadStatus(raw.status);
  } catch (err) {
    if (err instanceof SerdeError) throw new CommandError("validation_error", `status không hợp lệ: ${err.message}`);
    throw err;
  }
  const note = crmField(raw, "note", dString);
  const tags = crmField(raw, "tags", dVec(dString));
  const followUp = crmField(raw, "follow_up_at", dI64);
  const crm: LeadCrmPatch | null =
    note !== undefined || tags !== undefined || followUp !== undefined
      ? { note, tags, follow_up_at: followUp }
      : null;
  return { id: raw.id, status, crm };
}

// ---- rule-decided negative feedback (`handle_negative_feedback_on_rule_eval`) ------------------

interface AuditHistoryEntry {
  ts_ms: number;
  disagreed: boolean;
}

const dAuditHistory = dVec(
  struct<AuditHistoryEntry>("AuditHistoryEntry", { ts_ms: req(dI64), disagreed: req(dBool) }),
);

/** `CoreRuntime::enqueue_and_wake_job`. */
export function enqueueAndWakeJob(
  ctx: RuntimeContext,
  services: CatalogServices,
  kind: string,
  dedupKey: string | null,
  payload: unknown,
  runAt: number,
): void {
  const now = nowMs();
  ctx.store.jobs.enqueue(kind, dedupKey, payload, runAt, now);
  if (runAt <= now) services.wakeJobs(ctx);
}

/**
 * `record_audit_entries_and_maybe_demote`: a 7-day rolling disagreement ledger; once enough
 * samples disagree, the active ruleset drops back to `shadow` and a recompile is queued.
 */
export function recordAuditEntriesAndMaybeDemote(
  ctx: RuntimeContext,
  services: CatalogServices,
  radarVersionId: string,
  rulesetId: string,
  newEntries: AuditHistoryEntry[],
  now: number,
): boolean {
  if (newEntries.length === 0) return false;
  const key = `runtime.audit_history.${rulesetId}`;
  const since7d = now - 7 * DAY_MS;
  const history = readSetting(ctx, key, dAuditHistory, (): AuditHistoryEntry[] => []).filter((e) => e.ts_ms >= since7d);
  history.push(...newEntries);
  ctx.store.settings.set(key, history);

  if (history.length < AUDIT_MIN_SAMPLES) return false;
  const disagreements = history.filter((e) => e.disagreed).length;
  if (disagreements / history.length > AUDIT_DISAGREEMENT_DEMOTE_THRESHOLD) {
    const active = ctx.store.radars.getActiveRuleset(radarVersionId);
    if (active && active.id === rulesetId) {
      ctx.store.radars.updateRulesetState(rulesetId, "shadow", null, now);
      enqueueAndWakeJob(
        ctx,
        services,
        "compile_ruleset",
        `compile_ruleset:${radarVersionId}`,
        { radar_version_id: radarVersionId },
        now,
      );
      return true;
    }
  }
  return false;
}

export function handleNegativeFeedbackOnRuleEval(
  ctx: RuntimeContext,
  services: CatalogServices,
  evaluation: EvaluationRecord,
  now: number,
): boolean {
  if (evaluation.decided_by !== "rule") return false;
  let rulesetId = evaluation.ruleset_id;
  if (rulesetId === null) {
    const active = ctx.store.radars.getActiveRuleset(evaluation.radar_version_id);
    if (!active) return false;
    rulesetId = active.id;
  }
  const demoted = recordAuditEntriesAndMaybeDemote(
    ctx,
    services,
    evaluation.radar_version_id,
    rulesetId,
    [{ ts_ms: now, disagreed: true }],
    now,
  );
  if (!demoted) {
    enqueueAndWakeJob(
      ctx,
      services,
      "audit_ruleset",
      `audit_ruleset:${rulesetId}`,
      { radar_version_id: evaluation.radar_version_id, ruleset_id: rulesetId },
      now,
    );
  }
  return demoted;
}

// ---- feedback ----------------------------------------------------------------------------------

export function leadFeedback(
  ctx: RuntimeContext,
  services: CatalogServices,
  input: LeadFeedbackInput,
): LeadFeedbackResultDto {
  ensureNotShuttingDown(ctx);
  const now = nowMs();

  if (input.corrected_fields) {
    const evaluation = ctx.store.leads.getEvaluation(input.evaluation_id);
    if (!evaluation) throw CoreError.validation("Không tìm thấy đánh giá");
    const version = ctx.store.radars.getVersion(evaluation.radar_version_id);
    if (!version) throw CoreError.validation("Không tìm thấy phiên bản radar");
    for (const [key, value] of Object.entries(input.corrected_fields)) {
      const field = version.fields.find((f) => f.key === key);
      if (!field) throw CoreError.validation(`Trường không tồn tại: ${key}`);
      validateFieldValue(field, value);
    }
  }

  let correctedStore: Record<string, ExtractedField> | null = null;
  if (input.corrected_fields) {
    correctedStore = {};
    for (const [key, value] of Object.entries(input.corrected_fields)) {
      correctedStore[key] = { value, raw: null, confidence: 1.0, source: "user" };
    }
  }

  const feedback = ctx.store.leads.recordFeedback({
    evaluation_id: input.evaluation_id,
    label: input.label,
    corrected_fields: correctedStore,
    post_text: null,
    origin: input.origin,
    now_ms: now,
  });
  setEvalFeedbackLabel(ctx, input.evaluation_id, input.label);

  // Apply the corrections onto the lead as `source = user`; failures are intentionally ignored.
  if (input.lead_id !== null && input.corrected_fields) {
    for (const [key, value] of Object.entries(input.corrected_fields)) {
      try {
        ctx.store.leads.updateField(input.lead_id, key, value, null, now);
      } catch {
        // `let _ =` in the Rust service.
      }
    }
  }

  if (NEGATIVE_LABELS.includes(input.label)) {
    const evaluation = ctx.store.leads.getEvaluation(input.evaluation_id);
    if (evaluation) handleNegativeFeedbackOnRuleEval(ctx, services, evaluation, now);
  }

  // Marking a rejected post as `missed` from the app promotes it to an Inbox lead.
  let targetLeadId = input.lead_id;
  let createdNewLead = false;
  if (input.label === "missed" && input.origin === "app" && targetLeadId === null) {
    const version = ctx.store.radars.getVersion(feedback.radar_version_id);
    if (version) {
      const [created, wasCreated] = ctx.store.leads.createLead({
        id: null,
        radar_id: version.radar_id,
        radar_version_id: version.id,
        post_id: feedback.post_id,
        evaluation_id: feedback.evaluation_id,
        contact_id: null,
        status: "new",
        score: 0.75,
        summary: Array.from(feedback.post_text).slice(0, 120).join(""),
        fields: {},
        also_seen_in: null,
        notified_at: null,
        follow_up_at: null,
        note: null,
        tags: [],
        now_ms: now,
      });
      targetLeadId = created.id;
      createdNewLead = wasCreated;
    }
  }

  let blockedEntry: LeadFeedbackResultDto["blocked_entry"] = null;
  if (input.block_author === true) {
    const post = ctx.store.posts.get(feedback.post_id);
    if (post && post.author_id !== null) {
      const rec = ctx.store.blocklist.add("author", post.author_id, null, "blocked_from_feedback", now);
      blockedEntry = blocklistRecordToDto(rec, post.author_name);
    }
  }

  const updatedLead = targetLeadId !== null ? loadLeadDto(ctx, targetLeadId) : null;
  if (updatedLead) ctx.emit(createdNewLead ? "lead:new" : "lead:updated", updatedLead);

  return { feedback_id: feedback.id, updated_lead: updatedLead, blocked_entry: blockedEntry };
}

export function createLeadHandlers(services: CatalogServices): HandlerTable {
  return {
    lead_list: (ctx, args) => leadList(ctx, parseArg(args, "query", dLeadFilterQuery)),
    lead_get: (ctx, args) => leadGet(ctx, parseArg(args, "id", dString)),
    lead_mark_read: (ctx, args) => leadMarkRead(ctx, parseArg(args, "id", dString)),
    lead_set_status: (ctx, args) => {
      const { id, status, crm } = parseLeadSetStatusPayload(args);
      return leadSetStatus(ctx, id, status, crm);
    },
    lead_update_field: (ctx, args) => {
      const id = parseArg(args, "id", dString);
      const fieldKey = parseArg(args, "field_key", dString);
      const value = dAny(args.value);
      const raw = parseOptArg(args, "raw", dString);
      return leadUpdateField(ctx, id, fieldKey, value, raw);
    },
    lead_feedback: (ctx, args) => leadFeedback(ctx, services, parseArg(args, "input", dLeadFeedbackInput)),
  };
}
