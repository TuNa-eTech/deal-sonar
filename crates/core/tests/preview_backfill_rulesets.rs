//! Integration Tests for Streaming Preview, Quality Warnings, Active Radar Edit Flow,
//! 24h Silent Unpause Backfill, `bds-vi-v1` Seed Ruleset Fast-Path, and Full Ruleset Lifecycle
//! (`#29` DONE CRITERIA #2 & #3).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use dealsonar_ai_bridge::{
    AiError, AiProvider, AiRequest, AiResponse, MockAiProvider, ProbeResult, ProviderId,
};
use dealsonar_core::dto::{
    AuthorRole, CoreEvent, CreateRadarDraftInput, FeedbackLabel, FeedbackOrigin, FieldDef,
    FieldType, LeadFeedbackInput, LeadFilterQuery, MatchPolicy, PlanTier, PreviewStartInput,
    PreviewStatus, PreviewWarningCode, RadarStatus, RulesetBody, RulesetClassifyRule,
    RulesetExtractorRule, RulesetPrefilter, RulesetThresholds, SuggestFieldsInput,
    UpdateRadarInput, WantIntent,
};
use dealsonar_core::preview_rules::run_audit_ruleset;
use dealsonar_core::{CoreConfig, CoreError, CoreServiceBuilder, LicensePayload, LicenseSigner};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, AuthorInfo, Body, CrawlReason, Envelope, ExtractionInfo,
    ExtractionStrategy, RawPost, MAX_EXT_TO_HOST_BYTES,
};
use dealsonar_rules::types::FilterOp as EngineFilterOp;
use dealsonar_rules::{
    compile_ruleset_unchecked, normalize_text, ClassifyRule as EngineClassifyRule, Condition,
    ExtractRule as EngineExtractRule, ExtractorConfig as EngineExtractorConfig, FieldCmp,
    PrefilterSpec as EnginePrefilterSpec, RuleVerdict as EngineRuleVerdict,
    RulesetBody as EngineRulesetBody, RulesetOutcome, Thresholds as EngineThresholds,
};
use dealsonar_store::models::{
    now_ms, AuthorInput, DiscoveredSourceInput, EvaluationUpsertInput,
    ExtractedField as StoreExtractedField, FieldSource as StoreFieldSource, NewPost,
    NewRulesetInput, RecordFeedbackInput,
};
use dealsonar_store::Store;
use serde_json::json;

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

