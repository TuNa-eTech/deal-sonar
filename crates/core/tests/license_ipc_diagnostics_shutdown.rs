//! Integration Tests for Ed25519 License Verification, Personal/Pro Plan Limit Enforcement &
//! Auto-Pause Downgrade, Malformed IPC Stream Resilience, Extractor Broken & Session Checkpoint,
//! Redacted Diagnostic `.zip` Bundles, OS Notification Fallback, Data Lifecycle, and Graceful
//! `shutdown()` (`#29` DONE CRITERIA #4).

use std::fs::{self, File};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use dealsonar_ai_bridge::{
    AiError, AiProvider, AiRequest, AiResponse, MockAiProvider, ProbeResult, ProviderId,
};
use dealsonar_core::dto::{
    AuthorRole, ChromeConnectOptions, CrawlPauseReason, CreateRadarDraftInput,
    FacebookSessionState, FieldDef, FieldType, LeadFilterQuery, MatchPolicy, PlanTier, RadarStatus,
    WantIntent,
};
use dealsonar_core::{
    CoreConfig, CoreError, CoreServiceBuilder, LicensePayload, LicenseSigner, OsNotification,
};
use dealsonar_notify::{InMemorySecretStore, SecretStore};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, write_frame_async, AuthorInfo, Body, CrawlReason,
    CrawlStatus, Envelope, ErrorCode, ExtractionInfo, ExtractionStrategy, RawPost, SessionState,
    SourceRef, MAX_EXT_TO_HOST_BYTES,
};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput};
use dealsonar_store::Store;
use zip::ZipArchive;

async fn recv_host_env(stream: &mut IpcStream) -> Envelope {
    let bytes = tokio::time::timeout(
        Duration::from_secs(3),
        stream.read_frame(dealsonar_protocol::MAX_HOST_TO_EXT_BYTES),
    )
    .await
    .expect("IPC read timeout")
    .expect("IPC frame ok")
    .expect("IPC stream open");
    parse_envelope(&bytes).expect("valid host envelope")
}

