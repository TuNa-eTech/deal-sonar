//! Background Tokio Workers (`03-desktop.md §2–3`, `07-notifications-export.md §2–6`):
//! 1. Durable `jobs` queue runner (`evaluate_batch`, `notify_lead`, `flush_digest`, `compile_ruleset`, `audit_ruleset`, `purge_expired`).
//! 2. Outbound `outbox` delivery worker (`TelegramClient` + `WebhookClient` with retries, rate limits, 2h expiry, and `AuthRevoked` handling).
//! 3. Long-polling Telegram `getUpdates` bot worker (`/start`, `fb:<lead_id>:<label>`, `/pause`, `/resume`, `/status`).
//! 4. Health monitor (`health:changed` + 30m incident alerts), 5m `CrawlPlan` scheduler, and daily license/audit/retention maintenance.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Local, TimeZone, Timelike};
use dealsonar_notify::{
    escape_html, format_digest_html, webhook_channel_key, BotStatusSummary, DigestLeadItem,
    InlineKeyboardMarkup, PollUpdatesOptions, SendMessageRequest, SystemIncidentKind,
    TelegramDeliveryOutcome, TelegramIncomingEvent, WebhookDeliveryOutcome,
    WebhookLeadCreatedPayload, MAX_OUTBOX_QUEUE_AGE_MS, TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::{Body, Envelope};
use dealsonar_store::models::{
    now_ms, EnqueueOutboxInput, JobRecord, OutboxRecord, RecordFeedbackInput,
};
use dealsonar_store::ops::default_job_retry_delay_ms;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::dto::{CoreEvent, FacebookSessionState, FeedbackLabel, JobFailedEvent, QuietHours};
use crate::error::{CoreError, CoreResult};
use crate::license::enforce_plan_limits_on_store;
use crate::pipeline::{load_lead_dto, run_evaluate_batch_for_version, schedule_evaluate_batch_job};
use crate::preview_rules::{
    handle_negative_feedback_on_rule_eval, run_audit_ruleset, run_compile_ruleset_for_version,
};
use crate::state::{start_of_local_day_ms, CoreRuntime};

/// Spawn all four background loops and return their `JoinHandle`s for graceful `shutdown()`.
pub fn spawn_all_workers(
    rt: &Arc<CoreRuntime>,
    shutdown_rx: &watch::Receiver<bool>,
) -> Vec<JoinHandle<()>> {
    vec![
        spawn_jobs_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_outbox_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_telegram_poller_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_health_and_maintenance_worker(Arc::clone(rt), shutdown_rx.clone()),
    ]
}

// ============================================================================
// 1. Durable Jobs Worker
// ============================================================================

pub fn spawn_jobs_worker(
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let boot_now = now_ms();
        let _ = rt
            .store
            .recover_stale_running_jobs(boot_now.saturating_sub(300_000), boot_now);

        let mut interval = tokio::time::interval(rt.config.job_poll_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = rt.job_wake.notified() => {}
                _ = interval.tick() => {}
            }

            if rt.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            if let Err(err) = tick_jobs_once(&rt).await {
                tracing::warn!(error = %err, "jobs worker tick error");
            }
        }
    })
}

