//! Evaluation persistence and the pending AI work queue.

use super::*;

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

pub(super) fn list_pending_ai_items_conn(
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
