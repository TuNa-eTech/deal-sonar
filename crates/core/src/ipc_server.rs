//! Multi-Profile Local IPC Server (`01-protocol.md`, `02-extension.md §6–7`, `03-desktop.md §3`).
//!
//! Accepts concurrent connections from one or more `dealsonar-native-host` relay processes
//! (one per Chrome profile) over `dealsonar_protocol::ipc::IpcListener`, handles protocol v2
//! framing & structured parse errors without dropping connections, runs T0–T4 synchronously on
//! `posts.push`, and pushes `config.update`, `crawl.request`, `crawl.pause`, and `crawl.resume`.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use dealsonar_notify::SystemIncidentKind;
use dealsonar_protocol::ipc::{IpcListener, IpcStream};
use dealsonar_protocol::{
    parse_envelope, Body, CrawlReason, CrawlStatus, Envelope, ErrorCode, FrameError, SessionState,
    SourceInfo, SourceRef,
};
use dealsonar_store::models::{now_ms, CrawlRunInput, DiscoveredSourceInput, SourceRecord};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::dto::{CoreEvent, CrawlPauseReason, FacebookSessionState};
use crate::error::{CoreError, CoreResult};
use crate::pipeline;
use crate::state::{ConnectedProfile, CoreRuntime};

/// Spawn the local IPC accept loop on `listener`, terminating cleanly when `shutdown_rx` fires.
pub fn spawn_ipc_server(
    mut listener: IpcListener,
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok(stream) => {
                            if rt.shutting_down.load(Ordering::SeqCst) {
                                break;
                            }
                            let conn_rt = Arc::clone(&rt);
                            let conn_shutdown = shutdown_rx.clone();
                            tokio::spawn(async move {
                                handle_ipc_connection(stream, conn_rt, conn_shutdown).await;
                            });
                        }
                        Err(err) => {
                            if rt.shutting_down.load(Ordering::SeqCst) {
                                break;
                            }
                            tracing::warn!(error = %err, "IPC listener accept error");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    })
}

async fn handle_ipc_connection(
    stream: IpcStream,
    rt: Arc<CoreRuntime>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let conn_id = rt.ipc_hub.alloc_conn_id();
    let (mut read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Envelope>();

    let writer_handle = tokio::spawn(async move {
        while let Some(env) = rx.recv().await {
            if let Err(err) = write_half.write_host_envelope(&env).await {
                tracing::debug!(conn_id, error = %err, "IPC write_host_envelope failed");
                break;
            }
        }
    });

    let mut bound_profile_id: Option<String> = None;

    loop {
        let frame_res = tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
                continue;
            }
            res = read_half.read_ext_frame() => res,
        };

        let bytes = match frame_res {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break, // Clean EOF
            Err(FrameError::FrameTooLarge { size, max }) => {
                let err_env = Envelope::error(
                    None,
                    ErrorCode::InvalidPayload,
                    format!("frame length {size} exceeds max {max}"),
                    false,
                );
                let _ = tx.send(err_env);
                break;
            }
            Err(err) => {
                tracing::debug!(conn_id, error = %err, "IPC read_ext_frame closed");
                break;
            }
        };

        let envelope = match parse_envelope(&bytes) {
            Ok(env) => env,
            Err(parse_err) => {
                // Return structured `error` envelope (`protocol_mismatch`, `unknown_type`,
                // `invalid_payload`) WITHOUT dropping the IPC stream (`01-protocol.md §4.2`).
                let _ = tx.send(parse_err.to_error_envelope());
                continue;
            }
        };

        if !envelope.body.is_extension_to_desktop() {
            let msg_type = envelope.message_type();
            let _ = tx.send(Envelope::error(
                Some(envelope.id),
                ErrorCode::UnknownType,
                format!("unexpected message direction for type '{msg_type}'"),
                false,
            ));
            continue;
        }

        if let Body::Hello { profile_id, .. } = &envelope.body {
            bound_profile_id = Some(profile_id.clone());
        }

        match dispatch_incoming_envelope(conn_id, bound_profile_id.as_deref(), envelope, &tx, &rt) {
            Ok(()) => {}
            Err((reply_to, err)) => {
                tracing::warn!(conn_id, error = %err, "IPC message handler error");
                let (code, retryable) = match &err {
                    CoreError::Validation(_) => (ErrorCode::InvalidPayload, false),
                    CoreError::ShuttingDown => (ErrorCode::Busy, true),
                    _ => (ErrorCode::Internal, true),
                };
                let _ = tx.send(Envelope::error(reply_to, code, err.to_string(), retryable));
            }
        }
    }

    // Cleanup disconnected profile
    let became_all_disconnected = {
        let mut guard = rt.ipc_hub.state.lock().expect("ipc state lock");
        let removed = guard.connections.remove(&conn_id).is_some();
        if removed && guard.connections.is_empty() {
            guard.last_disconnected_at = Some(now_ms());
            true
        } else {
            false
        }
    };

    drop(tx);
    let _ = writer_handle.await;

    if became_all_disconnected || bound_profile_id.is_some() {
        let _ = rt.emit_health_if_changed(now_ms());
    }
}