/// Run one pass of pending-AI batch scheduling and claim/execute all currently due jobs.
pub async fn tick_jobs_once(rt: &Arc<CoreRuntime>) -> CoreResult<usize> {
    let now = now_ms();
    dispatch_due_followups(rt, now)?;

    // Check if any `pending_ai` batch reached `>= batch_trigger_count` or `>= batch_max_wait_ms`
    let pending_groups = rt.store.list_pending_ai_batches()?;
    for g in pending_groups {
        if g.is_preview {
            continue;
        }
        if g.count >= rt.config.batch_trigger_count
            || now.saturating_sub(g.oldest_created_at) >= rt.config.batch_max_wait_ms
        {
            schedule_evaluate_batch_job(rt, &g.radar_version_id, true, now)?;
        }
    }

    let mut processed = 0usize;
    while !rt.shutting_down.load(Ordering::SeqCst) {
        let now_step = now_ms();
        let Some(job) = rt.store.claim_due_job(now_step)? else {
            break;
        };

        let exec_res = execute_job(rt, &job).await;
        match exec_res {
            Ok(()) => {
                rt.store.complete_job(&job.id)?;
            }
            Err(err) => {
                let err_msg = err.to_string();
                let retry_delay = default_job_retry_delay_ms(&job.kind, job.attempts);
                let retry_at = retry_delay.map(|d| now_ms().saturating_add(d));
                let updated = rt.store.fail_or_retry_job(&job.id, &err_msg, retry_at)?;
                if updated.state == "failed" {
                    rt.emit(CoreEvent::JobFailed(JobFailedEvent {
                        job_id: updated.id,
                        kind: updated.kind,
                        error: err_msg,
                        failed_at: now_ms(),
                    }));
                }
            }
        }
        processed += 1;
    }

    Ok(processed)
}

/// Delivery is durable per scheduled timestamp; overdue work remains visible until completed.
pub fn dispatch_due_followups(rt: &Arc<CoreRuntime>, now: i64) -> CoreResult<usize> {
    let settings = rt.load_settings()?;
    let ids = rt.store.claim_due_followups(now)?;
    for id in &ids {
        if let Some(lead) = load_lead_dto(rt, id)? {
            rt.emit(CoreEvent::LeadReminder(lead.clone()));
            if settings.os_notifications_enabled {
                if let Some(hook) = rt
                    .os_notify_hook
                    .read()
                    .expect("notification hook")
                    .as_ref()
                {
                    hook(crate::state::OsNotification {
                        lead_id: lead.id,
                        radar_name: "Đến hạn liên hệ".into(),
                        summary: lead.summary,
                        group_name: lead.source_name,
                        permalink: lead.permalink,
                    });
                }
            }
        }
    }
    Ok(ids.len())
}

async fn execute_job(rt: &Arc<CoreRuntime>, job: &JobRecord) -> CoreResult<()> {
    match job.kind.as_str() {
        "evaluate_batch" => {
            let rvid = job
                .payload
                .get("radar_version_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::Validation("evaluate_batch missing radar_version_id".to_string())
                })?;
            let force_silent = job
                .payload
                .get("silent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            run_evaluate_batch_for_version(rt, rvid, force_silent).await?;
            Ok(())
        }
        "notify_lead" => {
            rt.outbox_wake.notify_one();
            let _ = process_due_outbox_batch(rt).await?;
            Ok(())
        }
        "flush_digest" => {
            let radar_id = job
                .payload
                .get("radar_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::Validation("flush_digest missing radar_id".to_string())
                })?;
            flush_digest_for_radar(rt, radar_id)?;
            Ok(())
        }
        "compile_ruleset" => {
            let rvid = job
                .payload
                .get("radar_version_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::Validation("compile_ruleset missing radar_version_id".to_string())
                })?;
            let _ = run_compile_ruleset_for_version(rt, rvid).await?;
            Ok(())
        }
        "audit_ruleset" => {
            let opt_rvid = job.payload.get("radar_version_id").and_then(Value::as_str);
            let opt_rsid = job.payload.get("ruleset_id").and_then(Value::as_str);
            if let (Some(rvid), Some(rsid)) = (opt_rvid, opt_rsid) {
                let _ = run_audit_ruleset(rt, rvid, rsid).await?;
            } else {
                let radars = rt.store.radar_list(false, now_ms())?;
                for rw in radars {
                    if rw.radar.status == "active" {
                        if let Some(active) = rt.store.get_active_ruleset(&rw.current_version.id)? {
                            let _ =
                                run_audit_ruleset(rt, &rw.current_version.id, &active.id).await?;
                        }
                    }
                }
            }
            Ok(())
        }
        "purge_expired" => {
            let settings = rt.load_settings()?;
            let now = now_ms();
            rt.store
                .purge_expired(now, settings.unmatched_retention_days)?;
            rt.store
                .cleanup_preview_evaluations(None, Some(now.saturating_sub(86_400_000)))?;
            Ok(())
        }
        other => Err(CoreError::Validation(format!("unknown job kind '{other}'"))),
    }
}

