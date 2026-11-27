//! Chrome and Desktop are updated on different schedules. These tests drive the real local IPC
//! endpoint the way a mismatched extension would and check that the Desktop (a) keeps working,
//! (b) tells the user which side to update, and (c) forgets the warning once the sides agree.

use std::sync::Arc;
use std::time::Duration;

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{ExtensionCompat, ExtensionCompatState};
use dealsonar_core::{CoreConfig, CoreService, CoreServiceBuilder};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, write_frame_async, Body, Envelope, ErrorCode,
    MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES,
};
use dealsonar_store::Store;

/// A Unix socket under the temp dir, or a uniquely named pipe on Windows (which has no socket files).
fn test_endpoint(dir: &std::path::Path, name: &str) -> IpcEndpoint {
    #[cfg(windows)]
    {
        let _ = (dir, name);
        IpcEndpoint::from_path(format!(
            r"\\.\pipe\dealsonar-test-{}",
            dealsonar_protocol::new_ulid()
        ))
    }
    #[cfg(not(windows))]
    {
        IpcEndpoint::from_path(dir.join(name))
    }
}

fn start(tmp: &tempfile::TempDir) -> (CoreService, IpcEndpoint) {
    let endpoint = test_endpoint(tmp.path(), "ipc.sock");
    let service = CoreServiceBuilder::new(Store::open_in_memory().expect("store"))
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ipc_endpoint: Some(endpoint.clone()),
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service");
    (service, endpoint)
}

async fn recv(stream: &mut IpcStream) -> Envelope {
    let bytes = tokio::time::timeout(
        Duration::from_secs(3),
        stream.read_frame(MAX_HOST_TO_EXT_BYTES),
    )
    .await
    .expect("IPC read timeout")
    .expect("IPC frame ok")
    .expect("IPC stream open");
    parse_envelope(&bytes).expect("valid host envelope")
}

async fn hello(stream: &mut IpcStream, ext_version: &str) -> Envelope {
    let env = Envelope::new(Body::Hello {
        profile_id: "Default".to_string(),
        ext_version: ext_version.to_string(),
        browser: "Chrome/131.0".to_string(),
        config_rev: 0,
    });
    write_envelope_async(stream, &env, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("write hello");
    let reply = recv(stream).await;
    assert_eq!(reply.reply_to.as_deref(), Some(env.id.as_str()));
    reply
}

fn compat(service: &CoreService) -> Option<ExtensionCompat> {
    service.health_get().expect("health").extension_compat
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_foreign_protocol_version_is_rejected_explained_and_forgotten_after_a_good_hello() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (service, endpoint) = start(&tmp);
    assert_eq!(compat(&service), None);

    // An extension already updated to a newer protocol talks to this Desktop.
    let mut stream = IpcStream::connect(&endpoint).await.expect("connect");
    let future_hello = br#"{"v":3,"id":"01JCF7Z3K8AAAAAAAAAAAAAAAA","type":"hello","ts":1794384000000,"reply_to":null,"payload":{"profile_id":"Default","ext_version":"9.0.0","browser":"chrome/200","config_rev":0}}"#;
    write_frame_async(&mut stream, future_hello, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("write");
    let rejection = recv(&mut stream).await;
    assert!(matches!(
        rejection.body,
        Body::Error {
            code: ErrorCode::ProtocolMismatch,
            ..
        }
    ));

    // The Desktop UI now has actionable, Vietnamese guidance and does not lose anything.
    let info = compat(&service).expect("mismatch is surfaced in health");
    assert_eq!(info.state, ExtensionCompatState::ProtocolMismatch);
    assert!(info.message.contains("không khớp"), "{}", info.message);
    assert!(
        info.action.contains("chrome://extensions"),
        "{}",
        info.action
    );
    assert!(info.action.contains("được giữ nguyên"), "{}", info.action);
    assert!(!service.health_get().unwrap().extension_connected);

    // The same connection stays usable, so once the extension is updated it can say hello again.
    let ok = hello(&mut stream, "0.3.0").await;
    assert!(matches!(ok.body, Body::HelloOk { .. }));
    assert_eq!(compat(&service), None, "warning clears once versions agree");
    assert!(service.health_get().unwrap().extension_connected);
    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_supported_extension_of_any_newer_release_is_not_flagged() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (service, endpoint) = start(&tmp);
    let mut stream = IpcStream::connect(&endpoint).await.expect("connect");
    let reply = hello(&mut stream, "12.4.0").await;
    // The extension compares against the release version baked in at build time.
    assert!(matches!(
        &reply.body,
        Body::HelloOk { desktop_version, .. } if desktop_version == dealsonar_core::DESKTOP_VERSION
    ));
    let health = service.health_get().unwrap();
    assert!(health.extension_connected);
    assert_eq!(health.extension_version.as_deref(), Some("12.4.0"));
    assert_eq!(health.extension_compat, None);
    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_extension_older_than_the_supported_minimum_is_served_but_flagged() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (service, endpoint) = start(&tmp);
    let mut stream = IpcStream::connect(&endpoint).await.expect("connect");
    let reply = hello(&mut stream, "0.0.9").await;
    assert!(
        matches!(reply.body, Body::HelloOk { .. }),
        "still connected"
    );
    let info = compat(&service).expect("outdated extension is surfaced");
    assert_eq!(info.state, ExtensionCompatState::ExtensionOutdated);
    assert_eq!(info.extension_version.as_deref(), Some("0.0.9"));
    assert!(service.health_get().unwrap().extension_connected);
    service.shutdown().await.expect("shutdown");
}

#[test]
fn outdated_extension_guidance_names_both_versions_and_keeps_data_reassurance() {
    let info = ExtensionCompat::outdated_extension("0.0.9");
    assert_eq!(info.state, ExtensionCompatState::ExtensionOutdated);
    assert!(info.message.contains("v0.0.9"));
    assert!(info
        .message
        .contains(dealsonar_protocol::compat::MIN_EXTENSION_VERSION));
    assert!(info.action.contains("giữ nguyên"));
}
