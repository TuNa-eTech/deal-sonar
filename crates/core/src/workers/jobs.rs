//! Durable jobs worker.

use super::*;

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

pub(super) async fn execute_job(rt: &Arc<CoreRuntime>, job: &JobRecord) -> CoreResult<()> {
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

pub(super) fn flush_digest_for_radar(rt: &Arc<CoreRuntime>, radar_id: &str) -> CoreResult<()> {
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