fn dispatch_incoming_envelope(
    conn_id: u64,
    conn_profile_id: Option<&str>,
    envelope: Envelope,
    tx: &mpsc::UnboundedSender<Envelope>,
    rt: &Arc<CoreRuntime>,
) -> Result<(), (Option<String>, CoreError)> {
    let msg_id = envelope.id.clone();
    let res = handle_body(conn_id, conn_profile_id, &msg_id, envelope.body, tx, rt);
    res.map_err(|e| (Some(msg_id), e))
}

fn handle_body(
    conn_id: u64,
    conn_profile_id: Option<&str>,
    msg_id: &str,
    body: Body,
    tx: &mpsc::UnboundedSender<Envelope>,
    rt: &Arc<CoreRuntime>,
) -> CoreResult<()> {
    let now = now_ms();

    match body {
        Body::Hello {
            profile_id,
            ext_version,
            browser,
            config_rev: ext_config_rev,
        } => {
            let (current_rev, is_paused, pause_reason) = {
                let mut guard = rt.ipc_hub.state.lock().expect("ipc state lock");
                guard.last_disconnected_at = None;
                guard.connections.insert(
                    conn_id,
                    ConnectedProfile {
                        conn_id,
                        profile_id: profile_id.clone(),
                        ext_version,
                        browser,
                        connected_at: now,
                        crawl_runtime: None,
                        tx: tx.clone(),
                    },
                );
                (
                    guard.config_rev,
                    guard.crawl_paused,
                    guard.crawl_pause_reason,
                )
            };

            // If we previously alerted on extension disconnect, send recovery alert
            let was_disconnect_alerted = {
                let mut inc = rt.incidents.lock().expect("incidents lock");
                if inc.ext_disconnected_alerted {
                    inc.ext_disconnected_alerted = false;
                    true
                } else {
                    false
                }
            };
            if was_disconnect_alerted {
                let _ = rt.queue_system_incident_alert(
                    &SystemIncidentKind::ExtensionDisconnected,
                    true,
                    now,
                );
            }

            // 1. Reply `hello.ok`
            let _ = tx.send(Envelope::reply(
                msg_id,
                Body::HelloOk {
                    desktop_version: env!("CARGO_PKG_VERSION").to_string(),
                    config_rev: current_rev,
                },
            ));

            // 2. Immediately push `config.update` if `ext_config_rev < current_rev`
            if ext_config_rev < current_rev {
                let (_, cfg_env) = rt.build_config_update_for_profile(&profile_id)?;
                let _ = tx.send(cfg_env);
            }

            // 3. Push `crawl.pause` if crawl is currently halted
            if is_paused {
                let reason_str = match pause_reason {
                    Some(CrawlPauseReason::Manual) => "manual",
                    Some(CrawlPauseReason::CheckpointAwaitingResume) => {
                        "checkpoint_awaiting_resume"
                    }
                    Some(CrawlPauseReason::RateLimited) => "rate_limited",
                    Some(CrawlPauseReason::LoggedOut) => "logged_out",
                    None => "paused",
                };
                let _ = tx.send(Envelope::new(Body::CrawlPause {
                    until: None,
                    reason: reason_str.to_string(),
                }));
            }

            rt.emit_health_if_changed(now)?;
            Ok(())
        }

        Body::PostsPush {
            run_id: _,
            source_ref,
            posts,
        } => {
            if let Some((accepted, duplicates)) =
                rt.ipc_hub.dedup.lock().expect("dedup lock").get(msg_id)
            {
                let _ = tx.send(Envelope::reply(
                    msg_id,
                    Body::Ack {
                        accepted,
                        duplicates,
                    },
                ));
                return Ok(());
            }

            let primary_source = ensure_source_exists(rt, &source_ref, conn_profile_id, now)?;
            let mut accepted = 0u32;
            let mut duplicates = 0u32;

            for raw_post in &posts {
                let post_source = if raw_post.source_external_id == primary_source.external_id
                    && raw_post.platform == primary_source.platform
                {
                    primary_source.clone()
                } else {
                    let alt_ref = SourceRef {
                        platform: raw_post.platform.clone(),
                        kind: source_ref.kind.clone(),
                        external_id: raw_post.source_external_id.clone(),
                    };
                    ensure_source_exists(rt, &alt_ref, conn_profile_id, now)?
                };

                let ingest = pipeline::ingest_raw_post(rt, &post_source, raw_post, now)?;
                if ingest.was_inserted() {
                    accepted += 1;
                } else {
                    duplicates += 1;
                }
            }

            rt.ipc_hub
                .dedup
                .lock()
                .expect("dedup lock")
                .insert(msg_id.to_string(), (accepted, duplicates));

            let _ = tx.send(Envelope::reply(
                msg_id,
                Body::Ack {
                    accepted,
                    duplicates,
                },
            ));
            Ok(())
        }

        Body::CrawlReport {
            run_id,
            source_ref,
            reason,
            status,
            started_at,
            ended_at,
            posts_seen,
            posts_new,
            page_loads,
            strategy,
            error,
            dropped_posts: _,
        } => {
            if let Some((accepted, duplicates)) =
                rt.ipc_hub.dedup.lock().expect("dedup lock").get(msg_id)
            {
                let _ = tx.send(Envelope::reply(
                    msg_id,
                    Body::Ack {
                        accepted,
                        duplicates,
                    },
                ));
                return Ok(());
            }

            let source = ensure_source_exists(rt, &source_ref, conn_profile_id, now)?;

            let run_record = rt.store.record_crawl_run(&CrawlRunInput {
                id: run_id,
                source_id: source.id.clone(),
                reason: reason.as_str().to_string(),
                status: status.as_str().to_string(),
                started_at,
                ended_at: Some(ended_at),
                posts_seen: i64::from(posts_seen),
                posts_new: i64::from(posts_new),
                page_loads: i64::from(page_loads),
                strategy: strategy.map(|s| s.as_str().to_string()),
                error: error.clone(),
            })?;

            match status {
                CrawlStatus::Ok | CrawlStatus::Empty => {
                    rt.store.source_set_state(&source.id, "ok")?;
                    rt.set_source_last_error(&source.id, None)?;
                }
                CrawlStatus::Blocked => {
                    rt.store.source_set_state(&source.id, "inaccessible")?;
                    rt.set_source_last_error(
                        &source.id,
                        error.as_deref().or(Some("group blocked or inaccessible")),
                    )?;
                }
                CrawlStatus::Error => {
                    rt.store.source_set_state(&source.id, "error")?;
                    rt.set_source_last_error(
                        &source.id,
                        error.as_deref().or(Some("crawl failed")),
                    )?;
                }
            }

            // Detect 3 consecutive `empty` crawls across distinct sources while session is `ok` (`02-extension.md §4`)
            let mut alert_broken_count: Option<usize> = None;
            let mut alert_recovered = false;
            {
                let mut hub = rt.ipc_hub.state.lock().expect("ipc state lock");
                match status {
                    CrawlStatus::Empty if hub.facebook_session == FacebookSessionState::Ok => {
                        if !hub
                            .consecutive_empty_sources
                            .iter()
                            .any(|s| s == &source.id)
                        {
                            hub.consecutive_empty_sources.push(source.id.clone());
                        }
                        if hub.consecutive_empty_sources.len() >= 3 {
                            hub.extractor_broken = true;
                            alert_broken_count = Some(hub.consecutive_empty_sources.len());
                        }
                    }
                    CrawlStatus::Ok if posts_seen > 0 => {
                        hub.consecutive_empty_sources.clear();
                        if hub.extractor_broken {
                            hub.extractor_broken = false;
                            alert_recovered = true;
                        }
                    }
                    _ => {}
                }
            }

            if let Some(_cnt) = alert_broken_count {
                let should_alert = {
                    let mut inc = rt.incidents.lock().expect("incidents lock");
                    if !inc.extractor_broken_alerted {
                        inc.extractor_broken_alerted = true;
                        true
                    } else {
                        false
                    }
                };
                if should_alert {
                    let _ = rt.queue_system_incident_alert(
                        &SystemIncidentKind::ExtractorBroken,
                        false,
                        now,
                    );
                }
            } else if alert_recovered {
                let was_alerted = {
                    let mut inc = rt.incidents.lock().expect("incidents lock");
                    if inc.extractor_broken_alerted {
                        inc.extractor_broken_alerted = false;
                        true
                    } else {
                        false
                    }
                };
                if was_alerted {
                    let _ = rt.queue_system_incident_alert(
                        &SystemIncidentKind::ExtractorBroken,
                        true,
                        now,
                    );
                }
            }

            rt.emit(CoreEvent::CrawlFinished(rt.crawl_run_to_dto(&run_record)));
            rt.emit_health_if_changed(now)?;

            rt.ipc_hub
                .dedup
                .lock()
                .expect("dedup lock")
                .insert(msg_id.to_string(), (1, 0));

            let _ = tx.send(Envelope::reply(
                msg_id,
                Body::Ack {
                    accepted: 1,
                    duplicates: 0,
                },
            ));
            Ok(())
        }

        Body::SourcesDiscovered { sources, follow } => {
            if let Some((accepted, duplicates)) =
                rt.ipc_hub.dedup.lock().expect("dedup lock").get(msg_id)
            {
                let _ = tx.send(Envelope::reply(
                    msg_id,
                    Body::Ack {
                        accepted,
                        duplicates,
                    },
                ));
                return Ok(());
            }

            let total_upserted =
                upsert_sources_respecting_plan(rt, &sources, follow, conn_profile_id, now)?;

            if follow.is_some() && total_upserted > 0 {
                let _ = rt.bump_and_push_config()?;
            }

            let accepted = u32::try_from(total_upserted).unwrap_or(u32::MAX);
            rt.ipc_hub
                .dedup
                .lock()
                .expect("dedup lock")
                .insert(msg_id.to_string(), (accepted, 0));

            let _ = tx.send(Envelope::reply(
                msg_id,
                Body::Ack {
                    accepted,
                    duplicates: 0,
                },
            ));
            Ok(())
        }

        Body::SessionStatus {
            runtime,
            platform: _,
            state,
            detail,
        } => {
            if let Some(runtime) = runtime {
                let mut hub = rt.ipc_hub.state.lock().expect("ipc state lock");
                if let Some(conn) = hub.connections.get_mut(&conn_id) {
                    conn.crawl_runtime = Some((now, runtime));
                }
            }
            handle_session_status(rt, state, detail, now)?;
            let _ = tx.send(Envelope::reply(
                msg_id,
                Body::Ack {
                    accepted: 1,
                    duplicates: 0,
                },
            ));
            Ok(())
        }

        Body::Ping {} => {
            let _ = tx.send(Envelope::reply(msg_id, Body::Pong {}));
            Ok(())
        }

        _ => Err(CoreError::Validation(
            "unsupported message body on IPC server".to_string(),
        )),
    }
}

