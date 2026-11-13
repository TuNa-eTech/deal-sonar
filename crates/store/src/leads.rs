use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
};

use crate::models::{
    build_fts5_query, is_valid_field_key, new_ulid, AlsoSeenInEntry, CreateLeadInput,
    EvaluationDoneInput, EvaluationRecord, EvaluationUpsertInput, ExtractedField, FeedbackRecord,
    FieldDef, FieldSource, FieldType, FilterOp, LabeledSample, LabeledSampleOrigin, LeadDetail,
    LeadEvaluationInfo, LeadEventRecord, LeadFieldFilter, LeadListItem, LeadListPage,
    LeadListQuery, LeadRecord, PendingAiEvaluationItem, PendingAiGroup, RecordFeedbackInput,
    SortDir,
};
use crate::posts::map_post_row;
use crate::{Store, StoreError};

fn map_evaluation_row(row: &Row<'_>) -> rusqlite::Result<EvaluationRecord> {
    let fields_raw: Option<String> = row.get("fields")?;
    let fields: Option<BTreeMap<String, ExtractedField>> = fields_raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;

    Ok(EvaluationRecord {
        id: row.get("id")?,
        post_id: row.get("post_id")?,
        radar_version_id: row.get("radar_version_id")?,
        state: row.get("state")?,
        decided_by: row.get("decided_by")?,
        verdict: row.get("verdict")?,
        reject_reason: row.get("reject_reason")?,
        score: row.get("score")?,
        intent: row.get("intent")?,
        author_role: row.get("author_role")?,
        summary: row.get("summary")?,
        reason: row.get("reason")?,
        fields,
        ruleset_id: row.get("ruleset_id")?,
        ai_call_id: row.get("ai_call_id")?,
        is_preview: row.get::<_, i64>("is_preview")? != 0,
        created_at: row.get("created_at")?,
        decided_at: row.get("decided_at")?,
    })
}

