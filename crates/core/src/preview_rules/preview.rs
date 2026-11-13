//! Streaming radar preview (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`).

use super::*;

/// Start an interactive streaming preview run (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`).
///
/// - Selects up to `config.preview_max_posts` (`50`) recent stored posts across `source_ids`.
/// - If `< config.preview_min_posts_before_crawl` (`20`) posts exist and an extension is connected,
///   sends `crawl.request(reason = "preview", max_posts = 25)` to fetch live group posts.
/// - Runs T3–T4 (skipping T2 dedup so user sees duplicates too) + T5 AI in batches (default `3` posts),
///   emitting `preview:progress` after every chunk and computing the 3 quality warnings!
pub async fn start_radar_preview(
    rt: &Arc<CoreRuntime>,
    input: PreviewStartInput,
) -> CoreResult<PreviewRunState> {
    let now = now_ms();
    let license = rt.current_license_status(now)?;
    if input
        .fields
        .as_ref()
        .is_some_and(|fs| fs.len() > license.limits.max_fields_per_radar)
    {
        return Err(CoreError::Validation(
            "Số trường vượt giới hạn gói hiện tại.".into(),
        ));
    }
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

    let effective_ver = rt.store.radar_preview_snapshot(&effective_ver)?;

    let source_ids = input
        .source_ids
        .clone()
        .unwrap_or_else(|| rw.source_ids.clone());

    if source_ids.is_empty() {
        return Err(CoreError::Validation(
            "Hãy chọn ít nhất một group nguồn.".into(),
        ));
    }
    for id in &source_ids {
        if rt.store.source_get(id)?.is_none() {
            return Err(CoreError::NotFound {
                entity: "source",
                id: id.clone(),
            });
        }
    }
    let posts = rt
        .store
        .list_recent_posts_for_sources(&source_ids, rt.config.preview_max_posts)?;

    let preview_id = new_ulid();
    let initial_status = if posts.is_empty() {
        PreviewStatus::Crawling
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
        failed_posts: 0,
        items: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };

    // Reserve atomically before any asynchronous work; a second start must never
    // delete or overwrite evaluations belonging to the running preview.
    {
        let mut latest = rt
            .latest_preview_by_radar
            .lock()
            .expect("latest preview lock");
        let mut previews = rt.previews.lock().expect("previews lock");
        if latest
            .get(&state.radar_id)
            .and_then(|id| previews.get(id))
            .is_some_and(|p| {
                matches!(
                    p.status,
                    PreviewStatus::Crawling | PreviewStatus::Evaluating
                )
            })
        {
            return Err(CoreError::Validation(
                "Radar đang xem thử. Hãy dừng phiên hiện tại trước khi chạy lại.".into(),
            ));
        }
        latest.insert(state.radar_id.clone(), state.preview_id.clone());
        previews.insert(state.preview_id.clone(), state.clone());
    }
    let initial = state.clone();
    let running_id = initial.preview_id.clone();
    let (cancel_tx, mut cancelled) = tokio::sync::watch::channel(false);
    rt.preview_cancellations
        .lock()
        .expect("preview cancellations lock")
        .insert(running_id.clone(), cancel_tx);
    let mut shutdown = rt.shutdown_tx.subscribe();
    let rt = Arc::clone(rt);
    tokio::spawn(async move {
        let work = async {
            rt.store
                .cleanup_preview_evaluations(Some(&effective_ver.id), None)?;
            let mut posts = posts;
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

            // Empty local datasets wait briefly for the requested crawl. Never
            // claim a successful zero-result evaluation while crawling is pending.
            if posts.is_empty() && rt.ipc_hub.is_any_connected() {
                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    posts = rt
                        .store
                        .list_recent_posts_for_sources(&source_ids, rt.config.preview_max_posts)?;
                    if !posts.is_empty() {
                        break;
                    }
                }
            }
            state.total_posts = posts.len();
            if posts.is_empty() {
                return Err(CoreError::Validation("Chưa có bài để xem thử. Hãy kiểm tra kết nối Chrome và thu thập bài từ các group đã chọn, rồi chạy lại.".into()));
            }
            state.status = PreviewStatus::Evaluating;
            save_preview_state(&rt, &state);
            emit_preview_progress(&rt, &state, Vec::new());
            evaluate_preview_posts(&rt, &rw, &effective_ver, &posts, &mut state).await
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(300), work) => {
                result.unwrap_or_else(|_| Err(CoreError::Validation("Xem thử vượt quá 5 phút. Hãy kiểm tra AI và thử lại với ít bài hơn.".into())))
            }
            _ = async {
                let already_shutting_down = rt.shutting_down.load(std::sync::atomic::Ordering::SeqCst) || *shutdown.borrow_and_update();
                if !already_shutting_down { let _ = shutdown.changed().await; }
            } => Err(CoreError::ShuttingDown),
            _ = cancelled.changed() => Err(CoreError::Validation("Đã dừng xem thử.".into())),
        };
        if let Err(err) = result {
            state.status = PreviewStatus::Error;
            state.error = Some(err.to_string());
        }
        save_preview_state(&rt, &state);
        emit_preview_progress(&rt, &state, Vec::new());
        rt.preview_cancellations
            .lock()
            .expect("preview cancellations lock")
            .remove(&running_id);
    });
    Ok(initial)
}

