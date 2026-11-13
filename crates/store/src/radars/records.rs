//! Radar drafts, updates, versions, status, and listing.

use super::*;

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
}

pub(super) fn activate_radar_version_tx(
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
