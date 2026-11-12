//! Streaming Radar Preview (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`) and
//! Declarative Ruleset Lifecycle (`compile_ruleset`, `audit_ruleset`, `ruleset_save_user`,
//! `05-pipeline-rules.md §6.4`).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use dealsonar_ai_bridge::{
    AuthorRole as AiAuthorRole, BatchConfig, CompileRulesInput, DetectedIntent,
    LabeledSample as AiLabeledSample, PostEvalOutcome, PostPromptInput,
};
use dealsonar_protocol::{Body, CrawlReason, Envelope, SourceRef};
use dealsonar_rules::{
    evaluate_gate_with_fields, normalize_text, validate_ruleset,
    LabeledSample as GateLabeledSample, RulesetBody as EngineRulesetBody,
};
use dealsonar_store::models::{
    new_ulid, now_ms, EvaluationRecord, NewRulesetInput, PendingAiEvaluationItem,
    RadarVersionRecord, RecordAiCallInput, RulesetRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::dto::{
    dto_ruleset_body_to_rules, extracted_field_ai_to_rules, extracted_field_from_store,
    extracted_field_store_to_rules, field_def_store_to_rules, field_def_to_store,
    match_policy_to_store, ruleset_record_to_dto,
};
use crate::dto::{
    AuthorRole, CoreEvent, DecidedBy, PostIntent, PreviewItem, PreviewProgressEvent,
    PreviewRunState, PreviewStartInput, PreviewStatus, PreviewWarning, PreviewWarningCode, Ruleset,
    RulesetBody as DtoRulesetBody, RulesetMetrics,
};
use crate::error::{CoreError, CoreResult};
use crate::pipeline::{
    build_radar_prompt_context, evaluate_post_for_radar_sync, finalize_candidate_evaluation,
    CandidateDecision, EvalMode,
};
use crate::state::{CoreRuntime, InflightAiGuard};

/// Rolling 7-day audit ledger stored in `settings` (`runtime.audit_history.<ruleset_id>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AuditHistoryEntry {
    pub ts_ms: i64,
    pub disagreed: bool,
}

