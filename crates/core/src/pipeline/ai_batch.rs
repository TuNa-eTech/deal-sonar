//! T5: AI batch evaluation jobs, prompt context, and ruleset auto-compile scheduling.

use super::*;

/// Schedule or wake `evaluate_batch:<radar_version_id>` per `05-pipeline-rules.md §7`.
pub fn schedule_evaluate_batch_job(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
    immediate: bool,
    now: i64,
) -> CoreResult<()> {
    let pending = rt.store.list_pending_ai_for_version(
        radar_version_id,
        false,
        rt.config.batch_trigger_count + 1,
    )?;
    if pending.is_empty() {
        return Ok(());
    }

    let oldest = pending
        .iter()
        .map(|p| p.evaluation.created_at)
        .min()
        .unwrap_or(now);
    let ready_now = immediate
        || pending.len() >= rt.config.batch_trigger_count
        || now.saturating_sub(oldest) >= rt.config.batch_max_wait_ms;

    let run_at = if ready_now {
        now
    } else {
        oldest.saturating_add(rt.config.batch_max_wait_ms)
    };

    let dedup_key = format!("evaluate_batch:{radar_version_id}");
    let _ = rt.store.enqueue_job(
        "evaluate_batch",
        Some(&dedup_key),
        &json!({
            "radar_version_id": radar_version_id,
            "silent": immediate,
        }),
        run_at,
        now,
    )?;

    if ready_now {
        rt.job_wake.notify_one();
    }
    Ok(())
}

