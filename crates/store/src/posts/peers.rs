//! Behavioral peer signals (shared phones, posting volume).

use super::*;

impl Store {
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
}

pub(super) fn count_distinct_authors_for_phone_conn(
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
