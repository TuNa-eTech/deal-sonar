//! User feedback recording and labeled datasets for prompts and evaluation.

use super::*;

impl Store {
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
}
