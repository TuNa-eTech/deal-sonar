//! Long-polling Telegram `getUpdates` worker (`07-notifications-export.md §2.3`).

use super::*;

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

pub(super) async fn handle_telegram_incoming_event(
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