fn flush_digest_for_radar(rt: &Arc<CoreRuntime>, radar_id: &str) -> CoreResult<()> {
    let key = format!("runtime.digest_pending.{radar_id}");
    let pending_ids: Vec<String> = rt.store.get_setting(&key)?.unwrap_or_default();
    if pending_ids.is_empty() {
        return Ok(());
    }
    rt.store.delete_setting(&key)?;

    let Some(rw) = rt.store.radar_get(radar_id)? else {
        return Ok(());
    };
    if rw.radar.status != "active" {
        return Ok(());
    }

    let mut digest_items = Vec::new();
    for lid in &pending_ids {
        if let Some(detail) = rt.store.lead_get(lid)? {
            digest_items.push(DigestLeadItem {
                lead_id: detail.lead.id,
                summary: detail.lead.summary,
                score: detail.lead.score,
                source_name: Some(detail.source_name),
                permalink: Some(detail.permalink),
            });
        }
    }
    if digest_items.is_empty() {
        return Ok(());
    }

    digest_items.sort_by(|a, b| b.score.total_cmp(&a.score));
    let total = digest_items.len();
    let shown_slice = &digest_items[..total.min(10)];
    let remaining = total.saturating_sub(shown_slice.len());
    let html = format_digest_html(&rw.radar.name, shown_slice, remaining);

    let now = now_ms();
    let all_channels = rt.store.channel_list()?;
    let target_channels: Vec<_> = if !rw.radar.notify.channel_ids.is_empty() {
        all_channels
            .into_iter()
            .filter(|c| {
                c.kind == "telegram"
                    && c.state == "ok"
                    && rw.radar.notify.channel_ids.iter().any(|id| id == &c.id)
            })
            .collect()
    } else {
        all_channels
            .into_iter()
            .filter(|c| c.kind == "telegram" && c.state == "ok")
            .collect()
    };

    let mut queued = 0usize;
    for ch in target_channels {
        if let Some(chat_id) = ch.config.get("chat_id").and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| v.as_i64())
        }) {
            let req = SendMessageRequest::html(chat_id, html.clone(), None);
            rt.enqueue_outbox_tracked(&EnqueueOutboxInput {
                id: None,
                channel_id: ch.id,
                lead_id: None,
                kind: "digest".to_string(),
                payload: serde_json::to_value(&req)?,
                next_try_at: now,
                now_ms: now,
            })?;
            queued += 1;
        }
    }

    if queued > 0 {
        rt.outbox_wake.notify_one();
    }
    Ok(())
}

// ============================================================================
// 2. Outbox Delivery Worker (Telegram & Webhook)
// ============================================================================

pub fn spawn_outbox_worker(
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(rt.config.outbox_poll_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = rt.outbox_wake.notified() => {}
                _ = interval.tick() => {}
            }

            if rt.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            if let Err(err) = process_due_outbox_batch(&rt).await {
                tracing::warn!(error = %err, "outbox worker tick error");
            }
        }
    })
}

/// Drain and deliver all currently due `outbox` items on healthy channels.
pub async fn process_due_outbox_batch(rt: &Arc<CoreRuntime>) -> CoreResult<usize> {
    let mut delivered_or_handled = 0usize;

    while !rt.shutting_down.load(Ordering::SeqCst) {
        let now = now_ms();
        let Some(item) = rt.store.claim_due_outbox(now)? else {
            break;
        };

        deliver_single_outbox_item(rt, &item, now).await?;
        delivered_or_handled += 1;
    }

    Ok(delivered_or_handled)
}

