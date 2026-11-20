// Port of crates/store/src/sources.rs and models/sources.rs.

import type Database from "better-sqlite3";

import { StoreError } from "./errors";
import { newUlid } from "./util";

export interface DiscoveredSourceInput {
  platform?: string;
  kind?: string;
  external_id: string;
  name: string;
  url: string;
  privacy?: string | null;
  member_count?: number | null;
}

export interface UpsertSourcesResult {
  inserted: number;
  updated: number;
  source_ids: string[];
}

export interface SourceRecord {
  id: string;
  platform: string;
  kind: string;
  external_id: string;
  name: string;
  url: string;
  privacy: string | null;
  member_count: number | null;
  profile_id: string | null;
  followed: boolean;
  priority: number;
  state: string;
  last_crawl_at: number | null;
  avg_new_posts: number;
  created_at: number;
}

export interface SourceListItem extends SourceRecord {
  stored_post_count: number;
  posts_last_24h: number;
}

export interface CrawlRunInput {
  id: string;
  source_id: string;
  reason: string;
  status: string;
  started_at: number;
  ended_at?: number | null;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy?: string | null;
  error?: string | null;
}

export interface CrawlRunRecord {
  id: string;
  source_id: string;
  source_name: string | null;
  reason: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy: string | null;
  error: string | null;
}

type Row = Record<string, unknown>;

export function mapSourceRow(row: Row): SourceRecord {
  return {
    id: row.id as string,
    platform: row.platform as string,
    kind: row.kind as string,
    external_id: row.external_id as string,
    name: row.name as string,
    url: row.url as string,
    privacy: row.privacy as string | null,
    member_count: row.member_count as number | null,
    profile_id: row.profile_id as string | null,
    followed: (row.followed as number) !== 0,
    priority: row.priority as number,
    state: row.state as string,
    last_crawl_at: row.last_crawl_at as number | null,
    avg_new_posts: row.avg_new_posts as number,
    created_at: row.created_at as number,
  };
}

function mapCrawlRun(row: Row): CrawlRunRecord {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    source_name: (row.source_name as string | null) ?? null,
    reason: row.reason as string,
    status: row.status as string,
    started_at: row.started_at as number,
    ended_at: row.ended_at as number | null,
    posts_seen: row.posts_seen as number,
    posts_new: row.posts_new as number,
    page_loads: row.page_loads as number,
    strategy: row.strategy as string | null,
    error: row.error as string | null,
  };
}

const DAY_MS = 86_400_000;

export class Sources {
  constructor(private readonly db: Database.Database) {}

  /**
   * Upsert sources from `sources.discovered`. `follow` undefined/null preserves an existing
   * `followed` flag and defaults new rows to unfollowed.
   */
  upsertDiscovered(
    sources: DiscoveredSourceInput[],
    follow: boolean | null,
    profileId: string | null,
    nowMs: number,
  ): UpsertSourcesResult {
    return this.db.transaction((): UpsertSourcesResult => {
      let inserted = 0;
      let updated = 0;
      const sourceIds: string[] = [];
      for (const item of sources) {
        const platform = item.platform ?? "facebook";
        const kind = item.kind ?? "group";
        const existing = this.db
          .prepare("SELECT id, followed FROM sources WHERE platform = ?1 AND external_id = ?2")
          .get(platform, item.external_id) as { id: string; followed: number } | undefined;
        if (existing) {
          const nextFollowed = follow === true ? 1 : follow === false ? 0 : existing.followed;
          this.db
            .prepare(
              `UPDATE sources
               SET kind = ?1, name = ?2, url = ?3,
                   privacy = COALESCE(?4, privacy),
                   member_count = COALESCE(?5, member_count),
                   profile_id = COALESCE(?6, profile_id),
                   followed = ?7
               WHERE id = ?8`,
            )
            .run(kind, item.name, item.url, item.privacy ?? null, item.member_count ?? null, profileId, nextFollowed, existing.id);
          updated += 1;
          sourceIds.push(existing.id);
        } else {
          const id = newUlid(nowMs);
          this.db
            .prepare(
              `INSERT INTO sources (
                 id, platform, kind, external_id, name, url, privacy, member_count,
                 profile_id, followed, priority, state, last_crawl_at, avg_new_posts, created_at
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 'ok', NULL, 0.0, ?11)`,
            )
            .run(id, platform, kind, item.external_id, item.name, item.url, item.privacy ?? null, item.member_count ?? null, profileId, follow === true ? 1 : 0, nowMs);
          inserted += 1;
          sourceIds.push(id);
        }
      }
      return { inserted, updated, source_ids: sourceIds };
    })();
  }

  get(sourceId: string): SourceRecord | null {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?1").get(sourceId) as Row | undefined;
    return row ? mapSourceRow(row) : null;
  }

