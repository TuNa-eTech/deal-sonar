//! Soak report metrics, checked against a hand-built database with known timestamps.

use dealsonar_store::soak::{
    build_soak_report, render_markdown, Distribution, Interruption, SoakOptions,
};
use dealsonar_store::Store;
use rusqlite::{params, Connection};
use tempfile::TempDir;

const T0: i64 = 1_800_000_000_000;
const MIN: i64 = 60_000;

fn at(minutes: i64) -> i64 {
    T0 + minutes * MIN
}

struct Fixture {
    _tmp: TempDir,
    conn: Connection,
}

fn exec(conn: &Connection, sql: &str, p: impl rusqlite::Params) {
    conn.execute(sql, p)
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

fn post(
    conn: &Connection,
    id: &str,
    source: &str,
    created: i64,
    captured: i64,
    cluster: Option<&str>,
) {
    exec(
        conn,
        "INSERT INTO posts (id, platform, external_id, source_id, permalink, content_hash, simhash,
                            created_at, captured_at, strategy, dup_cluster_id, is_cluster_head)
         VALUES (?1, 'facebook', ?1, ?2, 'https://example.invalid/p', ?1, 0, ?3, ?4, 'network', ?5, ?6)",
        params![id, source, at(created), at(captured), cluster, cluster.is_none()],
    );
}

#[allow(clippy::too_many_arguments)]
fn eval(
    conn: &Connection,
    id: &str,
    post: &str,
    version: &str,
    state: &str,
    decided_by: Option<&str>,
    created: i64,
    decided: Option<i64>,
    ai_call: Option<&str>,
) {
    exec(
        conn,
        "INSERT INTO evaluations (id, post_id, radar_version_id, state, decided_by, ai_call_id,
                                  is_preview, created_at, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
        params![
            id,
            post,
            version,
            state,
            decided_by,
            ai_call,
            at(created),
            decided.map(at)
        ],
    );
}

fn ai_call(conn: &Connection, id: &str, version: &str, status: &str, items: i64, minute: i64) {
    exec(
        conn,
        "INSERT INTO ai_calls (id, provider, task, radar_version_id, item_count, input_tokens,
                               output_tokens, duration_ms, status, created_at)
         VALUES (?1, 'claude_cli', 'judge_extract', ?2, ?3, 1000, 200, 4000, ?4, ?5)",
        params![id, version, items, status, at(minute)],
    );
}

#[allow(clippy::too_many_arguments)]
fn lead(
    conn: &Connection,
    id: &str,
    radar: &str,
    version: &str,
    post: &str,
    eval: &str,
    created: i64,
    notified: Option<i64>,
) {
    exec(
        conn,
        "INSERT INTO leads (id, radar_id, radar_version_id, post_id, evaluation_id, score, summary,
                            fields, notified_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0.9, 's', '{}', ?6, ?7, ?7)",
        params![
            id,
            radar,
            version,
            post,
            eval,
            notified.map(at),
            at(created)
        ],
    );
}

fn outbox(
    conn: &Connection,
    id: &str,
    lead: &str,
    state: &str,
    attempts: i64,
    created: i64,
    sent: Option<i64>,
) {
    exec(
        conn,
        "INSERT INTO outbox (id, channel_id, lead_id, kind, payload, state, attempts, next_try_at,
                             sent_at, created_at)
         VALUES (?1, 'ch1', ?2, 'telegram', '{}', ?3, ?4, 0, ?5, ?6)",
        params![id, lead, state, attempts, sent.map(at), at(created)],
    );
}