async fn deliver_single_outbox_item(
    rt: &Arc<CoreRuntime>,
    item: &OutboxRecord,
    now: i64,
) -> CoreResult<()> {
    let Some(channel) = rt.store.channel_get(&item.channel_id)? else {
        let updated =
            rt.store
                .retry_or_drop_outbox(&item.id, "channel_deleted", None, 1, -1, now)?;
        rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
        return Ok(());
    };

    let prior_attempts = u32::try_from(item.attempts.saturating_sub(1).max(0)).unwrap_or(0);
    let queued_age_ms = now.saturating_sub(item.created_at).max(0);

    match channel.kind.as_str() {
        "telegram" => {
            let Some(token) = rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY)? else {
                let updated = rt.store.retry_or_drop_outbox(
                    &item.id,
                    "missing_telegram_bot_token",
                    Some(now.saturating_add(30_000)),
                    6,
                    MAX_OUTBOX_QUEUE_AGE_MS,
                    now,
                )?;
                rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                return Ok(());
            };

            let req = parse_telegram_send_request(&item.payload)?;
            let outcome = rt
                .telegram
                .deliver_outbox_message(&token, &req, prior_attempts, queued_age_ms)
                .await;

            let finished_now = now_ms();
            match outcome {
                TelegramDeliveryOutcome::Sent { message_id } => {
                    rt.store.mark_outbox_sent(
                        &item.id,
                        Some(&message_id.to_string()),
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, "sent")?;
                    if let Some(lid) = &item.lead_id {
                        if let Some(dto) = load_lead_dto(rt, lid)? {
                            rt.emit(CoreEvent::LeadUpdated(dto));
                        }
                    }
                }
                TelegramDeliveryOutcome::RateLimited { retry_after_s } => {
                    let next_ts = finished_now.saturating_add((retry_after_s as i64) * 1000);
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        "telegram_rate_limited",
                        Some(next_ts),
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
                TelegramDeliveryOutcome::RetryableNetwork { next_delay_s } => {
                    let next_ts = finished_now.saturating_add((next_delay_s as i64) * 1000);
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        "telegram_network_error",
                        Some(next_ts),
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
                TelegramDeliveryOutcome::AuthRevoked => {
                    rt.store.channel_set_state(&channel.id, "error")?;
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        "telegram_auth_revoked",
                        None,
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                    rt.emit_health_if_changed(finished_now)?;
                }
                TelegramDeliveryOutcome::Dropped { reason } => {
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        &reason,
                        None,
                        0,
                        -1, // Force `dropped` state
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
                TelegramDeliveryOutcome::PermanentFailure {
                    status_code,
                    description,
                } => {
                    let err_str = format!("HTTP {status_code}: {description}");
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        &err_str,
                        None,
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
            }
        }

        "webhook" => {
            let url = channel
                .config
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let secret_key = webhook_channel_key(&channel.id);
            let Some(secret) = rt.secrets.get_secret(&secret_key)? else {
                rt.store.channel_set_state(&channel.id, "error")?;
                let updated = rt.store.retry_or_drop_outbox(
                    &item.id,
                    "missing_webhook_secret",
                    None,
                    6,
                    MAX_OUTBOX_QUEUE_AGE_MS,
                    now,
                )?;
                rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                return Ok(());
            };

            let wh_payload: WebhookLeadCreatedPayload =
                serde_json::from_value(item.payload.clone())?;
            let outcome = rt
                .webhook
                .send_once(url, &secret, &wh_payload, prior_attempts)
                .await?;

            let finished_now = now_ms();
            match outcome {
                WebhookDeliveryOutcome::Sent { status_code } => {
                    rt.store.mark_outbox_sent(
                        &item.id,
                        Some(&format!("http:{status_code}")),
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, "sent")?;
                    if let Some(lid) = &item.lead_id {
                        if let Some(dto) = load_lead_dto(rt, lid)? {
                            rt.emit(CoreEvent::LeadUpdated(dto));
                        }
                    }
                }
                WebhookDeliveryOutcome::Retryable {
                    next_delay_s,
                    reason,
                } => {
                    let next_ts = finished_now.saturating_add((next_delay_s as i64) * 1000);
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        &reason,
                        Some(next_ts),
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
                WebhookDeliveryOutcome::Exhausted { reason } => {
                    let updated = rt.store.retry_or_drop_outbox(
                        &item.id,
                        &reason,
                        None,
                        6,
                        MAX_OUTBOX_QUEUE_AGE_MS,
                        finished_now,
                    )?;
                    rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
                }
            }
        }

        other => {
            let updated = rt.store.retry_or_drop_outbox(
                &item.id,
                &format!("unsupported channel kind '{other}'"),
                None,
                1,
                MAX_OUTBOX_QUEUE_AGE_MS,
                now,
            )?;
            rt.update_outbox_tracked_state(&item.id, &item.channel_id, &updated.state)?;
        }
    }

    Ok(())
}

fn parse_telegram_send_request(payload: &Value) -> CoreResult<SendMessageRequest> {
    let chat_id = payload
        .get("chat_id")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
        .ok_or_else(|| CoreError::Validation("telegram outbox missing chat_id".to_string()))?;
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation("telegram outbox missing text".to_string()))?
        .to_string();
    let reply_markup: Option<InlineKeyboardMarkup> = match payload.get("reply_markup") {
        Some(v) if !v.is_null() => Some(serde_json::from_value(v.clone())?),
        _ => None,
    };
    Ok(SendMessageRequest::html(chat_id, text, reply_markup))
}

// ============================================================================
// 3. Long-Polling Telegram `getUpdates` Worker (`07-notifications-export.md §2.3`)
// ============================================================================

pub fn spawn_telegram_poller_worker(
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if rt.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            let has_token = rt
                .secrets
                .get_secret(TELEGRAM_BOT_TOKEN_KEY)
                .ok()
                .flatten()
                .is_some();

            if !has_token {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(rt.config.telegram_poll_idle_sleep) => {}
                }
                continue;
            }

            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                res = poll_telegram_once(&rt) => {
                    if let Err(err) = res {
                        tracing::debug!(error = %err, "telegram poll_updates cycle error");
                        tokio::time::sleep(rt.config.telegram_poll_idle_sleep).await;
                    }
                }
            }
        }
    })
}

