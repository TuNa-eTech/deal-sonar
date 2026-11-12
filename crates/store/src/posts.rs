use std::collections::BTreeSet;

use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension, Row};

use crate::models::{
    build_fts5_query, extract_e164_phones_light, hamming_distance, new_ulid, simhash_bands,
    AlsoSeenInEntry, AttachDupResult, AuthorInput, AuthorRecord, DupClusterRecord, NewPost,
    PeerSignals, PostDetail, PostRecord, RejectedEvaluationItem, SimhashMatch,
};
use crate::{Store, StoreError};

pub(crate) fn map_post_row(row: &Row<'_>) -> rusqlite::Result<PostRecord> {
    let attachments_raw: Option<String> = row.get("attachments")?;
    let counts_raw: Option<String> = row.get("counts")?;
    let phones_raw: Option<String> = row.get("extracted_phones")?;

    let attachments = attachments_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let counts = counts_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let extracted_phones: Vec<String> = phones_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let b0 = row.get::<_, i64>("simhash_b0")? as u16;
    let b1 = row.get::<_, i64>("simhash_b1")? as u16;
    let b2 = row.get::<_, i64>("simhash_b2")? as u16;
    let b3 = row.get::<_, i64>("simhash_b3")? as u16;

    Ok(PostRecord {
        id: row.get("id")?,
        platform: row.get("platform")?,
        external_id: row.get("external_id")?,
        source_id: row.get("source_id")?,
        author_id: row.get("author_id")?,
        permalink: row.get("permalink")?,
        text: row.get("text")?,
        text_norm: row.get("text_norm")?,
        text_fold: row.get("text_fold")?,
        text_truncated: row.get::<_, i64>("text_truncated")? != 0,
        lang: row.get("lang")?,
        content_hash: row.get("content_hash")?,
        simhash: row.get("simhash")?,
        simhash_bands: [b0, b1, b2, b3],
        dup_cluster_id: row.get("dup_cluster_id")?,
        is_cluster_head: row.get::<_, i64>("is_cluster_head")? != 0,
        attachments,
        counts,
        extracted_phones,
        created_at: row.get("created_at")?,
        captured_at: row.get("captured_at")?,
        strategy: row.get("strategy")?,
        purged_at: row.get("purged_at")?,
    })
}

fn map_author_row(row: &Row<'_>) -> rusqlite::Result<AuthorRecord> {
    Ok(AuthorRecord {
        id: row.get("id")?,
        platform: row.get("platform")?,
        external_id: row.get("external_id")?,
        name: row.get("name")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
        post_count_7d: row.get("post_count_7d")?,
        group_count_7d: row.get("group_count_7d")?,
    })
}

