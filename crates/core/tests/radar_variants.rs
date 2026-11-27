//! Radar variants: an independent radar created from an existing one. The copy is reviewed
//! and edited before saving; the original keeps its history and is never affected.

use std::sync::{Arc, Mutex};

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{
    AuthorRole, CreateRadarDraftInput, CreateRadarVariantInput, FeedbackLabel, FeedbackOrigin,
    FieldDef, FieldType, LeadFeedbackInput, LeadFilterQuery, MatchPolicy, NotifyMode,
    RadarNotifyPatch, RadarStatus, UpdateRadarInput, WantIntent,
};
use dealsonar_core::{CoreConfig, CoreError, CoreService, CoreServiceBuilder, OsNotification};
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput};
use dealsonar_store::Store;

fn raw_post(group: &str, post_id: &str, text: &str, now: i64) -> RawPost {
    RawPost {
        platform: "facebook".to_string(),
        source_external_id: group.to_string(),
        post_id: post_id.to_string(),
        permalink: format!("https://www.facebook.com/groups/{group}/posts/{post_id}"),
        author: AuthorInfo {
            name: format!("Người đăng {post_id}"),
            external_id: Some(format!("uid_{post_id}")),
            is_anonymous: false,
        },
        text: text.to_string(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(now - 60_000),
        captured_at: now - 1_000,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    }
}

fn money_field() -> FieldDef {
    FieldDef {
        key: "budget".to_string(),
        label: "Ngân sách".to_string(),
        r#type: FieldType::Money,
        description: "Ngân sách thuê".to_string(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 0,
    }
}

fn plain_draft(name: &str, source_ids: Vec<String>) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: name.to_string(),
        template_id: None,
        description: format!("Tìm khách cần thuê căn hộ ({name})"),
        language_hint: Some("vi".to_string()),
        user_profession: Some("Môi giới cho thuê".to_string()),
        fields: vec![money_field()],
        match_policy: MatchPolicy {
            want_intent: WantIntent::Demand,
            exclude_roles: vec![AuthorRole::Peer],
            hard_filters: Vec::new(),
        },
        source_ids,
        notify: None,
    }
}

fn start_service(tmp: &tempfile::TempDir) -> CoreService {
    CoreServiceBuilder::new(Store::open_in_memory().expect("store"))
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service")
}

fn discover(service: &CoreService, external_id: &str, name: &str) -> String {
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: external_id.to_string(),
                name: name.to_string(),
                url: format!("https://www.facebook.com/groups/{external_id}"),
                privacy: Some("public".to_string()),
                member_count: None,
            }],
            Some(true),
            None,
            now_ms(),
        )
        .expect("source");
    service
        .source_list()
        .expect("sources")
        .into_iter()
        .find(|s| s.external_id == external_id)
        .expect("discovered source")
        .id
}

fn ingest(service: &CoreService, group: &str, raw: &RawPost, now: i64) {
    let source_id = discover(service, group, group);
    let source = service.store().source_get(&source_id).unwrap().unwrap();
    dealsonar_core::pipeline::ingest_raw_post(service.runtime(), &source, raw, now)
        .expect("ingest");
}

