//! Comparing two radar definitions on one shared set of posts: which posts appear, disappear
//! or change extracted fields, and the guarantee that a comparison has no side effects.

use std::sync::{Arc, Mutex};

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{
    AuthorRole, CompareChange, CreateRadarDraftInput, FieldDef, FieldType, FilterOperator,
    HardFilter, MatchPolicy, RadarCompareInput, RadarCompareSide, RadarStatus, WantIntent,
    WhenMissing,
};
use dealsonar_core::{CoreConfig, CoreError, CoreService, CoreServiceBuilder, OsNotification};
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput};
use dealsonar_store::Store;
use serde_json::json;

const GROUP: &str = "grp_compare";

fn raw_post(post_id: &str, text: &str, now: i64) -> RawPost {
    RawPost {
        platform: "facebook".to_string(),
        source_external_id: GROUP.to_string(),
        post_id: post_id.to_string(),
        permalink: format!("https://www.facebook.com/groups/{GROUP}/posts/{post_id}"),
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

fn field(key: &str, label: &str, r#type: FieldType, order: i32) -> FieldDef {
    FieldDef {
        key: key.to_string(),
        label: label.to_string(),
        r#type,
        description: format!("{label} nêu trong bài"),
        required: false,
        options: None,
        show_in_alert: true,
        order,
    }
}

fn draft(
    name: &str,
    source_ids: Vec<String>,
    location_type: FieldType,
    max_price: Option<i64>,
) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: name.to_string(),
        template_id: None,
        description: "Tìm khách cần thuê căn hộ Cầu Giấy".to_string(),
        language_hint: Some("vi".to_string()),
        user_profession: Some("Môi giới cho thuê".to_string()),
        fields: vec![
            field("price", "Giá thuê", FieldType::Money, 1),
            field("location", "Khu vực", location_type, 2),
        ],
        match_policy: MatchPolicy {
            want_intent: WantIntent::Demand,
            exclude_roles: vec![AuthorRole::Peer],
            hard_filters: max_price
                .map(|max| {
                    vec![HardFilter {
                        field: "price".to_string(),
                        op: FilterOperator::Lte,
                        value: json!(max),
                        when_missing: WhenMissing::Pass,
                    }]
                })
                .unwrap_or_default(),
            assumptions: Vec::new(),
            condition: None,
        },
        source_ids,
        notify: None,
    }
}

