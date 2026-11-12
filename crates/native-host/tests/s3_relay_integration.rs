use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use dealsonar_native_host::{run_relay, RelayConfig};
use dealsonar_protocol::framing::{
    read_frame_async, write_envelope_async, write_frame_async, MAX_EXT_TO_HOST_BYTES,
    MAX_HOST_TO_EXT_BYTES,
};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcListener, DEALSONAR_IPC_PATH_ENV};
use dealsonar_protocol::native_manifest::NativeHostManifest;
use dealsonar_protocol::{
    parse_envelope, Body, CrawlReason, CrawlStatus, Envelope, ErrorCode, ExtractionStrategy,
    SourceRef,
};
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::oneshot;

/// S3 Milestone Integration Test (`docs/delivery/01-roadmap.md §2 S3`):
/// 1) Desktop server NOT running -> `desktop_unavailable` (`retryable: true`, `reply_to` preserved).
/// 2) Desktop server starts -> background loop reconnects automatically.
/// 3) 1,200+ frames relayed concurrently in BOTH directions (`stdin -> IPC` and `IPC -> stdout`)
///    verbatim without loss or corruption.
/// 4) Desktop server crashes/stops mid-stream -> `desktop_unavailable` returned -> server restarts ->
///    relay automatically reconnects and recovers cleanly.
/// 5) `stdin` closes (EOF) -> relay closes IPC cleanly and exits `Ok(())`.
#[tokio::test]
async fn s3_relay_full_lifecycle_1200_bidirectional_frames_and_recovery() {
    let tmp = tempdir().unwrap();
    let sock_path = tmp.path().join("ipc-dir").join("ipc.sock");
    let endpoint = IpcEndpoint::from_path(&sock_path);

    let (mut ext_to_host, host_stdin) = tokio::io::duplex(256 * 1024);
    let (host_stdout, mut host_to_ext) = tokio::io::duplex(256 * 1024);

    let config =
        RelayConfig::new(endpoint.clone()).with_reconnect_interval(Duration::from_millis(25));
    let relay_handle =
        tokio::spawn(async move { run_relay(host_stdin, host_stdout, config).await });

    // ── Phase 1: Desktop NOT running -> immediate `desktop_unavailable` ─────
    let hello_offline = Envelope::new(Body::Hello {
        profile_id: "p_offline".to_owned(),
        ext_version: "0.2.0".to_owned(),
        browser: "chrome/142".to_owned(),
        config_rev: 0,
    });
    write_envelope_async(&mut ext_to_host, &hello_offline, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();

    let offline_reply_raw = read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
        .await
        .unwrap()
        .unwrap();
    let offline_reply = parse_envelope(&offline_reply_raw).unwrap();
    assert_eq!(offline_reply.v, 2);
    assert_eq!(
        offline_reply.reply_to.as_deref(),
        Some(hello_offline.id.as_str())
    );
    assert!(matches!(
        offline_reply.body,
        Body::Error {
            code: ErrorCode::DesktopUnavailable,
            retryable: true,
            ..
        }
    ));

    // Malformed non-JSON frame while disconnected still yields valid v2 `desktop_unavailable`
    // with `reply_to: None`.
    write_frame_async(&mut ext_to_host, b"not-json-at-all", MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    let bad_offline_raw = read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
        .await
        .unwrap()
        .unwrap();
    let bad_offline = parse_envelope(&bad_offline_raw).unwrap();
    assert_eq!(bad_offline.reply_to, None);
    assert!(matches!(
        bad_offline.body,
        Body::Error {
            code: ErrorCode::DesktopUnavailable,
            retryable: true,
            ..
        }
    ));

    // ── Phase 2: Start Mock Desktop IPC Server & verify auto-reconnect ──────
    let mut listener_1 = IpcListener::bind(&endpoint).unwrap();
    let (server1_stop_tx, server1_stop_rx) = oneshot::channel::<()>();

    let total_frames: u32 = 1_200;
    let server1_handle = tokio::spawn(async move {
        let stream = tokio::time::timeout(Duration::from_secs(3), listener_1.accept())
            .await
            .expect("relay should auto-connect once listener binds")
            .unwrap();
        let (mut ipc_read, mut ipc_write) = stream.into_split();

        // Concurrently push `total_frames` unsolicited Desktop -> Extension frames (`pong` / `crawl.request`)
        // WHILE reading `total_frames` Extension -> Desktop frames and replying `ack`?
        // To test true concurrent bidirectional traffic:
        // - Server writer pushes `total_frames` `CrawlRequest` messages (`req_0`..`req_1199`).
        // - Server reader reads `total_frames` incoming `CrawlReport` messages (`run_0`..`run_1199`).
        let push_task = tokio::spawn(async move {
            for i in 0..total_frames {
                let req = Envelope::new(Body::CrawlRequest {
                    request_id: format!("req_{i}"),
                    source_ref: SourceRef::facebook_group("123"),
                    reason: CrawlReason::Manual,
                    max_posts: 25,
                });
                ipc_write.write_host_envelope(&req).await.unwrap();
            }
            ipc_write
        });

        for i in 0..total_frames {
            let raw = ipc_read.read_ext_frame().await.unwrap().unwrap();
            let env = parse_envelope(&raw).unwrap();
            match env.body {
                Body::CrawlReport { run_id, .. } => {
                    assert_eq!(run_id, format!("run_{i}"));
                }
                other => panic!("unexpected body at index {i}: {other:?}"),
            }
        }

        let ipc_write = push_task.await.unwrap();
        let _ = server1_stop_rx.await;
        drop(ipc_write);
        drop(ipc_read);
        drop(listener_1);
    });

    // Wait briefly (~60ms) so the relay's 25ms reconnect timer establishes the IPC stream.
    tokio::time::sleep(Duration::from_millis(80)).await;

    // ── Phase 3: Blast 1,200 frames concurrently in BOTH directions ─────────
    let ext_writer_task = tokio::spawn(async move {
        for i in 0..total_frames {
            let report = Envelope::new(Body::CrawlReport {
                run_id: format!("run_{i}"),
                source_ref: SourceRef::facebook_group("123"),
                reason: CrawlReason::Scheduled,
                status: CrawlStatus::Ok,
                started_at: 1_794_384_000_000 + i64::from(i),
                ended_at: 1_794_384_001_000 + i64::from(i),
                posts_seen: 10,
                posts_new: 2,
                page_loads: 1,
                strategy: Some(ExtractionStrategy::Network),
                error: None,
                dropped_posts: None,
            });
            write_envelope_async(&mut ext_to_host, &report, MAX_EXT_TO_HOST_BYTES)
                .await
                .unwrap();
        }
        ext_to_host
    });

    for i in 0..total_frames {
        let raw = read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
            .await
            .unwrap()
            .unwrap();
        let env = parse_envelope(&raw).unwrap();
        match env.body {
            Body::CrawlRequest { request_id, .. } => {
                assert_eq!(request_id, format!("req_{i}"));
            }
            other => panic!("expected CrawlRequest req_{i}, got {other:?}"),
        }
    }

    let mut ext_to_host = ext_writer_task.await.unwrap();

    // ── Phase 4: Crash/stop Desktop Server 1, verify `desktop_unavailable`,
    //             then start Desktop Server 2 and verify clean recovery! ─────
    let _ = server1_stop_tx.send(());
    server1_handle.await.unwrap();
    // Give relay a moment to observe EOF from server 1.
    tokio::time::sleep(Duration::from_millis(20)).await;

    let ping_during_outage = Envelope::new(Body::Ping {});
    write_envelope_async(&mut ext_to_host, &ping_during_outage, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    let outage_raw = read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
        .await
        .unwrap()
        .unwrap();
    let outage_env = parse_envelope(&outage_raw).unwrap();
    assert_eq!(
        outage_env.reply_to.as_deref(),
        Some(ping_during_outage.id.as_str())
    );
    assert!(matches!(
        outage_env.body,
        Body::Error {
            code: ErrorCode::DesktopUnavailable,
            retryable: true,
            ..
        }
    ));

    // Restart Desktop Server 2 on the exact same IPC endpoint!
    let mut listener_2 = IpcListener::bind(&endpoint).unwrap();
    let server2_handle = tokio::spawn(async move {
        let stream = tokio::time::timeout(Duration::from_secs(3), listener_2.accept())
            .await
            .expect("relay should reconnect to restarted server")
            .unwrap();
        let (mut r, mut w) = stream.into_split();
        let raw = r.read_ext_frame().await.unwrap().unwrap();
        let ping = parse_envelope(&raw).unwrap();
        assert_eq!(ping.body, Body::Ping {});
        let pong = Envelope::reply(&ping.id, Body::Pong {});
        w.write_host_envelope(&pong).await.unwrap();

        // Next read should observe clean EOF when stdin closes!
        assert_eq!(r.read_ext_frame().await.unwrap(), None);
    });

    tokio::time::sleep(Duration::from_millis(80)).await;

    let ping_after_recovery = Envelope::new(Body::Ping {});
    write_envelope_async(
        &mut ext_to_host,
        &ping_after_recovery,
        MAX_EXT_TO_HOST_BYTES,
    )
    .await
    .unwrap();
    let pong_raw = read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
        .await
        .unwrap()
        .unwrap();
    let pong_env = parse_envelope(&pong_raw).unwrap();
    assert_eq!(
        pong_env.reply_to.as_deref(),
        Some(ping_after_recovery.id.as_str())
    );
    assert_eq!(pong_env.body, Body::Pong {});

    // ── Phase 5: Close `stdin` (EOF) -> clean IPC shutdown & exit ───────────
    ext_to_host.shutdown().await.unwrap();
    drop(ext_to_host);

    assert_eq!(
        read_frame_async(&mut host_to_ext, MAX_HOST_TO_EXT_BYTES)
            .await
            .unwrap(),
        None
    );
    server2_handle.await.unwrap();
    relay_handle.await.unwrap().unwrap();
}

/// Real subprocess E2E test spawning the compiled `dealsonar-native-host` binary
/// over OS `stdin`/`stdout` pipes and `DEALSONAR_IPC_PATH`.
#[tokio::test]
async fn subprocess_binary_relays_1000_frames_and_exits_zero_on_stdin_eof() {
    let tmp = tempdir().unwrap();
    let sock_path = tmp.path().join("subproc").join("ipc.sock");
    let endpoint = IpcEndpoint::from_path(&sock_path);

    let mut listener = IpcListener::bind(&endpoint).unwrap();
    let count: u32 = 1_000;

    let server_task = tokio::spawn(async move {
        let mut stream = listener.accept().await.unwrap();
        for _ in 0..count {
            let raw = stream.read_ext_frame().await.unwrap().unwrap();
            let env = parse_envelope(&raw).unwrap();
            let ack = Envelope::reply(
                &env.id,
                Body::Ack {
                    accepted: 1,
                    duplicates: 0,
                },
            );
            stream.write_host_envelope(&ack).await.unwrap();
        }
        assert_eq!(stream.read_ext_frame().await.unwrap(), None);
    });

    let bin = env!("CARGO_BIN_EXE_dealsonar-native-host");
    let mut child = Command::new(bin)
        .env(DEALSONAR_IPC_PATH_ENV, &sock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut child_stdin = child.stdin.take().unwrap();
    let mut child_stdout = child.stdout.take().unwrap();

    let mut expected_ids = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let ping = Envelope::new(Body::Ping {});
        expected_ids.push(ping.id.clone());
        write_envelope_async(&mut child_stdin, &ping, MAX_EXT_TO_HOST_BYTES)
            .await
            .unwrap();
    }

    for expected_id in &expected_ids {
        let raw = read_frame_async(&mut child_stdout, MAX_HOST_TO_EXT_BYTES)
            .await
            .unwrap()
            .unwrap();
        let reply = parse_envelope(&raw).unwrap();
        assert_eq!(reply.reply_to.as_deref(), Some(expected_id.as_str()));
        assert_eq!(
            reply.body,
            Body::Ack {
                accepted: 1,
                duplicates: 0
            }
        );
    }

    // Close stdin -> native-host must close IPC and exit with code 0!
    drop(child_stdin);
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("dealsonar-native-host binary must exit promptly on stdin EOF")
        .unwrap();
    assert!(status.success(), "expected exit code 0, got {status}");
    server_task.await.unwrap();
}

#[cfg(unix)]
#[test]
fn dev_install_script_writes_valid_chrome_native_host_manifest() {
    let tmp = tempdir().unwrap();
    let hosts_dir = tmp.path().join("NativeMessagingHosts");
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let script = repo_root.join("scripts/install-native-host-dev.sh");

    let status = std::process::Command::new("bash")
        .arg(&script)
        .arg("abcdefghijklmnopabcdefghijklmnop")
        .env("CHROME_NATIVE_HOSTS_DIR", &hosts_dir)
        .status()
        .unwrap();
    assert!(status.success());

    let manifest_file = hosts_dir.join("com.dealsonar.host.json");
    let raw = std::fs::read_to_string(&manifest_file).unwrap();
    let parsed: NativeHostManifest = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.name, "com.dealsonar.host");
    assert_eq!(parsed.host_type, "stdio");
    assert_eq!(
        parsed.allowed_origins,
        vec!["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
    );
    assert!(PathBuf::from(&parsed.path).exists());
}