fn ensure_source_exists(
    rt: &CoreRuntime,
    source_ref: &SourceRef,
    profile_id: Option<&str>,
    now: i64,
) -> CoreResult<SourceRecord> {
    if let Some(existing) = rt
        .store
        .get_source_by_external_id(&source_ref.platform, &source_ref.external_id)?
    {
        return Ok(existing);
    }

    let placeholder = DiscoveredSourceInput {
        platform: source_ref.platform.clone(),
        kind: source_ref.kind.clone(),
        external_id: source_ref.external_id.clone(),
        name: format!("Group {}", source_ref.external_id),
        url: format!("https://www.facebook.com/groups/{}", source_ref.external_id),
        privacy: None,
        member_count: None,
    };
    rt.store
        .upsert_discovered_sources(&[placeholder], None, profile_id, now)?;
    rt.store
        .get_source_by_external_id(&source_ref.platform, &source_ref.external_id)?
        .ok_or_else(|| {
            CoreError::Internal(format!(
                "failed to create placeholder source for {}",
                source_ref.external_id
            ))
        })
}

fn source_info_to_input(s: &SourceInfo) -> DiscoveredSourceInput {
    DiscoveredSourceInput {
        platform: s.platform.clone(),
        kind: s.kind.clone(),
        external_id: s.external_id.clone(),
        name: s.name.clone(),
        url: s.url.clone(),
        privacy: s.privacy.map(|p| p.as_str().to_string()),
        member_count: s.member_count.map(|m| i64::try_from(m).unwrap_or(i64::MAX)),
    }
}