/// Execute T5 AI batch evaluation (`judge_extract`) for `radar_version_id` (`05-pipeline-rules.md §7`).
pub async fn run_evaluate_batch_for_version(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
    force_silent: bool,
) -> CoreResult<usize> {
    if rt.shutting_down.load(Ordering::SeqCst) {
        return Err(CoreError::ShuttingDown);
    }

    let now = now_ms();
    // Honor active rate-limit backoff window
    {
        let guard = rt.ai_health.lock().expect("ai health lock");
        if let Some(reset_at) = guard.rate_limit_reset_at {
            if reset_at > now {
                let dedup = format!("evaluate_batch:{radar_version_id}");
                let _ = rt.store.enqueue_job(
                    "evaluate_batch",
                    Some(&dedup),
                    &json!({ "radar_version_id": radar_version_id, "silent": force_silent }),
                    reset_at,
                    now,
                )?;
                return Ok(0);
            }
        }
    }

    let settings = rt.load_settings()?;
    let daily_cap = i64::from(settings.daily_ai_post_cap);
    let used_today = rt.store.count_ai_items_today(now)?;
    if used_today >= daily_cap {
        let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
        let should_emit = {
            let mut guard = rt.ai_health.lock().expect("ai health lock");
            if guard.daily_cap_reached_date.as_deref() != Some(today_str.as_str()) {
                guard.daily_cap_reached_date = Some(today_str);
                true
            } else {
                false
            }
        };
        if should_emit {
            let _ = rt.emit_health_if_changed(now);
        }
        return Ok(0);
    }

    let remaining_budget = usize::try_from((daily_cap - used_today).max(1)).unwrap_or(50);
    let max_fetch = remaining_budget.min(60);
    let pending_items = rt
        .store
        .list_pending_ai_for_version(radar_version_id, false, max_fetch)?;
    if pending_items.is_empty() {
        return Ok(0);
    }

    let Some(radar_ver) = rt.store.radar_get_version(radar_version_id)? else {
        return Ok(0);
    };
    let Some(rw) = rt.store.radar_get(&radar_ver.radar_id)? else {
        return Ok(0);
    };

    let prompt_ctx = build_radar_prompt_context(rt, &radar_ver)?;
    let prompt_posts: Vec<PostPromptInput> = pending_items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let rule_hints = item.evaluation.fields.as_ref().and_then(|m| {
                if m.is_empty() {
                    None
                } else {
                    Some(
                        m.iter()
                            .map(|(k, v)| (k.clone(), v.value.clone()))
                            .collect(),
                    )
                }
            });
            let text_src = item
                .post
                .text_norm
                .as_deref()
                .or(item.post.text.as_deref())
                .unwrap_or("");
            PostPromptInput::sanitized(
                item.post.id.clone(),
                u32::try_from(idx + 1).unwrap_or(1),
                item.source_name.clone(),
                item.author_name.clone(),
                None, // Strip author.external_id (`06-ai-bridge.md §6`)
                None, // Strip permalink (`06-ai-bridge.md §6`)
                item.post.created_at,
                text_src,
                rule_hints,
            )
        })
        .collect();

    let batch_res = {
        let _inflight = InflightAiGuard::acquire(rt);
        rt.ai_bridge
            .judge_extract_all(&prompt_ctx, &prompt_posts, &BatchConfig::default_live())
            .await
    };

    let decided_now = now_ms();
    match batch_res {
        Err(ai_err) => {
            // Log failed AI call in `ai_calls`
            let _ = rt.store.record_ai_call(&RecordAiCallInput {
                id: None,
                provider: rt.ai_bridge.provider_id().as_str().to_string(),
                model: None,
                task: "judge_extract".to_string(),
                radar_version_id: Some(radar_version_id.to_string()),
                item_count: pending_items.len() as i64,
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                duration_ms: 0,
                status: ai_err.call_status().as_str().to_string(),
                error: Some(ai_err.to_string()),
                now_ms: decided_now,
            });

            {
                let mut guard = rt.ai_health.lock().expect("ai health lock");
                if let AiError::RateLimited { retry_after } = &ai_err {
                    let wait_ms = retry_after
                        .map(|d| i64::try_from(d.as_millis()).unwrap_or(60_000))
                        .unwrap_or(60_000)
                        .max(1_000);
                    guard.rate_limit_reset_at = Some(decided_now.saturating_add(wait_ms));
                } else {
                    guard.last_error = Some(ai_err.to_string());
                    if guard.first_unavailable_at.is_none() {
                        guard.first_unavailable_at = Some(decided_now);
                    }
                }
            }
            let _ = rt.emit_health_if_changed(decided_now);
            Err(CoreError::Ai(ai_err))
        }
        Ok(report) => {
            let mut last_call_id: Option<String> = None;
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
                    now_ms: decided_now,
                })?;
                last_call_id = Some(saved.id);
            }

            // Clear AI error state and recover any prior `ai_failed` items
            let was_alerted = {
                let mut ai_guard = rt.ai_health.lock().expect("ai health lock");
                ai_guard.last_error = None;
                ai_guard.rate_limit_reset_at = None;
                ai_guard.first_unavailable_at = None;

                let mut inc = rt.incidents.lock().expect("incidents lock");
                let prev = inc.ai_unavailable_alerted;
                inc.ai_unavailable_alerted = false;
                prev
            };
            if was_alerted {
                let _ = rt.queue_system_incident_alert(
                    &SystemIncidentKind::AiUnavailable { pending_posts: 0 },
                    true,
                    decided_now,
                );
            }
            let _ = rt.store.requeue_ai_failed_evaluations();
            let _ = rt.emit_health_if_changed(decided_now);

            let by_post_id: HashMap<&str, &_> = pending_items
                .iter()
                .map(|item| (item.post.id.as_str(), item))
                .collect();

            let mut processed_count = 0usize;
            for outcome in report.outcomes {
                match outcome {
                    PostEvalOutcome::AiFailed { post_id, error, .. } => {
                        if let Some(item) = by_post_id.get(post_id.as_str()) {
                            rt.store.mark_evaluation_ai_failed(
                                &item.evaluation.id,
                                last_call_id.as_deref(),
                                Some(&error),
                                decided_now,
                            )?;
                        }
                    }
                    PostEvalOutcome::Done { post_id, result } => {
                        let Some(item) = by_post_id.get(post_id.as_str()) else {
                            continue;
                        };

                        // Update shadow ruleset agreement metrics against AI ground truth
                        if let Some(shadow_rec) = rt.store.get_shadow_ruleset(radar_version_id)? {
                            let _ = reconcile_shadow_with_ai_truth(
                                rt,
                                &shadow_rec,
                                &post_id,
                                result.is_match,
                                decided_now,
                            );
                        }

                        // Merge T4 rule hints + AI extracted fields (AI takes precedence per key,
                        // and T6 `renormalize_field` ensures built-in extractors win on normalized values!)
                        let mut merged_candidates: BTreeMap<
                            String,
                            dealsonar_rules::ExtractedField,
                        > = BTreeMap::new();
                        if let Some(rule_hints) = &item.evaluation.fields {
                            for (k, v) in rule_hints {
                                if let Some(rf) = extracted_field_store_to_rules(v) {
                                    merged_candidates.insert(k.clone(), rf);
                                }
                            }
                        }
                        for (k, ef) in result.extracted_fields() {
                            merged_candidates.insert(k, extracted_field_ai_to_rules(&ef));
                        }

                        let intent = match result.intent {
                            DetectedIntent::Demand => PostIntent::Demand,
                            DetectedIntent::Supply => PostIntent::Supply,
                            DetectedIntent::Other => PostIntent::Other,
                        };
                        let author_role = match result.author_role {
                            AiAuthorRole::EndUser => AuthorRole::EndUser,
                            AiAuthorRole::Peer => AuthorRole::Peer,
                            AiAuthorRole::Unknown => AuthorRole::Unknown,
                        };
                        let text_norm = item
                            .post
                            .text_norm
                            .as_deref()
                            .or(item.post.text.as_deref())
                            .unwrap_or("");

                        let repost_after_72h = !item.post.is_cluster_head;
                        let mode = if force_silent {
                            EvalMode::BackfillSilent
                        } else {
                            EvalMode::Live { repost_after_72h }
                        };

                        finalize_candidate_evaluation(
                            rt,
                            &item.evaluation.id,
                            &item.post,
                            text_norm,
                            &rw.radar.id,
                            &rw.radar.name,
                            &rw.radar.status,
                            &rw.radar.notify,
                            &radar_ver,
                            CandidateDecision {
                                decided_by: "ai",
                                ruleset_id: None,
                                ai_call_id: last_call_id.clone(),
                                is_match: result.is_match,
                                raw_score: result.score,
                                intent,
                                author_role,
                                is_spam: result.is_spam,
                                summary: result.summary,
                                reason: result.reason,
                                candidate_fields: merged_candidates,
                            },
                            mode,
                            decided_now,
                        )?;
                        processed_count += 1;
                    }
                }
            }

            // Check if more pending items remain for this radar_version_id
            let remaining = rt
                .store
                .list_pending_ai_for_version(radar_version_id, false, 1)?;
            if !remaining.is_empty() {
                schedule_evaluate_batch_job(rt, radar_version_id, force_silent, decided_now)?;
            }

            // Auto-compile ruleset check (`Pro` plan: >= 150 AI evals, >= 20 matches, >= 30 new since last compile)
            maybe_schedule_auto_compile_ruleset(rt, radar_version_id, decided_now)?;

            Ok(processed_count)
        }
    }
}

