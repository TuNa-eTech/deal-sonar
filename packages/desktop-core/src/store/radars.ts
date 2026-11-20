// Port of crates/store/src/radars/* and models/radars.rs.

import type Database from "better-sqlite3";

import {
  type FieldDef,
  type MatchPolicy,
  type NotifyConfig,
  defaultMatchPolicy,
  defaultNotifyConfig,
  normalizeFieldDefs,
  normalizeMatchPolicy,
  normalizeNotifyConfig,
} from "./domain";
import { StoreError } from "./errors";
import { isValidFieldKey, newUlid } from "./util";

export interface RadarRecord {
  id: string;
  name: string;
  status: string;
  template_id: string | null;
  current_version: number;
  notify: NotifyConfig;
  created_at: number;
  updated_at: number;
}

export interface RadarVersionRecord {
  id: string;
  radar_id: string;
  version: number;
  description: string;
  language_hint: string | null;
  user_profession: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicy;
  created_at: number;
}

export interface RadarWithVersion {
  radar: RadarRecord;
  current_version: RadarVersionRecord;
  candidate_version: RadarVersionRecord | null;
  source_ids: string[];
}

export interface CreateRadarDraftInput {
  id?: string | null;
  name: string;
  template_id?: string | null;
  description: string;
  language_hint?: string | null;
  user_profession?: string | null;
  fields: FieldDef[];
  match_policy?: MatchPolicy;
  notify?: NotifyConfig;
  source_ids?: string[];
  now_ms: number;
}

export interface UpdateRadarInput {
  name?: string | null;
  notify?: NotifyConfig | null;
  source_ids?: string[] | null;
  description?: string | null;
  /** `null`/absent keeps the value (serde `Option<Option<_>>` JSON semantics). */
  language_hint?: string | null;
  user_profession?: string | null;
  fields?: FieldDef[] | null;
  match_policy?: MatchPolicy | null;
  activate_immediately?: boolean;
  now_ms: number;
}

export interface RadarUpdateResult {
  radar: RadarWithVersion;
  version_created: RadarVersionRecord | null;
  pending_confirmation: boolean;
}

export interface RadarListItem {
  radar: RadarRecord;
  current_version: RadarVersionRecord;
  source_ids: string[];
  leads_24h: number;
  evaluated_posts_total: number;
  false_positive_rate: number;
}

export interface RadarFunnelStats {
  total_evaluated: number;
  dedup_rejected: number;
  prefilter_rejected: number;
  rule_decided: number;
  rule_matched: number;
  ai_decided: number;
  ai_matched: number;
  postfilter_rejected: number;
  pending_ai: number;
  ai_failed: number;
  leads_total: number;
  leads_notified: number;
  leads_weak_match: number;
  false_positive_count: number;
  false_positive_rate: number;
  rule_handled_ratio: number;
}

export interface NewRulesetInput {
  id?: string | null;
  radar_version_id: string;
  state: string;
  origin: string;
  body: unknown;
  metrics?: unknown | null;
  now_ms: number;
}

export interface RulesetRecord {
  id: string;
  radar_version_id: string;
  revision: number;
  state: string;
  origin: string;
  body: unknown;
  metrics: unknown | null;
  created_at: number;
  activated_at: number | null;
}

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;

export function validateFieldDefs(fields: FieldDef[]): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!isValidFieldKey(f.key)) throw StoreError.invalidFieldKey(f.key);
    if (seen.has(f.key)) throw StoreError.invalidArgument(`duplicate field key '${f.key}'`);
    seen.add(f.key);
  }
}

export function mapRadarRow(row: Row): RadarRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as string,
    template_id: row.template_id as string | null,
    current_version: row.current_version as number,
    notify: normalizeNotifyConfig(JSON.parse(row.notify as string)),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function mapRadarVersionRow(row: Row): RadarVersionRecord {
  return {
    id: row.id as string,
    radar_id: row.radar_id as string,
    version: row.version as number,
    description: row.description as string,
    language_hint: row.language_hint as string | null,
    user_profession: row.user_profession as string | null,
    fields: normalizeFieldDefs(JSON.parse(row.fields as string)),
    match_policy: normalizeMatchPolicy(JSON.parse(row.match_policy as string)),
    created_at: row.created_at as number,
  };
}