fn upsert_sources_respecting_plan(
    rt: &CoreRuntime,
    sources: &[SourceInfo],
    follow: Option<bool>,
    profile_id: Option<&str>,
    now: i64,
) -> CoreResult<usize> {
    if sources.is_empty() {
        return Ok(0);
    }

    if follow != Some(true) {
        let inputs: Vec<_> = sources.iter().map(source_info_to_input).collect();
        let res = rt
            .store
            .upsert_discovered_sources(&inputs, follow, profile_id, now)?;
        return Ok(res.inserted + res.updated);
    }

    // Honor `follow: Some(true)` subject to plan group limit (`max_followed_groups`)
    let license = rt.current_license_status(now)?;
    let max_groups = license.limits.max_followed_groups;
    let current_followed = usize::try_from(rt.store.count_followed_sources()?.max(0)).unwrap_or(0);
    let mut remaining_quota = max_groups.saturating_sub(current_followed);

    let mut allowed_follow = Vec::new();
    let mut capped_unfollow = Vec::new();

    for s in sources {
        let input = source_info_to_input(s);
        let already_followed = rt
            .store
            .get_source_by_external_id(&s.platform, &s.external_id)?
            .is_some_and(|existing| existing.followed);

        if already_followed {
            allowed_follow.push(input);
        } else if remaining_quota > 0 {
            remaining_quota -= 1;
            allowed_follow.push(input);
        } else {
            capped_unfollow.push(input);
        }
    }

    let mut total = 0usize;
    if !allowed_follow.is_empty() {
        let res =
            rt.store
                .upsert_discovered_sources(&allowed_follow, Some(true), profile_id, now)?;
        total += res.inserted + res.updated;
    }
    if !capped_unfollow.is_empty() {
        let res =
            rt.store
                .upsert_discovered_sources(&capped_unfollow, Some(false), profile_id, now)?;
        total += res.inserted + res.updated;
    }

    Ok(total)
}

