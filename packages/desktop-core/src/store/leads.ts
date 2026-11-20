// Port of crates/store/src/leads/{records,evaluations,feedback,list,rows}.rs and models/leads.rs.

import type Database from "better-sqlite3";

import {
  type ExtractedField,
  type FieldDef,
  DomainShapeError,
  normalizeExtractedField,
  normalizeFieldDefs,
} from "./domain";
import { StoreError } from "./errors";
import { validateFieldValue } from "./field-values";
import {
  type LeadFieldFilter,
  SqlParams,
  buildDynamicFilterClause,
  buildDynamicSortExpr,
} from "./lead-filters";
import { type AlsoSeenInEntry, type PostRecord, mapPostRow } from "./posts";
import { buildFts5Query, isValidFieldKey, newUlid } from "./util";

export type FieldMap = Record<string, ExtractedField>;

export interface EvaluationUpsertInput {
  id?: string | null;
  post_id: string;
  radar_version_id: string;
  state: string;
  decided_by?: string | null;
  verdict?: string | null;
  reject_reason?: string | null;
  score?: number | null;
  intent?: string | null;
  author_role?: string | null;
  summary?: string | null;
  reason?: string | null;
  fields?: FieldMap | null;
  ruleset_id?: string | null;
  ai_call_id?: string | null;
  is_preview?: boolean;
  created_at: number;
  decided_at?: number | null;
}

export interface EvaluationDoneInput {
  decided_by: string;
  verdict: string;
  reject_reason?: string | null;
  score?: number | null;
  intent?: string | null;
  author_role?: string | null;
  summary?: string | null;
  reason?: string | null;
  fields?: FieldMap | null;
  ruleset_id?: string | null;
  ai_call_id?: string | null;
  decided_at: number;
}

export interface EvaluationRecord {
  id: string;
  post_id: string;
  radar_version_id: string;
  state: string;
  decided_by: string | null;
  verdict: string | null;
  reject_reason: string | null;
  score: number | null;
  intent: string | null;
  author_role: string | null;
  summary: string | null;
  reason: string | null;
  fields: FieldMap | null;
  ruleset_id: string | null;
  ai_call_id: string | null;
  is_preview: boolean;
  created_at: number;
  decided_at: number | null;
}

export interface PendingAiEvaluationItem {
  evaluation: EvaluationRecord;
  post: PostRecord;
  source_name: string;
  author_name: string | null;
}

export interface PendingAiGroup {
  radar_version_id: string;
  is_preview: boolean;
  count: number;
  oldest_created_at: number;
  items: PendingAiEvaluationItem[];
}

export interface CreateLeadInput {
  id?: string | null;
  radar_id: string;
  radar_version_id: string;
  post_id: string;
  evaluation_id: string;
  contact_id?: string | null;
  status?: string;
  score: number;
  summary: string;
  fields: FieldMap;
  also_seen_in?: AlsoSeenInEntry[] | null;
  notified_at?: number | null;
  follow_up_at?: number | null;
  note?: string | null;
  tags?: string[] | null;
  now_ms: number;
}

export interface LeadRecord {
  id: string;
  radar_id: string;
  radar_version_id: string;
  post_id: string;
  evaluation_id: string;
  contact_id: string | null;
  status: string;
  read_at: number | null;
  score: number;
  summary: string;
  fields: FieldMap;
  also_seen_in: AlsoSeenInEntry[];
  notified_at: number | null;
  follow_up_at: number | null;
  note: string | null;
  tags: string[];
  created_at: number;
  updated_at: number;
}

export interface LeadEventRecord {
  id: string;
  lead_id: string;
  kind: string;
  data: unknown | null;
  created_at: number;
}

export interface LeadEvaluationInfo {
  id: string;
  radar_version: number;
  decided_by: string | null;
  verdict: string | null;
  score: number | null;
  intent: string | null;
  author_role: string | null;
  reason: string | null;
  ruleset_id: string | null;
  ai_call_id: string | null;
}

export interface LeadDetail {
  lead: LeadRecord;
  radar_name: string;
  source_id: string;
  source_name: string;
  author_id: string | null;
  author_name: string | null;
  post_text: string | null;
  post_text_norm: string | null;
  permalink: string;
  post_created_at: number | null;
  post_captured_at: number;
  evaluation: LeadEvaluationInfo;
  events: LeadEventRecord[];
}

export interface LeadListItem {
  lead: LeadRecord;
  radar_name: string;
  source_id: string;
  source_name: string;
  author_id: string | null;
  author_name: string | null;
  permalink: string;
  post_created_at: number | null;
  post_text: string | null;
}

export interface LeadSort {
  by: string;
  dir?: "asc" | "desc";
}

export interface LeadExpiryFilter {
  expired: boolean;
  now_ms: number;
}

export interface LeadListQuery {
  unread_only?: boolean | null;
  follow_up_before?: number | null;
  follow_up_after?: number | null;
  exclude_weak?: boolean | null;
  radar_id?: string | null;
  status?: string[] | null;
  since?: number | null;
  min_score?: number | null;
  filters?: LeadFieldFilter[];
  search?: string | null;
  sort?: LeadSort | null;
  limit?: number;
  cursor?: string | null;
  expiry?: LeadExpiryFilter | null;
}

export interface LeadListPage {
  total: number;
  items: LeadListItem[];
  next_cursor: string | null;
}

export interface RecordFeedbackInput {
  evaluation_id: string;
  label: string;
  corrected_fields?: FieldMap | null;
  post_text?: string | null;
  origin: string;
  now_ms: number;
}

