//! Deterministic stand-in for the 7-day soak runs of `docs/delivery/02-validation-plan.md §4.2`.
//!
//! Three radars share every group (5 quiet, 10 moderate, 10 busy), the real pipeline runs with
//! a mock AI and a local mock Telegram server, outages are injected, and the soak report is
//! checked against counts derived independently from the pipeline's own tables.
//!
//! This validates the harness and the pipeline's behaviour around outages. It is NOT the
//! evidence the validation plan asks for: that needs a real machine, real groups and a real AI
//! plan over 7 days (see `docs/delivery/04-soak-runbook.md`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dealsonar_ai_bridge::{AiError, MockAiProvider};
use dealsonar_core::dto::{
    AuthorRole, CreateRadarDraftInput, FieldDef, FieldType, LeadFilterQuery, MatchPolicy, PlanTier,
    RadarStatus, WantIntent,
};
use dealsonar_core::{CoreConfig, CoreService, CoreServiceBuilder, LicensePayload, LicenseSigner};
use dealsonar_notify::{TelegramClient, TelegramClientConfig};
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput, NewRulesetInput};
use dealsonar_store::soak::{render_markdown, Interruption, SoakOptions, SoakReport};
use dealsonar_store::Store;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const MIN: i64 = 60_000;

struct MockTelegram {
    base_url: String,
    down: Arc<AtomicBool>,
    sent: Arc<Mutex<Vec<String>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockTelegram {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().unwrap();
        let down = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(Mutex::new(Vec::new()));
        let updates = Arc::new(Mutex::new(VecDeque::from([json!({
            "update_id": 1,
            "message": { "message_id": 1, "chat": { "id": 42, "type": "private", "first_name": "Soak" }, "text": "/start" }
        })])));
        let (down2, sent2) = (Arc::clone(&down), Arc::clone(&sent));
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (down, sent, updates) =
                    (Arc::clone(&down2), Arc::clone(&sent2), Arc::clone(&updates));
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    break i + 4;
                                }
                            }
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let path = head
                        .lines()
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    while buf.len() < header_end + len {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let body: Value =
                        serde_json::from_slice(&buf[header_end..]).unwrap_or(json!({}));
                    let (status, resp) = if path.contains("/getMe") {
                        (
                            "200 OK",
                            json!({ "ok": true, "result": { "id": 7, "is_bot": true, "first_name": "Soak", "username": "soak_bot" } }),
                        )
                    } else if path.contains("/getUpdates") {
                        let items: Vec<Value> = updates.lock().unwrap().drain(..).collect();
                        ("200 OK", json!({ "ok": true, "result": items }))
                    } else if path.contains("/sendMessage") {
                        if down.load(Ordering::SeqCst) {
                            (
                                "500 Internal Server Error",
                                json!({ "ok": false, "error_code": 500, "description": "channel down" }),
                            )
                        } else {
                            let mut sent = sent.lock().unwrap();
                            sent.push(
                                body.get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            );
                            (
                                "200 OK",
                                json!({ "ok": true, "result": { "message_id": 1000 + sent.len() } }),
                            )
                        }
                    } else {
                        ("200 OK", json!({ "ok": true, "result": true }))
                    };
                    let bytes = serde_json::to_vec(&resp).unwrap();
                    let head = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&bytes).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self {
            base_url: format!("http://{addr}"),
            down,
            sent,
            handle,
        }
    }
}

impl Drop for MockTelegram {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

struct Config {
    label: &'static str,
    groups: usize,
    posts_per_group: usize,
}

const CONFIGS: [Config; 3] = [
    Config {
        label: "5 group vắng",
        groups: 5,
        posts_per_group: 2,
    },
    Config {
        label: "10 group trung bình",
        groups: 10,
        posts_per_group: 5,
    },
    Config {
        label: "10 group sôi động",
        groups: 10,
        posts_per_group: 12,
    },
];

fn field(key: &str, label: &str, r#type: FieldType, order: i32) -> FieldDef {
    FieldDef {
        key: key.into(),
        label: label.into(),
        r#type,
        description: format!("{label} nêu trong bài"),
        required: false,
        options: None,
        show_in_alert: true,
        order,
    }
}

fn radar(name: &str, intent: WantIntent, sources: &[String]) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: name.into(),
        template_id: None,
        description: format!("{name}: căn hộ Cầu Giấy"),
        language_hint: Some("vi".into()),
        user_profession: Some("Môi giới".into()),
        fields: vec![
            field("price", "Giá", FieldType::Money, 1),
            field("phone", "SĐT", FieldType::Phone, 2),
        ],
        match_policy: MatchPolicy {
            want_intent: intent,
            exclude_roles: vec![AuthorRole::Peer],
            hard_filters: vec![],
            assumptions: Vec::new(),
            condition: None,
        },
        source_ids: sources.to_vec(),
        notify: None,
    }
}