fn handle_session_status(
    rt: &CoreRuntime,
    state: SessionState,
    _detail: Option<String>,
    now: i64,
) -> CoreResult<()> {
    if state == SessionState::Ok {
        {
            let mut hub = rt.ipc_hub.state.lock().expect("ipc state lock");
            let was_checkpoint = hub.facebook_session == FacebookSessionState::Checkpoint
                || hub.crawl_pause_reason == Some(CrawlPauseReason::CheckpointAwaitingResume);
            hub.facebook_session = FacebookSessionState::Ok;

            if was_checkpoint {
                // Per `02-extension.md §7`: after a checkpoint clears, remain paused in
                // `checkpoint_awaiting_resume` until the user explicitly resumes crawling.
                hub.crawl_paused = true;
                hub.crawl_pause_reason = Some(CrawlPauseReason::CheckpointAwaitingResume);
            } else if matches!(
                hub.crawl_pause_reason,
                Some(CrawlPauseReason::LoggedOut | CrawlPauseReason::RateLimited)
            ) {
                hub.crawl_paused = false;
                hub.crawl_pause_reason = None;
            }
        }

        let was_alerted = {
            let mut inc = rt.incidents.lock().expect("incidents lock");
            if inc.fb_session_alerted {
                inc.fb_session_alerted = false;
                true
            } else {
                false
            }
        };
        if was_alerted {
            let _ = rt.queue_system_incident_alert(
                &SystemIncidentKind::FacebookSessionIssue,
                true,
                now,
            );
        }

        rt.emit_health_if_changed(now)?;
        return Ok(());
    }

    // Non-OK session state -> halt crawling & send single system incident alert (`01-protocol.md`, `02-extension.md §7`)
    let (mapped_state, pause_reason) = match state {
        SessionState::Ok => (FacebookSessionState::Ok, CrawlPauseReason::Manual),
        SessionState::LoggedOut => (FacebookSessionState::LoggedOut, CrawlPauseReason::LoggedOut),
        SessionState::Checkpoint => (
            FacebookSessionState::Checkpoint,
            CrawlPauseReason::CheckpointAwaitingResume,
        ),
        SessionState::RateLimited => (
            FacebookSessionState::RateLimited,
            CrawlPauseReason::RateLimited,
        ),
        SessionState::Unknown => (FacebookSessionState::LoggedOut, CrawlPauseReason::LoggedOut),
    };

    {
        let mut hub = rt.ipc_hub.state.lock().expect("ipc state lock");
        hub.facebook_session = mapped_state;
        hub.crawl_paused = true;
        hub.crawl_pause_reason = Some(pause_reason);
    }

    let pause_env = Envelope::new(Body::CrawlPause {
        until: None,
        reason: format!("facebook_{}", state.as_str()),
    });
    rt.ipc_hub.send_to_profile(None, &pause_env);

    let should_alert = {
        let mut inc = rt.incidents.lock().expect("incidents lock");
        if !inc.fb_session_alerted {
            inc.fb_session_alerted = true;
            true
        } else {
            false
        }
    };
    if should_alert {
        let _ =
            rt.queue_system_incident_alert(&SystemIncidentKind::FacebookSessionIssue, false, now);
    }

    rt.emit_health_if_changed(now)?;
    Ok(())
}

/// Push an on-demand `crawl.request` (`manual` or `preview`) to the source's owning Chrome profile
/// (or broadcast if `profile_id` is unset).
pub fn push_crawl_request(
    rt: &CoreRuntime,
    source: &SourceRecord,
    reason: CrawlReason,
    max_posts: u32,
) -> usize {
    let env = Envelope::new(Body::CrawlRequest {
        request_id: dealsonar_protocol::new_ulid(),
        source_ref: SourceRef {
            platform: source.platform.clone(),
            kind: source.kind.clone(),
            external_id: source.external_id.clone(),
        },
        reason,
        max_posts,
    });
    let sent = rt
        .ipc_hub
        .send_to_profile(source.profile_id.as_deref(), &env);
    if sent == 0 && source.profile_id.is_some() {
        // Fallback to any connected profile if the pinned profile is offline
        return rt.ipc_hub.send_to_profile(None, &env);
    }
    sent
}
