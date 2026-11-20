// Port of crates/store/src/posts/* and models/posts.rs.
//
// `posts.simhash` is a signed 64-bit integer. Statements that read posts therefore use
// better-sqlite3 `safeIntegers` and `PostRecord.simhash` is a bigint; every other integer is
// converted back to a JS number. The IPC layer must convert bigint -> number (what a Tauri webview
// did when it parsed the Rust JSON).

import type Database from "better-sqlite3";

import { StoreError } from "./errors";
import {
  buildFts5Query,
  extractE164PhonesLight,
  hammingDistance,
  newUlid,
  simhashBands,
} from "./util";

export interface AuthorInput {
  external_id?: string | null;
  name: string;
  is_anonymous?: boolean;
}

export interface AuthorRecord {
  id: string;
  platform: string;
  external_id: string | null;
  name: string;
  first_seen_at: number;
  last_seen_at: number;
  post_count_7d: number;
  group_count_7d: number;
}

export interface NewPost {
  id?: string | null;
  platform: string;
  external_id: string;
  source_id: string;
  author?: AuthorInput | null;
  permalink: string;
  text?: string | null;
  text_norm?: string | null;
  text_fold?: string | null;
  text_truncated?: boolean;
  lang?: string | null;
  content_hash: string;
  simhash: bigint | number;
  attachments?: unknown;
  counts?: unknown;
  extracted_phones?: string[];
  created_at?: number | null;
  captured_at: number;
  strategy: string;
}

export interface PostRecord {
  id: string;
  platform: string;
  external_id: string;
  source_id: string;
  author_id: string | null;
  permalink: string;
  text: string | null;
  text_norm: string | null;
  text_fold: string | null;
  text_truncated: boolean;
  lang: string | null;
  content_hash: string;
  simhash: bigint;
  simhash_bands: [number, number, number, number];
  dup_cluster_id: string | null;
  is_cluster_head: boolean;
  attachments: unknown | null;
  counts: unknown | null;
  extracted_phones: string[];
  created_at: number | null;
  captured_at: number;
  strategy: string;
  purged_at: number | null;
}

export interface PostDetail extends PostRecord {
  source_name: string;
  author_name: string | null;
}

export interface SimhashMatch {
  post: PostRecord;
  hamming_distance: number;
}

