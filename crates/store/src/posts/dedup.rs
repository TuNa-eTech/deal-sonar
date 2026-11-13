//! Exact and SimHash duplicate detection and dup clusters.

use super::*;

impl Store {
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
}
