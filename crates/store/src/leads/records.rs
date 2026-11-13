//! Lead creation, lookup, status/field/CRM updates, and follow-ups.

use super::*;

impl Store {
    // ========================================================================
    // Leads
    // ========================================================================

    /// Create a lead idempotently on `(radar_id, post_id)`.
    /// Automatically populates `also_seen_in` from the post's `dup_cluster` if `input.also_seen_in`
    /// is `None`, and appends a `lead_events(kind = 'created')` entry.
    pub fn create_lead(&self, input: &CreateLeadInput) -> Result<(LeadRecord, bool), StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        if let Some(existing) = tx
            .query_row(
                "SELECT * FROM leads WHERE radar_id = ?1 AND post_id = ?2",
                params![input.radar_id, input.post_id],
                map_lead_row,
            )
            .optional()?
        {
            return Ok((existing, false));
        }

        let lead_id = input.id.clone().unwrap_or_else(new_ulid);
        let fields_json = serde_json::to_string(&input.fields)?;

        let also_entries = if let Some(explicit) = &input.also_seen_in {
            explicit.clone()
        } else {
            collect_cluster_also_seen_tx(&tx, &input.post_id)?
        };
        let also_json = if also_entries.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&also_entries)?)
        };

        let tags_json = input
            .tags
            .as_ref()
            .filter(|t| !t.is_empty())
            .map(serde_json::to_string)
            .transpose()?;

        tx.execute(
            "INSERT INTO leads (
               id, radar_id, radar_version_id, post_id, evaluation_id, contact_id,
               status, score, summary, fields, also_seen_in,
               notified_at, follow_up_at, note, tags, created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6,
               ?7, ?8, ?9, ?10, ?11,
               ?12, ?13, ?14, ?15, ?16, ?16
             )",
            params![
                lead_id,
                input.radar_id,
                input.radar_version_id,
                input.post_id,
                input.evaluation_id,
                input.contact_id,
                input.status,
                input.score,
                input.summary,
                fields_json,
                also_json,
                input.notified_at,
                input.follow_up_at,
                input.note,
                tags_json,
                input.now_ms,
            ],
        )?;

        let event_data = serde_json::to_string(&serde_json::json!({ "score": input.score }))?;
        tx.execute(
            "INSERT INTO lead_events (id, lead_id, kind, data, created_at)
             VALUES (?1, ?2, 'created', ?3, ?4)",
            params![new_ulid(), lead_id, event_data, input.now_ms],
        )?;

        let created = tx.query_row(
            "SELECT * FROM leads WHERE id = ?1",
            params![lead_id],
            map_lead_row,
        )?;
        tx.commit()?;
        Ok((created, true))
    }

    /// Fetch full lead detail joined with radar, source, author, post, evaluation provenance,
    /// and chronological `lead_events`.
    pub fn lead_get(&self, lead_id: &str) -> Result<Option<LeadDetail>, StoreError> {
        let conn = self.lock_conn()?;

        let detail_opt = conn
            .query_row(
                "SELECT
                   l.*,
                   r.name AS radar_name,
                   p.source_id,
                   s.name AS source_name,
                   p.author_id,
                   a.name AS author_name,
                   p.text AS post_text,
                   p.text_norm AS post_text_norm,
                   p.permalink,
                   p.created_at AS post_created_at,
                   p.captured_at AS post_captured_at,
                   e.id AS eval_id,
                   rv.version AS eval_radar_version,
                   e.decided_by AS eval_decided_by,
                   e.verdict AS eval_verdict,
                   e.score AS eval_score,
                   e.intent AS eval_intent,
                   e.author_role AS eval_author_role,
                   e.reason AS eval_reason,
                   e.ruleset_id AS eval_ruleset_id,
                   e.ai_call_id AS eval_ai_call_id
                 FROM leads l
                 JOIN radars r ON r.id = l.radar_id
                 JOIN radar_versions rv ON rv.id = l.radar_version_id
                 JOIN posts p ON p.id = l.post_id
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN authors a ON a.id = p.author_id
                 JOIN evaluations e ON e.id = l.evaluation_id
                 WHERE l.id = ?1",
                params![lead_id],
                |row| {
                    let lead = map_lead_row(row)?;
                    let evaluation = LeadEvaluationInfo {
                        id: row.get("eval_id")?,
                        radar_version: row.get("eval_radar_version")?,
                        decided_by: row.get("eval_decided_by")?,
                        verdict: row.get("eval_verdict")?,
                        score: row.get("eval_score")?,
                        intent: row.get("eval_intent")?,
                        author_role: row.get("eval_author_role")?,
                        reason: row.get("eval_reason")?,
                        ruleset_id: row.get("eval_ruleset_id")?,
                        ai_call_id: row.get("eval_ai_call_id")?,
                    };
                    Ok((
                        lead,
                        row.get::<_, String>("radar_name")?,
                        row.get::<_, String>("source_id")?,
                        row.get::<_, String>("source_name")?,
                        row.get::<_, Option<String>>("author_id")?,
                        row.get::<_, Option<String>>("author_name")?,
                        row.get::<_, Option<String>>("post_text")?,
                        row.get::<_, Option<String>>("post_text_norm")?,
                        row.get::<_, String>("permalink")?,
                        row.get::<_, Option<i64>>("post_created_at")?,
                        row.get::<_, i64>("post_captured_at")?,
                        evaluation,
                    ))
                },
            )
            .optional()?;

        let Some((
            lead,
            radar_name,
            source_id,
            source_name,
            author_id,
            author_name,
            post_text,
            post_text_norm,
            permalink,
            post_created_at,
            post_captured_at,
            evaluation,
        )) = detail_opt
        else {
            return Ok(None);
        };

        let events = {
            let mut stmt = conn.prepare(
                "SELECT id, lead_id, kind, data, created_at
                 FROM lead_events
                 WHERE lead_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )?;
            let rows = stmt.query_map(params![lead_id], |row| {
                let data_raw: Option<String> = row.get(3)?;
                let data = data_raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());
                Ok(LeadEventRecord {
                    id: row.get(0)?,
                    lead_id: row.get(1)?,
                    kind: row.get(2)?,
                    data,
                    created_at: row.get(4)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        Ok(Some(LeadDetail {
            lead,
            radar_name,
            source_id,
            source_name,
            author_id,
            author_name,
            post_text,
            post_text_norm,
            permalink,
            post_created_at,
            post_captured_at,
            evaluation,
            events,
        }))
    }

    /// Update CRM status of a lead (`new | viewed | contacted | negotiating | won | lost | ignored`)
    /// and append a `status_changed` event.
    pub fn lead_set_status(
        &self,
        lead_id: &str,
        status: &str,
        now_ms: i64,
    ) -> Result<LeadRecord, StoreError> {
        if !matches!(
            status,
            "new" | "viewed" | "contacted" | "negotiating" | "won" | "lost" | "ignored"
        ) {
            return Err(StoreError::InvalidArgument(format!(
                "invalid lead status '{status}'"
            )));
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let old_status: String = tx
            .query_row(
                "SELECT status FROM leads WHERE id = ?1",
                params![lead_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "lead",
                id: lead_id.to_string(),
            })?;

        tx.execute(
            "UPDATE leads SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now_ms, lead_id],
        )?;

        let data = serde_json::to_string(&serde_json::json!({
            "from": old_status,
            "to": status,
        }))?;
        tx.execute(
            "INSERT INTO lead_events (id, lead_id, kind, data, created_at)
             VALUES (?1, ?2, 'status_changed', ?3, ?4)",
            params![new_ulid(), lead_id, data, now_ms],
        )?;

        let updated = tx.query_row(
            "SELECT * FROM leads WHERE id = ?1",
            params![lead_id],
            map_lead_row,
        )?;
        tx.commit()?;
        Ok(updated)
    }

    /// Update a single extracted field on a lead with `source = "user"` (`03-ux-flows.md §3.1`)
    /// after validating `field_key` against the lead's radar version field definitions.
    pub fn lead_update_field(
        &self,
        lead_id: &str,
        field_key: &str,
        new_value: serde_json::Value,
        raw: Option<String>,
        now_ms: i64,
    ) -> Result<LeadRecord, StoreError> {
        if !is_valid_field_key(field_key) {
            return Err(StoreError::InvalidFieldKey(field_key.to_string()));
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let lead = tx
            .query_row(
                "SELECT * FROM leads WHERE id = ?1",
                params![lead_id],
                map_lead_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "lead",
                id: lead_id.to_string(),
            })?;

        let version_fields_raw: String = tx.query_row(
            "SELECT fields FROM radar_versions WHERE id = ?1",
            params![lead.radar_version_id],
            |r| r.get(0),
        )?;
        let version_fields: Vec<FieldDef> = serde_json::from_str(&version_fields_raw)?;
        if !version_fields.iter().any(|f| f.key == field_key) {
            return Err(StoreError::UnknownRadarField {
                radar_id: Some(lead.radar_id.clone()),
                field: field_key.to_string(),
            });
        }

        let definition = version_fields
            .iter()
            .find(|f| f.key == field_key)
            .expect("checked field");
        crate::field_values::validate_field_value(definition, &new_value)?;
        let mut fields_map = lead.fields.clone();
        let old_entry = fields_map.get(field_key).cloned();
        let preserved_raw = raw.or_else(|| old_entry.as_ref().and_then(|e| e.raw.clone()));

        fields_map.insert(
            field_key.to_string(),
            ExtractedField {
                value: new_value.clone(),
                raw: preserved_raw,
                confidence: 1.0,
                source: FieldSource::User,
            },
        );

        let fields_json = serde_json::to_string(&fields_map)?;
        tx.execute(
            "UPDATE leads SET fields = ?1, updated_at = ?2 WHERE id = ?3",
            params![fields_json, now_ms, lead_id],
        )?;

        let event_data = serde_json::to_string(&serde_json::json!({
            "field": field_key,
            "old": old_entry.map(|e| e.value),
            "new": new_value,
        }))?;
        tx.execute(
            "INSERT INTO lead_events (id, lead_id, kind, data, created_at)
             VALUES (?1, ?2, 'field_edited', ?3, ?4)",
            params![new_ulid(), lead_id, event_data, now_ms],
        )?;

        let updated = tx.query_row(
            "SELECT * FROM leads WHERE id = ?1",
            params![lead_id],
            map_lead_row,
        )?;
        tx.commit()?;
        Ok(updated)
    }

    /// Update CRM note, tags, and follow-up reminder timestamp on a lead, appending a `noted` event.
    pub fn lead_set_note_tags_followup(
        &self,
        lead_id: &str,
        note: Option<String>,
        tags: Option<Vec<String>>,
        follow_up_at: Option<i64>,
        now_ms: i64,
    ) -> Result<LeadRecord, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leads WHERE id = ?1)",
            params![lead_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound {
                entity: "lead",
                id: lead_id.to_string(),
            });
        }

        let tags_json = tags
            .as_ref()
            .filter(|t| !t.is_empty())
            .map(serde_json::to_string)
            .transpose()?;

        tx.execute(
            "UPDATE leads
             SET note = ?1,
                 tags = ?2,
                 follow_up_at = ?3,
                 updated_at = ?4
             WHERE id = ?5",
            params![note, tags_json, follow_up_at, now_ms, lead_id],
        )?;

        let event_data = serde_json::to_string(&serde_json::json!({
            "note": note,
            "tags": tags,
            "follow_up_at": follow_up_at,
        }))?;
        tx.execute(
            "INSERT INTO lead_events (id, lead_id, kind, data, created_at)
             VALUES (?1, ?2, 'noted', ?3, ?4)",
            params![new_ulid(), lead_id, event_data, now_ms],
        )?;

        let updated = tx.query_row(
            "SELECT * FROM leads WHERE id = ?1",
            params![lead_id],
            map_lead_row,
        )?;
        tx.commit()?;
        Ok(updated)
    }

    /// Read state is independent of CRM stage.
    pub fn lead_mark_read(&self, id: &str, now: i64) -> Result<(), StoreError> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE leads SET read_at=COALESCE(read_at,?1) WHERE id=?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Claim due local reminders once per scheduled time. Overdue reminders survive restarts.
    pub fn claim_due_followups(&self, now: i64) -> Result<Vec<String>, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;
        let ids: Vec<(String, i64)> = {
            let mut stmt=tx.prepare("SELECT id,follow_up_at FROM leads l WHERE follow_up_at<=?1 AND status NOT IN ('won','lost','ignored') AND NOT EXISTS(SELECT 1 FROM follow_up_deliveries d WHERE d.lead_id=l.id AND d.due_at=l.follow_up_at) ORDER BY follow_up_at LIMIT 50")?;
            let rows = stmt.query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, due) in &ids {
            tx.execute("INSERT INTO follow_up_deliveries(lead_id,due_at,delivered_at) VALUES (?1,?2,?3) ON CONFLICT(lead_id) DO UPDATE SET due_at=excluded.due_at,delivered_at=excluded.delivered_at", params![id,due,now])?;
            tx.execute("INSERT INTO lead_events(id,lead_id,kind,data,created_at) VALUES(?1,?2,'follow_up_due',?3,?4)",params![new_ulid(),id,serde_json::json!({"due_at":due}).to_string(),now])?;
        }
        tx.commit()?;
        Ok(ids.into_iter().map(|(id, _)| id).collect())
    }

    /// Link a lead to a `contact_id`.
    pub fn lead_set_contact_id(
        &self,
        lead_id: &str,
        contact_id: Option<&str>,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE leads SET contact_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![contact_id, now_ms, lead_id],
        )?;
        Ok(changed > 0)
    }

    /// Count leads generated for `radar_id` in the last 60 minutes (`> 30/hr` flood guard per `07-notifications-export.md §3`).
    pub fn count_leads_in_last_hour(&self, radar_id: &str, now_ms: i64) -> Result<i64, StoreError> {
        let since_1h = now_ms.saturating_sub(3_600_000);
        let conn = self.lock_conn()?;
        let count = conn.query_row(
            "SELECT COUNT(*) FROM leads WHERE radar_id = ?1 AND created_at >= ?2",
            params![radar_id, since_1h],
            |r| r.get(0),
        )?;
        Ok(count)
    }
}