/// Two radars on one group, one of them with rules; an AI quota gap, a late capture after a
/// sleep, a retried and a duplicated message.
fn fixture() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("soak.db");
    drop(Store::open(&db, tmp.path().join("backups")).unwrap());
    let conn = Connection::open(&db).unwrap();

    for (id, name) in [("s1", "Nhóm A"), ("s2", "Nhóm B")] {
        exec(&conn, "INSERT INTO sources (id, external_id, name, url, followed, created_at) VALUES (?1, ?1, ?2, 'u', 1, ?3)", params![id, name, at(-1000)]);
    }
    exec(&conn, "INSERT INTO channels (id, kind, name, config, created_at) VALUES ('ch1', 'telegram', 'Telegram', '{}', 0)", []);
    for (rid, name, vid) in [("rA", "Thuê nhà", "vA"), ("rB", "Mua nhà", "vB")] {
        exec(&conn, "INSERT INTO radars (id, name, status, current_version, notify, created_at, updated_at) VALUES (?1, ?2, 'active', 1, '{}', ?3, ?3)", params![rid, name, at(-500)]);
        exec(&conn, "INSERT INTO radar_versions (id, radar_id, version, description, fields, match_policy, created_at) VALUES (?1, ?2, 1, 'd', '[]', '{}', 0)", params![vid, rid]);
    }
    exec(&conn, "INSERT INTO radar_sources (radar_id, source_id) VALUES ('rA', 's1'), ('rB', 's1'), ('rB', 's2')", []);
    exec(&conn, "INSERT INTO rulesets (id, radar_version_id, revision, state, origin, body, created_at, activated_at) VALUES ('rsA', 'vA', 1, 'active', 'compiled', '{}', 0, ?1)", params![at(5)]);

    exec(&conn, "INSERT INTO dup_clusters (id, head_post_id, size, source_count, first_seen_at, last_seen_at) VALUES ('c1', 'p1', 2, 2, 0, 0)", []);
    post(&conn, "p1", "s1", 0, 2, Some("c1"));
    exec(
        &conn,
        "UPDATE posts SET is_cluster_head = 1 WHERE id = 'p1'",
        [],
    );
    post(&conn, "p2", "s2", 1, 3, Some("c1")); // repost of p1, not a unique post
    post(&conn, "p3", "s1", 10, 11, None);
    post(&conn, "p4", "s1", 70, 125, None); // published while the machine slept
    post(&conn, "p5", "s1", 130, 131, None);
    post(&conn, "p6", "s1", 140, 141, None); // never evaluated

    ai_call(&conn, "c1", "vB", "ok", 2, 4);
    ai_call(&conn, "c2", "vB", "ok", 1, 12);
    ai_call(&conn, "c3", "vB", "rate_limited", 2, 126);
    ai_call(&conn, "c4", "vB", "ok", 2, 185);

    eval(
        &conn,
        "e1",
        "p1",
        "vA",
        "done",
        Some("rule"),
        2,
        Some(2),
        None,
    );
    eval(
        &conn,
        "e2",
        "p1",
        "vB",
        "done",
        Some("ai"),
        2,
        Some(4),
        Some("c1"),
    );
    eval(
        &conn,
        "e3",
        "p3",
        "vA",
        "done",
        Some("prefilter"),
        11,
        Some(11),
        None,
    );
    eval(
        &conn,
        "e4",
        "p3",
        "vB",
        "done",
        Some("ai"),
        11,
        Some(12),
        Some("c2"),
    );
    eval(&conn, "e5", "p4", "vA", "pending_ai", None, 125, None, None);
    eval(
        &conn,
        "e6",
        "p4",
        "vB",
        "ai_failed",
        None,
        125,
        Some(127),
        None,
    );
    eval(
        &conn,
        "e7",
        "p5",
        "vA",
        "done",
        Some("rule"),
        131,
        Some(131),
        None,
    );
    eval(
        &conn,
        "e8",
        "p5",
        "vB",
        "done",
        Some("rule"),
        131,
        Some(131),
        None,
    );

    lead(&conn, "L1", "rA", "vA", "p1", "e1", 2, Some(3));
    lead(&conn, "L2", "rB", "vB", "p1", "e2", 4, Some(4));
    lead(&conn, "L3", "rB", "vB", "p3", "e4", 12, Some(25));
    lead(&conn, "L4", "rA", "vA", "p5", "e7", 131, Some(160));
    lead(&conn, "L5", "rB", "vB", "p5", "e8", 131, None);
    outbox(&conn, "o1", "L1", "sent", 1, 2, Some(3));
    outbox(&conn, "o2", "L2", "sent", 1, 4, Some(4));
    outbox(&conn, "o3", "L3", "sent", 1, 12, Some(25));
    outbox(&conn, "o4", "L4", "sent", 3, 131, Some(160));
    outbox(&conn, "o5", "L4", "sent", 1, 131, Some(161)); // the same lead sent again
    outbox(&conn, "o6", "L5", "failed", 5, 131, None);

    Fixture { _tmp: tmp, conn }
}

fn options() -> SoakOptions {
    let mut opts = SoakOptions::new(at(200));
    opts.label = Some("fixture".into());
    opts.from_ms = Some(at(0));
    opts.until_ms = Some(at(200));
    opts.interruptions = vec![
        Interruption {
            kind: "machine_sleep".into(),
            start_ms: at(60),
            end_ms: at(120),
            note: Some("lid closed".into()),
        },
        Interruption {
            kind: "ai_quota".into(),
            start_ms: at(124),
            end_ms: at(180),
            note: None,
        },
    ];
    opts
}

