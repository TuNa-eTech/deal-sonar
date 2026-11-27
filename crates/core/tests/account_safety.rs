//! Account-safety log: each verification, sign-out or limit is recorded once, with the page
//! loads of the previous 24 hours, and scanning is halted while it lasts.

use std::fs::File;
use std::time::Duration;

use dealsonar_core::dto::{CrawlPauseReason, FacebookSessionState};
use dealsonar_core::safety::AccountIncidentKind;
use dealsonar_core::{CoreConfig, CoreServiceBuilder};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, Body, CrawlReason, CrawlStatus, Envelope,
    ExtractionStrategy, SessionState, SourceRef, MAX_EXT_TO_HOST_BYTES,
};
use dealsonar_store::models::now_ms;
use zip::ZipArchive;

async fn recv(stream: &mut IpcStream) -> Envelope {
    let bytes = tokio::time::timeout(
        Duration::from_secs(3),
        stream.read_frame(dealsonar_protocol::MAX_HOST_TO_EXT_BYTES),
    )
    .await
    .expect("IPC read timeout")
    .expect("IPC frame ok")
    .expect("IPC stream open");
    parse_envelope(&bytes).expect("valid host envelope")
}

async fn session(stream: &mut IpcStream, state: SessionState, detail: Option<&str>) {
    let envelope = Envelope::new(Body::SessionStatus {
        runtime: None,
        platform: "facebook".to_string(),
        state,
        detail: detail.map(str::to_string),
    });
    write_envelope_async(stream, &envelope, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("send session status");
    // Pause orders to connected profiles may arrive first; the Ack always follows.
    loop {
        if matches!(recv(stream).await.body, Body::Ack { .. }) {
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_session_problem_is_logged_once_with_the_previous_day_of_page_loads() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint = IpcEndpoint::from_path(tmp.path().join("safety.sock"));
    let service = CoreServiceBuilder::open_for_test(CoreConfig {
        data_dir: tmp.path().join("data"),
        ipc_endpoint: Some(endpoint.clone()),
        spawn_background_workers: false,
        ..CoreConfig::default()
    })
    .unwrap()
    .start()
    .unwrap();
    let mut stream = IpcStream::connect(&endpoint).await.unwrap();

    // Seven page loads in the last day, then Facebook asks for verification.
    let report = Envelope::new(Body::CrawlReport {
        run_id: dealsonar_protocol::new_ulid(),
        source_ref: SourceRef {
            platform: "facebook".into(),
            kind: "group".into(),
            external_id: "safety_src".into(),
        },
        reason: CrawlReason::Scheduled,
        status: CrawlStatus::Ok,
        started_at: now_ms() - 3_000,
        ended_at: now_ms() - 1_000,
        posts_seen: 0,
        posts_new: 0,
        page_loads: 7,
        strategy: Some(ExtractionStrategy::Dom),
        error: None,
        dropped_posts: None,
    });
    write_envelope_async(&mut stream, &report, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    recv(&mut stream).await;

    assert!(service
        .account_safety_report(None)
        .unwrap()
        .incidents
        .is_empty());

    session(
        &mut stream,
        SessionState::Checkpoint,
        Some("Chuyển hướng xác minh: /checkpoint/"),
    )
    .await;
    let health = service.health_get().unwrap();
    assert!(
        health.crawl_paused,
        "scanning must stop when the account needs attention"
    );
    assert_eq!(health.facebook_session, FacebookSessionState::Checkpoint);
    assert_eq!(
        health.crawl_pause_reason,
        Some(CrawlPauseReason::CheckpointAwaitingResume)
    );

    let first = service.account_safety_report(None).unwrap();
    assert_eq!(first.incidents.len(), 1);
    let incident = &first.incidents[0];
    assert_eq!(incident.kind, AccountIncidentKind::Checkpoint);
    assert_eq!(incident.page_loads_24h, 7);
    assert_eq!(incident.page_loads_1h, 7);
    assert!(incident.scanning_paused);
    assert_eq!(incident.resolved_at, None);
    assert!(incident.detail.contains("/checkpoint/"));
    assert_eq!(first.crawl_policy.group_interval_minutes, 15);
    assert_eq!(first.window_days, 30);
    assert_eq!(first.active_days.len(), 1);
    assert_eq!(first.active_days[0].page_loads, 7);

    // The same problem reported again is not a new incident; a different one is.
    session(&mut stream, SessionState::Checkpoint, None).await;
    assert_eq!(
        service.account_safety_report(None).unwrap().incidents.len(),
        1
    );
    session(
        &mut stream,
        SessionState::LoggedOut,
        Some("Chuyển hướng đăng nhập"),
    )
    .await;
    let second = service.account_safety_report(None).unwrap();
    assert_eq!(second.incidents.len(), 2);
    assert_eq!(second.incidents[1].kind, AccountIncidentKind::LoggedOut);

    // A healthy session closes what was open and keeps the history.
    session(&mut stream, SessionState::Ok, None).await;
    let closed = service.account_safety_report(None).unwrap();
    assert_eq!(closed.incidents.len(), 2);
    assert!(closed.incidents.iter().all(|i| i.resolved_at.is_some()));

    // The log reaches the diagnostic bundle, and survives a restart.
    let bundle = service.diagnostic_bundle_create().unwrap();
    let mut archive = ZipArchive::new(File::open(&bundle.path).unwrap()).unwrap();
    assert!(archive.by_name("account_safety.json").is_ok());
    drop(archive);
    service.shutdown().await.unwrap();
    drop(service);
    let restarted = CoreServiceBuilder::open_for_test(CoreConfig {
        data_dir: tmp.path().join("data"),
        spawn_background_workers: false,
        ..CoreConfig::default()
    })
    .unwrap()
    .start()
    .unwrap();
    assert_eq!(
        restarted
            .account_safety_report(None)
            .unwrap()
            .incidents
            .len(),
        2
    );
}