/// Letters-only code unique per (group, index): digits and phone numbers are normalised away
/// before duplicate detection, so only words keep two posts apart.
fn code(group: usize, index: usize) -> String {
    let n = group * 100 + index;
    let letters = |mut v: usize| {
        let mut out = String::new();
        loop {
            out.push((b'a' + (v % 26) as u8) as char);
            v /= 26;
            if v == 0 {
                return out;
            }
        }
    };
    format!("{}{}", letters(n), letters(n * 7 + 3))
}

/// Short text per post (under the 80 characters near-duplicate matching needs); kinds rotate
/// demand, supply, other.
fn text(group: usize, index: usize) -> String {
    const AREAS: [&str; 6] = [
        "Cầu Giấy",
        "Đống Đa",
        "Tây Hồ",
        "Hà Đông",
        "Thủ Đức",
        "Bình Thạnh",
    ];
    const EXTRAS: [&str; 5] = [
        "gần metro",
        "full nội thất",
        "có ban công",
        "yên tĩnh",
        "gần trường",
    ];
    let area = AREAS[(group + index) % AREAS.len()];
    let extra = EXTRAS[(group * 2 + index) % EXTRAS.len()];
    let code = code(group, index);
    let phone = format!("09{:08}", group * 1000 + index);
    match index % 3 {
        0 => format!(
            "Cần thuê căn hộ {extra} khu {area} mã {code} giá {} triệu LH {phone}",
            8 + index
        ),
        1 => format!(
            "Chính chủ cho thuê căn hộ {extra} {area} mã {code} {} triệu LH {phone}",
            9 + index
        ),
        _ => format!(
            "Bán xe máy cũ {extra} mã {code} giá {} triệu LH {phone}",
            12 + index
        ),
    }
}

fn raw(group: usize, index: usize, published: i64, captured: i64) -> RawPost {
    let gid = format!("sim_g{group}");
    RawPost {
        platform: "facebook".into(),
        source_external_id: gid.clone(),
        post_id: format!("p{group}_{index}"),
        permalink: format!("https://www.facebook.com/groups/{gid}/posts/p{group}_{index}"),
        author: AuthorInfo {
            name: format!("Người {group}-{index}"),
            external_id: Some(format!("u{group}_{index}")),
            is_anonymous: false,
        },
        text: text(group, index),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(published),
        captured_at: captured,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    }
}

struct Sim {
    service: CoreService,
    tg: MockTelegram,
    ai_down: Arc<AtomicBool>,
    source_ids: Vec<String>,
    radar_ids: Vec<String>,
    _tmp: tempfile::TempDir,
}

