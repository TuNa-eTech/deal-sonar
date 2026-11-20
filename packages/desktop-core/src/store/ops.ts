// Port of crates/store/src/ops.rs and models/ops.rs: durable jobs, channels, outbox,
// AI call accounting and typed JSON settings. Record fields stay snake_case because they are
// serialized straight onto the IPC contract.

import type Database from "better-sqlite3";

import { normalizeNotifyConfig, DomainShapeError } from "./domain";
import { StoreError } from "./errors";
import { newUlid } from "./util";

export interface JobRecord {
  id: string;
  kind: string;
  dedup_key: string | null;
  payload: unknown;
  state: string;
  attempts: number;
  run_at: number;
  locked_at: number | null;
  error: string | null;
  created_at: number;
}

export interface ChannelRecord {
  id: string;
  kind: string;
  name: string;
  config: unknown;
  state: string;
  created_at: number;
}

export interface EnqueueOutboxInput {
  id?: string | null;
  channel_id: string;
  lead_id?: string | null;
  kind: string;
  payload: unknown;
  next_try_at: number;
  now_ms: number;
}

export interface OutboxRecord {
  id: string;
  channel_id: string;
  lead_id: string | null;
  kind: string;
  payload: unknown;
  state: string;
  attempts: number;
  next_try_at: number;
  sent_at: number | null;
  remote_id: string | null;
  error: string | null;
  created_at: number;
}

export interface RecordAiCallInput {
  id?: string | null;
  provider: string;
  model?: string | null;
  task: string;
  radar_version_id?: string | null;
  item_count: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  duration_ms: number;
  status: string;
  error?: string | null;
  now_ms: number;
}

export interface AiCallRecord {
  id: string;
  provider: string;
  model: string | null;
  task: string;
  radar_version_id: string | null;
  item_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  status: string;
  error: string | null;
  created_at: number;
}

export interface DailyAiUsage {
  day_start_ms: number;
  date: string;
  calls: number;
  items: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  evaluated_posts: number;
  ai_escalated_posts: number;
  ai_escalation_rate: number;
}

export interface AiUsageReport {
  days: DailyAiUsage[];
  total_calls: number;
  total_items: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  overall_ai_escalation_rate: number;
}

export interface PurgeReport {
  posts_purged: number;
  evaluations_scrubbed: number;
  crawl_runs_deleted: number;
  ai_calls_deleted: number;
  jobs_deleted: number;
  outbox_deleted: number;
  authors_deleted: number;
}

export interface SchemaMigrationRecord {
  version: number;
  name: string;
  applied_at: number;
}

const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

function mapJob(row: Row): JobRecord {
  return { ...(row as unknown as JobRecord), payload: JSON.parse(row.payload as string) };
}

function mapChannel(row: Row): ChannelRecord {
  return { ...(row as unknown as ChannelRecord), config: JSON.parse(row.config as string) };
}

function mapOutbox(row: Row): OutboxRecord {
  return { ...(row as unknown as OutboxRecord), payload: JSON.parse(row.payload as string) };
}

/** Default retry delay (ms) per 03-desktop.md §3.1 given the 1-based attempts already run. */
export function defaultJobRetryDelayMs(kind: string, attempts: number): number | null {
  switch (kind) {
    case "evaluate_batch":
      return ({ 1: 60_000, 2: 300_000, 3: 900_000 } as Record<number, number>)[attempts] ?? null;
    case "notify_lead":
      return (
        ({ 1: 10_000, 2: 30_000, 3: 120_000, 4: 300_000, 5: 600_000 } as Record<number, number>)[attempts] ?? null
      );
    case "suggest_fields":
      return attempts <= 1 ? 5_000 : null;
    case "compile_ruleset":
      return attempts <= 1 ? 3_600_000 : null;
    default:
      return null;
  }
}

const jsonText = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) throw new SyntaxError("value is not JSON serializable");
  return text;
};

export class Jobs {
  constructor(private readonly db: Database.Database) {}

