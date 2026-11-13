//! Row mappers for evaluations, leads, feedback, and joined evaluation/post rows.

use super::*;

pub(super) fn map_evaluation_row(row: &Row<'_>) -> rusqlite::Result<EvaluationRecord> {
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

pub(super) fn map_feedback_row(row: &Row<'_>) -> rusqlite::Result<FeedbackRecord> {
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

pub(super) fn map_joined_eval_post_row(row: &Row<'_>) -> rusqlite::Result<PendingAiEvaluationItem> {
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