pub async fn cancel_radar_preview(
    rt: &CoreRuntime,
    radar_id: &str,
    preview_id: &str,
) -> CoreResult<PreviewRunState> {
    let state = get_radar_preview(rt, radar_id, Some(preview_id))?;
    if let Some(cancel) = rt
        .preview_cancellations
        .lock()
        .expect("preview cancellations lock")
        .get(preview_id)
    {
        let _ = cancel.send(true);
    }
    if matches!(
        state.status,
        PreviewStatus::Crawling | PreviewStatus::Evaluating
    ) {
        loop {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let state = get_radar_preview(rt, radar_id, Some(preview_id))?;
            if !matches!(
                state.status,
                PreviewStatus::Crawling | PreviewStatus::Evaluating
            ) {
                return Ok(state);
            }
        }
    }
    Ok(state)
}

pub(super) fn emit_preview_progress(
    rt: &CoreRuntime,
    state: &PreviewRunState,
    new_items: Vec<PreviewItem>,
) {
    rt.emit(CoreEvent::PreviewProgress(PreviewProgressEvent {
        preview_id: state.preview_id.clone(),
        radar_id: state.radar_id.clone(),
        status: state.status,
        evaluated_posts: state.evaluated_posts,
        total_posts: state.total_posts,
        failed_posts: state.failed_posts,
        new_items,
        warnings: state.warnings.clone(),
        error: state.error.clone(),
    }));
}