/// Run a single `poll_updates` cycle and process all returned bot commands & inline callbacks.
pub async fn poll_telegram_once(rt: &Arc<CoreRuntime>) -> CoreResult<usize> {
    let Some(token) = rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY)? else {
        return Ok(0);
    };

    let channels = rt.store.channel_list()?;
    let registered_chat_ids: HashSet<i64> = channels
        .iter()
        .filter(|c| c.kind == "telegram")
        .filter_map(|c| {
            c.config.get("chat_id").and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .or_else(|| v.as_i64())
            })
        })
        .collect();

    let offset: Option<i64> = rt.store.get_setting("telegram.update_offset")?;
    let bot_username: Option<String> = rt.store.get_setting("telegram.bot_username")?;

    let poll_res = rt
        .telegram
        .poll_updates(
            &token,
            &PollUpdatesOptions {
                offset,
                timeout_s: rt.config.telegram_poll_timeout_s,
                bot_username,
                registered_chat_ids,
            },
        )
        .await?;

    if let Some(next_off) = poll_res.next_offset {
        rt.store.set_setting("telegram.update_offset", &next_off)?;
    }

    let count = poll_res.events.len();
    for ev in poll_res.events {
        handle_telegram_incoming_event(rt, &token, ev).await?;
    }

    Ok(count)
}

