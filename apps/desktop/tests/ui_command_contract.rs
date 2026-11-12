//! Comprehensive UI <-> Desktop Command Contract Integration Test (`03-desktop.md §4`, `api.ts`).
//!
//! Exercises all 54 domain commands consumed by `apps/desktop/ui/src/lib/api.ts` plus
//! `open_external_url`, autostart synchronization, startup Chrome Native Host manifest refresh,
//! OS notification hooks, real-time `CoreEvent` broadcasting, Ed25519 Personal/Pro licensing,
//! redacted diagnostic bundles, and data lifecycle operations.

use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dealsonar_core::dto::PlanTier;
use dealsonar_core::{CoreConfig, CoreEvent, LicensePayload, LicenseSigner, OsNotification};
use dealsonar_desktop::commands::invoke_command_json;
use dealsonar_desktop::state::DesktopState;
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, AuthorInfo, Body, Envelope, ExtractionInfo,
    ExtractionStrategy, RawPost, SourceInfo, SourcePrivacy, SourceRef, MAX_EXT_TO_HOST_BYTES,
    MAX_HOST_TO_EXT_BYTES,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Minimal local HTTP server mocking Telegram Bot API (`getMe`, `getUpdates`, `sendMessage`).
async fn spawn_mock_telegram_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock telegram server");
    let addr = listener.local_addr().expect("local addr");
    let updates_served = Arc::new(AtomicUsize::new(0));

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let updates_counter = Arc::clone(&updates_served);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let Ok(n) = stream.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");

                let body_json = if first_line.contains("/getMe") {
                    json!({
                        "ok": true,
                        "result": {
                            "id": 99887766_i64,
                            "is_bot": true,
                            "first_name": "DealSonar Bot",
                            "username": "DealSonarTestBot"
                        }
                    })
                } else if first_line.contains("/getUpdates") {
                    let prev = updates_counter.fetch_add(1, Ordering::SeqCst);
                    if prev == 0 {
                        json!({
                            "ok": true,
                            "result": [{
                                "update_id": 1001,
                                "message": {
                                    "message_id": 1,
                                    "date": 1730000000,
                                    "text": "/start dealsonar",
                                    "chat": {
                                        "id": 55667788_i64,
                                        "type": "private",
                                        "first_name": "Anh",
                                        "username": "anhtu_bds"
                                    }
                                }
                            }]
                        })
                    } else {
                        json!({ "ok": true, "result": [] })
                    }
                } else if first_line.contains("/sendMessage") {
                    json!({
                        "ok": true,
                        "result": {
                            "message_id": 4242,
                            "date": 1730000010,
                            "chat": { "id": 55667788_i64, "type": "private" }
                        }
                    })
                } else {
                    json!({ "ok": true, "result": true })
                };

                let body_bytes = serde_json::to_vec(&body_json).unwrap();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body_bytes.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.write_all(&body_bytes).await;
            });
        }
    });

    (format!("http://{addr}"), handle)
}

async fn recv_ipc_env(stream: &mut IpcStream) -> Envelope {
    let bytes = tokio::time::timeout(
        Duration::from_secs(3),
        stream.read_frame(MAX_HOST_TO_EXT_BYTES),
    )
    .await
    .expect("IPC read timeout")
    .expect("IPC frame ok")
    .expect("IPC stream open");
    parse_envelope(&bytes).expect("parse host envelope")
}