/// Start an interactive streaming preview run (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`).
///
/// - Selects up to `config.preview_max_posts` (`50`) recent stored posts across `source_ids`.
/// - If `< config.preview_min_posts_before_crawl` (`20`) posts exist and an extension is connected,
///   sends `crawl.request(reason = "preview", max_posts = 25)` to fetch live group posts.
/// - Runs T3–T4 (skipping T2 dedup so user sees duplicates too) + T5 AI in batches of `10`,
///   emitting `preview:progress` after every chunk and computing the 3 quality warnings!
pub async fn start_radar_preview(
    rt: &Arc<CoreRuntime>,
    input: PreviewStartInput,
) -> CoreResult<PreviewRunState> {
    let now = now_ms();
    let rw = rt
        .store
        .radar_get(&input.radar_id)?
        .ok_or_else(|| CoreError::NotFound {
            entity: "radar",
            id: input.radar_id.clone(),
        })?;

    // Base preview definition on candidate_version (if present) or current_version, overlaid with `input`.
    let base_ver = rw.candidate_version.as_ref().unwrap_or(&rw.current_version);
    let effective_ver = RadarVersionRecord {
        id: base_ver.id.clone(),
        radar_id: rw.radar.id.clone(),
        version: base_ver.version,
        description: input
            .description
            .clone()
            .unwrap_or_else(|| base_ver.description.clone()),
        language_hint: base_ver.language_hint.clone(),
        user_profession: match &input.user_profession {
            Some(up) => up.clone(),
            None => base_ver.user_profession.clone(),
        },
        fields: match &input.fields {
            Some(fs) => fs.iter().map(field_def_to_store).collect(),
            None => base_ver.fields.clone(),
        },
        match_policy: match &input.match_policy {
            Some(mp) => match_policy_to_store(mp),
            None => base_ver.match_policy.clone(),
        },
        created_at: base_ver.created_at,
    };

    let source_ids = input
        .source_ids
        .clone()
        .unwrap_or_else(|| rw.source_ids.clone());

    // Clear prior preview evaluations for this radar_version_id before starting fresh
    let _ = rt
        .store
        .cleanup_preview_evaluations(Some(&effective_ver.id), None)?;

    let posts = rt
        .store
        .list_recent_posts_for_sources(&source_ids, rt.config.preview_max_posts)?;

    // If fewer than 20 posts are stored locally, request an immediate preview crawl from connected Chrome
    if posts.len() < rt.config.preview_min_posts_before_crawl {
        for sid in &source_ids {
            if let Some(src) = rt.store.source_get(sid)? {
                let env = Envelope::new(Body::CrawlRequest {
                    request_id: new_ulid(),
                    source_ref: SourceRef {
                        platform: src.platform,
                        kind: src.kind,
                        external_id: src.external_id,
                    },
                    reason: CrawlReason::Preview,
                    max_posts: 25,
                });
                rt.ipc_hub.send_to_profile(src.profile_id.as_deref(), &env);
            }
        }
    }

    let preview_id = new_ulid();
    let initial_status = if posts.is_empty() && rt.ipc_hub.is_any_connected() {
        PreviewStatus::Crawling
    } else if posts.is_empty() {
        PreviewStatus::Done
    } else {
        PreviewStatus::Evaluating
    };

    let mut state = PreviewRunState {
        preview_id: preview_id.clone(),
        radar_id: rw.radar.id.clone(),
        radar_version: effective_ver.version,
        status: initial_status,
        total_posts: posts.len(),
        evaluated_posts: 0,
        items: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };

    save_preview_state(rt, &state);

    if posts.is_empty() {
        state.status = PreviewStatus::Done;
        state.warnings = compute_preview_warnings(&state.items, &effective_ver);
        save_preview_state(rt, &state);
        rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
            preview_id: state.preview_id.clone(),
            radar_id: state.radar_id.clone(),
            status: state.status,
            evaluated_posts: 0,
            total_posts: 0,
            new_items: Vec::new(),
            warnings: state.warnings.clone(),
        }));
        return Ok(state);
    }

    // Step 1: Run T3–T4 synchronously across all selected posts (T2 dedup intentionally skipped!)
    let mut done_immediately = Vec::new();
    for post in &posts {
        let norm = normalize_text(post.text.as_deref().unwrap_or(""));
        let eval = evaluate_post_for_radar_sync(
            rt,
            post,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            &effective_ver,
            EvalMode::Preview,
            now,
        )?;
        if eval.state == "done" {
            done_immediately.push(eval.id);
        }
    }

    if !done_immediately.is_empty() {
        let all_preview = rt.store.list_preview_evaluations(&effective_ver.id)?;
        let new_items: Vec<PreviewItem> = all_preview
            .iter()
            .filter(|it| done_immediately.iter().any(|id| id == &it.evaluation.id))
            .map(preview_eval_item_to_dto)
            .collect();
        state.evaluated_posts += new_items.len();
        state.items.extend(new_items.clone());
        save_preview_state(rt, &state);
        rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
            preview_id: state.preview_id.clone(),
            radar_id: state.radar_id.clone(),
            status: PreviewStatus::Evaluating,
            evaluated_posts: state.evaluated_posts,
            total_posts: state.total_posts,
            new_items,
            warnings: Vec::new(),
        }));
    }

    // Step 2: Evaluate `pending_ai` preview posts in streaming batches of `preview_batch_size` (10)
    let pending_preview = rt.store.list_pending_ai_for_version(
        &effective_ver.id,
        true,
        rt.config.preview_max_posts,
    )?;

    if !pending_preview.is_empty() {
        let prompt_ctx = build_radar_prompt_context(rt, &effective_ver)?;
        let chunk_size = rt.config.preview_batch_size.max(1);

        for chunk in pending_preview.chunks(chunk_size) {
            let prompt_posts: Vec<PostPromptInput> = chunk
                .iter()
                .enumerate()
                .map(|(idx, item)| {
                    let rule_hints = item.evaluation.fields.as_ref().and_then(|m| {
                        (!m.is_empty()).then(|| {
                            m.iter()
                                .map(|(k, v)| (k.clone(), v.value.clone()))
                                .collect()
                        })
                    });
                    PostPromptInput::sanitized(
                        item.post.id.clone(),
                        u32::try_from(idx + 1).unwrap_or(1),
                        item.source_name.clone(),
                        item.author_name.clone(),
                        None,
                        None,
                        item.post.created_at,
                        item.post
                            .text_norm
                            .as_deref()
                            .or(item.post.text.as_deref())
                            .unwrap_or(""),
                        rule_hints,
                    )
                })
                .collect();

            let batch_res = {
                let _inflight = InflightAiGuard::acquire(rt);
                rt.ai_bridge
                    .judge_extract_all(&prompt_ctx, &prompt_posts, &BatchConfig::default_preview())
                    .await
            };

            let chunk_now = now_ms();
            match batch_res {
                Err(ai_err) => {
                    state.status = PreviewStatus::Error;
                    state.error = Some(ai_err.to_string());
                    save_preview_state(rt, &state);
                    rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
                        preview_id: state.preview_id.clone(),
                        radar_id: state.radar_id.clone(),
                        status: PreviewStatus::Error,
                        evaluated_posts: state.evaluated_posts,
                        total_posts: state.total_posts,
                        new_items: Vec::new(),
                        warnings: state.warnings.clone(),
                    }));
                    return Ok(state);
                }
                Ok(report) => {
                    let mut last_call_id = None;
                    for call in &report.calls {
                        let saved = rt.store.record_ai_call(&RecordAiCallInput {
                            id: None,
                            provider: call.provider.as_str().to_string(),
                            model: call.model.clone(),
                            task: call.task.as_str().to_string(),
                            radar_version_id: call.radar_version_id.clone(),
                            item_count: call.item_count as i64,
                            input_tokens: call.input_tokens.map(|v| v as i64),
                            output_tokens: call.output_tokens.map(|v| v as i64),
                            cost_usd: call.cost_usd,
                            duration_ms: call.duration_ms as i64,
                            status: call.status.as_str().to_string(),
                            error: call.error.clone(),
                            now_ms: chunk_now,
                        })?;
                        last_call_id = Some(saved.id);
                    }

                    let by_post: HashMap<&str, &PendingAiEvaluationItem> =
                        chunk.iter().map(|it| (it.post.id.as_str(), it)).collect();

                    let mut chunk_eval_ids = Vec::new();
                    for outcome in report.outcomes {
                        match outcome {
                            PostEvalOutcome::AiFailed { post_id, error, .. } => {
                                if let Some(it) = by_post.get(post_id.as_str()) {
                                    rt.store.mark_evaluation_ai_failed(
                                        &it.evaluation.id,
                                        last_call_id.as_deref(),
                                        Some(&error),
                                        chunk_now,
                                    )?;
                                }
                            }
                            PostEvalOutcome::Done { post_id, result } => {
                                let Some(it) = by_post.get(post_id.as_str()) else {
                                    continue;
                                };
                                let mut merged = BTreeMap::new();
                                if let Some(hints) = &it.evaluation.fields {
                                    for (k, v) in hints {
                                        if let Some(rf) = extracted_field_store_to_rules(v) {
                                            merged.insert(k.clone(), rf);
                                        }
                                    }
                                }
                                for (k, ef) in result.extracted_fields() {
                                    merged.insert(k, extracted_field_ai_to_rules(&ef));
                                }

                                let finalized = finalize_candidate_evaluation(
                                    rt,
                                    &it.evaluation.id,
                                    &it.post,
                                    it.post
                                        .text_norm
                                        .as_deref()
                                        .or(it.post.text.as_deref())
                                        .unwrap_or(""),
                                    &rw.radar.id,
                                    &rw.radar.name,
                                    &rw.radar.status,
                                    &rw.radar.notify,
                                    &effective_ver,
                                    CandidateDecision {
                                        decided_by: "ai",
                                        ruleset_id: None,
                                        ai_call_id: last_call_id.clone(),
                                        is_match: result.is_match,
                                        raw_score: result.score,
                                        intent: match result.intent {
                                            DetectedIntent::Demand => PostIntent::Demand,
                                            DetectedIntent::Supply => PostIntent::Supply,
                                            DetectedIntent::Other => PostIntent::Other,
                                        },
                                        author_role: match result.author_role {
                                            AiAuthorRole::EndUser => AuthorRole::EndUser,
                                            AiAuthorRole::Peer => AuthorRole::Peer,
                                            AiAuthorRole::Unknown => AuthorRole::Unknown,
                                        },
                                        is_spam: result.is_spam,
                                        summary: result.summary,
                                        reason: result.reason,
                                        candidate_fields: merged,
                                    },
                                    EvalMode::Preview,
                                    chunk_now,
                                )?;
                                chunk_eval_ids.push(finalized.id);
                            }
                        }
                    }

                    let all_preview = rt.store.list_preview_evaluations(&effective_ver.id)?;
                    let chunk_items: Vec<PreviewItem> = all_preview
                        .iter()
                        .filter(|it| chunk_eval_ids.iter().any(|id| id == &it.evaluation.id))
                        .map(preview_eval_item_to_dto)
                        .collect();

                    state.evaluated_posts += chunk_items.len();
                    state.items.extend(chunk_items.clone());
                    save_preview_state(rt, &state);

                    rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
                        preview_id: state.preview_id.clone(),
                        radar_id: state.radar_id.clone(),
                        status: PreviewStatus::Evaluating,
                        evaluated_posts: state.evaluated_posts,
                        total_posts: state.total_posts,
                        new_items: chunk_items,
                        warnings: Vec::new(),
                    }));
                }
            }
        }
    }

    // Sort matches first by score DESC, then non-matches by score DESC
    state.items.sort_by(|a, b| {
        let a_m = a.verdict == "match";
        let b_m = b.verdict == "match";
        b_m.cmp(&a_m).then_with(|| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    state.status = PreviewStatus::Done;
    state.warnings = compute_preview_warnings(&state.items, &effective_ver);
    save_preview_state(rt, &state);

    rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
        preview_id: state.preview_id.clone(),
        radar_id: state.radar_id.clone(),
        status: PreviewStatus::Done,
        evaluated_posts: state.evaluated_posts,
        total_posts: state.total_posts,
        new_items: Vec::new(),
        warnings: state.warnings.clone(),
    }));

    Ok(state)
}