#[test]
fn volume_pairs_and_ai_load_are_counted_from_the_database() {
    let f = fixture();
    let report = build_soak_report(&f.conn, &options()).unwrap();

    let c = &report.collection;
    assert_eq!(
        (c.posts_captured, c.unique_posts, c.duplicate_posts),
        (6, 5, 1)
    );
    assert_eq!(c.sources_followed, 2);
    let a = c.per_source.iter().find(|s| s.source_id == "s1").unwrap();
    assert_eq!((a.posts, a.unique_posts), (5, 5));
    // Capture lag: 2, 2, 1, 55, 1, 1 minutes (p2 is 2, p1 is 2).
    assert_eq!(c.capture_lag.count, 6);
    assert_eq!(c.capture_lag.max, Some(55 * MIN));

    let e = &report.evaluation;
    assert_eq!(e.pairs_evaluated, 8);
    assert_eq!(e.by_decided_by["ai"], 2);
    assert_eq!(e.by_decided_by["rule"], 3);
    assert_eq!(e.by_decided_by["chưa quyết định"], 2);
    assert_eq!(e.pairs_needing_ai, 4); // p1/rB, p3/rB, p4/rA pending, p4/rB failed
    assert_eq!(e.unique_posts_needing_ai, 3); // p1, p3, p4
    assert_eq!(e.ai_share_of_unique_posts, Some(3.0 / 5.0));
    assert_eq!((e.pending_ai_now, e.ai_failed_now), (1, 1));
    let rb = e.per_radar.iter().find(|r| r.radar_id == "rB").unwrap();
    assert_eq!((rb.pairs_evaluated, rb.pairs_needing_ai), (4, 3));
    assert_eq!(e.per_day.len(), 1);
    assert_eq!(e.per_day[0].pairs_evaluated, 8);

    // p6 was captured but neither active radar evaluated it.
    assert_eq!(e.possibly_missed_pairs, 2);
    assert!(e.possibly_missed_sample.iter().all(|m| m.post_id == "p6"));

    let ai = &report.ai;
    assert_eq!(ai.calls, 4);
    assert_eq!((ai.by_status["ok"], ai.by_status["rate_limited"]), (3, 1));
    assert_eq!(ai.quota_hits, 1);
    assert_eq!(ai.items, 7);
    assert_eq!((ai.input_tokens, ai.output_tokens), (4000, 800));
    assert_eq!(ai.per_radar.len(), 1);
    assert_eq!(ai.per_radar[0].radar_name, "Mua nhà");
    assert_eq!(ai.per_radar[0].share_of_items, 1.0);
}

#[test]
fn ai_share_after_rules_counts_only_radars_with_rules() {
    let f = fixture();
    let report = build_soak_report(&f.conn, &options()).unwrap();
    let rules = &report.rules;
    assert_eq!(
        (rules.radars_with_rules, rules.radars_without_rules),
        (1, 1)
    );
    assert_eq!(rules.rules_active_from_ms, Some(at(5)));
    // Unique posts captured since then: p3, p4, p5, p6. Only p4 still needs AI for rA.
    assert_eq!(rules.unique_posts_captured, 4);
    assert_eq!(rules.unique_posts_needing_ai, 1);
    assert_eq!(rules.ai_share_of_unique_posts, Some(0.25));
    assert_eq!(rules.meets_target, Some(false));
    assert!(report
        .warnings
        .iter()
        .any(|w| w.contains("chưa có bộ luật")));

    // Rules can be declared active from the start of the run instead.
    let mut opts = options();
    opts.rules_active_from_ms = Some(at(0));
    let all = build_soak_report(&f.conn, &opts).unwrap();
    assert_eq!(all.rules.radars_without_rules, 0);
    assert_eq!(all.rules.unique_posts_captured, 5);
    assert_eq!(all.rules.unique_posts_needing_ai, 3);
}