fn seed_post(store: &Store, source_id: &str, ext_id: &str, text: &str, captured_at: i64) -> String {
    let norm = normalize_text(text);
    let (rec, _) = store
        .insert_post(&NewPost {
            id: None,
            platform: "facebook".to_string(),
            external_id: ext_id.to_string(),
            source_id: source_id.to_string(),
            author: Some(AuthorInput {
                external_id: Some(format!("author_{ext_id}")),
                name: format!("Người đăng {ext_id}"),
                is_anonymous: false,
            }),
            permalink: format!("https://www.facebook.com/groups/src/posts/{ext_id}"),
            text: Some(text.to_string()),
            text_norm: Some(norm.text_norm),
            text_fold: Some(norm.text_fold),
            text_truncated: false,
            lang: Some(norm.lang),
            content_hash: format!("{}_{ext_id}", norm.content_hash),
            simhash: norm.simhash.wrapping_add(ext_id.len() as i64),
            attachments: None,
            counts: None,
            extracted_phones: Vec::new(),
            created_at: Some(captured_at),
            captured_at,
            strategy: "graphql".to_string(),
        })
        .expect("insert_post");
    rec.id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn streaming_preview_crawl_request_and_all_three_quality_warnings() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let endpoint = IpcEndpoint::from_path(tmp.path().join("preview.sock"));
    let store = Store::open_in_memory().expect("store");
    let mock_ai = Arc::new(MockAiProvider::new());

    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            ipc_endpoint: Some(endpoint.clone()),
            preview_batch_size: 10,
            preview_min_posts_before_crawl: 20,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(mock_ai.clone())
        .start()
        .expect("start service");

    // Verify `radar_suggest_fields` works through AiBridge
    let suggestion = service
        .radar_suggest_fields(SuggestFieldsInput {
            description: "Tìm khách cần thuê căn hộ chung cư Quận 7".to_string(),
            user_profession: Some("Môi giới cho thuê căn hộ".to_string()),
            template_id: None,
            language_hint: Some("vi".to_string()),
        })
        .await
        .expect("radar_suggest_fields");
    assert!(!suggestion.fields.is_empty());
    assert_eq!(suggestion.want_intent, WantIntent::Demand);

    // Connect extension on `"Profile 1"` and create 1 followed group with `< 20` posts (5 posts)
    let mut ext_stream = IpcStream::connect(&endpoint).await.expect("connect");
    write_envelope_async(
        &mut ext_stream,
        &Envelope::new(Body::Hello {
            profile_id: "Profile 1".to_string(),
            ext_version: "0.1.0".to_string(),
            browser: "Chrome/131".to_string(),
            config_rev: 0,
        }),
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .expect("hello");
    let _ = recv_host_env(&mut ext_stream).await; // HelloOk
    let _ = recv_host_env(&mut ext_stream).await; // ConfigUpdate

    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_prev_1".to_string(),
                name: "Nhóm Thử Radar".to_string(),
                url: "https://www.facebook.com/groups/grp_prev_1".to_string(),
                privacy: Some("public".to_string()),
                member_count: Some(10_000),
            }],
            Some(true),
            Some("Profile 1"),
            now,
        )
        .expect("upsert source");
    let src_id = service.source_list().expect("sources")[0].id.clone();

    let draft = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Radar Thử Nghiệm".to_string(),
            template_id: None,
            description: "Tìm khách cần thuê căn hộ 2PN Quận 7".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("Môi giới căn hộ".to_string()),
            fields: vec![
                FieldDef {
                    key: "budget".to_string(),
                    label: "Ngân sách".to_string(),
                    r#type: FieldType::Money,
                    description: "Ngân sách thuê".to_string(),
                    required: true,
                    options: None,
                    show_in_alert: true,
                    order: 0,
                },
                FieldDef {
                    key: "move_in_date".to_string(),
                    label: "Ngày dọn vào".to_string(),
                    r#type: FieldType::Date,
                    description: "Ngày dự kiến chuyển vào".to_string(),
                    required: true, // Intentionally missing in posts to trigger MissingRequiredField (>70%)!
                    options: None,
                    show_in_alert: true,
                    order: 1,
                },
            ],
            match_policy: MatchPolicy {
                want_intent: WantIntent::Demand,
                exclude_roles: vec![AuthorRole::Peer],
                hard_filters: Vec::new(),
            },
            source_ids: vec![src_id.clone()],
            notify: None,
        })
        .expect("create draft");
    let radar_id = draft.radar.id.clone();

    // Case A: `< 20` posts stored (5 irrelevant posts) -> triggers `crawl.request(preview)` AND `ZeroMatches` warning!
    for i in 0..5 {
        seed_post(
            service.store(),
            &src_id,
            &format!("irr_{i}"),
            &format!("Thanh lý bàn ghế văn phòng cũ tại Quận 1 giá rẻ số {i}"),
            now - (i as i64 * 10_000),
        );
    }

    let mut events_rx = service.subscribe_events();
    let prev_zero = service
        .radar_preview_start(PreviewStartInput {
            radar_id: radar_id.clone(),
            description: None,
            user_profession: None,
            fields: None,
            match_policy: None,
            source_ids: None,
        })
        .await
        .expect("preview zero matches");

    assert_eq!(prev_zero.status, PreviewStatus::Done);
    assert_eq!(prev_zero.total_posts, 5);
    assert!(
        prev_zero
            .warnings
            .iter()
            .any(|w| w.code == PreviewWarningCode::ZeroMatches),
        "expected ZeroMatches warning, got {:?}",
        prev_zero.warnings
    );

    // Extension must have received `Body::CrawlRequest { reason: CrawlReason::Preview, .. }` because `< 20` posts existed!
    let crawl_req = recv_host_env(&mut ext_stream).await;
    match crawl_req.body {
        Body::CrawlRequest { reason, .. } => assert_eq!(reason, CrawlReason::Preview),
        other => panic!("expected CrawlRequest(Preview), got {other:?}"),
    }

    // Case B: Seed 20 demand posts lacking `move_in_date` (total 25 posts: 20/25 = 80% > 60% match, and 100% > 70% missing `move_in_date`)!
    for i in 0..20 {
        seed_post(
            service.store(),
            &src_id,
            &format!("dem_{i}"),
            &format!(
                "Gia đình mình cần thuê căn hộ 2PN Quận 7 ngân sách {} triệu/tháng ở lâu dài LH 09091112{:02}",
                11 + (i % 4),
                i
            ),
            now + (i as i64 * 1_000),
        );
    }

    let prev_broad = service
        .radar_preview_start(PreviewStartInput {
            radar_id: radar_id.clone(),
            description: None,
            user_profession: None,
            fields: None,
            match_policy: None,
            source_ids: None,
        })
        .await
        .expect("preview broad + missing required");

    assert_eq!(prev_broad.status, PreviewStatus::Done);
    assert_eq!(prev_broad.total_posts, 25);
    assert_eq!(prev_broad.evaluated_posts, 25);
    assert!(
        prev_broad
            .warnings
            .iter()
            .any(|w| w.code == PreviewWarningCode::TooBroad),
        "expected TooBroad (>60%) warning, got {:?}",
        prev_broad.warnings
    );
    assert!(
        prev_broad.warnings.iter().any(|w| {
            w.code == PreviewWarningCode::MissingRequiredField
                && w.field_key.as_deref() == Some("move_in_date")
        }),
        "expected MissingRequiredField on move_in_date, got {:?}",
        prev_broad.warnings
    );

    // Verify `preview:progress` streamed multiple incremental chunks (`10`, `20`, `25`)
    let mut progress_counts = Vec::new();
    while let Ok(ev) = events_rx.try_recv() {
        if let CoreEvent::PreviewProgress(p) = ev {
            if p.preview_id == prev_broad.preview_id {
                progress_counts.push(p.evaluated_posts);
            }
        }
    }
    assert!(
        progress_counts.len() >= 3,
        "expected >= 3 streaming preview:progress events for 25 posts at batch=10, got {progress_counts:?}"
    );

    // Verify `radar_preview_get` retrieves the completed preview and live Inbox leads were NOT polluted!
    let fetched_prev = service
        .radar_preview_get(&radar_id, Some(&prev_broad.preview_id))
        .expect("radar_preview_get");
    assert_eq!(fetched_prev.evaluated_posts, 25);
    assert_eq!(
        service
            .lead_list(LeadFilterQuery::default())
            .expect("live leads")
            .items
            .len(),
        0,
        "preview must NEVER create live leads in Inbox"
    );

    drop(ext_stream);
    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_radar_edit_confirmation_and_silent_24h_unpause_backfill() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let mock_ai = Arc::new(MockAiProvider::new());

    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(mock_ai)
        .start()
        .expect("start service");

    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_bf".to_string(),
                name: "Nhóm Thuê Nhà Cầu Giấy".to_string(),
                url: "https://www.facebook.com/groups/grp_bf".to_string(),
                privacy: Some("public".to_string()),
                member_count: Some(20_000),
            }],
            Some(true),
            None,
            now,
        )
        .expect("upsert source");
    let src_id = service.source_list().expect("sources")[0].id.clone();

    let draft = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Khách thuê Cầu Giấy".to_string(),
            template_id: None,
            description: "Tìm khách cần thuê căn hộ chung cư Cầu Giấy".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("Môi giới cho thuê".to_string()),
            fields: vec![FieldDef {
                key: "budget".to_string(),
                label: "Ngân sách".to_string(),
                r#type: FieldType::Money,
                description: "Ngân sách thuê".to_string(),
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
            source_ids: vec![src_id.clone()],
            notify: None,
        })
        .expect("draft");
    let rid = draft.radar.id.clone();

    // Activate v1, then edit `description` without `confirm_version_upgrade` -> creates pending v2 while v1 stays active!
    service
        .radar_set_status(&rid, RadarStatus::Active)
        .await
        .expect("activate");

    let edit_pending = service
        .radar_update(UpdateRadarInput {
            id: rid.clone(),
            description: Some("Tìm khách cần thuê căn hộ 2PN Cầu Giấy hoặc Mỹ Đình".to_string()),
            confirm_version_upgrade: Some(false),
            ..Default::default()
        })
        .expect("edit active radar");
    assert!(edit_pending.created_new_version);
    assert!(edit_pending.requires_confirmation);
    assert_eq!(edit_pending.detail.radar.current_version, 1);
    assert_eq!(
        edit_pending
            .detail
            .pending_version_data
            .as_ref()
            .map(|v| v.version),
        Some(2)
    );

    // Confirm version upgrade -> promotes v2 to active!
    let edit_confirmed = service
        .radar_update(UpdateRadarInput {
            id: rid.clone(),
            confirm_version_upgrade: Some(true),
            ..Default::default()
        })
        .expect("confirm v2");
    assert!(!edit_confirmed.requires_confirmation);
    assert_eq!(edit_confirmed.detail.radar.current_version, 2);
    assert!(edit_confirmed.detail.pending_version_data.is_none());

    // Pause the radar, store 1 post within 24h (`now - 2h`) and 1 post older than 24h (`now - 30h`)
    service
        .radar_set_status(&rid, RadarStatus::Paused)
        .await
        .expect("pause");

    let recent_post_id = seed_post(
        service.store(),
        &src_id,
        "bf_recent_2h",
        "Gia đình trẻ cần thuê căn hộ 2PN khu Dịch Vọng Cầu Giấy ngân sách 11 triệu/tháng LH 0912345678",
        now - 2 * 3_600_000,
    );
    let _old_post_id = seed_post(
        service.store(),
        &src_id,
        "bf_old_30h",
        "Mình cần thuê căn hộ 2PN Cầu Giấy tài chính 10 triệu/tháng dọn vào ngay LH 0912999888",
        now - 30 * 3_600_000,
    );

    // Transition `Paused -> Active` -> triggers silent 24h backfill!
    service
        .radar_set_status(&rid, RadarStatus::Active)
        .await
        .expect("unpause -> backfill");
    service.tick_workers_now().await.expect("tick workers");

    let leads = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(rid.clone()),
            ..Default::default()
        })
        .expect("leads after unpause");
    assert_eq!(
        leads.items.len(),
        1,
        "only the <24h post must be backfilled (not the 30h old post)"
    );
    assert_eq!(leads.items[0].post_id, recent_post_id);
    assert!(
        leads.items[0].notified_at.is_none(),
        "24h unpause backfill leads MUST be silent in Inbox (notified_at == None)"
    );

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seed_bds_ruleset_fastpath_and_pro_compile_shadow_promote_demote_lifecycle() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let mock_ai = Arc::new(MockAiProvider::new());
    let signer = LicenseSigner::generate_for_test();

    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            shadow_min_posts: 4,
            shadow_min_age_ms: 0,
            audit_min_samples: 1,
            audit_disagreement_demote_threshold: 0.08,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(mock_ai.clone())
        .with_license_verifier(signer.verifier())
        .start()
        .expect("start service");

    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_rules".to_string(),
                name: "Cộng Đồng BĐS TP.HCM".to_string(),
                url: "https://www.facebook.com/groups/grp_rules".to_string(),
                privacy: Some("public".to_string()),
                member_count: Some(50_000),
            }],
            Some(true),
            None,
            now,
        )
        .expect("upsert source");
    let src_rec = service
        .store()
        .get_source_by_external_id("facebook", "grp_rules")
        .expect("get source")
        .expect("source exists");

    // 1. Verify all 7 built-in templates load and `bds.khach-thue` auto-attaches `bds-vi-v1` seed ruleset!
    let templates = service.template_list().expect("template_list");
    assert_eq!(templates.len(), 7);
    let bds_tpl = service
        .template_get("bds.khach-thue")
        .expect("bds template");
    assert_eq!(bds_tpl.seed_ruleset.as_deref(), Some("bds-vi-v1"));

    let bds_radar = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "BĐS Seed Radar".to_string(),
            template_id: Some("bds.khach-thue".to_string()),
            description: "Tìm khách cần thuê căn hộ chung cư Quận 7".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some(bds_tpl.user_profession),
            fields: bds_tpl.fields,
            match_policy: bds_tpl.match_policy,
            source_ids: vec![src_rec.id.clone()],
            notify: None,
        })
        .expect("create bds radar");

    let seed_rulesets = service
        .ruleset_list(&bds_radar.radar.id, None)
        .expect("ruleset_list");
    assert_eq!(seed_rulesets.len(), 1);
    assert_eq!(seed_rulesets[0].origin, "seed");
    assert_eq!(seed_rulesets[0].state, "active");

    service
        .radar_set_status(&bds_radar.radar.id, RadarStatus::Active)
        .await
        .expect("activate bds radar");

    // Ingest an obvious broker supply post -> `bds-vi-v1` rejects deterministically with ZERO AI calls!
    let calls_before = mock_ai.call_count();
    let supply_raw = RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_rules".to_string(),
        post_id: "seed_supply_reject_1".to_string(),
        permalink: "https://www.facebook.com/groups/grp_rules/posts/111".to_string(),
        author: AuthorInfo {
            name: "Sale Vinhomes".to_string(),
            external_id: Some("fb_sale_1".to_string()),
            is_anonymous: false,
        },
        text: "Bên em có quỹ căn căn hộ 2PN Vinhomes Grand Park full nội thất giá 8tr/tháng, kết hợp anh em môi giới".to_string(),
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
    dealsonar_core::pipeline::ingest_raw_post(service.runtime(), &src_rec, &supply_raw, now)
        .expect("ingest supply post");
    service.tick_workers_now().await.expect("tick");
    assert_eq!(
        mock_ai.call_count(),
        calls_before,
        "bds-vi-v1 seed ruleset must reject obvious broker supply post without calling AI"
    );

    // Pause first radar so we can test Pro `compile_ruleset` -> `shadow` -> `active` -> demote cleanly on a custom radar
    service
        .radar_set_status(&bds_radar.radar.id, RadarStatus::Paused)
        .await
        .expect("pause bds radar");

    // 2. Create custom radar (no seed ruleset), verify Personal plan blocks `ruleset_compile_now`, then upgrade to Pro!
    let custom_radar = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Custom BĐS Auto-Rule".to_string(),
            template_id: None,
            description: "Tìm khách cần thuê căn hộ chung cư Quận 7".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("Môi giới căn hộ".to_string()),
            fields: vec![FieldDef {
                key: "budget".to_string(),
                label: "Ngân sách".to_string(),
                r#type: FieldType::Money,
                description: "Ngân sách thuê".to_string(),
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
            notify: None,
        })
        .expect("create custom radar");
    let cr_id = custom_radar.radar.id.clone();
    let cr_vid = custom_radar.current_version_data.id.clone();

    let compile_err = service
        .ruleset_compile_now(&cr_id)
        .await
        .expect_err("Personal plan must reject ruleset_compile_now");
    assert!(matches!(compile_err, CoreError::LicenseLimitExceeded(_)));

    // Activate Pro license
    let pro_tok = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Pro Agency".to_string(),
            issued_at: now - 10_000,
            expires_at: Some(now + 86_400_000 * 365),
        })
        .expect("sign pro");
    service.license_set(&pro_tok).expect("set pro");

    // Seed 30 labeled samples (15 positive demand + 15 negative broker supply) for 80/20 holdout gate
    for i in 0..15 {
        let pos_txt = format!(
            "Gia đình mình cần thuê căn hộ 2PN Quận 7 tài chính {} triệu/tháng dọn vào ngay LH 09091234{:02}",
            10 + (i % 5),
            i
        );
        let p_pos = seed_post(
            service.store(),
            &src_rec.id,
            &format!("lbl_pos_{i}"),
            &pos_txt,
            now - (i as i64 * 1_000),
        );
        let mut f_map = BTreeMap::new();
        let val_vnd = (10 + (i % 5)) as f64 * 1_000_000.0;
        f_map.insert(
            "budget".to_string(),
            StoreExtractedField {
                value: json!({
                    "min": val_vnd,
                    "max": val_vnd,
                    "currency": "VND",
                    "period": "month"
                }),
                raw: Some(format!("{} triệu/tháng", 10 + (i % 5))),
                confidence: 0.95,
                source: StoreFieldSource::Ai,
            },
        );
        let ev_pos = service
            .store()
            .upsert_evaluation(&EvaluationUpsertInput {
                id: None,
                post_id: p_pos,
                radar_version_id: cr_vid.clone(),
                state: "done".to_string(),
                decided_by: Some("ai".to_string()),
                verdict: Some("match".to_string()),
                reject_reason: None,
                score: Some(0.92),
                intent: Some("demand".to_string()),
                author_role: Some("end_user".to_string()),
                summary: Some("Khách cần thuê".to_string()),
                reason: Some("Khớp nhu cầu".to_string()),
                fields: Some(f_map),
                ruleset_id: None,
                ai_call_id: None,
                is_preview: false,
                created_at: now,
                decided_at: Some(now),
            })
            .expect("ev_pos");
        service
            .store()
            .record_feedback(&RecordFeedbackInput {
                evaluation_id: ev_pos.id,
                label: "correct".to_string(),
                corrected_fields: None,
                post_text: Some(pos_txt),
                origin: "app".to_string(),
                now_ms: now,
            })
            .expect("fb_pos");

        let neg_txt = format!(
            "Cho thuê căn hộ 2PN Quận 7 giỏ hàng độc quyền hoa hồng 1 tháng môi giới mã căn A{:02}",
            i
        );
        let p_neg = seed_post(
            service.store(),
            &src_rec.id,
            &format!("lbl_neg_{i}"),
            &neg_txt,
            now - (i as i64 * 1_000) - 500,
        );
        let ev_neg = service
            .store()
            .upsert_evaluation(&EvaluationUpsertInput {
                id: None,
                post_id: p_neg,
                radar_version_id: cr_vid.clone(),
                state: "done".to_string(),
                decided_by: Some("ai".to_string()),
                verdict: Some("no_match".to_string()),
                reject_reason: Some("peer".to_string()),
                score: Some(0.05),
                intent: Some("supply".to_string()),
                author_role: Some("peer".to_string()),
                summary: None,
                reason: Some("Tin cho thuê của môi giới".to_string()),
                fields: None,
                ruleset_id: None,
                ai_call_id: None,
                is_preview: false,
                created_at: now,
                decided_at: Some(now),
            })
            .expect("ev_neg");
        service
            .store()
            .record_feedback(&RecordFeedbackInput {
                evaluation_id: ev_neg.id,
                label: "peer".to_string(),
                corrected_fields: None,
                post_text: Some(neg_txt),
                origin: "app".to_string(),
                now_ms: now,
            })
            .expect("fb_neg");
    }

    // Compile ruleset -> passes 80/20 `evaluate_gate_with_fields` and lands in `shadow`!
    let compiled_res = service
        .ruleset_compile_now(&cr_id)
        .await
        .expect("ruleset_compile_now");
    let shadow_rs = compiled_res
        .ruleset
        .expect("compiled ruleset should pass holdout gate");
    assert_eq!(shadow_rs.origin, "compiled");
    assert_eq!(shadow_rs.state, "shadow");

    // Activate radar and feed 4 posts (`shadow_min_posts = 4`, `shadow_min_age_ms = 0`) so shadow evaluations reconcile with AI truth and promote `shadow -> active`!
    service
        .radar_set_status(&cr_id, RadarStatus::Active)
        .await
        .expect("activate custom radar");

    let shadow_texts = [
        "Mình đang muốn thuê một căn studio yên tĩnh gần hồ Bán Nguyệt Quận 7, tài chính tầm 9 triệu/tháng, ở một mình sạch sẽ",
        "Bên em có giỏ hàng ký gửi chuyên khách tìm căn hộ Sunrise City Quận 7, hoa hồng gửi đủ 1 tháng cho anh chị cộng tác",
        "Chị gái mình chuyển công tác vào Sài Gòn cần thuê gấp chung cư khu Him Lam Quận 7 giá khoảng 14 triệu/tháng có nội thất cơ bản",
        "Sàn bên em có quỹ căn độc quyền Eco Green Sài Gòn cho khách tìm nhà ở liền, nhận ký gửi nhanh chóng trong ngày",
    ];
    for (k, txt) in shadow_texts.iter().enumerate() {
        let post_ts = now_ms();
        let raw = RawPost {
            platform: "facebook".to_string(),
            source_external_id: "grp_rules".to_string(),
            post_id: format!("shadow_eval_post_{k}"),
            permalink: format!("https://www.facebook.com/groups/grp_rules/posts/sh_{k}"),
            author: AuthorInfo {
                name: format!("User {k}"),
                external_id: Some(format!("fb_sh_user_{k}")),
                is_anonymous: false,
            },
            text: (*txt).to_string(),
            text_truncated: false,
            attachments: Vec::new(),
            created_at: Some(post_ts),
            captured_at: post_ts,
            counts: None,
            extraction: ExtractionInfo {
                strategy: ExtractionStrategy::Network,
                profile_rev: 1,
            },
        };
        dealsonar_core::pipeline::ingest_raw_post(service.runtime(), &src_rec, &raw, post_ts)
            .expect("ingest shadow post");
        service.tick_workers_now().await.expect("tick shadow batch");
    }

    let after_shadow = service
        .ruleset_list(&cr_id, Some(&cr_vid))
        .expect("rulesets after shadow");
    let promoted = after_shadow
        .iter()
        .find(|r| r.id == shadow_rs.id)
        .expect("compiled ruleset present");
    assert_eq!(
        promoted.state, "active",
        "shadow ruleset must auto-promote to active after meeting shadow agreement threshold"
    );

    // Trigger negative feedback against a rule-decided evaluation -> immediate audit check demotes `active -> shadow` (`audit_min_samples = 1`, disagreement 100% > 8%)!
    let demote_ts = now_ms();
    let rule_post_raw = RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_rules".to_string(),
        post_id: "rule_decided_post_for_demote".to_string(),
        permalink: "https://www.facebook.com/groups/grp_rules/posts/rd_1".to_string(),
        author: AuthorInfo {
            name: "Khách Hàng X".to_string(),
            external_id: Some("fb_kh_x".to_string()),
            is_anonymous: false,
        },
        text: "Hai anh em kỹ sư phần mềm cần thuê căn hộ thoáng mát khu Phú Thuận Quận 7, ngân sách 13 triệu/tháng ưu tiên tầng cao LH 0903444555"
            .to_string(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(demote_ts),
        captured_at: demote_ts,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    };
    dealsonar_core::pipeline::ingest_raw_post(
        service.runtime(),
        &src_rec,
        &rule_post_raw,
        demote_ts,
    )
    .expect("ingest rule post");
    service.tick_workers_now().await.expect("tick");

    // Find the lead created by `"rule"` (or create a rule-decided evaluation check) and mark `Irrelevant`
    let cr_leads = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(cr_id.clone()),
            ..Default::default()
        })
        .expect("cr leads");
    let rule_lead = cr_leads
        .items
        .iter()
        .find(|l| l.decided_by == dealsonar_core::dto::DecidedBy::Rule)
        .expect("active ruleset DefiniteMatch should create a rule-decided lead");

    service
        .lead_feedback(LeadFeedbackInput {
            evaluation_id: rule_lead.evaluation_id.clone(),
            lead_id: Some(rule_lead.id.clone()),
            post_id: Some(rule_lead.post_id.clone()),
            radar_version_id: Some(cr_vid.clone()),
            label: FeedbackLabel::Irrelevant,
            corrected_fields: None,
            duplicate_of_lead_id: None,
            block_author: Some(false),
            origin: FeedbackOrigin::App,
        })
        .expect("negative feedback on rule lead");

    let after_demote = service
        .ruleset_list(&cr_id, Some(&cr_vid))
        .expect("rulesets after demote");
    let demoted = after_demote
        .iter()
        .find(|r| r.id == shadow_rs.id)
        .expect("ruleset still stored");
    assert_eq!(
        demoted.state, "shadow",
        "negative feedback exceeding disagreement threshold must immediately demote active -> shadow"
    );

    // 3. `ruleset_save_user` validates regex safety and saves `origin = "user"`
    let unsafe_body = RulesetBody {
        dsl: 1,
        prefilter: RulesetPrefilter {
            any: vec!["re:(a+)+$".to_string()], // Nested quantifier -> rejected!
            none: Vec::new(),
            min_len: Some(20),
        },
        classify: Vec::new(),
        extract: Vec::new(),
        thresholds: RulesetThresholds::default(),
    };
    let unsafe_err = service
        .ruleset_save_user(&cr_id, &cr_vid, unsafe_body)
        .expect_err("nested quantifier regex must be rejected");
    assert!(matches!(unsafe_err, CoreError::RulesValidation(_)));

    let valid_user_body = RulesetBody {
        dsl: 1,
        prefilter: RulesetPrefilter {
            any: vec!["can thue".to_string()],
            none: vec!["hoa hong".to_string()],
            min_len: Some(20),
        },
        classify: vec![RulesetClassifyRule {
            id: "reject_broker".to_string(),
            description: Some("Loại môi giới".to_string()),
            kw_any: Some(vec!["hoa hong".to_string(), "gio hang".to_string()]),
            kw_none: None,
            has_field: None,
            when: None,
            verdict: "no_match".to_string(),
            confidence: 0.95,
            set: None,
        }],
        extract: vec![RulesetExtractorRule {
            field: "budget".to_string(),
            extractor: "vn_money".to_string(),
            near: Some(vec!["gia".to_string(), "tai chinh".to_string()]),
            window: Some(40),
            ..Default::default()
        }],
        thresholds: RulesetThresholds {
            accept: 0.9,
            reject: 0.9,
        },
    };
    let saved_user_rs = service
        .ruleset_save_user(&cr_id, &cr_vid, valid_user_body)
        .expect("save valid user ruleset");
    assert_eq!(saved_user_rs.origin, "user");

    service.shutdown().await.expect("shutdown");
}

