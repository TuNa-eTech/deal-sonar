//! Post lookup, search, recent posts, and rejected evaluations.

use super::*;

impl Store {
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