  /** Enqueue a durable job; a live job with the same non-null dedup_key is returned instead. */
  enqueue(
    kind: string,
    dedupKey: string | null,
    payload: unknown,
    runAt: number,
    nowMs: number,
  ): [JobRecord, boolean] {
    const payloadJson = jsonText(payload);
    const id = newUlid(nowMs);
    return this.db.transaction((): [JobRecord, boolean] => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO jobs (
             id, kind, dedup_key, payload, state, attempts, run_at, locked_at, error, created_at
           ) VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, NULL, NULL, ?6)`,
        )
        .run(id, kind, dedupKey, payloadJson, runAt, nowMs).changes;
      if (inserted > 0) {
        return [mapJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?1").get(id) as Row), true];
      }
      if (dedupKey === null) {
        throw StoreError.invalidArgument("job insert ignored unexpectedly without dedup_key");
      }
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE dedup_key = ?1 AND state IN ('queued', 'running') LIMIT 1")
        .get(dedupKey) as Row | undefined;
      if (!existing) throw new StoreError("sqlite", "SQLite error: Query returned no rows");
      return [mapJob(existing), false];
    })();
  }

  /** Atomically claim the earliest due job: queued -> running, attempts+1, locked_at = now. */
  claimDue(nowMs: number): JobRecord | null {
    return this.db.transaction((): JobRecord | null => {
      const due = this.db
        .prepare(
          `SELECT id FROM jobs WHERE state = 'queued' AND run_at <= ?1
           ORDER BY run_at ASC, created_at ASC LIMIT 1`,
        )
        .get(nowMs) as { id: string } | undefined;
      if (!due) return null;
      this.db
        .prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1, locked_at = ?1 WHERE id = ?2")
        .run(nowMs, due.id);
      return mapJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?1").get(due.id) as Row);
    })();
  }

  complete(jobId: string): boolean {
    return (
      this.db
        .prepare("UPDATE jobs SET state = 'done', locked_at = NULL, error = NULL WHERE id = ?1")
        .run(jobId).changes > 0
    );
  }

  /** `retryAt` set: re-queue; `null`: terminal failure. */
  failOrRetry(jobId: string, error: string, retryAt: number | null): JobRecord {
    const changed =
      retryAt !== null
        ? this.db
            .prepare("UPDATE jobs SET state = 'queued', run_at = ?1, locked_at = NULL, error = ?2 WHERE id = ?3")
            .run(retryAt, error, jobId).changes
        : this.db
            .prepare("UPDATE jobs SET state = 'failed', locked_at = NULL, error = ?1 WHERE id = ?2")
            .run(error, jobId).changes;
    if (changed === 0) throw StoreError.notFound("job", jobId);
    return mapJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?1").get(jobId) as Row);
  }

  /** Re-queue jobs stuck in `running` with `locked_at <= staleBeforeMs` (startup recovery). */
  recoverStaleRunning(staleBeforeMs: number, nowMs: number): number {
    return this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', locked_at = NULL, run_at = ?1
         WHERE state = 'running' AND (locked_at IS NULL OR locked_at <= ?2)`,
      )
      .run(nowMs, staleBeforeMs).changes;
  }

  get(jobId: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?1").get(jobId) as Row | undefined;
    return row ? mapJob(row) : null;
  }
}

function assertChannelState(state: string): void {
  if (!["ok", "error", "paused"].includes(state)) {
    throw StoreError.invalidArgument(`invalid channel state '${state}'`);
  }
}

export class Channels {
  constructor(private readonly db: Database.Database) {}

  create(kind: string, name: string, config: unknown, nowMs: number): ChannelRecord {
    return this.upsert(newUlid(nowMs), kind, name, config, "ok", nowMs);
  }