function mapRulesetRow(row: Row): RulesetRecord {
  return {
    id: row.id as string,
    radar_version_id: row.radar_version_id as string,
    revision: row.revision as number,
    state: row.state as string,
    origin: row.origin as string,
    body: JSON.parse(row.body as string),
    metrics: row.metrics === null ? null : JSON.parse(row.metrics as string),
    created_at: row.created_at as number,
    activated_at: row.activated_at as number | null,
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Radars {
  constructor(private readonly db: Database.Database) {}

  /** Radar with its current version, newest candidate version (> current) and source ids. */
  private loadWithVersion(radarId: string): RadarWithVersion | null {
    const radarRow = this.db.prepare("SELECT * FROM radars WHERE id = ?1").get(radarId) as Row | undefined;
    if (!radarRow) return null;
    const radar = mapRadarRow(radarRow);
    const currentRow = this.db
      .prepare("SELECT * FROM radar_versions WHERE radar_id = ?1 AND version = ?2")
      .get(radarId, radar.current_version) as Row | undefined;
    if (!currentRow) throw new StoreError("sqlite", "SQLite error: Query returned no rows");
    const candidateRow = this.db
      .prepare(
        `SELECT * FROM radar_versions WHERE radar_id = ?1 AND version > ?2 ORDER BY version DESC LIMIT 1`,
      )
      .get(radarId, radar.current_version) as Row | undefined;
    const sourceIds = (
      this.db
        .prepare("SELECT source_id FROM radar_sources WHERE radar_id = ?1 ORDER BY source_id ASC")
        .all(radarId) as Array<{ source_id: string }>
    ).map((r) => r.source_id);
    return {
      radar,
      current_version: mapRadarVersionRow(currentRow),
      candidate_version: candidateRow ? mapRadarVersionRow(candidateRow) : null,
      source_ids: sourceIds,
    };
  }

  private requireWithVersion(radarId: string): RadarWithVersion {
    const loaded = this.loadWithVersion(radarId);
    if (!loaded) throw StoreError.notFound("radar", radarId);
    return loaded;
  }

  versions(radarId: string): RadarVersionRecord[] {
    return (
      this.db.prepare("SELECT * FROM radar_versions WHERE radar_id=?1 ORDER BY version DESC").all(radarId) as Row[]
    ).map(mapRadarVersionRow);
  }

  /** New radar in `draft` state with its `version = 1` row and `radar_sources`. */
  createDraft(input: CreateRadarDraftInput): RadarWithVersion {
    const fields = normalizeFieldDefs(input.fields);
    validateFieldDefs(fields);
    const policy = input.match_policy ? normalizeMatchPolicy(input.match_policy) : defaultMatchPolicy();
    const notify = input.notify ? normalizeNotifyConfig(input.notify) : defaultNotifyConfig();

    const radarId = input.id ?? newUlid(input.now_ms);
    const versionId = newUlid(input.now_ms);
    return this.db.transaction((): RadarWithVersion => {
      this.db
        .prepare(
          `INSERT INTO radars (id, name, status, template_id, current_version, notify, created_at, updated_at)
           VALUES (?1, ?2, 'draft', ?3, 1, ?4, ?5, ?5)`,
        )
        .run(radarId, input.name, input.template_id ?? null, JSON.stringify(notify), input.now_ms);
      this.db
        .prepare(
          `INSERT INTO radar_versions (
             id, radar_id, version, description, language_hint, user_profession,
             fields, match_policy, created_at
           ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .run(
          versionId,
          radarId,
          input.description,
          input.language_hint ?? null,
          input.user_profession ?? null,
          JSON.stringify(fields),
          JSON.stringify(policy),
          input.now_ms,
        );
      for (const sid of input.source_ids ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO radar_sources (radar_id, source_id) VALUES (?1, ?2)").run(radarId, sid);
      }
      return this.requireWithVersion(radarId);
    })();
  }

  /**
   * Metadata edits (name, notify, sources) apply in place. Definition edits (description, fields,
   * match policy, profession, language) create a new immutable version; on an `active` radar the
   * new version stays a candidate until confirmed unless `activate_immediately`.
   */
  update(radarId: string, input: UpdateRadarInput): RadarUpdateResult {
    const inputFields = input.fields ? normalizeFieldDefs(input.fields) : null;
    if (inputFields) validateFieldDefs(inputFields);

    return this.db.transaction((): RadarUpdateResult => {
      const existing = this.requireWithVersion(radarId);
      const nextName = input.name ?? existing.radar.name;
      const nextNotify = input.notify ? normalizeNotifyConfig(input.notify) : existing.radar.notify;
      this.db
        .prepare("UPDATE radars SET name = ?1, notify = ?2, updated_at = ?3 WHERE id = ?4")
        .run(nextName, JSON.stringify(nextNotify), input.now_ms, radarId);

      if (input.source_ids) {
        this.db.prepare("DELETE FROM radar_sources WHERE radar_id = ?1").run(radarId);
        for (const sid of input.source_ids) {
          this.db
            .prepare("INSERT OR IGNORE INTO radar_sources (radar_id, source_id) VALUES (?1, ?2)")
            .run(radarId, sid);
        }
      }

      const cur = existing.current_version;
      const nextDesc = input.description ?? cur.description;
      // serde `Option<Option<String>>`: JSON `null` deserializes to the outer `None` (keep).
      const nextLang = input.language_hint ?? cur.language_hint;
      const nextProf = input.user_profession ?? cur.user_profession;
      const nextFields = inputFields ?? cur.fields;
      const nextPolicy = input.match_policy ? normalizeMatchPolicy(input.match_policy) : cur.match_policy;

      const definitionChanged =
        nextDesc !== cur.description ||
        !sameJson(nextFields, cur.fields) ||
        !sameJson(nextPolicy, cur.match_policy) ||
        nextProf !== cur.user_profession ||
        nextLang !== cur.language_hint;

      let versionCreated: RadarVersionRecord | null = null;
      let pendingConfirmation = false;
      if (definitionChanged) {
        const maxVer = (
          this.db
            .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM radar_versions WHERE radar_id = ?1")
            .get(radarId) as { v: number }
        ).v;
        const newVerNum = maxVer + 1;
        const newVerId = newUlid(input.now_ms);
        this.db
          .prepare(
            `INSERT INTO radar_versions (
               id, radar_id, version, description, language_hint, user_profession,
               fields, match_policy, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .run(
            newVerId,
            radarId,
            newVerNum,
            nextDesc,
            nextLang,
            nextProf,
            JSON.stringify(nextFields),
            JSON.stringify(nextPolicy),
            input.now_ms,
          );
        versionCreated = mapRadarVersionRow(
          this.db.prepare("SELECT * FROM radar_versions WHERE id = ?1").get(newVerId) as Row,
        );
        if (existing.radar.status === "active" && !input.activate_immediately) {
          pendingConfirmation = true;
        } else {
          this.activateVersion(radarId, newVerNum, input.now_ms);
        }
      }

      return {
        radar: this.requireWithVersion(radarId),
        version_created: versionCreated,
        pending_confirmation: pendingConfirmation,
      };
    })();
  }

  /** Persist an immutable preview definition without touching live metadata, sources or version. */
  previewSnapshot(definition: RadarVersionRecord): RadarVersionRecord {
    const fields = normalizeFieldDefs(definition.fields);
    validateFieldDefs(fields);
    const policy = normalizeMatchPolicy(definition.match_policy);
    return this.db.transaction((): RadarVersionRecord => {
      const existing = this.requireWithVersion(definition.radar_id);
      const candidates = [existing.current_version, ...(existing.candidate_version ? [existing.candidate_version] : [])];
      for (const v of candidates) {
        if (
          v.description === definition.description &&
          sameJson(v.fields, fields) &&
          sameJson(v.match_policy, policy) &&
          v.user_profession === (definition.user_profession ?? null)
        ) {
          return v;
        }
      }
      const snapshot: RadarVersionRecord = {
        ...definition,
        fields,
        match_policy: policy,
        language_hint: definition.language_hint ?? null,
        user_profession: definition.user_profession ?? null,
        id: newUlid(definition.created_at),
        version: (
          this.db.prepare("SELECT MAX(version)+1 AS v FROM radar_versions WHERE radar_id=?1").get(definition.radar_id) as {
            v: number;
          }
        ).v,
      };
      this.db
        .prepare(
          `INSERT INTO radar_versions(id,radar_id,version,description,language_hint,user_profession,fields,match_policy,created_at)
           VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        )
        .run(
          snapshot.id,
          snapshot.radar_id,
          snapshot.version,
          snapshot.description,
          snapshot.language_hint,
          snapshot.user_profession,
          JSON.stringify(snapshot.fields),
          JSON.stringify(snapshot.match_policy),
          snapshot.created_at,
        );
      return snapshot;
    })();
  }

  /** Confirm a candidate version, retiring rulesets of older versions and clearing previews. */
  confirmVersion(radarId: string, version: number, nowMs: number): RadarWithVersion {
    return this.db.transaction((): RadarWithVersion => {
      const exists = this.db
        .prepare("SELECT EXISTS(SELECT 1 FROM radar_versions WHERE radar_id = ?1 AND version = ?2) AS e")
        .get(radarId, version) as { e: number };
      if (!exists.e) throw StoreError.notFound("radar_version", `${radarId}@v${version}`);
      this.activateVersion(radarId, version, nowMs);
      return this.requireWithVersion(radarId);
    })();
  }

  private activateVersion(radarId: string, version: number, nowMs: number): void {
    this.db.prepare("UPDATE radars SET current_version = ?1, updated_at = ?2 WHERE id = ?3").run(version, nowMs, radarId);
    // Retire active/shadow rulesets belonging to superseded versions of this radar.
    this.db
      .prepare(
        `UPDATE rulesets SET state = 'retired'
         WHERE state IN ('active', 'shadow')
           AND radar_version_id IN (SELECT id FROM radar_versions WHERE radar_id = ?1 AND version != ?2)`,
      )
      .run(radarId, version);
    // Remove preview evaluations once a version is confirmed/active.
    this.db
      .prepare(
        `DELETE FROM evaluations WHERE is_preview = 1
           AND radar_version_id IN (SELECT id FROM radar_versions WHERE radar_id = ?1)`,
      )
      .run(radarId);
  }

  /** Lifecycle status (`draft | active | paused | archived`); activating clears previews. */
  setStatus(radarId: string, status: string, nowMs: number): RadarRecord {
    if (!["draft", "active", "paused", "archived"].includes(status)) {
      throw StoreError.invalidArgument(`invalid radar status '${status}'`);
    }
    return this.db.transaction((): RadarRecord => {
      const changed = this.db
        .prepare("UPDATE radars SET status = ?1, updated_at = ?2 WHERE id = ?3")
        .run(status, nowMs, radarId).changes;
      if (changed === 0) throw StoreError.notFound("radar", radarId);
      if (status === "active") {
        this.db
          .prepare(
            `DELETE FROM evaluations WHERE is_preview = 1
               AND radar_version_id IN (SELECT id FROM radar_versions WHERE radar_id = ?1)`,
          )
          .run(radarId);
      }
      return mapRadarRow(this.db.prepare("SELECT * FROM radars WHERE id = ?1").get(radarId) as Row);
    })();
  }

  get(radarId: string): RadarWithVersion | null {
    return this.loadWithVersion(radarId);
  }

  getVersion(radarVersionId: string): RadarVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM radar_versions WHERE id = ?1").get(radarVersionId) as Row | undefined;
    return row ? mapRadarVersionRow(row) : null;
  }

  /** Radars with 24h lead count, evaluated posts and 7d false-positive rate. */
  list(includeArchived: boolean, nowMs: number): RadarListItem[] {
    const since24h = nowMs - DAY_MS;
    const since7d = nowMs - 7 * DAY_MS;
    const ids = (
      includeArchived
        ? this.db.prepare("SELECT id FROM radars ORDER BY updated_at DESC, created_at DESC").all()
        : this.db
            .prepare("SELECT id FROM radars WHERE status != 'archived' ORDER BY updated_at DESC, created_at DESC")
            .all()
    ) as Array<{ id: string }>;

    const items: RadarListItem[] = [];
    for (const { id } of ids) {
      const rw = this.loadWithVersion(id);
      if (!rw) continue;
      const leads24h = (
        this.db.prepare("SELECT COUNT(*) AS c FROM leads WHERE radar_id = ?1 AND created_at >= ?2").get(id, since24h) as {
          c: number;
        }
      ).c;
      const evaluated = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM evaluations e JOIN radar_versions rv ON rv.id = e.radar_version_id
             WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.state = 'done'`,
          )
          .get(id) as { c: number }
      ).c;
      const l7 = this.db
        .prepare(
          `SELECT COUNT(*) AS leads, COALESCE(SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS notified
           FROM leads WHERE radar_id = ?1 AND created_at >= ?2`,
        )
        .get(id, since7d) as { leads: number; notified: number };
      const fp = (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT f.evaluation_id) AS c
             FROM feedback f JOIN radar_versions rv ON rv.id = f.radar_version_id
             WHERE rv.radar_id = ?1 AND f.created_at >= ?2 AND f.origin != 'preview'
               AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')`,
          )
          .get(id, since7d) as { c: number }
      ).c;
      const denom = l7.notified > 0 ? l7.notified : l7.leads;
      items.push({
        radar: rw.radar,
        current_version: rw.current_version,
        source_ids: rw.source_ids,
        leads_24h: leads24h,
        evaluated_posts_total: evaluated,
        false_positive_rate: denom > 0 ? Math.min(1, Math.max(0, fp / denom)) : 0,
      });
    }
    return items;
  }

  listActiveForSource(sourceId: string): RadarWithVersion[] {
    const ids = this.db
      .prepare(
        `SELECT r.id AS id FROM radars r JOIN radar_sources rs ON rs.radar_id = r.id
         WHERE rs.source_id = ?1 AND r.status = 'active' ORDER BY r.created_at ASC`,
      )
      .all(sourceId) as Array<{ id: string }>;
    const out: RadarWithVersion[] = [];
    for (const { id } of ids) {
      const rw = this.loadWithVersion(id);
      if (rw) out.push(rw);
    }
    return out;
  }

  countActive(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM radars WHERE status = 'active'").get() as { c: number }).c;
  }

  // ---- rulesets -----------------------------------------------------------------------------

  /** Insert a ruleset revision; `active`/`shadow` retire the previous ruleset in that state. */
  insertRuleset(input: NewRulesetInput): RulesetRecord {
    if (!["candidate", "shadow", "active", "retired"].includes(input.state)) {
      throw StoreError.invalidArgument(`invalid ruleset state '${input.state}'`);
    }
    if (!["seed", "compiled", "user"].includes(input.origin)) {
      throw StoreError.invalidArgument(`invalid ruleset origin '${input.origin}'`);
    }
    const id = input.id ?? newUlid(input.now_ms);
    const bodyJson = JSON.stringify(input.body);
    const metricsJson = input.metrics == null ? null : JSON.stringify(input.metrics);
    return this.db.transaction((): RulesetRecord => {
      const nextRev = (
        this.db
          .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS r FROM rulesets WHERE radar_version_id = ?1")
          .get(input.radar_version_id) as { r: number }
      ).r;
      if (input.state === "active") {
        this.db
          .prepare("UPDATE rulesets SET state = 'retired' WHERE radar_version_id = ?1 AND state = 'active'")
          .run(input.radar_version_id);
      } else if (input.state === "shadow") {
        this.db
          .prepare("UPDATE rulesets SET state = 'retired' WHERE radar_version_id = ?1 AND state = 'shadow'")
          .run(input.radar_version_id);
      }
      this.db
        .prepare(
          `INSERT INTO rulesets (id, radar_version_id, revision, state, origin, body, metrics, created_at, activated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          id,
          input.radar_version_id,
          nextRev,
          input.state,
          input.origin,
          bodyJson,
          metricsJson,
          input.now_ms,
          input.state === "active" ? input.now_ms : null,
        );
      return mapRulesetRow(this.db.prepare("SELECT * FROM rulesets WHERE id = ?1").get(id) as Row);
    })();
  }

  updateRulesetState(rulesetId: string, state: string, metrics: unknown | null, nowMs: number): RulesetRecord {
    if (!["candidate", "shadow", "active", "retired"].includes(state)) {
      throw StoreError.invalidArgument(`invalid ruleset state '${state}'`);
    }
    const metricsJson = metrics == null ? null : JSON.stringify(metrics);
    return this.db.transaction((): RulesetRecord => {
      const row = this.db.prepare("SELECT radar_version_id FROM rulesets WHERE id = ?1").get(rulesetId) as
        | { radar_version_id: string }
        | undefined;
      if (!row) throw StoreError.notFound("ruleset", rulesetId);
      if (state === "active") {
        this.db
          .prepare(
            "UPDATE rulesets SET state = 'retired' WHERE radar_version_id = ?1 AND state = 'active' AND id != ?2",
          )
          .run(row.radar_version_id, rulesetId);
        this.db
          .prepare(
            `UPDATE rulesets SET state = 'active', metrics = COALESCE(?1, metrics),
               activated_at = COALESCE(activated_at, ?2) WHERE id = ?3`,
          )
          .run(metricsJson, nowMs, rulesetId);
      } else {
        if (state === "shadow") {
          this.db
            .prepare(
              "UPDATE rulesets SET state = 'retired' WHERE radar_version_id = ?1 AND state = 'shadow' AND id != ?2",
            )
            .run(row.radar_version_id, rulesetId);
        }
        this.db
          .prepare("UPDATE rulesets SET state = ?1, metrics = COALESCE(?2, metrics) WHERE id = ?3")
          .run(state, metricsJson, rulesetId);
      }
      return mapRulesetRow(this.db.prepare("SELECT * FROM rulesets WHERE id = ?1").get(rulesetId) as Row);
    })();
  }

  getActiveRuleset(radarVersionId: string): RulesetRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM rulesets WHERE radar_version_id = ?1 AND state = 'active' ORDER BY revision DESC LIMIT 1",
      )
      .get(radarVersionId) as Row | undefined;
    return row ? mapRulesetRow(row) : null;
  }

  getShadowRuleset(radarVersionId: string): RulesetRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM rulesets WHERE radar_version_id = ?1 AND state = 'shadow' ORDER BY revision DESC LIMIT 1",
      )
      .get(radarVersionId) as Row | undefined;
    return row ? mapRulesetRow(row) : null;
  }

  listRulesets(radarVersionId: string): RulesetRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM rulesets WHERE radar_version_id = ?1 ORDER BY revision DESC")
        .all(radarVersionId) as Row[]
    ).map(mapRulesetRow);
  }

  // ---- stats --------------------------------------------------------------------------------

  /** 7-day pipeline funnel statistics; `null` radar id gives the global Health funnel. */
  stats(radarId: string | null, nowMs: number): RadarFunnelStats {
    const since7d = nowMs - 7 * DAY_MS;
    const evalCols = `
      COUNT(*) AS total_evaluated,
      COALESCE(SUM(CASE WHEN e.decided_by = 'dedup' OR e.reject_reason = 'duplicate' THEN 1 ELSE 0 END), 0) AS dedup_rejected,
      COALESCE(SUM(CASE WHEN e.decided_by = 'prefilter' THEN 1 ELSE 0 END), 0) AS prefilter_rejected,
      COALESCE(SUM(CASE WHEN e.decided_by = 'rule' THEN 1 ELSE 0 END), 0) AS rule_decided,
      COALESCE(SUM(CASE WHEN e.decided_by = 'rule' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0) AS rule_matched,
      COALESCE(SUM(CASE WHEN e.decided_by = 'ai' THEN 1 ELSE 0 END), 0) AS ai_decided,
      COALESCE(SUM(CASE WHEN e.decided_by = 'ai' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0) AS ai_matched,
      COALESCE(SUM(CASE WHEN e.decided_by = 'postfilter' THEN 1 ELSE 0 END), 0) AS postfilter_rejected,
      COALESCE(SUM(CASE WHEN e.state = 'pending_ai' THEN 1 ELSE 0 END), 0) AS pending_ai,
      COALESCE(SUM(CASE WHEN e.state = 'ai_failed' THEN 1 ELSE 0 END), 0) AS ai_failed`;
    type EvalAgg = Omit<
      RadarFunnelStats,
      "leads_total" | "leads_notified" | "leads_weak_match" | "false_positive_count" | "false_positive_rate" | "rule_handled_ratio"
    >;
    const e =
      radarId !== null
        ? (this.db
            .prepare(
              `SELECT ${evalCols} FROM evaluations e JOIN radar_versions rv ON rv.id = e.radar_version_id
               WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.created_at >= ?2`,
            )
            .get(radarId, since7d) as EvalAgg)
        : (this.db
            .prepare(`SELECT ${evalCols} FROM evaluations e WHERE e.is_preview = 0 AND e.created_at >= ?1`)
            .get(since7d) as EvalAgg);

    const leadCols = `
      COUNT(*) AS leads_total,
      COALESCE(SUM(CASE WHEN l.notified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS leads_notified,
      COALESCE(SUM(CASE
        WHEN l.score < COALESCE(CAST(json_extract(r.notify, '$.min_score') AS REAL), 0.6)
        THEN 1 ELSE 0
      END), 0) AS leads_weak_match`;
    const l =
      radarId !== null
        ? (this.db
            .prepare(
              `SELECT ${leadCols} FROM leads l JOIN radars r ON r.id = l.radar_id
               WHERE l.radar_id = ?1 AND l.created_at >= ?2`,
            )
            .get(radarId, since7d) as { leads_total: number; leads_notified: number; leads_weak_match: number })
        : (this.db
            .prepare(
              `SELECT ${leadCols} FROM leads l JOIN radars r ON r.id = l.radar_id WHERE l.created_at >= ?1`,
            )
            .get(since7d) as { leads_total: number; leads_notified: number; leads_weak_match: number });

    const fpCount = (
      radarId !== null
        ? this.db
            .prepare(
              `SELECT COUNT(DISTINCT f.evaluation_id) AS c
               FROM feedback f JOIN radar_versions rv ON rv.id = f.radar_version_id
               WHERE rv.radar_id = ?1 AND f.created_at >= ?2 AND f.origin != 'preview'
                 AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')`,
            )
            .get(radarId, since7d)
        : this.db
            .prepare(
              `SELECT COUNT(DISTINCT f.evaluation_id) AS c FROM feedback f
               WHERE f.created_at >= ?1 AND f.origin != 'preview'
                 AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')`,
            )
            .get(since7d)
    ) as { c: number };

    const fpDenom = l.leads_notified > 0 ? l.leads_notified : l.leads_total;
    const ruleVsAi = e.prefilter_rejected + e.rule_decided + e.ai_decided;
    return {
      ...e,
      ...l,
      false_positive_count: fpCount.c,
      false_positive_rate: fpDenom > 0 ? Math.min(1, Math.max(0, fpCount.c / fpDenom)) : 0,
      rule_handled_ratio: ruleVsAi > 0 ? (e.prefilter_rejected + e.rule_decided) / ruleVsAi : 0,
    };
  }
}
