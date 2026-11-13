//! T6–T7: postfilter, hard filters, scoring, and lead creation.

use super::*;

/// Execute T6 Postfilter (`verify_evidence`, `renormalize_field`, behavioral `peer` override,
/// `want_intent`, `hard_filters`, score tiers) and T7 Lead Creation + Notification Routing!
#[allow(clippy::too_many_arguments)]
pub fn finalize_candidate_evaluation(
    rt: &Arc<CoreRuntime>,
    evaluation_id: &str,
    post: &PostRecord,
    text_norm: &str,
    radar_id: &str,
    radar_name: &str,
    radar_status: &str,
    radar_notify: &dealsonar_store::models::NotifyConfig,
    radar_version: &RadarVersionRecord,
    decision: CandidateDecision,
    mode: EvalMode,
    now: i64,
) -> CoreResult<EvaluationRecord> {
    let rules_field_defs: Vec<dealsonar_rules::FieldDef> = radar_version
        .fields
        .iter()
        .map(field_def_store_to_rules)
        .collect();
    let ref_ts_ms = post.created_at.unwrap_or(post.captured_at);

    // T6 Step 1 & 2: Evidence check + built-in renormalization
    let postprocessed = postprocess_fields(
        text_norm,
        &rules_field_defs,
        &decision.candidate_fields,
        ref_ts_ms,
    );

    let store_fields: BTreeMap<String, StoreExtractedField> = postprocessed
        .fields
        .iter()
        .map(|(k, v)| (k.clone(), extracted_field_rules_to_store(v)))
        .collect();

    // Collect phones from both post ingestion and extracted `phone` fields for peer detection & contacts
    let mut all_phones = post.extracted_phones.clone();
    for def in &radar_version.fields {
        if def.r#type == dealsonar_store::models::FieldType::Phone {
            if let Some(ef) = store_fields.get(&def.key) {
                if let Some(s) = ef.value.as_str() {
                    if !all_phones.iter().any(|p| p == s) {
                        all_phones.push(s.to_string());
                    }
                }
            }
        }
    }

    // T6 Step 3: Behavioral peer signals (`>= 5` posts/7d, `>= 4` cluster sources, `>= 3` phone authors)
    let peer_signals = rt.store.get_peer_signals(&post.id, &all_phones, now)?;
    let effective_role = if peer_signals.is_peer_override {
        AuthorRole::Peer
    } else {
        decision.author_role
    };

    // Spam check
    if decision.is_spam {
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: if decision.is_match {
                    "postfilter".to_string()
                } else {
                    decision.decided_by.to_string()
                },
                verdict: "no_match".to_string(),
                reject_reason: Some("spam".to_string()),
                score: Some(0.0),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some(effective_role.as_str().to_string()),
                summary: Some(decision.summary),
                reason: Some(decision.reason),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // Exclude peer role if configured in `match_policy.exclude_roles`
    let excludes_peer = radar_version
        .match_policy
        .exclude_roles
        .iter()
        .any(|r| r == "peer");
    if excludes_peer && effective_role == AuthorRole::Peer {
        let reason = if peer_signals.is_peer_override && decision.author_role != AuthorRole::Peer {
            format!(
                "Ghi đè người cùng nghề theo hành vi ({} tín hiệu: {} bài/7n, {} nhóm trùng, {} tác giả dùng chung SĐT)",
                peer_signals.signal_count,
                peer_signals.author_followed_posts_7d,
                peer_signals.cluster_source_count,
                peer_signals.max_distinct_authors_for_phone
            )
        } else {
            decision.reason
        };
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: if decision.is_match {
                    "postfilter".to_string()
                } else {
                    decision.decided_by.to_string()
                },
                verdict: "no_match".to_string(),
                reject_reason: Some("peer".to_string()),
                score: Some(0.0),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some("peer".to_string()),
                summary: Some(decision.summary),
                reason: Some(reason),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // Non-match from AI/Rule
    if !decision.is_match {
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: decision.decided_by.to_string(),
                verdict: "no_match".to_string(),
                reject_reason: Some("irrelevant".to_string()),
                score: Some(decision.raw_score.clamp(0.0, 0.39)),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some(effective_role.as_str().to_string()),
                summary: Some(decision.summary),
                reason: Some(decision.reason),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // Check `want_intent` (`demand`, `supply`, `any`)
    let intent_ok = match radar_version.match_policy.want_intent.as_str() {
        "demand" => decision.intent == PostIntent::Demand,
        "supply" => decision.intent == PostIntent::Supply,
        _ => matches!(decision.intent, PostIntent::Demand | PostIntent::Supply),
    };
    if !intent_ok {
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: "postfilter".to_string(),
                verdict: "no_match".to_string(),
                reject_reason: Some("irrelevant".to_string()),
                score: Some(0.2),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some(effective_role.as_str().to_string()),
                summary: Some(decision.summary),
                reason: Some(format!(
                    "Chiều bài đăng ({}) không khớp yêu cầu radar ({})",
                    decision.intent.as_str(),
                    radar_version.match_policy.want_intent
                )),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // T6 Step 4: Hard filters (`05-pipeline-rules.md §8.4`)
    let rules_hard_filters = hard_filters_store_to_rules(&radar_version.match_policy.hard_filters);
    if !evaluate_hard_filters(&rules_hard_filters, &postprocessed.fields) {
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: "postfilter".to_string(),
                verdict: "no_match".to_string(),
                reject_reason: Some("hard_filter".to_string()),
                score: Some(decision.raw_score),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some(effective_role.as_str().to_string()),
                summary: Some(decision.summary),
                reason: Some("Không đạt điều kiện lọc cứng (hard_filters)".to_string()),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // T6 Step 5: Score threshold after required-field evidence penalty (`-0.2` per dropped required field)
    let adjusted_score = (decision.raw_score - postprocessed.score_penalty).clamp(0.0, 1.0);
    let min_score = radar_notify.min_score;
    let disposition = classify_lead_tier(adjusted_score, min_score);

    if disposition == LeadDisposition::Discard {
        return Ok(rt.store.mark_evaluation_done(
            evaluation_id,
            &EvaluationDoneInput {
                decided_by: if postprocessed.score_penalty > 0.0 {
                    "postfilter".to_string()
                } else {
                    decision.decided_by.to_string()
                },
                verdict: "no_match".to_string(),
                reject_reason: Some("irrelevant".to_string()),
                score: Some(adjusted_score),
                intent: Some(decision.intent.as_str().to_string()),
                author_role: Some(effective_role.as_str().to_string()),
                summary: Some(decision.summary),
                reason: Some(decision.reason),
                fields: Some(store_fields),
                ruleset_id: decision.ruleset_id,
                ai_call_id: decision.ai_call_id,
                decided_at: now,
            },
        )?);
    }

    // Mark evaluation `done / match`
    let eval_done = rt.store.mark_evaluation_done(
        evaluation_id,
        &EvaluationDoneInput {
            decided_by: decision.decided_by.to_string(),
            verdict: "match".to_string(),
            reject_reason: None,
            score: Some(adjusted_score),
            intent: Some(decision.intent.as_str().to_string()),
            author_role: Some(effective_role.as_str().to_string()),
            summary: Some(decision.summary.clone()),
            reason: Some(decision.reason.clone()),
            fields: Some(store_fields.clone()),
            ruleset_id: decision.ruleset_id,
            ai_call_id: decision.ai_call_id,
            decided_at: now,
        },
    )?;

    // Preview mode stops before T7 lead creation & notifications (`05-pipeline-rules.md §10`)
    if mode.is_preview() {
        return Ok(eval_done);
    }

    // T7: Create Lead + Contact Linking + Notification Routing (`05-pipeline-rules.md §9`)
    let post_detail = rt.store.post_get(&post.id)?;
    let author_display_name = post_detail
        .as_ref()
        .and_then(|d| d.author_name.clone())
        .unwrap_or_else(|| "Ẩn danh".to_string());
    let source_name = post_detail
        .as_ref()
        .map(|d| d.source_name.clone())
        .unwrap_or_default();

    // Link / upsert Contact by E.164 phone first, then author_id
    let contact_opt = rt.store.upsert_contact_from_lead(
        post.author_id.as_deref(),
        Some(author_display_name.as_str()),
        &all_phones,
        now,
    )?;

    let (lead_rec, lead_inserted) = rt.store.create_lead(&CreateLeadInput {
        id: None,
        radar_id: radar_id.to_string(),
        radar_version_id: radar_version.id.clone(),
        post_id: post.id.clone(),
        evaluation_id: eval_done.id.clone(),
        contact_id: contact_opt.as_ref().map(|c| c.id.clone()),
        status: "new".to_string(),
        score: adjusted_score,
        summary: decision.summary.clone(),
        fields: store_fields.clone(),
        also_seen_in: None,
        notified_at: None,
        follow_up_at: None,
        note: None,
        tags: Some(Vec::new()),
        now_ms: now,
    })?;

    if !lead_inserted {
        return Ok(eval_done);
    }

    // Notification routing (`CreateAndNotify` only; `CreateWeakOnly` stays silent in Inbox!)
    if disposition == LeadDisposition::CreateAndNotify {
        route_lead_notifications(
            rt,
            &lead_rec,
            post,
            &source_name,
            &author_display_name,
            radar_id,
            radar_name,
            radar_status,
            radar_notify,
            radar_version,
            mode,
            now,
        )?;
    }

    if let Some(lead_dto) = load_lead_dto(rt, &lead_rec.id)? {
        rt.emit(CoreEvent::LeadNew(lead_dto));
    }

    Ok(eval_done)
}

/// Load a complete [`Lead`] DTO from the store by `lead_id`.
pub fn load_lead_dto(rt: &CoreRuntime, lead_id: &str) -> CoreResult<Option<Lead>> {
    let Some(detail) = rt.store.lead_get(lead_id)? else {
        return Ok(None);
    };
    let min_score = rt
        .store
        .radar_get(&detail.lead.radar_id)?
        .map(|rw| rw.radar.notify.min_score)
        .unwrap_or(0.6);

    let feedback_label = detail
        .events
        .iter()
        .rev()
        .find(|ev| ev.kind == "feedback")
        .and_then(|ev| ev.data.as_ref())
        .and_then(|d| d.get("label"))
        .and_then(Value::as_str)
        .and_then(FeedbackLabel::from_db)
        .or_else(|| {
            rt.get_eval_feedback_labels()
                .ok()
                .and_then(|m| m.get(&detail.lead.evaluation_id).cloned())
                .as_deref()
                .and_then(FeedbackLabel::from_db)
        });

    Ok(Some(lead_detail_to_lead_dto(
        &detail,
        min_score,
        feedback_label,
    )))
}

pub fn lead_detail_to_lead_dto(
    detail: &dealsonar_store::models::LeadDetail,
    min_score: f64,
    feedback_label: Option<FeedbackLabel>,
) -> Lead {
    let fields = detail
        .lead
        .fields
        .iter()
        .map(|(k, v)| (k.clone(), extracted_field_from_store(v)))
        .collect();
    let also_seen_in = detail
        .lead
        .also_seen_in
        .iter()
        .map(|e| AlsoSeenSource {
            source_id: e.source_id.clone(),
            source_name: e.source_name.clone(),
            permalink: e.permalink.clone(),
            captured_at: e.captured_at,
        })
        .collect();

    Lead {
        id: detail.lead.id.clone(),
        radar_id: detail.lead.radar_id.clone(),
        radar_name: detail.radar_name.clone(),
        radar_version_id: detail.lead.radar_version_id.clone(),
        radar_version: detail.evaluation.radar_version,
        post_id: detail.lead.post_id.clone(),
        evaluation_id: detail.lead.evaluation_id.clone(),
        contact_id: detail.lead.contact_id.clone(),
        status: LeadStatus::from_db(&detail.lead.status),
        read_at: detail.lead.read_at,
        score: detail.lead.score,
        is_weak_match: detail.lead.score < min_score,
        summary: detail.lead.summary.clone(),
        reason: detail.evaluation.reason.clone(),
        decided_by: DecidedBy::from_db(detail.evaluation.decided_by.as_deref()),
        fields,
        source_id: detail.source_id.clone(),
        source_name: detail.source_name.clone(),
        author_id: detail.author_id.clone(),
        author_name: detail
            .author_name
            .clone()
            .unwrap_or_else(|| "Ẩn danh".to_string()),
        permalink: detail.permalink.clone(),
        post_created_at: detail.post_created_at,
        also_seen_in,
        notified_at: detail.lead.notified_at,
        follow_up_at: detail.lead.follow_up_at,
        note: detail.lead.note.clone(),
        tags: detail.lead.tags.clone(),
        feedback_label,
        created_at: detail.lead.created_at,
        updated_at: detail.lead.updated_at,
    }
}
