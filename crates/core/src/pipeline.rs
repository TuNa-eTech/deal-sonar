//! Full T0–T7 Post Ingestion, Ruleset/AI Evaluation, Postfilter, and Lead Creation Pipeline
//! (`05-pipeline-rules.md §2–9`, `06-ai-bridge.md`, `07-notifications-export.md §2–4`).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use chrono::{Local, TimeZone, Timelike};
use dealsonar_ai_bridge::{
    AiError, AuthorRole as AiAuthorRole, BatchConfig, DetectedIntent, FeedbackExample,
    PostEvalOutcome, PostPromptInput, RadarPromptContext, WantIntent as AiWantIntent,
};
use dealsonar_notify::{
    evaluate_notify_policy, format_lead_alert, LeadAlertInput, NotifyDecision, NotifyPolicyCheck,
    QuietHours as NotifyQuietHours, SendMessageRequest, SystemIncidentKind,
    WebhookLeadCreatedPayload, TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::RawPost;
use dealsonar_rules::{
    classify_lead_tier, compile_ruleset_unchecked, evaluate_hard_filters, extract_vn_phone,
    normalize_text, postprocess_fields, run_basic_prefilter, BasicPrefilterInput, LeadDisposition,
    NormalizedText, RulesetBody as EngineRulesetBody, RulesetOutcome, DEDUP_WINDOW_MS,
    NEAR_DUP_MAX_HAMMING, NEAR_DUP_MIN_CHARS,
};
use dealsonar_store::models::{
    extract_e164_phones_light, now_ms, AuthorInput, CreateLeadInput, EnqueueOutboxInput,
    EvaluationDoneInput, EvaluationRecord, EvaluationUpsertInput,
    ExtractedField as StoreExtractedField, NewPost, PostRecord, RadarVersionRecord,
    RadarWithVersion, RecordAiCallInput, SourceRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dto::{
    extracted_field_ai_to_rules, extracted_field_from_store, extracted_field_rules_to_store,
    extracted_field_store_to_rules, extracted_fields_store_to_notify, field_def_store_to_ai,
    field_def_store_to_notify, field_def_store_to_rules, hard_filters_store_to_rules,
};
use crate::dto::{
    AlsoSeenSource, AuthorRole, CoreEvent, DecidedBy, FeedbackLabel, Lead, LeadStatus, PostIntent,
    RulesetMetrics,
};
use crate::error::{CoreError, CoreResult};
use crate::state::{CoreRuntime, InflightAiGuard, OsNotification};

/// Pipeline execution mode for a single `(post, radar_version)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalMode {
    /// Normal live ingestion (`is_preview = false`, notifications enabled).
    Live { repost_after_72h: bool },
    /// Silent 24h backfill on `paused -> active` (`is_preview = false`, notifications suppressed).
    BackfillSilent,
    /// Interactive preview (`is_preview = true`, T2 skipped, no leads or notifications).
    Preview,
}

impl EvalMode {
    pub fn is_preview(&self) -> bool {
        matches!(self, Self::Preview)
    }

    pub fn is_silent_or_preview(&self) -> bool {
        matches!(self, Self::BackfillSilent | Self::Preview)
    }

    pub fn repost_after_72h(&self) -> bool {
        matches!(
            self,
            Self::Live {
                repost_after_72h: true
            }
        )
    }
}

/// Result of ingesting a single [`RawPost`] through T0–T4.
#[derive(Debug, Clone)]
pub enum IngestPostOutcome {
    /// Post `(platform, post_id)` was already stored; skipped idempotently.
    DuplicateStored(PostRecord),
    /// Newly stored post attached to an existing `< 72h` duplicate cluster (`also_seen_in` updated).
    ClusterDuplicate(PostRecord),
    /// Newly stored post processed synchronously through T3–T4 across subscribed active radars.
    Processed(PostRecord),
}

impl IngestPostOutcome {
    pub fn was_inserted(&self) -> bool {
        !matches!(self, Self::DuplicateStored(_))
    }
}

/// Persistent shadow evaluation tracker stored in `settings` (`runtime.shadow.<ruleset_id>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShadowTrackerState {
    pub total_evaluated: usize,
    pub rule_self_handled: usize,
    pub definite_match_total: usize,
    pub definite_match_correct: usize,
    pub positive_truth_total: usize,
    pub positive_falsely_rejected: usize,
    /// Pending predictions (`post_id -> "match" | "no_match" | "uncertain"`) awaiting T5 AI truth.
    #[serde(default)]
    pub pending_predictions: HashMap<String, String>,
}