  upsert(id: string, kind: string, name: string, config: unknown, state: string, nowMs: number): ChannelRecord {
    if (kind !== "telegram" && kind !== "webhook") {
      throw StoreError.invalidArgument(`invalid channel kind '${kind}'`);
    }
    assertChannelState(state);
    this.db
      .prepare(
        `INSERT INTO channels (id, kind, name, config, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name,
           config = excluded.config, state = excluded.state`,
      )
      .run(id, kind, name, jsonText(config), state, nowMs);
    return mapChannel(this.db.prepare("SELECT * FROM channels WHERE id = ?1").get(id) as Row);
  }

  get(channelId: string): ChannelRecord | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?1").get(channelId) as Row | undefined;
    return row ? mapChannel(row) : null;
  }

  list(): ChannelRecord[] {
    return (this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as Row[]).map(mapChannel);
  }

  setState(channelId: string, state: string): boolean {
    assertChannelState(state);
    return this.db.prepare("UPDATE channels SET state = ?1 WHERE id = ?2").run(state, channelId).changes > 0;
  }

  updateConfig(channelId: string, name: string | null, config: unknown): boolean {
    return (
      this.db
        .prepare("UPDATE channels SET name = COALESCE(?1, name), config = ?2 WHERE id = ?3")
        .run(name, jsonText(config), channelId).changes > 0
    );
  }

  /** Delete a channel, cascading its outbox and removing its id from `radars.notify`. */
  delete(channelId: string): boolean {
    return this.db.transaction((): boolean => {
      const radars = this.db.prepare("SELECT id, notify FROM radars").all() as Array<{
        id: string;
        notify: string;
      }>;
      for (const { id, notify } of radars) {
        let cfg;
        try {
          cfg = normalizeNotifyConfig(JSON.parse(notify));
        } catch (err) {
          if (err instanceof SyntaxError || err instanceof DomainShapeError) continue;
          throw err;
        }
        const before = cfg.channel_ids.length;
        cfg.channel_ids = cfg.channel_ids.filter((cid) => cid !== channelId);
        if (cfg.channel_ids.length !== before) {
          // Removing a selected channel must not broaden future delivery.
          const next =
            cfg.inherit_channels === undefined
              ? normalizeNotifyConfig({ ...cfg, inherit_channels: false })
              : cfg;
          this.db.prepare("UPDATE radars SET notify = ?1 WHERE id = ?2").run(jsonText(next), id);
        }
      }
      return this.db.prepare("DELETE FROM channels WHERE id = ?1").run(channelId).changes > 0;
    })();
  }
}