async fn handle_telegram_incoming_event(
    rt: &Arc<CoreRuntime>,
    token: &str,
    event: TelegramIncomingEvent,
) -> CoreResult<()> {
    let now = now_ms();
    match event {
        TelegramIncomingEvent::StartCommand {
            chat_id,
            chat_title,
            is_group: _,
        } => {
            let chat_id_str = chat_id.to_string();
            let existing = rt.store.channel_list()?.into_iter().find(|c| {
                c.kind == "telegram"
                    && c.config
                        .get("chat_id")
                        .and_then(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .or_else(|| v.as_i64().map(|n| n.to_string()))
                        })
                        .as_deref()
                        == Some(chat_id_str.as_str())
            });

            let cfg = json!({
                "chat_id": chat_id_str,
                "chat_title": chat_title,
            });
            let display_name = if chat_title.trim().is_empty() {
                format!("Telegram {chat_id}")
            } else {
                chat_title.clone()
            };

            if let Some(ch) = existing {
                rt.store
                    .channel_upsert(&ch.id, "telegram", &display_name, &cfg, "ok", now)?;
            } else {
                rt.store
                    .channel_create("telegram", &display_name, &cfg, now)?;
            }

            let _ = rt
                .telegram
                .send_welcome_message(token, chat_id, &display_name)
                .await;
            rt.emit_health_if_changed(now)?;
        }

        TelegramIncomingEvent::LeadFeedback {
            chat_id: _,
            lead_id,
            label,
        } => {
            let Some(fb_label) = FeedbackLabel::from_db(&label) else {
                return Ok(());
            };
            let Some(detail) = rt.store.lead_get(&lead_id)? else {
                return Ok(());
            };

            rt.store.record_feedback(&RecordFeedbackInput {
                evaluation_id: detail.lead.evaluation_id.clone(),
                label: fb_label.as_str().to_string(),
                corrected_fields: None,
                post_text: detail.post_text.clone(),
                origin: "telegram".to_string(),
                now_ms: now,
            })?;
            rt.set_eval_feedback_label(&detail.lead.evaluation_id, fb_label.as_str())?;

            if fb_label.is_negative() {
                if let Some(eval_rec) = rt.store.get_evaluation(&detail.lead.evaluation_id)? {
                    let _ = handle_negative_feedback_on_rule_eval(rt, &eval_rec, now)?;
                }
            }

            if let Some(updated_lead) = load_lead_dto(rt, &lead_id)? {
                rt.emit(CoreEvent::LeadUpdated(updated_lead));
            }
        }

        TelegramIncomingEvent::PauseCommand { chat_id } => {
            rt.store
                .set_setting("telegram.notifications_paused", &true)?;
            let req = SendMessageRequest::html(
                chat_id,
                "⏸ <b>Đã tạm dừng thông báo Telegram.</b> Gửi /resume bất cứ lúc nào để bật lại.",
                None,
            );
            let _ = rt.telegram.deliver_outbox_message(token, &req, 0, 0).await;
        }

        TelegramIncomingEvent::ResumeCommand { chat_id } => {
            rt.store
                .set_setting("telegram.notifications_paused", &false)?;

            // Also resume crawling if paused (`02-extension.md §7`, `07-notifications-export.md §2.3`)
            let resumed_crawl = {
                let mut hub = rt.ipc_hub.state.lock().expect("ipc state lock");
                if hub.crawl_paused {
                    hub.crawl_paused = false;
                    hub.crawl_pause_reason = None;
                    hub.facebook_session = FacebookSessionState::Ok;
                    true
                } else {
                    false
                }
            };
            if resumed_crawl {
                rt.ipc_hub
                    .send_to_profile(None, &Envelope::new(Body::CrawlResume {}));
                rt.emit_health_if_changed(now)?;
            }

            let req = SendMessageRequest::html(
                chat_id,
                format!(
                    "▶️ <b>Đã bật lại thông báo Telegram{}</b>.",
                    escape_html(if resumed_crawl {
                        " và tiếp tục quét nhóm"
                    } else {
                        ""
                    })
                ),
                None,
            );
            let _ = rt.telegram.deliver_outbox_message(token, &req, 0, 0).await;
        }

        TelegramIncomingEvent::StatusCommand { chat_id } => {
            let health = rt.compute_health_status(now)?;
            let radars = rt.store.radar_list(false, now)?;
            let active_radars = radars.iter().filter(|r| r.radar.status == "active").count();
            let day_start = start_of_local_day_ms(now);
            let leads_page = rt
                .store
                .lead_list(&dealsonar_store::models::LeadListQuery {
                    unread_only: None,
                    follow_up_before: None,
                    exclude_weak: None,
                    radar_id: None,
                    status: None,
                    since: Some(day_start),
                    min_score: None,
                    search: None,
                    filters: Vec::new(),
                    sort: None,
                    limit: 500,
                    cursor: None,
                })?;
            let paused = rt
                .store
                .get_setting::<bool>("telegram.notifications_paused")?
                .unwrap_or(false);

            let ext_desc = if health.extension_connected {
                "Extension OK"
            } else {
                "Extension ngắt kết nối"
            };
            let health_summary = format!("{ext_desc}, FB {:?}", health.facebook_session);

            let _ = rt
                .telegram
                .send_status_reply(
                    token,
                    chat_id,
                    &BotStatusSummary {
                        active_radars,
                        leads_today: leads_page.items.len(),
                        health_summary,
                        notifications_paused: paused,
                    },
                )
                .await;
        }
    }
    Ok(())
}