struct TogglableFailAiProvider {
    inner: MockAiProvider,
    should_fail: Arc<AtomicBool>,
}

#[async_trait]
impl AiProvider for TogglableFailAiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    async fn probe(&self) -> ProbeResult {
        self.inner.probe().await
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        if self.should_fail.load(Ordering::SeqCst) {
            return Err(AiError::Timeout);
        }
        self.inner.complete(req).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ruleset_roundtrip_lossless_audit_queue_durability_and_missed_feedback_event() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_in_memory().expect("store");
    let now = now_ms();

    store
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_roundtrip".to_string(),
                name: "Nhóm Test Roundtrip".to_string(),
                url: "https://www.facebook.com/groups/grp_roundtrip".to_string(),
                privacy: Some("closed".to_string()),
                member_count: Some(5_000),
            }],
            Some(true),
            None,
            now,
        )
        .expect("upsert source");
    let src_rec = store
        .get_source_by_external_id("facebook", "grp_roundtrip")
        .expect("get src")
        .expect("src");

    let should_fail = Arc::new(AtomicBool::new(false));
    let provider = Arc::new(TogglableFailAiProvider {
        inner: MockAiProvider::new(),
        should_fail: Arc::clone(&should_fail),
    });

    let service = CoreServiceBuilder::new(store)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(provider)
        .start()
        .expect("start service");

    // -------------------------------------------------------------------------
    // 1a) `bds-vi-v1` seed ruleset roundtrip (`ruleset_list -> edit prefilter -> ruleset_save_user`)
    //     MUST preserve `Regex { group: 1, cast: Int }`, `Gazetteer { dict }`, and `EnumKw`!
    // -------------------------------------------------------------------------
    let tpl = service
        .template_get("bds.khach-thue")
        .expect("get bds.khach-thue template");
    let radar = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Radar Roundtrip Seed".to_string(),
            template_id: Some("bds.khach-thue".to_string()),
            description: tpl.description_template,
            language_hint: Some("vi".to_string()),
            user_profession: None,
            fields: tpl.fields,
            match_policy: tpl.match_policy,
            source_ids: vec![src_rec.id.clone()],
            notify: None,
        })
        .expect("create draft with seed ruleset");
    let r_id = radar.radar.id.clone();
    let r_vid = radar.current_version_data.id.clone();

    let listed = service.ruleset_list(&r_id, None).expect("ruleset_list");
    let seed_dto = listed
        .iter()
        .find(|rs| rs.origin == "seed")
        .expect("seed ruleset present");

    // Simulate `RadarsScreen.tsx` editing ONLY `prefilter.none` while spreading `{ ...baseBody }`
    let mut edited_seed_body = seed_dto.body.clone();
    edited_seed_body
        .prefilter
        .none
        .push("spam quang cao rac".to_string());

    let saved_from_seed = service
        .ruleset_save_user(&r_id, &r_vid, edited_seed_body)
        .expect("save edited seed ruleset");
    assert_eq!(saved_from_seed.origin, "user");

    let stored_seed_rs = service
        .store()
        .get_active_ruleset(&r_vid)
        .expect("get active ruleset")
        .expect("active ruleset exists");
    let engine_seed_rs: EngineRulesetBody =
        serde_json::from_value(stored_seed_rs.body).expect("parse stored engine ruleset");
    let compiled_seed = compile_ruleset_unchecked(&engine_seed_rs).expect("compile seed");

    let sample_norm = normalize_text(
        "Gia đình cần thuê căn hộ 2PN 70m2 tại Quận 7 tài chính 12 triệu LH 0909111222",
    );
    let eval_seed = compiled_seed.evaluate(&sample_norm, &[], now);
    let seed_fields = match eval_seed {
        RulesetOutcome::DefiniteMatch { fields, .. } => fields,
        RulesetOutcome::Uncertain { hint_fields, .. } => hint_fields,
        other => panic!("expected DefiniteMatch or Uncertain on valid demand post, got {other:?}"),
    };
    assert_eq!(
        seed_fields.get("bedrooms").map(|f| &f.value),
        Some(&json!(2)),
        "Regex group=1 + cast=Int MUST survive ruleset_list -> ruleset_save_user so bedrooms is integer 2, not '2pn'!"
    );
    assert!(
        seed_fields.contains_key("location"),
        "Gazetteer dict='vn_admin' MUST survive roundtrip"
    );
    assert!(
        seed_fields.contains_key("area"),
        "VnArea extractor MUST survive roundtrip"
    );
    assert!(
        seed_fields.contains_key("property_type"),
        "EnumKw map MUST survive roundtrip"
    );

    // -------------------------------------------------------------------------
    // 1b) Complex `Condition::All([KwAny, FieldCmp])` + `ExtractorConfig::Number` roundtrip!
    // -------------------------------------------------------------------------
    let complex_engine_rs = EngineRulesetBody {
        dsl: 1,
        prefilter: Some(EnginePrefilterSpec {
            any: vec!["can thue".to_string()],
            none: Vec::new(),
            min_len: Some(15),
        }),
        extract: vec![EngineExtractRule {
            field: "bedrooms".to_string(),
            config: EngineExtractorConfig::Number {
                units: vec!["pn".to_string(), "phong ngu".to_string()],
                prefixes: vec!["so phong".to_string()],
                multipliers: BTreeMap::from([("chuc".to_string(), 10.0)]),
            },
        }],
        classify: vec![EngineClassifyRule {
            id: "match_2plus_bedrooms".to_string(),
            when: Condition::All(vec![
                Condition::KwAny(vec!["can thue".to_string()]),
                Condition::FieldCmp(FieldCmp {
                    field: "bedrooms".to_string(),
                    op: EngineFilterOp::Gte,
                    value: json!(2.0),
                }),
            ]),
            verdict: EngineRuleVerdict::Match,
            confidence: 0.95,
            set: BTreeMap::new(),
        }],
        thresholds: EngineThresholds {
            accept: 0.9,
            reject: 0.9,
        },
    };

    service
        .store()
        .insert_ruleset(&NewRulesetInput {
            id: None,
            radar_version_id: r_vid.clone(),
            state: "active".to_string(),
            origin: "compiled".to_string(),
            body: serde_json::to_value(&complex_engine_rs).expect("serialize complex ruleset"),
            metrics: None,
            now_ms: now + 10,
        })
        .expect("insert compiled complex ruleset");

    let listed_complex = service.ruleset_list(&r_id, None).expect("list complex");
    let active_complex_dto = listed_complex
        .iter()
        .find(|rs| rs.state == "active")
        .expect("active complex dto");

    // UI spreads `{ ...baseBody }` and edits `prefilter.min_len` without touching `classify` or `extract`
    let mut ui_edited_complex = active_complex_dto.body.clone();
    ui_edited_complex.prefilter.min_len = Some(18);
    service
        .ruleset_save_user(&r_id, &r_vid, ui_edited_complex)
        .expect("ruleset_save_user complex");

    let roundtripped_record = service
        .store()
        .get_active_ruleset(&r_vid)
        .expect("get active after save")
        .expect("active after save");
    let roundtripped_engine: EngineRulesetBody =
        serde_json::from_value(roundtripped_record.body).expect("parse roundtripped complex");
    let compiled_complex =
        compile_ruleset_unchecked(&roundtripped_engine).expect("compile roundtripped complex");

    // Verify `FieldCmp(bedrooms >= 2)` was NOT silently dropped:
    // Use non-required field slice `&[]` so `DefiniteMatch` depends purely on rule condition!
    let norm_1pn = normalize_text("Gia đình mình đang cần thuê căn hộ 1pn khu vực Quận 7");
    let res_1pn = compiled_complex.evaluate(&norm_1pn, &[], now);
    match res_1pn {
        RulesetOutcome::Uncertain { hint_fields, .. } => {
            assert_eq!(
                hint_fields.get("bedrooms").map(|f| &f.value),
                Some(&json!(1))
            );
        }
        other => panic!(
            "1PN post MUST be Uncertain (not DefiniteMatch) when FieldCmp(bedrooms >= 2) is preserved, got {other:?}"
        ),
    }

    let norm_3pn = normalize_text("Gia đình mình đang cần thuê căn hộ 3pn khu vực Quận 7");
    let res_3pn = compiled_complex.evaluate(&norm_3pn, &[], now);
    match res_3pn {
        RulesetOutcome::DefiniteMatch { fields, .. } => {
            assert_eq!(fields.get("bedrooms").map(|f| &f.value), Some(&json!(3)));
        }
        other => panic!(
            "3PN post MUST DefiniteMatch via preserved Number extractor + FieldCmp(bedrooms >= 2), got {other:?}"
        ),
    }

    // -------------------------------------------------------------------------
    // 3c) `run_audit_ruleset` durability on AI failure AND >30 evaluation batching!
    // -------------------------------------------------------------------------
    let active_rs_id = roundtripped_record.id.clone();
    let mut queued_eval_ids = Vec::new();
    for idx in 1..=35 {
        let pid = seed_post(
            service.store(),
            &src_rec.id,
            &format!("audit_post_{idx}"),
            &format!("Gia đình cần thuê căn hộ 3PN Quận 7 mã bài kiểm toán riêng biệt số {idx}"),
            now - idx * 1_000,
        );
        let ev = service
            .store()
            .upsert_evaluation(&EvaluationUpsertInput {
                id: None,
                radar_version_id: r_vid.clone(),
                post_id: pid,
                is_preview: false,
                state: "done".to_string(),
                verdict: Some("match".to_string()),
                reject_reason: None,
                score: Some(0.95),
                intent: Some("demand".to_string()),
                author_role: Some("customer".to_string()),
                summary: Some("Rule match".to_string()),
                reason: Some("Rule match".to_string()),
                fields: None,
                decided_by: Some("rule".to_string()),
                ruleset_id: Some(active_rs_id.clone()),
                ai_call_id: None,
                created_at: now,
                decided_at: Some(now),
            })
            .expect("upsert rule eval");
        queued_eval_ids.push(ev.id);
    }

    let queue_key = format!("runtime.audit_queue.{active_rs_id}");
    service
        .store()
        .set_setting(&queue_key, &queued_eval_ids)
        .expect("seed 35 audit eval IDs");

    // Simulate AI outage: `run_audit_ruleset` returns `Err`, and ALL 35 IDs remain in `queue_key`!
    should_fail.store(true, Ordering::SeqCst);
    let audit_err = run_audit_ruleset(service.runtime(), &r_vid, &active_rs_id).await;
    assert!(audit_err.is_err(), "AI timeout must surface error");
    let preserved_on_err: Vec<String> = service
        .store()
        .get_setting(&queue_key)
        .expect("read queue after err")
        .expect("queue setting must still exist after AI error");
    assert_eq!(
        preserved_on_err.len(),
        35,
        "audit queue MUST NOT drop pending evaluation IDs when AI call fails!"
    );

    // Restore AI: first batch processes 30 IDs and preserves the remaining 5 IDs in `queue_key`!
    should_fail.store(false, Ordering::SeqCst);
    run_audit_ruleset(service.runtime(), &r_vid, &active_rs_id)
        .await
        .expect("first 30 audit batch succeeds");
    let remaining_after_batch1: Vec<String> = service
        .store()
        .get_setting(&queue_key)
        .expect("read queue after batch 1")
        .expect("remaining 5 IDs must still be stored");
    assert_eq!(
        remaining_after_batch1,
        queued_eval_ids[30..].to_vec(),
        "IDs beyond .take(30) MUST be preserved for the next audit run!"
    );

    // Second batch drains the final 5 IDs and deletes `queue_key`!
    run_audit_ruleset(service.runtime(), &r_vid, &active_rs_id)
        .await
        .expect("remaining 5 audit batch succeeds");
    let after_batch2: Option<Vec<String>> = service
        .store()
        .get_setting(&queue_key)
        .expect("read queue after batch 2");
    assert!(
        after_batch2.is_none(),
        "queue key deleted once fully drained"
    );

    // -------------------------------------------------------------------------
    // 3d) `lead_feedback(Missed)` on a rejected evaluation emits `CoreEvent::LeadNew`
    //     (while feedback on an existing lead emits `CoreEvent::LeadUpdated`)!
    // -------------------------------------------------------------------------
    let mut events_rx = service.subscribe_events();
    let missed_post_id = seed_post(
        service.store(),
        &src_rec.id,
        "missed_eval_post_1",
        "Mình đang tìm căn hộ dịch vụ yên tĩnh khu Phú Mỹ Hưng LH 0912345678",
        now,
    );
    let rejected_ev = service
        .store()
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            radar_version_id: r_vid.clone(),
            post_id: missed_post_id.clone(),
            is_preview: false,
            state: "done".to_string(),
            verdict: Some("no_match".to_string()),
            reject_reason: Some("irrelevant".to_string()),
            score: Some(0.25),
            intent: Some("other".to_string()),
            author_role: Some("customer".to_string()),
            summary: Some("Rejected post".to_string()),
            reason: Some("Low score".to_string()),
            fields: None,
            decided_by: Some("ai".to_string()),
            ruleset_id: None,
            ai_call_id: None,
            created_at: now,
            decided_at: Some(now),
        })
        .expect("upsert rejected evaluation");

    let missed_fb = service
        .lead_feedback(LeadFeedbackInput {
            evaluation_id: rejected_ev.id.clone(),
            lead_id: None,
            post_id: Some(missed_post_id),
            radar_version_id: Some(r_vid.clone()),
            label: FeedbackLabel::Missed,
            corrected_fields: None,
            duplicate_of_lead_id: None,
            block_author: Some(false),
            origin: FeedbackOrigin::App,
        })
        .expect("lead_feedback Missed");
    let created_lead = missed_fb
        .updated_lead
        .expect("Missed feedback must materialize a lead");
    let created_lead_id = created_lead.id.clone();

    let ev1 = events_rx
        .try_recv()
        .expect("event emitted on Missed feedback");
    match ev1 {
        CoreEvent::LeadNew(lead) => {
            assert_eq!(lead.id, created_lead_id);
        }
        other => panic!("expected CoreEvent::LeadNew for newly created Missed lead, got {other:?}"),
    }

    // Subsequent feedback on the now-existing lead emits `CoreEvent::LeadUpdated`!
    let _ = service
        .lead_feedback(LeadFeedbackInput {
            evaluation_id: rejected_ev.id,
            lead_id: Some(created_lead_id.clone()),
            post_id: None,
            radar_version_id: Some(r_vid),
            label: FeedbackLabel::Correct,
            corrected_fields: None,
            duplicate_of_lead_id: None,
            block_author: Some(false),
            origin: FeedbackOrigin::App,
        })
        .expect("lead_feedback Correct on existing lead");
    let ev2 = events_rx
        .try_recv()
        .expect("event emitted on existing lead feedback");
    match ev2 {
        CoreEvent::LeadUpdated(lead) => {
            assert_eq!(lead.id, created_lead_id);
        }
        other => {
            panic!("expected CoreEvent::LeadUpdated for existing lead feedback, got {other:?}")
        }
    }

    service.shutdown().await.expect("shutdown");
}
