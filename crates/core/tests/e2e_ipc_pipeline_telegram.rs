//! Full End-to-End Integration Test (`#29` DONE CRITERIA #1):
//! Simulated Chrome extension over real local `IpcStream` -> `hello` -> `sources.discovered` ->
//! `posts.push` (real demand post, disguised behavioral peer post, duplicate post in 2nd group,
//! short spam post) -> T0–T7 pipeline with `MockAiProvider` + local mock Telegram Bot HTTP server ->
//! verifies exact Lead created, privacy stripping on AI prompt, `also_seen_in` updated on duplicate
//! without duplicate alert, behavioral peer rejected, Telegram HTML alert delivered, inline callback
//! `fb:<lead_id>:correct` recorded as feedback, dynamic `lead_list` filtering, CRM/contact ops, and
//! CSV / Pro XLSX export.

use std::collections::VecDeque;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{
    AiProviderId, AuthorRole, BlocklistKind, CoreEvent, CreateRadarDraftInput, DynamicFieldFilter,
    ExportFormat, FeedbackLabel, FieldDef, FieldType, FilterOperator, LeadCrmPatch,
    LeadExportInput, LeadFilterQuery, LeadStatus, MatchPolicy, PlanTier, RadarStatus,
    SettingsPatch, WantIntent,
};
use dealsonar_core::{CoreConfig, CoreError, CoreServiceBuilder, LicensePayload, LicenseSigner};
use dealsonar_notify::{TelegramClient, TelegramClientConfig};
use dealsonar_protocol::ipc::{IpcEndpoint, IpcStream};
use dealsonar_protocol::{
    parse_envelope, write_envelope_async, AuthorInfo, Body, Envelope, ExtractionInfo,
    ExtractionStrategy, RawPost, SourceInfo, SourcePrivacy, SourceRef, MAX_EXT_TO_HOST_BYTES,
};
use dealsonar_store::models::{now_ms, AuthorInput, NewPost};
use dealsonar_store::Store;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
struct RecordedTelegramSend {
    chat_id: i64,
    text: String,
    reply_markup: Option<Value>,
}

#[derive(Default)]
struct MockTelegramState {
    updates_queue: VecDeque<Value>,
    sent_messages: Vec<RecordedTelegramSend>,
    callback_answers: Vec<Value>,
    edited_markups: Vec<Value>,
    next_msg_id: i64,
}

struct MockTelegramServer {
    base_url: String,
    state: Arc<Mutex<MockTelegramState>>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockTelegramServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock telegram server");
        let addr = listener.local_addr().expect("local addr");
        let state = Arc::new(Mutex::new(MockTelegramState {
            next_msg_id: 100,
            ..Default::default()
        }));
        let state_clone = Arc::clone(&state);

        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let st = Arc::clone(&state_clone);
                tokio::spawn(async move {
                    let mut buf = Vec::with_capacity(8192);
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if let Some(idx) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    break idx + 4;
                                }
                            }
                        }
                    };

                    let (path, content_len) = {
                        let header_str = String::from_utf8_lossy(&buf[..header_end]);
                        let first_line = header_str.lines().next().unwrap_or("");
                        let path = first_line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("/")
                            .to_string();

                        let content_len = header_str
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                if k.eq_ignore_ascii_case("content-length") {
                                    v.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                        (path, content_len)
                    };

                    while buf.len() < header_end + content_len {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }

                    let body_bytes = &buf[header_end..buf.len().min(header_end + content_len)];
                    let body_json: Value =
                        serde_json::from_slice(body_bytes).unwrap_or_else(|_| json!({}));

                    let resp_json = if path.contains("/getMe") {
                        json!({
                            "ok": true,
                            "result": {
                                "id": 99887766,
                                "is_bot": true,
                                "first_name": "DealSonar Bot",
                                "username": "dealsonar_e2e_bot"
                            }
                        })
                    } else if path.contains("/getUpdates") {
                        let mut guard = st.lock().expect("tg lock");
                        let items: Vec<Value> = guard.updates_queue.drain(..).collect();
                        json!({
                            "ok": true,
                            "result": items
                        })
                    } else if path.contains("/sendMessage") {
                        let mut guard = st.lock().expect("tg lock");
                        guard.next_msg_id += 1;
                        let mid = guard.next_msg_id;
                        guard.sent_messages.push(RecordedTelegramSend {
                            chat_id: body_json
                                .get("chat_id")
                                .and_then(Value::as_i64)
                                .unwrap_or(0),
                            text: body_json
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            reply_markup: body_json.get("reply_markup").cloned(),
                        });
                        json!({
                            "ok": true,
                            "result": { "message_id": mid }
                        })
                    } else if path.contains("/answerCallbackQuery") {
                        st.lock().expect("tg lock").callback_answers.push(body_json);
                        json!({ "ok": true, "result": true })
                    } else if path.contains("/editMessageReplyMarkup") {
                        st.lock().expect("tg lock").edited_markups.push(body_json);
                        json!({ "ok": true, "result": true })
                    } else {
                        json!({ "ok": true, "result": true })
                    };

                    let resp_body = serde_json::to_vec(&resp_json).expect("serialize tg json");
                    let http_resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        resp_body.len()
                    );
                    let _ = socket.write_all(http_resp.as_bytes()).await;
                    let _ = socket.write_all(&resp_body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        Self {
            base_url: format!("http://{addr}"),
            state,
            handle,
        }
    }

    fn push_update(&self, update: Value) {
        self.state
            .lock()
            .expect("tg lock")
            .updates_queue
            .push_back(update);
    }

    fn sent_messages(&self) -> Vec<RecordedTelegramSend> {
        self.state.lock().expect("tg lock").sent_messages.clone()
    }
}

