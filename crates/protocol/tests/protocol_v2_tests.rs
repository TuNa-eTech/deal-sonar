use std::io::{self, Cursor};
use std::path::Path;
use std::str::FromStr;

use dealsonar_protocol::framing::{
    read_envelope_sync, read_frame_async, read_frame_sync, write_envelope_async,
    write_envelope_sync, write_frame_async, write_frame_sync, FrameError, MAX_EXT_TO_HOST_BYTES,
    MAX_HOST_TO_EXT_BYTES,
};
use dealsonar_protocol::ipc::{
    default_data_dir_with, resolve_ipc_endpoint_with, IpcEndpoint, IpcListener, IpcPlatform,
    IpcStream,
};
use dealsonar_protocol::native_manifest::{
    chrome_manifest_path_with, verify_or_write_manifest, ManifestError, NativeHostManifest,
    WINDOWS_CHROME_REGISTRY_KEY,
};
use dealsonar_protocol::{
    extract_envelope_id, is_known_message_type, parse_envelope, parse_envelope_str,
    parse_raw_envelope, ActiveHours, Attachment, AttachmentKind, AuthorInfo, Body, CrawlPlan,
    CrawlPlanEntry, CrawlPolicy, CrawlReason, CrawlStatus, Envelope, ErrorCode, ExtractionInfo,
    ExtractionStrategy, ExtractorProfile, PostCounts, RawPost, SessionState, SourceInfo,
    SourcePrivacy, SourceRef, KNOWN_MESSAGE_TYPES, NATIVE_HOST_NAME, PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use tempfile::tempdir;
use ulid::Ulid;

#[test]
fn protocol_constants_match_spec() {
    assert_eq!(PROTOCOL_VERSION, 2);
    assert_eq!(NATIVE_HOST_NAME, "com.dealsonar.host");
    assert_eq!(MAX_HOST_TO_EXT_BYTES, 1_048_576);
    assert_eq!(MAX_EXT_TO_HOST_BYTES, 67_108_864);
    assert_eq!(KNOWN_MESSAGE_TYPES.len(), 14);
}

#[test]
fn spec_section_6_session_wire_exact_match() {
    // Verbatim examples from `docs/specs/01-protocol.md §6`.
    let raw_hello = r#"{"v":2,"id":"01A","type":"hello","ts":1794384000000,"reply_to":null,"payload":{"profile_id":"p_7f3a","ext_version":"0.2.0","browser":"chrome/142","config_rev":11}}"#;
    let raw_hello_ok = r#"{"v":2,"id":"01B","type":"hello.ok","ts":1794384000050,"reply_to":"01A","payload":{"desktop_version":"0.2.0","config_rev":12}}"#;
    let raw_config_update = r#"{"v":2,"id":"01C","type":"config.update","ts":1794384000060,"reply_to":null,"payload":{"rev":12,"plan":{"entries":[{"source_ref":{"platform":"facebook","kind":"group","external_id":"123456789"},"interval_s":900,"priority":0,"max_posts_per_visit":30}]},"policy":{"max_loads_per_hour":60,"max_loads_per_day":600,"active_hours":{"from":"07:00","to":"23:00"},"jitter":0.3,"max_scroll_steps":3,"only_when_idle":false},"extractor":{"rev":4,"strategies":["network","embedded","dom"],"network":{},"dom":{},"session_markers":{}}}}"#;
    let raw_posts_push = r#"{"v":2,"id":"01D","type":"posts.push","ts":1794384905000,"reply_to":null,"payload":{"run_id":"r_01","source_ref":{"platform":"facebook","kind":"group","external_id":"123456789"},"posts":[{"platform":"facebook","post_id":"987654321","source_external_id":"123456789","permalink":"https://www.facebook.com/groups/123456789/posts/987654321/","author":{"name":"Nguyễn Văn A","is_anonymous":false},"text":"E cần thuê chung cư 2pn khu Cầu Giấy, tầm 12-15tr, vào ở luôn. Lh 0912.345.678","text_truncated":false,"created_at":1794384600000,"captured_at":1794384900000,"attachments":[],"extraction":{"strategy":"network","profile_rev":4}}]}}"#;
    let raw_ack = r#"{"v":2,"id":"01E","type":"ack","ts":1794384905020,"reply_to":"01D","payload":{"accepted":1,"duplicates":0}}"#;

    for raw in [
        raw_hello,
        raw_hello_ok,
        raw_config_update,
        raw_posts_push,
        raw_ack,
    ] {
        let expected_val: Value = serde_json::from_str(raw).unwrap();
        let via_serde: Envelope = serde_json::from_str(raw).unwrap();
        let via_parser: Envelope = parse_envelope_str(raw).unwrap();
        assert_eq!(via_serde, via_parser);
        let reserialized = serde_json::to_value(&via_parser).unwrap();
        assert_eq!(reserialized, expected_val);
    }

    // Also verify the shared JSON fixture file covering all 14 message types.
    let fixture_file = include_str!("fixtures/protocol_v2_examples.json");
    let root: Value = serde_json::from_str(fixture_file).unwrap();
    let mut all_msgs = Vec::new();
    all_msgs.extend(root["spec_section_6_session"].as_array().unwrap().iter());
    all_msgs.extend(
        root["additional_catalog_messages"]
            .as_array()
            .unwrap()
            .iter(),
    );
    assert_eq!(all_msgs.len(), 14);

    for fixture_val in all_msgs {
        let raw_bytes = serde_json::to_vec(fixture_val).unwrap();
        let env_from_parser = parse_envelope(&raw_bytes).unwrap();
        let env_from_serde: Envelope = serde_json::from_slice(&raw_bytes).unwrap();
        assert_eq!(env_from_parser, env_from_serde);
        assert_eq!(
            &serde_json::to_value(&env_from_parser).unwrap(),
            fixture_val
        );
    }
}

#[test]
fn all_variants_and_empty_payloads_emit_exact_wire_shape() {
    let ping = Envelope::new(Body::Ping {});
    assert_eq!(ping.v, 2);
    assert!(Ulid::from_str(&ping.id).is_ok());
    assert!(ping.ts > 0);
    assert_eq!(ping.reply_to, None);
    assert!(ping.body.is_extension_to_desktop());

    let ping_val = serde_json::to_value(&ping).unwrap();
    assert_eq!(ping_val["v"], json!(2));
    assert_eq!(ping_val["reply_to"], Value::Null);
    assert_eq!(ping_val["type"], json!("ping"));
    assert_eq!(ping_val["payload"], json!({}));

    let pong = Envelope::reply(&ping.id, Body::Pong {});
    assert_eq!(pong.reply_to.as_deref(), Some(ping.id.as_str()));
    assert!(pong.body.is_desktop_to_extension());
    let pong_val = serde_json::to_value(&pong).unwrap();
    assert_eq!(pong_val["type"], json!("pong"));
    assert_eq!(pong_val["payload"], json!({}));
    assert_eq!(pong_val["reply_to"], json!(ping.id));

    let resume = Envelope::new(Body::CrawlResume {});
    let resume_val = serde_json::to_value(&resume).unwrap();
    assert_eq!(resume_val["type"], json!("crawl.resume"));
    assert_eq!(resume_val["payload"], json!({}));

    // Verify `crawl.pause` with `until: None` emits `"until": null` per `until: number | null`.
    let pause = Envelope::new(Body::CrawlPause {
        until: None,
        reason: "checkpoint_detected".to_owned(),
    });
    let pause_val = serde_json::to_value(&pause).unwrap();
    assert_eq!(
        pause_val["payload"],
        json!({"until": null, "reason": "checkpoint_detected"})
    );

    // Rich RawPost with attachments, counts, external_id, and SourceInfo helper.
    let src_info = SourceInfo {
        platform: "facebook".to_owned(),
        kind: "group".to_owned(),
        external_id: "555".to_owned(),
        name: "BĐS Hà Nội".to_owned(),
        url: "https://www.facebook.com/groups/555/".to_owned(),
        privacy: Some(SourcePrivacy::Public),
        member_count: Some(50_000),
    };
    assert_eq!(src_info.source_ref(), SourceRef::facebook_group("555"));

    let post = RawPost {
        platform: "facebook".to_owned(),
        post_id: "p_999".to_owned(),
        source_external_id: "555".to_owned(),
        permalink: "https://www.facebook.com/groups/555/posts/p_999/".to_owned(),
        author: AuthorInfo {
            external_id: Some("u_1".to_owned()),
            name: "Trần Thị B".to_owned(),
            is_anonymous: false,
        },
        text: "Cần mua nhà".to_owned(),
        text_truncated: true,
        created_at: None,
        captured_at: 1_794_384_900_000,
        attachments: vec![
            Attachment {
                kind: AttachmentKind::Photo,
                url: Some("https://scontent.xx.fbcdn.net/1.jpg".to_owned()),
                alt: Some("Ảnh phòng khách".to_owned()),
            },
            Attachment {
                kind: AttachmentKind::Video,
                url: None,
                alt: None,
            },
            Attachment {
                kind: AttachmentKind::Link,
                url: Some("https://example.com".to_owned()),
                alt: None,
            },
            Attachment {
                kind: AttachmentKind::Other,
                url: None,
                alt: None,
            },
        ],
        counts: Some(PostCounts {
            comments: Some(4),
            reactions: Some(11),
        }),
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Dom,
            profile_rev: 2,
        },
    };
    let push_env = Envelope::new(Body::PostsPush {
        run_id: "run_2".to_owned(),
        source_ref: src_info.source_ref(),
        posts: vec![post],
    });
    let bytes = serde_json::to_vec(&push_env).unwrap();
    assert_eq!(parse_envelope(&bytes).unwrap(), push_env);

    // Verify all 6 ErrorCode variants round-trip cleanly.
    for (code, wire_name) in [
        (ErrorCode::ProtocolMismatch, "protocol_mismatch"),
        (ErrorCode::UnknownType, "unknown_type"),
        (ErrorCode::InvalidPayload, "invalid_payload"),
        (ErrorCode::DesktopUnavailable, "desktop_unavailable"),
        (ErrorCode::Busy, "busy"),
        (ErrorCode::Internal, "internal"),
    ] {
        assert_eq!(code.as_str(), wire_name);
        let err_env = Envelope::error(Some("01REQ".to_owned()), code, "boom", false);
        let v = serde_json::to_value(&err_env).unwrap();
        assert_eq!(v["payload"]["code"], json!(wire_name));
        assert_eq!(
            parse_envelope(&serde_json::to_vec(&v).unwrap()).unwrap(),
            err_env
        );
    }

    // Verify enum FromStr/Display round-trips and CrawlPolicy default.
    assert_eq!(CrawlPolicy::default().max_loads_per_hour, 60);
    assert_eq!(
        CrawlReason::from_str("passive").unwrap(),
        CrawlReason::Passive
    );
    assert_eq!(
        CrawlStatus::from_str("blocked").unwrap(),
        CrawlStatus::Blocked
    );

    // Verify `crawl.report` optional `dropped_posts` parity with `apps/extension/src/protocol.ts`.
    let report_with_drops = br#"{"v":2,"id":"01REP","ts":1794384910000,"reply_to":null,"type":"crawl.report","payload":{"run_id":"r_9","source_ref":{"platform":"facebook","kind":"group","external_id":"123"},"reason":"scheduled","status":"blocked","started_at":1794384890000,"ended_at":1794384909500,"posts_seen":0,"posts_new":0,"page_loads":1,"error":"logged_out","dropped_posts":7}}"#;
    let parsed_rep = parse_envelope(report_with_drops).unwrap();
    assert!(matches!(
        parsed_rep.body,
        Body::CrawlReport {
            strategy: None,
            dropped_posts: Some(7),
            ..
        }
    ));

    // Verify integer float `jitter: 0` (as produced by JS `JSON.stringify({ jitter: 0.0 })`).
    let cfg_int_jitter = json!({
        "v": 2,
        "id": "01CFG",
        "ts": 1794384000000_i64,
        "reply_to": null,
        "type": "config.update",
        "payload": {
            "rev": 1,
            "plan": CrawlPlan {
                entries: vec![CrawlPlanEntry {
                    source_ref: SourceRef::facebook_group("1"),
                    interval_s: 600,
                    priority: 1,
                    max_posts_per_visit: 20,
                }],
            },
            "policy": {
                "max_loads_per_hour": 60,
                "max_loads_per_day": 600,
                "active_hours": ActiveHours::default(),
                "jitter": 0,
                "max_scroll_steps": 3,
                "only_when_idle": true
            },
            "extractor": ExtractorProfile::default()
        }
    });
    let cfg_bytes = serde_json::to_vec(&cfg_int_jitter).unwrap();
    let parsed_cfg = parse_envelope(&cfg_bytes).unwrap();
    let serde_cfg: Envelope = serde_json::from_slice(&cfg_bytes).unwrap();
    assert_eq!(parsed_cfg, serde_cfg);
}