export interface DupClusterRecord {
  id: string;
  head_post_id: string;
  size: number;
  source_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface AlsoSeenInEntry {
  post_id: string;
  source_id: string;
  source_name: string;
  permalink: string;
  captured_at: number;
}

export interface AttachDupResult {
  cluster: DupClusterRecord;
  is_repost_after_72h: boolean;
  updated_lead_ids: string[];
}

export interface PeerSignals {
  author_post_count_7d: number;
  author_followed_posts_7d: number;
  author_group_count_7d: number;
  cluster_source_count: number;
  max_distinct_authors_for_phone: number;
  signal_count: number;
  is_peer_override: boolean;
}

export interface RejectedEvaluationItem {
  evaluation_id: string;
  radar_version_id: string;
  post_id: string;
  post_text: string | null;
  permalink: string;
  source_id: string;
  source_name: string;
  author_name: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  score: number | null;
  reason: string | null;
  created_at: number;
  decided_at: number | null;
}

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;

/** Lenient JSON read matching `serde_json::from_str(..).ok()`. */
function parseJsonOrNull(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseStringArrayOrEmpty(raw: unknown): string[] {
  const v = parseJsonOrNull(raw);
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Map a row read through a `safeIntegers` statement. */
export function mapPostRow(row: Row): PostRecord {
  return {
    id: row.id as string,
    platform: row.platform as string,
    external_id: row.external_id as string,
    source_id: row.source_id as string,
    author_id: row.author_id as string | null,
    permalink: row.permalink as string,
    text: row.text as string | null,
    text_norm: row.text_norm as string | null,
    text_fold: row.text_fold as string | null,
    text_truncated: num(row.text_truncated) !== 0,
    lang: row.lang as string | null,
    content_hash: row.content_hash as string,
    simhash: row.simhash as bigint,
    // Rust: `i64 as u16` truncation.
    simhash_bands: [
      num(row.simhash_b0) & 0xffff,
      num(row.simhash_b1) & 0xffff,
      num(row.simhash_b2) & 0xffff,
      num(row.simhash_b3) & 0xffff,
    ],
    dup_cluster_id: row.dup_cluster_id as string | null,
    is_cluster_head: num(row.is_cluster_head) !== 0,
    attachments: parseJsonOrNull(row.attachments),
    counts: parseJsonOrNull(row.counts),
    extracted_phones: parseStringArrayOrEmpty(row.extracted_phones),
    created_at: numOrNull(row.created_at),
    captured_at: num(row.captured_at),
    strategy: row.strategy as string,
    purged_at: numOrNull(row.purged_at),
  };
}

function mapPostDetail(row: Row): PostDetail {
  return {
    ...mapPostRow(row),
    source_name: row.source_name as string,
    author_name: row.author_name as string | null,
  };
}

function mapAuthor(row: Row): AuthorRecord {
  return {
    id: row.id as string,
    platform: row.platform as string,
    external_id: row.external_id as string | null,
    name: row.name as string,
    first_seen_at: row.first_seen_at as number,
    last_seen_at: row.last_seen_at as number,
    post_count_7d: row.post_count_7d as number,
    group_count_7d: row.group_count_7d as number,
  };
}

function mapCluster(row: Row): DupClusterRecord {
  return {
    id: row.id as string,
    head_post_id: row.head_post_id as string,
    size: row.size as number,
    source_count: row.source_count as number,
    first_seen_at: row.first_seen_at as number,
    last_seen_at: row.last_seen_at as number,
  };
}

const toI64 = (v: bigint | number): bigint => BigInt.asIntN(64, BigInt(v));

export class Posts {
  constructor(private readonly db: Database.Database) {}

  /** Statement whose INTEGER columns come back as bigint (for `mapPostRow`). */
  private post(sql: string): Database.Statement {
    return this.db.prepare(sql).safeIntegers(true);
  }

  // ---- ingest -------------------------------------------------------------------------------

  /** Idempotent insert by `(platform, external_id)`. Returns `[post, isNew]`. */
  insert(input: NewPost): [PostRecord, boolean] {
    return this.db.transaction((): [PostRecord, boolean] => {
      const existing = this.post("SELECT * FROM posts WHERE platform = ?1 AND external_id = ?2").get(
        input.platform,
        input.external_id,
      ) as Row | undefined;
      if (existing) return [mapPostRow(existing), false];

      const authorId = input.author
        ? this.upsertAuthor(input.platform, input.author, input.captured_at)
        : null;

      const postId = input.id ?? newUlid(input.captured_at);
      const simhash = toI64(input.simhash);
      const bands = simhashBands(simhash);

      const phoneSet = new Set<string>(input.extracted_phones ?? []);
      if (input.text != null) for (const p of extractE164PhonesLight(input.text)) phoneSet.add(p);
      const phones = [...phoneSet].sort();
      const phonesJson = phones.length === 0 ? null : JSON.stringify(phones);

      this.db
        .prepare(
          `INSERT INTO posts (
             id, platform, external_id, source_id, author_id, permalink,
             text, text_norm, text_fold, text_truncated, lang,
             content_hash, simhash, simhash_b0, simhash_b1, simhash_b2, simhash_b3,
             dup_cluster_id, is_cluster_head, attachments, counts, extracted_phones,
             created_at, captured_at, strategy, purged_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6,
             ?7, ?8, ?9, ?10, ?11,
             ?12, ?13, ?14, ?15, ?16, ?17,
             NULL, 1, ?18, ?19, ?20,
             ?21, ?22, ?23, NULL
           )`,
        )
        .run(
          postId,
          input.platform,
          input.external_id,
          input.source_id,
          authorId,
          input.permalink,
          input.text ?? null,
          input.text_norm ?? null,
          input.text_fold ?? null,
          input.text_truncated ? 1 : 0,
          input.lang ?? null,
          input.content_hash,
          simhash,
          bands[0],
          bands[1],
          bands[2],
          bands[3],
          input.attachments == null ? null : JSON.stringify(input.attachments),
          input.counts == null ? null : JSON.stringify(input.counts),
          phonesJson,
          input.created_at ?? null,
          input.captured_at,
          input.strategy,
        );

      if (authorId) this.refreshAuthor7dStats(authorId);

      const created = this.post("SELECT * FROM posts WHERE id = ?1").get(postId) as Row;
      return [mapPostRow(created), true];
    })();
  }

  /** Merge normalized E.164 phones into `posts.extracted_phones`. */
  recordPhones(postId: string, phones: string[]): boolean {
    const row = this.db.prepare("SELECT extracted_phones FROM posts WHERE id = ?1").get(postId) as
      | { extracted_phones: string | null }
      | undefined;
    if (!row) return false;
    const merged = new Set<string>(parseStringArrayOrEmpty(row.extracted_phones));
    for (const p of phones) merged.add(p);
    const json = merged.size === 0 ? null : JSON.stringify([...merged].sort());
    return this.db.prepare("UPDATE posts SET extracted_phones = ?1 WHERE id = ?2").run(json, postId).changes > 0;
  }

  authorGet(authorId: string): AuthorRecord | null {
    const row = this.db.prepare("SELECT * FROM authors WHERE id = ?1").get(authorId) as Row | undefined;
    return row ? mapAuthor(row) : null;
  }

  private upsertAuthor(platform: string, author: AuthorInput, capturedAt: number): string | null {
    const extId = author.external_id ?? null;
    if (author.is_anonymous && extId === null) return null;

    if (extId !== null) {
      const existing = this.db
        .prepare("SELECT id FROM authors WHERE platform = ?1 AND external_id = ?2")
        .get(platform, extId) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE authors SET name = ?1, first_seen_at = MIN(first_seen_at, ?2),
               last_seen_at = MAX(last_seen_at, ?2) WHERE id = ?3`,
          )
          .run(author.name, capturedAt, existing.id);
        return existing.id;
      }
      const id = newUlid(capturedAt);
      this.db
        .prepare(
          `INSERT INTO authors (id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 0)`,
        )
        .run(id, platform, extId, author.name, capturedAt);
      return id;
    }

    if (author.name.trim() === "") return null;
    const existing = this.db
      .prepare("SELECT id FROM authors WHERE platform = ?1 AND external_id IS NULL AND name = ?2")
      .get(platform, author.name) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE authors SET first_seen_at = MIN(first_seen_at, ?1), last_seen_at = MAX(last_seen_at, ?1)
           WHERE id = ?2`,
        )
        .run(capturedAt, existing.id);
      return existing.id;
    }
    const id = newUlid(capturedAt);
    this.db
      .prepare(
        `INSERT INTO authors (id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d)
         VALUES (?1, ?2, NULL, ?3, ?4, ?4, 0, 0)`,
      )
      .run(id, platform, author.name, capturedAt);
    return id;
  }

  private refreshAuthor7dStats(authorId: string): void {
    const maxTs = (
      this.db
        .prepare("SELECT COALESCE(MAX(captured_at), 0) AS m FROM posts WHERE author_id = ?1")
        .get(authorId) as { m: number }
    ).m;
    const since7d = maxTs - 7 * DAY_MS;
    const { p, g } = this.db
      .prepare(
        `SELECT COUNT(*) AS p, COUNT(DISTINCT source_id) AS g
         FROM posts WHERE author_id = ?1 AND captured_at >= ?2`,
      )
      .get(authorId, since7d) as { p: number; g: number };
    this.db.prepare("UPDATE authors SET post_count_7d = ?1, group_count_7d = ?2 WHERE id = ?3").run(p, g, authorId);
  }

  // ---- dedup --------------------------------------------------------------------------------

  /** Exact duplicate lookup by `content_hash` since `sinceMs`, optionally excluding one post. */
  findExactDup(contentHash: string, sinceMs: number, excludePostId: string | null = null): PostRecord | null {
    const row =
      excludePostId !== null
        ? (this.post(
            `SELECT * FROM posts WHERE content_hash = ?1 AND captured_at >= ?2 AND id != ?3
             ORDER BY is_cluster_head DESC, captured_at ASC LIMIT 1`,
          ).get(contentHash, sinceMs, excludePostId) as Row | undefined)
        : (this.post(
            `SELECT * FROM posts WHERE content_hash = ?1 AND captured_at >= ?2
             ORDER BY is_cluster_head DESC, captured_at ASC LIMIT 1`,
          ).get(contentHash, sinceMs) as Row | undefined);
    return row ? mapPostRow(row) : null;
  }

  /**
   * Near-duplicate lookup: for distance <= 3 the 4x16-bit band indexes narrow candidates
   * (pigeonhole), then exact 64-bit Hamming filtering applies.
   */
  findSimhashDups(
    simhash: bigint | number,
    maxHammingDist: number,
    sinceMs: number,
    excludePostId: string | null = null,
  ): SimhashMatch[] {
    const sh = toI64(simhash);
    let rows: Row[];
    if (maxHammingDist <= 3) {
      const b = simhashBands(sh);
      rows = this.post(
        `SELECT * FROM posts
         WHERE captured_at >= ?1
           AND (simhash_b0 = ?2 OR simhash_b1 = ?3 OR simhash_b2 = ?4 OR simhash_b3 = ?5)
         ORDER BY is_cluster_head DESC, captured_at ASC`,
      ).all(sinceMs, b[0], b[1], b[2], b[3]) as Row[];
    } else {
      rows = this.post(
        "SELECT * FROM posts WHERE captured_at >= ?1 ORDER BY is_cluster_head DESC, captured_at ASC",
      ).all(sinceMs) as Row[];
    }
    const matches: SimhashMatch[] = [];
    for (const row of rows) {
      const post = mapPostRow(row);
      if (excludePostId !== null && post.id === excludePostId) continue;
      const dist = hammingDistance(sh, post.simhash);
      if (dist <= maxHammingDist) matches.push({ post, hamming_distance: dist });
    }
    matches.sort(
      (a, b) =>
        a.hamming_distance - b.hamming_distance ||
        Number(b.post.is_cluster_head) - Number(a.post.is_cluster_head) ||
        a.post.captured_at - b.post.captured_at,
    );
    return matches;
  }

  /** Create or extend the dedup cluster of `matchedPostId` with `dupPostId`. */
  createOrAttachDupCluster(matchedPostId: string, dupPostId: string): AttachDupResult {
    const REPOST_WINDOW_MS = 72 * 3_600_000;
    if (matchedPostId === dupPostId) {
      throw StoreError.invalidArgument("matched_post_id and dup_post_id must be distinct");
    }
    return this.db.transaction((): AttachDupResult => {
      const matchedRow = this.post("SELECT * FROM posts WHERE id = ?1").get(matchedPostId) as Row | undefined;
      if (!matchedRow) throw StoreError.notFound("post", matchedPostId);
      const matched = mapPostRow(matchedRow);
      const dupRow = this.post("SELECT * FROM posts WHERE id = ?1").get(dupPostId) as Row | undefined;
      if (!dupRow) throw StoreError.notFound("post", dupPostId);
      const dup = mapPostRow(dupRow);

      let clusterId = matched.dup_cluster_id;
      if (clusterId === null) {
        clusterId = newUlid(matched.captured_at);
        this.db
          .prepare(
            `INSERT INTO dup_clusters (id, head_post_id, size, source_count, first_seen_at, last_seen_at)
             VALUES (?1, ?2, 1, 1, ?3, ?3)`,
          )
          .run(clusterId, matched.id, matched.captured_at);
        this.db
          .prepare("UPDATE posts SET dup_cluster_id = ?1, is_cluster_head = 1 WHERE id = ?2")
          .run(clusterId, matched.id);
      }

      const headFirstSeen = (
        this.db.prepare("SELECT first_seen_at FROM dup_clusters WHERE id = ?1").get(clusterId) as {
          first_seen_at: number;
        }
      ).first_seen_at;
      const isRepostAfter72h = dup.captured_at - headFirstSeen > REPOST_WINDOW_MS;

      this.db
        .prepare("UPDATE posts SET dup_cluster_id = ?1, is_cluster_head = 0 WHERE id = ?2")
        .run(clusterId, dup.id);

      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS size, COUNT(DISTINCT source_id) AS source_count,
                  MIN(captured_at) AS first_seen_at, MAX(captured_at) AS last_seen_at
           FROM posts WHERE dup_cluster_id = ?1`,
        )
        .get(clusterId) as { size: number; source_count: number; first_seen_at: number; last_seen_at: number };
      this.db
        .prepare(
          `UPDATE dup_clusters SET size = ?1, source_count = ?2, first_seen_at = ?3, last_seen_at = ?4
           WHERE id = ?5`,
        )
        .run(agg.size, agg.source_count, agg.first_seen_at, agg.last_seen_at, clusterId);

      const updatedLeadIds: string[] = [];
      if (!isRepostAfter72h) {
        const dupSourceName = (
          this.db.prepare("SELECT name FROM sources WHERE id = ?1").get(dup.source_id) as { name: string }
        ).name;
        const leads = this.db
          .prepare(
            `SELECT l.id AS id, p.source_id AS source_id, l.also_seen_in AS also_seen_in
             FROM leads l JOIN posts p ON p.id = l.post_id
             WHERE p.dup_cluster_id = ?1 AND l.post_id != ?2`,
          )
          .all(clusterId, dup.id) as Array<{ id: string; source_id: string; also_seen_in: string | null }>;
        for (const lead of leads) {
          const parsed = parseJsonOrNull(lead.also_seen_in);
          const entries: AlsoSeenInEntry[] = Array.isArray(parsed) ? (parsed as AlsoSeenInEntry[]) : [];
          const alreadyPresent = entries.some((e) => e.post_id === dup.id || e.source_id === dup.source_id);
          if (dup.source_id !== lead.source_id && !alreadyPresent) {
            entries.push({
              post_id: dup.id,
              source_id: dup.source_id,
              source_name: dupSourceName,
              permalink: dup.permalink,
              captured_at: dup.captured_at,
            });
            this.db
              .prepare("UPDATE leads SET also_seen_in = ?1, updated_at = MAX(updated_at, ?2) WHERE id = ?3")
              .run(JSON.stringify(entries), dup.captured_at, lead.id);
            updatedLeadIds.push(lead.id);
          }
        }
      }

      const cluster = mapCluster(
        this.db.prepare("SELECT * FROM dup_clusters WHERE id = ?1").get(clusterId) as Row,
      );
      return { cluster, is_repost_after_72h: isRepostAfter72h, updated_lead_ids: updatedLeadIds };
    })();
  }

  getDupCluster(clusterId: string): DupClusterRecord | null {
    const row = this.db.prepare("SELECT * FROM dup_clusters WHERE id = ?1").get(clusterId) as Row | undefined;
    return row ? mapCluster(row) : null;
  }

  // ---- peer signals -------------------------------------------------------------------------

  /** Distinct authors associated with an E.164 phone across contacts, posts, evaluations, leads. */
  countDistinctAuthorsForPhone(e164Phone: string): number {
    const authors = new Set<string>();

    const contactRows = this.db
      .prepare(
        `SELECT c.author_ids AS author_ids FROM contacts c
         WHERE c.phones IS NOT NULL AND c.author_ids IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(c.phones) jp WHERE jp.value = ?1)`,
      )
      .all(e164Phone) as Array<{ author_ids: string }>;
    for (const r of contactRows) {
      const ids = parseJsonOrNull(r.author_ids);
      if (Array.isArray(ids) && ids.every((x) => typeof x === "string")) {
        for (const id of ids as string[]) if (id !== "") authors.add(id);
      }
    }

    const authorQueries = [
      `SELECT DISTINCT p.author_id AS a FROM posts p
       WHERE p.author_id IS NOT NULL AND p.extracted_phones IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(p.extracted_phones) jp WHERE jp.value = ?1)`,
      `SELECT DISTINCT p.author_id AS a FROM evaluations e JOIN posts p ON p.id = e.post_id
       WHERE p.author_id IS NOT NULL AND e.fields IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(e.fields) jf WHERE json_extract(jf.value, '$.value') = ?1)`,
      `SELECT DISTINCT p.author_id AS a FROM leads l JOIN posts p ON p.id = l.post_id
       WHERE p.author_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(l.fields) jf WHERE json_extract(jf.value, '$.value') = ?1)`,
    ];
    for (const sql of authorQueries) {
      for (const r of this.db.prepare(sql).all(e164Phone) as Array<{ a: string }>) authors.add(r.a);
    }
    return authors.size;
  }

  /** The three T6 peer-detection signals (05-pipeline-rules.md §8.3). */
  getPeerSignals(postId: string, phones: string[], nowMs: number): PeerSignals {
    const row = this.post("SELECT * FROM posts WHERE id = ?1").get(postId) as Row | undefined;
    if (!row) throw StoreError.notFound("post", postId);
    const post = mapPostRow(row);

    const since7d = nowMs - 7 * DAY_MS;
    let authorPostCount7d = 0;
    let authorFollowedPosts7d = 0;
    let authorGroupCount7d = 0;
    if (post.author_id !== null) {
      const a = this.db
        .prepare("SELECT post_count_7d, group_count_7d FROM authors WHERE id = ?1")
        .get(post.author_id) as { post_count_7d: number; group_count_7d: number } | undefined;
      authorPostCount7d = a?.post_count_7d ?? 0;
      authorGroupCount7d = a?.group_count_7d ?? 0;
      authorFollowedPosts7d = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM posts p JOIN sources s ON s.id = p.source_id
             WHERE p.author_id = ?1 AND p.captured_at >= ?2 AND s.followed = 1`,
          )
          .get(post.author_id, since7d) as { c: number }
      ).c;
    }

    let clusterSourceCount = 1;
    if (post.dup_cluster_id !== null) {
      const c = this.db.prepare("SELECT source_count FROM dup_clusters WHERE id = ?1").get(post.dup_cluster_id) as
        | { source_count: number }
        | undefined;
      clusterSourceCount = c?.source_count ?? 1;
    }

    const allPhones = new Set<string>([...phones, ...post.extracted_phones]);
    let maxDistinct = 0;
    for (const phone of [...allPhones].sort()) {
      maxDistinct = Math.max(maxDistinct, this.countDistinctAuthorsForPhone(phone));
    }

    let signalCount = 0;
    if (authorFollowedPosts7d >= 5) signalCount += 1;
    if (clusterSourceCount >= 4) signalCount += 1;
    if (maxDistinct >= 3) signalCount += 1;

    return {
      author_post_count_7d: authorPostCount7d,
      author_followed_posts_7d: authorFollowedPosts7d,
      author_group_count_7d: authorGroupCount7d,
      cluster_source_count: clusterSourceCount,
      max_distinct_authors_for_phone: maxDistinct,
      signal_count: signalCount,
      is_peer_override: signalCount >= 2,
    };
  }

  // ---- queries ------------------------------------------------------------------------------

  private static readonly DETAIL_JOIN = `
    FROM posts p
    JOIN sources s ON s.id = p.source_id
    LEFT JOIN authors a ON a.id = p.author_id`;

  get(postId: string): PostDetail | null {
    const row = this.post(
      `SELECT p.*, s.name AS source_name, a.name AS author_name ${Posts.DETAIL_JOIN} WHERE p.id = ?1`,
    ).get(postId) as Row | undefined;
    return row ? mapPostDetail(row) : null;
  }

  /** Retained posts of one source, most recently published first, keyset-paginated. */
  listBySource(sourceId: string, before: [number, string] | null, limit: number): PostDetail[] {
    const lim = Math.min(500, Math.max(0, Math.trunc(limit)));
    const rows = this.post(
      `SELECT p.*, s.name AS source_name, a.name AS author_name ${Posts.DETAIL_JOIN}
       WHERE p.source_id = ?1 AND p.text IS NOT NULL
         AND (?2 IS NULL OR (COALESCE(p.created_at, p.captured_at), p.id) < (?2, ?3))
       ORDER BY COALESCE(p.created_at, p.captured_at) DESC, p.id DESC
       LIMIT ?4`,
    ).all(sourceId, before ? before[0] : null, before ? before[1] : null, lim) as Row[];
    return rows.map(mapPostDetail);
  }

  /** Diacritic-insensitive full-text search over stored posts. */
  search(query: string, sourceId: string | null, limit: number): PostDetail[] {
    const fts = buildFts5Query(query);
    if (fts === null) return [];
    const lim = Math.min(500, Math.max(1, Math.trunc(limit)));
    const select = `SELECT p.*, s.name AS source_name, a.name AS author_name
      FROM posts_fts f
      JOIN posts p ON p.rowid = f.rowid
      JOIN sources s ON s.id = p.source_id
      LEFT JOIN authors a ON a.id = p.author_id`;
    const rows =
      sourceId !== null
        ? (this.post(
            `${select} WHERE posts_fts MATCH ?1 AND p.source_id = ?2 AND p.text IS NOT NULL
             ORDER BY bm25(posts_fts), p.captured_at DESC LIMIT ?3`,
          ).all(fts, sourceId, lim) as Row[])
        : (this.post(
            `${select} WHERE posts_fts MATCH ?1 AND p.text IS NOT NULL
             ORDER BY bm25(posts_fts), p.captured_at DESC LIMIT ?2`,
          ).all(fts, lim) as Row[]);
    return rows.map(mapPostDetail);
  }

  /** Recent non-purged posts across sources, optionally since `captured_at >= sinceMs`. */
  listRecentForSources(sourceIds: string[], limit: number, sinceMs: number | null = null): PostRecord[] {
    if (sourceIds.length === 0 || limit === 0) return [];
    const lim = Math.min(5000, Math.max(1, Math.trunc(limit)));
    const args: Array<string | number> = [...sourceIds];
    let sql = `SELECT * FROM posts WHERE source_id IN (${sourceIds.map((_, i) => `?${i + 1}`).join(", ")}) AND text IS NOT NULL`;
    if (sinceMs !== null) {
      args.push(sinceMs);
      sql += ` AND captured_at >= ?${args.length}`;
    }
    args.push(lim);
    sql += ` ORDER BY captured_at DESC LIMIT ?${args.length}`;
    return (this.post(sql).all(...args) as Row[]).map(mapPostRow);
  }

  /** Recent rejected (non-preview, `no_match`) evaluations for a radar. */
  listRejectedEvaluations(radarId: string, limit: number): RejectedEvaluationItem[] {
    const lim = Math.min(500, Math.max(1, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `SELECT e.id AS evaluation_id, e.radar_version_id, e.post_id, p.text AS post_text, p.permalink,
                p.source_id, s.name AS source_name, a.name AS author_name, e.decided_by,
                e.reject_reason, e.score, e.reason, e.created_at, e.decided_at
         FROM evaluations e
         JOIN radar_versions rv ON rv.id = e.radar_version_id
         JOIN posts p ON p.id = e.post_id
         JOIN sources s ON s.id = p.source_id
         LEFT JOIN authors a ON a.id = p.author_id
         WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.state = 'done' AND e.verdict = 'no_match'
         ORDER BY COALESCE(e.decided_at, e.created_at) DESC
         LIMIT ?2`,
      )
      .all(radarId, lim);
    return rows as RejectedEvaluationItem[];
  }
}