async fn recv_ipc_reply(stream: &mut IpcStream, expected_id: &str) -> Envelope {
    loop {
        let env = recv_ipc_env(stream).await;
        if env.reply_to.as_deref() == Some(expected_id) {
            return env;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_ui_to_desktop_command_contract_and_lifecycle() {
    std::env::set_var("DEALSONAR_DISABLE_BROWSER_SPAWN", "1");

    let tmp = tempfile::Builder::new()
        .prefix("ds-ui-")
        .tempdir_in("/tmp")
        .unwrap_or_else(|_| tempfile::tempdir().expect("tempdir"));
    let data_dir = tmp.path().join("data");
    let ipc_sock = IpcEndpoint::from_path(tmp.path().join("ipc.sock"));
    let manifest_path = tmp.path().join("com.dealsonar.host.json");
    let bin_v1 = tmp.path().join("bin-v1").join("dealsonar-native-host");
    let bin_v2 = tmp.path().join("bin-v2").join("dealsonar-native-host");
    fs::create_dir_all(bin_v1.parent().unwrap()).unwrap();
    fs::create_dir_all(bin_v2.parent().unwrap()).unwrap();
    fs::write(&bin_v1, b"#!/bin/sh\n").unwrap();
    fs::write(&bin_v2, b"#!/bin/sh\n").unwrap();

    let (tg_base_url, tg_server) = spawn_mock_telegram_server().await;

    let os_notifications: Arc<Mutex<Vec<OsNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let os_notifications_clone = Arc::clone(&os_notifications);
    let os_hook = Arc::new(move |notif: OsNotification| {
        os_notifications_clone.lock().unwrap().push(notif);
    });

    let signer = LicenseSigner::generate_for_test();
    let verifier = signer.verifier();

    let cfg = CoreConfig {
        data_dir: data_dir.clone(),
        logs_dir: Some(data_dir.join("logs")),
        ipc_endpoint: Some(ipc_sock.clone()),
        chrome_manifest_path: Some(manifest_path.clone()),
        native_host_binary_path: Some(bin_v1.clone()),
        batch_trigger_count: 1,
        batch_max_wait_ms: 0,
        spawn_background_workers: false,
        ..CoreConfig::default()
    };

    let builder = dealsonar_core::CoreServiceBuilder::open_for_test(cfg.clone())
        .expect("open_for_test")
        .with_license_verifier(verifier)
        .with_telegram_api_base_url(&tg_base_url)
        .expect("telegram base url")
        .with_os_notification_hook(os_hook);
    let core = Arc::new(builder.start().expect("start core"));
    let state = DesktopState::from_core(core, data_dir.clone(), bin_v1.clone());

    let mut event_rx = state.core().subscribe_events();

    // ------------------------------------------------------------------------
    // 1. Settings & Autostart Sync (including graceful dev-env error handling)
    // ------------------------------------------------------------------------
    let autostart_calls: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
    let autostart_calls_clone = Arc::clone(&autostart_calls);
    state.set_autostart_sync_hook(Some(Arc::new(move |enabled| {
        autostart_calls_clone.lock().unwrap().push(enabled);
        if !enabled {
            return Err("LaunchAgent unavailable in unbundled dev binary".to_string());
        }
        Ok(())
    })));

    let initial_settings = invoke_command_json(&state, "settings_get", json!({}))
        .await
        .expect("settings_get");
    assert_eq!(initial_settings["launch_at_login"], json!(true));

    let updated_settings = invoke_command_json(
        &state,
        "settings_set",
        json!({
            "patch": {
                "privacy_consent_accepted": true,
                "onboarding_completed": true,
                "launch_at_login": false,
                "daily_ai_post_cap": 1500,
                "os_notifications_enabled": true
            }
        }),
    )
    .await
    .expect("settings_set must succeed even if autostart returns non-fatal error");
    assert_eq!(updated_settings["privacy_consent_accepted"], json!(true));
    assert_eq!(updated_settings["launch_at_login"], json!(false));
    assert_eq!(autostart_calls.lock().unwrap().as_slice(), &[false]);

    // ------------------------------------------------------------------------
    // 2. AI Probe & Set Provider
    // ------------------------------------------------------------------------
    let probe_all = invoke_command_json(&state, "ai_probe", json!({ "provider": null }))
        .await
        .expect("ai_probe all");
    assert!(probe_all["claude_cli"].is_object());
    assert!(probe_all["codex_cli"].is_object());
    assert!(probe_all["agy_cli"].is_object());

    let after_ai_set = invoke_command_json(
        &state,
        "ai_set_provider",
        json!({
            "provider": "claude_cli",
            "model_tiers": { "fast": "haiku", "smart": "sonnet" }
        }),
    )
    .await
    .expect("ai_set_provider");
    assert_eq!(after_ai_set["ai_provider"], json!("claude_cli"));

    // ------------------------------------------------------------------------
    // 3. Templates (`template_list`, `template_get`)
    // ------------------------------------------------------------------------
    let templates = invoke_command_json(&state, "template_list", json!({}))
        .await
        .expect("template_list");
    let tpl_arr = templates.as_array().expect("templates array");
    assert!(
        tpl_arr.len() >= 7,
        "all 7 embedded templates must be available"
    );

    let bds_tpl = invoke_command_json(&state, "template_get", json!({ "id": "bds.khach-thue" }))
        .await
        .expect("template_get bds.khach-thue");
    assert_eq!(bds_tpl["id"], json!("bds.khach-thue"));

    // ------------------------------------------------------------------------
    // 4. Chrome Connect & Manifest Installation
    // ------------------------------------------------------------------------
    let ext_id = "abcdefghijklmnopqrstuvwxyzabcdef";
    let chrome_res = invoke_command_json(
        &state,
        "chrome_connect",
        json!({
            "extension_id": ext_id,
            "resume_crawl": false
        }),
    )
    .await
    .expect("chrome_connect");
    assert_eq!(chrome_res["native_host_installed"], json!(true));
    let manifest_raw_v1 = fs::read_to_string(&manifest_path).expect("read manifest v1");
    assert!(manifest_raw_v1.contains(&bin_v1.to_string_lossy().to_string()));
    assert!(manifest_raw_v1.contains(ext_id));

    // ------------------------------------------------------------------------
    // 5. Sources (`source_list`, `source_follow`, `source_set_priority`, `source_crawl_now`, `source_unfollow`)
    // ------------------------------------------------------------------------
    let mut ipc_client = IpcStream::connect(&ipc_sock).await.expect("connect ipc");
    write_envelope_async(
        &mut ipc_client,
        &Envelope::new(Body::Hello {
            profile_id: "Profile 1".to_string(),
            ext_version: "0.1.0".to_string(),
            browser: "Chrome/131.0".to_string(),
            config_rev: 0,
        }),
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .unwrap();
    let _hello_ok = recv_ipc_env(&mut ipc_client).await;
    let _initial_cfg = recv_ipc_env(&mut ipc_client).await;

    write_envelope_async(
        &mut ipc_client,
        &Envelope::new(Body::SourcesDiscovered {
            follow: Some(false),
            sources: vec![SourceInfo {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "fb_group_cau_giay_01".to_string(),
                name: "Thuê Nhà Căn Hộ Cầu Giấy Hà Nội".to_string(),
                url: "https://www.facebook.com/groups/fb_group_cau_giay_01/".to_string(),
                privacy: Some(SourcePrivacy::Public),
                member_count: Some(85_000),
            }],
        }),
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .unwrap();
    let _disc_ack = recv_ipc_env(&mut ipc_client).await;

    let sources = invoke_command_json(&state, "source_list", json!({}))
        .await
        .expect("source_list");
    let source_id = sources[0]["id"].as_str().expect("source id").to_string();

    let followed = invoke_command_json(&state, "source_follow", json!({ "id": source_id }))
        .await
        .expect("source_follow");
    assert_eq!(followed["followed"], json!(true));
    let _cfg_after_follow = recv_ipc_env(&mut ipc_client).await;

    let prioritized = invoke_command_json(
        &state,
        "source_set_priority",
        json!({ "id": source_id, "priority": true }),
    )
    .await
    .expect("source_set_priority");
    assert_eq!(prioritized["priority"], json!(true));
    let _cfg_after_prio = recv_ipc_env(&mut ipc_client).await;

    let crawl_now = invoke_command_json(
        &state,
        "source_crawl_now",
        json!({ "id": source_id, "reason": "manual" }),
    )
    .await
    .expect("source_crawl_now");
    assert_eq!(crawl_now["queued"], json!(true));
    let _crawl_req_env = recv_ipc_env(&mut ipc_client).await;

    let unfollowed = invoke_command_json(&state, "source_unfollow", json!({ "id": source_id }))
        .await
        .expect("source_unfollow");
    assert_eq!(unfollowed["followed"], json!(false));
    let _cfg_after_unfollow = recv_ipc_env(&mut ipc_client).await;

    let _ = invoke_command_json(&state, "source_follow", json!({ "id": source_id }))
        .await
        .expect("re-follow source");
    let _cfg_after_refollow = recv_ipc_env(&mut ipc_client).await;

    // ------------------------------------------------------------------------
    // 6. Radars, Suggest Fields, Preview & Rulesets
    // ------------------------------------------------------------------------
    let suggested = invoke_command_json(
        &state,
        "radar_suggest_fields",
        json!({
            "input": {
                "description": "Tìm khách cần thuê căn hộ chung cư khu vực Cầu Giấy tài chính 10-16 triệu/tháng",
                "user_profession": "Môi giới BĐS cho thuê",
                "language_hint": "vi"
            }
        }),
    )
    .await
    .expect("radar_suggest_fields");
    assert!(suggested["fields"].as_array().is_some());

    let created_radar = invoke_command_json(
        &state,
        "radar_create_draft",
        json!({
            "input": {
                "name": "Khách thuê chung cư Cầu Giấy",
                "template_id": "bds.khach-thue",
                "description": "Người đang cần thuê căn hộ chung cư ở Cầu Giấy, ngân sách dưới 16 triệu/tháng",
                "user_profession": "Môi giới cho thuê căn hộ",
                "language_hint": "vi",
                "fields": bds_tpl["fields"],
                "match_policy": bds_tpl["match_policy"],
                "source_ids": [source_id],
                "notify": { "mode": "instant", "min_score": 0.6 }
            }
        }),
    )
    .await
    .expect("radar_create_draft");
    let radar_id = created_radar["radar"]["id"]
        .as_str()
        .expect("radar_id")
        .to_string();
    let radar_version_id = created_radar["current_version_data"]["id"]
        .as_str()
        .expect("radar_version_id")
        .to_string();

    let radar_detail = invoke_command_json(&state, "radar_get", json!({ "id": radar_id }))
        .await
        .expect("radar_get");
    assert_eq!(
        radar_detail["radar"]["name"],
        json!("Khách thuê chung cư Cầu Giấy")
    );

    let updated_radar = invoke_command_json(
        &state,
        "radar_update",
        json!({
            "input": {
                "id": radar_id,
                "name": "Khách thuê căn hộ Cầu Giấy VIP"
            }
        }),
    )
    .await
    .expect("radar_update");
    assert_eq!(
        updated_radar["detail"]["radar"]["name"],
        json!("Khách thuê căn hộ Cầu Giấy VIP")
    );

    let radar_list = invoke_command_json(&state, "radar_list", json!({}))
        .await
        .expect("radar_list");
    assert_eq!(radar_list.as_array().unwrap().len(), 1);

    let rulesets = invoke_command_json(
        &state,
        "ruleset_list",
        json!({ "radar_id": radar_id, "radar_version_id": null }),
    )
    .await
    .expect("ruleset_list");
    assert!(!rulesets.as_array().unwrap().is_empty());
    let seed_body = rulesets[0]["body"].clone();

    let saved_user_rs = invoke_command_json(
        &state,
        "ruleset_save_user",
        json!({
            "radar_id": radar_id,
            "radar_version_id": radar_version_id,
            "body": seed_body
        }),
    )
    .await
    .expect("ruleset_save_user");
    assert_eq!(saved_user_rs["origin"], json!("user"));

    let preview_started = invoke_command_json(
        &state,
        "radar_preview_start",
        json!({ "input": { "radar_id": radar_id } }),
    )
    .await
    .expect("radar_preview_start");
    let preview_id = preview_started["preview_id"].as_str().unwrap().to_string();
    let _preview_crawl_req = recv_ipc_env(&mut ipc_client).await;

    let preview_got = invoke_command_json(
        &state,
        "radar_preview_get",
        json!({ "radar_id": radar_id, "preview_id": preview_id }),
    )
    .await
    .expect("radar_preview_get");
    assert_eq!(preview_got["radar_id"], json!(radar_id));

    let active_radar = invoke_command_json(
        &state,
        "radar_set_status",
        json!({ "id": radar_id, "status": "active" }),
    )
    .await
    .expect("radar_set_status active");
    assert_eq!(active_radar["status"], json!("active"));
    let _cfg_after_active = recv_ipc_env(&mut ipc_client).await;

    // ------------------------------------------------------------------------
    // 7. Push Posts -> Pipeline -> Leads, Posts, Rejected Evals, Contacts, Blocklist
    // ------------------------------------------------------------------------
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let push_env = Envelope::new(Body::PostsPush {
        run_id: dealsonar_protocol::new_ulid(),
        source_ref: SourceRef {
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: "fb_group_cau_giay_01".to_string(),
        },
        posts: vec![
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_group_cau_giay_01".to_string(),
                post_id: "fb_post_demand_101".to_string(),
                permalink: "https://www.facebook.com/groups/fb_group_cau_giay_01/posts/101/"
                    .to_string(),
                author: AuthorInfo {
                    name: "Nguyễn Minh Anh".to_string(),
                    external_id: Some("fb_user_khach_thue".to_string()),
                    is_anonymous: false,
                },
                text: "Gia đình mình cần thuê căn hộ chung cư 2PN khu vực Cầu Giấy hoặc Dịch Vọng, ngân sách 13 triệu/tháng, dọn vào ở ngay tuần này. Ai có căn phù hợp liên hệ mình số 0912345678 nhé!".to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now_ms - 60_000),
                captured_at: now_ms,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Dom,
                    profile_rev: 1,
                },
            },
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_group_cau_giay_01".to_string(),
                post_id: "fb_post_supply_spam_102".to_string(),
                permalink: "https://www.facebook.com/groups/fb_group_cau_giay_01/posts/102/"
                    .to_string(),
                author: AuthorInfo {
                    name: "Kho Nhà Đẹp".to_string(),
                    external_id: Some("fb_user_broker_spam".to_string()),
                    is_anonymous: false,
                },
                text: "Chính chủ cho thuê gấp giỏ hàng 50 căn hộ chung cư Cầu Giấy hoa hồng cao cho CTV môi giới inbox ngay".to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now_ms - 30_000),
                captured_at: now_ms,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Dom,
                    profile_rev: 1,
                },
            },
        ],
    });
    write_envelope_async(&mut ipc_client, &push_env, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    let push_ack = recv_ipc_reply(&mut ipc_client, &push_env.id).await;
    assert_eq!(
        push_ack.body,
        Body::Ack {
            accepted: 2,
            duplicates: 0
        }
    );

    for _ in 0..3 {
        state.core().tick_workers_now().await.expect("tick workers");
    }

    let leads_resp = invoke_command_json(
        &state,
        "lead_list",
        json!({
            "query": {
                "radar_id": radar_id,
                "status": ["new"],
                "include_weak": true,
                "limit": 20
            }
        }),
    )
    .await
    .expect("lead_list");
    let lead_items = leads_resp["items"].as_array().expect("lead items");
    let dbg_rejected = invoke_command_json(
        &state,
        "evaluation_list_rejected",
        json!({ "radar_id": radar_id, "limit": 30 }),
    )
    .await
    .expect("evaluation_list_rejected");
    assert_eq!(
        lead_items.len(),
        1,
        "expected 1 lead, got leads={leads_resp}, rejected={dbg_rejected}"
    );
    assert!(
        !os_notifications.lock().unwrap().is_empty(),
        "OS notification hook must fire when instant lead arrives before Telegram is paired; lead={}",
        lead_items[0]
    );

    let mut saw_lead_new = false;
    while let Ok(ev) = event_rx.try_recv() {
        if ev.event_name() == "lead:new" {
            saw_lead_new = true;
        }
    }
    assert!(
        saw_lead_new,
        "CoreEvent::LeadNew ('lead:new') must be broadcast"
    );
    let lead_id = lead_items[0]["id"].as_str().unwrap().to_string();
    let eval_id = lead_items[0]["evaluation_id"].as_str().unwrap().to_string();
    let post_id = lead_items[0]["post_id"].as_str().unwrap().to_string();

    let lead_detail = invoke_command_json(&state, "lead_get", json!({ "id": lead_id }))
        .await
        .expect("lead_get");
    assert_eq!(lead_detail["lead"]["id"], json!(lead_id));

    // `lead_set_status`: set CRM fields -> omit CRM fields (preserve) -> explicit null (clear)
    let st_contacted = invoke_command_json(
        &state,
        "lead_set_status",
        json!({
            "id": lead_id,
            "status": "contacted",
            "note": "Đã gọi hẹn xem căn hộ lúc 18h",
            "tags": ["vip", "2pn"],
            "follow_up_at": 1_760_086_400_000_i64
        }),
    )
    .await
    .expect("lead_set_status with crm");
    assert_eq!(st_contacted["lead"]["status"], json!("contacted"));

    let st_omitted = invoke_command_json(
        &state,
        "lead_set_status",
        json!({
            "id": lead_id,
            "status": "negotiating"
        }),
    )
    .await
    .expect("lead_set_status omitted crm");
    assert_eq!(
        st_omitted["lead"]["note"],
        json!("Đã gọi hẹn xem căn hộ lúc 18h")
    );
    assert_eq!(
        st_omitted["lead"]["follow_up_at"],
        json!(1_760_086_400_000_i64)
    );

    let st_cleared = invoke_command_json(
        &state,
        "lead_set_status",
        json!({
            "id": lead_id,
            "status": "won",
            "follow_up_at": null
        }),
    )
    .await
    .expect("lead_set_status explicit null");
    assert_eq!(st_cleared["lead"]["status"], json!("won"));
    assert_eq!(st_cleared["lead"]["follow_up_at"], Value::Null);
    assert_eq!(
        st_cleared["lead"]["note"],
        json!("Đã gọi hẹn xem căn hộ lúc 18h")
    );

    let after_field = invoke_command_json(
        &state,
        "lead_update_field",
        json!({
            "id": lead_id,
            "field_key": "price",
            "value": 13_500_000,
            "raw": "13.5 triệu/tháng"
        }),
    )
    .await
    .expect("lead_update_field");
    assert_eq!(
        after_field["lead"]["fields"]["price"]["source"],
        json!("user")
    );

    let fb_res = invoke_command_json(
        &state,
        "lead_feedback",
        json!({
            "input": {
                "evaluation_id": eval_id,
                "lead_id": lead_id,
                "label": "correct",
                "origin": "app"
            }
        }),
    )
    .await
    .expect("lead_feedback");
    assert!(fb_res["feedback_id"].as_str().is_some());

    let got_post = invoke_command_json(&state, "post_get", json!({ "id": post_id }))
        .await
        .expect("post_get");
    assert_eq!(got_post["external_id"], json!("fb_post_demand_101"));

    let searched_posts = invoke_command_json(
        &state,
        "post_search",
        json!({ "query": "Cầu Giấy", "source_id": null, "limit": 30 }),
    )
    .await
    .expect("post_search");
    assert!(!searched_posts.as_array().unwrap().is_empty());

    let rejected_evals = invoke_command_json(
        &state,
        "evaluation_list_rejected",
        json!({ "radar_id": radar_id, "limit": 30 }),
    )
    .await
    .expect("evaluation_list_rejected");
    assert!(!rejected_evals.as_array().unwrap().is_empty());

    let contacts = invoke_command_json(
        &state,
        "contact_list",
        json!({ "search": "+84912", "limit": 100 }),
    )
    .await
    .expect("contact_list");
    let contact_id = contacts[0]["id"].as_str().expect("contact id").to_string();

    let contact_detail = invoke_command_json(&state, "contact_get", json!({ "id": contact_id }))
        .await
        .expect("contact_get");
    assert_eq!(contact_detail["contact"]["id"], json!(contact_id));

    let noted_contact = invoke_command_json(
        &state,
        "contact_note",
        json!({ "id": contact_id, "note": "Khách thiện chí, tài chính tốt" }),
    )
    .await
    .expect("contact_note");
    assert_eq!(
        noted_contact["note"],
        json!("Khách thiện chí, tài chính tốt")
    );

    let blocked_contact = invoke_command_json(
        &state,
        "contact_block",
        json!({ "id": contact_id, "reason": "test_block", "radar_id": radar_id }),
    )
    .await
    .expect("contact_block");
    assert!(!blocked_contact["blocked_entries"]
        .as_array()
        .unwrap()
        .is_empty());

    let added_blk = invoke_command_json(
        &state,
        "blocklist_add",
        json!({
            "kind": "keyword",
            "value": "tuyển cộng tác viên",
            "reason": "lọc spam tuyển dụng",
            "radar_id": null
        }),
    )
    .await
    .expect("blocklist_add");
    let blk_id = added_blk["id"].as_str().unwrap().to_string();

    let blk_list = invoke_command_json(&state, "blocklist_list", json!({ "radar_id": null }))
        .await
        .expect("blocklist_list");
    assert!(!blk_list.as_array().unwrap().is_empty());

    let blk_removed = invoke_command_json(&state, "blocklist_remove", json!({ "id": blk_id }))
        .await
        .expect("blocklist_remove");
    assert_eq!(blk_removed["removed"], json!(true));

    // ------------------------------------------------------------------------
    // 8. Personal vs Pro License Enforcement, CSV/XLSX Export, Telegram, Webhooks, Compile
    // ------------------------------------------------------------------------
    let csv_export = invoke_command_json(
        &state,
        "lead_export",
        json!({
            "input": {
                "query": { "radar_id": radar_id, "include_weak": true },
                "format": "csv",
                "include_post_text": true
            }
        }),
    )
    .await
    .expect("CSV export allowed on Personal plan");
    assert_eq!(csv_export["row_count"], json!(1));
    assert!(std::path::Path::new(csv_export["path"].as_str().unwrap()).is_file());

    let xlsx_personal_err = invoke_command_json(
        &state,
        "lead_export",
        json!({
            "input": {
                "query": { "radar_id": radar_id, "include_weak": true },
                "format": "xlsx",
                "include_post_text": false
            }
        }),
    )
    .await
    .expect_err("Personal plan must block XLSX export");
    assert_eq!(xlsx_personal_err.code(), "license_limit_exceeded");

    let initial_lic = invoke_command_json(&state, "license_get", json!({}))
        .await
        .expect("license_get");
    assert_eq!(initial_lic["plan"], json!("personal"));

    let pro_token = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Công ty BĐS Minh Anh".to_string(),
            issued_at: now_ms - 86_400_000,
            expires_at: None,
        })
        .expect("sign pro token");
    let upgraded_lic =
        invoke_command_json(&state, "license_set", json!({ "license_key": pro_token }))
            .await
            .expect("license_set Pro");
    assert_eq!(upgraded_lic["plan"], json!("pro"));
    assert_eq!(upgraded_lic["is_valid"], json!(true));

    let xlsx_export = invoke_command_json(
        &state,
        "lead_export",
        json!({
            "input": {
                "query": { "radar_id": radar_id, "include_weak": true },
                "format": "xlsx",
                "include_post_text": false
            }
        }),
    )
    .await
    .expect("XLSX export allowed on Pro plan");
    assert_eq!(xlsx_export["row_count"], json!(1));
    assert!(std::path::Path::new(xlsx_export["path"].as_str().unwrap()).is_file());

    let compile_res = invoke_command_json(
        &state,
        "ruleset_compile_now",
        json!({ "radar_id": radar_id }),
    )
    .await
    .expect("ruleset_compile_now on Pro");
    assert!(compile_res["job_id"].as_str().is_some());

    let secret_tg_token = "123456:AAFakeSecretBotTokenDoNotLeak999";
    let tg_setup = invoke_command_json(
        &state,
        "telegram_set_token",
        json!({ "token": secret_tg_token }),
    )
    .await
    .expect("telegram_set_token");
    assert_eq!(tg_setup["bot_username"], json!("DealSonarTestBot"));

    state
        .core()
        .tick_workers_now()
        .await
        .expect("poll telegram /start");

    let channels = invoke_command_json(&state, "channel_list", json!({}))
        .await
        .expect("channel_list");
    assert_eq!(channels.as_array().unwrap().len(), 1);

    let tg_test = invoke_command_json(&state, "telegram_test", json!({ "channel_id": null }))
        .await
        .expect("telegram_test");
    assert_eq!(tg_test["ok"], json!(true));

    let secret_wh = "whsec_TopSecretHmacKey987654";
    let wh_ch = invoke_command_json(
        &state,
        "webhook_add",
        json!({
            "name": "CRM Webhook",
            "url": "https://crm.example.com/hooks/dealsonar",
            "secret": secret_wh
        }),
    )
    .await
    .expect("webhook_add");
    let wh_id = wh_ch["id"].as_str().unwrap().to_string();

    // ------------------------------------------------------------------------
    // 9. Health, Stats, Safe Permalink Opener, Diagnostics Redaction & Data Lifecycle
    // ------------------------------------------------------------------------
    let stats = invoke_command_json(
        &state,
        "radar_stats",
        json!({ "radar_id": radar_id, "days": 7 }),
    )
    .await
    .expect("radar_stats");
    assert!(stats["leads_created"].as_i64().unwrap() >= 1);

    let health = invoke_command_json(&state, "health_get", json!({}))
        .await
        .expect("health_get");
    assert_eq!(health["extension_connected"], json!(true));

    let paused_health = state.core().toggle_crawl_paused().expect("pause crawl");
    assert!(paused_health.crawl_paused);
    let resumed_health = state.core().toggle_crawl_paused().expect("resume crawl");
    assert!(!resumed_health.crawl_paused);

    let crawl_runs = invoke_command_json(
        &state,
        "crawl_run_list",
        json!({ "source_id": null, "limit": 50 }),
    )
    .await
    .expect("crawl_run_list");
    assert!(crawl_runs.is_array());

    let ai_usage = invoke_command_json(&state, "ai_usage_get", json!({ "days": 7 }))
        .await
        .expect("ai_usage_get");
    assert!(ai_usage["total_calls"].as_i64().unwrap() >= 0);

    let safe_open = invoke_command_json(
        &state,
        "open_external_url",
        json!({ "url": "https://www.facebook.com/groups/fb_group_cau_giay_01/posts/101/" }),
    )
    .await
    .expect("safe facebook url allowed");
    assert_eq!(safe_open["opened"], json!(true));

    let blocked_open = invoke_command_json(
        &state,
        "open_external_url",
        json!({ "url": "https://www.facebook.com.attacker.evil/phish" }),
    )
    .await
    .expect_err("non-facebook origin must be rejected");
    assert_eq!(blocked_open.code(), "blocked_external_url");

    let diag = invoke_command_json(&state, "diagnostic_bundle_create", json!({}))
        .await
        .expect("diagnostic_bundle_create");
    let diag_file = fs::File::open(diag["path"].as_str().unwrap()).expect("open diag zip");
    let mut archive = zip::ZipArchive::new(diag_file).expect("read zip");
    assert!(!archive.is_empty());
    for idx in 0..archive.len() {
        let mut entry = archive.by_index(idx).unwrap();
        let mut text = String::new();
        let _ = entry.read_to_string(&mut text);
        assert!(
            !text.contains(secret_tg_token),
            "diagnostic bundle must never leak Telegram bot token"
        );
        assert!(
            !text.contains(secret_wh),
            "diagnostic bundle must never leak webhook secret"
        );
        assert!(
            !text.contains("0912345678"),
            "diagnostic bundle must never leak post phone/text"
        );
    }

    let ch_removed = invoke_command_json(&state, "channel_remove", json!({ "id": wh_id }))
        .await
        .expect("channel_remove");
    assert_eq!(ch_removed["removed"], json!(true));

    let backup = invoke_command_json(&state, "data_backup", json!({}))
        .await
        .expect("data_backup");
    assert!(std::path::Path::new(backup["path"].as_str().unwrap()).is_file());

    let purge = invoke_command_json(
        &state,
        "data_purge",
        json!({ "unmatched_retention_days": 90 }),
    )
    .await
    .expect("data_purge");
    assert!(purge["posts_purged"].is_number());

    // Shut down instance 1 and verify startup auto-refresh of `com.dealsonar.host.json` when binary moves (`bin_v1` -> `bin_v2`)!
    drop(ipc_client);
    state.shutdown().await.expect("graceful shutdown v1");

    let cfg_v2 = CoreConfig {
        native_host_binary_path: Some(bin_v2.clone()),
        ..cfg.clone()
    };
    let state_v2 = DesktopState::open_for_test(cfg_v2, None, None).expect("open state_v2");
    let manifest_raw_v2 = fs::read_to_string(&manifest_path).expect("read manifest v2");
    assert!(
        manifest_raw_v2.contains(bin_v2.to_string_lossy().as_ref()),
        "DesktopState startup must auto-refresh Chrome Native Host manifest when binary path changes"
    );
    assert!(
        manifest_raw_v2.contains(ext_id),
        "DesktopState startup must preserve paired Chrome extension ID"
    );

    let bad_del = invoke_command_json(
        &state_v2,
        "data_delete_all",
        json!({ "confirm_phrase": "DELETE" }),
    )
    .await
    .expect_err("wrong confirmation phrase must fail");
    assert_eq!(bad_del.code(), "validation_error");

    let ok_del = invoke_command_json(
        &state_v2,
        "data_delete_all",
        json!({ "confirm_phrase": "XÓA TẤT CẢ" }),
    )
    .await
    .expect("data_delete_all with Vietnamese phrase");
    assert_eq!(ok_del["deleted"], json!(true));

    let radars_after_wipe = invoke_command_json(&state_v2, "radar_list", json!({}))
        .await
        .expect("radar_list after wipe");
    assert!(radars_after_wipe.as_array().unwrap().is_empty());

    state_v2.shutdown().await.expect("graceful shutdown v2");
    tg_server.abort();
    let _ = CoreEvent::JobFailed(dealsonar_core::dto::JobFailedEvent {
        job_id: "0".into(),
        kind: "noop".into(),
        error: String::new(),
        failed_at: 0,
    });
}