export interface FeedbackRecord {
  expected_match: boolean;
  id: string;
  evaluation_id: string;
  radar_version_id: string;
  post_id: string;
  label: string;
  corrected_fields: FieldMap | null;
  post_text: string;
  origin: string;
  created_at: number;
}

export type LabeledSampleOrigin = { feedback: string } | "ai_high_confidence";

export interface LabeledSample {
  post_id: string;
  evaluation_id: string;
  post_text: string;
  text_fold: string | null;
  is_match: boolean;
  author_role: string | null;
  score: number | null;
  fields: FieldMap | null;
  origin: LabeledSampleOrigin;
}

/** SQL expression for a lead's expiry instant (`r` = radars, `p` = posts); NULL without a TTL. */
export const LEAD_EXPIRES_AT_SQL =
  "(COALESCE(p.created_at, p.captured_at) + CAST(json_extract(r.notify, '$.lead_ttl_hours') AS INTEGER) * 3600000)";

type Row = Record<string, unknown>;

const LEAD_STATUSES = ["new", "viewed", "contacted", "negotiating", "won", "lost", "ignored"];
const FEEDBACK_LABELS = ["correct", "irrelevant", "wrong_fields", "peer", "duplicate", "spam", "missed"];
const NEGATIVE_LABELS = ["irrelevant", "peer", "duplicate", "spam"];

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ---- field-map (BTreeMap<String, ExtractedField>) (de)serialization ---------------------------

function sortKeys<T>(map: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(map).sort()) out[k] = map[k];
  return out;
}

export function parseFieldMap(raw: string): FieldMap {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainShapeError("invalid type: expected a map");
  }
  const out: FieldMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = normalizeExtractedField(v);
  return sortKeys(out);
}

const parseFieldMapOrNull = (raw: unknown): FieldMap | null => (typeof raw === "string" ? parseFieldMap(raw) : null);
const parseFieldMapLenient = (raw: unknown): FieldMap | null => {
  if (typeof raw !== "string") return null;
  try {
    return parseFieldMap(raw);
  } catch {
    return null;
  }
};

export function serializeFieldMap(map: FieldMap): string {
  const out: FieldMap = {};
  for (const [k, v] of Object.entries(map)) out[k] = normalizeExtractedField(v);
  return JSON.stringify(sortKeys(out));
}

function parseAlsoSeen(raw: unknown): AlsoSeenInEntry[] {
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const ok = v.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof e.post_id === "string" &&
        typeof e.source_id === "string" &&
        typeof e.source_name === "string" &&
        typeof e.permalink === "string" &&
        typeof e.captured_at === "number",
    );
    return ok
      ? (v as AlsoSeenInEntry[]).map((e) => ({
          post_id: e.post_id,
          source_id: e.source_id,
          source_name: e.source_name,
          permalink: e.permalink,
          captured_at: e.captured_at,
        }))
      : [];
  } catch {
    return [];
  }
}