/// Fetch an existing preview run state by `(radar_id, optional preview_id)`.
pub fn get_radar_preview(
    rt: &CoreRuntime,
    radar_id: &str,
    preview_id: Option<&str>,
) -> CoreResult<PreviewRunState> {
    let resolved_id = match preview_id {
        Some(pid) => Some(pid.to_string()),
        None => rt
            .latest_preview_by_radar
            .lock()
            .expect("latest preview lock")
            .get(radar_id)
            .cloned(),
    };

    if let Some(pid) = resolved_id {
        if let Some(st) = rt
            .previews
            .lock()
            .expect("previews lock")
            .get(&pid)
            .cloned()
        {
            return Ok(st);
        }
    }

    // Reconstruct from DB preview rows if process restarted
    let rw = rt
        .store
        .radar_get(radar_id)?
        .ok_or_else(|| CoreError::NotFound {
            entity: "radar",
            id: radar_id.to_string(),
        })?;
    let ver = rw.candidate_version.as_ref().unwrap_or(&rw.current_version);
    let rows = rt.store.list_preview_evaluations(&ver.id)?;
    let items: Vec<PreviewItem> = rows.iter().map(preview_eval_item_to_dto).collect();
    let warnings = compute_preview_warnings(&items, ver);

    Ok(PreviewRunState {
        preview_id: preview_id.unwrap_or("restored").to_string(),
        radar_id: radar_id.to_string(),
        radar_version: ver.version,
        status: PreviewStatus::Done,
        total_posts: items.len(),
        evaluated_posts: items.len(),
        items,
        warnings,
        error: None,
    })
}