fn make_minimal_draft(name: &str, field_count: usize) -> CreateRadarDraftInput {
    let fields = (0..field_count)
        .map(|i| FieldDef {
            key: format!("field_{i}"),
            label: format!("Trường {i}"),
            r#type: FieldType::Text,
            description: "Mô tả trường".to_string(),
            required: false,
            options: None,
            show_in_alert: true,
            order: i as i32,
        })
        .collect();
    CreateRadarDraftInput {
        name: name.to_string(),
        template_id: None,
        description: format!("Mô tả radar {name}"),
        language_hint: Some("vi".to_string()),
        user_profession: None,
        fields,
        match_policy: MatchPolicy {
            want_intent: WantIntent::Demand,
            exclude_roles: vec![AuthorRole::Peer],
            hard_filters: Vec::new(),
        },
        source_ids: Vec::new(),
        notify: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ed25519_license_limits_tamper_rejection_and_downgrade_auto_pause() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let signer = LicenseSigner::generate_for_test();
    let other_signer = LicenseSigner::generate_for_test();

    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_license_verifier(signer.verifier())
        .start()
        .expect("start service");

    let now = now_ms();

    // 1. Default plan is Personal (`Cá nhân`): max 2 active radars, 10 followed groups, 12 fields, no webhooks
    let initial = service.license_get().expect("license_get");
    assert_eq!(initial.plan, PlanTier::Personal);
    assert_eq!(initial.limits.max_active_radars, Some(2));
    assert_eq!(initial.limits.max_followed_groups, 10);
    assert_eq!(initial.limits.max_fields_per_radar, 12);

    // 13 fields rejected on Personal
    let too_many_fields = service
        .radar_create_draft(make_minimal_draft("Radar 13 Fields", 13))
        .expect_err("13 fields must fail on Personal");
    assert!(matches!(
        too_many_fields,
        CoreError::LicenseLimitExceeded(_)
    ));

    // Webhook rejected on Personal
    let wh_err = service
        .webhook_add("CRM Hook", "https://example.com/dealsonar-hook", None)
        .expect_err("webhook must fail on Personal");
    assert!(matches!(wh_err, CoreError::LicenseLimitExceeded(_)));

    // Create 3 radars: first 2 activate cleanly, 3rd active radar rejected on Personal!
    let r1 = service
        .radar_create_draft(make_minimal_draft("Radar 1", 2))
        .expect("r1")
        .radar
        .id;
    let r2 = service
        .radar_create_draft(make_minimal_draft("Radar 2", 2))
        .expect("r2")
        .radar
        .id;
    let r3 = service
        .radar_create_draft(make_minimal_draft("Radar 3", 2))
        .expect("r3")
        .radar
        .id;

    service
        .radar_set_status(&r1, RadarStatus::Active)
        .await
        .expect("activate r1");
    service
        .radar_set_status(&r2, RadarStatus::Active)
        .await
        .expect("activate r2");
    let third_err = service
        .radar_set_status(&r3, RadarStatus::Active)
        .await
        .expect_err("3rd active radar must fail on Personal");
    assert!(matches!(third_err, CoreError::LicenseLimitExceeded(_)));

    // Seed 11 unfollowed groups: first 10 `source_follow` succeed, 11th rejected on Personal!
    let group_inputs: Vec<_> = (1..=11)
        .map(|i| DiscoveredSourceInput {
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: format!("grp_lim_{i}"),
            name: format!("Group Limit {i}"),
            url: format!("https://www.facebook.com/groups/grp_lim_{i}"),
            privacy: Some("public".to_string()),
            member_count: Some(1_000),
        })
        .collect();
    service
        .store()
        .upsert_discovered_sources(&group_inputs, Some(false), None, now)
        .expect("seed 11 groups");
    let all_srcs = service.source_list().expect("source_list");
    assert_eq!(all_srcs.len(), 11);

    for s in all_srcs.iter().take(10) {
        service.source_follow(&s.id).expect("follow up to 10");
    }
    let eleventh_err = service
        .source_follow(&all_srcs[10].id)
        .expect_err("11th group must fail on Personal");
    assert!(matches!(eleventh_err, CoreError::LicenseLimitExceeded(_)));

    // 2. Tampered / wrong-key Ed25519 signature rejected!
    let wrong_key_tok = other_signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Attacker".to_string(),
            issued_at: now - 10_000,
            expires_at: Some(now + 86_400_000),
        })
        .expect("sign wrong key");
    let bad_sig_err = service
        .license_set(&wrong_key_tok)
        .expect_err("wrong Ed25519 key must fail");
    assert!(matches!(bad_sig_err, CoreError::LicenseInvalid(_)));

    // 3. Valid Pro license unlocks 3rd active radar, 11th followed group, 20 fields, and webhooks!
    let valid_pro = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Sàn BĐS Phú Mỹ".to_string(),
            issued_at: now - 60_000,
            expires_at: Some(now + 30 * 86_400_000),
        })
        .expect("sign pro");
    let pro_status = service.license_set(&valid_pro).expect("activate pro");
    assert_eq!(pro_status.plan, PlanTier::Pro);
    assert!(pro_status.is_valid);

    service
        .radar_set_status(&r3, RadarStatus::Active)
        .await
        .expect("Pro allows 3rd active radar");
    service
        .source_follow(&all_srcs[10].id)
        .expect("Pro allows 11th followed group");
    let r4_pro = service
        .radar_create_draft(make_minimal_draft("Radar 18 Fields", 18))
        .expect("Pro allows 18 fields");
    service
        .radar_set_status(&r4_pro.radar.id, RadarStatus::Active)
        .await
        .expect("activate r4");

    assert_eq!(
        service
            .radar_list()
            .expect("list")
            .iter()
            .filter(|r| r.status == RadarStatus::Active)
            .count(),
        4,
        "4 active radars running on Pro"
    );

    // 4. Expiry / Downgrade to Personal (`license_set` with already-expired token OR clearing license):
    //    Excess active radars (`r3`, `r4`) are auto-paused down to 2 WITHOUT deleting any radars!
    let expired_pro = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Sàn BĐS Phú Mỹ".to_string(),
            issued_at: now - 10 * 86_400_000,
            expires_at: Some(now - 1_000),
        })
        .expect("sign expired pro");
    let downgraded = service
        .license_set(&expired_pro)
        .expect("expired signature-valid token downgrades to Personal");
    assert_eq!(downgraded.plan, PlanTier::Personal);
    assert!(!downgraded.is_valid);

    let radars_after = service.radar_list().expect("radars after downgrade");
    assert_eq!(
        radars_after.len(),
        4,
        "zero radars deleted upon Pro expiry downgrade"
    );
    let active_after: Vec<_> = radars_after
        .iter()
        .filter(|r| r.status == RadarStatus::Active)
        .map(|r| r.id.clone())
        .collect();
    assert_eq!(
        active_after.len(),
        2,
        "excess active radars auto-paused down to Personal limit of 2"
    );
    assert!(active_after.contains(&r1) && active_after.contains(&r2));

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ipc_malformed_frames_extractor_broken_and_checkpoint_pause_resume() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let endpoint = IpcEndpoint::from_path(tmp.path().join("ipc_resilience.sock"));
    let manifest_path = tmp
        .path()
        .join("NativeMessagingHosts/com.dealsonar.host.json");
    let dummy_bin = std::env::current_exe().expect("current_exe");

    let store = Store::open_in_memory().expect("store");
    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            ipc_endpoint: Some(endpoint.clone()),
            native_host_binary_path: Some(dummy_bin),
            chrome_manifest_path: Some(manifest_path.clone()),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .start()
        .expect("start service");

    let mut stream = IpcStream::connect(&endpoint).await.expect("connect");

    // 1. Malformed frames (`protocol_mismatch`, `unknown_type`, `invalid_payload`) MUST return
    //    structured `Body::Error` without dropping the IPC stream!
    write_frame_async(
        &mut stream,
        br#"{"v":1,"id":"m1","type":"ping","ts":1700000000000,"payload":{}}"#,
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .expect("send v1 frame");
    let err_v1 = recv_host_env(&mut stream).await;
    assert_eq!(err_v1.reply_to.as_deref(), Some("m1"));
    assert!(matches!(
        err_v1.body,
        Body::Error {
            code: ErrorCode::ProtocolMismatch,
            ..
        }
    ));

    write_frame_async(
        &mut stream,
        br#"{"v":2,"id":"m2","type":"nonexistent.command","ts":1700000000000,"payload":{}}"#,
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .expect("send unknown type");
    let err_unk = recv_host_env(&mut stream).await;
    assert_eq!(err_unk.reply_to.as_deref(), Some("m2"));
    assert!(matches!(
        err_unk.body,
        Body::Error {
            code: ErrorCode::UnknownType,
            ..
        }
    ));

    write_frame_async(
        &mut stream,
        br#"{"v":2,"id":"m3","type":"hello","ts":1700000000000,"payload":{"bad":true}}"#,
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .expect("send invalid payload");
    let err_bad = recv_host_env(&mut stream).await;
    assert_eq!(err_bad.reply_to.as_deref(), Some("m3"));
    assert!(matches!(
        err_bad.body,
        Body::Error {
            code: ErrorCode::InvalidPayload,
            ..
        }
    ));

    // Stream is STILL alive: `Ping -> Pong` and `Hello -> HelloOk` succeed on the same connection!
    let ping = Envelope::new(Body::Ping {});
    write_envelope_async(&mut stream, &ping, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("ping");
    let pong = recv_host_env(&mut stream).await;
    assert_eq!(pong.reply_to.as_deref(), Some(ping.id.as_str()));
    assert_eq!(pong.body, Body::Pong {});

    let hello = Envelope::new(Body::Hello {
        profile_id: "Profile A".to_string(),
        ext_version: "0.1.0".to_string(),
        browser: "Chrome/131".to_string(),
        config_rev: 0,
    });
    write_envelope_async(&mut stream, &hello, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("hello");
    let _ = recv_host_env(&mut stream).await; // HelloOk
    let cfg_env = recv_host_env(&mut stream).await; // ConfigUpdate
    match cfg_env.body {
        Body::ConfigUpdate { extractor, .. } => {
            assert_eq!(
                extractor.dom,
                serde_json::json!({}),
                "default_extractor_profile MUST emit empty dom JSON so extension preserves full DEFAULT_DOM_CONFIG.article_selector"
            );
            assert_eq!(extractor.network, serde_json::json!({}));
            assert_eq!(extractor.session_markers, serde_json::json!({}));
        }
        other => panic!("expected Body::ConfigUpdate after Hello, got {other:?}"),
    }

    // 2a. Three `CrawlStatus::Empty` reports while `facebook_session != Ok` (`LoggedOut`)
    //     MUST NOT falsely flag `extractor_broken` (`02-extension.md §4`)!
    let sess_lo = Envelope::new(Body::SessionStatus {
        platform: "facebook".to_string(),
        state: SessionState::LoggedOut,
        detail: Some("cookie expired".to_string()),
    });
    write_envelope_async(&mut stream, &sess_lo, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("send logged_out");
    let _ = recv_host_env(&mut stream).await; // CrawlPause or Ack
    let _ = recv_host_env(&mut stream).await; // Ack or CrawlPause

    for idx in 1..=3 {
        let rep = Envelope::new(Body::CrawlReport {
            run_id: dealsonar_protocol::new_ulid(),
            source_ref: SourceRef {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: format!("logged_out_empty_src_{idx}"),
            },
            reason: CrawlReason::Scheduled,
            status: CrawlStatus::Empty,
            started_at: now_ms() - 2_000,
            ended_at: now_ms(),
            posts_seen: 0,
            posts_new: 0,
            page_loads: 1,
            strategy: Some(ExtractionStrategy::Dom),
            error: None,
            dropped_posts: None,
        });
        write_envelope_async(&mut stream, &rep, MAX_EXT_TO_HOST_BYTES)
            .await
            .expect("send empty report while logged out");
        let ack = recv_host_env(&mut stream).await;
        assert!(matches!(ack.body, Body::Ack { accepted: 1, .. }));
    }
    assert!(
        !service
            .runtime()
            .ipc_hub
            .state
            .lock()
            .unwrap()
            .extractor_broken,
        "empty crawls while facebook_session == LoggedOut MUST NOT flag extractor_broken!"
    );

    // Restore `SessionState::Ok` before testing healthy-session empty crawl detection
    let sess_restore_ok = Envelope::new(Body::SessionStatus {
        platform: "facebook".to_string(),
        state: SessionState::Ok,
        detail: None,
    });
    write_envelope_async(&mut stream, &sess_restore_ok, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("restore ok");
    let _ = recv_host_env(&mut stream).await; // Ack

    // 2b. Three consecutive `CrawlStatus::Empty` reports across 3 distinct sources while `facebook_session == Ok` -> `extractor_broken`!
    for idx in 1..=3 {
        let rep = Envelope::new(Body::CrawlReport {
            run_id: dealsonar_protocol::new_ulid(),
            source_ref: SourceRef {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: format!("empty_src_{idx}"),
            },
            reason: CrawlReason::Scheduled,
            status: CrawlStatus::Empty,
            started_at: now_ms() - 2_000,
            ended_at: now_ms(),
            posts_seen: 0,
            posts_new: 0,
            page_loads: 1,
            strategy: Some(ExtractionStrategy::Dom),
            error: None,
            dropped_posts: None,
        });
        write_envelope_async(&mut stream, &rep, MAX_EXT_TO_HOST_BYTES)
            .await
            .expect("send empty report");
        let ack = recv_host_env(&mut stream).await;
        assert!(matches!(ack.body, Body::Ack { accepted: 1, .. }));
    }
    assert_eq!(service.crawl_run_list(None, 10).expect("runs").len(), 6);
    assert!(
        service
            .runtime()
            .ipc_hub
            .state
            .lock()
            .unwrap()
            .extractor_broken,
        "3 consecutive empty crawls across distinct sources must flag extractor_broken"
    );

    // 3. `SessionStatus(Checkpoint)` halts crawl (`CrawlPause` pushed), transitions to
    //    `CheckpointAwaitingResume` when `SessionStatus(Ok)` arrives, and resumes on `chrome_connect(resume_crawl: true)`!
    let sess_cp = Envelope::new(Body::SessionStatus {
        platform: "facebook".to_string(),
        state: SessionState::Checkpoint,
        detail: Some("checkpoint challenge".to_string()),
    });
    write_envelope_async(&mut stream, &sess_cp, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("send checkpoint");

    let f1 = recv_host_env(&mut stream).await;
    let f2 = recv_host_env(&mut stream).await;
    assert!(
        matches!(f1.body, Body::CrawlPause { .. }) || matches!(f2.body, Body::CrawlPause { .. }),
        "Desktop must push CrawlPause when Facebook enters Checkpoint"
    );

    let h_cp = service.health_get().expect("health_get");
    assert_eq!(h_cp.facebook_session, FacebookSessionState::Checkpoint);
    assert!(h_cp.crawl_paused);

    // Extension reports `SessionState::Ok` after user solves checkpoint -> stays paused in `CheckpointAwaitingResume`!
    let sess_ok = Envelope::new(Body::SessionStatus {
        platform: "facebook".to_string(),
        state: SessionState::Ok,
        detail: None,
    });
    write_envelope_async(&mut stream, &sess_ok, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("send session ok");
    let _ = recv_host_env(&mut stream).await; // Ack

    let h_await = service.health_get().expect("health awaiting resume");
    assert_eq!(h_await.facebook_session, FacebookSessionState::Ok);
    assert!(h_await.crawl_paused);
    assert_eq!(
        h_await.crawl_pause_reason,
        Some(CrawlPauseReason::CheckpointAwaitingResume)
    );

    // User clicks Resume in Desktop (`chrome_connect(resume_crawl: true)`) -> writes manifest & pushes `CrawlResume`!
    let conn_res = service
        .chrome_connect(Some(ChromeConnectOptions {
            extension_id: Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            resume_crawl: true,
        }))
        .expect("chrome_connect");
    assert!(conn_res.native_host_installed);
    assert!(manifest_path.exists());

    let resume_env = recv_host_env(&mut stream).await;
    assert_eq!(resume_env.body, Body::CrawlResume {});
    assert!(!service.health_get().expect("health resumed").crawl_paused);

    drop(stream);
    service.shutdown().await.expect("shutdown");
}

struct SlowAiProvider {
    inner: MockAiProvider,
    delay: Duration,
    completed: Arc<AtomicBool>,
}

#[async_trait]
impl AiProvider for SlowAiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    async fn probe(&self) -> ProbeResult {
        self.inner.probe().await
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        tokio::time::sleep(self.delay).await;
        let res = self.inner.complete(req).await;
        self.completed.store(true, Ordering::SeqCst);
        res
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diagnostic_zip_redaction_os_notify_data_lifecycle_and_graceful_shutdown() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("dealsonar.sqlite3");
    let logs_dir = tmp.path().join("logs");
    fs::create_dir_all(&logs_dir).expect("logs_dir");

    let signer = LicenseSigner::generate_for_test();
    let pro_token = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Redaction Check Corp".to_string(),
            issued_at: now_ms() - 10_000,
            expires_at: Some(now_ms() + 86_400_000),
        })
        .expect("sign pro");

    // Write a `.log` file containing accidental secret tokens to verify log scrubbing!
    let fake_bot_token = "777888999:SUPER_SECRET_BOT_TOKEN_VALUE_12345";
    let fake_wh_secret = "whsec_ULTRA_SECRET_WEBHOOK_KEY_999";
    fs::write(
        logs_dir.join("dealsonar.log"),
        format!(
            "2026-11-12 INFO starting app\naccidental leak bot{fake_bot_token} and {fake_wh_secret} and {pro_token}\n"
        ),
    )
    .expect("write log");

    let secrets = Arc::new(InMemorySecretStore::new());
    secrets
        .set_secret(dealsonar_notify::TELEGRAM_BOT_TOKEN_KEY, fake_bot_token)
        .expect("set bot secret");

    let os_notifs: Arc<Mutex<Vec<OsNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let os_notifs_clone = Arc::clone(&os_notifs);

    let ai_completed = Arc::new(AtomicBool::new(false));
    let slow_provider = Arc::new(SlowAiProvider {
        inner: MockAiProvider::new(),
        delay: Duration::from_millis(160),
        completed: Arc::clone(&ai_completed),
    });

    let store = Store::open(&db_path, tmp.path().join("backups")).expect("open file store");
    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            logs_dir: Some(logs_dir),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_secrets(secrets.clone())
        .with_license_verifier(signer.verifier())
        .with_ai_provider(slow_provider)
        .with_os_notification_hook(Arc::new(move |notif| {
            os_notifs_clone.lock().expect("os notif lock").push(notif);
        }))
        .start()
        .expect("start service");

    service.license_set(&pro_token).expect("set pro");
    let wh_ch = service
        .webhook_add(
            "Internal CRM",
            "https://crm.example.com/hook",
            Some(fake_wh_secret),
        )
        .expect("add webhook");
    // Remove webhook from default channels before creating radar so NO Telegram/Webhook channel is attached -> triggers OS notification fallback!
    let _ = service.channel_remove(&wh_ch.id).expect("remove wh");
    let wh_ch2 = service
        .webhook_add(
            "Secret Vault Hook",
            "https://crm.example.com/hook2",
            Some(fake_wh_secret),
        )
        .expect("re-add webhook for redaction check");
    assert_eq!(wh_ch2.kind, "webhook");

    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_diag".to_string(),
                name: "Nhóm Kiểm Tra Bảo Mật".to_string(),
                url: "https://www.facebook.com/groups/grp_diag".to_string(),
                privacy: Some("closed".to_string()),
                member_count: Some(5_000),
            }],
            Some(true),
            None,
            now,
        )
        .expect("upsert source");
    let src_rec = service
        .store()
        .get_source_by_external_id("facebook", "grp_diag")
        .expect("get src")
        .expect("src");

    let radar = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Radar Bảo Mật".to_string(),
            template_id: None,
            description: "Tìm khách cần thuê căn hộ Quận 7".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: None,
            fields: vec![FieldDef {
                key: "budget".to_string(),
                label: "Ngân sách".to_string(),
                r#type: FieldType::Money,
                description: "Ngân sách".to_string(),
                required: false,
                options: None,
                show_in_alert: true,
                order: 0,
            }],
            match_policy: MatchPolicy {
                want_intent: WantIntent::Demand,
                exclude_roles: vec![AuthorRole::Peer],
                hard_filters: Vec::new(),
            },
            source_ids: vec![src_rec.id.clone()],
            notify: Some(dealsonar_core::dto::RadarNotifyPatch {
                channel_ids: Some(Vec::new()), // No Telegram channel configured -> OS Notification fallback!
                mode: None,
                min_score: None,
                quiet_hours: None,
            }),
        })
        .expect("draft");
    service
        .radar_set_status(&radar.radar.id, RadarStatus::Active)
        .await
        .expect("activate");

    let secret_post_marker = "CONFIDENTIAL_RAW_POST_CONTENT_MARKER_88888";
    let raw_post = RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_diag".to_string(),
        post_id: "diag_post_1".to_string(),
        permalink: "https://www.facebook.com/groups/grp_diag/posts/999111".to_string(),
        author: AuthorInfo {
            name: "Khách Bí Mật".to_string(),
            external_id: Some("fb_priv_uid_99".to_string()),
            is_anonymous: false,
        },
        text: format!(
            "Gia đình cần thuê căn hộ 2PN Quận 7 ngân sách 12 triệu/tháng LH 0909555666 {secret_post_marker}"
        ),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(now),
        captured_at: now,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    };
    dealsonar_core::pipeline::ingest_raw_post(service.runtime(), &src_rec, &raw_post, now)
        .expect("ingest post");
    service.tick_workers_now().await.expect("tick");

    // Verify OS notification hook fired because no Telegram channel is configured!
    assert_eq!(
        os_notifs.lock().expect("lock").len(),
        1,
        "OS notification fallback must fire when Telegram is not configured"
    );

    // 1. Verify `diagnostic_bundle_create` `.zip` contains ZERO secrets and ZERO post text!
    let bundle = service
        .diagnostic_bundle_create()
        .expect("diagnostic_bundle_create");
    assert!(bundle.size_bytes > 0);
    let zip_file = File::open(&bundle.path).expect("open zip");
    let mut archive = ZipArchive::new(zip_file).expect("read zip");

    let mut entry_names = Vec::new();
    for idx in 0..archive.len() {
        let mut entry = archive.by_index(idx).expect("zip entry");
        entry_names.push(entry.name().to_string());
        let mut contents = String::new();
        entry
            .read_to_string(&mut contents)
            .expect("utf8 entry contents");

        assert!(
            !contents.contains("SUPER_SECRET_BOT_TOKEN_VALUE_12345"),
            "diagnostic entry {} leaked Telegram bot token!",
            entry.name()
        );
        assert!(
            !contents.contains(fake_wh_secret),
            "diagnostic entry {} leaked webhook HMAC secret!",
            entry.name()
        );
        assert!(
            !contents.contains(&pro_token),
            "diagnostic entry {} leaked raw DS1 license token!",
            entry.name()
        );
        assert!(
            !contents.contains(secret_post_marker),
            "diagnostic entry {} leaked raw Facebook post content!",
            entry.name()
        );
    }
    assert!(entry_names.contains(&"version.json".to_string()));
    assert!(entry_names.contains(&"health.json".to_string()));
    assert!(entry_names.contains(&"settings_redacted.json".to_string()));
    assert!(entry_names.contains(&"table_counts.json".to_string()));
    assert!(entry_names.iter().any(|n| n.starts_with("logs/")));

    // 2. Verify `data_backup`, `data_purge`, and `data_delete_all` confirmation guard
    let backup = service.data_backup().expect("data_backup");
    assert!(std::path::Path::new(&backup.path).exists());

    let _ = service.data_purge(Some(30)).expect("data_purge");

    let bad_del = service
        .data_delete_all("wrong phrase")
        .expect_err("wrong confirmation phrase must fail");
    assert!(matches!(bad_del, CoreError::Validation(_)));
    assert_eq!(
        service
            .lead_list(LeadFilterQuery::default())
            .expect("leads")
            .items
            .len(),
        1
    );

    let ok_del = service
        .data_delete_all("XOA TAT CA")
        .expect("data_delete_all with exact phrase");
    assert!(ok_del.deleted);
    assert_eq!(
        service
            .lead_list(LeadFilterQuery::default())
            .expect("leads wiped")
            .items
            .len(),
        0
    );

    // 3. Verify graceful `shutdown()` waits for an in-flight slow AI call (`160ms`) before returning!
    ai_completed.store(false, Ordering::SeqCst);
    let svc_arc = Arc::new(service);
    let svc_bg = Arc::clone(&svc_arc);
    let inflight_task = tokio::spawn(async move {
        svc_bg
            .radar_suggest_fields(dealsonar_core::dto::SuggestFieldsInput {
                description: "Tìm khách thuê văn phòng Quận 1".to_string(),
                user_profession: None,
                template_id: None,
                language_hint: Some("vi".to_string()),
            })
            .await
    });

    // Give `radar_suggest_fields` 25ms to enter `SlowAiProvider::complete` (which sleeps 160ms)
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !ai_completed.load(Ordering::SeqCst),
        "slow AI call should still be in flight when shutdown starts"
    );

    svc_arc.shutdown().await.expect("shutdown");
    assert!(
        ai_completed.load(Ordering::SeqCst),
        "graceful shutdown() MUST wait for in-flight AI call to finish"
    );
    let suggest_res = inflight_task.await.expect("join inflight task");
    assert!(suggest_res.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outbox_health_counters_persist_across_restart_and_clear_on_channel_remove() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("outbox_persist.sqlite3");
    let backups_dir = tmp.path().join("backups");

    let signer = LicenseSigner::generate_for_test();
    let pro_token = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Outbox Durability Co".to_string(),
            issued_at: now_ms() - 10_000,
            expires_at: Some(now_ms() + 86_400_000),
        })
        .expect("sign pro");

    let secrets = Arc::new(InMemorySecretStore::new());
    let store1 = Store::open(&db_path, &backups_dir).expect("open store1");
    let service1 = CoreServiceBuilder::new(store1)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_secrets(secrets.clone())
        .with_license_verifier(signer.verifier())
        .start()
        .expect("start service1");

    service1.license_set(&pro_token).expect("set pro");

    let wh_pending = service1
        .webhook_add(
            "Retryable Webhook",
            "http://127.0.0.1:9/unreachable-pending",
            Some("whsec_valid_retryable_secret_111"),
        )
        .expect("add wh_pending");
    let wh_failed = service1
        .webhook_add(
            "Broken Secret Webhook",
            "http://127.0.0.1:9/broken-failed",
            Some("whsec_temp_secret_222"),
        )
        .expect("add wh_failed");
    // Delete `wh_failed`'s secret so delivery permanently marks its outbox entry `"failed"`
    secrets
        .delete_secret(&dealsonar_notify::webhook_channel_key(&wh_failed.id))
        .expect("delete wh_failed secret");

    let now = now_ms();
    service1
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_outbox_persist".to_string(),
                name: "Nhóm Test Outbox".to_string(),
                url: "https://www.facebook.com/groups/grp_outbox_persist".to_string(),
                privacy: Some("closed".to_string()),
                member_count: Some(2_000),
            }],
            Some(true),
            None,
            now,
        )
        .expect("upsert source");
    let src_rec = service1
        .store()
        .get_source_by_external_id("facebook", "grp_outbox_persist")
        .expect("get src")
        .expect("src");

    let tpl = service1
        .template_get("bds.khach-thue")
        .expect("get template");
    let radar = service1
        .radar_create_draft(CreateRadarDraftInput {
            name: "Radar Outbox Persist".to_string(),
            template_id: Some("bds.khach-thue".to_string()),
            description: tpl.description_template,
            language_hint: Some("vi".to_string()),
            user_profession: None,
            fields: tpl.fields,
            match_policy: tpl.match_policy,
            source_ids: vec![src_rec.id.clone()],
            notify: Some(dealsonar_core::dto::RadarNotifyPatch {
                channel_ids: Some(vec![wh_pending.id.clone(), wh_failed.id.clone()]),
                mode: None,
                min_score: None,
                quiet_hours: None,
            }),
        })
        .expect("create radar");
    service1
        .radar_set_status(&radar.radar.id, RadarStatus::Active)
        .await
        .expect("activate radar");

    // Ingest a post that DefiniteMatches `bds-vi-v1` immediately in T4 -> T6 -> T7 (enqueues 2 outbox items)
    let raw_post = RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_outbox_persist".to_string(),
        post_id: "outbox_post_1".to_string(),
        permalink: "https://www.facebook.com/groups/grp_outbox_persist/posts/101".to_string(),
        author: AuthorInfo {
            name: "Khách Thuê Thật".to_string(),
            external_id: Some("fb_uid_outbox_1".to_string()),
            is_anonymous: false,
        },
        text:
            "Gia đình mình cần thuê căn hộ 2PN Quận 7 tài chính 12 triệu vào ở ngay LH 0909888777"
                .to_string(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(now),
        captured_at: now,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    };
    dealsonar_core::pipeline::ingest_raw_post(service1.runtime(), &src_rec, &raw_post, now)
        .expect("ingest matching post");

    let h_before_worker = service1.health_get().expect("health before worker");
    assert_eq!(h_before_worker.outbox_pending, 2);
    assert_eq!(h_before_worker.outbox_failed, 0);

    // Run outbox worker batch once: `wh_pending` stays `pending` (backoff retry), `wh_failed` becomes `failed`!
    dealsonar_core::workers::process_due_outbox_batch(service1.runtime())
        .await
        .expect("process due outbox");

    let h_after_worker = service1.health_get().expect("health after worker");
    assert_eq!(h_after_worker.outbox_pending, 1);
    assert_eq!(h_after_worker.outbox_failed, 1);

    let wh_pending_id = wh_pending.id.clone();
    let wh_failed_id = wh_failed.id.clone();
    service1.shutdown().await.expect("shutdown service1");

    // Restart a brand-new `CoreService` on the SAME SQLite database -> counters MUST be restored!
    let store2 = Store::open(&db_path, &backups_dir).expect("reopen store2");
    let service2 = CoreServiceBuilder::new(store2)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_secrets(secrets)
        .with_license_verifier(signer.verifier())
        .start()
        .expect("start service2");

    let h_restarted = service2.health_get().expect("health after restart");
    assert_eq!(
        h_restarted.outbox_pending, 1,
        "outbox_pending MUST persist across CoreService restart"
    );
    assert_eq!(
        h_restarted.outbox_failed, 1,
        "outbox_failed MUST persist across CoreService restart"
    );

    // Removing `wh_failed` clears `outbox_failed` down to 0 while keeping `wh_pending`'s `outbox_pending == 1`!
    let _ = service2
        .channel_remove(&wh_failed_id)
        .expect("remove wh_failed");
    let h_after_rm_failed = service2.health_get().expect("health after rm failed");
    assert_eq!(h_after_rm_failed.outbox_pending, 1);
    assert_eq!(
        h_after_rm_failed.outbox_failed, 0,
        "channel_remove MUST purge deleted channel's failed outbox counter"
    );

    // Removing `wh_pending` clears `outbox_pending` down to 0!
    let _ = service2
        .channel_remove(&wh_pending_id)
        .expect("remove wh_pending");
    let h_after_rm_pending = service2.health_get().expect("health after rm pending");
    assert_eq!(
        h_after_rm_pending.outbox_pending, 0,
        "channel_remove MUST purge deleted channel's pending outbox counter"
    );
    assert_eq!(h_after_rm_pending.outbox_failed, 0);

    service2.shutdown().await.expect("shutdown service2");
}
