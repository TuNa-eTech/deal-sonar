use std::process::Stdio;
use std::time::Duration;

use dealsonar_core::{dto::RadarStatus, CoreConfig, CoreServiceBuilder};
use dealsonar_protocol::agent::{AgentMethod, AgentRequest, FRAME_PREFIX, MAX_FRAME_BYTES};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, AuthorInfo, Body, Envelope, ExtractionInfo, ExtractionStrategy, RawPost,
    SourceInfo, SourceRef,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

async fn rpc(input: &mut ChildStdin, output: &mut BufReader<ChildStdout>, message: Value) -> Value {
    input
        .write_all(format!("{message}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], message["id"]);
    response
}

async fn tool(
    input: &mut ChildStdin,
    output: &mut BufReader<ChildStdout>,
    name: &str,
    arguments: Value,
) -> Value {
    let reply = rpc(
        input,
        output,
        json!({
            "jsonrpc": "2.0", "id": 42, "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }),
    )
    .await;
    assert!(reply["error"].is_null(), "{reply}");
    assert!(reply["result"]["isError"].is_null(), "{reply}");
    serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

async fn send_extension(extension: &mut IpcStream, body: Body) {
    let envelope = Envelope::new(body);
    let bytes = serde_json::to_vec(&envelope).unwrap();
    extension
        .write_frame(&bytes, MAX_FRAME_BYTES)
        .await
        .unwrap();
    loop {
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            extension.read_frame(MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let reply = parse_envelope(&reply).unwrap();
        if reply.reply_to.as_ref() == Some(&envelope.id) {
            assert!(!matches!(reply.body, Body::Error { .. }), "{reply:?}");
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_prepares_single_reviewable_draft_without_exposing_posts() {
    let temp = tempfile::tempdir().unwrap();
    let endpoint = if cfg!(windows) {
        IpcEndpoint::from_path(format!(
            r"\\.\pipe\dealsonar-test-{}",
            dealsonar_protocol::new_ulid()
        ))
    } else {
        IpcEndpoint::from_path(temp.path().join("ipc.sock"))
    };
    let config = CoreConfig {
        data_dir: temp.path().to_owned(),
        ipc_endpoint: Some(endpoint.clone()),
        preview_min_posts_before_crawl: 0,
        spawn_background_workers: false,
        ..CoreConfig::default()
    };
    let start = || {
        CoreServiceBuilder::open_for_test(config.clone())
            .unwrap()
            .with_agent_tools()
            .start()
            .unwrap()
    };
    let core = start();

    let mut unauthorized = IpcStream::connect(&endpoint).await.unwrap();
    let mut frame = FRAME_PREFIX.to_vec();
    serde_json::to_writer(
        &mut frame,
        &AgentRequest {
            token: [0; 32],
            method: AgentMethod::ListRadarSources,
            arguments: json!({}),
        },
    )
    .unwrap();
    unauthorized
        .write_frame(&frame, MAX_FRAME_BYTES)
        .await
        .unwrap();
    let reply = unauthorized
        .read_frame(MAX_FRAME_BYTES)
        .await
        .unwrap()
        .unwrap();
    assert!(serde_json::from_slice::<Value>(&reply).unwrap()["Error"].is_string());

    let mut extension = IpcStream::connect(&endpoint).await.unwrap();
    send_extension(
        &mut extension,
        Body::Hello {
            profile_id: "preview-test".into(),
            ext_version: "0.1.0".into(),
            browser: "test".into(),
            config_rev: 0,
        },
    )
    .await;
    send_extension(
        &mut extension,
        Body::SourcesDiscovered {
            sources: vec![SourceInfo {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: "123456".into(),
                name: "Cộng đồng thuê căn hộ Tân Phú".into(),
                url: "https://www.facebook.com/groups/123456".into(),
                privacy: None,
                member_count: None,
            }],
            follow: Some(true),
        },
    )
    .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    send_extension(
        &mut extension,
        Body::PostsPush {
            run_id: dealsonar_protocol::new_ulid(),
            source_ref: SourceRef {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: "123456".into(),
            },
            posts: vec![RawPost {
                platform: "facebook".into(),
                source_external_id: "123456".into(),
                post_id: "test-0001".into(),
                permalink: "https://www.facebook.com/groups/123456/posts/100".into(),
                author: AuthorInfo {
                    name: "Tên tác giả thử nghiệm".into(),
                    external_id: None,
                    is_anonymous: false,
                },
                text: "Em cần tìm thuê căn hộ khu Tân Phú, ngân sách 7 triệu/tháng".into(),
                text_truncated: false,
                attachments: vec![],
                created_at: Some(now),
                captured_at: now,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Network,
                    profile_rev: 1,
                },
            }],
        },
    )
    .await;

    let mut client = Command::new(env!("CARGO_BIN_EXE_dealsonar-native-host"))
        .arg("--mcp")
        .env("DEALSONAR_DATA_DIR", temp.path())
        .env("DEALSONAR_IPC_PATH", endpoint.as_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = client.stdin.take().unwrap();
    let mut output = BufReader::new(client.stdout.take().unwrap());
    let hello = rpc(&mut input, &mut output, json!({
        "jsonrpc": "2.0", "id": "initialize", "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"} }
    })).await;
    assert_eq!(hello["result"]["protocolVersion"], "2025-11-25");
    let tools = rpc(
        &mut input,
        &mut output,
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
    )
    .await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 4);
    let sources = tool(&mut input, &mut output, "list_radar_sources", json!({})).await;
    let radar_id = sources["draft_id"].as_str().unwrap();
    let source = &sources["sources"][0];
    assert_eq!(source["name"], "Cộng đồng thuê căn hộ Tân Phú");
    let draft = json!({
        "draft_id": radar_id, "name": "Khách thuê Tân Phú", "description": "Người cần thuê căn hộ ở Tân Phú",
        "source_ids": [source["id"]], "fields": [{"type":"location", "key":"area", "label":"Khu vực", "description":"Khu vực cần thuê"}],
        "want_intent": "demand"
    });
    let prepared = tool(&mut input, &mut output, "prepare_radar", draft.clone()).await;
    assert_eq!(prepared["radar_id"], radar_id);
    tool(&mut input, &mut output, "prepare_radar", draft).await;
    let summary = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let progress = tool(
                &mut input,
                &mut output,
                "check_radar_preview",
                json!({"radar_id": radar_id}),
            )
            .await;
            if matches!(progress["status"].as_str(), Some("done" | "error")) {
                break progress;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(summary["status"], "done", "{summary}");
    assert_eq!(summary["evaluated_posts"], 1);
    assert!(summary["items"].is_null());
    assert!(!summary.to_string().contains("Tên tác giả thử nghiệm"));
    let activation = rpc(&mut input, &mut output, json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "radar_set_status", "arguments": {"radar_id": radar_id, "status": "active"}}
    })).await;
    assert_eq!(activation["error"]["code"], -32602);
    assert_eq!(core.radar_list().unwrap().len(), 1);
    assert_eq!(
        core.radar_get(radar_id).unwrap().radar.status,
        RadarStatus::Draft
    );
    let first = core.radar_preview_get(radar_id, None).unwrap();
    assert_eq!(first.items.len(), 1);
    assert!(core.lead_list(Default::default()).unwrap().items.is_empty());

    drop(extension);
    core.shutdown().await.unwrap();
    drop(core);
    let core = start();
    let reopened = core.radar_preview_get(radar_id, None).unwrap();
    assert_eq!(reopened.preview_id, first.preview_id);
    assert_eq!(reopened.source_ids, first.source_ids);
    assert_eq!(reopened.items.len(), 1);
    let active = core
        .radar_set_status_from_desktop(radar_id, RadarStatus::Active, Some(&reopened.preview_id))
        .await
        .unwrap();
    assert_eq!(active.status, RadarStatus::Active);

    drop(input);
    assert!(client.wait().await.unwrap().success());
    core.shutdown().await.unwrap();
}