#[test]
fn notification_counts_duplicates_and_latency() {
    let f = fixture();
    let report = build_soak_report(&f.conn, &options()).unwrap();

    let n = &report.notifications;
    assert_eq!(
        (n.leads_created, n.leads_notified, n.leads_not_notified),
        (5, 4, 1)
    );
    assert_eq!(n.messages_sent, 5);
    assert_eq!(n.messages_failed_or_dropped, 1);
    assert_eq!(n.messages_retried, 2); // o4 needed 3 attempts, o6 gave up after 5
    assert_eq!(n.outbox_by_kind["telegram"], 6);
    assert_eq!(n.duplicates.leads_sent_more_than_once, 1);
    assert_eq!(n.duplicates.extra_messages, 1);
    // p1 reached the same channel for both radars; p5's second message is a retry duplicate of L4.
    assert_eq!(n.duplicates.posts_sent_for_multiple_radars, 1);
    assert_eq!(n.duplicates.extra_messages_across_radars, 1);
    let ra = n.per_radar.iter().find(|r| r.radar_id == "rA").unwrap();
    assert_eq!((ra.leads, ra.notified, ra.messages_sent), (2, 2, 3));

    // Post time -> first delivery: 3, 4, 15 and 30 minutes.
    let l = &report.latency;
    assert_eq!(l.notified_leads, 4);
    assert_eq!(l.total.p50, Some(570_000));
    assert_eq!(l.total.max, Some(30 * MIN));
    assert_eq!(l.total.p90, Some(30 * MIN));
    assert_eq!(l.median_within_target, Some(true));
    assert_eq!(l.slow_count, 2);
    assert_eq!(l.slowest[0].lead_id, "L4");
    assert_eq!(l.slowest[0].capture_ms, MIN);
    assert_eq!(l.slowest[0].processing_ms, 29 * MIN);

    // A stricter slow threshold is applied to the list but not to the median target.
    let mut strict = options();
    strict.slow_after_ms = 3 * MIN;
    assert_eq!(
        build_soak_report(&f.conn, &strict)
            .unwrap()
            .latency
            .slow_count,
        3
    );
}

#[test]
fn interruptions_are_reconciled() {
    let f = fixture();
    let report = build_soak_report(&f.conn, &options()).unwrap();
    assert_eq!(report.interruptions.len(), 2);

    let sleep = &report.interruptions[0];
    assert_eq!(sleep.kind, "machine_sleep");
    assert_eq!(sleep.duration_ms, 60 * MIN);
    assert_eq!(sleep.posts_published_during, 1); // p4
    assert_eq!(sleep.posts_published_during_captured_late, 1);
    assert_eq!(sleep.late_capture_lag.max, Some(55 * MIN));
    assert_eq!(sleep.posts_captured_during, 0);
    assert!(sleep
        .findings
        .iter()
        .any(|f| f.contains("chỉ được thu sau khi phục hồi")));

    let quota = &report.interruptions[1];
    assert_eq!(quota.kind, "ai_quota");
    assert_eq!(quota.backlog_at_start, 0);
    assert_eq!(quota.backlog_at_end, 1); // p4/rA is still waiting for AI
    assert_eq!(quota.backlog_cleared_at_ms, None);
    assert_eq!(quota.evaluations_created_during, 4);
    assert_eq!(quota.evaluations_unresolved_now, 2); // pending p4/rA and failed p4/rB
    assert_eq!(quota.ai_calls_during["rate_limited"], 1);
    assert_eq!(quota.first_ok_ai_call_at_ms, Some(at(185)));
    assert_eq!(quota.ai_recovery_ms, Some(5 * MIN));
    assert_eq!(quota.leads_created_during, 2); // L4, L5
    assert_eq!(quota.leads_notified_after_end, 0);
    assert_eq!(quota.leads_never_notified, 1); // L5
    assert_eq!(quota.messages_failed_or_dropped, 1);
    assert_eq!(quota.messages_retried, 2);
    assert_eq!(quota.leads_sent_more_than_once, 1);
    assert!(quota
        .findings
        .iter()
        .any(|f| f.contains("vẫn chưa xử lý hết")));
    assert!(quota.findings.iter().any(|f| f.contains("gửi trùng")));
}

#[test]
fn a_cleared_backlog_reports_how_long_recovery_took() {
    let f = fixture();
    // The AI recovers: the waiting evaluation is decided 30 minutes after the interruption.
    exec(
        &f.conn,
        "UPDATE evaluations SET state = 'done', decided_by = 'ai', decided_at = ?1 WHERE id = 'e5'",
        params![at(150)],
    );
    let mut opts = options();
    opts.interruptions = vec![Interruption {
        kind: "ai_quota".into(),
        start_ms: at(124),
        end_ms: at(130),
        note: None,
    }];
    let report = build_soak_report(&f.conn, &opts).unwrap();
    let quota = &report.interruptions[0];
    assert_eq!(quota.backlog_at_end, 1);
    assert_eq!(quota.backlog_cleared_at_ms, Some(at(150)));
    assert_eq!(quota.backlog_drain_ms, Some(20 * MIN));
    assert!(quota
        .findings
        .iter()
        .any(|f| f.contains("xử lý hết sau 20 phút")));
}