fn save_preview_state(rt: &CoreRuntime, state: &PreviewRunState) {
    rt.latest_preview_by_radar
        .lock()
        .expect("latest preview lock")
        .insert(state.radar_id.clone(), state.preview_id.clone());
    rt.previews
        .lock()
        .expect("previews lock")
        .insert(state.preview_id.clone(), state.clone());
}

fn preview_eval_item_to_dto(item: &PendingAiEvaluationItem) -> PreviewItem {
    let fields = item
        .evaluation
        .fields
        .as_ref()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), extracted_field_from_store(v)))
                .collect()
        })
        .unwrap_or_default();

    PreviewItem {
        evaluation_id: item.evaluation.id.clone(),
        post_id: item.post.id.clone(),
        verdict: item
            .evaluation
            .verdict
            .clone()
            .unwrap_or_else(|| "no_match".to_string()),
        score: item.evaluation.score.unwrap_or(0.0),
        intent: PostIntent::from_db(item.evaluation.intent.as_deref()),
        author_role: AuthorRole::from_db(item.evaluation.author_role.as_deref()),
        summary: item.evaluation.summary.clone().unwrap_or_default(),
        reason: item.evaluation.reason.clone().unwrap_or_default(),
        decided_by: DecidedBy::from_db(item.evaluation.decided_by.as_deref()),
        fields,
        source_name: item.source_name.clone(),
        author_name: item
            .author_name
            .clone()
            .unwrap_or_else(|| "Ẩn danh".to_string()),
        permalink: item.post.permalink.clone(),
        post_text: item.post.text.clone().unwrap_or_default(),
        post_created_at: item.post.created_at,
        feedback_label: None,
    }
}