impl Drop for MockTelegramServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn recv_host_env(stream: &mut IpcStream) -> Envelope {
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

async fn send_ext_env(stream: &mut IpcStream, env: &Envelope) {
    write_envelope_async(stream, env, MAX_EXT_TO_HOST_BYTES)
        .await
        .expect("write ext envelope");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_e2e_ipc_pipeline_telegram_feedback_and_export() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let endpoint = IpcEndpoint::from_path(tmp.path().join("ipc.sock"));
    let tg_server = MockTelegramServer::start().await;

    let tg_client = TelegramClient::with_config(TelegramClientConfig {
        api_base_url: tg_server.base_url.clone(),
        request_timeout: Duration::from_secs(5),
        enforce_rate_limits: false,
    })
    .expect("tg client");

    let mock_ai = Arc::new(MockAiProvider::new());
    let signer = LicenseSigner::generate_for_test();
    let store = Store::open_in_memory().expect("open store");

    let config = CoreConfig {
        data_dir: tmp.path().join("data"),
        logs_dir: Some(tmp.path().join("logs")),
        ipc_endpoint: Some(endpoint.clone()),
        batch_trigger_count: 1,
        batch_max_wait_ms: 0,
        spawn_background_workers: false,
        ..CoreConfig::default()
    };

    let service = CoreServiceBuilder::new(store)
        .with_config(config)
        .with_ai_provider(mock_ai.clone())
        .with_telegram_client(tg_client)
        .with_license_verifier(signer.verifier())
        .start()
        .expect("start CoreService");

    let mut events_rx = service.subscribe_events();

    // 1. Setup Telegram Bot Token + `/start` onboarding -> auto-creates channel & sends welcome HTML
    let bot_status = service
        .telegram_set_token("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi")
        .await
        .expect("telegram_set_token");
    assert!(bot_status.waiting_for_start);
    assert_eq!(bot_status.bot_username, "dealsonar_e2e_bot");

    tg_server.push_update(json!({
        "update_id": 1001,
        "message": {
            "message_id": 1,
            "chat": { "id": 555666, "type": "private", "first_name": "Minh" },
            "text": "/start"
        }
    }));
    service.tick_workers_now().await.expect("tick /start");

    let channels = service.channel_list().expect("channel_list");
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].kind, "telegram");
    assert_eq!(channels[0].config.chat_id.as_deref(), Some("555666"));

    let welcome_msgs = tg_server.sent_messages();
    assert_eq!(
        welcome_msgs.len(),
        1,
        "expected 1 welcome message after /start"
    );
    assert_eq!(welcome_msgs[0].chat_id, 555666);

    // 2. Connect simulated Chrome extension over real local `IpcStream`
    let mut ext_stream = IpcStream::connect(&endpoint)
        .await
        .expect("connect IpcStream");

    let hello_env = Envelope::new(Body::Hello {
        profile_id: "Profile 1".to_string(),
        ext_version: "0.1.0".to_string(),
        browser: "Chrome/131.0".to_string(),
        config_rev: 0,
    });
    send_ext_env(&mut ext_stream, &hello_env).await;

    let reply_hello = recv_host_env(&mut ext_stream).await;
    assert_eq!(reply_hello.reply_to.as_deref(), Some(hello_env.id.as_str()));
    assert!(matches!(
        reply_hello.body,
        Body::HelloOk { config_rev: 1, .. }
    ));

    let initial_cfg = recv_host_env(&mut ext_stream).await;
    assert!(matches!(
        initial_cfg.body,
        Body::ConfigUpdate { rev: 1, .. }
    ));

    // 3. Extension sends `sources.discovered` with `follow: Some(true)` for 2 groups
    let disc_env = Envelope::new(Body::SourcesDiscovered {
        follow: Some(true),
        sources: vec![
            SourceInfo {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "fb_grp_q7".to_string(),
                name: "Thuê Nhà Quận 7".to_string(),
                url: "https://www.facebook.com/groups/fb_grp_q7".to_string(),
                privacy: Some(SourcePrivacy::Private),
                member_count: Some(45_000),
            },
            SourceInfo {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "fb_grp_pmh".to_string(),
                name: "Cư Dân Phú Mỹ Hưng".to_string(),
                url: "https://www.facebook.com/groups/fb_grp_pmh".to_string(),
                privacy: Some(SourcePrivacy::Public),
                member_count: Some(28_000),
            },
        ],
    });
    send_ext_env(&mut ext_stream, &disc_env).await;

    // Receive `ConfigUpdate` + `Ack` (order between pushed ConfigUpdate and reply Ack is deterministic on single writer channel: ConfigUpdate queued first, then Ack)
    let m1 = recv_host_env(&mut ext_stream).await;
    let m2 = recv_host_env(&mut ext_stream).await;
    let (disc_ack, disc_cfg) = if m1.reply_to.is_some() {
        (m1, m2)
    } else {
        (m2, m1)
    };
    assert_eq!(
        disc_ack.body,
        Body::Ack {
            accepted: 2,
            duplicates: 0
        }
    );
    assert!(matches!(disc_cfg.body, Body::ConfigUpdate { .. }));

    let sources = service.source_list().expect("source_list");
    assert_eq!(sources.len(), 2);
    let grp_a = sources
        .iter()
        .find(|s| s.external_id == "fb_grp_q7")
        .expect("Group A");
    let grp_b = sources
        .iter()
        .find(|s| s.external_id == "fb_grp_pmh")
        .expect("Group B");
    assert!(grp_a.followed && grp_b.followed);

    // 4. Create & activate a Demand Radar watching both groups (attaches healthy Telegram channel automatically)
    let radar_detail = service
        .radar_create_draft(CreateRadarDraftInput {
            name: "Khách thuê CHCC Q7".to_string(),
            template_id: None,
            description: "Tìm khách thực sự cần thuê căn hộ chung cư Quận 7".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("Môi giới cho thuê căn hộ Quận 7".to_string()),
            fields: vec![
                FieldDef {
                    key: "budget".to_string(),
                    label: "Ngân sách".to_string(),
                    r#type: FieldType::Money,
                    description: "Ngân sách thuê mỗi tháng".to_string(),
                    required: true,
                    options: None,
                    show_in_alert: true,
                    order: 0,
                },
                FieldDef {
                    key: "bedrooms".to_string(),
                    label: "Số phòng ngủ".to_string(),
                    r#type: FieldType::Number,
                    description: "Số phòng ngủ".to_string(),
                    required: false,
                    options: None,
                    show_in_alert: true,
                    order: 1,
                },
                FieldDef {
                    key: "location".to_string(),
                    label: "Khu vực".to_string(),
                    r#type: FieldType::Location,
                    description: "Quận/phường mong muốn".to_string(),
                    required: false,
                    options: None,
                    show_in_alert: true,
                    order: 2,
                },
                FieldDef {
                    key: "phone".to_string(),
                    label: "Số điện thoại".to_string(),
                    r#type: FieldType::Phone,
                    description: "Số điện thoại liên hệ".to_string(),
                    required: false,
                    options: None,
                    show_in_alert: true,
                    order: 3,
                },
            ],
            match_policy: MatchPolicy {
                want_intent: WantIntent::Demand,
                exclude_roles: vec![AuthorRole::Peer],
                hard_filters: Vec::new(),
            },
            source_ids: vec![grp_a.id.clone(), grp_b.id.clone()],
            notify: None,
        })
        .expect("radar_create_draft");

    let radar_id = radar_detail.radar.id.clone();
    let activated_radar = service
        .radar_set_status(&radar_id, RadarStatus::Active)
        .await
        .expect("activate radar");
    assert_eq!(activated_radar.status, RadarStatus::Active);

    // Drain the `ConfigUpdate` pushed when the radar became active
    let active_cfg = recv_host_env(&mut ext_stream).await;
    if let Body::ConfigUpdate { plan, .. } = active_cfg.body {
        assert_eq!(plan.entries.len(), 2, "both followed groups scheduled");
    } else {
        panic!(
            "expected ConfigUpdate on radar activation, got {:?}",
            active_cfg.body
        );
    }

    // 5. Seed behavioral history for disguised broker `fb_peer_broker`:
    //    - Signal 1: `>= 5` posts by `fb_peer_broker` in the last 7 days
    //    - Signal 3: phone `+84988777666` shared by `>= 3` distinct authors (`fb_peer_broker`, `fb_clone_1`, `fb_clone_2`)
    //    Even when AI returns `author_role = "end_user"`, T6 Behavioral Peer Override (`>= 2` signals) MUST override to `peer` and reject!
    let now = now_ms();
    for i in 0..5 {
        let hist_text = format!("Bài cũ số {i} ở nhóm khác không liên quan {}", i * 111);
        let (p, _) = service
            .store()
            .insert_post(&NewPost {
                id: None,
                platform: "facebook".to_string(),
                external_id: format!("hist_peer_post_{i}"),
                source_id: grp_a.id.clone(),
                author: Some(AuthorInput {
                    external_id: Some("fb_peer_broker".to_string()),
                    name: "Tuấn Nhà Đẹp".to_string(),
                    is_anonymous: false,
                }),
                permalink: format!("https://www.facebook.com/groups/fb_grp_q7/posts/hist_{i}"),
                text: Some(hist_text.clone()),
                text_norm: Some(hist_text.clone()),
                text_fold: Some(hist_text),
                text_truncated: false,
                lang: Some("vi".to_string()),
                content_hash: format!("hash_hist_peer_{i}"),
                simhash: i as i64 + 100,
                attachments: None,
                counts: None,
                extracted_phones: vec!["+84988777666".to_string()],
                created_at: Some(now - (i as i64 + 1) * 3_600_000),
                captured_at: now - (i as i64 + 1) * 3_600_000,
                strategy: "graphql".to_string(),
            })
            .expect("insert hist post");
        service
            .store()
            .record_post_phones(&p.id, &["+84988777666".to_string()])
            .expect("index phone");
    }
    for clone_idx in [1, 2] {
        let (p, _) = service
            .store()
            .insert_post(&NewPost {
                id: None,
                platform: "facebook".to_string(),
                external_id: format!("clone_post_{clone_idx}"),
                source_id: grp_a.id.clone(),
                author: Some(AuthorInput {
                    external_id: Some(format!("fb_clone_{clone_idx}")),
                    name: format!("Clone Nick {clone_idx}"),
                    is_anonymous: false,
                }),
                permalink: format!(
                    "https://www.facebook.com/groups/fb_grp_q7/posts/clone_{clone_idx}"
                ),
                text: Some("Tin đăng phụ chia sẻ số hotline 0988777666".to_string()),
                text_norm: Some("Tin đăng phụ chia sẻ số hotline 0988777666".to_string()),
                text_fold: Some("tin dang phu chia se so hotline 0988777666".to_string()),
                text_truncated: false,
                lang: Some("vi".to_string()),
                content_hash: format!("hash_clone_{clone_idx}"),
                simhash: 9000 + clone_idx,
                attachments: None,
                counts: None,
                extracted_phones: vec!["+84988777666".to_string()],
                created_at: Some(now - 7_200_000),
                captured_at: now - 7_200_000,
                strategy: "graphql".to_string(),
            })
            .expect("insert clone post");
        service
            .store()
            .record_post_phones(&p.id, &["+84988777666".to_string()])
            .expect("index clone phone");
    }

    // 6. Extension pushes 4 posts in `posts.push`:
    //    (a) Real buyer/tenant demand post in Group A
    //    (b) Disguised behavioral peer post in Group A (worded like an end-user so AI says `end_user`, caught by T6 behavioral peer override!)
    //    (c) Cross-group duplicate of (a) in Group B (< 72h later) -> updates `also_seen_in` with zero extra alert
    //    (d) Short spam post (< 15 chars, no attachments) -> dropped at T3 prefilter without calling AI
    let demand_text = "Gia đình mình cần thuê căn hộ 2PN khu Tân Phong Quận 7 ngân sách 12 triệu/tháng, dọn vào tháng này. Liên hệ Lan 0909123456";
    let disguised_peer_text = "Vợ chồng mình cần thuê căn hộ 2PN Quận 7 tài chính 14 triệu/tháng ở lâu dài, liên hệ 0988777666";
    let short_spam_text = "Ib giá tốt!";

    let push_env = Envelope::new(Body::PostsPush {
        run_id: dealsonar_protocol::new_ulid(),
        source_ref: SourceRef {
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: "fb_grp_q7".to_string(),
        },
        posts: vec![
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_q7".to_string(),
                post_id: "post_real_demand_1".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_q7/posts/100001".to_string(),
                author: AuthorInfo {
                    name: "Ngọc Lan".to_string(),
                    external_id: Some("fb_secret_buyer_uid_1".to_string()),
                    is_anonymous: false,
                },
                text: demand_text.to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now - 120_000),
                captured_at: now - 60_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Network,
                    profile_rev: 1,
                },
            },
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_q7".to_string(),
                post_id: "post_disguised_peer_2".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_q7/posts/100002".to_string(),
                author: AuthorInfo {
                    name: "Tuấn Nhà Đẹp".to_string(),
                    external_id: Some("fb_peer_broker".to_string()),
                    is_anonymous: false,
                },
                text: disguised_peer_text.to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now - 90_000),
                captured_at: now - 50_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Network,
                    profile_rev: 1,
                },
            },
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_pmh".to_string(),
                post_id: "post_dup_group_b_3".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_pmh/posts/200003".to_string(),
                author: AuthorInfo {
                    name: "Ngọc Lan".to_string(),
                    external_id: Some("fb_secret_buyer_uid_1".to_string()),
                    is_anonymous: false,
                },
                text: demand_text.to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now - 30_000),
                captured_at: now - 10_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Dom,
                    profile_rev: 1,
                },
            },
            RawPost {
                platform: "facebook".to_string(),
                source_external_id: "fb_grp_q7".to_string(),
                post_id: "post_short_spam_4".to_string(),
                permalink: "https://www.facebook.com/groups/fb_grp_q7/posts/100004".to_string(),
                author: AuthorInfo {
                    name: "Spammer".to_string(),
                    external_id: Some("fb_spam_4".to_string()),
                    is_anonymous: false,
                },
                text: short_spam_text.to_string(),
                text_truncated: false,
                attachments: Vec::new(),
                created_at: Some(now - 15_000),
                captured_at: now - 5_000,
                counts: None,
                extraction: ExtractionInfo {
                    strategy: ExtractionStrategy::Dom,
                    profile_rev: 1,
                },
            },
        ],
    });

    send_ext_env(&mut ext_stream, &push_env).await;
    let push_ack = recv_host_env(&mut ext_stream).await;
    assert_eq!(push_ack.reply_to.as_deref(), Some(push_env.id.as_str()));
    assert_eq!(
        push_ack.body,
        Body::Ack {
            accepted: 4,
            duplicates: 0
        }
    );

    // Re-sending the exact same `PostsPush` envelope ID returns cached `Ack` from message dedup cache!
    send_ext_env(&mut ext_stream, &push_env).await;
    let replay_ack = recv_host_env(&mut ext_stream).await;
    assert_eq!(
        replay_ack.body,
        Body::Ack {
            accepted: 4,
            duplicates: 0
        }
    );

    // Run T5 AI batch evaluation + T6 Postfilter + T7 Lead creation & Telegram outbox delivery
    service
        .tick_workers_now()
        .await
        .expect("tick pipeline & outbox");

    // Verify AI privacy invariant (`06-ai-bridge.md §6`):
    // - Only 2 posts (`post_real_demand_1` and `post_disguised_peer_2`) reached AI (dup & short spam never sent!)
    // - `author.external_id` (`fb_secret_buyer_uid_1`) and `permalink` were NEVER included in the prompt!
    let ai_reqs = mock_ai.recorded_requests();
    assert_eq!(
        ai_reqs.len(),
        1,
        "both candidate posts batched into 1 judge_extract call"
    );
    assert!(!ai_reqs[0].prompt.contains("fb_secret_buyer_uid_1"));
    assert!(!ai_reqs[0]
        .prompt
        .contains("https://www.facebook.com/groups/"));
    assert!(!ai_reqs[0].prompt.contains("Ib giá tốt!"));

    // Verify ONLY 1 Lead was created (for `post_real_demand_1`), with `also_seen_in` already updated to include Group B (`Cư Dân Phú Mỹ Hưng`)!
    // Wait: in `PostsPush`, `post_dup_group_b_3` arrived synchronously at T2 BEFORE T5 AI created the lead, OR if a second cross-group duplicate arrives AFTER the lead exists, `create_or_attach_dup_cluster` updates `also_seen_in` on existing leads AND `create_lead` can also see cluster siblings or a post-lead duplicate updates `also_seen_in`!
    // Let's push a 3rd group's duplicate post (`post_dup_group_b_after_lead`) right now as well so we verify live `also_seen_in` mutation + `lead:updated` event on an already-notified lead with ZERO duplicate Telegram alert!
    let post_lead_dup_env = Envelope::new(Body::PostsPush {
        run_id: dealsonar_protocol::new_ulid(),
        source_ref: SourceRef {
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: "fb_grp_pmh".to_string(),
        },
        posts: vec![RawPost {
            platform: "facebook".to_string(),
            source_external_id: "fb_grp_pmh".to_string(),
            post_id: "post_dup_group_b_after_lead".to_string(),
            permalink: "https://www.facebook.com/groups/fb_grp_pmh/posts/200099".to_string(),
            author: AuthorInfo {
                name: "Ngọc Lan".to_string(),
                external_id: Some("fb_secret_buyer_uid_1".to_string()),
                is_anonymous: false,
            },
            text: demand_text.to_string(),
            text_truncated: false,
            attachments: Vec::new(),
            created_at: Some(now - 5_000),
            captured_at: now - 1_000,
            counts: None,
            extraction: ExtractionInfo {
                strategy: ExtractionStrategy::Network,
                profile_rev: 1,
            },
        }],
    });
    send_ext_env(&mut ext_stream, &post_lead_dup_env).await;
    let dup2_ack = recv_host_env(&mut ext_stream).await;
    assert_eq!(
        dup2_ack.body,
        Body::Ack {
            accepted: 1,
            duplicates: 0
        }
    );
    service.tick_workers_now().await.expect("tick after dup");

    let leads_resp = service
        .lead_list(LeadFilterQuery::default())
        .expect("lead_list");
    assert_eq!(leads_resp.items.len(), 1, "exactly 1 lead must be created");
    let lead = &leads_resp.items[0];
    assert_eq!(lead.radar_id, radar_id);
    assert_eq!(lead.source_name, "Thuê Nhà Quận 7");
    assert_eq!(lead.author_name, "Ngọc Lan");
    assert!(!lead.is_weak_match);
    assert!(lead.notified_at.is_some());
    assert!(
        lead.also_seen_in
            .iter()
            .any(|s| s.source_name == "Cư Dân Phú Mỹ Hưng"),
        "also_seen_in should contain Cư Dân Phú Mỹ Hưng, got {:?}",
        lead.also_seen_in
    );

    // Verify extracted & normalized fields on the lead (`budget`, `bedrooms`, `phone`)
    let phone_field = lead.fields.get("phone").expect("phone field extracted");
    assert_eq!(phone_field.value, json!("+84909123456"));
    let bedrooms_field = lead.fields.get("bedrooms").expect("bedrooms extracted");
    assert_eq!(bedrooms_field.value.as_f64(), Some(2.0));
    let budget_field = lead.fields.get("budget").expect("budget extracted");
    assert_eq!(
        budget_field.value.get("min").and_then(Value::as_f64),
        Some(12_000_000.0)
    );

    // Verify Contact was automatically upserted & linked (`04-data-model.md §2.4`)
    assert!(lead.contact_id.is_some());
    let contacts = service.contact_list(None, 50).expect("contact_list");
    assert_eq!(contacts.len(), 1);
    assert!(contacts[0].phones.contains(&"+84909123456".to_string()));

    // Verify rejected evaluations contain:
    // - `peer` rejection for `post_disguised_peer_2`
    // - `duplicate` rejection for `post_dup_group_b_3` / `post_dup_group_b_after_lead`
    // - `prefilter` rejection for `post_short_spam_4`
    let rejected = service
        .evaluation_list_rejected(&radar_id, 20)
        .expect("evaluation_list_rejected");
    assert!(
        rejected
            .iter()
            .any(|r| r.reject_reason == dealsonar_core::dto::RejectReason::Peer),
        "disguised peer post must be rejected with reason=peer, got {rejected:?}"
    );
    assert!(
        rejected
            .iter()
            .any(|r| r.reject_reason == dealsonar_core::dto::RejectReason::Duplicate),
        "cross-group duplicate must be recorded with reason=duplicate"
    );
    assert!(
        rejected
            .iter()
            .any(|r| r.reject_reason == dealsonar_core::dto::RejectReason::Prefilter),
        "short spam post must be rejected at T3 prefilter"
    );

    // Verify Telegram HTML alert delivered ONCE (1 welcome + 1 lead alert = 2 total messages, ZERO duplicate alert!)
    let sent_msgs = tg_server.sent_messages();
    assert_eq!(
        sent_msgs.len(),
        2,
        "expected exactly 1 welcome + 1 lead alert (no duplicate alert!), got {sent_msgs:?}"
    );
    let alert_msg = &sent_msgs[1];
    assert_eq!(alert_msg.chat_id, 555666);
    assert!(alert_msg.text.contains("Khách thuê CHCC Q7"));
    assert!(alert_msg.text.contains("Thuê Nhà Quận 7"));
    let expected_cb = format!("fb:{}:correct", lead.id);
    let markup_str = serde_json::to_string(&alert_msg.reply_markup).expect("markup json");
    assert!(
        markup_str.contains(&expected_cb),
        "inline keyboard must contain {expected_cb}, got {markup_str}"
    );

    // Verify `lead:new` and `lead:updated` events were broadcast
    let mut saw_lead_new = false;
    let mut saw_lead_updated = false;
    while let Ok(ev) = events_rx.try_recv() {
        match ev {
            CoreEvent::LeadNew(l) if l.id == lead.id => saw_lead_new = true,
            CoreEvent::LeadUpdated(l) if l.id == lead.id => saw_lead_updated = true,
            _ => {}
        }
    }
    assert!(saw_lead_new, "must emit lead:new");
    assert!(
        saw_lead_updated,
        "must emit lead:updated on cross-group duplicate attachment"
    );

    // 7. Simulate Telegram inline feedback button tap: `fb:<lead_id>:correct`
    tg_server.push_update(json!({
        "update_id": 1002,
        "callback_query": {
            "id": "cbq_999",
            "message": {
                "message_id": 102,
                "chat": { "id": 555666, "type": "private" },
                "text": alert_msg.text
            },
            "data": expected_cb
        }
    }));
    service
        .tick_workers_now()
        .await
        .expect("tick telegram callback");

    let lead_detail = service.lead_get(&lead.id).expect("lead_get after feedback");
    assert_eq!(
        lead_detail.lead.feedback_label,
        Some(FeedbackLabel::Correct),
        "Telegram callback feedback must update lead feedback_label"
    );

    // 8. Dynamic `lead_list` filtering + CRM status update + CSV & Pro XLSX export
    let filtered_match = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(radar_id.clone()),
            filters: Some(vec![DynamicFieldFilter {
                field: "bedrooms".to_string(),
                op: FilterOperator::Eq,
                value: json!(2),
            }]),
            ..Default::default()
        })
        .expect("dynamic filter match");
    assert_eq!(filtered_match.items.len(), 1);

    let filtered_miss = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(radar_id.clone()),
            filters: Some(vec![DynamicFieldFilter {
                field: "bedrooms".to_string(),
                op: FilterOperator::Eq,
                value: json!(4),
            }]),
            ..Default::default()
        })
        .expect("dynamic filter miss");
    assert_eq!(filtered_miss.items.len(), 0);

    // Update CRM status & note
    let updated_detail = service
        .lead_set_status(
            &lead.id,
            LeadStatus::Contacted,
            Some(LeadCrmPatch {
                note: Some(Some("Đã gọi hẹn xem căn hộ lúc 18h".to_string())),
                tags: Some(Some(vec!["vip".to_string(), "q7".to_string()])),
                follow_up_at: None,
            }),
        )
        .expect("lead_set_status");
    assert_eq!(updated_detail.lead.status, LeadStatus::Contacted);
    assert_eq!(
        updated_detail.lead.note.as_deref(),
        Some("Đã gọi hẹn xem căn hộ lúc 18h")
    );

    // Contact note + block/unblock roundtrip
    let cid = lead.contact_id.as_ref().expect("contact id");
    let c_noted = service
        .contact_note(cid, "Khách thiện chí")
        .expect("contact_note");
    assert_eq!(c_noted.note.as_deref(), Some("Khách thiện chí"));
    let blk_res = service
        .contact_block(cid, Some("test block"), None)
        .expect("contact_block");
    assert!(!blk_res.blocked_entries.is_empty());
    let c_after_block = service.contact_get(cid).expect("contact_get");
    assert!(c_after_block.contact.is_blocked);
    for entry in &blk_res.blocked_entries {
        let rm = service.blocklist_remove(&entry.id).expect("unblock");
        assert!(rm.removed);
    }
    let _ = service
        .blocklist_add(BlocklistKind::Keyword, "tuyển cộng tác viên", None, None)
        .expect("add kw block");
    assert_eq!(
        service.blocklist_list(None).expect("blocklist_list").len(),
        1
    );

    // CSV export works on Personal plan
    let csv_path = tmp.path().join("leads.csv");
    let csv_res = service
        .lead_export(LeadExportInput {
            query: LeadFilterQuery {
                radar_id: Some(radar_id.clone()),
                ..Default::default()
            },
            format: ExportFormat::Csv,
            include_post_text: true,
            dest_path: Some(csv_path.to_string_lossy().into_owned()),
        })
        .expect("CSV export on Personal");
    assert_eq!(csv_res.row_count, 1);
    let csv_bytes = fs::read(&csv_path).expect("read csv");
    assert!(
        csv_bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
        "CSV must start with UTF-8 BOM"
    );
    let csv_text = String::from_utf8_lossy(&csv_bytes);
    assert!(csv_text.contains("Khách thuê CHCC Q7"));

    // XLSX export rejected on Personal plan, then succeeds after upgrading to Pro license!
    let xlsx_path = tmp.path().join("leads.xlsx");
    let xlsx_err = service
        .lead_export(LeadExportInput {
            query: LeadFilterQuery {
                radar_id: Some(radar_id.clone()),
                ..Default::default()
            },
            format: ExportFormat::Xlsx,
            include_post_text: false,
            dest_path: Some(xlsx_path.to_string_lossy().into_owned()),
        })
        .expect_err("Personal plan must reject XLSX export");
    assert!(matches!(xlsx_err, CoreError::LicenseLimitExceeded(_)));

    let pro_token = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Công ty BĐS Nam Sài Gòn".to_string(),
            issued_at: now - 60_000,
            expires_at: Some(now + 30 * 86_400_000),
        })
        .expect("sign pro license");
    let lic_status = service.license_set(&pro_token).expect("set pro license");
    assert_eq!(lic_status.plan, PlanTier::Pro);
    assert!(lic_status.is_valid);

    let xlsx_res = service
        .lead_export(LeadExportInput {
            query: LeadFilterQuery {
                radar_id: Some(radar_id.clone()),
                ..Default::default()
            },
            format: ExportFormat::Xlsx,
            include_post_text: true,
            dest_path: Some(xlsx_path.to_string_lossy().into_owned()),
        })
        .expect("Pro plan allows XLSX export");
    assert_eq!(xlsx_res.row_count, 1);
    let xlsx_bytes = fs::read(&xlsx_path).expect("read xlsx");
    assert_eq!(&xlsx_bytes[..2], b"PK", "valid XLSX zip magic");

    // Funnel stats & AI usage stats + remaining facade commands (`radar_get`, `post_get`,
    // `post_search`, `lead_update_field`, `source_set_priority`, `source_crawl_now`,
    // `source_unfollow`, `settings_get`, `settings_set`, `ai_probe`, `ai_set_provider`, `telegram_test`)
    let r_got = service.radar_get(&radar_id).expect("radar_get");
    assert_eq!(r_got.radar.id, radar_id);

    let p_got = service.post_get(&lead.post_id).expect("post_get");
    assert_eq!(p_got.id, lead.post_id);
    let p_hits = service
        .post_search("Tân Phong", Some(&grp_a.id), 10)
        .expect("post_search");
    assert_eq!(p_hits.len(), 1);

    let field_edited = service
        .lead_update_field(&lead.id, "bedrooms", json!(3), Some("3PN".to_string()))
        .expect("lead_update_field");
    assert_eq!(
        field_edited.lead.fields.get("bedrooms").unwrap().value,
        json!(3)
    );

    let prio_src = service
        .source_set_priority(&grp_a.id, true)
        .expect("source_set_priority");
    assert!(prio_src.priority);
    let _ = recv_host_env(&mut ext_stream).await; // ConfigUpdate for priority change

    let crawl_now = service
        .source_crawl_now(&grp_a.id, Some("manual"))
        .expect("source_crawl_now");
    assert!(crawl_now.queued);
    let manual_req = recv_host_env(&mut ext_stream).await;
    assert!(matches!(manual_req.body, Body::CrawlRequest { .. }));

    let unfollowed = service.source_unfollow(&grp_b.id).expect("source_unfollow");
    assert!(!unfollowed.followed);
    let _ = recv_host_env(&mut ext_stream).await; // ConfigUpdate for unfollow

    let s_cur = service.settings_get().expect("settings_get");
    assert_eq!(s_cur.daily_ai_post_cap, 2_000);
    let s_upd = service
        .settings_set(SettingsPatch {
            daily_ai_post_cap: Some(2_500),
            onboarding_completed: Some(true),
            ..Default::default()
        })
        .expect("settings_set");
    assert_eq!(s_upd.daily_ai_post_cap, 2_500);
    assert!(s_upd.onboarding_completed);

    let probes = service
        .ai_probe(Some(AiProviderId::ClaudeCli))
        .await
        .expect("ai_probe");
    assert!(probes.get(&AiProviderId::ClaudeCli).unwrap().installed);
    let s_prov = service
        .ai_set_provider(AiProviderId::ClaudeCli, None)
        .expect("ai_set_provider");
    assert_eq!(s_prov.ai_provider, Some(AiProviderId::ClaudeCli));

    let tg_test = service.telegram_test(None).await.expect("telegram_test");
    assert!(tg_test.ok);

    let funnel = service
        .radar_stats(Some(&radar_id), 7)
        .expect("radar_stats");
    assert!(funnel.leads_created >= 1);
    let usage = service.ai_usage_get(7).expect("ai_usage_get");
    assert!(usage.total_calls >= 1);

    drop(ext_stream);
    service.shutdown().await.expect("shutdown");
}
