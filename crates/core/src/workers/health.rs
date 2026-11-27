//! Health monitor, crawl scheduler, and daily maintenance worker.

use super::*;

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

pub(super) fn is_within_active_hours(active_hours: &QuietHours, now: i64) -> bool {
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
