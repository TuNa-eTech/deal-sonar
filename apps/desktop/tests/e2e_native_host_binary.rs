//! True Binary-to-Binary Full-Stack E2E Test (`03-desktop.md §2–4`, `01-protocol.md`).
//!
//! Spawns the real compiled `dealsonar-native-host` executable over OS `stdin`/`stdout` pipes
//! connected via `DEALSONAR_IPC_PATH` Unix socket to `DesktopState` / `CoreService`, exchanges
//! real 4-byte little-endian length-prefixed Protocol v2 frames (`hello` -> `sources.discovered` ->
//! `posts.push` -> `crawl.report`), and verifies the Desktop command layer (`lead_list`, `lead_get`,
//! `health_get`, `crawl_run_list`, `lead_export`) returns the processed CRM leads and health state.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use dealsonar_core::CoreConfig;
use dealsonar_desktop::commands::invoke_command_json;
use dealsonar_desktop::state::DesktopState;
use dealsonar_protocol::framing::read_frame_async;
use dealsonar_protocol::ipc::IpcEndpoint;
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, AuthorInfo, Body, CrawlReason, CrawlStatus, Envelope,
    ExtractionInfo, ExtractionStrategy, RawPost, SourceInfo, SourcePrivacy, SourceRef,
    MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES,
};
use serde_json::json;
use tokio::process::{ChildStdin, ChildStdout, Command};

fn ensure_native_host_binary() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("workspace root");
    let exe_name = if cfg!(windows) {
        "dealsonar-native-host.exe"
    } else {
        "dealsonar-native-host"
    };
    let bin_path = workspace_root.join("target").join("debug").join(exe_name);
    if bin_path.is_file() {
        return bin_path;
    }

    let status = std::process::Command::new("cargo")
        .args(["build", "-p", "dealsonar-native-host"])
        .current_dir(workspace_root)
        .status()
        .expect("run cargo build -p dealsonar-native-host");
    assert!(
        status.success(),
        "dealsonar-native-host binary must compile"
    );
    assert!(
        bin_path.is_file(),
        "dealsonar-native-host binary must exist"
    );
    bin_path
}