async fn start(config: &Config) -> Sim {
    let tmp = tempfile::tempdir().unwrap();
    let tg = MockTelegram::start().await;
    let ai_down = Arc::new(AtomicBool::new(false));
    let gate = Arc::clone(&ai_down);
    let provider = MockAiProvider::with_handler(move |req| {
        if gate.load(Ordering::SeqCst) {
            Err(AiError::RateLimited {
                retry_after: Some(Duration::from_secs(1)),
            })
        } else {
            MockAiProvider::heuristic_complete(req)
        }
    });
    let signer = LicenseSigner::generate_for_test();
    let service = CoreServiceBuilder::new(Store::open_in_memory().unwrap())
        .with_license_verifier(signer.verifier())
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(provider))
        .with_telegram_client(
            TelegramClient::with_config(TelegramClientConfig {
                api_base_url: tg.base_url.clone(),
                request_timeout: Duration::from_secs(5),
                enforce_rate_limits: false,
            })
            .unwrap(),
        )
        .start()
        .unwrap();

    // Three radars need the Pro plan (Personal allows two active radars).
    let token = signer
        .sign(&LicensePayload {
            plan: PlanTier::Pro,
            licensee: "soak".into(),
            issued_at: now_ms() - MIN,
            expires_at: Some(now_ms() + 30 * 86_400_000),
        })
        .unwrap();
    service.license_set(&token).unwrap();
    service
        .telegram_set_token("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi")
        .await
        .unwrap();
    service.tick_workers_now().await.unwrap();
    assert_eq!(
        service.channel_list().unwrap().len(),
        1,
        "Telegram channel from /start"
    );
    tg.sent.lock().unwrap().clear();

    let now = now_ms();
    let sources: Vec<DiscoveredSourceInput> = (0..config.groups)
        .map(|g| DiscoveredSourceInput {
            platform: "facebook".into(),
            kind: "group".into(),
            external_id: format!("sim_g{g}"),
            name: format!("Nhóm mô phỏng {g}"),
            url: format!("https://www.facebook.com/groups/sim_g{g}"),
            privacy: Some("public".into()),
            member_count: None,
        })
        .collect();
    service
        .store()
        .upsert_discovered_sources(&sources, Some(true), None, now)
        .unwrap();
    let source_ids: Vec<String> = service
        .source_list()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();

    let mut radar_ids = Vec::new();
    for (name, intent) in [
        ("Thuê căn hộ", WantIntent::Demand),
        ("Mua căn hộ", WantIntent::Demand),
        ("Cho thuê", WantIntent::Supply),
    ] {
        let detail = service
            .radar_create_draft(radar(name, intent, &source_ids))
            .unwrap();
        service
            .radar_set_status(&detail.radar.id, RadarStatus::Active)
            .await
            .unwrap();
        radar_ids.push(detail.radar.id);
    }
    // Only the first radar has rules (the BĐS seed set), as after a compile or a template.
    let first = service.radar_get(&radar_ids[0]).unwrap();
    service
        .store()
        .insert_ruleset(&NewRulesetInput {
            id: None,
            radar_version_id: first.current_version_data.id.clone(),
            state: "active".into(),
            origin: "seed".into(),
            body: serde_json::to_value(dealsonar_rules::seed_ruleset("bds-vi-v1").unwrap())
                .unwrap(),
            metrics: None,
            now_ms: now,
        })
        .unwrap();

    Sim {
        service,
        tg,
        ai_down,
        source_ids,
        radar_ids,
        _tmp: tmp,
    }
}

impl Sim {
    fn ingest(&self, posts: &[RawPost]) {
        for post in posts {
            let source = self
                .service
                .store()
                .source_get(&self.source_ids[self.source_index(&post.source_external_id)])
                .unwrap()
                .unwrap();
            dealsonar_core::pipeline::ingest_raw_post(
                self.service.runtime(),
                &source,
                post,
                post.captured_at,
            )
            .unwrap();
        }
    }

    fn source_index(&self, external: &str) -> usize {
        let wanted = external
            .trim_start_matches("sim_g")
            .parse::<usize>()
            .unwrap();
        self.service
            .source_list()
            .unwrap()
            .iter()
            .position(|s| s.external_id == format!("sim_g{wanted}"))
            .unwrap()
    }

    async fn drain(&self) {
        for _ in 0..40 {
            self.service.tick_workers_now().await.unwrap();
            let c = self.service.store().table_row_counts().unwrap();
            let open = self
                .service
                .store()
                .soak_report(&SoakOptions::new(now_ms()))
                .unwrap();
            if open.evaluation.pending_ai_now == 0
                && c["jobs"] == 0
                && open.notifications.messages_still_pending == 0
            {
                break;
            }
        }
    }

    fn report(&self, label: &str, interruptions: Vec<Interruption>) -> SoakReport {
        let mut opts = SoakOptions::new(now_ms());
        opts.label = Some(label.into());
        opts.interruptions = interruptions;
        self.service.store().soak_report(&opts).unwrap()
    }
}