// ============================================================================
// 4. Health Monitor, Crawl Scheduler & Daily Maintenance Worker
// ============================================================================

pub fn spawn_health_and_maintenance_worker(
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut health_tick = tokio::time::interval(rt.config.health_check_interval);
        health_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut sched_tick = tokio::time::interval(rt.config.scheduler_interval);
        sched_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut daily_tick = tokio::time::interval(Duration::from_secs(3_600));
        daily_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut last_daily_day: i64 = -1;

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = health_tick.tick() => {
                    if !rt.shutting_down.load(Ordering::SeqCst) {
                        if let Err(err) = check_health_and_incidents(&rt, now_ms()) {
                            tracing::warn!(error = %err, "health monitor check failed");
                        }
                    }
                }
                _ = sched_tick.tick() => {
                    if !rt.shutting_down.load(Ordering::SeqCst) && rt.ipc_hub.is_any_connected() {
                        let _ = rt.bump_and_push_config();
                    }
                }
                _ = daily_tick.tick() => {
                    if !rt.shutting_down.load(Ordering::SeqCst) {
                        let now = now_ms();
                        let day_bucket = now.div_euclid(86_400_000);
                        if day_bucket != last_daily_day {
                            last_daily_day = day_bucket;
                            let _ = run_daily_maintenance(&rt, now);
                        }
                    }
                }
            }
        }
    })
}