/// Compute the 3 preview quality warnings (`02-radar-spec.md §5`):
/// 1) `0` matches (`zero_matches`)
/// 2) `> 60%` of evaluated posts matched (`too_broad`)
/// 3) Required field missing on `> 70%` of matched posts (`missing_required_field`)
pub fn compute_preview_warnings(
    items: &[PreviewItem],
    radar_ver: &RadarVersionRecord,
) -> Vec<PreviewWarning> {
    if items.is_empty() {
        return vec![PreviewWarning {
            code: PreviewWarningCode::ZeroMatches,
            field_key: None,
            field_label: None,
            message:
                "Chưa có bài khớp trong mẫu thử. Hãy thử nới điều kiện hoặc thêm nhóm Facebook."
                    .to_string(),
        }];
    }

    let mut warnings = Vec::new();
    let matched: Vec<&PreviewItem> = items.iter().filter(|i| i.verdict == "match").collect();

    if matched.is_empty() {
        warnings.push(PreviewWarning {
            code: PreviewWarningCode::ZeroMatches,
            field_key: None,
            field_label: None,
            message: "Không có bài nào khớp — mô tả có thể quá hẹp hoặc nhóm chưa có bài phù hợp."
                .to_string(),
        });
        return warnings;
    }

    let match_ratio = matched.len() as f64 / items.len() as f64;
    if match_ratio > 0.60 {
        warnings.push(PreviewWarning {
            code: PreviewWarningCode::TooBroad,
            field_key: None,
            field_label: None,
            message: format!(
                "Có tới {:.0}% số bài khớp (> 60%) — mô tả radar quá rộng, có thể gây nhiều thông báo nhiễu.",
                match_ratio * 100.0
            ),
        });
    }

    for field in radar_ver.fields.iter().filter(|f| f.required) {
        let missing_count = matched
            .iter()
            .filter(|m| !m.fields.contains_key(&field.key))
            .count();
        let missing_ratio = missing_count as f64 / matched.len() as f64;
        if missing_ratio > 0.70 {
            warnings.push(PreviewWarning {
                code: PreviewWarningCode::MissingRequiredField,
                field_key: Some(field.key.clone()),
                field_label: Some(field.label.clone()),
                message: format!(
                    "Trường bắt buộc '{}' vắng mặt ở {:.0}% bài khớp — nên tắt bắt buộc hoặc chỉnh mô tả trường.",
                    field.label,
                    missing_ratio * 100.0
                ),
            });
        }
    }

    warnings
}

// ============================================================================
// Ruleset Lifecycle (`compile_ruleset`, `audit_ruleset`, `ruleset_save_user`)
// ============================================================================