  getByExternalId(platform: string, externalId: string): SourceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sources WHERE platform = ?1 AND external_id = ?2")
      .get(platform, externalId) as Row | undefined;
    return row ? mapSourceRow(row) : null;
  }

  /** All sources with stored-post count (`text IS NOT NULL`) and 24h post rate. */
  list(nowMs: number): SourceListItem[] {
    const since24h = nowMs - DAY_MS;
    const rows = this.db
      .prepare(
        `SELECT s.*,
           COALESCE(SUM(CASE WHEN p.text IS NOT NULL THEN 1 ELSE 0 END), 0) AS stored_post_count,
           COALESCE(SUM(CASE WHEN p.captured_at >= ?1 THEN 1 ELSE 0 END), 0) AS posts_last_24h
         FROM sources s LEFT JOIN posts p ON p.source_id = s.id
         GROUP BY s.id
         ORDER BY s.followed DESC, s.priority DESC, s.name ASC`,
      )
      .all(since24h) as Row[];
    return rows.map((row) => ({
      ...mapSourceRow(row),
      stored_post_count: row.stored_post_count as number,
      posts_last_24h: row.posts_last_24h as number,
    }));
  }

  follow(sourceId: string): boolean {
    return this.db.prepare("UPDATE sources SET followed = 1 WHERE id = ?1").run(sourceId).changes > 0;
  }

  unfollow(sourceId: string): boolean {
    return this.db.prepare("UPDATE sources SET followed = 0 WHERE id = ?1").run(sourceId).changes > 0;
  }

  setPriority(sourceId: string, priority: number): boolean {
    return this.db.prepare("UPDATE sources SET priority = ?1 WHERE id = ?2").run(priority, sourceId).changes > 0;
  }

  setState(sourceId: string, state: string): boolean {
    if (!["ok", "error", "inaccessible"].includes(state)) {
      throw StoreError.invalidArgument(`invalid source state '${state}'`);
    }
    return this.db.prepare("UPDATE sources SET state = ?1 WHERE id = ?2").run(state, sourceId).changes > 0;
  }

  /** Record a crawl run, bump `last_crawl_at` and recompute the 24h `avg_new_posts`. */
  recordCrawlRun(run: CrawlRunInput): CrawlRunRecord {
    return this.db.transaction((): CrawlRunRecord => {
      this.db
        .prepare(
          `INSERT INTO crawl_runs (
             id, source_id, reason, status, started_at, ended_at,
             posts_seen, posts_new, page_loads, strategy, error
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status, ended_at = excluded.ended_at,
             posts_seen = excluded.posts_seen, posts_new = excluded.posts_new,
             page_loads = excluded.page_loads, strategy = excluded.strategy, error = excluded.error`,
        )
        .run(
          run.id,
          run.source_id,
          run.reason,
          run.status,
          run.started_at,
          run.ended_at ?? null,
          run.posts_seen,
          run.posts_new,
          run.page_loads,
          run.strategy ?? null,
          run.error ?? null,
        );
      const refTs = run.ended_at ?? run.started_at;
      const since24h = refTs - DAY_MS;
      const avg = (
        this.db
          .prepare(
            `SELECT COALESCE(AVG(CAST(posts_new AS REAL)), 0.0) AS a
             FROM crawl_runs WHERE source_id = ?1 AND started_at >= ?2`,
          )
          .get(run.source_id, since24h) as { a: number }
      ).a;
      this.db
        .prepare(
          `UPDATE sources SET last_crawl_at = MAX(COALESCE(last_crawl_at, 0), ?1), avg_new_posts = ?2
           WHERE id = ?3`,
        )
        .run(refTs, avg, run.source_id);
      const name = this.db.prepare("SELECT name FROM sources WHERE id = ?1").get(run.source_id) as
        | { name: string }
        | undefined;
      return {
        id: run.id,
        source_id: run.source_id,
        source_name: name?.name ?? null,
        reason: run.reason,
        status: run.status,
        started_at: run.started_at,
        ended_at: run.ended_at ?? null,
        posts_seen: run.posts_seen,
        posts_new: run.posts_new,
        page_loads: run.page_loads,
        strategy: run.strategy ?? null,
        error: run.error ?? null,
      };
    })();
  }

  listCrawlRuns(sourceId: string | null, limit: number): CrawlRunRecord[] {
    const lim = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const base = `SELECT cr.*, s.name AS source_name
                  FROM crawl_runs cr LEFT JOIN sources s ON s.id = cr.source_id`;
    const rows =
      sourceId !== null
        ? (this.db
            .prepare(`${base} WHERE cr.source_id = ?1 ORDER BY cr.started_at DESC LIMIT ?2`)
            .all(sourceId, lim) as Row[])
        : (this.db.prepare(`${base} ORDER BY cr.started_at DESC LIMIT ?1`).all(lim) as Row[]);
    return rows.map(mapCrawlRun);
  }

  /** Followed sources that are operational (`followed = 1 AND state = 'ok'`). */
  listActiveFollowed(): SourceRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM sources WHERE followed = 1 AND state = 'ok' ORDER BY priority DESC, name ASC")
        .all() as Row[]
    ).map(mapSourceRow);
  }

  /** Non-inaccessible sources referenced by at least one active radar. */
  listForActiveRadars(): SourceRecord[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM sources s
           WHERE s.state != 'inaccessible'
             AND EXISTS (
               SELECT 1 FROM radar_sources rs JOIN radars r ON r.id = rs.radar_id
               WHERE rs.source_id = s.id AND r.status = 'active'
             )
           ORDER BY s.priority DESC, s.name ASC`,
        )
        .all() as Row[]
    ).map(mapSourceRow);
  }

  countFollowed(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sources WHERE followed = 1").get() as { c: number }).c;
  }
}
