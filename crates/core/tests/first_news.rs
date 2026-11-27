//! First-run journey: install time is recorded once and kept apart from the time the first Radar
//! was created and switched on.

use std::time::Duration;

use dealsonar_core::dto::{
    CreateRadarDraftInput, FieldDef, FieldType, MatchPolicy, RadarStatus, WantIntent,
};
use dealsonar_core::{CoreConfig, CoreService, CoreServiceBuilder};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput};

fn start(data_dir: &std::path::Path) -> CoreService {
    CoreServiceBuilder::open_for_test(CoreConfig {
        data_dir: data_dir.to_owned(),
        spawn_background_workers: false,
        ..CoreConfig::default()
    })
    .expect("open")
    .start()
    .expect("start")
}

fn draft(source_id: &str) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: "Khách thuê".into(),
        template_id: None,
        description: "Người cần thuê căn hộ".into(),
        user_profession: None,
        language_hint: None,
        fields: vec![FieldDef {
            key: "area".into(),
            label: "Khu vực".into(),
            r#type: FieldType::Location,
            description: "Khu vực cần thuê".into(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 1,
        }],
        match_policy: MatchPolicy {
            want_intent: WantIntent::Demand,
            exclude_roles: vec![],
            hard_filters: vec![],
            assumptions: vec![],
        },
        source_ids: vec![source_id.into()],
        notify: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_time_is_separate_from_radar_creation_and_activation() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());
    let fresh = core.first_news_status().unwrap();
    assert!(!fresh.installed_at_estimated);
    assert_eq!(fresh.first_radar_activated_at, None);
    assert_eq!(fresh.facts.first_radar_created_at, None);
    assert_eq!(fresh.facts.active_radars, 0);
    assert_eq!(fresh.facts.leads_total, 0);

    tokio::time::sleep(Duration::from_millis(20)).await;
    core.store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: "g1".into(),
                name: "Cộng đồng thuê căn hộ".into(),
                url: "https://www.facebook.com/groups/g1".into(),
                privacy: None,
                member_count: None,
            }],
            Some(true),
            Some("Profile 1"),
            now_ms(),
        )
        .unwrap();
    let source_id = core.source_list().unwrap()[0].id.clone();
    let created = core.radar_create_draft(draft(&source_id)).unwrap();
    let after_create = core.first_news_status().unwrap();
    assert_eq!(after_create.installed_at, fresh.installed_at);
    assert!(after_create.facts.first_radar_created_at.unwrap() > fresh.installed_at);
    assert_eq!(
        after_create.first_radar_activated_at, None,
        "creating a draft is not switching a Radar on"
    );

    tokio::time::sleep(Duration::from_millis(20)).await;
    core.radar_set_status(&created.radar.id, RadarStatus::Active)
        .await
        .unwrap();
    let active = core.first_news_status().unwrap();
    let activated = active.first_radar_activated_at.unwrap();
    assert!(activated > active.facts.first_radar_created_at.unwrap());
    assert_eq!(active.facts.active_radars, 1);
    assert_eq!(active.facts.active_sources, 1);
    assert_eq!(active.facts.posts_captured, 0, "nothing collected yet");

    // Pausing and switching on again does not move the first-activation time.
    core.radar_set_status(&created.radar.id, RadarStatus::Paused)
        .await
        .unwrap();
    core.radar_set_status(&created.radar.id, RadarStatus::Active)
        .await
        .unwrap();
    assert_eq!(
        core.first_news_status().unwrap().first_radar_activated_at,
        Some(activated)
    );

    core.shutdown().await.unwrap();
    drop(core);
    let restarted = start(dir.path());
    assert_eq!(
        restarted.first_news_status().unwrap().installed_at,
        fresh.installed_at,
        "install time survives restarts"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn existing_data_gives_an_estimated_install_time() {
    let dir = tempfile::tempdir().unwrap();
    let old = now_ms() - 5 * 86_400_000;
    {
        // A database written before install time was recorded.
        let db = dir.path().join("dealsonar.db");
        std::fs::create_dir_all(dir.path().join("backups")).unwrap();
        let store = dealsonar_store::Store::open(&db, dir.path().join("backups")).unwrap();
        store
            .upsert_discovered_sources(
                &[DiscoveredSourceInput {
                    platform: "facebook".into(),
                    kind: "group".into(),
                    external_id: "old".into(),
                    name: "Nhóm cũ".into(),
                    url: "https://www.facebook.com/groups/old".into(),
                    privacy: None,
                    member_count: None,
                }],
                Some(true),
                Some("Profile 1"),
                old,
            )
            .unwrap();
    }
    let status = start(dir.path()).first_news_status().unwrap();
    assert!(status.installed_at_estimated);
    assert_eq!(status.installed_at, old);
}
