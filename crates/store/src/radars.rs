use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{
    is_valid_field_key, new_ulid, CreateRadarDraftInput, FieldDef, MatchPolicy, NewRulesetInput,
    NotifyConfig, RadarFunnelStats, RadarListItem, RadarRecord, RadarUpdateResult,
    RadarVersionRecord, RadarWithVersion, RulesetRecord, UpdateRadarInput,
};
use crate::{Store, StoreError};

pub(crate) fn validate_field_defs(fields: &[FieldDef]) -> Result<(), StoreError> {
    let mut seen = BTreeSet::new();
    for f in fields {
        if !is_valid_field_key(&f.key) {
            return Err(StoreError::InvalidFieldKey(f.key.clone()));
        }
        if !seen.insert(f.key.clone()) {
            return Err(StoreError::InvalidArgument(format!(
                "duplicate field key '{}'",
                f.key
            )));
        }
    }
    Ok(())
}

pub(crate) fn map_radar_row(row: &Row<'_>) -> rusqlite::Result<RadarRecord> {
    let notify_raw: String = row.get("notify")?;
    let notify: NotifyConfig = serde_json::from_str(&notify_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RadarRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        status: row.get("status")?,
        template_id: row.get("template_id")?,
        current_version: row.get("current_version")?,
        notify,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn map_radar_version_row(row: &Row<'_>) -> rusqlite::Result<RadarVersionRecord> {
    let fields_raw: String = row.get("fields")?;
    let policy_raw: String = row.get("match_policy")?;
    let fields: Vec<FieldDef> = serde_json::from_str(&fields_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let match_policy: MatchPolicy = serde_json::from_str(&policy_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RadarVersionRecord {
        id: row.get("id")?,
        radar_id: row.get("radar_id")?,
        version: row.get("version")?,
        description: row.get("description")?,
        language_hint: row.get("language_hint")?,
        user_profession: row.get("user_profession")?,
        fields,
        match_policy,
        created_at: row.get("created_at")?,
    })
}

fn map_ruleset_row(row: &Row<'_>) -> rusqlite::Result<RulesetRecord> {
    let body_raw: String = row.get("body")?;
    let metrics_raw: Option<String> = row.get("metrics")?;
    let body: serde_json::Value = serde_json::from_str(&body_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let metrics = metrics_raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    Ok(RulesetRecord {
        id: row.get("id")?,
        radar_version_id: row.get("radar_version_id")?,
        revision: row.get("revision")?,
        state: row.get("state")?,
        origin: row.get("origin")?,
        body,
        metrics,
        created_at: row.get("created_at")?,
        activated_at: row.get("activated_at")?,
    })
}

pub(crate) fn load_radar_with_version_conn(
    conn: &Connection,
    radar_id: &str,
) -> Result<Option<RadarWithVersion>, StoreError> {
    let Some(radar) = conn
        .query_row(
            "SELECT * FROM radars WHERE id = ?1",
            params![radar_id],
            map_radar_row,
        )
        .optional()?
    else {
        return Ok(None);
    };

    let current_version = conn.query_row(
        "SELECT * FROM radar_versions WHERE radar_id = ?1 AND version = ?2",
        params![radar_id, radar.current_version],
        map_radar_version_row,
    )?;

    let candidate_version = conn
        .query_row(
            "SELECT * FROM radar_versions
             WHERE radar_id = ?1 AND version > ?2
             ORDER BY version DESC
             LIMIT 1",
            params![radar_id, radar.current_version],
            map_radar_version_row,
        )
        .optional()?;

    let source_ids = {
        let mut stmt = conn.prepare(
            "SELECT source_id FROM radar_sources WHERE radar_id = ?1 ORDER BY source_id ASC",
        )?;
        let rows = stmt.query_map(params![radar_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Some(RadarWithVersion {
        radar,
        current_version,
        candidate_version,
        source_ids,
    }))
}

impl Store {
    pub fn radar_versions(&self, id: &str) -> Result<Vec<RadarVersionRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut statement =
            conn.prepare("SELECT * FROM radar_versions WHERE radar_id=?1 ORDER BY version DESC")?;
        let rows = statement.query_map(params![id], map_radar_version_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Create a new radar in `draft` state along with its initial `version = 1` row and `radar_sources`.
    pub fn radar_create_draft(
        &self,
        input: &CreateRadarDraftInput,
    ) -> Result<RadarWithVersion, StoreError> {
        validate_field_defs(&input.fields)?;

        let radar_id = input.id.clone().unwrap_or_else(new_ulid);
        let version_id = new_ulid();
        let notify_json = serde_json::to_string(&input.notify)?;
        let fields_json = serde_json::to_string(&input.fields)?;
        let policy_json = serde_json::to_string(&input.match_policy)?;

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        tx.execute(
            "INSERT INTO radars (
               id, name, status, template_id, current_version, notify, created_at, updated_at
             ) VALUES (?1, ?2, 'draft', ?3, 1, ?4, ?5, ?5)",
            params![
                radar_id,
                input.name,
                input.template_id,
                notify_json,
                input.now_ms
            ],
        )?;

        tx.execute(
            "INSERT INTO radar_versions (
               id, radar_id, version, description, language_hint, user_profession,
               fields, match_policy, created_at
             ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                version_id,
                radar_id,
                input.description,
                input.language_hint,
                input.user_profession,
                fields_json,
                policy_json,
                input.now_ms,
            ],
        )?;

        for sid in &input.source_ids {
            tx.execute(
                "INSERT OR IGNORE INTO radar_sources (radar_id, source_id) VALUES (?1, ?2)",
                params![radar_id, sid],
            )?;
        }

        let loaded =
            load_radar_with_version_conn(&tx, &radar_id)?.ok_or_else(|| StoreError::NotFound {
                entity: "radar",
                id: radar_id,
            })?;
        tx.commit()?;
        Ok(loaded)
    }

    /// Update a radar (`02-radar-spec.md §2 & §4`):
    /// - Metadata-only edits (`name`, `notify`, `source_ids`) update `radars` / `radar_sources` in place.
    /// - Changes to `description`, `fields`, `match_policy`, or `user_profession` create a new
    ///   immutable `radar_versions` row.
    /// - When the radar is `active` and `activate_immediately == false`, the new version is stored
    ///   as a candidate preview version (`radars.current_version` stays on the active version until
    ///   `radar_confirm_version` is called).
    pub fn radar_update(
        &self,
        radar_id: &str,
        input: &UpdateRadarInput,
    ) -> Result<RadarUpdateResult, StoreError> {
        if let Some(fields) = &input.fields {
            validate_field_defs(fields)?;
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let existing =
            load_radar_with_version_conn(&tx, radar_id)?.ok_or_else(|| StoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;

        let next_name = input
            .name
            .clone()
            .unwrap_or_else(|| existing.radar.name.clone());
        let next_notify = input
            .notify
            .clone()
            .unwrap_or_else(|| existing.radar.notify.clone());
        let notify_json = serde_json::to_string(&next_notify)?;

        tx.execute(
            "UPDATE radars SET name = ?1, notify = ?2, updated_at = ?3 WHERE id = ?4",
            params![next_name, notify_json, input.now_ms, radar_id],
        )?;

        if let Some(new_sources) = &input.source_ids {
            tx.execute(
                "DELETE FROM radar_sources WHERE radar_id = ?1",
                params![radar_id],
            )?;
            for sid in new_sources {
                tx.execute(
                    "INSERT OR IGNORE INTO radar_sources (radar_id, source_id) VALUES (?1, ?2)",
                    params![radar_id, sid],
                )?;
            }
        }

        let cur = &existing.current_version;
        let next_desc = input
            .description
            .clone()
            .unwrap_or_else(|| cur.description.clone());
        let next_lang = input
            .language_hint
            .clone()
            .unwrap_or_else(|| cur.language_hint.clone());
        let next_prof = input
            .user_profession
            .clone()
            .unwrap_or_else(|| cur.user_profession.clone());
        let next_fields = input.fields.clone().unwrap_or_else(|| cur.fields.clone());
        let next_policy = input
            .match_policy
            .clone()
            .unwrap_or_else(|| cur.match_policy.clone());

        let definition_changed = next_desc != cur.description
            || next_fields != cur.fields
            || next_policy != cur.match_policy
            || next_prof != cur.user_profession
            || next_lang != cur.language_hint;

        let mut version_created = None;
        let mut pending_confirmation = false;

        if definition_changed {
            let max_ver: i32 = tx.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM radar_versions WHERE radar_id = ?1",
                params![radar_id],
                |r| r.get(0),
            )?;
            let new_ver_num = max_ver + 1;
            let new_ver_id = new_ulid();
            let fields_json = serde_json::to_string(&next_fields)?;
            let policy_json = serde_json::to_string(&next_policy)?;

            tx.execute(
                "INSERT INTO radar_versions (
                   id, radar_id, version, description, language_hint, user_profession,
                   fields, match_policy, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_ver_id,
                    radar_id,
                    new_ver_num,
                    next_desc,
                    next_lang,
                    next_prof,
                    fields_json,
                    policy_json,
                    input.now_ms,
                ],
            )?;

            let created_ver = tx.query_row(
                "SELECT * FROM radar_versions WHERE id = ?1",
                params![new_ver_id],
                map_radar_version_row,
            )?;

            if existing.radar.status == "active" && !input.activate_immediately {
                pending_confirmation = true;
            } else {
                activate_radar_version_tx(&tx, radar_id, new_ver_num, input.now_ms)?;
            }

            version_created = Some(created_ver);
        }

        let updated =
            load_radar_with_version_conn(&tx, radar_id)?.ok_or_else(|| StoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        tx.commit()?;

        Ok(RadarUpdateResult {
            radar: updated,
            version_created,
            pending_confirmation,
        })
    }

    /// Persist an immutable preview definition without changing live metadata, sources or version.
    pub fn radar_preview_snapshot(
        &self,
        definition: &RadarVersionRecord,
    ) -> Result<RadarVersionRecord, StoreError> {
        validate_field_defs(&definition.fields)?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;
        let existing =
            load_radar_with_version_conn(&tx, &definition.radar_id)?.ok_or_else(|| {
                StoreError::NotFound {
                    entity: "radar",
                    id: definition.radar_id.clone(),
                }
            })?;
        for version in
            std::iter::once(&existing.current_version).chain(existing.candidate_version.iter())
        {
            if version.description == definition.description
                && version.fields == definition.fields
                && version.match_policy == definition.match_policy
                && version.user_profession == definition.user_profession
            {
                return Ok(version.clone());
            }
        }
        let mut snapshot = definition.clone();
        snapshot.id = new_ulid();
        snapshot.version = tx.query_row(
            "SELECT MAX(version)+1 FROM radar_versions WHERE radar_id=?1",
            params![definition.radar_id],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO radar_versions(id,radar_id,version,description,language_hint,user_profession,fields,match_policy,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![snapshot.id,snapshot.radar_id,snapshot.version,snapshot.description,snapshot.language_hint,snapshot.user_profession,serde_json::to_string(&snapshot.fields)?,serde_json::to_string(&snapshot.match_policy)?,snapshot.created_at])?;
        tx.commit()?;
        Ok(snapshot)
    }

    /// Confirm and activate a candidate `radar_versions` version on an active radar,
    /// retiring rulesets of older versions and cleaning up preview evaluations.
    pub fn radar_confirm_version(
        &self,
        radar_id: &str,
        version: i32,
        now_ms: i64,
    ) -> Result<RadarWithVersion, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let exists: bool = tx.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM radar_versions WHERE radar_id = ?1 AND version = ?2
             )",
            params![radar_id, version],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound {
                entity: "radar_version",
                id: format!("{radar_id}@v{version}"),
            });
        }

        activate_radar_version_tx(&tx, radar_id, version, now_ms)?;

        let loaded =
            load_radar_with_version_conn(&tx, radar_id)?.ok_or_else(|| StoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        tx.commit()?;
        Ok(loaded)
    }

    /// Set radar lifecycle status (`draft | active | paused | archived`).
    /// Activating a radar automatically removes preview evaluations (`05-pipeline-rules.md §10`).
    pub fn radar_set_status(
        &self,
        radar_id: &str,
        status: &str,
        now_ms: i64,
    ) -> Result<RadarRecord, StoreError> {
        if !matches!(status, "draft" | "active" | "paused" | "archived") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid radar status '{status}'"
            )));
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let changed = tx.execute(
            "UPDATE radars SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now_ms, radar_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            });
        }

        if status == "active" {
            tx.execute(
                "DELETE FROM evaluations
                 WHERE is_preview = 1
                   AND radar_version_id IN (SELECT id FROM radar_versions WHERE radar_id = ?1)",
                params![radar_id],
            )?;
        }

        let radar = tx.query_row(
            "SELECT * FROM radars WHERE id = ?1",
            params![radar_id],
            map_radar_row,
        )?;
        tx.commit()?;
        Ok(radar)
    }

    /// Fetch a radar with its current version, optional candidate preview version, and source IDs.
    pub fn radar_get(&self, radar_id: &str) -> Result<Option<RadarWithVersion>, StoreError> {
        let conn = self.lock_conn()?;
        load_radar_with_version_conn(&conn, radar_id)
    }

    /// Fetch a specific `RadarVersionRecord` by its ULID.
    pub fn radar_get_version(
        &self,
        radar_version_id: &str,
    ) -> Result<Option<RadarVersionRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM radar_versions WHERE id = ?1",
                params![radar_version_id],
                map_radar_version_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List radars with 24h lead count, total evaluated posts, and 7d false-positive rate.
    pub fn radar_list(
        &self,
        include_archived: bool,
        now_ms: i64,
    ) -> Result<Vec<RadarListItem>, StoreError> {
        let since_24h = now_ms.saturating_sub(86_400_000);
        let since_7d = now_ms.saturating_sub(7 * 86_400_000);
        let conn = self.lock_conn()?;

        let radar_ids: Vec<String> = if include_archived {
            let mut stmt =
                conn.prepare("SELECT id FROM radars ORDER BY updated_at DESC, created_at DESC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id FROM radars
                 WHERE status != 'archived'
                 ORDER BY updated_at DESC, created_at DESC",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut items = Vec::with_capacity(radar_ids.len());
        for rid in radar_ids {
            let Some(rw) = load_radar_with_version_conn(&conn, &rid)? else {
                continue;
            };

            let leads_24h: i64 = conn.query_row(
                "SELECT COUNT(*) FROM leads WHERE radar_id = ?1 AND created_at >= ?2",
                params![rid, since_24h],
                |r| r.get(0),
            )?;

            let evaluated_posts_total: i64 = conn.query_row(
                "SELECT COUNT(*)
                 FROM evaluations e
                 JOIN radar_versions rv ON rv.id = e.radar_version_id
                 WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.state = 'done'",
                params![rid],
                |r| r.get(0),
            )?;

            let (leads_7d, notified_7d): (i64, i64) = conn.query_row(
                "SELECT
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END), 0)
                 FROM leads
                 WHERE radar_id = ?1 AND created_at >= ?2",
                params![rid, since_7d],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;

            let fp_count_7d: i64 = conn.query_row(
                "SELECT COUNT(DISTINCT f.evaluation_id)
                 FROM feedback f
                 JOIN radar_versions rv ON rv.id = f.radar_version_id
                 WHERE rv.radar_id = ?1
                   AND f.created_at >= ?2
                   AND f.origin != 'preview'
                   AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')",
                params![rid, since_7d],
                |r| r.get(0),
            )?;

            let denom = if notified_7d > 0 {
                notified_7d
            } else {
                leads_7d
            };
            let false_positive_rate = if denom > 0 {
                ((fp_count_7d as f64) / (denom as f64)).clamp(0.0, 1.0)
            } else {
                0.0
            };

            items.push(RadarListItem {
                radar: rw.radar,
                current_version: rw.current_version,
                source_ids: rw.source_ids,
                leads_24h,
                evaluated_posts_total,
                false_positive_rate,
            });
        }

        Ok(items)
    }

    /// List `active` radars subscribed to `source_id`.
    pub fn list_active_radars_for_source(
        &self,
        source_id: &str,
    ) -> Result<Vec<RadarWithVersion>, StoreError> {
        let conn = self.lock_conn()?;
        let radar_ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT r.id
                 FROM radars r
                 JOIN radar_sources rs ON rs.radar_id = r.id
                 WHERE rs.source_id = ?1 AND r.status = 'active'
                 ORDER BY r.created_at ASC",
            )?;
            let rows = stmt.query_map(params![source_id], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut out = Vec::with_capacity(radar_ids.len());
        for rid in radar_ids {
            if let Some(rw) = load_radar_with_version_conn(&conn, &rid)? {
                out.push(rw);
            }
        }
        Ok(out)
    }

    /// Count active radars (for license check: max 2 on Cá nhân plan).
    pub fn count_active_radars(&self) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        let count = conn.query_row(
            "SELECT COUNT(*) FROM radars WHERE status = 'active'",
            [],
            |r| r.get(0),
        )?;
        Ok(count)
    }

    /// Compute 7-day pipeline funnel statistics (`05-pipeline-rules.md §11`).
    /// Pass `Some(radar_id)` for a single radar or `None` for global Health funnel stats.
    pub fn radar_stats(
        &self,
        radar_id: Option<&str>,
        now_ms: i64,
    ) -> Result<RadarFunnelStats, StoreError> {
        let since_7d = now_ms.saturating_sub(7 * 86_400_000);
        let conn = self.lock_conn()?;

        let (
            total_evaluated,
            dedup_rejected,
            prefilter_rejected,
            rule_decided,
            rule_matched,
            ai_decided,
            ai_matched,
            postfilter_rejected,
            pending_ai,
            ai_failed,
        ): (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) = if let Some(rid) = radar_id {
            conn.query_row(
                "SELECT
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'dedup' OR e.reject_reason = 'duplicate' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'prefilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'postfilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'pending_ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'ai_failed' THEN 1 ELSE 0 END), 0)
                 FROM evaluations e
                 JOIN radar_versions rv ON rv.id = e.radar_version_id
                 WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.created_at >= ?2",
                params![rid, since_7d],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )?
        } else {
            conn.query_row(
                "SELECT
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'dedup' OR e.reject_reason = 'duplicate' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'prefilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'postfilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'pending_ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'ai_failed' THEN 1 ELSE 0 END), 0)
                 FROM evaluations e
                 WHERE e.is_preview = 0 AND e.created_at >= ?1",
                params![since_7d],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )?
        };

        let (leads_total, leads_notified, leads_weak_match): (i64, i64, i64) = if let Some(rid) =
            radar_id
        {
            conn.query_row(
                    "SELECT
                       COUNT(*),
                       COALESCE(SUM(CASE WHEN l.notified_at IS NOT NULL THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE
                         WHEN l.score < COALESCE(CAST(json_extract(r.notify, '$.min_score') AS REAL), 0.6)
                         THEN 1 ELSE 0
                       END), 0)
                     FROM leads l
                     JOIN radars r ON r.id = l.radar_id
                     WHERE l.radar_id = ?1 AND l.created_at >= ?2",
                    params![rid, since_7d],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
        } else {
            conn.query_row(
                    "SELECT
                       COUNT(*),
                       COALESCE(SUM(CASE WHEN l.notified_at IS NOT NULL THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE
                         WHEN l.score < COALESCE(CAST(json_extract(r.notify, '$.min_score') AS REAL), 0.6)
                         THEN 1 ELSE 0
                       END), 0)
                     FROM leads l
                     JOIN radars r ON r.id = l.radar_id
                     WHERE l.created_at >= ?1",
                    params![since_7d],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
        };

        let false_positive_count: i64 = if let Some(rid) = radar_id {
            conn.query_row(
                "SELECT COUNT(DISTINCT f.evaluation_id)
                 FROM feedback f
                 JOIN radar_versions rv ON rv.id = f.radar_version_id
                 WHERE rv.radar_id = ?1
                   AND f.created_at >= ?2
                   AND f.origin != 'preview'
                   AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')",
                params![rid, since_7d],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(DISTINCT f.evaluation_id)
                 FROM feedback f
                 WHERE f.created_at >= ?1
                   AND f.origin != 'preview'
                   AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')",
                params![since_7d],
                |r| r.get(0),
            )?
        };

        let fp_denom = if leads_notified > 0 {
            leads_notified
        } else {
            leads_total
        };
        let false_positive_rate = if fp_denom > 0 {
            ((false_positive_count as f64) / (fp_denom as f64)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let rule_vs_ai_total = prefilter_rejected + rule_decided + ai_decided;
        let rule_handled_ratio = if rule_vs_ai_total > 0 {
            ((prefilter_rejected + rule_decided) as f64) / (rule_vs_ai_total as f64)
        } else {
            0.0
        };

        Ok(RadarFunnelStats {
            total_evaluated,
            dedup_rejected,
            prefilter_rejected,
            rule_decided,
            rule_matched,
            ai_decided,
            ai_matched,
            postfilter_rejected,
            pending_ai,
            ai_failed,
            leads_total,
            leads_notified,
            leads_weak_match,
            false_positive_count,
            false_positive_rate,
            rule_handled_ratio,
        })
    }

    // ========================================================================
    // Rulesets
    // ========================================================================

    /// Insert a new ruleset revision (`candidate | shadow | active | retired`).
    /// When `state == "active"`, automatically retires any previously active ruleset for `radar_version_id`.
    pub fn insert_ruleset(&self, input: &NewRulesetInput) -> Result<RulesetRecord, StoreError> {
        if !matches!(
            input.state.as_str(),
            "candidate" | "shadow" | "active" | "retired"
        ) {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset state '{}'",
                input.state
            )));
        }
        if !matches!(input.origin.as_str(), "seed" | "compiled" | "user") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset origin '{}'",
                input.origin
            )));
        }

        let id = input.id.clone().unwrap_or_else(new_ulid);
        let body_json = serde_json::to_string(&input.body)?;
        let metrics_json = input
            .metrics
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let next_rev: i32 = tx.query_row(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM rulesets WHERE radar_version_id = ?1",
            params![input.radar_version_id],
            |r| r.get(0),
        )?;

        if input.state == "active" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'active'",
                params![input.radar_version_id],
            )?;
        } else if input.state == "shadow" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'shadow'",
                params![input.radar_version_id],
            )?;
        }

        let activated_at = (input.state == "active").then_some(input.now_ms);

        tx.execute(
            "INSERT INTO rulesets (
               id, radar_version_id, revision, state, origin, body, metrics, created_at, activated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                input.radar_version_id,
                next_rev,
                input.state,
                input.origin,
                body_json,
                metrics_json,
                input.now_ms,
                activated_at,
            ],
        )?;

        let rec = tx.query_row(
            "SELECT * FROM rulesets WHERE id = ?1",
            params![id],
            map_ruleset_row,
        )?;
        tx.commit()?;
        Ok(rec)
    }

    /// Transition a ruleset's lifecycle state (`candidate | shadow | active | retired`),
    /// optionally recording gate/audit metrics.
    pub fn update_ruleset_state(
        &self,
        ruleset_id: &str,
        state: &str,
        metrics: Option<&serde_json::Value>,
        now_ms: i64,
    ) -> Result<RulesetRecord, StoreError> {
        if !matches!(state, "candidate" | "shadow" | "active" | "retired") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset state '{state}'"
            )));
        }
        let metrics_json = metrics.map(serde_json::to_string).transpose()?;

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let radar_version_id: String = tx
            .query_row(
                "SELECT radar_version_id FROM rulesets WHERE id = ?1",
                params![ruleset_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "ruleset",
                id: ruleset_id.to_string(),
            })?;

        if state == "active" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'active' AND id != ?2",
                params![radar_version_id, ruleset_id],
            )?;
            tx.execute(
                "UPDATE rulesets
                 SET state = 'active',
                     metrics = COALESCE(?1, metrics),
                     activated_at = COALESCE(activated_at, ?2)
                 WHERE id = ?3",
                params![metrics_json, now_ms, ruleset_id],
            )?;
        } else {
            if state == "shadow" {
                tx.execute(
                    "UPDATE rulesets SET state = 'retired'
                     WHERE radar_version_id = ?1 AND state = 'shadow' AND id != ?2",
                    params![radar_version_id, ruleset_id],
                )?;
            }
            tx.execute(
                "UPDATE rulesets
                 SET state = ?1,
                     metrics = COALESCE(?2, metrics)
                 WHERE id = ?3",
                params![state, metrics_json, ruleset_id],
            )?;
        }

        let rec = tx.query_row(
            "SELECT * FROM rulesets WHERE id = ?1",
            params![ruleset_id],
            map_ruleset_row,
        )?;
        tx.commit()?;
        Ok(rec)
    }

    /// Get the currently `active` ruleset for `radar_version_id`.
    pub fn get_active_ruleset(
        &self,
        radar_version_id: &str,
    ) -> Result<Option<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM rulesets
                 WHERE radar_version_id = ?1 AND state = 'active'
                 ORDER BY revision DESC
                 LIMIT 1",
                params![radar_version_id],
                map_ruleset_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// Get the currently `shadow` ruleset for `radar_version_id`.
    pub fn get_shadow_ruleset(
        &self,
        radar_version_id: &str,
    ) -> Result<Option<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM rulesets
                 WHERE radar_version_id = ?1 AND state = 'shadow'
                 ORDER BY revision DESC
                 LIMIT 1",
                params![radar_version_id],
                map_ruleset_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List all rulesets for `radar_version_id` ordered by `revision DESC`.
    pub fn list_rulesets(&self, radar_version_id: &str) -> Result<Vec<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT * FROM rulesets WHERE radar_version_id = ?1 ORDER BY revision DESC")?;
        let rows = stmt
            .query_map(params![radar_version_id], map_ruleset_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn activate_radar_version_tx(
    conn: &Connection,
    radar_id: &str,
    version: i32,
    now_ms: i64,
) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE radars SET current_version = ?1, updated_at = ?2 WHERE id = ?3",
        params![version, now_ms, radar_id],
    )?;

    // Retire active/shadow rulesets belonging to superseded versions of this radar (05-pipeline-rules.md §6.4).
    conn.execute(
        "UPDATE rulesets
         SET state = 'retired'
         WHERE state IN ('active', 'shadow')
           AND radar_version_id IN (
             SELECT id FROM radar_versions WHERE radar_id = ?1 AND version != ?2
           )",
        params![radar_id, version],
    )?;

    // Remove preview evaluations once version is confirmed/active (05-pipeline-rules.md §10).
    conn.execute(
        "DELETE FROM evaluations
         WHERE is_preview = 1
           AND radar_version_id IN (SELECT id FROM radar_versions WHERE radar_id = ?1)",
        params![radar_id],
    )?;

    Ok(())
}