fn map_cluster_row(row: &Row<'_>) -> rusqlite::Result<DupClusterRecord> {
    Ok(DupClusterRecord {
        id: row.get("id")?,
        head_post_id: row.get("head_post_id")?,
        size: row.get("size")?,
        source_count: row.get("source_count")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

impl Store {
    /// Idempotent post insertion by `(platform, external_id)`.
    /// Returns `(PostRecord, is_new)`. When `is_new` is true, upserts the author (when not anonymous)
    /// and refreshes the author's 7-day `post_count_7d` and `group_count_7d`.
    pub fn insert_post(&self, input: &NewPost) -> Result<(PostRecord, bool), StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        if let Some(existing) = tx
            .query_row(
                "SELECT * FROM posts WHERE platform = ?1 AND external_id = ?2",
                params![input.platform, input.external_id],
                map_post_row,
            )
            .optional()?
        {
            return Ok((existing, false));
        }

        let author_id = if let Some(author) = &input.author {
            upsert_author_tx(&tx, &input.platform, author, input.captured_at)?
        } else {
            None
        };

        let post_id = input.id.clone().unwrap_or_else(new_ulid);
        let bands = simhash_bands(input.simhash);

        let mut phone_set: BTreeSet<String> = input.extracted_phones.iter().cloned().collect();
        if let Some(t) = &input.text {
            for p in extract_e164_phones_light(t) {
                phone_set.insert(p);
            }
        }
        let phones_vec: Vec<String> = phone_set.into_iter().collect();
        let phones_json = if phones_vec.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&phones_vec)?)
        };

        let attachments_json = input
            .attachments
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let counts_json = input
            .counts
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        tx.execute(
            "INSERT INTO posts (
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
             )",
            params![
                post_id,
                input.platform,
                input.external_id,
                input.source_id,
                author_id,
                input.permalink,
                input.text,
                input.text_norm,
                input.text_fold,
                i64::from(input.text_truncated),
                input.lang,
                input.content_hash,
                input.simhash,
                i64::from(bands[0]),
                i64::from(bands[1]),
                i64::from(bands[2]),
                i64::from(bands[3]),
                attachments_json,
                counts_json,
                phones_json,
                input.created_at,
                input.captured_at,
                input.strategy,
            ],
        )?;

        if let Some(aid) = &author_id {
            refresh_author_7d_stats_tx(&tx, aid)?;
        }

        let created = tx.query_row(
            "SELECT * FROM posts WHERE id = ?1",
            params![post_id],
            map_post_row,
        )?;
        tx.commit()?;
        Ok((created, true))
    }

    /// Record normalized E.164 phone numbers extracted from a post (e.g. from `vn_phone` extractor).
    pub fn record_post_phones(&self, post_id: &str, phones: &[String]) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let existing_raw: Option<Option<String>> = conn
            .query_row(
                "SELECT extracted_phones FROM posts WHERE id = ?1",
                params![post_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(existing_opt) = existing_raw else {
            return Ok(false);
        };
        let mut merged: BTreeSet<String> = existing_opt
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        for p in phones {
            merged.insert(p.clone());
        }
        let json = if merged.is_empty() {
            None
        } else {
            Some(serde_json::to_string(
                &merged.into_iter().collect::<Vec<_>>(),
            )?)
        };
        let changed = conn.execute(
            "UPDATE posts SET extracted_phones = ?1 WHERE id = ?2",
            params![json, post_id],
        )?;
        Ok(changed > 0)
    }

    /// Fetch an author by ULID.
    pub fn author_get(&self, author_id: &str) -> Result<Option<AuthorRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM authors WHERE id = ?1",
                params![author_id],
                map_author_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// Exact duplicate lookup by `content_hash` since `since_ms` (e.g. `now_ms - 14d`).
    pub fn find_exact_dup(
        &self,
        content_hash: &str,
        since_ms: i64,
    ) -> Result<Option<PostRecord>, StoreError> {
        self.find_exact_dup_excluding(content_hash, since_ms, None)
    }

    /// Exact duplicate lookup excluding a specific `post_id` (useful when `insert_post` ran first).
    pub fn find_exact_dup_excluding(
        &self,
        content_hash: &str,
        since_ms: i64,
        exclude_post_id: Option<&str>,
    ) -> Result<Option<PostRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = if let Some(excl) = exclude_post_id {
            conn.query_row(
                "SELECT * FROM posts
                 WHERE content_hash = ?1 AND captured_at >= ?2 AND id != ?3
                 ORDER BY is_cluster_head DESC, captured_at ASC
                 LIMIT 1",
                params![content_hash, since_ms, excl],
                map_post_row,
            )
            .optional()?
        } else {
            conn.query_row(
                "SELECT * FROM posts
                 WHERE content_hash = ?1 AND captured_at >= ?2
                 ORDER BY is_cluster_head DESC, captured_at ASC
                 LIMIT 1",
                params![content_hash, since_ms],
                map_post_row,
            )
            .optional()?
        };
        Ok(rec)
    }

    /// Near-duplicate SimHash lookup (`05-pipeline-rules.md §4`) using the 4x16-bit band indexes
    /// followed by exact 64-bit Hamming distance filtering in Rust.
    pub fn find_simhash_dups(
        &self,
        simhash: i64,
        max_hamming_dist: u32,
        since_ms: i64,
    ) -> Result<Vec<SimhashMatch>, StoreError> {
        self.find_simhash_dups_excluding(simhash, max_hamming_dist, since_ms, None)
    }

    /// Near-duplicate SimHash lookup excluding a specific `post_id`.
    pub fn find_simhash_dups_excluding(
        &self,
        simhash: i64,
        max_hamming_dist: u32,
        since_ms: i64,
        exclude_post_id: Option<&str>,
    ) -> Result<Vec<SimhashMatch>, StoreError> {
        let conn = self.lock_conn()?;
        let candidates: Vec<PostRecord> = if max_hamming_dist <= 3 {
            // Pigeonhole principle: any two 64-bit hashes within <= 3 bit flips share >= 1 16-bit band.
            let bands = simhash_bands(simhash);
            let mut stmt = conn.prepare(
                "SELECT * FROM posts
                 WHERE captured_at >= ?1
                   AND (simhash_b0 = ?2 OR simhash_b1 = ?3 OR simhash_b2 = ?4 OR simhash_b3 = ?5)
                 ORDER BY is_cluster_head DESC, captured_at ASC",
            )?;
            let rows = stmt.query_map(
                params![
                    since_ms,
                    i64::from(bands[0]),
                    i64::from(bands[1]),
                    i64::from(bands[2]),
                    i64::from(bands[3]),
                ],
                map_post_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT * FROM posts
                 WHERE captured_at >= ?1
                 ORDER BY is_cluster_head DESC, captured_at ASC",
            )?;
            let rows = stmt.query_map(params![since_ms], map_post_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut matches = Vec::new();
        for post in candidates {
            if exclude_post_id.is_some_and(|excl| excl == post.id) {
                continue;
            }
            let dist = hamming_distance(simhash, post.simhash);
            if dist <= max_hamming_dist {
                matches.push(SimhashMatch {
                    post,
                    hamming_distance: dist,
                });
            }
        }
        matches.sort_by(|a, b| {
            a.hamming_distance
                .cmp(&b.hamming_distance)
                .then_with(|| b.post.is_cluster_head.cmp(&a.post.is_cluster_head))
                .then_with(|| a.post.captured_at.cmp(&b.post.captured_at))
        });
        Ok(matches)
    }

    /// Create or attach `dup_post_id` onto the deduplication cluster of `matched_post_id`
    /// (`05-pipeline-rules.md §4`).
    ///
    /// - Recomputes `dup_clusters(size, source_count, first_seen_at, last_seen_at)`.
    /// - Sets `is_cluster_head = 0` on `dup_post_id`.
    /// - If `dup_post` arrived within 72 hours of the cluster's `first_seen_at`, updates existing
    ///   leads' `also_seen_in` JSON list (`is_repost_after_72h = false`).
    /// - If `> 72h`, marks `is_repost_after_72h = true` so the pipeline can allow intentional reposts through.
    pub fn create_or_attach_dup_cluster(
        &self,
        matched_post_id: &str,
        dup_post_id: &str,
    ) -> Result<AttachDupResult, StoreError> {
        const REPOST_WINDOW_MS: i64 = 72 * 3_600_000;

        if matched_post_id == dup_post_id {
            return Err(StoreError::InvalidArgument(
                "matched_post_id and dup_post_id must be distinct".to_string(),
            ));
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let matched_post = tx
            .query_row(
                "SELECT * FROM posts WHERE id = ?1",
                params![matched_post_id],
                map_post_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "post",
                id: matched_post_id.to_string(),
            })?;

        let dup_post = tx
            .query_row(
                "SELECT * FROM posts WHERE id = ?1",
                params![dup_post_id],
                map_post_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "post",
                id: dup_post_id.to_string(),
            })?;

        let cluster_id = if let Some(cid) = matched_post.dup_cluster_id.clone() {
            cid
        } else {
            let cid = new_ulid();
            tx.execute(
                "INSERT INTO dup_clusters (id, head_post_id, size, source_count, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, 1, 1, ?3, ?3)",
                params![cid, matched_post.id, matched_post.captured_at],
            )?;
            tx.execute(
                "UPDATE posts SET dup_cluster_id = ?1, is_cluster_head = 1 WHERE id = ?2",
                params![cid, matched_post.id],
            )?;
            cid
        };

        let head_first_seen: i64 = tx.query_row(
            "SELECT first_seen_at FROM dup_clusters WHERE id = ?1",
            params![cluster_id],
            |r| r.get(0),
        )?;

        let is_repost_after_72h =
            dup_post.captured_at.saturating_sub(head_first_seen) > REPOST_WINDOW_MS;

        tx.execute(
            "UPDATE posts SET dup_cluster_id = ?1, is_cluster_head = 0 WHERE id = ?2",
            params![cluster_id, dup_post.id],
        )?;

        let (size, source_count, first_seen_at, last_seen_at): (i64, i64, i64, i64) = tx
            .query_row(
                "SELECT
               COUNT(*),
               COUNT(DISTINCT source_id),
               MIN(captured_at),
               MAX(captured_at)
             FROM posts
             WHERE dup_cluster_id = ?1",
                params![cluster_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;

        tx.execute(
            "UPDATE dup_clusters
             SET size = ?1, source_count = ?2, first_seen_at = ?3, last_seen_at = ?4
             WHERE id = ?5",
            params![size, source_count, first_seen_at, last_seen_at, cluster_id],
        )?;

        let mut updated_lead_ids = Vec::new();
        if !is_repost_after_72h {
            let dup_source_name: String = tx.query_row(
                "SELECT name FROM sources WHERE id = ?1",
                params![dup_post.source_id],
                |r| r.get(0),
            )?;

            let existing_leads: Vec<(String, String, Option<String>)> = {
                let mut stmt = tx.prepare(
                    "SELECT l.id, p.source_id, l.also_seen_in
                     FROM leads l
                     JOIN posts p ON p.id = l.post_id
                     WHERE p.dup_cluster_id = ?1 AND l.post_id != ?2",
                )?;
                let rows = stmt.query_map(params![cluster_id, dup_post.id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            for (lead_id, lead_source_id, also_raw) in existing_leads {
                let mut entries: Vec<AlsoSeenInEntry> = also_raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                let already_present = entries
                    .iter()
                    .any(|e| e.post_id == dup_post.id || e.source_id == dup_post.source_id);

                if dup_post.source_id != lead_source_id && !already_present {
                    entries.push(AlsoSeenInEntry {
                        post_id: dup_post.id.clone(),
                        source_id: dup_post.source_id.clone(),
                        source_name: dup_source_name.clone(),
                        permalink: dup_post.permalink.clone(),
                        captured_at: dup_post.captured_at,
                    });
                    let json = serde_json::to_string(&entries)?;
                    tx.execute(
                        "UPDATE leads SET also_seen_in = ?1, updated_at = MAX(updated_at, ?2) WHERE id = ?3",
                        params![json, dup_post.captured_at, lead_id],
                    )?;
                    updated_lead_ids.push(lead_id);
                }
            }
        }

        let cluster = tx.query_row(
            "SELECT * FROM dup_clusters WHERE id = ?1",
            params![cluster_id],
            map_cluster_row,
        )?;

        tx.commit()?;

        Ok(AttachDupResult {
            cluster,
            is_repost_after_72h,
            updated_lead_ids,
        })
    }

    /// Fetch a deduplication cluster by ID.
    pub fn get_dup_cluster(
        &self,
        cluster_id: &str,
    ) -> Result<Option<DupClusterRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM dup_clusters WHERE id = ?1",
                params![cluster_id],
                map_cluster_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// Count distinct authors associated with an E.164 phone number (`05-pipeline-rules.md §8.3`)
    /// across `contacts`, `posts.extracted_phones`, and extracted phone fields in `evaluations`/`leads`.
    pub fn count_distinct_authors_for_phone(&self, e164_phone: &str) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        count_distinct_authors_for_phone_conn(&conn, e164_phone)
    }

    /// Compute all three T6 peer-detection signals (`05-pipeline-rules.md §8.3`):
    /// 1) Author posted >= 5 times in 7 days across followed sources.
    /// 2) Post's dedup cluster spans >= 4 distinct sources.
    /// 3) Any phone in `phones` (or post's `extracted_phones`) appears across >= 3 distinct authors.
    pub fn get_peer_signals(
        &self,
        post_id: &str,
        phones: &[String],
        now_ms: i64,
    ) -> Result<PeerSignals, StoreError> {
        let conn = self.lock_conn()?;
        let post = conn
            .query_row(
                "SELECT * FROM posts WHERE id = ?1",
                params![post_id],
                map_post_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "post",
                id: post_id.to_string(),
            })?;

        let since_7d = now_ms.saturating_sub(7 * 86_400_000);
        let (author_post_count_7d, author_followed_posts_7d, author_group_count_7d) =
            if let Some(aid) = &post.author_id {
                let (p7, g7): (i64, i64) = conn
                    .query_row(
                        "SELECT post_count_7d, group_count_7d FROM authors WHERE id = ?1",
                        params![aid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?
                    .unwrap_or((0, 0));
                let followed_7d: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM posts p
                     JOIN sources s ON s.id = p.source_id
                     WHERE p.author_id = ?1 AND p.captured_at >= ?2 AND s.followed = 1",
                    params![aid, since_7d],
                    |r| r.get(0),
                )?;
                (p7, followed_7d, g7)
            } else {
                (0, 0, 0)
            };

        let cluster_source_count: i64 = if let Some(cid) = &post.dup_cluster_id {
            conn.query_row(
                "SELECT source_count FROM dup_clusters WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(1)
        } else {
            1
        };

        let mut all_phones: BTreeSet<String> = phones.iter().cloned().collect();
        for p in &post.extracted_phones {
            all_phones.insert(p.clone());
        }

        let mut max_distinct_authors_for_phone = 0i64;
        for phone in &all_phones {
            let cnt = count_distinct_authors_for_phone_conn(&conn, phone)?;
            if cnt > max_distinct_authors_for_phone {
                max_distinct_authors_for_phone = cnt;
            }
        }

        let mut signal_count = 0u8;
        if author_followed_posts_7d >= 5 {
            signal_count += 1;
        }
        if cluster_source_count >= 4 {
            signal_count += 1;
        }
        if max_distinct_authors_for_phone >= 3 {
            signal_count += 1;
        }

        Ok(PeerSignals {
            author_post_count_7d,
            author_followed_posts_7d,
            author_group_count_7d,
            cluster_source_count,
            max_distinct_authors_for_phone,
            signal_count,
            is_peer_override: signal_count >= 2,
        })
    }

    /// Fetch a post joined with `source_name` and `author_name`.
    pub fn post_get(&self, post_id: &str) -> Result<Option<PostDetail>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT p.*, s.name AS source_name, a.name AS author_name
                 FROM posts p
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN authors a ON a.id = p.author_id
                 WHERE p.id = ?1",
                params![post_id],
                |row| {
                    Ok(PostDetail {
                        post: map_post_row(row)?,
                        source_name: row.get("source_name")?,
                        author_name: row.get("author_name")?,
                    })
                },
            )
            .optional()?;
        Ok(rec)
    }

    /// Full-text diacritic-insensitive search across stored posts via `posts_fts`
    /// (`unicode61 remove_diacritics 2`).
    pub fn post_search(
        &self,
        query: &str,
        source_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PostDetail>, StoreError> {
        let Some(fts_query) = build_fts5_query(query) else {
            return Ok(Vec::new());
        };
        let limit = limit.clamp(1, 500) as i64;
        let conn = self.lock_conn()?;

        let map_detail = |row: &Row<'_>| -> rusqlite::Result<PostDetail> {
            Ok(PostDetail {
                post: map_post_row(row)?,
                source_name: row.get("source_name")?,
                author_name: row.get("author_name")?,
            })
        };

        if let Some(sid) = source_id {
            let mut stmt = conn.prepare(
                "SELECT p.*, s.name AS source_name, a.name AS author_name
                 FROM posts_fts f
                 JOIN posts p ON p.rowid = f.rowid
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN authors a ON a.id = p.author_id
                 WHERE posts_fts MATCH ?1
                   AND p.source_id = ?2
                   AND p.text IS NOT NULL
                 ORDER BY bm25(posts_fts), p.captured_at DESC
                 LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(params![fts_query, sid, limit], map_detail)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        } else {
            let mut stmt = conn.prepare(
                "SELECT p.*, s.name AS source_name, a.name AS author_name
                 FROM posts_fts f
                 JOIN posts p ON p.rowid = f.rowid
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN authors a ON a.id = p.author_id
                 WHERE posts_fts MATCH ?1
                   AND p.text IS NOT NULL
                 ORDER BY bm25(posts_fts), p.captured_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![fts_query, limit], map_detail)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }
    }

    /// List recent non-purged posts across `source_ids` (used for preview up to 50 posts).
    pub fn list_recent_posts_for_sources(
        &self,
        source_ids: &[String],
        limit: usize,
    ) -> Result<Vec<PostRecord>, StoreError> {
        self.list_recent_posts_for_sources_since(source_ids, None, limit)
    }

    /// List recent non-purged posts across `source_ids` optionally restricted to `captured_at >= since_ms`
    /// (used for both preview and 24-hour unpause backfill per `02-radar-spec.md §4`).
    pub fn list_recent_posts_for_sources_since(
        &self,
        source_ids: &[String],
        since_ms: Option<i64>,
        limit: usize,
    ) -> Result<Vec<PostRecord>, StoreError> {
        if source_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 5000) as i64;
        let conn = self.lock_conn()?;

        let mut sql_params: Vec<SqlValue> = Vec::with_capacity(source_ids.len() + 2);
        let mut placeholders = Vec::with_capacity(source_ids.len());
        for (idx, sid) in source_ids.iter().enumerate() {
            placeholders.push(format!("?{}", idx + 1));
            sql_params.push(SqlValue::Text(sid.clone()));
        }

        let mut sql = format!(
            "SELECT * FROM posts WHERE source_id IN ({}) AND text IS NOT NULL",
            placeholders.join(", ")
        );
        if let Some(since) = since_ms {
            sql_params.push(SqlValue::Integer(since));
            sql.push_str(&format!(" AND captured_at >= ?{}", sql_params.len()));
        }
        sql_params.push(SqlValue::Integer(limit));
        sql.push_str(&format!(
            " ORDER BY captured_at DESC LIMIT ?{}",
            sql_params.len()
        ));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(sql_params), map_post_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// List recent rejected evaluations (`verdict = 'no_match'`, non-preview) for a radar so the
    /// user can inspect rejected posts and mark false negatives (`missed` feedback).
    pub fn evaluation_list_rejected(
        &self,
        radar_id: &str,
        limit: usize,
    ) -> Result<Vec<RejectedEvaluationItem>, StoreError> {
        let limit = limit.clamp(1, 500) as i64;
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT
               e.id AS evaluation_id,
               e.radar_version_id,
               e.post_id,
               p.text AS post_text,
               p.permalink,
               p.source_id,
               s.name AS source_name,
               a.name AS author_name,
               e.decided_by,
               e.reject_reason,
               e.score,
               e.reason,
               e.created_at,
               e.decided_at
             FROM evaluations e
             JOIN radar_versions rv ON rv.id = e.radar_version_id
             JOIN posts p ON p.id = e.post_id
             JOIN sources s ON s.id = p.source_id
             LEFT JOIN authors a ON a.id = p.author_id
             WHERE rv.radar_id = ?1
               AND e.is_preview = 0
               AND e.state = 'done'
               AND e.verdict = 'no_match'
             ORDER BY COALESCE(e.decided_at, e.created_at) DESC
             LIMIT ?2",
        )?;

        let rows = stmt
            .query_map(params![radar_id, limit], |row| {
                Ok(RejectedEvaluationItem {
                    evaluation_id: row.get("evaluation_id")?,
                    radar_version_id: row.get("radar_version_id")?,
                    post_id: row.get("post_id")?,
                    post_text: row.get("post_text")?,
                    permalink: row.get("permalink")?,
                    source_id: row.get("source_id")?,
                    source_name: row.get("source_name")?,
                    author_name: row.get("author_name")?,
                    decided_by: row.get("decided_by")?,
                    reject_reason: row.get("reject_reason")?,
                    score: row.get("score")?,
                    reason: row.get("reason")?,
                    created_at: row.get("created_at")?,
                    decided_at: row.get("decided_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn upsert_author_tx(
    conn: &rusqlite::Connection,
    platform: &str,
    author: &AuthorInput,
    captured_at: i64,
) -> Result<Option<String>, StoreError> {
    if author.is_anonymous && author.external_id.is_none() {
        return Ok(None);
    }

    if let Some(ext_id) = &author.external_id {
        if let Some(existing_id) = conn
            .query_row(
                "SELECT id FROM authors WHERE platform = ?1 AND external_id = ?2",
                params![platform, ext_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE authors
                 SET name = ?1,
                     first_seen_at = MIN(first_seen_at, ?2),
                     last_seen_at = MAX(last_seen_at, ?2)
                 WHERE id = ?3",
                params![author.name, captured_at, existing_id],
            )?;
            return Ok(Some(existing_id));
        }

        let id = new_ulid();
        conn.execute(
            "INSERT INTO authors (
               id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 0)",
            params![id, platform, ext_id, author.name, captured_at],
        )?;
        Ok(Some(id))
    } else {
        if author.name.trim().is_empty() {
            return Ok(None);
        }
        if let Some(existing_id) = conn
            .query_row(
                "SELECT id FROM authors WHERE platform = ?1 AND external_id IS NULL AND name = ?2",
                params![platform, author.name],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE authors
                 SET first_seen_at = MIN(first_seen_at, ?1),
                     last_seen_at = MAX(last_seen_at, ?1)
                 WHERE id = ?2",
                params![captured_at, existing_id],
            )?;
            return Ok(Some(existing_id));
        }
        let id = new_ulid();
        conn.execute(
            "INSERT INTO authors (
               id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d
             ) VALUES (?1, ?2, NULL, ?3, ?4, ?4, 0, 0)",
            params![id, platform, author.name, captured_at],
        )?;
        Ok(Some(id))
    }
}

fn refresh_author_7d_stats_tx(
    conn: &rusqlite::Connection,
    author_id: &str,
) -> Result<(), StoreError> {
    let max_ts: i64 = conn.query_row(
        "SELECT COALESCE(MAX(captured_at), 0) FROM posts WHERE author_id = ?1",
        params![author_id],
        |r| r.get(0),
    )?;
    let since_7d = max_ts.saturating_sub(7 * 86_400_000);
    let (post_count_7d, group_count_7d): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT source_id)
         FROM posts
         WHERE author_id = ?1 AND captured_at >= ?2",
        params![author_id, since_7d],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    conn.execute(
        "UPDATE authors SET post_count_7d = ?1, group_count_7d = ?2 WHERE id = ?3",
        params![post_count_7d, group_count_7d, author_id],
    )?;
    Ok(())
}

fn count_distinct_authors_for_phone_conn(
    conn: &rusqlite::Connection,
    e164_phone: &str,
) -> Result<i64, StoreError> {
    let mut distinct_authors = BTreeSet::new();

    // 1. From `contacts` (merged E.164 phones -> author_ids)
    {
        let mut stmt = conn.prepare(
            "SELECT c.author_ids
             FROM contacts c
             WHERE c.phones IS NOT NULL
               AND c.author_ids IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(c.phones) jp WHERE jp.value = ?1
               )",
        )?;
        let rows = stmt.query_map(params![e164_phone], |r| r.get::<_, String>(0))?;
        for raw in rows {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&raw?) {
                for aid in ids {
                    if !aid.is_empty() {
                        distinct_authors.insert(aid);
                    }
                }
            }
        }
    }

    // 2. From `posts.extracted_phones`
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.author_id
             FROM posts p
             WHERE p.author_id IS NOT NULL
               AND p.extracted_phones IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(p.extracted_phones) jp WHERE jp.value = ?1
               )",
        )?;
        let rows = stmt.query_map(params![e164_phone], |r| r.get::<_, String>(0))?;
        for aid in rows {
            distinct_authors.insert(aid?);
        }
    }

    // 3. From `evaluations.fields` and `leads.fields` (in case phone was extracted by AI/rules without `record_post_phones`)
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.author_id
             FROM evaluations e
             JOIN posts p ON p.id = e.post_id
             WHERE p.author_id IS NOT NULL
               AND e.fields IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(e.fields) jf
                 WHERE json_extract(jf.value, '$.value') = ?1
               )",
        )?;
        let rows = stmt.query_map(params![e164_phone], |r| r.get::<_, String>(0))?;
        for aid in rows {
            distinct_authors.insert(aid?);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.author_id
             FROM leads l
             JOIN posts p ON p.id = l.post_id
             WHERE p.author_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(l.fields) jf
                 WHERE json_extract(jf.value, '$.value') = ?1
               )",
        )?;
        let rows = stmt.query_map(params![e164_phone], |r| r.get::<_, String>(0))?;
        for aid in rows {
            distinct_authors.insert(aid?);
        }
    }

    Ok(distinct_authors.len() as i64)
}