pub(crate) fn map_lead_row(row: &Row<'_>) -> rusqlite::Result<LeadRecord> {
    let fields_raw: String = row.get("fields")?;
    let fields: BTreeMap<String, ExtractedField> =
        serde_json::from_str(&fields_raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    let also_raw: Option<String> = row.get("also_seen_in")?;
    let also_seen_in: Vec<AlsoSeenInEntry> = also_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let tags_raw: Option<String> = row.get("tags")?;
    let tags: Vec<String> = tags_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    Ok(LeadRecord {
        id: row.get("id")?,
        radar_id: row.get("radar_id")?,
        radar_version_id: row.get("radar_version_id")?,
        post_id: row.get("post_id")?,
        evaluation_id: row.get("evaluation_id")?,
        contact_id: row.get("contact_id")?,
        status: row.get("status")?,
        read_at: row.get("read_at")?,
        score: row.get("score")?,
        summary: row.get("summary")?,
        fields,
        also_seen_in,
        notified_at: row.get("notified_at")?,
        follow_up_at: row.get("follow_up_at")?,
        note: row.get("note")?,
        tags,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn map_lead_list_item_row(row: &Row<'_>) -> rusqlite::Result<LeadListItem> {
    Ok(LeadListItem {
        lead: map_lead_row(row)?,
        radar_name: row.get("radar_name")?,
        source_id: row.get("source_id")?,
        source_name: row.get("source_name")?,
        author_id: row.get("author_id")?,
        author_name: row.get("author_name")?,
        permalink: row.get("permalink")?,
        post_created_at: row.get("post_created_at")?,
        post_text: row.get("post_text")?,
    })
}

fn map_feedback_row(row: &Row<'_>) -> rusqlite::Result<FeedbackRecord> {
    let cf_raw: Option<String> = row.get("corrected_fields")?;
    let corrected_fields: Option<BTreeMap<String, ExtractedField>> = cf_raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    Ok(FeedbackRecord {
        expected_match: row.get("expected_match")?,
        id: row.get("id")?,
        evaluation_id: row.get("evaluation_id")?,
        radar_version_id: row.get("radar_version_id")?,
        post_id: row.get("post_id")?,
        label: row.get("label")?,
        corrected_fields,
        post_text: row.get("post_text")?,
        origin: row.get("origin")?,
        created_at: row.get("created_at")?,
    })
}

impl Store {
    // ========================================================================
    // Evaluations
    // ========================================================================

    /// Upsert an evaluation row on `(post_id, radar_version_id, is_preview)`.
    pub fn upsert_evaluation(
        &self,
        input: &EvaluationUpsertInput,
    ) -> Result<EvaluationRecord, StoreError> {
        if !matches!(input.state.as_str(), "pending_ai" | "done" | "ai_failed") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid evaluation state '{}'",
                input.state
            )));
        }

        let id = input.id.clone().unwrap_or_else(new_ulid);
        let fields_json = input
            .fields
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let is_preview_int = i64::from(input.is_preview);

        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO evaluations (
               id, post_id, radar_version_id, state, decided_by, verdict, reject_reason,
               score, intent, author_role, summary, reason, fields,
               ruleset_id, ai_call_id, is_preview, created_at, decided_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7,
               ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18
             )
             ON CONFLICT(post_id, radar_version_id, is_preview) DO UPDATE SET
               state = excluded.state,
               decided_by = excluded.decided_by,
               verdict = excluded.verdict,
               reject_reason = excluded.reject_reason,
               score = excluded.score,
               intent = excluded.intent,
               author_role = excluded.author_role,
               summary = excluded.summary,
               reason = excluded.reason,
               fields = COALESCE(excluded.fields, evaluations.fields),
               ruleset_id = COALESCE(excluded.ruleset_id, evaluations.ruleset_id),
               ai_call_id = COALESCE(excluded.ai_call_id, evaluations.ai_call_id),
               decided_at = excluded.decided_at",
            params![
                id,
                input.post_id,
                input.radar_version_id,
                input.state,
                input.decided_by,
                input.verdict,
                input.reject_reason,
                input.score,
                input.intent,
                input.author_role,
                input.summary,
                input.reason,
                fields_json,
                input.ruleset_id,
                input.ai_call_id,
                is_preview_int,
                input.created_at,
                input.decided_at,
            ],
        )?;

        let rec = conn.query_row(
            "SELECT * FROM evaluations
             WHERE post_id = ?1 AND radar_version_id = ?2 AND is_preview = ?3",
            params![input.post_id, input.radar_version_id, is_preview_int],
            map_evaluation_row,
        )?;
        Ok(rec)
    }

    /// Fetch an evaluation by ID.
    pub fn get_evaluation(
        &self,
        evaluation_id: &str,
    ) -> Result<Option<EvaluationRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM evaluations WHERE id = ?1",
                params![evaluation_id],
                map_evaluation_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List `pending_ai` evaluations grouped by `(radar_version_id, is_preview)` with
    /// `oldest_created_at` so the batch scheduler can trigger at `>= 20` items (`10` for preview)
    /// or `>= 45s` wait threshold (`05-pipeline-rules.md §7`).
    pub fn list_pending_ai_batches(&self) -> Result<Vec<PendingAiGroup>, StoreError> {
        let conn = self.lock_conn()?;
        let group_keys: Vec<(String, i64, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT radar_version_id, is_preview, MIN(created_at) AS oldest_created_at
                 FROM evaluations
                 WHERE state = 'pending_ai'
                 GROUP BY radar_version_id, is_preview
                 ORDER BY oldest_created_at ASC",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut groups = Vec::with_capacity(group_keys.len());
        for (rvid, is_preview_int, oldest_created_at) in group_keys {
            let items = list_pending_ai_items_conn(&conn, &rvid, is_preview_int != 0, 500)?;
            let count = items.len();
            groups.push(PendingAiGroup {
                radar_version_id: rvid,
                is_preview: is_preview_int != 0,
                count,
                oldest_created_at,
                items,
            });
        }
        Ok(groups)
    }

    /// Fetch up to `limit` `pending_ai` evaluations for a specific `(radar_version_id, is_preview)`.
    pub fn list_pending_ai_for_version(
        &self,
        radar_version_id: &str,
        is_preview: bool,
        limit: usize,
    ) -> Result<Vec<PendingAiEvaluationItem>, StoreError> {
        let conn = self.lock_conn()?;
        list_pending_ai_items_conn(&conn, radar_version_id, is_preview, limit)
    }

    /// Mark an evaluation `done` and store final verdict, extracted fields, and provenance.
    pub fn mark_evaluation_done(
        &self,
        evaluation_id: &str,
        update: &EvaluationDoneInput,
    ) -> Result<EvaluationRecord, StoreError> {
        let fields_json = update
            .fields
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE evaluations
             SET state = 'done',
                 decided_by = ?1,
                 verdict = ?2,
                 reject_reason = ?3,
                 score = ?4,
                 intent = ?5,
                 author_role = ?6,
                 summary = ?7,
                 reason = ?8,
                 fields = ?9,
                 ruleset_id = COALESCE(?10, ruleset_id),
                 ai_call_id = COALESCE(?11, ai_call_id),
                 decided_at = ?12
             WHERE id = ?13",
            params![
                update.decided_by,
                update.verdict,
                update.reject_reason,
                update.score,
                update.intent,
                update.author_role,
                update.summary,
                update.reason,
                fields_json,
                update.ruleset_id,
                update.ai_call_id,
                update.decided_at,
                evaluation_id,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "evaluation",
                id: evaluation_id.to_string(),
            });
        }
        let rec = conn.query_row(
            "SELECT * FROM evaluations WHERE id = ?1",
            params![evaluation_id],
            map_evaluation_row,
        )?;
        Ok(rec)
    }

    /// Mark an evaluation `ai_failed`.
    pub fn mark_evaluation_ai_failed(
        &self,
        evaluation_id: &str,
        ai_call_id: Option<&str>,
        reason: Option<&str>,
        decided_at: i64,
    ) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE evaluations
             SET state = 'ai_failed',
                 ai_call_id = COALESCE(?1, ai_call_id),
                 reason = COALESCE(?2, reason),
                 decided_at = ?3
             WHERE id = ?4",
            params![ai_call_id, reason, decided_at, evaluation_id],
        )?;
        Ok(changed > 0)
    }

    /// Re-queue `ai_failed` evaluations back to `pending_ai` once AI recovers (`03-desktop.md §3.1`).
    pub fn requeue_ai_failed_evaluations(&self) -> Result<usize, StoreError> {
        let conn = self.lock_conn()?;
        let count = conn.execute(
            "UPDATE evaluations SET state = 'pending_ai', decided_at = NULL WHERE state = 'ai_failed'",
            [],
        )?;
        Ok(count)
    }

    /// Clean up preview evaluations (`is_preview = 1`), optionally scoped to `radar_version_id`
    /// and/or `created_at < older_than_ms` (`05-pipeline-rules.md §10`).
    pub fn cleanup_preview_evaluations(
        &self,
        radar_version_id: Option<&str>,
        older_than_ms: Option<i64>,
    ) -> Result<usize, StoreError> {
        let conn = self.lock_conn()?;
        let deleted = match (radar_version_id, older_than_ms) {
            (Some(rvid), Some(cutoff)) => conn.execute(
                "DELETE FROM evaluations
                 WHERE is_preview = 1 AND radar_version_id = ?1 AND created_at < ?2",
                params![rvid, cutoff],
            )?,
            (Some(rvid), None) => conn.execute(
                "DELETE FROM evaluations WHERE is_preview = 1 AND radar_version_id = ?1",
                params![rvid],
            )?,
            (None, Some(cutoff)) => conn.execute(
                "DELETE FROM evaluations WHERE is_preview = 1 AND created_at < ?1",
                params![cutoff],
            )?,
            (None, None) => conn.execute("DELETE FROM evaluations WHERE is_preview = 1", [])?,
        };
        Ok(deleted)
    }

    /// List preview evaluations joined with post details for `radar_preview_get`.
    pub fn list_preview_evaluations(
        &self,
        radar_version_id: &str,
    ) -> Result<Vec<PendingAiEvaluationItem>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT
               e.id AS eval_id, e.post_id AS eval_post_id, e.radar_version_id AS eval_rvid,
               e.state AS eval_state, e.decided_by AS eval_decided_by, e.verdict AS eval_verdict,
               e.reject_reason AS eval_reject_reason, e.score AS eval_score, e.intent AS eval_intent,
               e.author_role AS eval_author_role, e.summary AS eval_summary, e.reason AS eval_reason,
               e.fields AS eval_fields, e.ruleset_id AS eval_ruleset_id, e.ai_call_id AS eval_ai_call_id,
               e.is_preview AS eval_is_preview, e.created_at AS eval_created_at, e.decided_at AS eval_decided_at,
               p.*, s.name AS source_name, a.name AS author_name
             FROM evaluations e
             JOIN posts p ON p.id = e.post_id
             JOIN sources s ON s.id = p.source_id
             LEFT JOIN authors a ON a.id = p.author_id
             WHERE e.radar_version_id = ?1 AND e.is_preview = 1
             ORDER BY COALESCE(e.score, 0.0) DESC, e.created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![radar_version_id], map_joined_eval_post_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

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

    // ========================================================================
    // Dynamic `lead_list` Query (`03-desktop.md §4`, `04-data-model.md §3`, `03-risks-compliance.md §4`)
    // ========================================================================

    /// Dynamic CRM lead query with strict whitelist validation against SQL injection,
    /// field-shape-aware JSON filtering, diacritic-insensitive FTS5 across `leads_fts` and `posts_fts`,
    /// dynamic sorting, and cursor pagination.
    pub fn lead_list(&self, query: &LeadListQuery) -> Result<LeadListPage, StoreError> {
        let conn = self.lock_conn()?;

        // 1. Load allowed dynamic field definitions for whitelist validation & shape awareness.
        let allowed_fields = load_allowed_field_map(&conn, query.radar_id.as_deref())?;

        // Validate every filter field key BEFORE building any SQL.
        for filter in &query.filters {
            if !is_valid_field_key(&filter.field) {
                return Err(StoreError::InvalidFieldKey(filter.field.clone()));
            }
            if !allowed_fields.contains_key(&filter.field) {
                return Err(StoreError::UnknownRadarField {
                    radar_id: query.radar_id.clone(),
                    field: filter.field.clone(),
                });
            }
        }

        let sort = query.sort.clone().unwrap_or_default();
        let dynamic_sort_field = match sort.by.as_str() {
            "created_at" | "updated_at" | "score" => None,
            field_key => {
                if !is_valid_field_key(field_key) {
                    return Err(StoreError::InvalidFieldKey(field_key.to_string()));
                }
                let Some(fdef) = allowed_fields.get(field_key) else {
                    return Err(StoreError::UnknownRadarField {
                        radar_id: query.radar_id.clone(),
                        field: field_key.to_string(),
                    });
                };
                Some(fdef.clone())
            }
        };

        let mut sql_params: Vec<SqlValue> = Vec::new();
        let mut where_clauses: Vec<String> = Vec::new();

        if let Some(rid) = &query.radar_id {
            let p = push_param(&mut sql_params, SqlValue::Text(rid.clone()));
            where_clauses.push(format!("l.radar_id = {p}"));
        }

        if query.unread_only == Some(true) {
            where_clauses.push("l.read_at IS NULL".into());
        }
        if let Some(due) = query.follow_up_before {
            let p = push_param(&mut sql_params, SqlValue::Integer(due));
            where_clauses.push(format!(
                "l.follow_up_at <= {p} AND l.status NOT IN ('won','lost','ignored')"
            ));
        }
        if query.exclude_weak == Some(true) {
            where_clauses
                .push("l.score >= COALESCE(json_extract(r.notify, '$.min_score'), 0.6)".into());
        }
        if let Some(statuses) = &query.status {
            if !statuses.is_empty() {
                let mut ph = Vec::with_capacity(statuses.len());
                for st in statuses {
                    ph.push(push_param(&mut sql_params, SqlValue::Text(st.clone())));
                }
                where_clauses.push(format!("l.status IN ({})", ph.join(", ")));
            }
        }

        if let Some(since) = query.since {
            let p = push_param(&mut sql_params, SqlValue::Integer(since));
            where_clauses.push(format!("l.created_at >= {p}"));
        }

        if let Some(min_score) = query.min_score {
            let p = push_param(&mut sql_params, SqlValue::Real(min_score));
            where_clauses.push(format!("l.score >= {p}"));
        }

        if let Some(search_raw) = &query.search {
            if !search_raw.trim().is_empty() {
                if let Some(fts_q) = build_fts5_query(search_raw) {
                    let p1 = push_param(&mut sql_params, SqlValue::Text(fts_q.clone()));
                    let p2 = push_param(&mut sql_params, SqlValue::Text(fts_q));
                    where_clauses.push(format!(
                        "(l.rowid IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH {p1}) \
                          OR p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH {p2}))"
                    ));
                } else {
                    // Non-alphanumeric-only query matches nothing.
                    where_clauses.push("0 = 1".to_string());
                }
            }
        }

        // Dynamic field filters: every path & value bound via `sql_params`.
        for filter in &query.filters {
            let fdef = allowed_fields
                .get(&filter.field)
                .expect("validated against allowed_fields");
            let clause = build_dynamic_filter_clause(fdef, filter, &mut sql_params)?;
            where_clauses.push(clause);
        }

        let offset = parse_cursor_offset(query.cursor.as_deref())?;
        let limit = query.limit.clamp(1, 500);
        let fetch_limit = (limit + 1) as i64;

        let dir_sql = match sort.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };

        let filter_param_count = sql_params.len();
        let order_sql = if let Some(fdef) = &dynamic_sort_field {
            let expr = build_dynamic_sort_expr(fdef, &mut sql_params);
            format!(
                "CASE WHEN {expr} IS NULL THEN 1 ELSE 0 END ASC, {expr} {dir_sql}, l.created_at DESC, l.id DESC"
            )
        } else {
            let col = match sort.by.as_str() {
                "updated_at" => "l.updated_at",
                "score" => "l.score",
                _ => "l.created_at",
            };
            format!("{col} {dir_sql}, l.id {dir_sql}")
        };

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM leads l JOIN radars r ON r.id=l.radar_id JOIN posts p ON p.id=l.post_id JOIN sources s ON s.id=p.source_id LEFT JOIN authors a ON a.id=p.author_id {where_sql}"), params_from_iter(sql_params[..filter_param_count].iter()), |r|r.get(0))?;
        let p_limit = push_param(&mut sql_params, SqlValue::Integer(fetch_limit));
        let p_offset = push_param(&mut sql_params, SqlValue::Integer(offset as i64));

        let sql = format!(
            "SELECT
               l.*,
               r.name AS radar_name,
               p.source_id,
               s.name AS source_name,
               p.author_id,
               a.name AS author_name,
               p.permalink,
               p.created_at AS post_created_at,
               p.text AS post_text
             FROM leads l
             JOIN radars r ON r.id = l.radar_id
             JOIN posts p ON p.id = l.post_id
             JOIN sources s ON s.id = p.source_id
             LEFT JOIN authors a ON a.id = p.author_id
             {where_sql}
             ORDER BY {order_sql}
             LIMIT {p_limit} OFFSET {p_offset}"
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut items = stmt
            .query_map(params_from_iter(sql_params), map_lead_list_item_row)?
            .collect::<Result<Vec<_>, _>>()?;

        let next_cursor = if items.len() > limit {
            items.truncate(limit);
            Some(format!("off:{}", offset + limit))
        } else {
            None
        };

        Ok(LeadListPage {
            items,
            next_cursor,
            total: total as usize,
        })
    }

    // ========================================================================
    // Feedback (`04-data-model.md §2.4`, `02-radar-spec.md §6`, `05-pipeline-rules.md §6.4`)
    // ========================================================================

    /// Record user feedback (`correct | irrelevant | wrong_fields | peer | duplicate | spam | missed`),
    /// snapshotting `post_text` so it survives post retention purging.
    pub fn record_feedback(
        &self,
        input: &RecordFeedbackInput,
    ) -> Result<FeedbackRecord, StoreError> {
        if !matches!(
            input.label.as_str(),
            "correct" | "irrelevant" | "wrong_fields" | "peer" | "duplicate" | "spam" | "missed"
        ) {
            return Err(StoreError::InvalidArgument(format!(
                "invalid feedback label '{}'",
                input.label
            )));
        }
        if !matches!(input.origin.as_str(), "app" | "telegram" | "preview") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid feedback origin '{}'",
                input.origin
            )));
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let (radar_version_id, post_id, fallback_text, verdict): (
            String,
            String,
            String,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT
                   e.radar_version_id,
                   e.post_id,
                   COALESCE(p.text, e.summary, ''), e.verdict
                 FROM evaluations e
                 JOIN posts p ON p.id = e.post_id
                 WHERE e.id = ?1",
                params![input.evaluation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "evaluation",
                id: input.evaluation_id.clone(),
            })?;

        let expected_match = match input.label.as_str() {
            "correct" => verdict.as_deref() == Some("match"),
            "missed" | "wrong_fields" => true,
            _ => false,
        };
        let id = new_ulid();
        let post_text = input.post_text.clone().unwrap_or(fallback_text);
        let cf_json = input
            .corrected_fields
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        tx.execute(
            "INSERT INTO feedback (
               id, evaluation_id, radar_version_id, post_id, label,
               corrected_fields, post_text, origin, created_at, expected_match
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                input.evaluation_id,
                radar_version_id,
                post_id,
                input.label,
                cf_json,
                post_text,
                input.origin,
                input.now_ms,
                expected_match,
            ],
        )?;

        // Hide lead immediately when marked with a negative rejection label (`02-radar-spec.md §6`).
        if matches!(
            input.label.as_str(),
            "irrelevant" | "peer" | "duplicate" | "spam"
        ) {
            tx.execute(
                "UPDATE leads
                 SET status = 'ignored', updated_at = ?1
                 WHERE evaluation_id = ?2 AND status IN ('new', 'viewed')",
                params![input.now_ms, input.evaluation_id],
            )?;
        }

        let rec = tx.query_row(
            "SELECT * FROM feedback WHERE id = ?1",
            params![id],
            map_feedback_row,
        )?;
        tx.commit()?;
        Ok(rec)
    }

    /// Fetch up to `max` recent balanced prompt feedback examples (e.g. `max = 8` -> up to 4 positive
    /// and up to 4 negative examples) for `judge_extract` (`02-radar-spec.md §6`, `06-ai-bridge.md §5.2`).
    pub fn get_prompt_feedback_examples(
        &self,
        radar_version_id: &str,
        max: usize,
    ) -> Result<Vec<FeedbackRecord>, StoreError> {
        if max == 0 {
            return Ok(Vec::new());
        }
        let pos_limit = (max / 2).max(1) as i64;
        let neg_limit = (max - (max / 2)).max(1) as i64;
        let conn = self.lock_conn()?;

        let mut positives = {
            let mut stmt = conn.prepare(
                "SELECT * FROM feedback
                 WHERE radar_version_id = ?1
                   AND expected_match = 1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![radar_version_id, pos_limit], map_feedback_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let negatives = {
            let mut stmt = conn.prepare(
                "SELECT * FROM feedback
                 WHERE radar_version_id = ?1
                   AND expected_match = 0
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![radar_version_id, neg_limit], map_feedback_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        positives.extend(negatives);
        positives.truncate(max);
        Ok(positives)
    }

    /// Assemble labeled training/validation dataset for ruleset compilation & gating
    /// (`05-pipeline-rules.md §6.4`): prioritizes explicit user feedback (deduplicated by `post_id`),
    /// followed by high/low confidence AI evaluations (`score >= 0.85` or `score <= 0.15`).
    pub fn get_labeled_dataset(
        &self,
        radar_version_id: &str,
    ) -> Result<Vec<LabeledSample>, StoreError> {
        let conn = self.lock_conn()?;
        let mut samples = Vec::new();
        let mut seen_posts = BTreeSet::new();

        // 1. User feedback (authoritative ground truth)
        {
            let mut stmt = conn.prepare(
                "SELECT
                   f.post_id,
                   f.evaluation_id,
                   f.post_text,
                   p.text_fold,
                   f.label,
                   f.expected_match,
                   f.corrected_fields,
                   e.author_role,
                   e.score,
                   e.fields AS eval_fields
                 FROM feedback f
                 LEFT JOIN posts p ON p.id = f.post_id
                 LEFT JOIN evaluations e ON e.id = f.evaluation_id
                 WHERE f.radar_version_id = ?1
                 ORDER BY f.created_at DESC",
            )?;

            let rows = stmt.query_map(params![radar_version_id], |row| {
                let cf_raw: Option<String> = row.get("corrected_fields")?;
                let ef_raw: Option<String> = row.get("eval_fields")?;
                let fields: Option<BTreeMap<String, ExtractedField>> = cf_raw
                    .as_deref()
                    .or(ef_raw.as_deref())
                    .and_then(|s| serde_json::from_str(s).ok());

                let label: String = row.get("label")?;
                let is_match: bool = row.get("expected_match")?;
                let role: Option<String> = if label == "peer" {
                    Some("peer".to_string())
                } else {
                    row.get("author_role")?
                };

                Ok(LabeledSample {
                    post_id: row.get("post_id")?,
                    evaluation_id: row.get("evaluation_id")?,
                    post_text: row.get("post_text")?,
                    text_fold: row.get("text_fold")?,
                    is_match,
                    author_role: role,
                    score: row.get("score")?,
                    fields,
                    origin: LabeledSampleOrigin::Feedback(label),
                })
            })?;

            for item in rows {
                let sample = item?;
                if seen_posts.insert(sample.post_id.clone()) {
                    samples.push(sample);
                }
            }
        }

        // 2. High/low confidence AI evaluations
        {
            let mut stmt = conn.prepare(
                "SELECT
                   e.post_id,
                   e.id AS evaluation_id,
                   p.text AS post_text,
                   p.text_fold,
                   e.verdict,
                   e.author_role,
                   e.score,
                   e.fields
                 FROM evaluations e
                 JOIN posts p ON p.id = e.post_id
                 WHERE e.radar_version_id = ?1
                   AND e.is_preview = 0
                   AND e.state = 'done'
                   AND e.decided_by = 'ai'
                   AND p.text IS NOT NULL
                   AND (e.score >= 0.85 OR e.score <= 0.15)
                 ORDER BY e.created_at DESC
                 LIMIT 300",
            )?;

            let rows = stmt.query_map(params![radar_version_id], |row| {
                let ef_raw: Option<String> = row.get("fields")?;
                let fields: Option<BTreeMap<String, ExtractedField>> =
                    ef_raw.as_deref().and_then(|s| serde_json::from_str(s).ok());
                let verdict: Option<String> = row.get("verdict")?;
                Ok(LabeledSample {
                    post_id: row.get("post_id")?,
                    evaluation_id: row.get("evaluation_id")?,
                    post_text: row.get("post_text")?,
                    text_fold: row.get("text_fold")?,
                    is_match: verdict.as_deref() == Some("match"),
                    author_role: row.get("author_role")?,
                    score: row.get("score")?,
                    fields,
                    origin: LabeledSampleOrigin::AiHighConfidence,
                })
            })?;

            for item in rows {
                let sample = item?;
                if seen_posts.insert(sample.post_id.clone()) {
                    samples.push(sample);
                }
            }
        }

        Ok(samples)
    }

    /// Count `(total_ai_evaluations, matched_ai_evaluations)` for `radar_version_id`
    /// (`05-pipeline-rules.md §6.4`: compile trigger requires `>= 150` AI evals and `>= 20` matches).
    pub fn count_ai_evaluations_for_version(
        &self,
        radar_version_id: &str,
    ) -> Result<(i64, i64), StoreError> {
        let conn = self.lock_conn()?;
        let counts = conn.query_row(
            "SELECT
               COUNT(*),
               COALESCE(SUM(CASE WHEN verdict = 'match' THEN 1 ELSE 0 END), 0)
             FROM evaluations
             WHERE radar_version_id = ?1
               AND is_preview = 0
               AND state = 'done'
               AND decided_by = 'ai'",
            params![radar_version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(counts)
    }
}

// ============================================================================
// Internal Helpers for Evaluations & Dynamic Field SQL Builder
// ============================================================================

fn list_pending_ai_items_conn(
    conn: &Connection,
    radar_version_id: &str,
    is_preview: bool,
    limit: usize,
) -> Result<Vec<PendingAiEvaluationItem>, StoreError> {
    let limit = limit.clamp(1, 1000) as i64;
    let mut stmt = conn.prepare(
        "SELECT
           e.id AS eval_id, e.post_id AS eval_post_id, e.radar_version_id AS eval_rvid,
           e.state AS eval_state, e.decided_by AS eval_decided_by, e.verdict AS eval_verdict,
           e.reject_reason AS eval_reject_reason, e.score AS eval_score, e.intent AS eval_intent,
           e.author_role AS eval_author_role, e.summary AS eval_summary, e.reason AS eval_reason,
           e.fields AS eval_fields, e.ruleset_id AS eval_ruleset_id, e.ai_call_id AS eval_ai_call_id,
           e.is_preview AS eval_is_preview, e.created_at AS eval_created_at, e.decided_at AS eval_decided_at,
           p.*, s.name AS source_name, a.name AS author_name
         FROM evaluations e
         JOIN posts p ON p.id = e.post_id
         JOIN sources s ON s.id = p.source_id
         LEFT JOIN authors a ON a.id = p.author_id
         WHERE e.state = 'pending_ai'
           AND e.radar_version_id = ?1
           AND e.is_preview = ?2
         ORDER BY e.created_at ASC
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(
            params![radar_version_id, i64::from(is_preview), limit],
            map_joined_eval_post_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_joined_eval_post_row(row: &Row<'_>) -> rusqlite::Result<PendingAiEvaluationItem> {
    let fields_raw: Option<String> = row.get("eval_fields")?;
    let fields: Option<BTreeMap<String, ExtractedField>> = fields_raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;

    let evaluation = EvaluationRecord {
        id: row.get("eval_id")?,
        post_id: row.get("eval_post_id")?,
        radar_version_id: row.get("eval_rvid")?,
        state: row.get("eval_state")?,
        decided_by: row.get("eval_decided_by")?,
        verdict: row.get("eval_verdict")?,
        reject_reason: row.get("eval_reject_reason")?,
        score: row.get("eval_score")?,
        intent: row.get("eval_intent")?,
        author_role: row.get("eval_author_role")?,
        summary: row.get("eval_summary")?,
        reason: row.get("eval_reason")?,
        fields,
        ruleset_id: row.get("eval_ruleset_id")?,
        ai_call_id: row.get("eval_ai_call_id")?,
        is_preview: row.get::<_, i64>("eval_is_preview")? != 0,
        created_at: row.get("eval_created_at")?,
        decided_at: row.get("eval_decided_at")?,
    };

    Ok(PendingAiEvaluationItem {
        evaluation,
        post: map_post_row(row)?,
        source_name: row.get("source_name")?,
        author_name: row.get("author_name")?,
    })
}

fn collect_cluster_also_seen_tx(
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

fn load_allowed_field_map(
    conn: &Connection,
    radar_id: Option<&str>,
) -> Result<BTreeMap<String, FieldDef>, StoreError> {
    let mut map = BTreeMap::new();
    if let Some(rid) = radar_id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM radars WHERE id = ?1)",
            params![rid],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound {
                entity: "radar",
                id: rid.to_string(),
            });
        }
        // Load fields from radar versions (oldest -> current so current_version wins on type).
        let mut stmt = conn.prepare(
            "SELECT rv.fields
             FROM radar_versions rv
             JOIN radars r ON r.id = rv.radar_id
             WHERE rv.radar_id = ?1 AND rv.version <= r.current_version
             ORDER BY rv.version ASC",
        )?;
        let rows = stmt.query_map(params![rid], |r| r.get::<_, String>(0))?;
        for raw in rows {
            let defs: Vec<FieldDef> = serde_json::from_str(&raw?)?;
            for f in defs {
                if is_valid_field_key(&f.key) {
                    map.insert(f.key.clone(), f);
                }
            }
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT rv.fields
             FROM radar_versions rv
             JOIN radars r ON r.id = rv.radar_id
             WHERE rv.version = r.current_version
             ORDER BY r.updated_at ASC",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for raw in rows {
            let defs: Vec<FieldDef> = serde_json::from_str(&raw?)?;
            for f in defs {
                if is_valid_field_key(&f.key) {
                    map.insert(f.key.clone(), f);
                }
            }
        }
    }
    Ok(map)
}

fn push_param(params: &mut Vec<SqlValue>, val: SqlValue) -> String {
    params.push(val);
    format!("?{}", params.len())
}

fn parse_cursor_offset(cursor: Option<&str>) -> Result<usize, StoreError> {
    let Some(c) = cursor else {
        return Ok(0);
    };
    let trimmed = c.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let num_str = trimmed.strip_prefix("off:").unwrap_or(trimmed);
    num_str
        .parse::<usize>()
        .map_err(|_| StoreError::InvalidArgument(format!("invalid pagination cursor '{trimmed}'")))
}

fn extract_f64(val: &serde_json::Value, field: &str, op: FilterOp) -> Result<f64, StoreError> {
    val.as_f64()
        .or_else(|| val.as_str().and_then(|s| s.parse::<f64>().ok()))
        .ok_or_else(|| StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected numeric value".to_string(),
        })
}

fn extract_str(val: &serde_json::Value, field: &str, op: FilterOp) -> Result<String, StoreError> {
    match val {
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        _ => Err(StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected string/scalar value".to_string(),
        }),
    }
}

fn extract_between_f64(val: &serde_json::Value, field: &str) -> Result<(f64, f64), StoreError> {
    if let Some(arr) = val.as_array() {
        if arr.len() == 2 {
            let lo = extract_f64(&arr[0], field, FilterOp::Between)?;
            let hi = extract_f64(&arr[1], field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    if let Some(obj) = val.as_object() {
        if let (Some(lo_v), Some(hi_v)) = (obj.get("min"), obj.get("max")) {
            let lo = extract_f64(lo_v, field, FilterOp::Between)?;
            let hi = extract_f64(hi_v, field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    Err(StoreError::InvalidFilterValue {
        field: field.to_string(),
        op: "Between".to_string(),
        message: "expected [min, max] array or {min, max} object".to_string(),
    })
}

fn extract_between_str(
    val: &serde_json::Value,
    field: &str,
) -> Result<(String, String), StoreError> {
    if let Some(arr) = val.as_array() {
        if arr.len() == 2 {
            let lo = extract_str(&arr[0], field, FilterOp::Between)?;
            let hi = extract_str(&arr[1], field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    if let Some(obj) = val.as_object() {
        if let (Some(lo_v), Some(hi_v)) = (obj.get("min"), obj.get("max")) {
            let lo = extract_str(lo_v, field, FilterOp::Between)?;
            let hi = extract_str(hi_v, field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    Err(StoreError::InvalidFilterValue {
        field: field.to_string(),
        op: "Between".to_string(),
        message: "expected [low, high] array or {min, max} object".to_string(),
    })
}

fn is_empty_expected(val: &serde_json::Value) -> bool {
    match val {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Null => true,
        _ => true,
    }
}

fn build_dynamic_sort_expr(fdef: &FieldDef, params: &mut Vec<SqlValue>) -> String {
    let key = &fdef.key;
    match fdef.r#type {
        FieldType::Money | FieldType::Range => {
            let p_min = push_param(params, SqlValue::Text(format!("$.{key}.value.min")));
            let p_amt = push_param(params, SqlValue::Text(format!("$.{key}.value.amount")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!(
                "CAST(COALESCE(json_extract(l.fields, {p_min}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END) AS REAL)"
            )
        }
        FieldType::Number => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!("CAST(json_extract(l.fields, {p_val}) AS REAL)")
        }
        FieldType::Location => {
            let p_dist = push_param(params, SqlValue::Text(format!("$.{key}.value.district")));
            let p_prov = push_param(params, SqlValue::Text(format!("$.{key}.value.province")));
            let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.value.raw")));
            format!(
                "COALESCE(json_extract(l.fields, {p_dist}), json_extract(l.fields, {p_prov}), json_extract(l.fields, {p_raw}))"
            )
        }
        _ => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!("json_extract(l.fields, {p_val})")
        }
    }
}

fn build_dynamic_filter_clause(
    fdef: &FieldDef,
    filter: &LeadFieldFilter,
    params: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    let key = &fdef.key;
    let op = filter.op;

    match fdef.r#type {
        FieldType::Money | FieldType::Range => {
            let p_min = push_param(params, SqlValue::Text(format!("$.{key}.value.min")));
            let p_max = push_param(params, SqlValue::Text(format!("$.{key}.value.max")));
            let p_amt = push_param(params, SqlValue::Text(format!("$.{key}.value.amount")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));

            let min_expr = format!(
                "COALESCE(json_extract(l.fields, {p_min}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END)"
            );
            let max_expr = format!(
                "COALESCE(json_extract(l.fields, {p_max}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END)"
            );

            match op {
                FilterOp::Lte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({max_expr} AS REAL) <= {px}"))
                }
                FilterOp::Lt => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({max_expr} AS REAL) < {px}"))
                }
                FilterOp::Gte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({min_expr} AS REAL) >= {px}"))
                }
                FilterOp::Gt => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({min_expr} AS REAL) > {px}"))
                }
                FilterOp::Eq => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px1 = push_param(params, SqlValue::Real(x));
                    let px2 = push_param(params, SqlValue::Real(x));
                    Ok(format!(
                        "(CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2})"
                    ))
                }
                FilterOp::Ne => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px1 = push_param(params, SqlValue::Real(x));
                    let px2 = push_param(params, SqlValue::Real(x));
                    Ok(format!(
                        "({min_expr} IS NOT NULL AND NOT (CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2}))"
                    ))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_f64(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Real(lo));
                    let phi = push_param(params, SqlValue::Real(hi));
                    Ok(format!(
                        "(CAST({min_expr} AS REAL) >= {plo} AND CAST({max_expr} AS REAL) <= {phi})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of numbers".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut disj = Vec::with_capacity(arr.len());
                    for item in arr {
                        let x = extract_f64(item, key, op)?;
                        let px1 = push_param(params, SqlValue::Real(x));
                        let px2 = push_param(params, SqlValue::Real(x));
                        disj.push(format!(
                            "(CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2})"
                        ));
                    }
                    Ok(format!("({})", disj.join(" OR ")))
                }
                FilterOp::Contains => {
                    let needle = extract_str(&filter.value, key, op)?;
                    let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.raw")));
                    let pn = push_param(params, SqlValue::Text(needle));
                    Ok(format!(
                        "dealsonar_fold_contains(COALESCE(json_extract(l.fields, {p_raw}), CAST(json_extract(l.fields, {p_val}) AS TEXT)), {pn}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("({min_expr} IS NULL AND {max_expr} IS NULL)"))
                    } else {
                        Ok(format!(
                            "({min_expr} IS NOT NULL OR {max_expr} IS NOT NULL)"
                        ))
                    }
                }
            }
        }

        FieldType::Location => {
            let p_prov = push_param(params, SqlValue::Text(format!("$.{key}.value.province")));
            let p_dist = push_param(params, SqlValue::Text(format!("$.{key}.value.district")));
            let p_ward = push_param(params, SqlValue::Text(format!("$.{key}.value.ward")));
            let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.value.raw")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));

            let prov = format!("json_extract(l.fields, {p_prov})");
            let dist = format!("json_extract(l.fields, {p_dist})");
            let ward = format!("json_extract(l.fields, {p_ward})");
            let raw = format!("json_extract(l.fields, {p_raw})");
            let scalar = format!(
                "(CASE WHEN json_type(l.fields, {p_val}) = 'text' THEN json_extract(l.fields, {p_val}) END)"
            );

            match op {
                FilterOp::Eq => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "({prov} = {ps} OR {dist} = {ps} OR {ward} = {ps} OR {raw} = {ps} OR {scalar} = {ps})"
                    ))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_extract(l.fields, {p_val}) IS NOT NULL \
                          AND COALESCE({prov}, '') != {ps} \
                          AND COALESCE({dist}, '') != {ps} \
                          AND COALESCE({ward}, '') != {ps} \
                          AND COALESCE({raw}, '') != {ps} \
                          AND COALESCE({scalar}, '') != {ps})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of location strings".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    let list = ph.join(", ");
                    Ok(format!(
                        "({prov} IN ({list}) OR {dist} IN ({list}) OR {ward} IN ({list}) OR {raw} IN ({list}) OR {scalar} IN ({list}))"
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(\
                           COALESCE({prov}, '') || ' ' || COALESCE({dist}, '') || ' ' || \
                           COALESCE({ward}, '') || ' ' || COALESCE({raw}, '') || ' ' || COALESCE({scalar}, ''), \
                           {ps}\
                         ) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NULL \
                              OR ({prov} IS NULL AND {dist} IS NULL AND {ward} IS NULL AND {raw} IS NULL AND {scalar} IS NULL))"
                        ))
                    } else {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NOT NULL \
                              AND ({prov} IS NOT NULL OR {dist} IS NOT NULL OR {ward} IS NOT NULL OR {raw} IS NOT NULL OR {scalar} IS NOT NULL))"
                        ))
                    }
                }
                FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!(
                        "COALESCE({dist}, {prov}, {raw}, {scalar}) {sql_op} {ps}"
                    ))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_str(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Text(lo));
                    let phi = push_param(params, SqlValue::Text(hi));
                    Ok(format!(
                        "COALESCE({dist}, {prov}, {raw}, {scalar}) BETWEEN {plo} AND {phi}"
                    ))
                }
            }
        }

        FieldType::MultiEnum => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            match op {
                FilterOp::Eq => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value = {ps}\
                         ))"
                    ))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND NOT EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value = {ps}\
                         ))"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of strings".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value IN ({})\
                         ))",
                        ph.join(", ")
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je \
                           WHERE dealsonar_fold_contains(CAST(je.value AS TEXT), {ps}) = 1\
                         ))"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NULL \
                              OR (json_type(l.fields, {p_val}) = 'array' AND json_array_length(json_extract(l.fields, {p_val})) = 0))"
                        ))
                    } else {
                        Ok(format!(
                            "(json_type(l.fields, {p_val}) = 'array' AND json_array_length(json_extract(l.fields, {p_val})) > 0)"
                        ))
                    }
                }
                _ => Err(StoreError::InvalidFilterValue {
                    field: key.clone(),
                    op: format!("{op:?}"),
                    message: "unsupported operator for multi_enum field".to_string(),
                }),
            }
        }

        FieldType::Number => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");
            let num_expr = format!("CAST({val_expr} AS REAL)");

            match op {
                FilterOp::Eq | FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} {sql_op} {px})"
                    ))
                }
                FilterOp::Ne => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("({val_expr} IS NOT NULL AND {num_expr} != {px})"))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_f64(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Real(lo));
                    let phi = push_param(params, SqlValue::Real(hi));
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} BETWEEN {plo} AND {phi})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of numbers".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let x = extract_f64(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Real(x)));
                    }
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} IN ({}))",
                        ph.join(", ")
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(CAST({val_expr} AS TEXT), {ps}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("{val_expr} IS NULL"))
                    } else {
                        Ok(format!("{val_expr} IS NOT NULL"))
                    }
                }
            }
        }

        FieldType::Boolean => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");

            match op {
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("{val_expr} IS NULL"))
                    } else {
                        Ok(format!("{val_expr} IS NOT NULL"))
                    }
                }
                FilterOp::Eq | FilterOp::Ne => {
                    let b = parse_bool_filter(&filter.value, key, op)?;
                    let pb = push_param(params, SqlValue::Integer(i64::from(b)));
                    if op == FilterOp::Eq {
                        Ok(format!("{val_expr} = {pb}"))
                    } else {
                        Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != {pb})"))
                    }
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of booleans".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let b = parse_bool_filter(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Integer(i64::from(b))));
                    }
                    Ok(format!("{val_expr} IN ({})", ph.join(", ")))
                }
                _ => Err(StoreError::InvalidFilterValue {
                    field: key.clone(),
                    op: format!("{op:?}"),
                    message: "unsupported operator for boolean field".to_string(),
                }),
            }
        }

        FieldType::Text | FieldType::Phone | FieldType::Enum | FieldType::Date | FieldType::Url => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");

            match op {
                FilterOp::Eq | FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!("{val_expr} {sql_op} {ps}"))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != {ps})"))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_str(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Text(lo));
                    let phi = push_param(params, SqlValue::Text(hi));
                    Ok(format!("{val_expr} BETWEEN {plo} AND {phi}"))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of scalar values".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    Ok(format!("{val_expr} IN ({})", ph.join(", ")))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(CAST({val_expr} AS TEXT), {ps}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("({val_expr} IS NULL OR {val_expr} = '')"))
                    } else {
                        Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != '')"))
                    }
                }
            }
        }
    }
}

fn cmp_op_sql(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "=",
        FilterOp::Ne => "!=",
        FilterOp::Lt => "<",
        FilterOp::Lte => "<=",
        FilterOp::Gt => ">",
        FilterOp::Gte => ">=",
        _ => "=",
    }
}

fn parse_bool_filter(
    val: &serde_json::Value,
    field: &str,
    op: FilterOp,
) -> Result<bool, StoreError> {
    match val {
        serde_json::Value::Bool(b) => Ok(*b),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(StoreError::InvalidFilterValue {
                field: field.to_string(),
                op: format!("{op:?}"),
                message: "expected boolean".to_string(),
            }),
        },
        serde_json::Value::String(s) => match s.as_str() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(StoreError::InvalidFilterValue {
                field: field.to_string(),
                op: format!("{op:?}"),
                message: "expected boolean".to_string(),
            }),
        },
        _ => Err(StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected boolean".to_string(),
        }),
    }
}