/// Candidate match/no-match judgment entering T6 Postfilter (from either T4 Ruleset or T5 AI).
#[derive(Debug, Clone)]
pub struct CandidateDecision {
    pub decided_by: &'static str, // "rule" | "ai"
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub is_match: bool,
    pub raw_score: f64,
    pub intent: PostIntent,
    pub author_role: AuthorRole,
    pub is_spam: bool,
    pub summary: String,
    pub reason: String,
    pub candidate_fields: BTreeMap<String, dealsonar_rules::ExtractedField>,
}

/// Deterministic 5% audit sampler based on SHA-256 / FNV byte mix of `post_id`.
pub fn should_sample_for_audit(post_id: &str, percent: u8) -> bool {
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in post_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (hash % 100) < u64::from(percent)
}

/// Extract union of all Vietnamese E.164 phone numbers in `text_norm`.
pub fn collect_e164_phones(text_norm: &str) -> Vec<String> {
    let mut out = extract_e164_phones_light(text_norm);
    for m in extract_vn_phone(text_norm) {
        if let Some(s) = m.value.as_str() {
            if !out.iter().any(|existing| existing == s) {
                out.push(s.to_string());
            }
        }
    }
    out
}

/// T0–T4 synchronous ingestion for a single [`RawPost`] (`05-pipeline-rules.md §2–6`).
pub fn ingest_raw_post(
    rt: &Arc<CoreRuntime>,
    source: &SourceRecord,
    raw: &RawPost,
    now: i64,
) -> CoreResult<IngestPostOutcome> {
    // T1: Normalize text, language detection, content_hash, and 64-bit SimHash
    let norm = normalize_text(&raw.text);
    let phones = collect_e164_phones(&norm.text_norm);

    let attachments_val = if raw.attachments.is_empty() {
        None
    } else {
        Some(serde_json::to_value(&raw.attachments)?)
    };
    let counts_val = raw.counts.as_ref().map(serde_json::to_value).transpose()?;

    // T0: Idempotent post + author upsert
    let new_post = NewPost {
        id: None,
        platform: raw.platform.clone(),
        external_id: raw.post_id.clone(),
        source_id: source.id.clone(),
        author: Some(AuthorInput {
            external_id: raw.author.external_id.clone(),
            name: raw.author.name.clone(),
            is_anonymous: raw.author.is_anonymous,
        }),
        permalink: raw.permalink.clone(),
        text: Some(raw.text.clone()),
        text_norm: Some(norm.text_norm.clone()),
        text_fold: Some(norm.text_fold.clone()),
        text_truncated: raw.text_truncated,
        lang: Some(norm.lang.clone()),
        content_hash: norm.content_hash.clone(),
        simhash: norm.simhash,
        attachments: attachments_val,
        counts: counts_val,
        extracted_phones: phones.clone(),
        created_at: raw.created_at,
        captured_at: raw.captured_at,
        strategy: raw.extraction.strategy.as_str().to_string(),
    };

    let (post, inserted) = rt.store.insert_post(&new_post)?;
    if !inserted {
        return Ok(IngestPostOutcome::DuplicateStored(post));
    }

    if !phones.is_empty() {
        let _ = rt.store.record_post_phones(&post.id, &phones)?;
    }

    // Active radars watching this source
    let active_radars = rt.store.list_active_radars_for_source(&source.id)?;

    // T2: Exact (`content_hash`, 14d) + Near-duplicate (`simhash` Hamming <= 3, >= 80 chars, 14d)
    let since_14d = post.captured_at.saturating_sub(DEDUP_WINDOW_MS);
    let matched_dup = if let Some(exact) =
        rt.store
            .find_exact_dup_excluding(&post.content_hash, since_14d, Some(&post.id))?
    {
        Some(exact)
    } else if norm.text_norm.chars().count() >= NEAR_DUP_MIN_CHARS {
        rt.store
            .find_simhash_dups_excluding(
                post.simhash,
                NEAR_DUP_MAX_HAMMING,
                since_14d,
                Some(&post.id),
            )?
            .into_iter()
            .next()
            .map(|m| m.post)
    } else {
        None
    };

    let mut repost_after_72h = false;
    if let Some(matched) = matched_dup {
        let attach = rt
            .store
            .create_or_attach_dup_cluster(&matched.id, &post.id)?;
        for updated_lead_id in &attach.updated_lead_ids {
            if let Ok(Some(lead_dto)) = load_lead_dto(rt, updated_lead_id) {
                rt.emit(CoreEvent::LeadUpdated(lead_dto));
            }
        }

        if !attach.is_repost_after_72h {
            // Within 72h: record `dedup / duplicate` evaluation per active radar for funnel stats and stop!
            for rw in &active_radars {
                let _ = rt.store.upsert_evaluation(&EvaluationUpsertInput {
                    id: None,
                    post_id: post.id.clone(),
                    radar_version_id: rw.current_version.id.clone(),
                    state: "done".to_string(),
                    decided_by: Some("dedup".to_string()),
                    verdict: Some("no_match".to_string()),
                    reject_reason: Some("duplicate".to_string()),
                    score: Some(0.0),
                    intent: None,
                    author_role: None,
                    summary: None,
                    reason: Some("Bài đăng trùng trong cụm 72 giờ".to_string()),
                    fields: None,
                    ruleset_id: None,
                    ai_call_id: None,
                    is_preview: false,
                    created_at: now,
                    decided_at: Some(now),
                })?;
            }
            return Ok(IngestPostOutcome::ClusterDuplicate(post));
        }
        repost_after_72h = true;
    }

    // Refresh post row if cluster attachment mutated `dup_cluster_id` / `is_cluster_head`
    let post_current = rt.store.post_get(&post.id)?.map(|d| d.post).unwrap_or(post);

    // T3–T4 per subscribed active radar
    for rw in &active_radars {
        evaluate_post_for_radar_sync(
            rt,
            &post_current,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            &rw.current_version,
            EvalMode::Live { repost_after_72h },
            now,
        )?;
    }

    Ok(IngestPostOutcome::Processed(post_current))
}

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