#[test]
fn graceful_parser_classifies_version_unknown_type_invalid_payload_and_ignores_extra_fields() {
    // 1. `v != 2` -> `protocol_mismatch` with `id` retained for `reply_to`.
    let v1_env =
        br#"{"v":1,"id":"01OLD","ts":1794384000000,"reply_to":null,"type":"hello","payload":{}}"#;
    let err = parse_envelope(v1_env).unwrap_err();
    assert_eq!(err.code, ErrorCode::ProtocolMismatch);
    assert_eq!(err.id.as_deref(), Some("01OLD"));
    let reply = err.to_error_envelope();
    assert_eq!(reply.reply_to.as_deref(), Some("01OLD"));
    assert!(matches!(
        reply.body,
        Body::Error {
            code: ErrorCode::ProtocolMismatch,
            retryable: false,
            ..
        }
    ));

    // Future v3 with completely different fields still classifies as `protocol_mismatch` and keeps `id`.
    let v3_env = br#"{"v":3,"id":"01FUTURE"}"#;
    let err_v3 = parse_envelope(v3_env).unwrap_err();
    assert_eq!(err_v3.code, ErrorCode::ProtocolMismatch);
    assert_eq!(err_v3.id.as_deref(), Some("01FUTURE"));

    // Legacy v1 `Request::Ping { version: 1 }` without `v` -> `protocol_mismatch`.
    let legacy_v1 = br#"{"type":"ping","version":1}"#;
    let err_legacy = parse_envelope(legacy_v1).unwrap_err();
    assert_eq!(err_legacy.code, ErrorCode::ProtocolMismatch);
    assert_eq!(err_legacy.id, None);

    // 2. Unknown `type` -> `unknown_type` with `id` retained.
    assert!(!is_known_message_type("leads.sync"));
    let unknown = br#"{"v":2,"id":"01UNK","ts":1794384000000,"reply_to":null,"type":"leads.sync","payload":{"any":123}}"#;
    let err_unk = parse_envelope(unknown).unwrap_err();
    assert_eq!(err_unk.code, ErrorCode::UnknownType);
    assert_eq!(err_unk.id.as_deref(), Some("01UNK"));

    // 3. Invalid payload on known `type` -> `invalid_payload` with `id` retained.
    let bad_hello = br#"{"v":2,"id":"01BAD","ts":1794384000000,"reply_to":null,"type":"hello","payload":{"profile_id":"p1"}}"#;
    let err_bad = parse_envelope(bad_hello).unwrap_err();
    assert_eq!(err_bad.code, ErrorCode::InvalidPayload);
    assert_eq!(err_bad.id.as_deref(), Some("01BAD"));

    let null_payload =
        br#"{"v":2,"id":"01NULL","ts":1794384000000,"reply_to":null,"type":"ping","payload":null}"#;
    let err_null = parse_envelope(null_payload).unwrap_err();
    assert_eq!(err_null.code, ErrorCode::InvalidPayload);
    assert_eq!(err_null.id.as_deref(), Some("01NULL"));

    let malformed_json = b"{not valid json";
    let err_malformed = parse_envelope(malformed_json).unwrap_err();
    assert_eq!(err_malformed.code, ErrorCode::InvalidPayload);
    assert_eq!(err_malformed.id, None);

    // 4. Unknown extra fields inside `payload` (both struct payloads and empty `{}` payloads)
    //    MUST be ignored per `01-protocol.md §3`.
    let hello_with_extras = br#"{
        "v": 2,
        "id": "01EXT",
        "ts": 1794384000000,
        "reply_to": null,
        "type": "hello",
        "extra_envelope_meta": "ignored",
        "payload": {
            "profile_id": "p_1",
            "ext_version": "0.3.0",
            "browser": "chrome/145",
            "config_rev": 7,
            "new_optional_capability": ["tap_v2", "dom_v3"],
            "nested_unknown": { "flag": true }
        }
    }"#;
    let raw_env = parse_raw_envelope(hello_with_extras).unwrap();
    assert_eq!(raw_env.msg_type, "hello");
    let parsed_hello = parse_envelope(hello_with_extras).unwrap();
    assert_eq!(
        parsed_hello.body,
        Body::Hello {
            profile_id: "p_1".to_owned(),
            ext_version: "0.3.0".to_owned(),
            browser: "chrome/145".to_owned(),
            config_rev: 7,
        }
    );

    let ping_with_extras = br#"{
        "v": 2,
        "id": "01PINGEXT",
        "ts": 1794384000000,
        "reply_to": null,
        "type": "ping",
        "payload": { "client_monotonic_ms": 99999 }
    }"#;
    let parsed_ping = parse_envelope(ping_with_extras).unwrap();
    assert_eq!(parsed_ping.body, Body::Ping {});

    // `extract_envelope_id` extracts `id` even on arbitrary JSON and returns `None` on garbage.
    assert_eq!(
        extract_envelope_id(br#"{"id":"01XYZ","anything":true}"#).as_deref(),
        Some("01XYZ")
    );
    assert_eq!(extract_envelope_id(br#"{"id":123}"#), None);
    assert_eq!(extract_envelope_id(b"not-json"), None);
}

#[tokio::test]
async fn length_prefixed_framing_sync_and_async_with_size_guards() {
    let env1 = Envelope::new(Body::Ping {});
    let env2 = Envelope::reply(
        &env1.id,
        Body::SessionStatus {
            runtime: None,
            platform: "facebook".to_owned(),
            state: SessionState::Checkpoint,
            detail: Some("redirected to /checkpoint/".to_owned()),
        },
    );

    // Sync framing check + exact 4-byte little-endian header verification.
    let mut wire = Vec::new();
    write_envelope_sync(&mut wire, &env1, MAX_EXT_TO_HOST_BYTES).unwrap();
    let first_json_len = serde_json::to_vec(&env1).unwrap().len() as u32;
    assert_eq!(&wire[..4], &first_json_len.to_le_bytes());
    write_envelope_sync(&mut wire, &env2, MAX_EXT_TO_HOST_BYTES).unwrap();

    let mut cursor = Cursor::new(wire.clone());
    assert_eq!(
        read_envelope_sync(&mut cursor, MAX_EXT_TO_HOST_BYTES).unwrap(),
        Some(env1.clone())
    );
    assert_eq!(
        read_envelope_sync(&mut cursor, MAX_EXT_TO_HOST_BYTES).unwrap(),
        Some(env2.clone())
    );
    assert_eq!(
        read_envelope_sync(&mut cursor, MAX_EXT_TO_HOST_BYTES).unwrap(),
        None
    );

    // Async framing round-trip.
    let (mut client, mut server) = tokio::io::duplex(64 * 1024);
    write_envelope_async(&mut client, &env1, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    write_envelope_async(&mut client, &env2, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap();
    drop(client);

    let f1 = read_frame_async(&mut server, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap()
        .unwrap();
    let f2 = read_frame_async(&mut server, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parse_envelope(&f1).unwrap(), env1);
    assert_eq!(parse_envelope(&f2).unwrap(), env2);
    assert_eq!(
        read_frame_async(&mut server, MAX_EXT_TO_HOST_BYTES)
            .await
            .unwrap(),
        None
    );

    // Truncated 2-byte header must error with `UnexpectedEof`, NOT return `Ok(None)`.
    let mut trunc_sync = Cursor::new(vec![0x05, 0x00]);
    let err = read_frame_sync(&mut trunc_sync, MAX_HOST_TO_EXT_BYTES).unwrap_err();
    assert!(matches!(err, FrameError::Io(ref e) if e.kind() == io::ErrorKind::UnexpectedEof));

    let mut trunc_async = Cursor::new(vec![0x05, 0x00]);
    let err_async = read_frame_async(&mut trunc_async, MAX_HOST_TO_EXT_BYTES)
        .await
        .unwrap_err();
    assert!(matches!(err_async, FrameError::Io(ref e) if e.kind() == io::ErrorKind::UnexpectedEof));

    // Max frame cap guard: 4 GiB header (`0xFFFF_FFFF`) rejected immediately without OOM.
    let huge_header = u32::MAX.to_le_bytes();
    let mut huge_sync = Cursor::new(huge_header.to_vec());
    let err_huge = read_frame_sync(&mut huge_sync, MAX_HOST_TO_EXT_BYTES).unwrap_err();
    assert!(matches!(
        err_huge,
        FrameError::FrameTooLarge {
            size: 0xFFFF_FFFF,
            max: MAX_HOST_TO_EXT_BYTES
        }
    ));

    let mut huge_async = Cursor::new(huge_header.to_vec());
    let err_huge_async = read_frame_async(&mut huge_async, MAX_EXT_TO_HOST_BYTES)
        .await
        .unwrap_err();
    assert!(matches!(
        err_huge_async,
        FrameError::FrameTooLarge {
            size: 0xFFFF_FFFF,
            max: MAX_EXT_TO_HOST_BYTES
        }
    ));

    // Write guard rejects > 1 MiB host->ext frames.
    let oversized_payload = vec![b'x'; MAX_HOST_TO_EXT_BYTES + 1];
    let mut sink = Vec::new();
    assert!(matches!(
        write_frame_sync(&mut sink, &oversized_payload, MAX_HOST_TO_EXT_BYTES),
        Err(FrameError::FrameTooLarge { .. })
    ));
    let mut async_sink = Vec::new();
    assert!(matches!(
        write_frame_async(&mut async_sink, &oversized_payload, MAX_HOST_TO_EXT_BYTES).await,
        Err(FrameError::FrameTooLarge { .. })
    ));
}

#[test]
fn ipc_endpoint_and_manifest_paths_match_all_platforms() {
    let home = Path::new("/Users/alice");
    let mac_ep =
        resolve_ipc_endpoint_with(IpcPlatform::MacOs, None, Some(home), None, None).unwrap();
    assert_eq!(
        mac_ep.as_path(),
        Path::new("/Users/alice/Library/Application Support/DealSonar/ipc.sock")
    );

    let linux_home = Path::new("/home/alice");
    let xdg_rt = Path::new("/run/user/1000");
    let linux_xdg = resolve_ipc_endpoint_with(
        IpcPlatform::Linux,
        None,
        Some(linux_home),
        Some(xdg_rt),
        None,
    )
    .unwrap();
    assert_eq!(
        linux_xdg.as_path(),
        Path::new("/run/user/1000/dealsonar/ipc.sock")
    );

    let linux_fallback =
        resolve_ipc_endpoint_with(IpcPlatform::Linux, None, Some(linux_home), None, None).unwrap();
    assert_eq!(
        linux_fallback.as_path(),
        Path::new("/home/alice/.local/share/dealsonar/ipc.sock")
    );

    let win_ep =
        resolve_ipc_endpoint_with(IpcPlatform::Windows, None, None, None, Some("alice.nguyen"))
            .unwrap();
    assert_eq!(win_ep.to_string_lossy(), r"\\.\pipe\dealsonar-alice_nguyen");

    let custom = Path::new("/tmp/custom-dealsonar/ipc.sock");
    let overridden =
        resolve_ipc_endpoint_with(IpcPlatform::MacOs, Some(custom), Some(home), None, None)
            .unwrap();
    assert_eq!(overridden.as_path(), custom);

    // Data dirs (`03-desktop.md §2.1`).
    assert_eq!(
        default_data_dir_with(IpcPlatform::MacOs, Some(home), None).unwrap(),
        Path::new("/Users/alice/Library/Application Support/DealSonar")
    );
    assert_eq!(
        default_data_dir_with(IpcPlatform::Linux, Some(linux_home), None).unwrap(),
        Path::new("/home/alice/.local/share/dealsonar")
    );
    assert_eq!(
        default_data_dir_with(
            IpcPlatform::Windows,
            None,
            Some(Path::new(r"C:\Users\alice\AppData\Roaming"))
        )
        .unwrap(),
        Path::new(r"C:\Users\alice\AppData\Roaming").join("DealSonar")
    );

    // Chrome NativeMessagingHosts manifest paths (`03-desktop.md §2.2`).
    assert_eq!(
        chrome_manifest_path_with(IpcPlatform::MacOs, Some(home), None, None).unwrap(),
        Path::new("/Users/alice/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json")
    );
    assert_eq!(
        chrome_manifest_path_with(IpcPlatform::Linux, Some(linux_home), None, None).unwrap(),
        Path::new("/home/alice/.config/google-chrome/NativeMessagingHosts/com.dealsonar.host.json")
    );
    assert_eq!(
        chrome_manifest_path_with(
            IpcPlatform::Windows,
            None,
            None,
            Some(Path::new(r"C:\Users\alice\AppData\Roaming"))
        )
        .unwrap(),
        Path::new(r"C:\Users\alice\AppData\Roaming")
            .join("DealSonar")
            .join("com.dealsonar.host.json")
    );
    assert_eq!(
        WINDOWS_CHROME_REGISTRY_KEY,
        r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host"
    );
}

#[test]
fn native_manifest_validation_and_idempotent_install() {
    let tmp = tempdir().unwrap();
    let manifest_path = tmp
        .path()
        .join("NativeMessagingHosts/com.dealsonar.host.json");
    let bin_path = Path::new("/Applications/DealSonar.app/Contents/MacOS/dealsonar-native-host");

    let manifest = NativeHostManifest::new("abcdefghijklmnopabcdefghijklmnop", bin_path).unwrap();
    assert_eq!(manifest.name, "com.dealsonar.host");
    assert_eq!(manifest.host_type, "stdio");
    assert_eq!(
        manifest.allowed_origins,
        vec!["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
    );

    // First write creates the file; second check sees identical content; updated binary rewrites.
    assert!(verify_or_write_manifest(&manifest_path, &manifest).unwrap());
    assert!(!verify_or_write_manifest(&manifest_path, &manifest).unwrap());

    let moved_manifest = NativeHostManifest::new(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        Path::new("/usr/local/bin/dealsonar-native-host"),
    )
    .unwrap();
    assert!(verify_or_write_manifest(&manifest_path, &moved_manifest).unwrap());

    // Security checks: reject wildcards, empty IDs, and relative binary paths.
    assert!(matches!(
        NativeHostManifest::new("*", bin_path),
        Err(ManifestError::InvalidExtensionId(_))
    ));
    assert!(matches!(
        NativeHostManifest::new("", bin_path),
        Err(ManifestError::InvalidExtensionId(_))
    ));
    assert!(matches!(
        NativeHostManifest::new(
            "abcdefghijklmnopabcdefghijklmnop",
            Path::new("relative/bin")
        ),
        Err(ManifestError::RelativeBinaryPath(_))
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn unix_ipc_enforces_0700_permissions_stale_recovery_and_full_duplex() {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempdir().unwrap();
    let sock_dir = tmp.path().join("dealsonar-ipc");
    // Pre-create with overly permissive 0o755 to verify `bind` tightens it to 0o700!
    fs::create_dir_all(&sock_dir).unwrap();
    fs::set_permissions(&sock_dir, Permissions::from_mode(0o755)).unwrap();

    let sock_path = sock_dir.join("ipc.sock");
    let endpoint = IpcEndpoint::from_path(&sock_path);

    let mut listener = IpcListener::bind(&endpoint).unwrap();
    let mode = fs::metadata(&sock_dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o700,
        "socket directory must have strict 0700 permissions"
    );

    // Second bind while listener is live MUST fail with AddrInUse without stealing the socket.
    let second = IpcListener::bind(&endpoint).unwrap_err();
    assert_eq!(second.kind(), io::ErrorKind::AddrInUse);

    // Full-duplex exchange with split streams.
    let ep_clone = endpoint.clone();
    let server_task = tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (mut reader, mut writer) = stream.into_split();
        let raw = reader.read_ext_frame().await.unwrap().unwrap();
        let hello = parse_envelope(&raw).unwrap();
        let reply = Envelope::reply(
            &hello.id,
            Body::HelloOk {
                desktop_version: "0.2.0".to_owned(),
                config_rev: 5,
            },
        );
        writer.write_host_envelope(&reply).await.unwrap();
    });

    let client = IpcStream::connect(&ep_clone).await.unwrap();
    let (mut c_read, mut c_write) = client.into_split();
    let hello = Envelope::new(Body::Hello {
        profile_id: "prof_1".to_owned(),
        ext_version: "0.2.0".to_owned(),
        browser: "chrome/142".to_owned(),
        config_rev: 4,
    });
    c_write.write_ext_envelope(&hello).await.unwrap();
    let reply_bytes = c_read.read_host_frame().await.unwrap().unwrap();
    let reply = parse_envelope(&reply_bytes).unwrap();
    assert_eq!(reply.reply_to.as_deref(), Some(hello.id.as_str()));
    server_task.await.unwrap();

    // Simulate a stale crashed socket (bound std UnixListener whose fd is closed without unlink).
    {
        let raw_listener = std::os::unix::net::UnixListener::bind(&sock_path).unwrap();
        drop(raw_listener);
        assert!(sock_path.exists());
    }
    let rebound = IpcListener::bind(&endpoint).expect("should clean up stale socket and rebind");
    drop(rebound);
}
