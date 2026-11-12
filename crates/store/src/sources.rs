use rusqlite::{params, OptionalExtension, Row};

use crate::models::{
    new_ulid, CrawlRunInput, CrawlRunRecord, DiscoveredSourceInput, SourceListItem, SourceRecord,
    UpsertSourcesResult,
};
use crate::{Store, StoreError};

pub(crate) fn map_source_row(row: &Row<'_>) -> rusqlite::Result<SourceRecord> {
    Ok(SourceRecord {
        id: row.get("id")?,
        platform: row.get("platform")?,
        kind: row.get("kind")?,
        external_id: row.get("external_id")?,
        name: row.get("name")?,
        url: row.get("url")?,
        privacy: row.get("privacy")?,
        member_count: row.get("member_count")?,
        profile_id: row.get("profile_id")?,
        followed: row.get::<_, i64>("followed")? != 0,
        priority: row.get("priority")?,
        state: row.get("state")?,
        last_crawl_at: row.get("last_crawl_at")?,
        avg_new_posts: row.get("avg_new_posts")?,
        created_at: row.get("created_at")?,
    })
}

impl Store {
    /// Upsert sources reported by `sources.discovered`, respecting optional `follow` flag
    /// (preserving existing `followed` when `follow` is `None`) and `profile_id`.
    pub fn upsert_discovered_sources(
        &self,
        sources: &[DiscoveredSourceInput],
        follow: Option<bool>,
        profile_id: Option<&str>,
        now_ms: i64,
    ) -> Result<UpsertSourcesResult, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let mut inserted = 0usize;
        let mut updated = 0usize;
        let mut source_ids = Vec::with_capacity(sources.len());

        for item in sources {
            let existing: Option<(String, i64)> = tx
                .query_row(
                    "SELECT id, followed FROM sources WHERE platform = ?1 AND external_id = ?2",
                    params![item.platform, item.external_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;

            if let Some((existing_id, existing_followed)) = existing {
                let next_followed = match follow {
                    Some(true) => 1i64,
                    Some(false) => 0i64,
                    None => existing_followed,
                };
                tx.execute(
                    "UPDATE sources
                     SET kind = ?1,
                         name = ?2,
                         url = ?3,
                         privacy = COALESCE(?4, privacy),
                         member_count = COALESCE(?5, member_count),
                         profile_id = COALESCE(?6, profile_id),
                         followed = ?7
                     WHERE id = ?8",
                    params![
                        item.kind,
                        item.name,
                        item.url,
                        item.privacy,
                        item.member_count,
                        profile_id,
                        next_followed,
                        existing_id,
                    ],
                )?;
                updated += 1;
                source_ids.push(existing_id);
            } else {
                let id = new_ulid();
                let followed_int = i64::from(follow.unwrap_or(false));
                tx.execute(
                    "INSERT INTO sources (
                       id, platform, kind, external_id, name, url, privacy, member_count,
                       profile_id, followed, priority, state, last_crawl_at, avg_new_posts, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 'ok', NULL, 0.0, ?11)",
                    params![
                        id,
                        item.platform,
                        item.kind,
                        item.external_id,
                        item.name,
                        item.url,
                        item.privacy,
                        item.member_count,
                        profile_id,
                        followed_int,
                        now_ms,
                    ],
                )?;
                inserted += 1;
                source_ids.push(id);
            }
        }

        tx.commit()?;
        Ok(UpsertSourcesResult {
            inserted,
            updated,
            source_ids,
        })
    }

    /// Fetch a source by its internal ULID.
    pub fn source_get(&self, source_id: &str) -> Result<Option<SourceRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM sources WHERE id = ?1",
                params![source_id],
                map_source_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// Fetch a source by `(platform, external_id)`.
    pub fn get_source_by_external_id(
        &self,
        platform: &str,
        external_id: &str,
    ) -> Result<Option<SourceRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM sources WHERE platform = ?1 AND external_id = ?2",
                params![platform, external_id],
                map_source_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List all discovered sources with stored post count (`text IS NOT NULL`) and 24h post rate.
    pub fn source_list(&self, now_ms: i64) -> Result<Vec<SourceListItem>, StoreError> {
        let since_24h = now_ms.saturating_sub(86_400_000);
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT
               s.*,
               COALESCE(SUM(CASE WHEN p.text IS NOT NULL THEN 1 ELSE 0 END), 0) AS stored_post_count,
               COALESCE(SUM(CASE WHEN p.captured_at >= ?1 THEN 1 ELSE 0 END), 0) AS posts_last_24h
             FROM sources s
             LEFT JOIN posts p ON p.source_id = s.id
             GROUP BY s.id
             ORDER BY s.followed DESC, s.priority DESC, s.name ASC",
        )?;

        let items = stmt
            .query_map(params![since_24h], |row| {
                let source = map_source_row(row)?;
                let stored_post_count: i64 = row.get("stored_post_count")?;
                let posts_last_24h: i64 = row.get("posts_last_24h")?;
                Ok(SourceListItem {
                    source,
                    stored_post_count,
                    posts_last_24h,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    /// Mark a source as followed (`followed = 1`).
    pub fn source_follow(&self, source_id: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE sources SET followed = 1 WHERE id = ?1",
            params![source_id],
        )?;
        Ok(changed > 0)
    }

    /// Mark a source as unfollowed (`followed = 0`).
    pub fn source_unfollow(&self, source_id: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE sources SET followed = 0 WHERE id = ?1",
            params![source_id],
        )?;
        Ok(changed > 0)
    }

    /// Set priority flag/level for a source (`0` = normal, `1` = priority).
    pub fn source_set_priority(&self, source_id: &str, priority: i32) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE sources SET priority = ?1 WHERE id = ?2",
            params![priority, source_id],
        )?;
        Ok(changed > 0)
    }