function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function parseJsonLenient(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- row mappers ------------------------------------------------------------------------------

function mapEvaluationRow(row: Row, p = ""): EvaluationRecord {
  const g = (k: string): unknown => row[`${p}${k}`];
  return {
    id: g("id") as string,
    post_id: g("post_id") as string,
    radar_version_id: g("radar_version_id") as string,
    state: g("state") as string,
    decided_by: g("decided_by") as string | null,
    verdict: g("verdict") as string | null,
    reject_reason: g("reject_reason") as string | null,
    score: g("score") as number | null,
    intent: g("intent") as string | null,
    author_role: g("author_role") as string | null,
    summary: g("summary") as string | null,
    reason: g("reason") as string | null,
    fields: parseFieldMapOrNull(g("fields")),
    ruleset_id: g("ruleset_id") as string | null,
    ai_call_id: g("ai_call_id") as string | null,
    is_preview: num(g("is_preview")) !== 0,
    created_at: num(g("created_at")),
    decided_at: numOrNull(g("decided_at")),
  };
}

export function mapLeadRow(row: Row): LeadRecord {
  return {
    id: row.id as string,
    radar_id: row.radar_id as string,
    radar_version_id: row.radar_version_id as string,
    post_id: row.post_id as string,
    evaluation_id: row.evaluation_id as string,
    contact_id: row.contact_id as string | null,
    status: row.status as string,
    read_at: row.read_at as number | null,
    score: row.score as number,
    summary: row.summary as string,
    fields: parseFieldMap(row.fields as string),
    also_seen_in: parseAlsoSeen(row.also_seen_in),
    notified_at: row.notified_at as number | null,
    follow_up_at: row.follow_up_at as number | null,
    note: row.note as string | null,
    tags: parseStringList(row.tags),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function mapLeadListItemRow(row: Row): LeadListItem {
  return {
    lead: mapLeadRow(row),
    radar_name: row.radar_name as string,
    source_id: row.source_id as string,
    source_name: row.source_name as string,
    author_id: row.author_id as string | null,
    author_name: row.author_name as string | null,
    permalink: row.permalink as string,
    post_created_at: row.post_created_at as number | null,
    post_text: row.post_text as string | null,
  };
}

function mapFeedbackRow(row: Row): FeedbackRecord {
  return {
    expected_match: num(row.expected_match) !== 0,
    id: row.id as string,
    evaluation_id: row.evaluation_id as string,
    radar_version_id: row.radar_version_id as string,
    post_id: row.post_id as string,
    label: row.label as string,
    corrected_fields: parseFieldMapOrNull(row.corrected_fields),
    post_text: row.post_text as string,
    origin: row.origin as string,
    created_at: row.created_at as number,
  };
}

function mapJoinedEvalPostRow(row: Row): PendingAiEvaluationItem {
  return {
    evaluation: mapEvaluationRow(normalizeEvalAliases(row), "eval_"),
    post: mapPostRow(row),
    source_name: row.source_name as string,
    author_name: row.author_name as string | null,
  };
}

// The joined evaluation columns are aliased `eval_<col>`, except `radar_version_id` -> `eval_rvid`.
function normalizeEvalAliases(row: Row): Row {
  const r = { ...row };
  r.eval_radar_version_id = row.eval_rvid;
  return r;
}

const EVAL_POST_SELECT = `
  SELECT
    e.id AS eval_id, e.post_id AS eval_post_id, e.radar_version_id AS eval_rvid,
    e.state AS eval_state, e.decided_by AS eval_decided_by, e.verdict AS eval_verdict,
    e.reject_reason AS eval_reject_reason, e.score AS eval_score, e.intent AS eval_intent,
    e.author_role AS eval_author_role, e.summary AS eval_summary, e.reason AS eval_reason,
    e.fields AS eval_fields, e.ruleset_id AS eval_ruleset_id, e.ai_call_id AS eval_ai_call_id,
    e.is_preview AS eval_is_preview, e.created_at AS eval_created_at, e.decided_at AS eval_decided_at,
    p.*, s.name AS source_name, a.name AS author_name
  FROM evaluations e
  JOIN posts p ON p.id = e.post_id
  JOIN sources s ON s.id = p.source_id
  LEFT JOIN authors a ON a.id = p.author_id`;

function parseCursorOffset(cursor: string | null | undefined): number {
  if (cursor == null) return 0;
  const trimmed = cursor.trim();
  if (trimmed === "") return 0;
  const numStr = trimmed.startsWith("off:") ? trimmed.slice(4) : trimmed;
  if (!/^\+?[0-9]+$/.test(numStr)) {
    throw StoreError.invalidArgument(`invalid pagination cursor '${trimmed}'`);
  }
  return Number(numStr);
}

export class Leads {
  constructor(private readonly db: Database.Database) {}

  private withBigInts(sql: string): Database.Statement {
    return this.db.prepare(sql).safeIntegers(true);
  }

  // ---- evaluations --------------------------------------------------------------------------

  /** Upsert on `(post_id, radar_version_id, is_preview)`. */
  upsertEvaluation(input: EvaluationUpsertInput): EvaluationRecord {
    if (!["pending_ai", "done", "ai_failed"].includes(input.state)) {
      throw StoreError.invalidArgument(`invalid evaluation state '${input.state}'`);
    }
    const id = input.id ?? newUlid(input.created_at);
    const fieldsJson = input.fields ? serializeFieldMap(input.fields) : null;
    const isPreview = input.is_preview ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO evaluations (
           id, post_id, radar_version_id, state, decided_by, verdict, reject_reason,
           score, intent, author_role, summary, reason, fields,
           ruleset_id, ai_call_id, is_preview, created_at, decided_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7,
           ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, ?18
         )
         ON CONFLICT(post_id, radar_version_id, is_preview) DO UPDATE SET
           state = excluded.state,
           decided_by = excluded.decided_by,
           verdict = excluded.verdict,
           reject_reason = excluded.reject_reason,
           score = excluded.score,
           intent = excluded.intent,
           author_role = excluded.author_role,
           summary = excluded.summary,
           reason = excluded.reason,
           fields = COALESCE(excluded.fields, evaluations.fields),
           ruleset_id = COALESCE(excluded.ruleset_id, evaluations.ruleset_id),
           ai_call_id = COALESCE(excluded.ai_call_id, evaluations.ai_call_id),
           decided_at = excluded.decided_at`,
      )
      .run(
        id,
        input.post_id,
        input.radar_version_id,
        input.state,
        input.decided_by ?? null,
        input.verdict ?? null,
        input.reject_reason ?? null,
        input.score ?? null,
        input.intent ?? null,
        input.author_role ?? null,
        input.summary ?? null,
        input.reason ?? null,
        fieldsJson,
        input.ruleset_id ?? null,
        input.ai_call_id ?? null,
        isPreview,
        input.created_at,
        input.decided_at ?? null,
      );
    return mapEvaluationRow(
      this.db
        .prepare("SELECT * FROM evaluations WHERE post_id = ?1 AND radar_version_id = ?2 AND is_preview = ?3")
        .get(input.post_id, input.radar_version_id, isPreview) as Row,
    );
  }

  getEvaluation(evaluationId: string): EvaluationRecord | null {
    const row = this.db.prepare("SELECT * FROM evaluations WHERE id = ?1").get(evaluationId) as Row | undefined;
    return row ? mapEvaluationRow(row) : null;
  }

  private pendingItems(radarVersionId: string, isPreview: boolean, limit: number): PendingAiEvaluationItem[] {
    const lim = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const rows = this.withBigInts(
      `${EVAL_POST_SELECT}
       WHERE e.state = 'pending_ai' AND e.radar_version_id = ?1 AND e.is_preview = ?2
       ORDER BY e.created_at ASC LIMIT ?3`,
    ).all(radarVersionId, isPreview ? 1 : 0, lim) as Row[];
    return rows.map(mapJoinedEvalPostRow);
  }

  /** `pending_ai` evaluations grouped by `(radar_version_id, is_preview)`, oldest group first. */
  listPendingAiBatches(): PendingAiGroup[] {
    const keys = this.db
      .prepare(
        `SELECT radar_version_id, is_preview, MIN(created_at) AS oldest_created_at
         FROM evaluations WHERE state = 'pending_ai'
         GROUP BY radar_version_id, is_preview ORDER BY oldest_created_at ASC`,
      )
      .all() as Array<{ radar_version_id: string; is_preview: number; oldest_created_at: number }>;
    return keys.map((k) => {
      const items = this.pendingItems(k.radar_version_id, k.is_preview !== 0, 500);
      return {
        radar_version_id: k.radar_version_id,
        is_preview: k.is_preview !== 0,
        count: items.length,
        oldest_created_at: k.oldest_created_at,
        items,
      };
    });
  }

  listPendingAiForVersion(radarVersionId: string, isPreview: boolean, limit: number): PendingAiEvaluationItem[] {
    return this.pendingItems(radarVersionId, isPreview, limit);
  }

  markEvaluationDone(evaluationId: string, update: EvaluationDoneInput): EvaluationRecord {
    const changed = this.db
      .prepare(
        `UPDATE evaluations
         SET state = 'done', decided_by = ?1, verdict = ?2, reject_reason = ?3, score = ?4,
             intent = ?5, author_role = ?6, summary = ?7, reason = ?8, fields = ?9,
             ruleset_id = COALESCE(?10, ruleset_id), ai_call_id = COALESCE(?11, ai_call_id),
             decided_at = ?12
         WHERE id = ?13`,
      )
      .run(
        update.decided_by,
        update.verdict,
        update.reject_reason ?? null,
        update.score ?? null,
        update.intent ?? null,
        update.author_role ?? null,
        update.summary ?? null,
        update.reason ?? null,
        update.fields ? serializeFieldMap(update.fields) : null,
        update.ruleset_id ?? null,
        update.ai_call_id ?? null,
        update.decided_at,
        evaluationId,
      ).changes;
    if (changed === 0) throw StoreError.notFound("evaluation", evaluationId);
    return mapEvaluationRow(this.db.prepare("SELECT * FROM evaluations WHERE id = ?1").get(evaluationId) as Row);
  }

  markEvaluationAiFailed(
    evaluationId: string,
    aiCallId: string | null,
    reason: string | null,
    decidedAt: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE evaluations
           SET state = 'ai_failed', ai_call_id = COALESCE(?1, ai_call_id),
               reason = COALESCE(?2, reason), decided_at = ?3
           WHERE id = ?4`,
        )
        .run(aiCallId, reason, decidedAt, evaluationId).changes > 0
    );
  }

  requeueAiFailedEvaluations(): number {
    return this.db
      .prepare("UPDATE evaluations SET state = 'pending_ai', decided_at = NULL WHERE state = 'ai_failed'")
      .run().changes;
  }

  cleanupPreviewEvaluations(radarVersionId: string | null, olderThanMs: number | null): number {
    if (radarVersionId !== null && olderThanMs !== null) {
      return this.db
        .prepare("DELETE FROM evaluations WHERE is_preview = 1 AND radar_version_id = ?1 AND created_at < ?2")
        .run(radarVersionId, olderThanMs).changes;
    }
    if (radarVersionId !== null) {
      return this.db
        .prepare("DELETE FROM evaluations WHERE is_preview = 1 AND radar_version_id = ?1")
        .run(radarVersionId).changes;
    }
    if (olderThanMs !== null) {
      return this.db
        .prepare("DELETE FROM evaluations WHERE is_preview = 1 AND created_at < ?1")
        .run(olderThanMs).changes;
    }
    return this.db.prepare("DELETE FROM evaluations WHERE is_preview = 1").run().changes;
  }

  listPreviewEvaluations(radarVersionId: string): PendingAiEvaluationItem[] {
    const rows = this.withBigInts(
      `${EVAL_POST_SELECT}
       WHERE e.radar_version_id = ?1 AND e.is_preview = 1
       ORDER BY COALESCE(e.score, 0.0) DESC, e.created_at DESC`,
    ).all(radarVersionId) as Row[];
    return rows.map(mapJoinedEvalPostRow);
  }

  /** `[total, matched]` AI evaluations for a version (compile trigger: >= 150 total, >= 20 matched). */
  countAiEvaluationsForVersion(radarVersionId: string): [number, number] {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verdict = 'match' THEN 1 ELSE 0 END), 0) AS matched
         FROM evaluations
         WHERE radar_version_id = ?1 AND is_preview = 0 AND state = 'done' AND decided_by = 'ai'`,
      )
      .get(radarVersionId) as { total: number; matched: number };
    return [r.total, r.matched];
  }

  // ---- leads --------------------------------------------------------------------------------

  /** Idempotent on `(radar_id, post_id)`; fills `also_seen_in` from the post's dup cluster. */
  createLead(input: CreateLeadInput): [LeadRecord, boolean] {
    return this.db.transaction((): [LeadRecord, boolean] => {
      const existing = this.db
        .prepare("SELECT * FROM leads WHERE radar_id = ?1 AND post_id = ?2")
        .get(input.radar_id, input.post_id) as Row | undefined;
      if (existing) return [mapLeadRow(existing), false];

      const leadId = input.id ?? newUlid(input.now_ms);
      const fieldsJson = serializeFieldMap(input.fields);
      const also = input.also_seen_in ?? this.collectClusterAlsoSeen(input.post_id);
      const alsoJson = also.length === 0 ? null : JSON.stringify(also);
      const tagsJson = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

      this.db
        .prepare(
          `INSERT INTO leads (
             id, radar_id, radar_version_id, post_id, evaluation_id, contact_id,
             status, score, summary, fields, also_seen_in,
             notified_at, follow_up_at, note, tags, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6,
             ?7, ?8, ?9, ?10, ?11,
             ?12, ?13, ?14, ?15, ?16, ?16
           )`,
        )
        .run(
          leadId,
          input.radar_id,
          input.radar_version_id,
          input.post_id,
          input.evaluation_id,
          input.contact_id ?? null,
          input.status ?? "new",
          input.score,
          input.summary,
          fieldsJson,
          alsoJson,
          input.notified_at ?? null,
          input.follow_up_at ?? null,
          input.note ?? null,
          tagsJson,
          input.now_ms,
        );
      this.addEvent(leadId, "created", { score: input.score }, input.now_ms);
      return [mapLeadRow(this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row), true];
    })();
  }

  private addEvent(leadId: string, kind: string, data: unknown, nowMs: number): void {
    this.db
      .prepare("INSERT INTO lead_events (id, lead_id, kind, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(newUlid(nowMs), leadId, kind, JSON.stringify(data), nowMs);
  }

  private collectClusterAlsoSeen(postId: string): AlsoSeenInEntry[] {
    const meta = this.db.prepare("SELECT source_id, dup_cluster_id FROM posts WHERE id = ?1").get(postId) as
      | { source_id: string; dup_cluster_id: string | null }
      | undefined;
    if (!meta || meta.dup_cluster_id === null) return [];
    const rows = this.db
      .prepare(
        `SELECT p.id AS post_id, p.source_id AS source_id, s.name AS source_name, p.permalink AS permalink,
                p.captured_at AS captured_at
         FROM posts p JOIN sources s ON s.id = p.source_id
         WHERE p.dup_cluster_id = ?1 AND p.source_id != ?2
         ORDER BY p.captured_at ASC`,
      )
      .all(meta.dup_cluster_id, meta.source_id) as AlsoSeenInEntry[];
    const seen = new Set<string>();
    const entries: AlsoSeenInEntry[] = [];
    for (const e of rows) {
      if (!seen.has(e.source_id)) {
        seen.add(e.source_id);
        entries.push(e);
      }
    }
    return entries;
  }

  getLead(leadId: string): LeadRecord | null {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row | undefined;
    return row ? mapLeadRow(row) : null;
  }

  /** Lead joined with radar, source, author, post, evaluation provenance and its events. */
  leadGet(leadId: string): LeadDetail | null {
    const row = this.db
      .prepare(
        `SELECT l.*, r.name AS radar_name, p.source_id, s.name AS source_name, p.author_id,
                a.name AS author_name, p.text AS post_text, p.text_norm AS post_text_norm, p.permalink,
                p.created_at AS post_created_at, p.captured_at AS post_captured_at,
                e.id AS eval_id, rv.version AS eval_radar_version, e.decided_by AS eval_decided_by,
                e.verdict AS eval_verdict, e.score AS eval_score, e.intent AS eval_intent,
                e.author_role AS eval_author_role, e.reason AS eval_reason,
                e.ruleset_id AS eval_ruleset_id, e.ai_call_id AS eval_ai_call_id
         FROM leads l
         JOIN radars r ON r.id = l.radar_id
         JOIN radar_versions rv ON rv.id = l.radar_version_id
         JOIN posts p ON p.id = l.post_id
         JOIN sources s ON s.id = p.source_id
         LEFT JOIN authors a ON a.id = p.author_id
         JOIN evaluations e ON e.id = l.evaluation_id
         WHERE l.id = ?1`,
      )
      .get(leadId) as Row | undefined;
    if (!row) return null;
    const events = (
      this.db
        .prepare(
          `SELECT id, lead_id, kind, data, created_at FROM lead_events
           WHERE lead_id = ?1 ORDER BY created_at ASC, id ASC`,
        )
        .all(leadId) as Row[]
    ).map(
      (e): LeadEventRecord => ({
        id: e.id as string,
        lead_id: e.lead_id as string,
        kind: e.kind as string,
        data: parseJsonLenient(e.data),
        created_at: e.created_at as number,
      }),
    );
    return {
      lead: mapLeadRow(row),
      radar_name: row.radar_name as string,
      source_id: row.source_id as string,
      source_name: row.source_name as string,
      author_id: row.author_id as string | null,
      author_name: row.author_name as string | null,
      post_text: row.post_text as string | null,
      post_text_norm: row.post_text_norm as string | null,
      permalink: row.permalink as string,
      post_created_at: row.post_created_at as number | null,
      post_captured_at: row.post_captured_at as number,
      evaluation: {
        id: row.eval_id as string,
        radar_version: row.eval_radar_version as number,
        decided_by: row.eval_decided_by as string | null,
        verdict: row.eval_verdict as string | null,
        score: row.eval_score as number | null,
        intent: row.eval_intent as string | null,
        author_role: row.eval_author_role as string | null,
        reason: row.eval_reason as string | null,
        ruleset_id: row.eval_ruleset_id as string | null,
        ai_call_id: row.eval_ai_call_id as string | null,
      },
      events,
    };
  }

  setStatus(leadId: string, status: string, nowMs: number): LeadRecord {
    if (!LEAD_STATUSES.includes(status)) throw StoreError.invalidArgument(`invalid lead status '${status}'`);
    return this.db.transaction((): LeadRecord => {
      const old = this.db.prepare("SELECT status FROM leads WHERE id = ?1").get(leadId) as
        | { status: string }
        | undefined;
      if (!old) throw StoreError.notFound("lead", leadId);
      this.db.prepare("UPDATE leads SET status = ?1, updated_at = ?2 WHERE id = ?3").run(status, nowMs, leadId);
      this.addEvent(leadId, "status_changed", { from: old.status, to: status }, nowMs);
      return mapLeadRow(this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row);
    })();
  }

  /** Edit one extracted field as `source = "user"` after validating against the version's fields. */
  updateField(leadId: string, fieldKey: string, newValue: unknown, raw: string | null, nowMs: number): LeadRecord {
    if (!isValidFieldKey(fieldKey)) throw StoreError.invalidFieldKey(fieldKey);
    return this.db.transaction((): LeadRecord => {
      const leadRow = this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row | undefined;
      if (!leadRow) throw StoreError.notFound("lead", leadId);
      const lead = mapLeadRow(leadRow);
      const defsRaw = (
        this.db.prepare("SELECT fields FROM radar_versions WHERE id = ?1").get(lead.radar_version_id) as {
          fields: string;
        }
      ).fields;
      const defs: FieldDef[] = normalizeFieldDefs(JSON.parse(defsRaw));
      const definition = defs.find((f) => f.key === fieldKey);
      if (!definition) throw StoreError.unknownRadarField(lead.radar_id, fieldKey);
      validateFieldValue(definition, newValue);

      const fields = { ...lead.fields };
      const old = fields[fieldKey];
      fields[fieldKey] = {
        value: newValue,
        raw: raw ?? old?.raw ?? null,
        confidence: 1.0,
        source: "user",
      };
      this.db
        .prepare("UPDATE leads SET fields = ?1, updated_at = ?2 WHERE id = ?3")
        .run(serializeFieldMap(fields), nowMs, leadId);
      this.addEvent(leadId, "field_edited", { field: fieldKey, old: old ? old.value : null, new: newValue }, nowMs);
      return mapLeadRow(this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row);
    })();
  }

  setNoteTagsFollowUp(
    leadId: string,
    note: string | null,
    tags: string[] | null,
    followUpAt: number | null,
    nowMs: number,
  ): LeadRecord {
    return this.db.transaction((): LeadRecord => {
      const exists = this.db.prepare("SELECT EXISTS(SELECT 1 FROM leads WHERE id = ?1) AS e").get(leadId) as {
        e: number;
      };
      if (!exists.e) throw StoreError.notFound("lead", leadId);
      const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;
      this.db
        .prepare("UPDATE leads SET note = ?1, tags = ?2, follow_up_at = ?3, updated_at = ?4 WHERE id = ?5")
        .run(note, tagsJson, followUpAt, nowMs, leadId);
      this.addEvent(leadId, "noted", { note, tags, follow_up_at: followUpAt }, nowMs);
      return mapLeadRow(this.db.prepare("SELECT * FROM leads WHERE id = ?1").get(leadId) as Row);
    })();
  }

  /** Read state is independent of CRM stage. */
  markRead(id: string, now: number): void {
    this.db.prepare("UPDATE leads SET read_at=COALESCE(read_at,?1) WHERE id=?2").run(now, id);
  }

  /** Claim due local reminders once per scheduled time; overdue reminders survive restarts. */
  claimDueFollowUps(now: number): string[] {
    return this.db.transaction((): string[] => {
      const due = this.db
        .prepare(
          `SELECT id, follow_up_at FROM leads l
           WHERE follow_up_at<=?1 AND status NOT IN ('won','lost','ignored')
             AND NOT EXISTS(SELECT 1 FROM follow_up_deliveries d WHERE d.lead_id=l.id AND d.due_at=l.follow_up_at)
           ORDER BY follow_up_at LIMIT 50`,
        )
        .all(now) as Array<{ id: string; follow_up_at: number }>;
      for (const { id, follow_up_at } of due) {
        this.db
          .prepare(
            `INSERT INTO follow_up_deliveries(lead_id,due_at,delivered_at) VALUES (?1,?2,?3)
             ON CONFLICT(lead_id) DO UPDATE SET due_at=excluded.due_at,delivered_at=excluded.delivered_at`,
          )
          .run(id, follow_up_at, now);
        this.addEvent(id, "follow_up_due", { due_at: follow_up_at }, now);
      }
      return due.map((d) => d.id);
    })();
  }

  setContactId(leadId: string, contactId: string | null, nowMs: number): boolean {
    return (
      this.db
        .prepare("UPDATE leads SET contact_id = ?1, updated_at = ?2 WHERE id = ?3")
        .run(contactId, nowMs, leadId).changes > 0
    );
  }

  /** Leads created for a radar in the last 60 minutes (flood guard). */
  countLeadsInLastHour(radarId: string, nowMs: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM leads WHERE radar_id = ?1 AND created_at >= ?2")
        .get(radarId, nowMs - 3_600_000) as { c: number }
    ).c;
  }

  // ---- feedback -----------------------------------------------------------------------------

  recordFeedback(input: RecordFeedbackInput): FeedbackRecord {
    if (!FEEDBACK_LABELS.includes(input.label)) {
      throw StoreError.invalidArgument(`invalid feedback label '${input.label}'`);
    }
    if (!["app", "telegram", "preview"].includes(input.origin)) {
      throw StoreError.invalidArgument(`invalid feedback origin '${input.origin}'`);
    }
    return this.db.transaction((): FeedbackRecord => {
      const ev = this.db
        .prepare(
          `SELECT e.radar_version_id AS radar_version_id, e.post_id AS post_id,
                  COALESCE(p.text, e.summary, '') AS fallback_text, e.verdict AS verdict
           FROM evaluations e JOIN posts p ON p.id = e.post_id WHERE e.id = ?1`,
        )
        .get(input.evaluation_id) as
        | { radar_version_id: string; post_id: string; fallback_text: string; verdict: string | null }
        | undefined;
      if (!ev) throw StoreError.notFound("evaluation", input.evaluation_id);

      const expectedMatch =
        input.label === "correct" ? ev.verdict === "match" : input.label === "missed" || input.label === "wrong_fields";
      const id = newUlid(input.now_ms);
      const postText = input.post_text ?? ev.fallback_text;
      this.db
        .prepare(
          `INSERT INTO feedback (
             id, evaluation_id, radar_version_id, post_id, label,
             corrected_fields, post_text, origin, created_at, expected_match
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .run(
          id,
          input.evaluation_id,
          ev.radar_version_id,
          ev.post_id,
          input.label,
          input.corrected_fields ? serializeFieldMap(input.corrected_fields) : null,
          postText,
          input.origin,
          input.now_ms,
          expectedMatch ? 1 : 0,
        );

      // Hide the lead immediately on a negative rejection label.
      if (NEGATIVE_LABELS.includes(input.label)) {
        this.db
          .prepare(
            `UPDATE leads SET status = 'ignored', updated_at = ?1
             WHERE evaluation_id = ?2 AND status IN ('new', 'viewed')`,
          )
          .run(input.now_ms, input.evaluation_id);
      }
      return mapFeedbackRow(this.db.prepare("SELECT * FROM feedback WHERE id = ?1").get(id) as Row);
    })();
  }

  /** Up to `max` recent balanced feedback examples (positives first, then negatives). */
  getPromptFeedbackExamples(radarVersionId: string, max: number): FeedbackRecord[] {
    if (max === 0) return [];
    const posLimit = Math.max(Math.floor(max / 2), 1);
    const negLimit = Math.max(max - Math.floor(max / 2), 1);
    const query = (expected: number, limit: number): FeedbackRecord[] =>
      (
        this.db
          .prepare(
            `SELECT * FROM feedback WHERE radar_version_id = ?1 AND expected_match = ${expected}
             ORDER BY created_at DESC LIMIT ?2`,
          )
          .all(radarVersionId, limit) as Row[]
      ).map(mapFeedbackRow);
    return [...query(1, posLimit), ...query(0, negLimit)].slice(0, max);
  }

  /** Labeled dataset: explicit feedback first (dedup by post), then confident AI evaluations. */
  getLabeledDataset(radarVersionId: string): LabeledSample[] {
    const samples: LabeledSample[] = [];
    const seen = new Set<string>();

    const feedbackRows = this.db
      .prepare(
        `SELECT f.post_id AS post_id, f.evaluation_id AS evaluation_id, f.post_text AS post_text,
                p.text_fold AS text_fold, f.label AS label, f.expected_match AS expected_match,
                f.corrected_fields AS corrected_fields, e.author_role AS author_role, e.score AS score,
                e.fields AS eval_fields
         FROM feedback f
         LEFT JOIN posts p ON p.id = f.post_id
         LEFT JOIN evaluations e ON e.id = f.evaluation_id
         WHERE f.radar_version_id = ?1
         ORDER BY f.created_at DESC`,
      )
      .all(radarVersionId) as Row[];
    for (const r of feedbackRows) {
      if (seen.has(r.post_id as string)) continue;
      seen.add(r.post_id as string);
      const label = r.label as string;
      samples.push({
        post_id: r.post_id as string,
        evaluation_id: r.evaluation_id as string,
        post_text: r.post_text as string,
        text_fold: r.text_fold as string | null,
        is_match: num(r.expected_match) !== 0,
        author_role: label === "peer" ? "peer" : (r.author_role as string | null),
        score: r.score as number | null,
        // `corrected_fields.or(eval_fields)` is chosen before parsing; a parse failure yields None.
        fields: parseFieldMapLenient((r.corrected_fields as string | null) ?? (r.eval_fields as string | null)),
        origin: { feedback: label },
      });
    }

    const aiRows = this.db
      .prepare(
        `SELECT e.post_id AS post_id, e.id AS evaluation_id, p.text AS post_text, p.text_fold AS text_fold,
                e.verdict AS verdict, e.author_role AS author_role, e.score AS score, e.fields AS fields
         FROM evaluations e JOIN posts p ON p.id = e.post_id
         WHERE e.radar_version_id = ?1 AND e.is_preview = 0 AND e.state = 'done' AND e.decided_by = 'ai'
           AND p.text IS NOT NULL AND (e.score >= 0.85 OR e.score <= 0.15)
         ORDER BY e.created_at DESC LIMIT 300`,
      )
      .all(radarVersionId) as Row[];
    for (const r of aiRows) {
      if (seen.has(r.post_id as string)) continue;
      seen.add(r.post_id as string);
      samples.push({
        post_id: r.post_id as string,
        evaluation_id: r.evaluation_id as string,
        post_text: r.post_text as string,
        text_fold: r.text_fold as string | null,
        is_match: r.verdict === "match",
        author_role: r.author_role as string | null,
        score: r.score as number | null,
        fields: parseFieldMapLenient(r.fields),
        origin: "ai_high_confidence",
      });
    }
    return samples;
  }

  // ---- list ---------------------------------------------------------------------------------

  /** Allowed dynamic field definitions (whitelist + type awareness) for filter/sort validation. */
  private loadAllowedFieldMap(radarId: string | null): Map<string, FieldDef> {
    const map = new Map<string, FieldDef>();
    let rows: Array<{ fields: string }>;
    if (radarId !== null) {
      const exists = this.db.prepare("SELECT EXISTS(SELECT 1 FROM radars WHERE id = ?1) AS e").get(radarId) as {
        e: number;
      };
      if (!exists.e) throw StoreError.notFound("radar", radarId);
      rows = this.db
        .prepare(
          `SELECT rv.fields AS fields FROM radar_versions rv JOIN radars r ON r.id = rv.radar_id
           WHERE rv.radar_id = ?1 AND rv.version <= r.current_version ORDER BY rv.version ASC`,
        )
        .all(radarId) as Array<{ fields: string }>;
    } else {
      rows = this.db
        .prepare(
          `SELECT rv.fields AS fields FROM radar_versions rv JOIN radars r ON r.id = rv.radar_id
           WHERE rv.version = r.current_version ORDER BY r.updated_at ASC`,
        )
        .all() as Array<{ fields: string }>;
    }
    for (const r of rows) {
      for (const f of normalizeFieldDefs(JSON.parse(r.fields))) {
        if (isValidFieldKey(f.key)) map.set(f.key, f);
      }
    }
    return map;
  }

  /** Dynamic CRM lead query: whitelist-validated filters/sort, FTS, offset-cursor pagination. */
  list(query: LeadListQuery): LeadListPage {
    const radarId = query.radar_id ?? null;
    const filters = query.filters ?? [];
    const allowed = this.loadAllowedFieldMap(radarId);

    for (const filter of filters) {
      if (!isValidFieldKey(filter.field)) throw StoreError.invalidFieldKey(filter.field);
      if (!allowed.has(filter.field)) throw StoreError.unknownRadarField(radarId, filter.field);
    }

    const sort: { by: string; dir: "asc" | "desc" } = {
      by: query.sort?.by ?? "created_at",
      dir: query.sort?.dir ?? "desc",
    };
    let dynamicSortField: FieldDef | null = null;
    if (!["created_at", "updated_at", "score", "follow_up_at"].includes(sort.by)) {
      if (!isValidFieldKey(sort.by)) throw StoreError.invalidFieldKey(sort.by);
      const fdef = allowed.get(sort.by);
      if (!fdef) throw StoreError.unknownRadarField(radarId, sort.by);
      dynamicSortField = fdef;
    }

    const params = new SqlParams();
    const where: string[] = [];

    if (radarId !== null) where.push(`l.radar_id = ${params.push(radarId)}`);
    if (query.unread_only === true) where.push("l.read_at IS NULL");
    if (query.follow_up_after != null) {
      where.push(`l.follow_up_at >= ${params.push(query.follow_up_after)} AND l.status NOT IN ('won','lost','ignored')`);
    }
    if (query.follow_up_before != null) {
      where.push(`l.follow_up_at <= ${params.push(query.follow_up_before)} AND l.status NOT IN ('won','lost','ignored')`);
    }
    if (query.exclude_weak === true) {
      where.push("l.score >= COALESCE(json_extract(r.notify, '$.min_score'), 0.6)");
    }
    if (query.status && query.status.length > 0) {
      where.push(`l.status IN (${query.status.map((s) => params.push(s)).join(", ")})`);
    }
    if (query.expiry) {
      const p = params.push(query.expiry.now_ms);
      const hasTtl = "json_extract(r.notify, '$.lead_ttl_hours') IS NOT NULL";
      where.push(
        query.expiry.expired
          ? `(${hasTtl} AND ${LEAD_EXPIRES_AT_SQL} <= ${p})`
          : `(NOT (${hasTtl}) OR ${LEAD_EXPIRES_AT_SQL} > ${p})`,
      );
    }
    if (query.since != null) where.push(`l.created_at >= ${params.push(query.since)}`);
    if (query.min_score != null) where.push(`l.score >= ${params.push(query.min_score)}`);

    if (query.search != null && query.search.trim() !== "") {
      const fts = buildFts5Query(query.search);
      if (fts !== null) {
        const p1 = params.push(fts);
        const p2 = params.push(fts);
        where.push(
          `(l.rowid IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH ${p1}) ` +
            `OR p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ${p2}))`,
        );
      } else {
        where.push("0 = 1"); // non-alphanumeric-only query matches nothing
      }
    }

    for (const filter of filters) {
      where.push(buildDynamicFilterClause(allowed.get(filter.field)!, filter, params));
    }

    const offset = parseCursorOffset(query.cursor);
    const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 50)));
    const dirSql = sort.dir === "asc" ? "ASC" : "DESC";

    const filterParamCount = params.values.length;
    let orderSql: string;
    if (dynamicSortField) {
      const expr = buildDynamicSortExpr(dynamicSortField, params);
      orderSql = `CASE WHEN ${expr} IS NULL THEN 1 ELSE 0 END ASC, ${expr} ${dirSql}, l.created_at DESC, l.id DESC`;
    } else {
      const col =
        sort.by === "updated_at"
          ? "l.updated_at"
          : sort.by === "score"
            ? "l.score"
            : sort.by === "follow_up_at"
              ? "l.follow_up_at"
              : "l.created_at";
      orderSql = `${col} ${dirSql}, l.id ${dirSql}`;
    }
    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads l JOIN radars r ON r.id=l.radar_id JOIN posts p ON p.id=l.post_id
           JOIN sources s ON s.id=p.source_id LEFT JOIN authors a ON a.id=p.author_id ${whereSql}`,
        )
        .get(...params.values.slice(0, filterParamCount)) as { c: number }
    ).c;

    const pLimit = params.push(limit + 1);
    const pOffset = params.push(offset);
    const sql = `SELECT l.*, r.name AS radar_name, p.source_id, s.name AS source_name, p.author_id,
                        a.name AS author_name, p.permalink, p.created_at AS post_created_at, p.text AS post_text
                 FROM leads l
                 JOIN radars r ON r.id = l.radar_id
                 JOIN posts p ON p.id = l.post_id
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN authors a ON a.id = p.author_id
                 ${whereSql}
                 ORDER BY ${orderSql}
                 LIMIT ${pLimit} OFFSET ${pOffset}`;
    let items = (this.db.prepare(sql).all(...params.values) as Row[]).map(mapLeadListItemRow);
    let nextCursor: string | null = null;
    if (items.length > limit) {
      items = items.slice(0, limit);
      nextCursor = `off:${offset + limit}`;
    }
    return { total, items, next_cursor: nextCursor };
  }
}