pub(super) fn collect_cluster_also_seen_tx(
    conn: &Connection,
    post_id: &str,
) -> Result<Vec<AlsoSeenInEntry>, StoreError> {
    let post_meta: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT source_id, dup_cluster_id FROM posts WHERE id = ?1",
            params![post_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((lead_source_id, Some(cluster_id))) = post_meta else {
        return Ok(Vec::new());
    };

    let mut stmt = conn.prepare(
        "SELECT p.id, p.source_id, s.name AS source_name, p.permalink, p.captured_at
         FROM posts p
         JOIN sources s ON s.id = p.source_id
         WHERE p.dup_cluster_id = ?1 AND p.source_id != ?2
         ORDER BY p.captured_at ASC",
    )?;
    let rows = stmt.query_map(params![cluster_id, lead_source_id], |r| {
        Ok(AlsoSeenInEntry {
            post_id: r.get(0)?,
            source_id: r.get(1)?,
            source_name: r.get(2)?,
            permalink: r.get(3)?,
            captured_at: r.get(4)?,
        })
    })?;

    let mut seen_sources = BTreeSet::new();
    let mut entries = Vec::new();
    for item in rows {
        let entry = item?;
        if seen_sources.insert(entry.source_id.clone()) {
            entries.push(entry);
        }
    }
    Ok(entries)
}