    /// Update operational state of a source (`"ok" | "error" | "inaccessible"`).
    pub fn source_set_state(&self, source_id: &str, state: &str) -> Result<bool, StoreError> {
        if !matches!(state, "ok" | "error" | "inaccessible") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid source state '{state}'"
            )));
        }
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE sources SET state = ?1 WHERE id = ?2",
            params![state, source_id],
        )?;
        Ok(changed > 0)
    }

    /// Record a crawl run (`crawl.report`), updating `sources.last_crawl_at` and recalculating
    /// 24-hour `avg_new_posts`.
    pub fn record_crawl_run(&self, run: &CrawlRunInput) -> Result<CrawlRunRecord, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        tx.execute(
            "INSERT INTO crawl_runs (
               id, source_id, reason, status, started_at, ended_at,
               posts_seen, posts_new, page_loads, strategy, error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               status = excluded.status,
               ended_at = excluded.ended_at,
               posts_seen = excluded.posts_seen,
               posts_new = excluded.posts_new,
               page_loads = excluded.page_loads,
               strategy = excluded.strategy,
               error = excluded.error",
            params![
                run.id,
                run.source_id,
                run.reason,
                run.status,
                run.started_at,
                run.ended_at,
                run.posts_seen,
                run.posts_new,
                run.page_loads,
                run.strategy,
                run.error,
            ],
        )?;

        let ref_ts = run.ended_at.unwrap_or(run.started_at);
        let since_24h = ref_ts.saturating_sub(86_400_000);
        let avg_new_posts: f64 = tx.query_row(
            "SELECT COALESCE(AVG(CAST(posts_new AS REAL)), 0.0)
             FROM crawl_runs
             WHERE source_id = ?1 AND started_at >= ?2",
            params![run.source_id, since_24h],
            |r| r.get(0),
        )?;

        tx.execute(
            "UPDATE sources
             SET last_crawl_at = MAX(COALESCE(last_crawl_at, 0), ?1),
                 avg_new_posts = ?2
             WHERE id = ?3",
            params![ref_ts, avg_new_posts, run.source_id],
        )?;

        let source_name: Option<String> = tx
            .query_row(
                "SELECT name FROM sources WHERE id = ?1",
                params![run.source_id],
                |r| r.get(0),
            )
            .optional()?;

        tx.commit()?;

        Ok(CrawlRunRecord {
            id: run.id.clone(),
            source_id: run.source_id.clone(),
            source_name,
            reason: run.reason.clone(),
            status: run.status.clone(),
            started_at: run.started_at,
            ended_at: run.ended_at,
            posts_seen: run.posts_seen,
            posts_new: run.posts_new,
            page_loads: run.page_loads,
            strategy: run.strategy.clone(),
            error: run.error.clone(),
        })
    }

    /// List recent crawl runs ordered by `started_at DESC`, optionally filtered by `source_id`.
    pub fn crawl_run_list(
        &self,
        source_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CrawlRunRecord>, StoreError> {
        let limit = limit.clamp(1, 1000) as i64;
        let conn = self.lock_conn()?;
        let map_row = |row: &Row<'_>| -> rusqlite::Result<CrawlRunRecord> {
            Ok(CrawlRunRecord {
                id: row.get("id")?,
                source_id: row.get("source_id")?,
                source_name: row.get("source_name")?,
                reason: row.get("reason")?,
                status: row.get("status")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                posts_seen: row.get("posts_seen")?,
                posts_new: row.get("posts_new")?,
                page_loads: row.get("page_loads")?,
                strategy: row.get("strategy")?,
                error: row.get("error")?,
            })
        };

        if let Some(sid) = source_id {
            let mut stmt = conn.prepare(
                "SELECT cr.*, s.name AS source_name
                 FROM crawl_runs cr
                 LEFT JOIN sources s ON s.id = cr.source_id
                 WHERE cr.source_id = ?1
                 ORDER BY cr.started_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![sid, limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        } else {
            let mut stmt = conn.prepare(
                "SELECT cr.*, s.name AS source_name
                 FROM crawl_runs cr
                 LEFT JOIN sources s ON s.id = cr.source_id
                 ORDER BY cr.started_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }
    }

    /// List followed sources that are currently operational (`followed = 1 AND state = 'ok'`).
    pub fn list_active_followed_sources(&self) -> Result<Vec<SourceRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM sources
             WHERE followed = 1 AND state = 'ok'
             ORDER BY priority DESC, name ASC",
        )?;
        let rows = stmt
            .query_map([], map_source_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// List operational sources referenced by at least one `active` radar (`03-desktop.md §3.2`).
    pub fn list_sources_for_active_radars(&self) -> Result<Vec<SourceRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT s.* FROM sources s
             WHERE s.state != 'inaccessible'
               AND EXISTS (
                 SELECT 1 FROM radar_sources rs
                 JOIN radars r ON r.id = rs.radar_id
                 WHERE rs.source_id = s.id AND r.status = 'active'
               )
             ORDER BY s.priority DESC, s.name ASC",
        )?;
        let rows = stmt
            .query_map([], map_source_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Count total followed sources (used to enforce plan limits: 10 Cá nhân / 50 Chuyên nghiệp).
    pub fn count_followed_sources(&self) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        let count = conn.query_row("SELECT COUNT(*) FROM sources WHERE followed = 1", [], |r| {
            r.get(0)
        })?;
        Ok(count)
    }
}