/// Build [`RadarPromptContext`] with up to 8 balanced user feedback examples (`06-ai-bridge.md §5.2`).
pub fn build_radar_prompt_context(
    rt: &CoreRuntime,
    radar_ver: &RadarVersionRecord,
) -> CoreResult<RadarPromptContext> {
    let raw_examples = rt
        .store
        .get_prompt_feedback_examples(&radar_ver.id, 8)
        .unwrap_or_default();
    let feedback_examples: Vec<FeedbackExample> = raw_examples
        .into_iter()
        .map(|fb| {
            let is_positive = fb.expected_match;
            let author_role = (fb.label == "peer").then_some(AiAuthorRole::Peer);
            let corrected_fields = fb.corrected_fields.map(|m| {
                m.into_iter()
                    .map(|(k, v)| (k, v.value))
                    .collect::<BTreeMap<_, _>>()
            });
            FeedbackExample {
                is_positive,
                label: fb.label,
                post_text: fb.post_text,
                author_role,
                corrected_fields,
            }
        })
        .collect();

    let want_intent = match radar_ver.match_policy.want_intent.as_str() {
        "demand" => AiWantIntent::Demand,
        "supply" => AiWantIntent::Supply,
        _ => AiWantIntent::Any,
    };
    let exclude_roles = radar_ver
        .match_policy
        .exclude_roles
        .iter()
        .map(|r| match r.as_str() {
            "peer" => AiAuthorRole::Peer,
            "end_user" => AiAuthorRole::EndUser,
            _ => AiAuthorRole::Unknown,
        })
        .collect();

    Ok(RadarPromptContext {
        radar_version_id: radar_ver.id.clone(),
        description: radar_ver.description.clone(),
        user_profession: radar_ver.user_profession.clone(),
        language_hint: radar_ver.language_hint.clone(),
        want_intent,
        exclude_roles,
        fields: radar_ver.fields.iter().map(field_def_store_to_ai).collect(),
        feedback_examples,
    })
}

pub(super) fn maybe_schedule_auto_compile_ruleset(
    rt: &Arc<CoreRuntime>,
    radar_version_id: &str,
    now: i64,
) -> CoreResult<()> {
    let license = rt.current_license_status(now)?;
    if !license.limits.allow_auto_rulesets {
        return Ok(());
    }
    let (total_ai, matched_ai) = rt
        .store
        .count_ai_evaluations_for_version(radar_version_id)?;
    if total_ai < rt.config.auto_compile_min_ai_evals
        || matched_ai < rt.config.auto_compile_min_matches
    {
        return Ok(());
    }

    let last_cnt_key = format!("runtime.last_compile_ai_count.{radar_version_id}");
    let last_cnt: i64 = rt.store.get_setting(&last_cnt_key)?.unwrap_or(0);
    if last_cnt > 0 && total_ai.saturating_sub(last_cnt) < 30 {
        return Ok(());
    }

    rt.store.set_setting(&last_cnt_key, &total_ai)?;
    let dedup = format!("compile_ruleset:{radar_version_id}");
    rt.enqueue_and_wake_job(
        "compile_ruleset",
        Some(&dedup),
        &json!({ "radar_version_id": radar_version_id }),
        now,
    )?;
    Ok(())
}
