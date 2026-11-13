//! T3–T4: blocklist, prefilter, and ruleset evaluation per radar.

use super::*;

/// Run T3 (Prefilter) & T4 (Ruleset) synchronously for `(post, radar_version)`.
///
/// - `DefiniteMatch` proceeds immediately through T6–T7 without calling AI.
/// - `DefiniteNoMatch` / `PrefilterReject` marks the evaluation `done / no_match`.
/// - `Uncertain` (or no active ruleset) saves `pending_ai` with rule hint fields and schedules T5.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_post_for_radar_sync(
    rt: &Arc<CoreRuntime>,
    post: &PostRecord,
    norm: &NormalizedText,
    radar_id: &str,
    radar_name: &str,
    radar_status: &str,
    radar_notify: &dealsonar_store::models::NotifyConfig,
    radar_version: &RadarVersionRecord,
    mode: EvalMode,
    now: i64,
) -> CoreResult<EvaluationRecord> {
    let is_preview = mode.is_preview();

    // T3 Step 1: Blocklist (`author`, `phone`, `keyword`)
    let author_ref = post.author_id.as_deref();
    if let Some(blocked) = rt.store.find_matching_blocklist(
        Some(radar_id),
        author_ref,
        &post.extracted_phones,
        Some(norm.text_fold.as_str()),
    )? {
        return Ok(rt.store.upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: post.id.clone(),
            radar_version_id: radar_version.id.clone(),
            state: "done".to_string(),
            decided_by: Some("prefilter".to_string()),
            verdict: Some("no_match".to_string()),
            reject_reason: Some("blocked".to_string()),
            score: Some(0.0),
            intent: None,
            author_role: None,
            summary: None,
            reason: Some(format!(
                "Chặn theo danh sách chặn ({}: {})",
                blocked.kind, blocked.value
            )),
            fields: None,
            ruleset_id: None,
            ai_call_id: None,
            is_preview,
            created_at: now,
            decided_at: Some(now),
        })?);
    }

    // T3 Step 2: Basic prefilter (`< 15` chars without media/link, or URL-only)
    let has_attachments = post
        .attachments
        .as_ref()
        .and_then(|v| v.as_array())
        .is_some_and(|arr| !arr.is_empty());

    let basic_res = run_basic_prefilter(
        &BasicPrefilterInput {
            author_id: post.author_id.as_deref(),
            text_norm: &norm.text_norm,
            text_fold: &norm.text_fold,
            has_attachments,
        },
        &[],
    );

    if let Some(prefilter_err) = basic_res {
        return Ok(rt.store.upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: post.id.clone(),
            radar_version_id: radar_version.id.clone(),
            state: "done".to_string(),
            decided_by: Some("prefilter".to_string()),
            verdict: Some("no_match".to_string()),
            reject_reason: Some("prefilter".to_string()),
            score: Some(0.0),
            intent: None,
            author_role: None,
            summary: None,
            reason: Some(format!("Loại ở T3 lọc sơ bộ ({prefilter_err:?})")),
            fields: None,
            ruleset_id: None,
            ai_call_id: None,
            is_preview,
            created_at: now,
            decided_at: Some(now),
        })?);
    }

    let rules_field_defs: Vec<dealsonar_rules::FieldDef> = radar_version
        .fields
        .iter()
        .map(field_def_store_to_rules)
        .collect();
    let ref_ts_ms = post.created_at.unwrap_or(post.captured_at);

    // T4 Side-by-side Shadow Ruleset evaluation (when non-preview)
    if !is_preview {
        if let Some(shadow_rec) = rt.store.get_shadow_ruleset(&radar_version.id)? {
            if let Ok(shadow_body) =
                serde_json::from_value::<EngineRulesetBody>(shadow_rec.body.clone())
            {
                if let Ok(compiled_shadow) = compile_ruleset_unchecked(&shadow_body) {
                    let shadow_outcome =
                        compiled_shadow.evaluate(norm, &rules_field_defs, ref_ts_ms);
                    record_shadow_prediction(rt, &shadow_rec.id, &post.id, &shadow_outcome)?;
                }
            }
        }
    }

    // T4 Active Ruleset evaluation
    let mut hint_fields_store: Option<BTreeMap<String, StoreExtractedField>> = None;
    if let Some(active_rec) = rt.store.get_active_ruleset(&radar_version.id)? {
        if let Ok(active_body) =
            serde_json::from_value::<EngineRulesetBody>(active_rec.body.clone())
        {
            if let Ok(compiled) = compile_ruleset_unchecked(&active_body) {
                let outcome = compiled.evaluate(norm, &rules_field_defs, ref_ts_ms);
                match outcome {
                    RulesetOutcome::PrefilterReject => {
                        return Ok(rt.store.upsert_evaluation(&EvaluationUpsertInput {
                            id: None,
                            post_id: post.id.clone(),
                            radar_version_id: radar_version.id.clone(),
                            state: "done".to_string(),
                            decided_by: Some("prefilter".to_string()),
                            verdict: Some("no_match".to_string()),
                            reject_reason: Some("prefilter".to_string()),
                            score: Some(0.0),
                            intent: None,
                            author_role: None,
                            summary: None,
                            reason: Some("Loại bởi lọc sơ bộ của bộ quy tắc".to_string()),
                            fields: None,
                            ruleset_id: Some(active_rec.id),
                            ai_call_id: None,
                            is_preview,
                            created_at: now,
                            decided_at: Some(now),
                        })?);
                    }
                    RulesetOutcome::DefiniteNoMatch {
                        rule_id,
                        confidence,
                        set,
                    } => {
                        let role_str = set
                            .get("author_role")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        let reject_reason = if role_str == "peer" {
                            "peer"
                        } else if set.get("is_spam").and_then(Value::as_bool) == Some(true) {
                            "spam"
                        } else {
                            "irrelevant"
                        };
                        let eval = rt.store.upsert_evaluation(&EvaluationUpsertInput {
                            id: None,
                            post_id: post.id.clone(),
                            radar_version_id: radar_version.id.clone(),
                            state: "done".to_string(),
                            decided_by: Some("rule".to_string()),
                            verdict: Some("no_match".to_string()),
                            reject_reason: Some(reject_reason.to_string()),
                            score: Some((1.0 - confidence).clamp(0.0, 0.39)),
                            intent: set
                                .get("intent")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            author_role: Some(role_str.to_string()),
                            summary: None,
                            reason: Some(format!("Loại chắc bởi luật '{rule_id}'")),
                            fields: None,
                            ruleset_id: Some(active_rec.id.clone()),
                            ai_call_id: None,
                            is_preview,
                            created_at: now,
                            decided_at: Some(now),
                        })?;

                        if !is_preview
                            && should_sample_for_audit(&post.id, rt.config.audit_sample_percent)
                        {
                            enqueue_audit_sample(
                                rt,
                                &radar_version.id,
                                &active_rec.id,
                                &eval.id,
                                now,
                            )?;
                        }
                        return Ok(eval);
                    }
                    RulesetOutcome::DefiniteMatch {
                        rule_id,
                        confidence,
                        fields,
                        set,
                    } => {
                        let intent = match set.get("intent").and_then(Value::as_str) {
                            Some("demand") => PostIntent::Demand,
                            Some("supply") => PostIntent::Supply,
                            Some("other") => PostIntent::Other,
                            _ => match radar_version.match_policy.want_intent.as_str() {
                                "supply" => PostIntent::Supply,
                                _ => PostIntent::Demand,
                            },
                        };
                        let author_role = match set.get("author_role").and_then(Value::as_str) {
                            Some("peer") => AuthorRole::Peer,
                            Some("end_user") => AuthorRole::EndUser,
                            _ => AuthorRole::EndUser,
                        };
                        let is_spam = set.get("is_spam").and_then(Value::as_bool).unwrap_or(false);
                        let summary = build_rule_match_summary(&norm.text_norm);

                        // Create placeholder evaluation first so finalize_candidate_evaluation can update it
                        let eval_placeholder =
                            rt.store.upsert_evaluation(&EvaluationUpsertInput {
                                id: None,
                                post_id: post.id.clone(),
                                radar_version_id: radar_version.id.clone(),
                                state: "pending_ai".to_string(),
                                decided_by: Some("rule".to_string()),
                                verdict: None,
                                reject_reason: None,
                                score: None,
                                intent: None,
                                author_role: None,
                                summary: None,
                                reason: None,
                                fields: None,
                                ruleset_id: Some(active_rec.id.clone()),
                                ai_call_id: None,
                                is_preview,
                                created_at: now,
                                decided_at: None,
                            })?;

                        let finalized = finalize_candidate_evaluation(
                            rt,
                            &eval_placeholder.id,
                            post,
                            &norm.text_norm,
                            radar_id,
                            radar_name,
                            radar_status,
                            radar_notify,
                            radar_version,
                            CandidateDecision {
                                decided_by: "rule",
                                ruleset_id: Some(active_rec.id.clone()),
                                ai_call_id: None,
                                is_match: true,
                                raw_score: confidence,
                                intent,
                                author_role,
                                is_spam,
                                summary,
                                reason: format!("Khớp chắc bởi luật '{rule_id}'"),
                                candidate_fields: fields,
                            },
                            mode,
                            now,
                        )?;

                        if !is_preview
                            && should_sample_for_audit(&post.id, rt.config.audit_sample_percent)
                        {
                            enqueue_audit_sample(
                                rt,
                                &radar_version.id,
                                &active_rec.id,
                                &finalized.id,
                                now,
                            )?;
                        }
                        return Ok(finalized);
                    }
                    RulesetOutcome::Uncertain { hint_fields, .. } => {
                        if !hint_fields.is_empty() {
                            hint_fields_store = Some(
                                hint_fields
                                    .iter()
                                    .map(|(k, v)| (k.clone(), extracted_field_rules_to_store(v)))
                                    .collect(),
                            );
                        }
                    }
                }
            }
        }
    }

    // Queue for T5 AI batch evaluation
    let pending_eval = rt.store.upsert_evaluation(&EvaluationUpsertInput {
        id: None,
        post_id: post.id.clone(),
        radar_version_id: radar_version.id.clone(),
        state: "pending_ai".to_string(),
        decided_by: None,
        verdict: None,
        reject_reason: None,
        score: None,
        intent: None,
        author_role: None,
        summary: None,
        reason: None,
        fields: hint_fields_store,
        ruleset_id: None,
        ai_call_id: None,
        is_preview,
        created_at: now,
        decided_at: None,
    })?;

    if !is_preview {
        schedule_evaluate_batch_job(
            rt,
            &radar_version.id,
            matches!(mode, EvalMode::BackfillSilent),
            now,
        )?;
    }

    Ok(pending_eval)
}

pub(super) fn build_rule_match_summary(text_norm: &str) -> String {
    let first_line = text_norm
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(text_norm.trim());
    let chars: Vec<char> = first_line.chars().collect();
    if chars.len() <= 120 {
        first_line.to_string()
    } else {
        let mut s: String = chars.into_iter().take(119).collect();
        s.push('…');
        s
    }
}