fn side(radar_id: &str) -> RadarCompareSide {
    RadarCompareSide {
        radar_id: radar_id.to_string(),
        version: None,
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

fn counts(service: &CoreService) -> std::collections::BTreeMap<String, i64> {
    service.store().table_row_counts().expect("row counts")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_reports_appearing_disappearing_and_changed_posts_without_side_effects() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let notified: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notified);
    service.set_os_notification_hook(Some(Arc::new(move |n: OsNotification| {
        sink.lock().unwrap().push(n.lead_id);
    })));

    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: GROUP.to_string(),
                name: "Thuê nhà Cầu Giấy".to_string(),
                url: format!("https://www.facebook.com/groups/{GROUP}"),
                privacy: Some("public".to_string()),
                member_count: None,
            }],
            Some(true),
            None,
            now,
        )
        .expect("source");
    let source_id = service.source_list().unwrap()[0].id.clone();
    let source = service.store().source_get(&source_id).unwrap().unwrap();

    // A: running radar that only wants rents up to 15 million.
    let a = service
        .radar_create_draft(draft(
            "Thuê tới 15tr",
            vec![source_id.clone()],
            FieldType::Text,
            Some(15_000_000),
        ))
        .expect("A");
    let a_id = a.radar.id.clone();
    service
        .radar_set_status(&a_id, RadarStatus::Active)
        .await
        .expect("activate A");

    let texts = [
        (
            "cheap",
            "Gia đình em cần thuê căn hộ 2PN Cầu Giấy giá 12 triệu/tháng LH 0912345678",
        ),
        (
            "pricey",
            "Em cần thuê căn hộ 3PN Cầu Giấy ngân sách 18 triệu/tháng LH 0912000111",
        ),
        (
            "landlord",
            "Chính chủ cho thuê căn hộ 2PN Cầu Giấy giá 13 triệu/tháng LH 0988777666",
        ),
    ];
    for (id, text) in texts {
        dealsonar_core::pipeline::ingest_raw_post(
            service.runtime(),
            &source,
            &raw_post(id, text, now),
            now,
        )
        .expect("ingest");
    }
    service.tick_workers_now().await.expect("tick");
    let a_leads_before = service.store().table_row_counts().unwrap()["leads"];
    assert!(a_leads_before >= 1, "A already holds real leads");
    let notified_before = notified.lock().unwrap().len();

    // B: a variant with no price cap and a typed location field.
    let b = service
        .radar_create_draft(draft(
            "Thuê không giới hạn",
            vec![source_id.clone()],
            FieldType::Location,
            None,
        ))
        .expect("B");
    let b_id = b.radar.id.clone();
    // C: a variant with a much stricter cap.
    let c = service
        .radar_create_draft(draft(
            "Thuê tới 10tr",
            vec![source_id.clone()],
            FieldType::Text,
            Some(10_000_000),
        ))
        .expect("C");
    let c_id = c.radar.id.clone();

    let snapshot = counts(&service);
    let a_preview_before = service.radar_preview_get(&a_id, None).is_err();

    // 1. A -> B on the group's posts: the pricey post appears, location extraction changes.
    let ab = service
        .radar_compare_run(RadarCompareInput {
            left: side(&a_id),
            right: side(&b_id),
            source_ids: Some(vec![source_id.clone()]),
            post_ids: None,
            max_posts: None,
        })
        .await
        .expect("compare A vs B");

    // The comparison records what it used.
    assert_eq!(ab.left.version, 1);
    assert_eq!(ab.left.version_id, a.current_version_data.id);
    assert_eq!(ab.right.version_id, b.current_version_data.id);
    assert_eq!(ab.source_ids, vec![source_id.clone()]);
    assert_eq!(ab.post_ids.len(), 3);
    assert_eq!(ab.counts.total, 3);
    assert!(ab.definition_diff.hard_filters_changed);
    assert_eq!(
        ab.definition_diff.fields_changed,
        vec!["location".to_string()]
    );

    let by_text = |c: &dealsonar_core::dto::RadarComparison, needle: &str| {
        c.items
            .iter()
            .find(|i| i.post_text.as_deref().is_some_and(|t| t.contains(needle)))
            .unwrap_or_else(|| panic!("item containing {needle}"))
            .clone()
    };
    let pricey = by_text(&ab, "18 triệu");
    assert_eq!(pricey.change, CompareChange::NewlyMatched);
    assert_eq!(pricey.left.reject_reason.as_deref(), Some("hard_filter"));
    assert!(pricey.reason.contains("Mới khớp ở B"), "{}", pricey.reason);
    assert!(
        pricey.reason.contains("điều kiện lọc cứng"),
        "{}",
        pricey.reason
    );

    let cheap = by_text(&ab, "12 triệu");
    // Still matches, but the typed location field now extracts a value.
    assert_eq!(cheap.change, CompareChange::FieldsChanged);
    assert_eq!(cheap.field_changes.len(), 1);
    assert_eq!(cheap.field_changes[0].key, "location");
    assert!(cheap.field_changes[0].before.is_none());
    assert!(cheap.field_changes[0].after.is_some());
    assert!(cheap.reason.contains("Khu vực"), "{}", cheap.reason);
    assert_eq!(ab.counts.fields_changed, 1);
    assert_eq!(ab.counts.newly_matched, 1);

    let landlord = by_text(&ab, "Chính chủ");
    assert_eq!(landlord.change, CompareChange::StillUnmatched);
    assert!(landlord.reason.contains("Không khớp ở cả hai"));

    // 2. A -> C: a stricter cap makes the 12 million post disappear.
    let ac = service
        .radar_compare_run(RadarCompareInput {
            left: side(&a_id),
            right: side(&c_id),
            source_ids: Some(vec![source_id.clone()]),
            post_ids: None,
            max_posts: None,
        })
        .await
        .expect("compare A vs C");
    let gone = by_text(&ac, "12 triệu");
    assert_eq!(gone.change, CompareChange::NoLongerMatched);
    assert!(gone.reason.contains("Hết khớp ở B"), "{}", gone.reason);
    assert_eq!(ac.counts.no_longer_matched, 1);
    assert_eq!(
        ac.items[0].change,
        CompareChange::NoLongerMatched,
        "changes first"
    );

    // 3. Explicit shared posts are recorded exactly.
    let subset = vec![ab.post_ids[0].clone(), ab.post_ids[1].clone()];
    let explicit = service
        .radar_compare_run(RadarCompareInput {
            left: side(&a_id),
            right: side(&b_id),
            source_ids: None,
            post_ids: Some(subset.clone()),
            max_posts: None,
        })
        .await
        .expect("compare explicit posts");
    assert_eq!(explicit.post_ids, subset);
    assert!(explicit.source_ids.is_empty());

    // 4. The record can be listed and read back.
    let listed = service.radar_compare_list().expect("list");
    assert_eq!(listed.len(), 3);
    assert_eq!(listed[0].id, explicit.id);
    let reread = service.radar_compare_get(&ab.id).expect("get");
    assert_eq!(reread.left.version_id, ab.left.version_id);
    assert_eq!(reread.post_ids, ab.post_ids);
    assert_eq!(reread.items.len(), ab.items.len());

    // 5. No leads, contacts, notifications, scratch rows or preview state were created.
    // Only the AI usage log and the comparison records (3 runs + their index) are written.
    let mut after = counts(&service);
    assert!(after["ai_calls"] > snapshot["ai_calls"]);
    assert_eq!(after["settings"], snapshot["settings"] + 4);
    let mut before = snapshot.clone();
    for table in ["ai_calls", "settings"] {
        after.remove(table);
        before.remove(table);
    }
    assert_eq!(
        after, before,
        "no leads, contacts, evaluations or outbox rows"
    );
    assert_eq!(
        service.store().table_row_counts().unwrap()["leads"],
        a_leads_before
    );
    assert_eq!(notified.lock().unwrap().len(), notified_before);
    assert_eq!(
        service.radar_preview_get(&a_id, None).is_err(),
        a_preview_before
    );
    assert_eq!(
        service.radar_get(&b_id).unwrap().radar.status,
        RadarStatus::Draft
    );

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_validates_its_inputs_and_pins_versions() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let a = service
        .radar_create_draft(draft("A", Vec::new(), FieldType::Text, None))
        .expect("A");
    let b = service
        .radar_create_draft(draft("B", Vec::new(), FieldType::Text, None))
        .expect("B");
    let run = |input: RadarCompareInput| service.radar_compare_run(input);
    let base = RadarCompareInput {
        left: side(&a.radar.id),
        right: side(&b.radar.id),
        source_ids: None,
        post_ids: None,
        max_posts: None,
    };

    // No shared group and no explicit set.
    assert!(matches!(
        run(base.clone()).await,
        Err(CoreError::Validation(_))
    ));
    // Both explicit posts and groups is ambiguous.
    assert!(matches!(
        run(RadarCompareInput {
            source_ids: Some(vec!["s".into()]),
            post_ids: Some(vec!["p".into()]),
            ..base.clone()
        })
        .await,
        Err(CoreError::Validation(_))
    ));
    // Unknown radar, version and source.
    assert!(matches!(
        run(RadarCompareInput {
            left: side("missing"),
            ..base.clone()
        })
        .await,
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        run(RadarCompareInput {
            left: RadarCompareSide {
                radar_id: a.radar.id.clone(),
                version: Some(9)
            },
            ..base.clone()
        })
        .await,
        Err(CoreError::NotFound {
            entity: "radar_version",
            ..
        })
    ));
    assert!(matches!(
        run(RadarCompareInput {
            source_ids: Some(vec!["missing-source".into()]),
            ..base
        })
        .await,
        Err(CoreError::NotFound {
            entity: "source",
            ..
        })
    ));
    assert!(service.radar_compare_list().unwrap().is_empty());
    assert!(matches!(
        service.radar_compare_get("nope"),
        Err(CoreError::NotFound { .. })
    ));

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_different_radars_on_one_group_are_compared_without_leads_or_notifications() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let now = now_ms();
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: GROUP.to_string(),
                name: "Vận tải ghép hàng".to_string(),
                url: format!("https://www.facebook.com/groups/{GROUP}"),
                privacy: Some("public".to_string()),
                member_count: None,
            }],
            Some(true),
            None,
            now,
        )
        .expect("source");
    let source_id = service.source_list().unwrap()[0].id.clone();
    let source = service.store().source_get(&source_id).unwrap().unwrap();
    for (id, text) in [
        (
            "need_truck",
            "Cần thuê xe tải 5 tấn chở hàng từ Hà Nội đi Vinh ngày mai LH 0912345678",
        ),
        (
            "empty_truck",
            "Chính chủ cho thuê xe tải 5 tấn trống chiều về Hà Nội, nhận ghép hàng LH 0988111222",
        ),
    ] {
        dealsonar_core::pipeline::ingest_raw_post(
            service.runtime(),
            &source,
            &raw_post(id, text, now),
            now,
        )
        .expect("ingest");
    }

    let radar = |name: &str, intent: WantIntent, key: &str, label: &str| {
        let mut input = draft(name, vec![source_id.clone()], FieldType::Text, None);
        input.description = format!("{name} trên nhóm vận tải");
        input.fields = vec![field(key, label, FieldType::Text, 1)];
        input.match_policy.want_intent = intent;
        input
    };
    let find_truck = service
        .radar_create_draft(radar("Tìm xe", WantIntent::Demand, "load", "Loại hàng"))
        .expect("find truck");
    let find_cargo = service
        .radar_create_draft(radar("Tìm hàng", WantIntent::Supply, "truck", "Loại xe"))
        .expect("find cargo");
    let snapshot = counts(&service);

    let cmp = service
        .radar_compare_run(RadarCompareInput {
            left: side(&find_truck.radar.id),
            right: side(&find_cargo.radar.id),
            source_ids: Some(vec![source_id.clone()]),
            post_ids: None,
            max_posts: None,
        })
        .await
        .expect("compare");

    let item = |needle: &str| {
        cmp.items
            .iter()
            .find(|i| i.post_text.as_deref().is_some_and(|t| t.contains(needle)))
            .expect("item")
            .clone()
    };
    let need = item("Cần thuê xe tải");
    assert_eq!(need.change, CompareChange::NoLongerMatched);
    assert!(need.reason.contains("Hết khớp ở B"), "{}", need.reason);
    let empty = item("trống chiều về");
    assert_eq!(empty.change, CompareChange::NewlyMatched);
    assert!(cmp.definition_diff.want_intent_changed);
    assert_eq!(
        cmp.definition_diff.fields_only_left,
        vec!["load".to_string()]
    );
    assert_eq!(
        cmp.definition_diff.fields_only_right,
        vec!["truck".to_string()]
    );
    assert_eq!(cmp.post_ids.len(), 2);

    let mut after = counts(&service);
    let mut before = snapshot;
    for table in ["ai_calls", "settings"] {
        after.remove(table);
        before.remove(table);
    }
    assert_eq!(after, before);
    assert_eq!(after["leads"], 0);
    assert_eq!(after["outbox"], 0);

    service.shutdown().await.expect("shutdown");
}
