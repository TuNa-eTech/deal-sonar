//! Lead notification routing (Telegram, webhook, and OS fallback).

use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn route_lead_notifications(
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