pub(super) async fn evaluate_preview_posts(
    rt: &Arc<CoreRuntime>,
    rw: &dealsonar_store::models::RadarWithVersion,
    effective_ver: &RadarVersionRecord,
    posts: &[dealsonar_store::models::PostRecord],
    state: &mut PreviewRunState,
) -> CoreResult<()> {
    let now = now_ms();
    // Step 1: Run T3–T4 synchronously across all selected posts (T2 dedup intentionally skipped!)
    let mut done_immediately = Vec::new();
    for post in posts {
        let norm = normalize_text(post.text.as_deref().unwrap_or(""));
        let eval = evaluate_post_for_radar_sync(
            rt,
            post,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            effective_ver,
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
        save_preview_state(rt, state);
        emit_preview_progress(rt, state, new_items);
    }

    // Step 2: Evaluate `pending_ai` preview posts in streaming batches of `preview_batch_size` (default 3)
    let pending_preview = rt.store.list_pending_ai_for_version(
        &effective_ver.id,
        true,
        rt.config.preview_max_posts,
    )?;

    let post_ids: std::collections::HashSet<_> = posts.iter().map(|p| p.id.as_str()).collect();
    let pending_preview: Vec<_> = pending_preview
        .into_iter()
        .filter(|it| post_ids.contains(it.post.id.as_str()))
        .collect();
    if !pending_preview.is_empty() {
        let prompt_ctx = build_radar_prompt_context(rt, effective_ver)?;
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

            let batch_started = std::time::Instant::now();
            let batch_res = {
                let _inflight = InflightAiGuard::acquire(rt);
                rt.ai_bridge
                    .judge_extract_all(&prompt_ctx, &prompt_posts, &BatchConfig::default_preview())
                    .await
            };

            let chunk_now = now_ms();
            match batch_res {
                Err(ai_err) => {
                    let call = rt.store.record_ai_call(&RecordAiCallInput {
                        id: None,
                        provider: rt.ai_bridge.provider_id().as_str().into(),
                        model: None,
                        task: "judge_extract".into(),
                        radar_version_id: Some(effective_ver.id.clone()),
                        item_count: chunk.len() as i64,
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        duration_ms: batch_started.elapsed().as_millis() as i64,
                        status: ai_err.call_status().as_str().into(),
                        error: Some(ai_err.to_string()),
                        now_ms: chunk_now,
                    })?;
                    for item in chunk {
                        rt.store.mark_evaluation_ai_failed(
                            &item.evaluation.id,
                            Some(&call.id),
                            Some(&ai_err.to_string()),
                            chunk_now,
                        )?;
                    }
                    state.failed_posts += chunk.len();
                    return Err(ai_err.into());
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
                                state.failed_posts += 1;
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
                                    effective_ver,
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
                    save_preview_state(rt, state);

                    emit_preview_progress(rt, state, chunk_items);
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
    state.status = if state.failed_posts == 0 {
        PreviewStatus::Done
    } else {
        PreviewStatus::Error
    };
    if state.failed_posts > 0 {
        state.error = Some(format!("{} bài không chấm được. Kết quả đã hoàn tất vẫn được giữ; hãy kiểm tra AI và chạy lại.", state.failed_posts));
    }
    state.warnings = if state.failed_posts == 0 {
        compute_preview_warnings(&state.items, effective_ver)
    } else {
        Vec::new()
    };
    Ok(())
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
        let existing = rt
            .previews
            .lock()
            .expect("previews lock")
            .get(&pid)
            .cloned();
        if let Some(mut st) = existing {
            if st.radar_id != radar_id {
                return Err(CoreError::Validation(
                    "Phiên xem thử không thuộc Radar này.".into(),
                ));
            }
            let labels = rt.get_eval_feedback_labels()?;
            for item in &mut st.items {
                item.feedback_label = labels
                    .get(&item.evaluation_id)
                    .and_then(|label| crate::dto::FeedbackLabel::from_db(label));
            }
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
    let failed_posts = rows
        .iter()
        .filter(|r| r.evaluation.state == "ai_failed")
        .count();
    let incomplete = rows.iter().any(|r| r.evaluation.state != "done");
    let items: Vec<PreviewItem> = rows
        .iter()
        .filter(|r| r.evaluation.state == "done")
        .map(preview_eval_item_to_dto)
        .collect();
    let warnings = compute_preview_warnings(&items, ver);

    Ok(PreviewRunState {
        preview_id: preview_id.unwrap_or("restored").to_string(),
        radar_id: radar_id.to_string(),
        radar_version: ver.version,
        status: if incomplete {
            PreviewStatus::Error
        } else {
            PreviewStatus::Done
        },
        total_posts: rows.len(),
        failed_posts,
        evaluated_posts: items.len(),
        items,
        warnings,
        error: incomplete.then(|| "Phiên xem thử bị gián đoạn. Hãy chạy lại.".into()),
    })
}

pub(super) fn save_preview_state(rt: &CoreRuntime, state: &PreviewRunState) {
    rt.latest_preview_by_radar
        .lock()
        .expect("latest preview lock")
        .insert(state.radar_id.clone(), state.preview_id.clone());
    rt.previews
        .lock()
        .expect("previews lock")
        .insert(state.preview_id.clone(), state.clone());
}

pub(super) fn preview_eval_item_to_dto(item: &PendingAiEvaluationItem) -> PreviewItem {
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