/// Compile a declarative ruleset via AI (`AiBridge::compile_rules`), split labeled samples 80/20,
/// validate through `evaluate_gate_with_fields` (auto-pruning `< 90%` fields), and promote to
/// `shadow` on gate pass (`05-pipeline-rules.md §6.4`).
pub async fn run_compile_ruleset_for_version(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
) -> CoreResult<Option<RulesetRecord>> {
    let Some(radar_ver) = rt.store.radar_get_version(radar_version_id)? else {
        return Ok(None);
    };

    let all_samples = rt.store.get_labeled_dataset(radar_version_id)?;
    if all_samples.len() < 5 {
        return Ok(None);
    }

    // Deterministic 80% train (up to 120 sent to AI) / 20% holdout (never sent to AI!)
    let mut train_samples = Vec::new();
    let mut holdout_samples = Vec::new();
    for (idx, sample) in all_samples.into_iter().enumerate() {
        if idx % 5 == 4 {
            holdout_samples.push(sample);
        } else {
            train_samples.push(sample);
        }
    }
    if holdout_samples.is_empty() {
        if let Some(last) = train_samples.pop() {
            holdout_samples.push(last);
        }
    }

    let ai_train: Vec<AiLabeledSample> = train_samples
        .into_iter()
        .take(120)
        .map(|s| AiLabeledSample {
            post_text: s.post_text,
            is_match: s.is_match,
            author_role: s.author_role.as_deref().map(|r| match r {
                "peer" => AiAuthorRole::Peer,
                "end_user" => AiAuthorRole::EndUser,
                _ => AiAuthorRole::Unknown,
            }),
            expected_fields: s
                .fields
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| (k, v.value))
                .collect(),
        })
        .collect();

    let current_ruleset = rt
        .store
        .get_active_ruleset(radar_version_id)?
        .or(rt.store.get_shadow_ruleset(radar_version_id)?)
        .map(|r| r.body);

    let prompt_ctx = build_radar_prompt_context(rt, &radar_ver)?;
    let compile_input = CompileRulesInput {
        radar: prompt_ctx,
        labeled_samples: ai_train,
        current_ruleset,
        current_ruleset_errors: Vec::new(),
    };

    let task_res = {
        let _inflight = InflightAiGuard::acquire(rt);
        rt.ai_bridge.compile_rules(&compile_input).await
    };

    let now = now_ms();
    let task_res = match task_res {
        Ok(r) => r,
        Err(ai_err) => {
            let _ = rt.store.record_ai_call(&RecordAiCallInput {
                id: None,
                provider: rt.ai_bridge.provider_id().as_str().to_string(),
                model: None,
                task: "compile_rules".to_string(),
                radar_version_id: Some(radar_version_id.to_string()),
                item_count: compile_input.labeled_samples.len() as i64,
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                duration_ms: 0,
                status: ai_err.call_status().as_str().to_string(),
                error: Some(ai_err.to_string()),
                now_ms: now,
            });
            return Err(CoreError::Ai(ai_err));
        }
    };

    for call in &task_res.calls {
        let _ = rt.store.record_ai_call(&RecordAiCallInput {
            id: None,
            provider: call.provider.as_str().to_string(),
            model: call.model.clone(),
            task: call.task.as_str().to_string(),
            radar_version_id: call.radar_version_id.clone(),
            item_count: call.item_count as i64,
            input_tokens: call.input_tokens.map(|v| v as i64),
            output_tokens: call.output_tokens.map(|v| v as i64),
            cost_usd: call.cost_usd,
            duration_ms: call.duration_ms as i64,
            status: call.status.as_str().to_string(),
            error: call.error.clone(),
            now_ms: now,
        })?;
    }

    let candidate_body: EngineRulesetBody = serde_json::from_value(task_res.output)?;
    let rules_fields: Vec<dealsonar_rules::FieldDef> = radar_ver
        .fields
        .iter()
        .map(field_def_store_to_rules)
        .collect();
    let gate_holdout: Vec<GateLabeledSample> = holdout_samples
        .into_iter()
        .map(|s| GateLabeledSample {
            post_text: s.post_text,
            ref_ts_ms: now,
            is_match: s.is_match,
            expected_fields: s
                .fields
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| (k, v.value))
                .collect(),
        })
        .collect();

    let gate = evaluate_gate_with_fields(&candidate_body, &rules_fields, &gate_holdout);
    let rule_pct = (gate.self_handled_rate * 100.0).round();
    let metrics = RulesetMetrics {
        rule_handled_pct: rule_pct,
        ai_handled_pct: (100.0 - rule_pct).max(0.0),
        accept_precision: gate.accept_precision,
        false_negative_rate: gate.false_negative_rate,
        sample_size: gate.total_samples,
    };
    let metrics_val = serde_json::to_value(&metrics)?;

    // Insert as `candidate`, then promote to `shadow` if gate passed (`05-pipeline-rules.md §6.4`)
    let inserted = rt.store.insert_ruleset(&NewRulesetInput {
        id: None,
        radar_version_id: radar_version_id.to_string(),
        state: "candidate".to_string(),
        origin: "compiled".to_string(),
        body: serde_json::to_value(&gate.pruned_ruleset)?,
        metrics: Some(metrics_val.clone()),
        now_ms: now,
    })?;

    if gate.passed {
        let promoted =
            rt.store
                .update_ruleset_state(&inserted.id, "shadow", Some(&metrics_val), now)?;
        Ok(Some(promoted))
    } else {
        let retired =
            rt.store
                .update_ruleset_state(&inserted.id, "retired", Some(&metrics_val), now)?;
        Ok(Some(retired))
    }
}

/// Save a user-edited ruleset (`origin = "user"`), validating schema + regex safety + `< 1ms` execution
/// (`validate_ruleset`), and gating against holdout samples if enough labeled posts exist (`05-pipeline-rules.md §6.5`).
pub fn save_user_ruleset(
    rt: &CoreRuntime,
    radar_version_id: &str,
    dto_body: DtoRulesetBody,
    now: i64,
) -> CoreResult<Ruleset> {
    let radar_ver = rt
        .store
        .radar_get_version(radar_version_id)?
        .ok_or_else(|| CoreError::NotFound {
            entity: "radar_version",
            id: radar_version_id.to_string(),
        })?;

    let engine_body = dto_ruleset_body_to_rules(&dto_body);
    validate_ruleset(&engine_body)?;

    let labeled = rt.store.get_labeled_dataset(radar_version_id)?;
    let (target_state, final_body, metrics_opt) = if labeled.len() >= 10 {
        let rules_fields: Vec<_> = radar_ver
            .fields
            .iter()
            .map(field_def_store_to_rules)
            .collect();
        let gate_samples: Vec<_> = labeled
            .into_iter()
            .map(|s| GateLabeledSample {
                post_text: s.post_text,
                ref_ts_ms: now,
                is_match: s.is_match,
                expected_fields: s
                    .fields
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(k, v)| (k, v.value))
                    .collect(),
            })
            .collect();
        let gate = evaluate_gate_with_fields(&engine_body, &rules_fields, &gate_samples);
        let pct = (gate.self_handled_rate * 100.0).round();
        let m = serde_json::to_value(RulesetMetrics {
            rule_handled_pct: pct,
            ai_handled_pct: (100.0 - pct).max(0.0),
            accept_precision: gate.accept_precision,
            false_negative_rate: gate.false_negative_rate,
            sample_size: gate.total_samples,
        })?;
        let state = if gate.passed { "active" } else { "shadow" };
        (state, gate.pruned_ruleset, Some(m))
    } else {
        ("active", engine_body, None)
    };

    let saved = rt.store.insert_ruleset(&NewRulesetInput {
        id: None,
        radar_version_id: radar_version_id.to_string(),
        state: target_state.to_string(),
        origin: "user".to_string(),
        body: serde_json::to_value(&final_body)?,
        metrics: metrics_opt,
        now_ms: now,
    })?;

    Ok(ruleset_record_to_dto(&saved))
}