const DEMAND: &str =
    "Gia đình trẻ cần thuê căn hộ 2PN khu Dịch Vọng Cầu Giấy ngân sách 11 triệu/tháng LH 0912345678";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn variant_is_an_independent_draft_and_leaves_the_original_untouched() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let notified: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notified);
    service.set_os_notification_hook(Some(Arc::new(move |n: OsNotification| {
        sink.lock().unwrap().push(n.radar_name);
    })));

    let now = now_ms();
    let north = discover(&service, "grp_north", "Thuê nhà Cầu Giấy");
    let south = discover(&service, "grp_south", "Thuê nhà Thủ Đức");

    // Original radar with its own notify settings, running and holding history.
    let mut original_input = plain_draft("Khách thuê Cầu Giấy", vec![north.clone()]);
    original_input.notify = Some(RadarNotifyPatch {
        mode: Some(NotifyMode::Digest),
        min_score: Some(0.7),
        lead_ttl_hours: Some(Some(48)),
        ..Default::default()
    });
    let original = service
        .radar_create_draft(original_input)
        .expect("original draft");
    let original_id = original.radar.id.clone();
    service
        .radar_set_status(&original_id, RadarStatus::Active)
        .await
        .expect("activate original");

    ingest(
        &service,
        "grp_north",
        &raw_post("grp_north", "p1", DEMAND, now),
        now,
    );
    service.tick_workers_now().await.expect("tick");
    let original_leads = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(original_id.clone()),
            ..Default::default()
        })
        .expect("leads")
        .items;
    assert_eq!(original_leads.len(), 1, "original has a lead to protect");
    let lead = original_leads[0].clone();
    service
        .lead_feedback(LeadFeedbackInput {
            evaluation_id: lead.evaluation_id.clone(),
            lead_id: Some(lead.id.clone()),
            post_id: Some(lead.post_id.clone()),
            radar_version_id: Some(lead.radar_version_id.clone()),
            label: FeedbackLabel::Correct,
            corrected_fields: None,
            duplicate_of_lead_id: None,
            block_author: None,
            origin: FeedbackOrigin::App,
        })
        .expect("feedback on original");
    let original_version_id = lead.radar_version_id.clone();
    let feedback_before = service
        .store()
        .get_prompt_feedback_examples(&original_version_id, 8)
        .unwrap()
        .len();
    assert_eq!(feedback_before, 1);
    let notified_before = notified.lock().unwrap().len();

    // 1. Review the copy before anything is saved.
    let radars_before_prepare = service.radar_list().unwrap().len();
    let proposal = service
        .radar_variant_prepare(&original_id)
        .expect("prepare variant");
    assert_eq!(service.radar_list().unwrap().len(), radars_before_prepare);
    assert_eq!(proposal.source_radar_id, original_id);
    assert_eq!(proposal.input.name, "Khách thuê Cầu Giấy (biến thể)");
    assert_eq!(
        proposal.input.description,
        original.current_version_data.description
    );
    assert_eq!(proposal.input.fields, original.current_version_data.fields);
    assert_eq!(
        proposal.input.match_policy,
        original.current_version_data.match_policy
    );
    assert_eq!(proposal.input.source_ids, vec![north.clone()]);
    let copied = proposal.input.notify.clone().expect("notify copied");
    assert_eq!(copied.mode, Some(NotifyMode::Digest));
    assert_eq!(copied.min_score, Some(0.7));
    assert_eq!(copied.lead_ttl_hours, Some(Some(48)));
    assert_eq!(
        copied.channel_ids,
        Some(original.radar.notify.channel_ids.clone())
    );

    // 2. Edit the copy (new route, new name, new alert setting) and save it.
    let mut edited = proposal.input.clone();
    edited.name = "Khách thuê Thủ Đức".to_string();
    edited.description = "Tìm khách cần thuê căn hộ khu Thủ Đức".to_string();
    edited.source_ids = vec![south.clone()];
    edited.notify = Some(RadarNotifyPatch {
        channel_ids: Some(Vec::new()),
        inherit_channels: Some(false),
        mode: Some(NotifyMode::Instant),
        ..copied
    });
    let variant = service
        .radar_create_variant(CreateRadarVariantInput {
            source_radar_id: original_id.clone(),
            input: edited,
        })
        .expect("create variant");
    let variant_id = variant.radar.id.clone();

    assert_ne!(variant_id, original_id, "own ID");
    assert_eq!(variant.radar.status, RadarStatus::Draft, "starts as draft");
    assert_eq!(
        variant.radar.variant_of.as_deref(),
        Some(original_id.as_str())
    );
    assert_eq!(variant.radar.name, "Khách thuê Thủ Đức");
    assert_eq!(variant.radar.source_ids, vec![south.clone()]);
    assert_eq!(variant.radar.current_version, 1);
    assert_ne!(variant.current_version_data.id, original_version_id);
    assert_eq!(
        variant.current_version_data.fields,
        original.current_version_data.fields
    );
    assert_eq!(variant.radar.notify.min_score, 0.7);
    assert_eq!(variant.radar.notify.lead_ttl_hours, Some(48));
    assert_eq!(variant.radar.notify.mode, NotifyMode::Instant);
    assert_eq!(
        service
            .radar_get(&variant_id)
            .unwrap()
            .radar
            .variant_of
            .as_deref(),
        Some(original_id.as_str())
    );
    assert!(service
        .radar_list()
        .unwrap()
        .iter()
        .any(|r| r.id == variant_id && r.variant_of.as_deref() == Some(original_id.as_str())));

    // 3. The variant starts with no history, and the original keeps all of its own.
    let leads_of = |id: &str| {
        service
            .lead_list(LeadFilterQuery {
                radar_id: Some(id.to_string()),
                ..Default::default()
            })
            .unwrap()
            .items
    };
    assert!(leads_of(&variant_id).is_empty());
    let original_after = leads_of(&original_id);
    assert_eq!(original_after.len(), 1);
    assert_eq!(original_after[0].id, lead.id);
    assert_eq!(original_after[0].radar_id, original_id);
    assert_eq!(original_after[0].radar_version_id, original_version_id);
    assert!(service
        .store()
        .get_prompt_feedback_examples(&variant.current_version_data.id, 8)
        .unwrap()
        .is_empty());
    assert_eq!(
        service
            .store()
            .get_prompt_feedback_examples(&original_version_id, 8)
            .unwrap()
            .len(),
        feedback_before
    );

    // 4. A draft variant scores nothing and notifies nobody, even for matching posts.
    ingest(
        &service,
        "grp_south",
        &raw_post("grp_south", "p2", DEMAND, now),
        now,
    );
    service.tick_workers_now().await.expect("tick");
    assert!(
        leads_of(&variant_id).is_empty(),
        "draft variant stays silent"
    );
    assert_eq!(notified.lock().unwrap().len(), notified_before);

    // 5. Enabling, editing and archiving the variant does not touch the original.
    let original_snapshot = service.radar_get(&original_id).unwrap();
    service
        .radar_set_status(&variant_id, RadarStatus::Active)
        .await
        .expect("enable variant");
    service
        .radar_update(UpdateRadarInput {
            id: variant_id.clone(),
            name: Some("Thủ Đức gấp".to_string()),
            description: Some("Tìm khách thuê căn hộ Thủ Đức dưới 8 triệu".to_string()),
            ..Default::default()
        })
        .expect("edit variant");
    let variant_after_edit = service.radar_get(&variant_id).unwrap();
    assert_eq!(
        variant_after_edit.versions.len(),
        2,
        "edit versions the variant only"
    );
    service
        .radar_set_status(&variant_id, RadarStatus::Archived)
        .await
        .expect("archive variant");

    let original_final = service.radar_get(&original_id).unwrap();
    assert_eq!(original_final.radar.status, RadarStatus::Active);
    assert_eq!(original_final.radar.name, original_snapshot.radar.name);
    assert_eq!(original_final.radar.notify, original_snapshot.radar.notify);
    assert_eq!(
        original_final.radar.source_ids,
        original_snapshot.radar.source_ids
    );
    assert_eq!(original_final.radar.current_version, 1);
    assert_eq!(original_final.versions, original_snapshot.versions);
    assert_eq!(
        original_final.current_version_data,
        original_snapshot.current_version_data
    );
    assert_eq!(leads_of(&original_id).len(), 1);

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn variants_follow_the_same_plan_limits_as_new_radars() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let source = discover(&service, "grp_limits", "Nhóm giới hạn");

    let original = service
        .radar_create_draft(plain_draft("Gốc", vec![source.clone()]))
        .expect("original");
    let original_id = original.radar.id.clone();

    // Field cap (12 on Personal) applies to the edited copy exactly like a new radar.
    let mut too_many_fields = service.radar_variant_prepare(&original_id).unwrap().input;
    too_many_fields.fields = (0..13)
        .map(|i| FieldDef {
            key: format!("field_{i}"),
            label: format!("Trường {i}"),
            order: i,
            ..money_field()
        })
        .collect();
    let err = service
        .radar_create_variant(CreateRadarVariantInput {
            source_radar_id: original_id.clone(),
            input: too_many_fields,
        })
        .expect_err("13 fields must fail");
    assert!(matches!(err, CoreError::LicenseLimitExceeded(_)));
    assert_eq!(service.radar_list().unwrap().len(), 1, "nothing was saved");

    // Active-radar cap (2 on Personal) is enforced when the variant is enabled, not when saved.
    service
        .radar_set_status(&original_id, RadarStatus::Active)
        .await
        .unwrap();
    let mut variant_ids = Vec::new();
    for _ in 0..2 {
        let proposal = service.radar_variant_prepare(&original_id).unwrap();
        variant_ids.push(
            service
                .radar_create_variant(CreateRadarVariantInput {
                    source_radar_id: original_id.clone(),
                    input: proposal.input,
                })
                .expect("drafts are not limited")
                .radar
                .id,
        );
    }
    service
        .radar_set_status(&variant_ids[0], RadarStatus::Active)
        .await
        .expect("second active radar fits the plan");
    let err = service
        .radar_set_status(&variant_ids[1], RadarStatus::Active)
        .await
        .expect_err("third active radar exceeds the plan");
    assert!(matches!(err, CoreError::LicenseLimitExceeded(_)));
    assert_eq!(
        service.radar_get(&variant_ids[1]).unwrap().radar.status,
        RadarStatus::Draft
    );

    // Unknown sources and unknown originals are rejected without writing anything.
    let mut bad_source = service.radar_variant_prepare(&original_id).unwrap().input;
    bad_source.source_ids = vec!["missing-source".to_string()];
    assert!(matches!(
        service.radar_create_variant(CreateRadarVariantInput {
            source_radar_id: original_id.clone(),
            input: bad_source,
        }),
        Err(CoreError::Validation(_))
    ));
    assert!(matches!(
        service.radar_variant_prepare("missing-radar"),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        service.radar_create_variant(CreateRadarVariantInput {
            source_radar_id: "missing-radar".to_string(),
            input: plain_draft("Mồ côi", Vec::new()),
        }),
        Err(CoreError::NotFound { .. })
    ));
    assert_eq!(service.radar_list().unwrap().len(), 3);

    service.shutdown().await.expect("shutdown");
}
