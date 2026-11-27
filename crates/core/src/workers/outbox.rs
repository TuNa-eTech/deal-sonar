//! Outbox delivery worker (Telegram & webhook).

use super::*;

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

pub(super) async fn deliver_single_outbox_item(
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

pub(super) fn parse_telegram_send_request(payload: &Value) -> CoreResult<SendMessageRequest> {
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