/// Evaluate 1-minute health invariants, 30-minute grace incident alerts, AI recovery requeue,
/// and flood recovery (`03-desktop.md §3`, `07-notifications-export.md §3`).
pub fn check_health_and_incidents(rt: &Arc<CoreRuntime>, now: i64) -> CoreResult<()> {
    let settings = rt.load_settings()?;
    let active_radars = rt.store.count_active_radars()?;

    // 1. Extension disconnected > 30m during active hours with active radars > 0
    let disconnected_since = {
        let hub = rt.ipc_hub.state.lock().expect("ipc state lock");
        if hub.connections.is_empty() {
            Some(hub.last_disconnected_at.unwrap_or(rt.started_at_ms))
        } else {
            None
        }
    };

    if let Some(disc_ts) = disconnected_since {
        let elapsed_ms = now.saturating_sub(disc_ts);
        if active_radars > 0
            && elapsed_ms >= rt.config.disconnect_alert_grace_ms
            && is_within_active_hours(&settings.crawl_policy.active_hours, now)
        {
            let should_alert = {
                let mut inc = rt.incidents.lock().expect("incidents lock");
                if !inc.ext_disconnected_alerted {
                    inc.ext_disconnected_alerted = true;
                    true
                } else {
                    false
                }
            };
            if should_alert {
                let _ = rt.queue_system_incident_alert(
                    &SystemIncidentKind::ExtensionDisconnected,
                    false,
                    now,
                );
            }
        }
    }

    // 2. AI unavailable > 30m with pending AI posts (or recovery requeue when AI healthy)
    let pending_groups = rt.store.list_pending_ai_batches()?;
    let pending_live: usize = pending_groups
        .iter()
        .filter(|g| !g.is_preview)
        .map(|g| g.count)
        .sum();

    let (ai_unavail_since, ai_healthy) = {
        let ai_guard = rt.ai_health.lock().expect("ai health lock");
        let healthy = ai_guard.last_error.is_none()
            && ai_guard.rate_limit_reset_at.is_none_or(|ts| ts <= now);
        (ai_guard.first_unavailable_at, healthy)
    };

    if ai_healthy {
        let requeued = rt.store.requeue_ai_failed_evaluations()?;
        if requeued > 0 {
            rt.job_wake.notify_one();
        }
        let was_alerted = {
            let mut inc = rt.incidents.lock().expect("incidents lock");
            if inc.ai_unavailable_alerted {
                inc.ai_unavailable_alerted = false;
                true
            } else {
                false
            }
        };
        if was_alerted {
            let _ = rt.queue_system_incident_alert(
                &SystemIncidentKind::AiUnavailable { pending_posts: 0 },
                true,
                now,
            );
        }
    } else if let Some(unavail_ts) = ai_unavail_since {
        let elapsed_ms = now.saturating_sub(unavail_ts);
        if pending_live > 0 && elapsed_ms >= rt.config.disconnect_alert_grace_ms {
            let should_alert = {
                let mut inc = rt.incidents.lock().expect("incidents lock");
                if !inc.ai_unavailable_alerted {
                    inc.ai_unavailable_alerted = true;
                    true
                } else {
                    false
                }
            };
            if should_alert {
                let _ = rt.queue_system_incident_alert(
                    &SystemIncidentKind::AiUnavailable {
                        pending_posts: pending_live,
                    },
                    false,
                    now,
                );
            }
        }
    }

    // 3. Clear flood auto-digest flags once a radar's hourly volume cools back down `<= 30`
    let flood_radars = rt.get_flood_auto_digest_radars()?;
    for rid in flood_radars {
        let last_hr = rt.store.count_leads_in_last_hour(&rid, now)? as usize;
        if last_hr <= dealsonar_notify::FLOOD_LEADS_PER_HOUR_THRESHOLD {
            rt.mark_radar_flood_auto_digest(&rid, false)?;
            rt.incidents
                .lock()
                .expect("incidents lock")
                .flood_alerted_radars
                .remove(&rid);
        }
    }

    rt.emit_health_if_changed(now)?;
    Ok(())
}

pub fn run_daily_maintenance(rt: &Arc<CoreRuntime>, now: i64) -> CoreResult<()> {
    // 1. Re-verify Ed25519 license expiry & auto-pause excess active radars if downgraded (`03-desktop.md §5`)
    let license = rt.current_license_status(now)?;
    let paused = enforce_plan_limits_on_store(&rt.store, &license.limits, now)?;
    if !paused.is_empty() {
        let _ = rt.bump_and_push_config();
    }

    // 2. Schedule daily 5% active ruleset audit
    let day = now.div_euclid(86_400_000);
    let audit_dedup = format!("audit_ruleset:{day}");
    let _ = rt.enqueue_and_wake_job("audit_ruleset", Some(&audit_dedup), &json!({}), now);

    // 3. Schedule daily expired post/lead retention purge
    let purge_dedup = format!("purge_expired:{day}");
    let _ = rt.enqueue_and_wake_job("purge_expired", Some(&purge_dedup), &json!({}), now);

    Ok(())
}

fn is_within_active_hours(active_hours: &QuietHours, now: i64) -> bool {
    let Some(dt) = Local.timestamp_millis_opt(now).single() else {
        return true;
    };
    let cur_mins = (dt.hour() * 60 + dt.minute()) as i32;
    let parse_hhmm = |s: &str| -> Option<i32> {
        let (h, m) = s.trim().split_once(':')?;
        Some(h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?)
    };
    let (Some(from_m), Some(to_m)) = (parse_hhmm(&active_hours.from), parse_hhmm(&active_hours.to))
    else {
        return true;
    };
    if from_m <= to_m {
        cur_mins >= from_m && cur_mins <= to_m
    } else {
        cur_mins >= from_m || cur_mins <= to_m
    }
}