#[test]
fn report_serializes_renders_and_exposes_no_post_text() {
    let f = fixture();
    exec(
        &f.conn,
        "UPDATE posts SET text = 'SECRET-POST-BODY 0912345678'",
        [],
    );
    let report = build_soak_report(&f.conn, &options()).unwrap();
    let json = serde_json::to_string(&report).unwrap();
    let md = render_markdown(&report);
    for out in [&json, &md] {
        assert!(!out.contains("SECRET-POST-BODY") && !out.contains("0912345678"));
    }
    assert!(md.contains("# Báo cáo chạy dài ngày: fixture"));
    assert!(md.contains("Bài duy nhất cần AI / bài duy nhất đã thu | 1 / 4 = 25.0%"));
    assert!(md.contains("KHÔNG ĐẠT"));
    assert!(md.contains("Đối soát sau gián đoạn"));
    assert!(md.contains("| Mua nhà |"));
    let back: dealsonar_store::soak::SoakReport = serde_json::from_str(&json).unwrap();
    assert_eq!(back.notifications, report.notifications);
    assert_eq!(back.interruptions, report.interruptions);
    assert_eq!(
        back.evaluation.pairs_evaluated,
        report.evaluation.pairs_evaluated
    );
}

#[test]
fn empty_database_yields_a_report_with_warnings() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("empty.db");
    drop(Store::open(&db, tmp.path().join("backups")).unwrap());
    let conn = Connection::open(&db).unwrap();
    let report = build_soak_report(&conn, &SoakOptions::new(at(0))).unwrap();
    assert_eq!(report.collection.posts_captured, 0);
    assert_eq!(report.latency.median_within_target, None);
    assert_eq!(report.rules.meets_target, None);
    assert!(!report.warnings.is_empty());
    assert_eq!(Distribution::from_values(vec![]).count, 0);
    let one = Distribution::from_values(vec![5, 1, 9, 3]);
    assert_eq!((one.p50, one.p90, one.max), (Some(4), Some(9), Some(9)));
}

#[test]
fn command_line_tool_reads_a_database_read_only_and_writes_markdown_or_json() {
    let f = fixture();
    let db = f.conn.path().unwrap().to_string();
    let dir = f._tmp.path();
    let interruptions = dir.join("interruptions.json");
    std::fs::write(
        &interruptions,
        serde_json::to_string(&vec![Interruption {
            kind: "ai_quota".into(),
            start_ms: at(124),
            end_ms: at(180),
            note: Some("test".into()),
        }])
        .unwrap(),
    )
    .unwrap();
    let before = std::fs::metadata(&db).unwrap().modified().unwrap();
    let run = |extra: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_dealsonar-soak-report"))
            .args([
                "--db",
                &db,
                "--label",
                "cli",
                "--from-ms",
                &at(0).to_string(),
            ])
            .args([
                "--until-ms",
                &at(200).to_string(),
                "--now-ms",
                &at(200).to_string(),
            ])
            .args(["--interruptions", interruptions.to_str().unwrap()])
            .args(extra)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };

    let md = run(&[]);
    assert!(md.contains("# Báo cáo chạy dài ngày: cli"));
    assert!(md.contains("### ai_quota (56 phút) — test"));
    let report: dealsonar_store::soak::SoakReport =
        serde_json::from_str(&run(&["--format", "json"])).unwrap();
    assert_eq!(report.notifications.messages_sent, 5);
    assert_eq!(report.interruptions.len(), 1);

    let out_file = dir.join("report.md");
    run(&["--out", out_file.to_str().unwrap()]);
    assert!(std::fs::read_to_string(out_file)
        .unwrap()
        .contains("Bài thu"));
    assert_eq!(
        std::fs::metadata(&db).unwrap().modified().unwrap(),
        before,
        "database untouched"
    );

    let bad = std::process::Command::new(env!("CARGO_BIN_EXE_dealsonar-soak-report"))
        .args(["--db", "/nonexistent/x.db"])
        .output()
        .unwrap();
    assert!(!bad.status.success());
}