export class Outbox {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueOutboxInput): OutboxRecord {
    if (!["lead", "digest", "system"].includes(input.kind)) {
      throw StoreError.invalidArgument(`invalid outbox kind '${input.kind}'`);
    }
    const id = input.id ?? newUlid(input.now_ms);
    this.db
      .prepare(
        `INSERT INTO outbox (
           id, channel_id, lead_id, kind, payload, state, attempts,
           next_try_at, sent_at, remote_id, error, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, NULL, NULL, NULL, ?7)`,
      )
      .run(id, input.channel_id, input.lead_id ?? null, input.kind, jsonText(input.payload), input.next_try_at, input.now_ms);
    return mapOutbox(this.db.prepare("SELECT * FROM outbox WHERE id = ?1").get(id) as Row);
  }

  /** Claim the earliest due pending item on an `ok` channel with a 60s in-flight lease. */
  claimDue(nowMs: number): OutboxRecord | null {
    return this.db.transaction((): OutboxRecord | null => {
      const due = this.db
        .prepare(
          `SELECT o.id FROM outbox o JOIN channels c ON c.id = o.channel_id
           WHERE o.state = 'pending' AND o.next_try_at <= ?1 AND c.state = 'ok'
           ORDER BY o.next_try_at ASC, o.created_at ASC LIMIT 1`,
        )
        .get(nowMs) as { id: string } | undefined;
      if (!due) return null;
      this.db
        .prepare("UPDATE outbox SET attempts = attempts + 1, next_try_at = ?1 WHERE id = ?2")
        .run(nowMs + 60_000, due.id);
      return mapOutbox(this.db.prepare("SELECT * FROM outbox WHERE id = ?1").get(due.id) as Row);
    })();
  }

  /** Mark sent; stamps `leads.notified_at` and a `notified` lead event when tied to a lead. */
  markSent(outboxId: string, remoteId: string | null, sentAt: number): boolean {
    return this.db.transaction((): boolean => {
      const meta = this.db.prepare("SELECT channel_id, lead_id FROM outbox WHERE id = ?1").get(outboxId) as
        | { channel_id: string; lead_id: string | null }
        | undefined;
      if (!meta) return false;
      this.db
        .prepare("UPDATE outbox SET state = 'sent', sent_at = ?1, remote_id = ?2, error = NULL WHERE id = ?3")
        .run(sentAt, remoteId, outboxId);
      if (meta.lead_id !== null) {
        this.db
          .prepare(
            `UPDATE leads SET notified_at = COALESCE(notified_at, ?1), updated_at = MAX(updated_at, ?1)
             WHERE id = ?2`,
          )
          .run(sentAt, meta.lead_id);
        const data = jsonText({ channel_id: meta.channel_id, remote_id: remoteId });
        this.db
          .prepare("INSERT INTO lead_events (id, lead_id, kind, data, created_at) VALUES (?1, ?2, 'notified', ?3, ?4)")
          .run(newUlid(sentAt), meta.lead_id, data, sentAt);
      }
      return true;
    })();
  }

  /** Retry, drop (older than `maxAgeMs`), or fail an outbox entry. */
  retryOrDrop(
    outboxId: string,
    error: string,
    nextTryAt: number | null,
    maxAttempts: number,
    maxAgeMs: number,
    nowMs: number,
  ): OutboxRecord {
    const row = this.db.prepare("SELECT attempts, created_at FROM outbox WHERE id = ?1").get(outboxId) as
      | { attempts: number; created_at: number }
      | undefined;
    if (!row) throw StoreError.notFound("outbox", outboxId);
    if (nowMs - row.created_at > maxAgeMs) {
      this.db.prepare("UPDATE outbox SET state = 'dropped', error = ?1 WHERE id = ?2").run(error, outboxId);
    } else if (nextTryAt !== null && row.attempts < maxAttempts) {
      this.db
        .prepare("UPDATE outbox SET state = 'pending', next_try_at = ?1, error = ?2 WHERE id = ?3")
        .run(nextTryAt, error, outboxId);
    } else {
      this.db.prepare("UPDATE outbox SET state = 'failed', error = ?1 WHERE id = ?2").run(error, outboxId);
    }
    return mapOutbox(this.db.prepare("SELECT * FROM outbox WHERE id = ?1").get(outboxId) as Row);
  }
}

export class AiCalls {
  constructor(private readonly db: Database.Database) {}

