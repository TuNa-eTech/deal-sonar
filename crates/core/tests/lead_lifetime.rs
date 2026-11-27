//! Lead lifetime (`notify.lead_ttl_hours`): a lead found after it stopped being actionable
//! still lands in the app but must not ping the user, and the queue can split live/expired.

use std::sync::{Arc, Mutex};

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{
    AuthorRole, CreateRadarDraftInput, FieldDef, FieldType, LeadFilterQuery, MatchPolicy,
    RadarNotifyPatch, RadarStatus, WantIntent,
};
use dealsonar_core::{CoreConfig, CoreServiceBuilder, OsNotification};
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput};
use dealsonar_store::Store;

const HOUR: i64 = 3_600_000;

fn raw_post(post_id: &str, author: &str, text: &str, created_at: i64, captured_at: i64) -> RawPost {
    RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_ttl".to_string(),
        post_id: post_id.to_string(),
        permalink: format!("https://www.facebook.com/groups/grp_ttl/posts/{post_id}"),
        author: AuthorInfo {
            name: author.to_string(),
            external_id: Some(format!("uid_{post_id}")),
            is_anonymous: false,
        },
        text: text.to_string(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(created_at),
        captured_at,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_leads_are_kept_but_not_notified() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = CoreServiceBuilder::new(Store::open_in_memory().expect("store"))
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service");

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
                external_id: "grp_ttl".to_string(),
                name: "Thuê nhà Cầu Giấy".to_string(),
                url: "https://www.facebook.com/groups/grp_ttl".to_string(),
                privacy: Some("public".to_string()),
                member_count: None,
            }],
            Some(true),
            None,
            now,
        )
        .expect("source");
    let src_id = service.source_list().expect("sources")[0].id.clone();
    let source = service.store().source_get(&src_id).unwrap().unwrap();

    let draft = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Khách thuê gấp".to_string(),
            template_id: None,
            description: "Tìm khách cần thuê căn hộ Cầu Giấy".to_string(),
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
            notify: Some(RadarNotifyPatch {
                lead_ttl_hours: Some(Some(2)),
                ..Default::default()
            }),
        })
        .expect("draft");
    assert_eq!(draft.radar.notify.lead_ttl_hours, Some(2));
    let rid = draft.radar.id.clone();
    service
        .radar_set_status(&rid, RadarStatus::Active)
        .await
        .expect("activate");

    // Both captured just now; one was posted 5h ago (late crawl), past the 2h lifetime.
    let stale = raw_post(
        "stale_5h",
        "Minh Anh",
        "Gia đình trẻ cần thuê căn hộ 2PN khu Dịch Vọng Cầu Giấy ngân sách 11 triệu/tháng LH 0912345678",
        now - 5 * HOUR,
        now - 1_000,
    );
    let fresh = raw_post(
        "fresh_10m",
        "Thu Hà",
        "Mình cần thuê căn hộ 2PN Cầu Giấy tài chính 10 triệu/tháng dọn vào ngay LH 0912999888",
        now - 10 * 60_000,
        now - 1_000,
    );
    for raw in [&stale, &fresh] {
        dealsonar_core::pipeline::ingest_raw_post(service.runtime(), &source, raw, now)
            .expect("ingest");
    }
    service.tick_workers_now().await.expect("tick");

    let all = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(rid.clone()),
            ..Default::default()
        })
        .expect("leads");
    assert_eq!(
        all.items.len(),
        2,
        "both posts match and are kept in the app"
    );
    let by_post = |ext: &str| {
        all.items
            .iter()
            .find(|l| l.permalink.ends_with(ext))
            .unwrap_or_else(|| panic!("lead for {ext}"))
            .clone()
    };
    let (stale_lead, fresh_lead) = (by_post("stale_5h"), by_post("fresh_10m"));
    assert_eq!(stale_lead.expires_at, Some(now - 5 * HOUR + 2 * HOUR));
    assert_eq!(fresh_lead.expires_at, Some(now - 10 * 60_000 + 2 * HOUR));

    let notified = notified.lock().unwrap().clone();
    assert!(notified.contains(&fresh_lead.id), "fresh lead is notified");
    assert!(
        !notified.contains(&stale_lead.id),
        "expired lead must stay silent"
    );

    let only = |expired: bool| -> Vec<String> {
        service
            .lead_list(LeadFilterQuery {
                radar_id: Some(rid.clone()),
                expired: Some(expired),
                ..Default::default()
            })
            .unwrap()
            .items
            .into_iter()
            .map(|l| l.id)
            .collect()
    };
    assert_eq!(only(false), vec![fresh_lead.id.clone()]);
    assert_eq!(only(true), vec![stale_lead.id.clone()]);

    // Poster history is exposed so the user can tell a first-time customer from a broker.
    let poster = service
        .lead_get(&fresh_lead.id)
        .expect("lead_get")
        .poster
        .expect("poster activity");
    assert_eq!(poster.posts_7d, 1);
    assert_eq!(poster.same_post_groups, 1);
    assert!(!poster.looks_like_peer);

    service.shutdown().await.expect("shutdown");
}