/// Audit a rule-decided evaluation batch (`audit_ruleset` daily 5% audit OR immediate audit on
/// negative user feedback against a rule-decided lead, `05-pipeline-rules.md §6.4`).
///
/// If 7-day disagreement exceeds `audit_disagreement_demote_threshold` (`8%`), demotes the
/// `active` ruleset back to `shadow` and schedules a fresh `compile_ruleset`!
pub async fn run_audit_ruleset(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
    ruleset_id: &str,
) -> CoreResult<bool> {
    let Some(radar_ver) = rt.store.radar_get_version(radar_version_id)? else {
        return Ok(false);
    };

    let queue_key = format!("runtime.audit_queue.{ruleset_id}");
    let eval_ids: Vec<String> = rt.store.get_setting(&queue_key)?.unwrap_or_default();

    if eval_ids.is_empty() {
        return Ok(false);
    }

    let batch_ids: Vec<String> = eval_ids.iter().take(30).cloned().collect();
    let batch_id_set: std::collections::HashSet<&str> =
        batch_ids.iter().map(String::as_str).collect();

    let mut evals_and_posts: Vec<(EvaluationRecord, dealsonar_store::models::PostDetail)> =
        Vec::new();
    for eid in &batch_ids {
        if let Some(ev) = rt.store.get_evaluation(eid)? {
            if let Some(pd) = rt.store.post_get(&ev.post_id)? {
                evals_and_posts.push((ev, pd));
            }
        }
    }
    if evals_and_posts.is_empty() {
        let mut latest_queue: Vec<String> = rt.store.get_setting(&queue_key)?.unwrap_or_default();
        latest_queue.retain(|id| !batch_id_set.contains(id.as_str()));
        if latest_queue.is_empty() {
            rt.store.delete_setting(&queue_key)?;
        } else {
            rt.store.set_setting(&queue_key, &latest_queue)?;
            let dedup = format!("audit_ruleset:{ruleset_id}");
            let cleanup_now = now_ms();
            let _ = rt.store.enqueue_job(
                "audit_ruleset",
                Some(&dedup),
                &serde_json::json!({
                    "radar_version_id": radar_version_id,
                    "ruleset_id": ruleset_id,
                }),
                cleanup_now.saturating_add(60_000),
                cleanup_now,
            )?;
        }
        return Ok(false);
    }

    let prompt_ctx = build_radar_prompt_context(rt, &radar_ver)?;
    let prompt_posts: Vec<PostPromptInput> = evals_and_posts
        .iter()
        .enumerate()
        .map(|(idx, (_ev, pd))| {
            PostPromptInput::sanitized(
                pd.post.id.clone(),
                u32::try_from(idx + 1).unwrap_or(1),
                pd.source_name.clone(),
                pd.author_name.clone(),
                None,
                None,
                pd.post.created_at,
                pd.post
                    .text_norm
                    .as_deref()
                    .or(pd.post.text.as_deref())
                    .unwrap_or(""),
                None,
            )
        })
        .collect();

    let report = {
        let _inflight = InflightAiGuard::acquire(rt);
        rt.ai_bridge
            .judge_extract_all(&prompt_ctx, &prompt_posts, &BatchConfig::default_live())
            .await?
    };

    let now = now_ms();

    // Only dequeue processed audit IDs AFTER `judge_extract_all` succeeds, preserving any IDs
    // beyond `.take(30)` as well as any IDs appended concurrently while AI was in flight!
    let mut latest_queue: Vec<String> = rt.store.get_setting(&queue_key)?.unwrap_or_default();
    latest_queue.retain(|id| !batch_id_set.contains(id.as_str()));
    if latest_queue.is_empty() {
        rt.store.delete_setting(&queue_key)?;
    } else {
        rt.store.set_setting(&queue_key, &latest_queue)?;
        let dedup = format!("audit_ruleset:{ruleset_id}");
        let _ = rt.store.enqueue_job(
            "audit_ruleset",
            Some(&dedup),
            &serde_json::json!({
                "radar_version_id": radar_version_id,
                "ruleset_id": ruleset_id,
            }),
            now.saturating_add(60_000),
            now,
        )?;
    }
    for call in &report.calls {
        let _ = rt.store.record_ai_call(&RecordAiCallInput {
            id: None,
            provider: call.provider.as_str().to_string(),
            model: call.model.clone(),
            task: call.task.as_str().to_string(),
            radar_version_id: call.radar_version_id.clone(),
            item_count: call.item_count as i64,
            input_tokens: call.input_tokens.map(|v| v as i64),
            output_tokens: call.output_tokens.map(|v| v as i64),
            cost_usd: call.cost_usd,
            duration_ms: call.duration_ms as i64,
            status: call.status.as_str().to_string(),
            error: call.error.clone(),
            now_ms: now,
        })?;
    }

    let rule_verdict_by_post: HashMap<&str, bool> = evals_and_posts
        .iter()
        .map(|(ev, pd)| (pd.post.id.as_str(), ev.verdict.as_deref() == Some("match")))
        .collect();

    let mut new_entries = Vec::new();
    for outcome in report.outcomes {
        if let PostEvalOutcome::Done { post_id, result } = outcome {
            if let Some(&rule_matched) = rule_verdict_by_post.get(post_id.as_str()) {
                new_entries.push(AuditHistoryEntry {
                    ts_ms: now,
                    disagreed: rule_matched != result.is_match,
                });
            }
        }
    }

    record_audit_entries_and_maybe_demote(rt, radar_version_id, ruleset_id, new_entries, now)
}