fn build_rule_match_summary(text_norm: &str) -> String {
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

#[allow(clippy::too_many_arguments)]
fn route_lead_notifications(
    rt: &Arc<CoreRuntime>,
    lead: &dealsonar_store::models::LeadRecord,
    post: &PostRecord,
    source_name: &str,
    author_name: &str,
    radar_id: &str,
    radar_name: &str,
    radar_status: &str,
    radar_notify: &dealsonar_store::models::NotifyConfig,
    radar_version: &RadarVersionRecord,
    mode: EvalMode,
    now: i64,
) -> CoreResult<()> {
    let settings = rt.load_settings()?;
    let global_paused = rt
        .store
        .get_setting::<bool>("telegram.notifications_paused")?
        .unwrap_or(false);

    // Resolve channels attached to radar (or all healthy channels if `channel_ids` is empty and channels exist)
    let all_channels = rt.store.channel_list()?;
    let target_channels: Vec<_> = if !radar_notify.channel_ids.is_empty() {
        all_channels
            .iter()
            .filter(|c| c.state == "ok" && radar_notify.channel_ids.iter().any(|id| id == &c.id))
            .cloned()
            .collect()
    } else {
        all_channels
            .iter()
            .filter(|c| c.state == "ok")
            .cloned()
            .collect()
    };

    let has_telegram_configured = all_channels.iter().any(|c| c.kind == "telegram")
        && rt
            .secrets
            .get_secret(TELEGRAM_BOT_TOKEN_KEY)
            .ok()
            .flatten()
            .is_some();

    // OS desktop notification fallback when Telegram is not configured (`07-notifications-export.md §4`)
    let six_hours_ms = 6 * 3_600_000i64;
    if !has_telegram_configured
        && settings.os_notifications_enabled
        && !mode.is_silent_or_preview()
        && radar_status == "active"
        && now.saturating_sub(post.captured_at) <= six_hours_ms
    {
        if let Some(hook) = rt.os_notify_hook.read().expect("os hook lock").clone() {
            hook(OsNotification {
                lead_id: lead.id.clone(),
                radar_name: radar_name.to_string(),
                summary: lead.summary.clone(),
                group_name: source_name.to_string(),
                permalink: post.permalink.clone(),
            });
        }
    }

    if global_paused || target_channels.is_empty() {
        return Ok(());
    }

    // Local hour/minute for quiet hours check
    let (local_hour, local_minute) = Local
        .timestamp_millis_opt(now)
        .single()
        .map(|dt| (dt.hour() as u8, dt.minute() as u8))
        .unwrap_or((12, 0));

    let effective_quiet = radar_notify
        .quiet_hours
        .as_ref()
        .map(|q| NotifyQuietHours {
            from: q.from.clone(),
            to: q.to.clone(),
        })
        .or_else(|| {
            settings.quiet_hours_enabled.then(|| NotifyQuietHours {
                from: settings.quiet_hours.from.clone(),
                to: settings.quiet_hours.to.clone(),
            })
        });

    let leads_in_last_hour = rt.store.count_leads_in_last_hour(radar_id, now)? as usize;
    let flood_set = rt.get_flood_auto_digest_radars()?;
    let is_digest_mode = radar_notify.mode == "digest" || flood_set.contains(radar_id);

    let policy_decision = evaluate_notify_policy(&NotifyPolicyCheck {
        radar_active: radar_status == "active",
        has_channels: !target_channels.is_empty(),
        digest_mode: is_digest_mode,
        score: lead.score,
        min_score: radar_notify.min_score,
        is_cluster_head: post.is_cluster_head,
        repost_after_72h: mode.repost_after_72h(),
        captured_at_ms: post.captured_at,
        decided_at_ms: now,
        quiet_hours: effective_quiet.as_ref(),
        local_hour,
        local_minute,
        is_preview_or_backfill: mode.is_silent_or_preview(),
        leads_in_last_hour,
    });

    match policy_decision {
        NotifyDecision::Skip(_) => Ok(()),
        NotifyDecision::QueueDigest {
            trigger_flood_auto_digest,
        } => {
            if trigger_flood_auto_digest {
                rt.mark_radar_flood_auto_digest(radar_id, true)?;
                let mut inc = rt.incidents.lock().expect("incidents lock");
                if inc.flood_alerted_radars.insert(radar_id.to_string()) {
                    drop(inc);
                    let _ = rt.queue_system_incident_alert(
                        &SystemIncidentKind::RadarFloodAutoDigest {
                            radar_name: radar_name.to_string(),
                            leads_last_hour: leads_in_last_hour,
                        },
                        false,
                        now,
                    );
                }
            }
            rt.enqueue_digest_lead(radar_id, &lead.id, now)?;
            Ok(())
        }
        NotifyDecision::SendInstant { .. } => {
            let notify_field_defs: Vec<_> = radar_version
                .fields
                .iter()
                .map(field_def_store_to_notify)
                .collect();
            let notify_extracted = extracted_fields_store_to_notify(&lead.fields);

            let mut queued_any = false;
            for ch in target_channels {
                match ch.kind.as_str() {
                    "telegram" => {
                        let Some(chat_id) = ch.config.get("chat_id").and_then(|v| {
                            v.as_str()
                                .and_then(|s| s.parse::<i64>().ok())
                                .or_else(|| v.as_i64())
                        }) else {
                            continue;
                        };
                        let alert = format_lead_alert(&LeadAlertInput {
                            lead_id: lead.id.clone(),
                            radar_name: radar_name.to_string(),
                            summary: lead.summary.clone(),
                            field_defs: notify_field_defs.clone(),
                            extracted_fields: notify_extracted.clone(),
                            group_name: source_name.to_string(),
                            author_name: Some(author_name.to_string()),
                            post_created_at_ms: post.created_at,
                            now_ms: now,
                            other_group_count: lead.also_seen_in.len(),
                            permalink: post.permalink.clone(),
                        })?;
                        let req =
                            SendMessageRequest::html(chat_id, alert.html, Some(alert.reply_markup));
                        rt.enqueue_outbox_tracked(&EnqueueOutboxInput {
                            id: None,
                            channel_id: ch.id,
                            lead_id: Some(lead.id.clone()),
                            kind: "lead".to_string(),
                            payload: serde_json::to_value(&req)?,
                            next_try_at: now,
                            now_ms: now,
                        })?;
                        queued_any = true;
                    }
                    "webhook" => {
                        let include_text = ch
                            .config
                            .get("include_post_text")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let wh_payload = WebhookLeadCreatedPayload::new_lead_created(
                            now,
                            radar_id,
                            radar_name,
                            &lead.id,
                            lead.score,
                            &lead.summary,
                            &notify_extracted,
                            &post.permalink,
                            post.created_at,
                            source_name,
                            author_name,
                            include_text.then(|| post.text.clone()).flatten(),
                        );
                        rt.enqueue_outbox_tracked(&EnqueueOutboxInput {
                            id: None,
                            channel_id: ch.id,
                            lead_id: Some(lead.id.clone()),
                            kind: "lead".to_string(),
                            payload: serde_json::to_value(&wh_payload)?,
                            next_try_at: now,
                            now_ms: now,
                        })?;
                        queued_any = true;
                    }
                    _ => {}
                }
            }

            if queued_any {
                let dedup = format!("notify_lead:{}", lead.id);
                let _ = rt.store.enqueue_job(
                    "notify_lead",
                    Some(&dedup),
                    &json!({ "lead_id": lead.id }),
                    now,
                    now,
                )?;
                rt.outbox_wake.notify_one();
                rt.job_wake.notify_one();
            }
            Ok(())
        }
    }
}

/// Record a shadow ruleset's T4 prediction so it can be compared against T5 AI truth.
fn record_shadow_prediction(
    rt: &CoreRuntime,
    shadow_ruleset_id: &str,
    post_id: &str,
    outcome: &RulesetOutcome,
) -> CoreResult<()> {
    let key = format!("runtime.shadow.{shadow_ruleset_id}");
    let mut tracker: ShadowTrackerState = rt.store.get_setting(&key)?.unwrap_or_default();
    let pred = match outcome {
        RulesetOutcome::DefiniteMatch { .. } => "match",
        RulesetOutcome::PrefilterReject | RulesetOutcome::DefiniteNoMatch { .. } => "no_match",
        RulesetOutcome::Uncertain { .. } => "uncertain",
    };
    if tracker.pending_predictions.len() >= 1_000 {
        tracker.pending_predictions.clear();
    }
    tracker
        .pending_predictions
        .insert(post_id.to_string(), pred.to_string());
    rt.store.set_setting(&key, &tracker)?;
    Ok(())
}

/// Compare shadow ruleset's prediction against AI's ground-truth verdict and promote `shadow -> active`
/// once thresholds (`>= shadow_min_posts` OR `>= shadow_min_age_ms`) are satisfied (`05-pipeline-rules.md §6.4`).
pub fn reconcile_shadow_with_ai_truth(
    rt: &CoreRuntime,
    shadow_rec: &dealsonar_store::models::RulesetRecord,
    post_id: &str,
    ai_is_match: bool,
    now: i64,
) -> CoreResult<bool> {
    let key = format!("runtime.shadow.{}", shadow_rec.id);
    let mut tracker: ShadowTrackerState = rt.store.get_setting(&key)?.unwrap_or_default();
    let Some(pred) = tracker.pending_predictions.remove(post_id) else {
        return Ok(false);
    };

    tracker.total_evaluated += 1;
    if pred != "uncertain" {
        tracker.rule_self_handled += 1;
    }
    if pred == "match" {
        tracker.definite_match_total += 1;
        if ai_is_match {
            tracker.definite_match_correct += 1;
        }
    }
    if ai_is_match {
        tracker.positive_truth_total += 1;
        if pred == "no_match" {
            tracker.positive_falsely_rejected += 1;
        }
    }

    let rule_pct = if tracker.total_evaluated > 0 {
        ((tracker.rule_self_handled as f64 / tracker.total_evaluated as f64) * 100.0).round()
    } else {
        0.0
    };
    let accept_precision = if tracker.definite_match_total > 0 {
        tracker.definite_match_correct as f64 / tracker.definite_match_total as f64
    } else {
        1.0
    };
    let false_negative_rate = if tracker.positive_truth_total > 0 {
        tracker.positive_falsely_rejected as f64 / tracker.positive_truth_total as f64
    } else {
        0.0
    };

    let metrics = RulesetMetrics {
        rule_handled_pct: rule_pct,
        ai_handled_pct: (100.0 - rule_pct).max(0.0),
        accept_precision,
        false_negative_rate,
        sample_size: tracker.total_evaluated,
    };
    let metrics_val = serde_json::to_value(&metrics)?;
    rt.store.set_setting(&key, &tracker)?;

    let ready_by_count = tracker.total_evaluated >= rt.config.shadow_min_posts;
    let ready_by_age = tracker.total_evaluated >= 10
        && now.saturating_sub(shadow_rec.created_at) >= rt.config.shadow_min_age_ms;

    if ready_by_count || ready_by_age {
        if accept_precision >= dealsonar_rules::GATE_MIN_ACCEPT_PRECISION
            && false_negative_rate <= dealsonar_rules::GATE_MAX_FALSE_NEGATIVE_RATE
        {
            rt.store
                .update_ruleset_state(&shadow_rec.id, "active", Some(&metrics_val), now)?;
            return Ok(true);
        } else if ready_by_count {
            // Failed shadow promotion gate -> retire
            rt.store
                .update_ruleset_state(&shadow_rec.id, "retired", Some(&metrics_val), now)?;
            return Ok(false);
        }
    }

    rt.store
        .update_ruleset_state(&shadow_rec.id, "shadow", Some(&metrics_val), now)?;
    Ok(false)
}

fn enqueue_audit_sample(
    rt: &CoreRuntime,
    radar_version_id: &str,
    ruleset_id: &str,
    evaluation_id: &str,
    now: i64,
) -> CoreResult<()> {
    let key = format!("runtime.audit_queue.{ruleset_id}");
    let mut queue: Vec<String> = rt.store.get_setting(&key)?.unwrap_or_default();
    if queue.len() < 30 && !queue.iter().any(|id| id == evaluation_id) {
        queue.push(evaluation_id.to_string());
        rt.store.set_setting(&key, &queue)?;
    }

    let dedup = format!("audit_ruleset:{ruleset_id}");
    let _ = rt.store.enqueue_job(
        "audit_ruleset",
        Some(&dedup),
        &json!({
            "radar_version_id": radar_version_id,
            "ruleset_id": ruleset_id,
        }),
        now.saturating_add(60_000),
        now,
    )?;
    Ok(())
}

fn maybe_schedule_auto_compile_ruleset(
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

/// Convert a [`RadarWithVersion`] + post list into silent 24h backfill (`02-radar-spec.md §4`).
pub async fn run_silent_backfill_24h(
    rt: &Arc<CoreRuntime>,
    rw: &RadarWithVersion,
    now: i64,
) -> CoreResult<usize> {
    if rw.source_ids.is_empty() {
        return Ok(0);
    }
    let since_24h = now.saturating_sub(24 * 3_600_000);
    let posts =
        rt.store
            .list_recent_posts_for_sources_since(&rw.source_ids, Some(since_24h), 200)?;
    if posts.is_empty() {
        return Ok(0);
    }

    let mut queued_ai = false;
    let mut evaluated = 0usize;
    for post in &posts {
        // Skip non-head cluster duplicates
        if !post.is_cluster_head {
            continue;
        }
        let raw_text = post.text.as_deref().unwrap_or("");
        let norm = normalize_text(raw_text);
        let eval = evaluate_post_for_radar_sync(
            rt,
            post,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            &rw.current_version,
            EvalMode::BackfillSilent,
            now,
        )?;
        evaluated += 1;
        if eval.state == "pending_ai" {
            queued_ai = true;
        }
    }

    if queued_ai {
        let _ = run_evaluate_batch_for_version(rt, &rw.current_version.id, true).await?;
    }
    Ok(evaluated)
}
