//! UI <-> desktop contract for radar variants: the JSON shapes `api.ts` sends and receives.

use std::sync::Arc;

use dealsonar_core::CoreConfig;
use dealsonar_desktop::commands::invoke_command_json;
use dealsonar_desktop::state::DesktopState;
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn variant_commands_round_trip_through_the_ui_contract() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_dir = tmp.path().join("data");
    let cfg = CoreConfig {
        data_dir: data_dir.clone(),
        spawn_background_workers: false,
        ..CoreConfig::default()
    };
    let core = Arc::new(
        dealsonar_core::CoreServiceBuilder::open_for_test(cfg)
            .expect("open_for_test")
            .start()
            .expect("start core"),
    );
    let state = DesktopState::from_core(core, data_dir, tmp.path().join("dealsonar-native-host"));

    let original = invoke_command_json(
        &state,
        "radar_create_draft",
        json!({ "input": {
            "name": "Khách thuê Cầu Giấy",
            "description": "Người cần thuê căn hộ ở Cầu Giấy",
            "user_profession": "Môi giới",
            "fields": [{ "key": "price", "label": "Giá", "type": "money" }],
            "match_policy": { "want_intent": "demand", "exclude_roles": ["peer"], "hard_filters": [] },
            "notify": { "mode": "digest", "min_score": 0.7, "channel_ids": [], "lead_ttl_hours": 24 }
        }}),
    )
    .await
    .expect("radar_create_draft");
    let original_id = original["radar"]["id"].as_str().unwrap().to_string();
    assert!(original["radar"].get("variant_of").is_none());

    let proposal = invoke_command_json(
        &state,
        "radar_variant_prepare",
        json!({ "source_radar_id": original_id }),
    )
    .await
    .expect("radar_variant_prepare");
    assert_eq!(proposal["source_radar_id"], json!(original_id));
    assert_eq!(proposal["source_radar_name"], json!("Khách thuê Cầu Giấy"));
    let mut input = proposal["input"].clone();
    assert_eq!(input["fields"][0]["key"], json!("price"));
    assert_eq!(input["notify"]["mode"], json!("digest"));
    assert_eq!(input["notify"]["lead_ttl_hours"], json!(24));
    input["name"] = json!("Khách thuê Thủ Đức");

    let variant = invoke_command_json(
        &state,
        "radar_create_variant",
        json!({ "input": { "source_radar_id": original_id, "input": input } }),
    )
    .await
    .expect("radar_create_variant");
    assert_eq!(variant["radar"]["status"], json!("draft"));
    assert_eq!(variant["radar"]["variant_of"], json!(original_id));
    assert_ne!(variant["radar"]["id"], json!(original_id));
    assert_eq!(variant["current_version_data"]["version"], json!(1));

    let list = invoke_command_json(&state, "radar_list", json!({}))
        .await
        .expect("radar_list");
    let items = list.as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .any(|r| r["id"] == variant["radar"]["id"] && r["variant_of"] == json!(original_id)));
}