/// Immediate check triggered when a user marks negative feedback on a rule-decided lead (`05-pipeline-rules.md §6.4`:
/// "một bài người dùng đánh dấu sai mà bộ luật đã tự quyết sẽ kích hoạt kiểm tra ngay, không chờ chu kỳ").
pub fn handle_negative_feedback_on_rule_eval(
    rt: &Arc<CoreRuntime>,
    eval: &EvaluationRecord,
    now: i64,
) -> CoreResult<bool> {
    if eval.decided_by.as_deref() != Some("rule") {
        return Ok(false);
    }
    let ruleset_id = match eval.ruleset_id.clone() {
        Some(id) => id,
        None => match rt.store.get_active_ruleset(&eval.radar_version_id)? {
            Some(active) => active.id,
            None => return Ok(false),
        },
    };

    let demoted = record_audit_entries_and_maybe_demote(
        rt,
        &eval.radar_version_id,
        &ruleset_id,
        vec![AuditHistoryEntry {
            ts_ms: now,
            disagreed: true,
        }],
        now,
    )?;

    if !demoted {
        // Also trigger an immediate `audit_ruleset` run on recent rule-decided evaluations
        let dedup = format!("audit_ruleset:{ruleset_id}");
        rt.enqueue_and_wake_job(
            "audit_ruleset",
            Some(&dedup),
            &json!({
                "radar_version_id": eval.radar_version_id,
                "ruleset_id": ruleset_id,
            }),
            now,
        )?;
    }

    Ok(demoted)
}

fn record_audit_entries_and_maybe_demote(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
    ruleset_id: &str,
    new_entries: Vec<AuditHistoryEntry>,
    now: i64,
) -> CoreResult<bool> {
    if new_entries.is_empty() {
        return Ok(false);
    }
    let hist_key = format!("runtime.audit_history.{ruleset_id}");
    let since_7d = now.saturating_sub(7 * 86_400_000);
    let mut hist: Vec<AuditHistoryEntry> = rt.store.get_setting(&hist_key)?.unwrap_or_default();
    hist.retain(|e| e.ts_ms >= since_7d);
    hist.extend(new_entries);
    rt.store.set_setting(&hist_key, &hist)?;

    if hist.len() < rt.config.audit_min_samples {
        return Ok(false);
    }

    let disagreements = hist.iter().filter(|e| e.disagreed).count();
    let disagreement_rate = disagreements as f64 / hist.len() as f64;
    if disagreement_rate > rt.config.audit_disagreement_demote_threshold {
        if let Some(active) = rt.store.get_active_ruleset(radar_version_id)? {
            if active.id == ruleset_id {
                rt.store
                    .update_ruleset_state(ruleset_id, "shadow", None, now)?;
                let dedup = format!("compile_ruleset:{radar_version_id}");
                let _ = rt.enqueue_and_wake_job(
                    "compile_ruleset",
                    Some(&dedup),
                    &json!({ "radar_version_id": radar_version_id }),
                    now,
                )?;
                return Ok(true);
            }
        }
    }
    Ok(false)
}