async fn send_stdio_envelope(stdin: &mut ChildStdin, env: &Envelope) {
    write_envelope_async(stdin, env, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("write length-prefixed Protocol v2 frame to dealsonar-native-host stdin");
}

async fn recv_stdio_envelope(stdout: &mut ChildStdout) -> Envelope {
    let raw = tokio::time::timeout(
        Duration::from_secs(5),
        read_frame_async(stdout, MAX_HOST_TO_EXT_BYTES),
    )
    .await
    .expect("timeout waiting for frame from dealsonar-native-host stdout")
    .expect("valid length-prefixed frame")
    .expect("dealsonar-native-host stdout open");
    parse_envelope(&raw).expect("valid Protocol v2 JSON envelope")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_native_host_binary_stdio_to_desktop_commands_e2e() {
    let native_host_bin = ensure_native_host_binary();

    let tmp = tempfile::Builder::new()
        .prefix("ds-bin-")
        .tempdir_in("/tmp")
        .unwrap_or_else(|_| tempfile::tempdir().expect("tempdir"));
    let data_dir = tmp.path().join("data");
    let sock_path = tmp.path().join("dealsonar.sock");
    let ipc_endpoint = IpcEndpoint::from_path(&sock_path);

    let cfg = CoreConfig {
        data_dir: data_dir.clone(),
        logs_dir: Some(data_dir.join("logs")),
        ipc_endpoint: Some(ipc_endpoint),
        native_host_binary_path: Some(native_host_bin.clone()),
        chrome_manifest_path: Some(tmp.path().join("com.dealsonar.host.json")),
        batch_trigger_count: 1,
        batch_max_wait_ms: 0,
        spawn_background_workers: false,
        ..CoreConfig::default()
    };

    let state = DesktopState::open_for_test(cfg, None, None).expect("start DesktopState");

    // Spawn the REAL `dealsonar-native-host` binary with stdio pipes & `DEALSONAR_IPC_PATH`
    let mut child = Command::new(&native_host_bin)
        .env("DEALSONAR_IPC_PATH", &sock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn dealsonar-native-host binary");

    let mut child_stdin = child.stdin.take().expect("child stdin");
    let mut child_stdout = child.stdout.take().expect("child stdout");

    // 1. Send `hello` over Chrome Native Messaging stdio -> receive `hello.ok` + `config.update`
    let hello_env = Envelope::new(Body::Hello {
        profile_id: "Chrome-Profile-E2E".to_string(),
        ext_version: "0.1.0".to_string(),
        browser: "Chrome/132.0".to_string(),
        config_rev: 0,
    });
    send_stdio_envelope(&mut child_stdin, &hello_env).await;

    let hello_reply = recv_stdio_envelope(&mut child_stdout).await;
    assert_eq!(hello_reply.reply_to.as_deref(), Some(hello_env.id.as_str()));
    assert!(matches!(hello_reply.body, Body::HelloOk { .. }));

    let boot_cfg = recv_stdio_envelope(&mut child_stdout).await;
    assert!(matches!(boot_cfg.body, Body::ConfigUpdate { .. }));

    // Verify `health_get` immediately reflects live extension connection relayed via native-host!
    let health_connected = invoke_command_json(&state, "health_get", json!({}))
        .await
        .expect("health_get");
    assert_eq!(health_connected["extension_connected"], json!(true));
    assert_eq!(health_connected["extension_version"], json!("0.1.0"));

    // 2. Send `sources.discovered` with `follow: true`
    let disc_env = Envelope::new(Body::SourcesDiscovered {
        follow: Some(true),
        sources: vec![SourceInfo {
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: "fb_grp_thao_dien_e2e".to_string(),
            name: "Cộng Đồng Thuê Căn Hộ Thảo Điền Q2".to_string(),
            url: "https://www.facebook.com/groups/fb_grp_thao_dien_e2e".to_string(),
            privacy: Some(SourcePrivacy::Public),
            member_count: Some(62_000),
        }],
    });
    send_stdio_envelope(&mut child_stdin, &disc_env).await;

    let r1 = recv_stdio_envelope(&mut child_stdout).await;
    let r2 = recv_stdio_envelope(&mut child_stdout).await;
    let ack_disc = if r1.reply_to.is_some() { r1 } else { r2 };
    assert_eq!(
        ack_disc.body,
        Body::Ack {
            accepted: 1,
            duplicates: 0
        }
    );

    let sources = invoke_command_json(&state, "source_list", json!({}))
        .await
        .expect("source_list");
    let source_id = sources[0]["id"].as_str().expect("source id").to_string();

    // 3. Create & activate Vietnamese BĐS demand radar through Desktop commands
    let tpl = invoke_command_json(&state, "template_get", json!({ "id": "bds.khach-thue" }))
        .await
        .expect("template_get");
    let draft = invoke_command_json(
        &state,
        "radar_create_draft",
        json!({
            "input": {
                "name": "Khách thuê căn hộ Thảo Điền",
                "template_id": "bds.khach-thue",
                "description": "Người đang cần thuê căn hộ 2 phòng ngủ ở Thảo Điền Quận 2, ngân sách khoảng 18 triệu/tháng",
                "user_profession": "Chuyên viên cho thuê căn hộ Quận 2",
                "language_hint": "vi",
                "fields": tpl["fields"],
                "match_policy": tpl["match_policy"],
                "source_ids": [source_id]
            }
        }),
    )
    .await
    .expect("radar_create_draft");
    let radar_id = draft["radar"]["id"].as_str().unwrap().to_string();

    let activated = invoke_command_json(
        &state,
        "radar_set_status",
        json!({ "id": radar_id, "status": "active" }),
    )
    .await
    .expect("radar_set_status active");
    assert_eq!(activated["status"], json!("active"));

    // Drain pushed `config.update` relayed through `dealsonar-native-host` stdout
    let active_cfg = recv_stdio_envelope(&mut child_stdout).await;
    assert!(matches!(active_cfg.body, Body::ConfigUpdate { .. }));

    // 4. Send `posts.push` + `crawl.report` over `dealsonar-native-host` stdio
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let run_id = dealsonar_protocol::new_ulid();
    let source_ref = SourceRef {
        platform: "facebook".to_string(),
        kind: "group".to_string(),
        external_id: "fb_grp_thao_dien_e2e".to_string(),
    };

    let push_env = Envelope::new(Body::PostsPush {
        run_id: run_id.clone(),
        source_ref: source_ref.clone(),
        posts: vec![
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_thao_dien_e2e".to_string(),
                post_id: "post_e2e_buyer_001".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_thao_dien_e2e/posts/9001/"
                    .to_string(),
                author: AuthorInfo {
                    name: "Trần Hoàng Nam".to_string(),
                    external_id: Some("fb_uid_hoang_nam".to_string()),
                    is_anonymous: false,
                },
                text: "Mình cần thuê gấp căn hộ 2 phòng ngủ full nội thất khu Thảo Điền Quận 2, ngân sách khoảng 18 triệu/tháng, dọn vào đầu tháng tới. Ai có căn chính chủ nhắn Zalo mình 0908112233 cảm ơn!".to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now_ms - 45_000),
                captured_at: now_ms - 10_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Network,
                    profile_rev: 1,
                },
            },
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_thao_dien_e2e".to_string(),
                post_id: "post_e2e_spam_002".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_thao_dien_e2e/posts/9002/"
                    .to_string(),
                author: AuthorInfo {
                    name: "Rổ Hàng Quận 2".to_string(),
                    external_id: Some("fb_uid_broker_q2".to_string()),
                    is_anonymous: false,
                },
                text: "Chuyên cho thuê giỏ hàng 100 căn Masteri Thảo Điền giá rẻ nhất thị trường hoa hồng cao cho anh em sale kết hợp".to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now_ms - 20_000),
                captured_at: now_ms - 5_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Network,
                    profile_rev: 1,
                },
            },
        ],
    });
    send_stdio_envelope(&mut child_stdin, &push_env).await;

    let push_ack = recv_stdio_envelope(&mut child_stdout).await;
    assert_eq!(push_ack.reply_to.as_deref(), Some(push_env.id.as_str()));
    assert_eq!(
        push_ack.body,
        Body::Ack {
            accepted: 2,
            duplicates: 0
        }
    );

    let report_env = Envelope::new(Body::CrawlReport {
        run_id: run_id.clone(),
        source_ref,
        reason: CrawlReason::Scheduled,
        status: CrawlStatus::Ok,
        started_at: now_ms - 12_000,
        ended_at: now_ms,
        posts_seen: 2,
        posts_new: 2,
        page_loads: 1,
        strategy: Some(ExtractionStrategy::Network),
        error: None,
        dropped_posts: Some(0),
    });
    send_stdio_envelope(&mut child_stdin, &report_env).await;

    let report_ack = recv_stdio_envelope(&mut child_stdout).await;
    assert_eq!(report_ack.reply_to.as_deref(), Some(report_env.id.as_str()));
    assert_eq!(
        report_ack.body,
        Body::Ack {
            accepted: 1,
            duplicates: 0
        }
    );

    // 5. Pump desktop pipeline workers & verify `lead_list`, `lead_get`, `health_get`, `crawl_run_list`, `lead_export`
    state.core().tick_workers_now().await.expect("tick workers");

    let leads = invoke_command_json(
        &state,
        "lead_list",
        json!({ "query": { "radar_id": radar_id, "include_weak": true } }),
    )
    .await
    .expect("lead_list");
    let items = leads["items"].as_array().expect("lead items");
    assert_eq!(
        items.len(),
        1,
        "buyer demand post must become CRM lead while broker supply post is rejected"
    );
    let lead_id = items[0]["id"].as_str().unwrap().to_string();
    assert_eq!(items[0]["author_name"], json!("Trần Hoàng Nam"));

    let detail = invoke_command_json(&state, "lead_get", json!({ "id": lead_id }))
        .await
        .expect("lead_get");
    assert!(detail["post"]["text"]
        .as_str()
        .unwrap()
        .contains("0908112233"));

    let runs = invoke_command_json(
        &state,
        "crawl_run_list",
        json!({ "source_id": source_id, "limit": 10 }),
    )
    .await
    .expect("crawl_run_list");
    let run_arr = runs.as_array().expect("crawl runs array");
    assert!(!run_arr.is_empty());
    assert_eq!(run_arr[0]["posts_seen"], json!(2));
    assert_eq!(run_arr[0]["posts_new"], json!(2));
    assert_eq!(run_arr[0]["page_loads"], json!(1));

    let health_after = invoke_command_json(&state, "health_get", json!({}))
        .await
        .expect("health_get after crawl");
    assert_eq!(health_after["extension_connected"], json!(true));
    assert_eq!(health_after["page_loads_last_hour"], json!(1));

    let export_res = invoke_command_json(
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
    .expect("lead_export csv");
    assert_eq!(export_res["row_count"], json!(1));
    let csv_text = std::fs::read_to_string(export_res["path"].as_str().unwrap()).expect("read csv");
    assert!(csv_text.contains("Trần Hoàng Nam"));

    // 6. Close native-host stdin (clean EOF) -> verify `dealsonar-native-host` exits with code 0
    drop(child_stdin);
    let exit_status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("native-host exit timeout")
        .expect("wait child");
    assert!(
        exit_status.success(),
        "dealsonar-native-host binary must exit cleanly with status 0 on stdin EOF"
    );

    state
        .shutdown()
        .await
        .expect("graceful DesktopState shutdown");
}