async fn run_quiet(config: &Config) -> (Sim, SoakReport) {
    let sim = start(config).await;
    let now = now_ms();
    let mut posts = Vec::new();
    for g in 0..config.groups {
        for i in 0..config.posts_per_group {
            posts.push(raw(g, i, now - 2 * MIN, now - MIN));
        }
    }
    sim.ingest(&posts);
    sim.drain().await;
    let report = sim.report(config.label, vec![]);
    (sim, report)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn volume_pairs_ai_and_messages_match_the_pipeline_for_all_three_configurations() {
    for config in &CONFIGS {
        let (sim, report) = run_quiet(config).await;
        let posts = (config.groups * config.posts_per_group) as i64;
        let radars = sim.radar_ids.len() as i64;

        assert_eq!(report.collection.posts_captured, posts, "{}", config.label);
        assert_eq!(report.collection.unique_posts, posts, "{}", config.label);
        assert_eq!(report.collection.sources_followed, config.groups as i64);
        // Every captured post is judged by every subscribed radar.
        assert_eq!(
            report.evaluation.pairs_evaluated,
            posts * radars,
            "{}",
            config.label
        );
        assert_eq!(
            report.evaluation.possibly_missed_pairs, 0,
            "{}",
            config.label
        );
        assert_eq!(
            (
                report.evaluation.pending_ai_now,
                report.evaluation.ai_failed_now
            ),
            (0, 0)
        );

        // The rules-bearing radar sends fewer pairs to AI than the two without rules.
        let load = |name: &str| {
            report
                .evaluation
                .per_radar
                .iter()
                .find(|r| r.radar_name == name)
                .unwrap()
                .clone()
        };
        assert!(
            load("Thuê căn hộ").pairs_needing_ai < load("Mua căn hộ").pairs_needing_ai,
            "{}",
            config.label
        );
        assert!(report.ai.calls > 0 && report.ai.quota_hits == 0);
        assert_eq!(report.rules.radars_with_rules, 1);
        assert_eq!(report.rules.radars_without_rules, 2);

        // Counts equal the independent view from the lead list and the Telegram server.
        let leads = sim
            .service
            .lead_list(LeadFilterQuery {
                limit: Some(5000),
                ..Default::default()
            })
            .unwrap()
            .items;
        let sent = sim.tg.sent.lock().unwrap().len() as i64;
        assert_eq!(
            report.notifications.leads_created,
            leads.len() as i64,
            "{}",
            config.label
        );
        assert_eq!(report.notifications.messages_sent, sent, "{}", config.label);
        assert_eq!(report.notifications.duplicates.leads_sent_more_than_once, 0);
        // Posts that match two radars are announced once per radar on the same channel.
        let mut per_post: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for l in leads.iter().filter(|l| l.notified_at.is_some()) {
            per_post
                .entry(l.post_id.as_str())
                .or_default()
                .insert(l.radar_id.as_str());
        }
        let multi = per_post.values().filter(|r| r.len() > 1).count() as i64;
        assert_eq!(
            report
                .notifications
                .duplicates
                .posts_sent_for_multiple_radars,
            multi,
            "{}",
            config.label
        );
        assert_eq!(
            report.latency.notified_leads,
            report.notifications.leads_notified
        );
        assert_eq!(report.latency.median_within_target, Some(true));
        eprintln!("--- {} ---\n{}", config.label, summary_line(&report));
        sim.service.shutdown().await.unwrap();
    }
}

fn summary_line(r: &SoakReport) -> String {
    format!(
        "posts={} unique={} pairs={} pairs_ai={} unique_ai_share={:.0}% ai_calls={} ai_items={} leads={} msgs={} multi_radar_posts={}",
        r.collection.posts_captured,
        r.collection.unique_posts,
        r.evaluation.pairs_evaluated,
        r.evaluation.pairs_needing_ai,
        r.evaluation.ai_share_of_unique_posts.unwrap_or(0.0) * 100.0,
        r.ai.calls,
        r.ai.items,
        r.notifications.leads_created,
        r.notifications.messages_sent,
        r.notifications.duplicates.posts_sent_for_multiple_radars
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outages_are_visible_in_the_report_and_work_catches_up_after_recovery() {
    let config = &CONFIGS[1];
    let sim = start(config).await;
    let batch = |from: usize, to: usize, published: i64, captured: i64| -> Vec<RawPost> {
        (0..config.groups)
            .flat_map(|g| (from..to).map(move |i| raw(g, i, published, captured)))
            .collect()
    };
    let t = now_ms();

    // 1. Machine asleep: the posts were published 45 minutes ago and are captured only on wake.
    let sleep = Interruption {
        kind: "machine_sleep".into(),
        start_ms: t - 50 * MIN,
        end_ms: t - 5 * MIN,
        note: None,
    };
    sim.ingest(&batch(0, 1, t - 45 * MIN, t - 4 * MIN));
    sim.drain().await;

    // 2. AI quota exhausted: scoring fails, posts wait, and the backoff (1s here, 60s by
    //    default) holds back the next attempt.
    let quota_start = now_ms();
    sim.ai_down.store(true, Ordering::SeqCst);
    sim.ingest(&batch(1, 2, now_ms() - MIN, now_ms()));
    sim.service.tick_workers_now().await.unwrap();
    let during = sim.report("during quota outage", vec![]);
    assert!(during.ai.quota_hits > 0, "quota failures are recorded");
    assert!(during.evaluation.pending_ai_now > 0, "posts wait for AI");
    sim.ai_down.store(false, Ordering::SeqCst);
    let quota_end = now_ms();

    // Recovery is not instant: the failed batch job is retried on its own schedule (1, 5, then
    // 15 minutes), so the waiting pairs stay queued even though the AI answers again.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    sim.drain().await;
    assert!(
        sim.report("still waiting", vec![])
            .evaluation
            .pending_ai_now
            > 0,
        "pairs wait for the job backoff, not only for the provider"
    );
    // Skip the clock past that backoff, as the minutes it takes on a real machine.
    let mut skipped = Vec::new();
    while let Some(job) = sim
        .service
        .store()
        .claim_due_job(now_ms() + 20 * MIN)
        .unwrap()
    {
        skipped.push(job.id);
    }
    assert!(
        !skipped.is_empty(),
        "retries were queued behind the backoff"
    );
    for id in skipped {
        sim.service
            .store()
            .fail_or_retry_job(&id, "test: clock skipped past backoff", Some(now_ms()))
            .unwrap();
    }
    sim.drain().await;
    let recovered = sim.report("after quota recovery", vec![]);
    assert_eq!(
        recovered.evaluation.pending_ai_now, 0,
        "AI backlog clears once the retry runs"
    );
    assert_eq!(recovered.evaluation.ai_failed_now, 0);

    // 3. Notification channel down: messages fail and are retried later.
    let channel_start = now_ms();
    sim.tg.down.store(true, Ordering::SeqCst);
    // Index 3 is a demand post (every third post is unrelated chatter and creates no lead).
    sim.ingest(&batch(3, 4, now_ms() - MIN, now_ms()));
    sim.drain().await;
    let failing = sim.report("channel down", vec![]);
    assert!(
        failing.notifications.messages_retried > 0,
        "failed sends are retried, not dropped silently"
    );
    assert!(
        failing.notifications.messages_still_pending > 0,
        "failed sends wait in the outbox"
    );
    sim.tg.down.store(false, Ordering::SeqCst);
    let channel_end = now_ms();
    for _ in 0..40 {
        sim.service.tick_workers_now().await.unwrap();
        if sim
            .report("poll", vec![])
            .notifications
            .messages_still_pending
            == 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let after = sim.report(
        "sau phục hồi",
        vec![
            sleep,
            Interruption {
                kind: "ai_quota".into(),
                start_ms: quota_start,
                end_ms: quota_end,
                note: None,
            },
            Interruption {
                kind: "channel_error".into(),
                start_ms: channel_start,
                end_ms: channel_end,
                note: None,
            },
        ],
    );
    let markdown = render_markdown(&after);
    for section in [
        "machine_sleep",
        "ai_quota",
        "channel_error",
        "Đối soát sau gián đoạn",
    ] {
        assert!(markdown.contains(section), "{section}");
    }

    // Machine sleep: late capture is reported, and the lag shows in the latency tail.
    let s = &after.interruptions[0];
    assert_eq!(s.posts_published_during, config.groups as i64);
    assert_eq!(s.posts_published_during_captured_late, config.groups as i64);
    assert!(s.late_capture_lag.min.unwrap() >= 40 * MIN);
    assert!(after.collection.capture_lag.max.unwrap() >= 40 * MIN);
    assert!(
        after.latency.slow_count >= 1,
        "late-captured posts are slow notifications"
    );

    // AI quota: the failure is recorded and the evaluations created then were scored later.
    let q = &after.interruptions[1];
    assert!(q.ai_calls_during.get("rate_limited").copied().unwrap_or(0) > 0);
    assert!(q.first_ok_ai_call_at_ms.is_some() && q.ai_recovery_ms.is_some());
    assert!(
        q.evaluation_delay.max.unwrap_or(0) >= 1_000,
        "pairs waited out the backoff"
    );
    assert_eq!(q.evaluations_unresolved_now, 0);

    // Channel error: messages needed retries and were delivered after the channel came back.
    let c = &after.interruptions[2];
    assert!(c.messages_retried > 0);
    assert!(
        c.leads_notified_after_end > 0,
        "leads created during the outage were sent afterwards"
    );
    assert_eq!(c.leads_never_notified, 0);

    // Reconciliation: nothing is left waiting, nothing is sent twice, nothing is lost.
    assert_eq!(after.evaluation.possibly_missed_pairs, 0);
    assert_eq!(after.notifications.duplicates.leads_sent_more_than_once, 0);
    assert_eq!(
        (
            after.evaluation.pending_ai_now,
            after.evaluation.ai_failed_now
        ),
        (0, 0)
    );
    assert_eq!(
        after.notifications.messages_still_pending, 0,
        "outbox drains after recovery"
    );
    assert_eq!(after.notifications.messages_failed_or_dropped, 0);
    assert_eq!(
        after.notifications.messages_sent as usize,
        sim.tg.sent.lock().unwrap().len(),
        "every delivered message is accounted for"
    );
    sim.service.shutdown().await.unwrap();
}
