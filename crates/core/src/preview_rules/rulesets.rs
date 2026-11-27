//! Ruleset lifecycle: compile, user save, audit, and demotion (`05-pipeline-rules.md §6.4`).

use super::*;

/// Rolling 7-day audit ledger stored in `settings` (`runtime.audit_history.<ruleset_id>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct AuditHistoryEntry {
    pub ts_ms: i64,
    pub disagreed: bool,
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

pub(super) fn record_audit_entries_and_maybe_demote(
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
