//! One interpretation of a free-text Radar goal for Desktop and local agents: trade side,
//! excluded audience, fields, connected sources and assumptions, all editable before enabling.

use dealsonar_core::dto::{
    AuthorRole, CreateRadarDraftInput, MatchPolicy, RadarStatus, SuggestFieldsInput,
    SuggestFieldsResult, UpdateRadarInput, WantIntent,
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

fn seed_group(core: &CoreService, external_id: &str, name: &str) -> String {
    core.store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: external_id.into(),
                name: name.into(),
                url: format!("https://www.facebook.com/groups/{external_id}"),
                privacy: Some("public".into()),
                member_count: Some(1_000),
            }],
            Some(true),
            Some("Profile 1"),
            now_ms(),
        )
        .expect("seed group");
    core.source_list()
        .expect("sources")
        .into_iter()
        .find(|source| source.name == name)
        .expect("seeded source")
        .id
}

async fn interpret(core: &CoreService, description: &str) -> SuggestFieldsResult {
    core.radar_suggest_fields(SuggestFieldsInput {
        description: description.into(),
        user_profession: None,
        template_id: None,
        language_hint: Some("vi".into()),
        suggest_sources: true,
    })
    .await
    .expect("interpret goal")
}

fn draft_from(
    description: &str,
    result: &SuggestFieldsResult,
    source_ids: &[String],
) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: result.suggested_name.clone(),
        template_id: None,
        description: description.into(),
        user_profession: None,
        language_hint: None,
        fields: result.fields.clone(),
        match_policy: MatchPolicy {
            want_intent: result.want_intent,
            exclude_roles: result.exclude_roles.clone(),
            hard_filters: result.hard_filters.clone(),
            assumptions: result.assumptions.clone(),
            condition: None,
        },
        source_ids: source_ids.to_vec(),
        notify: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opposing_briefs_share_a_group_and_an_unlisted_trade_needs_no_template() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());
    let apartments = seed_group(&core, "g-apartments", "Cộng đồng thuê căn hộ Tân Phú");
    let pickleball = seed_group(&core, "g-pickleball", "Hội pickleball Thủ Đức");

    let seeker_brief = "Tìm người cần thuê căn hộ ở Tân Phú dưới 8 triệu";
    let seeker = interpret(&core, seeker_brief).await;
    assert_eq!(seeker.want_intent, WantIntent::Demand);
    assert!(!seeker.side_ambiguous);
    assert_eq!(seeker.exclude_roles, vec![AuthorRole::Peer]);
    assert!(
        seeker
            .assumptions
            .iter()
            .any(|a| a.contains("người cùng nghề")),
        "excluding same-trade authors is shown as an assumption: {:?}",
        seeker.assumptions
    );
    assert_eq!(seeker.suggested_source_ids, vec![apartments.clone()]);

    let owner_brief = "Tìm căn hộ cho thuê chính chủ ở Tân Phú";
    let owner = interpret(&core, owner_brief).await;
    assert_eq!(owner.want_intent, WantIntent::Supply);
    assert_eq!(owner.suggested_source_ids, vec![apartments.clone()]);

    let unlisted_brief = "Tìm người cần thuê sân pickleball ở Thủ Đức";
    let unlisted = interpret(&core, unlisted_brief).await;
    assert!(!unlisted.fields.is_empty());
    assert_eq!(unlisted.suggested_source_ids, vec![pickleball.clone()]);

    let seeker_radar = core
        .radar_create_draft(draft_from(seeker_brief, &seeker, &[apartments.clone()]))
        .unwrap();
    let owner_radar = core
        .radar_create_draft(draft_from(owner_brief, &owner, &[apartments.clone()]))
        .unwrap();
    let unlisted_radar = core
        .radar_create_draft(draft_from(unlisted_brief, &unlisted, &[pickleball]))
        .unwrap();
    for radar in [&seeker_radar, &owner_radar, &unlisted_radar] {
        assert_eq!(radar.radar.status, RadarStatus::Draft);
        assert_eq!(radar.radar.template_id, None);
    }
    assert_eq!(seeker_radar.radar.source_ids, owner_radar.radar.source_ids);
    assert_eq!(
        seeker_radar.current_version_data.match_policy.want_intent,
        WantIntent::Demand
    );
    assert_eq!(
        owner_radar.current_version_data.match_policy.want_intent,
        WantIntent::Supply
    );
    assert_eq!(
        seeker_radar.current_version_data.match_policy.assumptions,
        seeker.assumptions
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ambiguous_brief_stays_neutral_and_asks_instead_of_guessing_a_side() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());

    let result = interpret(&core, "Tìm xe tải hoặc tìm hàng chở khu vực Quận 7").await;
    assert!(result.side_ambiguous);
    assert_eq!(result.want_intent, WantIntent::Any);
    assert!(
        result.exclude_roles.is_empty(),
        "same-trade authors must not be dropped while the side is unknown"
    );
    assert!(!result.clarifying_questions.is_empty());
    assert!(result
        .assumptions
        .iter()
        .any(|a| a.starts_with("Chưa rõ bạn muốn tìm bài của người cần")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_keeps_peers_when_the_user_wants_to_connect_with_them() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());

    let result = interpret(
        &core,
        "Tìm đối tác môi giới cần thuê căn hộ Tân Phú để hợp tác",
    )
    .await;
    assert_eq!(result.want_intent, WantIntent::Demand);
    assert!(result.exclude_roles.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_connected_groups_are_suggested() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());
    let working = seed_group(&core, "g-ok", "Cộng đồng thuê căn hộ Tân Phú");
    let broken = seed_group(&core, "g-broken", "Thuê căn hộ Tân Phú giá rẻ");
    core.store().source_set_state(&broken, "error").unwrap();

    let result = interpret(&core, "Tìm người cần thuê căn hộ ở Tân Phú").await;
    assert_eq!(result.suggested_source_ids, vec![working]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_edits_survive_closing_and_reopening_a_draft() {
    let dir = tempfile::tempdir().unwrap();
    let core = start(dir.path());
    let group = seed_group(&core, "g-apartments", "Cộng đồng thuê căn hộ Tân Phú");
    let brief = "Tìm người cần thuê căn hộ ở Tân Phú";
    let result = interpret(&core, brief).await;
    let created = core
        .radar_create_draft(draft_from(brief, &result, &[group]))
        .unwrap();
    let id = created.radar.id.clone();

    let mut fields = created.current_version_data.fields.clone();
    fields[0].label = "Khu vực (sửa tay)".into();
    let edited_policy = MatchPolicy {
        want_intent: WantIntent::Any,
        exclude_roles: vec![],
        hard_filters: vec![],
        assumptions: vec!["Chỉ tính Tân Phú, không tính Tân Bình.".into()],
        condition: None,
    };
    core.radar_update(UpdateRadarInput {
        id: id.clone(),
        name: Some("Radar đã chỉnh".into()),
        fields: Some(fields.clone()),
        match_policy: Some(edited_policy.clone()),
        ..UpdateRadarInput::default()
    })
    .unwrap();
    core.shutdown().await.unwrap();
    drop(core);

    let reopened = start(dir.path()).radar_get(&id).unwrap();
    assert_eq!(reopened.radar.name, "Radar đã chỉnh");
    assert_eq!(reopened.radar.status, RadarStatus::Draft);
    assert_eq!(
        reopened.current_version_data.fields[0].label,
        "Khu vực (sửa tay)"
    );
    assert_eq!(reopened.current_version_data.match_policy, edited_policy);
}