  /** Record an AI CLI call (never stores prompt/response bodies). */
  record(input: RecordAiCallInput): AiCallRecord {
    const id = input.id ?? newUlid(input.now_ms);
    this.db
      .prepare(
        `INSERT INTO ai_calls (
           id, provider, model, task, radar_version_id, item_count,
           input_tokens, output_tokens, cost_usd, duration_ms, status, error, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        id,
        input.provider,
        input.model ?? null,
        input.task,
        input.radar_version_id ?? null,
        input.item_count,
        input.input_tokens ?? null,
        input.output_tokens ?? null,
        input.cost_usd ?? null,
        input.duration_ms,
        input.status,
        input.error ?? null,
        input.now_ms,
      );
    return this.db.prepare("SELECT * FROM ai_calls WHERE id = ?1").get(id) as AiCallRecord;
  }

  /** Daily AI usage aggregated over the last `days` UTC days (clamped to 1..=365). */
  usage(days: number, nowMs: number): AiUsageReport {
    const d = Math.min(365, Math.max(1, Math.trunc(days)));
    const today = Math.floor(nowMs / DAY_MS);
    const start = today - (d - 1);
    const sinceMs = start * DAY_MS;

    const map = new Map<number, DailyAiUsage>();
    for (let b = start; b <= today; b += 1) {
      map.set(b, {
        day_start_ms: b * DAY_MS,
        date: unixDayToYmd(b),
        calls: 0,
        items: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        evaluated_posts: 0,
        ai_escalated_posts: 0,
        ai_escalation_rate: 0,
      });
    }

    const calls = this.db
      .prepare(
        `SELECT (created_at / 86400000) AS day_bucket, COUNT(*) AS calls,
                COALESCE(SUM(item_count), 0) AS items,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
                COALESCE(SUM(COALESCE(cost_usd, 0.0)), 0.0) AS cost_usd
         FROM ai_calls WHERE created_at >= ?1 GROUP BY day_bucket`,
      )
      .all(sinceMs) as Array<Row & { day_bucket: number }>;
    for (const r of calls) {
      const entry = map.get(r.day_bucket);
      if (!entry) continue;
      entry.calls = r.calls as number;
      entry.items = r.items as number;
      entry.input_tokens = r.input_tokens as number;
      entry.output_tokens = r.output_tokens as number;
      entry.cost_usd = r.cost_usd as number;
    }

    const evals = this.db
      .prepare(
        `SELECT (created_at / 86400000) AS day_bucket, COUNT(*) AS total,
                COALESCE(SUM(CASE
                  WHEN decided_by = 'ai' OR ai_call_id IS NOT NULL OR state IN ('pending_ai', 'ai_failed')
                  THEN 1 ELSE 0 END), 0) AS ai
         FROM evaluations WHERE is_preview = 0 AND created_at >= ?1 GROUP BY day_bucket`,
      )
      .all(sinceMs) as Array<{ day_bucket: number; total: number; ai: number }>;
    for (const r of evals) {
      const entry = map.get(r.day_bucket);
      if (!entry) continue;
      entry.evaluated_posts = r.total;
      entry.ai_escalated_posts = r.ai;
      if (r.total > 0) entry.ai_escalation_rate = r.ai / r.total;
    }

    const report: AiUsageReport = {
      days: [],
      total_calls: 0,
      total_items: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      overall_ai_escalation_rate: 0,
    };
    let totalEval = 0;
    let totalAi = 0;
    for (const entry of [...map.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      report.days.push(entry);
      report.total_calls += entry.calls;
      report.total_items += entry.items;
      report.total_input_tokens += entry.input_tokens;
      report.total_output_tokens += entry.output_tokens;
      report.total_cost_usd += entry.cost_usd;
      totalEval += entry.evaluated_posts;
      totalAi += entry.ai_escalated_posts;
    }
    report.overall_ai_escalation_rate = totalEval > 0 ? totalAi / totalEval : 0;
    return report;
  }

  /** Items sent to AI since the start of the current UTC day. */
  countItemsToday(nowMs: number): number {
    const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    return (
      this.db
        .prepare("SELECT COALESCE(SUM(item_count), 0) AS n FROM ai_calls WHERE created_at >= ?1")
        .get(dayStart) as { n: number }
    ).n;
  }
}

export class Settings {
  constructor(private readonly db: Database.Database) {}

  get<T = unknown>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?1").get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, jsonText(value));
  }

  delete(key: string): boolean {
    return this.db.prepare("DELETE FROM settings WHERE key = ?1").run(key).changes > 0;
  }

  /** All settings sorted by key. */
  getAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key, value FROM settings ORDER BY key ASC").all() as Array<{
      key: string;
      value: string;
    }>) {
      out[r.key] = JSON.parse(r.value);
    }
    return out;
  }
}

/** Proleptic Gregorian `YYYY-MM-DD` from a Unix day count (Hinnant's algorithm). */
export function unixDayToYmd(unixDays: number): string {
  const z = unixDays + 719_468;
  const era = Math.trunc((z >= 0 ? z : z - 146_096) / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
