use std::collections::BTreeMap;
use std::fs;

use dealsonar_store::ops::default_job_retry_delay_ms;
use dealsonar_store::{
    hamming_distance, simhash_bands, AuthorInput, CrawlRunInput, CreateLeadInput,
    CreateRadarDraftInput, DiscoveredSourceInput, EnqueueOutboxInput, EvaluationDoneInput,
    EvaluationUpsertInput, ExtractedField, FieldDef, FieldSource, FieldType, FilterOp, HardFilter,
    LabeledSampleOrigin, LeadFieldFilter, LeadListQuery, LeadSort, MatchPolicy, Migration, NewPost,
    NewRulesetInput, NotifyConfig, RecordAiCallInput, RecordFeedbackInput, SortDir, Store,
    StoreError, UpdateRadarInput, LATEST_SCHEMA_VERSION, MIGRATIONS,
};
use serde_json::json;
use tempfile::TempDir;

const BASE_TS: i64 = 1_794_384_000_000; // 2026-11-11T08:00:00Z
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

fn sample_bds_fields() -> Vec<FieldDef> {
    vec![
        FieldDef {
            key: "price".to_string(),
            label: "Giá thuê".to_string(),
            r#type: FieldType::Money,
            description: "Ngân sách thuê mỗi tháng".to_string(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 1,
        },
        FieldDef {
            key: "district".to_string(),
            label: "Khu vực".to_string(),
            r#type: FieldType::Location,
            description: "Quận/huyện tại Hà Nội".to_string(),
            required: true,
            options: None,
            show_in_alert: true,
            order: 2,
        },
        FieldDef {
            key: "area".to_string(),
            label: "Diện tích".to_string(),
            r#type: FieldType::Range,
            description: "Diện tích m2".to_string(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 3,
        },
        FieldDef {
            key: "deal_type".to_string(),
            label: "Loại giao dịch".to_string(),
            r#type: FieldType::Enum,
            description: "Thuê hoặc mua".to_string(),
            required: true,
            options: Some(vec!["rent".to_string(), "buy".to_string()]),
            show_in_alert: true,
            order: 4,
        },
        FieldDef {
            key: "amenities".to_string(),
            label: "Tiện ích".to_string(),
            r#type: FieldType::MultiEnum,
            description: "Nội thất đi kèm".to_string(),
            required: false,
            options: Some(vec![
                "điều hoà".to_string(),
                "máy giặt".to_string(),
                "ban công".to_string(),
            ]),
            show_in_alert: false,
            order: 5,
        },
        FieldDef {
            key: "bedrooms".to_string(),
            label: "Phòng ngủ".to_string(),
            r#type: FieldType::Number,
            description: "Số phòng ngủ".to_string(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 6,
        },
        FieldDef {
            key: "is_owner".to_string(),
            label: "Chính chủ".to_string(),
            r#type: FieldType::Boolean,
            description: "Khách chính chủ".to_string(),
            required: false,
            options: None,
            show_in_alert: false,
            order: 7,
        },
        FieldDef {
            key: "move_in_date".to_string(),
            label: "Ngày vào ở".to_string(),
            r#type: FieldType::Date,
            description: "Ngày dự kiến chuyển vào".to_string(),
            required: false,
            options: None,
            show_in_alert: false,
            order: 8,
        },
        FieldDef {
            key: "phone".to_string(),
            label: "SĐT".to_string(),
            r#type: FieldType::Phone,
            description: "Số điện thoại liên hệ".to_string(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 9,
        },
        FieldDef {
            key: "notes_excerpt".to_string(),
            label: "Ghi chú thêm".to_string(),
            r#type: FieldType::Text,
            description: "Yêu cầu đặc biệt".to_string(),
            required: false,
            options: None,
            show_in_alert: false,
            order: 10,
        },
    ]
}

fn seed_source(store: &Store, ext_id: &str, name: &str, follow: bool) -> String {
    let res = store
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: ext_id.to_string(),
                name: name.to_string(),
                url: format!("https://www.facebook.com/groups/{ext_id}"),
                privacy: Some("private".to_string()),
                member_count: Some(45_000),
            }],
            Some(follow),
            Some("profile_chrome_1"),
            BASE_TS,
        )
        .expect("upsert source");
    res.source_ids[0].clone()
}

#[allow(clippy::too_many_arguments)]
fn make_post(
    source_id: &str,
    ext_id: &str,
    author_ext: &str,
    author_name: &str,
    text: &str,
    hash: &str,
    simhash: i64,
    captured_at: i64,
) -> NewPost {
    NewPost {
        id: None,
        platform: "facebook".to_string(),
        external_id: ext_id.to_string(),
        source_id: source_id.to_string(),
        author: Some(AuthorInput {
            external_id: Some(author_ext.to_string()),
            name: author_name.to_string(),
            is_anonymous: false,
        }),
        permalink: format!("https://www.facebook.com/groups/123/posts/{ext_id}/"),
        text: Some(text.to_string()),
        text_norm: Some(text.to_string()),
        text_fold: Some(dealsonar_store::fold_vi(text)),
        text_truncated: false,
        lang: Some("vi".to_string()),
        content_hash: hash.to_string(),
        simhash,
        attachments: None,
        counts: Some(json!({"comments": 2, "reactions": 5})),
        extracted_phones: Vec::new(),
        created_at: Some(captured_at - 60_000),
        captured_at,
        strategy: "network".to_string(),
    }
}

#[test]
fn test_migrations_wal_backups_and_future_schema_guard() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("dealsonar.db");
    let backup_dir = tmp.path().join("backups");

    // 1. Fresh file-backed open applies 0001_init in WAL mode without creating a pre-migration backup.
    let store = Store::open_with_migrations(&db_path, &backup_dir, &MIGRATIONS[..1])
        .expect("open v1 store");
    assert_eq!(store.journal_mode().expect("journal_mode"), "wal");
    let applied = store.list_schema_migrations().expect("migrations");
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].version, 1);
    assert_eq!(applied[0].name, "0001_init");
    assert!(!backup_dir.exists() || fs::read_dir(&backup_dir).unwrap().count() == 0);

    // Populate a setting so we can verify pre-migration backup content integrity.
    store.set_setting("ui.theme", &"dark").expect("set_setting");
    let counts = store.table_row_counts().expect("table_row_counts");
    assert_eq!(counts.get("settings"), Some(&1));
    assert_eq!(counts.get("schema_migrations"), Some(&1));
    drop(store);

    // 2. Simulate 7 subsequent migrations (v2..=v8) and verify automatic pre-migration backups
    //    are created AND pruned to keep only the latest 5!
    let mut extended: Vec<Migration> = MIGRATIONS[..1].to_vec();
    let extra_migrations = [
        (
            2,
            "0002_idx_a",
            "CREATE INDEX IF NOT EXISTS settings_k2 ON settings(key);",
        ),
        (3, "0003_idx_b", "DROP INDEX IF EXISTS settings_k2;"),
        (
            4,
            "0004_idx_c",
            "CREATE INDEX IF NOT EXISTS settings_k4 ON settings(key);",
        ),
        (5, "0005_idx_d", "DROP INDEX IF EXISTS settings_k4;"),
        (
            6,
            "0006_idx_e",
            "CREATE INDEX IF NOT EXISTS settings_k6 ON settings(key);",
        ),
        (7, "0007_idx_f", "DROP INDEX IF EXISTS settings_k6;"),
        (
            8,
            "0008_idx_g",
            "CREATE INDEX IF NOT EXISTS settings_k8 ON settings(key);",
        ),
    ];

    for (ver, name, sql) in extra_migrations {
        extended.push(Migration {
            version: ver,
            name,
            sql,
        });
        let upgraded =
            Store::open_with_migrations(&db_path, &backup_dir, &extended).expect("upgrade db");
        assert_eq!(
            upgraded
                .list_schema_migrations()
                .expect("migrations")
                .last()
                .unwrap()
                .version,
            ver
        );
        drop(upgraded);
    }

    let mut backup_files: Vec<String> = fs::read_dir(&backup_dir)
        .expect("read backup_dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("dealsonar-pre-v") && n.ends_with(".db"))
        .collect();
    backup_files.sort();

    // Must retain strictly the latest 5 backups (v0004, v0005, v0006, v0007, v0008)!
    assert_eq!(
        backup_files.len(),
        5,
        "expected 5 retained backups, got: {backup_files:?}"
    );
    assert!(backup_files
        .iter()
        .any(|n| n.starts_with("dealsonar-pre-v0004-")));
    assert!(backup_files
        .iter()
        .any(|n| n.starts_with("dealsonar-pre-v0008-")));
    assert!(!backup_files
        .iter()
        .any(|n| n.starts_with("dealsonar-pre-v0002-")));

    // Verify one of the backup files is a valid standalone SQLite DB preserving our setting.
    let v8_backup = backup_dir.join(
        backup_files
            .iter()
            .find(|n| n.starts_with("dealsonar-pre-v0008-"))
            .unwrap(),
    );
    let restored = Store::open_with_migrations(&v8_backup, tmp.path().join("bk2"), &extended[..7])
        .expect("open backup");
    let saved_theme: Option<String> = restored.get_setting("ui.theme").expect("read setting");
    assert_eq!(saved_theme.as_deref(), Some("dark"));
    drop(restored);

    // 3. Future schema guard: DB is now at v8, while canonical binary only knows v1!
    let err = Store::open(&db_path, &backup_dir).expect_err("must refuse newer schema");
    match err {
        StoreError::NewerSchemaVersion {
            db_version,
            app_version,
        } => {
            assert_eq!(db_version, 8);
            assert_eq!(app_version, LATEST_SCHEMA_VERSION);
        }
        other => panic!("expected NewerSchemaVersion, got {other:?}"),
    }
}

#[test]
fn test_sources_and_crawl_runs_repository() {
    let store = Store::open_in_memory().expect("open_in_memory");

    let s1 = seed_source(&store, "grp_cg", "Hội thuê nhà Cầu Giấy", true);
    let s2 = seed_source(&store, "grp_tx", "Hội chung cư Thanh Xuân", false);

    // Passive re-discovery (`follow = None`) MUST preserve `followed = true` on `s1`!
    let up = store
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_cg".to_string(),
                name: "Hội thuê nhà Cầu Giấy (Mới)".to_string(),
                url: "https://www.facebook.com/groups/grp_cg".to_string(),
                privacy: Some("public".to_string()),
                member_count: Some(50_000),
            }],
            None,
            Some("profile_chrome_2"),
            BASE_TS + 1_000,
        )
        .expect("re-discover");
    assert_eq!(up.inserted, 0);
    assert_eq!(up.updated, 1);

    let s1_rec = store.source_get(&s1).unwrap().unwrap();
    assert!(s1_rec.followed);
    assert_eq!(s1_rec.name, "Hội thuê nhà Cầu Giấy (Mới)");
    assert_eq!(s1_rec.profile_id.as_deref(), Some("profile_chrome_2"));
    assert_eq!(store.count_followed_sources().unwrap(), 1);

    store.source_follow(&s2).unwrap();
    store.source_set_priority(&s1, 1).unwrap();
    assert_eq!(store.count_followed_sources().unwrap(), 2);
    assert_eq!(store.list_active_followed_sources().unwrap().len(), 2);

    store.source_set_state(&s2, "inaccessible").unwrap();
    assert_eq!(store.list_active_followed_sources().unwrap().len(), 1);
    store.source_unfollow(&s2).unwrap();
    assert_eq!(store.count_followed_sources().unwrap(), 1);

    // Insert 2 posts in last 24h and 1 older post to test `source_list` counts.
    store
        .insert_post(&make_post(
            &s1,
            "p_old",
            "u1",
            "User 1",
            "Bài cũ tuần trước",
            "h_old",
            10,
            BASE_TS - 3 * DAY_MS,
        ))
        .unwrap();
    store
        .insert_post(&make_post(
            &s1,
            "p_new1",
            "u1",
            "User 1",
            "Bài mới hôm nay 1",
            "h_n1",
            11,
            BASE_TS - 2 * HOUR_MS,
        ))
        .unwrap();
    store
        .insert_post(&make_post(
            &s1,
            "p_new2",
            "u2",
            "User 2",
            "Bài mới hôm nay 2",
            "h_n2",
            12,
            BASE_TS - HOUR_MS,
        ))
        .unwrap();

    // Record two crawl runs in 24h: posts_new = 4 and posts_new = 8 -> avg_new_posts = 6.0!
    store
        .record_crawl_run(&CrawlRunInput {
            id: "run_1".to_string(),
            source_id: s1.clone(),
            reason: "scheduled".to_string(),
            status: "ok".to_string(),
            started_at: BASE_TS - 2 * HOUR_MS,
            ended_at: Some(BASE_TS - 2 * HOUR_MS + 15_000),
            posts_seen: 20,
            posts_new: 4,
            page_loads: 1,
            strategy: Some("network".to_string()),
            error: None,
        })
        .unwrap();
    store
        .record_crawl_run(&CrawlRunInput {
            id: "run_2".to_string(),
            source_id: s1.clone(),
            reason: "manual".to_string(),
            status: "ok".to_string(),
            started_at: BASE_TS - HOUR_MS,
            ended_at: Some(BASE_TS - HOUR_MS + 12_000),
            posts_seen: 25,
            posts_new: 8,
            page_loads: 2,
            strategy: Some("network".to_string()),
            error: None,
        })
        .unwrap();

    let listed = store.source_list(BASE_TS).unwrap();
    let s1_item = listed.iter().find(|i| i.source.id == s1).unwrap();
    assert_eq!(s1_item.stored_post_count, 3);
    assert_eq!(s1_item.posts_last_24h, 2);
    assert!((s1_item.source.avg_new_posts - 6.0).abs() < 1e-6);
    assert_eq!(
        s1_item.source.last_crawl_at,
        Some(BASE_TS - HOUR_MS + 12_000)
    );

    let runs = store.crawl_run_list(Some(&s1), 10).unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].id, "run_2");
}

#[test]
fn test_vietnamese_diacritic_insensitive_fts5_and_simhash_dedup() {
    let store = Store::open_in_memory().expect("open_in_memory");
    let s1 = seed_source(&store, "g1", "Group Cầu Giấy", true);
    let s2 = seed_source(&store, "g2", "Group Mỹ Đình", true);
    let s3 = seed_source(&store, "g3", "Group Đống Đa", true);

    let base_hash: u64 = 0xCAFE_BABE_1234_5678;
    let base_simhash = base_hash as i64;
    let bands = simhash_bands(base_simhash);
    assert_eq!(bands, [0x5678, 0x1234, 0xBABE, 0xCAFE]);

    // 1. Insert post & check idempotency
    let p1_in = make_post(
        &s1,
        "fb_1001",
        "auth_a",
        "Nguyễn Văn A",
        "Em cần thuê căn hộ 2 phòng ngủ khu Cầu Giấy, ban công thoáng, tầm 12-15tr/th. LH 0912.345.678",
        "sha256_exact_1",
        base_simhash,
        BASE_TS,
    );
    let (p1, is_new_1) = store.insert_post(&p1_in).unwrap();
    assert!(is_new_1);
    let (p1_again, is_new_again) = store.insert_post(&p1_in).unwrap();
    assert!(!is_new_again);
    assert_eq!(p1.id, p1_again.id);
    assert_eq!(p1.extracted_phones, vec!["+84912345678".to_string()]);

    let author = store
        .author_get(p1.author_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(author.post_count_7d, 1);
    assert_eq!(author.group_count_7d, 1);

    // 2. Vietnamese diacritic-insensitive FTS5 (`"cau giay"` matching `"Cầu Giấy"`)
    let hits_unaccented = store.post_search("cau giay", None, 10).unwrap();
    assert_eq!(hits_unaccented.len(), 1);
    assert_eq!(hits_unaccented[0].post.id, p1.id);

    let hits_accented = store.post_search("Cầu Giấy ban công", None, 10).unwrap();
    assert_eq!(hits_accented.len(), 1);

    // Malicious/punctuation FTS query must not syntax-error
    let hits_punct = store
        .post_search("\"cau-giay\" (2 phòng) & * : ^ ~", None, 10)
        .unwrap();
    assert_eq!(hits_punct.len(), 1);

    // 3. Exact & 4-band SimHash near-duplicate lookup
    let exact = store
        .find_exact_dup("sha256_exact_1", BASE_TS - 14 * DAY_MS)
        .unwrap();
    assert_eq!(exact.unwrap().id, p1.id);
    assert!(store
        .find_exact_dup("sha256_exact_1", BASE_TS + 1_000)
        .unwrap()
        .is_none());

    // Flip 3 bits across 3 different 16-bit bands (band 3 remains identical -> 4-band index hits!)
    let near_3bits = (base_hash ^ (1 << 0) ^ (1 << 17) ^ (1 << 35)) as i64;
    assert_eq!(hamming_distance(base_simhash, near_3bits), 3);

    // Flip 4 bits inside band 0 (bands 1..3 still match index, but Rust Hamming filter rejects > 3!)
    let far_4bits = (base_hash ^ 0b1111) as i64;
    assert_eq!(hamming_distance(base_simhash, far_4bits), 4);

    let (p_far, _) = store
        .insert_post(&make_post(
            &s2,
            "fb_far",
            "auth_b",
            "Trần B",
            "Bài khác biệt hơn 4 bit simhash ở khu vực khác",
            "sha256_far",
            far_4bits,
            BASE_TS + 1_000,
        ))
        .unwrap();

    let sim_matches = store
        .find_simhash_dups(near_3bits, 3, BASE_TS - 14 * DAY_MS)
        .unwrap();
    assert_eq!(sim_matches.len(), 1);
    assert_eq!(sim_matches[0].post.id, p1.id);
    assert_eq!(sim_matches[0].hamming_distance, 3);
    assert_ne!(sim_matches[0].post.id, p_far.id);

    // 4. Create radar + lead on `p1`, then attach <72h duplicate in `s2` and >72h repost in `s3`!
    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Radar Cầu Giấy".to_string(),
            template_id: Some("bds.khach-thue".to_string()),
            description: "Khách cần thuê căn hộ Cầu Giấy".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("môi giới BĐS".to_string()),
            fields: sample_bds_fields(),
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![s1.clone(), s2.clone(), s3.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();

    let eval1 = store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p1.id.clone(),
            radar_version_id: radar.current_version.id.clone(),
            state: "done".to_string(),
            decided_by: Some("ai".to_string()),
            verdict: Some("match".to_string()),
            reject_reason: None,
            score: Some(0.92),
            intent: Some("demand".to_string()),
            author_role: Some("end_user".to_string()),
            summary: Some("Khách cần thuê 2PN Cầu Giấy 12-15tr".to_string()),
            reason: Some("Đúng nhu cầu thuê thật".to_string()),
            fields: Some(BTreeMap::new()),
            ruleset_id: None,
            ai_call_id: None,
            is_preview: false,
            created_at: BASE_TS,
            decided_at: Some(BASE_TS + 500),
        })
        .unwrap();

    let (lead, created) = store
        .create_lead(&CreateLeadInput {
            id: None,
            radar_id: radar.radar.id.clone(),
            radar_version_id: radar.current_version.id.clone(),
            post_id: p1.id.clone(),
            evaluation_id: eval1.id.clone(),
            contact_id: None,
            status: "new".to_string(),
            score: 0.92,
            summary: "Khách cần thuê 2PN Cầu Giấy 12-15tr".to_string(),
            fields: BTreeMap::new(),
            also_seen_in: None,
            notified_at: None,
            follow_up_at: None,
            note: None,
            tags: None,
            now_ms: BASE_TS + 1_000,
        })
        .unwrap();
    assert!(created);
    assert!(lead.also_seen_in.is_empty());

    // Duplicate within 72h (2h later) in `s2` updates `dup_clusters` AND `lead.also_seen_in`!
    let (p_dup_2h, _) = store
        .insert_post(&make_post(
            &s2,
            "fb_dup_2h",
            "auth_a",
            "Nguyễn Văn A",
            "Em cần thuê căn hộ 2 phòng ngủ khu Cầu Giấy, ban công thoáng, tầm 12-15tr/th",
            "sha256_exact_1",
            near_3bits,
            BASE_TS + 2 * HOUR_MS,
        ))
        .unwrap();

    let attach_2h = store
        .create_or_attach_dup_cluster(&p1.id, &p_dup_2h.id)
        .unwrap();
    assert!(!attach_2h.is_repost_after_72h);
    assert_eq!(attach_2h.cluster.size, 2);
    assert_eq!(attach_2h.cluster.source_count, 2);
    assert_eq!(attach_2h.updated_lead_ids, vec![lead.id.clone()]);

    let lead_after_2h = store.lead_get(&lead.id).unwrap().unwrap();
    assert_eq!(lead_after_2h.lead.also_seen_in.len(), 1);
    assert_eq!(lead_after_2h.lead.also_seen_in[0].source_id, s2);
    assert_eq!(
        lead_after_2h.lead.also_seen_in[0].source_name,
        "Group Mỹ Đình"
    );

    // Duplicate after >72h (80h later) in `s3` is flagged `is_repost_after_72h = true`!
    let (p_repost_80h, _) = store
        .insert_post(&make_post(
            &s3,
            "fb_repost_80h",
            "auth_a",
            "Nguyễn Văn A",
            "Em vẫn cần thuê căn hộ 2 phòng ngủ khu Cầu Giấy, tầm 12-15tr/th",
            "sha256_exact_1",
            near_3bits,
            BASE_TS + 80 * HOUR_MS,
        ))
        .unwrap();
    let attach_80h = store
        .create_or_attach_dup_cluster(&p1.id, &p_repost_80h.id)
        .unwrap();
    assert!(attach_80h.is_repost_after_72h);
    assert_eq!(attach_80h.cluster.size, 3);
    assert_eq!(attach_80h.cluster.source_count, 3);
    assert!(attach_80h.updated_lead_ids.is_empty());
}

#[test]
fn test_dynamic_lead_list_filters_fts_pagination_and_sql_injection_guard() {
    let store = Store::open_in_memory().expect("open_in_memory");
    let src = seed_source(&store, "g_bds", "Chợ căn hộ Hà Nội", true);

    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Khách thuê căn hộ HN".to_string(),
            template_id: Some("bds.khach-thue".to_string()),
            description: "Khách cần thuê căn hộ Hà Nội".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("môi giới bất động sản".to_string()),
            fields: sample_bds_fields(),
            match_policy: MatchPolicy {
                want_intent: "demand".to_string(),
                exclude_roles: vec!["peer".to_string()],
                hard_filters: vec![HardFilter {
                    field: "price".to_string(),
                    op: FilterOp::Lte,
                    value: json!(15_000_000),
                    when_missing: "pass".to_string(),
                }],
                extra: BTreeMap::new(),
            },
            notify: NotifyConfig::default(),
            source_ids: vec![src.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();

    // Helper to insert post + eval + lead
    let create_sample_lead = |idx: usize,
                              post_text: &str,
                              summary: &str,
                              score: f64,
                              status: &str,
                              fields_map: BTreeMap<String, ExtractedField>,
                              note: Option<String>|
     -> String {
        let ts = BASE_TS + (idx as i64) * 10_000;
        let (post, _) = store
            .insert_post(&make_post(
                &src,
                &format!("p_{idx}"),
                &format!("u_{idx}"),
                &format!("Khách {idx}"),
                post_text,
                &format!("hash_{idx}"),
                1000 + idx as i64,
                ts,
            ))
            .unwrap();

        let eval = store
            .upsert_evaluation(&EvaluationUpsertInput {
                id: None,
                post_id: post.id.clone(),
                radar_version_id: radar.current_version.id.clone(),
                state: "done".to_string(),
                decided_by: Some("ai".to_string()),
                verdict: Some("match".to_string()),
                reject_reason: None,
                score: Some(score),
                intent: Some("demand".to_string()),
                author_role: Some("end_user".to_string()),
                summary: Some(summary.to_string()),
                reason: Some("Khớp".to_string()),
                fields: Some(fields_map.clone()),
                ruleset_id: None,
                ai_call_id: None,
                is_preview: false,
                created_at: ts,
                decided_at: Some(ts + 100),
            })
            .unwrap();

        let (lead, _) = store
            .create_lead(&CreateLeadInput {
                id: None,
                radar_id: radar.radar.id.clone(),
                radar_version_id: radar.current_version.id.clone(),
                post_id: post.id,
                evaluation_id: eval.id,
                contact_id: None,
                status: status.to_string(),
                score,
                summary: summary.to_string(),
                fields: fields_map,
                also_seen_in: None,
                notified_at: (score >= 0.6).then_some(ts + 200),
                follow_up_at: None,
                note,
                tags: Some(vec!["vip".to_string()]),
                now_ms: ts + 150,
            })
            .unwrap();
        lead.id
    };

    // Lead 1: Cầu Giấy, 12-15tr, 65m2, rent, [điều hoà, ban công], 2pn, is_owner=true, 2026-11-15
    let mut f1 = BTreeMap::new();
    f1.insert(
        "price".into(),
        ExtractedField {
            value: json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"}),
            raw: Some("12-15tr/th".into()),
            confidence: 0.95,
            source: FieldSource::Ai,
        },
    );
    f1.insert(
        "district".into(),
        ExtractedField {
            value: json!({"raw": "khu Cầu Giấy", "province": "Hà Nội", "district": "Cầu Giấy", "ward": "Dịch Vọng"}),
            raw: Some("khu Cầu Giấy".into()),
            confidence: 0.95,
            source: FieldSource::Rule,
        },
    );
    f1.insert(
        "area".into(),
        ExtractedField {
            value: json!({"min": 60.0, "max": 70.0, "unit": "m2"}),
            raw: Some("60-70m2".into()),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );
    f1.insert(
        "deal_type".into(),
        ExtractedField {
            value: json!("rent"),
            raw: Some("thuê".into()),
            confidence: 0.99,
            source: FieldSource::Rule,
        },
    );
    f1.insert(
        "amenities".into(),
        ExtractedField {
            value: json!(["điều hoà", "ban công"]),
            raw: Some("điều hoà, ban công".into()),
            confidence: 0.9,
            source: FieldSource::Ai,
        },
    );
    f1.insert(
        "bedrooms".into(),
        ExtractedField {
            value: json!(2),
            raw: Some("2pn".into()),
            confidence: 0.98,
            source: FieldSource::Rule,
        },
    );
    f1.insert(
        "is_owner".into(),
        ExtractedField {
            value: json!(true),
            raw: Some("chính chủ".into()),
            confidence: 0.85,
            source: FieldSource::Ai,
        },
    );
    f1.insert(
        "move_in_date".into(),
        ExtractedField {
            value: json!("2026-11-15"),
            raw: Some("15/11".into()),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );
    f1.insert(
        "notes_excerpt".into(),
        ExtractedField {
            value: json!("Nuôi mèo sạch sẽ"),
            raw: Some("Nuôi mèo sạch sẽ".into()),
            confidence: 0.9,
            source: FieldSource::Ai,
        },
    );

    let lead1_id = create_sample_lead(
        1,
        "Gia đình trẻ cần thuê căn hộ 2pn khu Cầu Giấy có ban công hướng Đông Nam, nuôi mèo sạch sẽ",
        "Cần thuê 2PN Cầu Giấy 12-15tr",
        0.93,
        "new",
        f1,
        Some("Khách thiện chí, gọi buổi tối".to_string()),
    );

    // Lead 2: Nam Từ Liêm, 8-10tr, 45m2, rent, [máy giặt], 1pn, is_owner=false, 2026-12-01
    let mut f2 = BTreeMap::new();
    f2.insert(
        "price".into(),
        ExtractedField {
            value: json!({"min": 8_000_000, "max": 10_000_000, "currency": "VND", "period": "month"}),
            raw: Some("8-10tr".into()),
            confidence: 0.95,
            source: FieldSource::Ai,
        },
    );
    f2.insert(
        "district".into(),
        ExtractedField {
            value: json!({"raw": "Mỹ Đình", "province": "Hà Nội", "district": "Nam Từ Liêm", "ward": null}),
            raw: Some("Mỹ Đình".into()),
            confidence: 0.92,
            source: FieldSource::Rule,
        },
    );
    f2.insert(
        "deal_type".into(),
        ExtractedField {
            value: json!("rent"),
            raw: Some("thuê".into()),
            confidence: 0.99,
            source: FieldSource::Rule,
        },
    );
    f2.insert(
        "bedrooms".into(),
        ExtractedField {
            value: json!(1),
            raw: Some("1pn".into()),
            confidence: 0.95,
            source: FieldSource::Rule,
        },
    );
    f2.insert(
        "is_owner".into(),
        ExtractedField {
            value: json!(false),
            raw: None,
            confidence: 0.8,
            source: FieldSource::Ai,
        },
    );
    f2.insert(
        "move_in_date".into(),
        ExtractedField {
            value: json!("2026-12-01"),
            raw: Some("1/12".into()),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );

    let lead2_id = create_sample_lead(
        2,
        "Mình cần tìm phòng studio 1pn khu Mỹ Đình Nam Từ Liêm giá 8-10tr",
        "Tìm 1PN Mỹ Đình 8-10tr",
        0.84,
        "viewed",
        f2,
        None,
    );

    // Lead 3: Tây Hồ, 25tr, buy
    let mut f3 = BTreeMap::new();
    f3.insert(
        "price".into(),
        ExtractedField {
            value: json!({"min": 25_000_000, "max": 25_000_000, "currency": "VND", "period": "month"}),
            raw: Some("25tr".into()),
            confidence: 0.95,
            source: FieldSource::Ai,
        },
    );
    f3.insert(
        "district".into(),
        ExtractedField {
            value: json!({"raw": "Tây Hồ", "province": "Hà Nội", "district": "Tây Hồ", "ward": null}),
            raw: Some("Tây Hồ".into()),
            confidence: 0.95,
            source: FieldSource::Rule,
        },
    );
    f3.insert(
        "deal_type".into(),
        ExtractedField {
            value: json!("buy"),
            raw: Some("mua".into()),
            confidence: 0.95,
            source: FieldSource::Rule,
        },
    );

    let lead3_id = create_sample_lead(
        3,
        "Cần mua căn hộ dịch vụ Tây Hồ dòng tiền 25tr/tháng",
        "Mua căn hộ Tây Hồ",
        0.52,
        "new",
        f3,
        None,
    );

    // Query 1: exact spec query from `04-data-model.md §3`:
    // price <= 15_000_000 AND district IN ["Cầu Giấy", "Nam Từ Liêm"], status IN ["new", "viewed"]
    let page = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            unread_only: None,
            follow_up_before: None,
            exclude_weak: None,
            status: Some(vec!["new".into(), "viewed".into()]),
            since: Some(BASE_TS),
            min_score: None,
            filters: vec![
                LeadFieldFilter {
                    field: "price".into(),
                    op: FilterOp::Lte,
                    value: json!(15_000_000),
                },
                LeadFieldFilter {
                    field: "district".into(),
                    op: FilterOp::In,
                    value: json!(["Cầu Giấy", "Nam Từ Liêm"]),
                },
            ],
            search: None,
            sort: Some(LeadSort {
                by: "price".into(),
                dir: SortDir::Asc,
            }),
            limit: 50,
            cursor: None,
        })
        .unwrap();

    assert_eq!(page.items.len(), 2);
    // Sorted by `price` ASC -> lead2 (8M) first, lead1 (12M) second!
    assert_eq!(page.items[0].lead.id, lead2_id);
    assert_eq!(page.items[1].lead.id, lead1_id);

    // Query 2: multi_enum, range between, boolean, date between, and diacritic-insensitive contains!
    let page2 = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            filters: vec![
                LeadFieldFilter {
                    field: "area".into(),
                    op: FilterOp::Between,
                    value: json!([55, 75]),
                },
                LeadFieldFilter {
                    field: "amenities".into(),
                    op: FilterOp::In,
                    value: json!(["ban công"]),
                },
                LeadFieldFilter {
                    field: "is_owner".into(),
                    op: FilterOp::Eq,
                    value: json!(true),
                },
                LeadFieldFilter {
                    field: "move_in_date".into(),
                    op: FilterOp::Between,
                    value: json!(["2026-11-01", "2026-11-20"]),
                },
                LeadFieldFilter {
                    field: "notes_excerpt".into(),
                    op: FilterOp::Contains,
                    value: json!("nuoi meo"),
                },
                LeadFieldFilter {
                    field: "phone".into(),
                    op: FilterOp::IsEmpty,
                    value: json!(true),
                },
            ],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page2.items.len(), 1);
    assert_eq!(page2.items[0].lead.id, lead1_id);

    // Query 3: FTS5 `search` matching `leads_fts.note` ("khach thien chi" -> "Khách thiện chí")
    let fts_lead_note = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            search: Some("khach thien chi".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(fts_lead_note.items.len(), 1);
    assert_eq!(fts_lead_note.items[0].lead.id, lead1_id);

    // Query 4: FTS5 `search` matching `posts_fts.text` ("huong dong nam" -> "hướng Đông Nam")
    let fts_post = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            search: Some("huong dong nam".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(fts_post.items.len(), 1);
    assert_eq!(fts_post.items[0].lead.id, lead1_id);

    // Query 5: Cursor pagination (limit = 2 -> page A has 2 items + cursor, page B has 1 item + None)
    let p_a = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            limit: 2,
            cursor: None,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(p_a.items.len(), 2);
    assert!(p_a.next_cursor.is_some());

    let p_b = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            limit: 2,
            cursor: p_a.next_cursor,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(p_b.items.len(), 1);
    assert!(p_b.next_cursor.is_none());
    assert_eq!(p_a.items[0].lead.id, lead3_id);

    // Query 6: Inline field editing (`lead_update_field` -> `source: User` + `lead_events`)
    let edited = store
        .lead_update_field(
            &lead1_id,
            "bedrooms",
            json!(3),
            Some("3 phòng ngủ".into()),
            BASE_TS + 99_000,
        )
        .unwrap();
    assert_eq!(edited.fields["bedrooms"].value, json!(3));
    assert_eq!(edited.fields["bedrooms"].source, FieldSource::User);

    store
        .lead_set_status(&lead1_id, "contacted", BASE_TS + 100_000)
        .unwrap();
    store
        .lead_set_note_tags_followup(
            &lead1_id,
            Some("Đã hẹn xem nhà".into()),
            Some(vec!["hen-xem".into()]),
            Some(BASE_TS + DAY_MS),
            BASE_TS + 101_000,
        )
        .unwrap();
    let detail = store.lead_get(&lead1_id).unwrap().unwrap();
    assert_eq!(detail.events.len(), 4); // created, field_edited, status_changed, noted
    assert_eq!(
        store
            .count_leads_in_last_hour(&radar.radar.id, BASE_TS + 200_000)
            .unwrap(),
        3
    );

    // ========================================================================
    // CRITICAL SECURITY: SQL-injection key rejection & radar field whitelist
    // ========================================================================
    let injection_keys = [
        "price') OR 1=1--",
        "price\"; DROP TABLE leads;--",
        "$.price",
        "1price",
        "Price",
        "",
        "field_name_way_too_long_exceeding_31_chars_limit",
    ];
    for bad_key in injection_keys {
        let err = store
            .lead_list(&LeadListQuery {
                radar_id: Some(radar.radar.id.clone()),
                filters: vec![LeadFieldFilter {
                    field: bad_key.to_string(),
                    op: FilterOp::Eq,
                    value: json!(1),
                }],
                ..Default::default()
            })
            .expect_err("must reject SQL injection / invalid field key");
        assert!(matches!(err, StoreError::InvalidFieldKey(_)));
    }

    // Valid identifier syntax, but NOT defined in this radar's fields -> UnknownRadarField!
    let unknown_err = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            filters: vec![LeadFieldFilter {
                field: "undeclared_field".to_string(),
                op: FilterOp::Eq,
                value: json!("abc"),
            }],
            ..Default::default()
        })
        .expect_err("must reject field not in radar definition");
    assert!(matches!(unknown_err, StoreError::UnknownRadarField { .. }));

    // Malicious sort column -> InvalidFieldKey!
    let bad_sort_err = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            sort: Some(LeadSort {
                by: "score DESC; DROP TABLE leads;--".to_string(),
                dir: SortDir::Desc,
            }),
            ..Default::default()
        })
        .expect_err("must reject SQL injection in sort.by");
    assert!(matches!(bad_sort_err, StoreError::InvalidFieldKey(_)));

    // Malicious filter VALUE is safely parameterized and never executes SQL!
    let safe_val_page = store
        .lead_list(&LeadListQuery {
            radar_id: Some(radar.radar.id.clone()),
            filters: vec![LeadFieldFilter {
                field: "district".to_string(),
                op: FilterOp::Eq,
                value: json!("Cầu Giấy') OR 1=1;--"),
            }],
            ..Default::default()
        })
        .unwrap();
    assert!(safe_val_page.items.is_empty());
    assert_eq!(store.table_row_counts().unwrap()["leads"], 3);
}

#[test]
fn test_radar_versioning_rulesets_funnel_and_feedback() {
    let store = Store::open_in_memory().expect("open_in_memory");
    let s1 = seed_source(&store, "g1", "Group 1", true);

    let draft = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Radar BĐS".to_string(),
            template_id: None,
            description: "Tìm khách thuê 2PN".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: Some("môi giới".to_string()),
            fields: sample_bds_fields(),
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![s1.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();
    assert_eq!(draft.radar.current_version, 1);

    // 1. Metadata-only update does NOT create a new version.
    let meta_upd = store
        .radar_update(
            &draft.radar.id,
            &UpdateRadarInput {
                name: Some("Radar BĐS Đổi Tên".to_string()),
                now_ms: BASE_TS + 1_000,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(meta_upd.version_created.is_none());
    assert_eq!(meta_upd.radar.radar.current_version, 1);

    // 2. Definition update on `draft` creates v2 and activates it immediately.
    let draft_def_upd = store
        .radar_update(
            &draft.radar.id,
            &UpdateRadarInput {
                description: Some("Tìm khách thuê 2PN dưới 15 triệu".to_string()),
                now_ms: BASE_TS + 2_000,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(draft_def_upd.version_created.as_ref().unwrap().version, 2);
    assert!(!draft_def_upd.pending_confirmation);
    assert_eq!(draft_def_upd.radar.radar.current_version, 2);
    let v2_id = draft_def_upd.radar.current_version.id.clone();

    // Activate radar & attach an active ruleset on v2.
    store
        .radar_set_status(&draft.radar.id, "active", BASE_TS + 3_000)
        .unwrap();
    assert_eq!(store.count_active_radars().unwrap(), 1);
    assert_eq!(store.list_sources_for_active_radars().unwrap().len(), 1);

    let rs_v2 = store
        .insert_ruleset(&NewRulesetInput {
            id: None,
            radar_version_id: v2_id.clone(),
            state: "candidate".to_string(),
            origin: "compiled".to_string(),
            body: json!({"dsl": 1}),
            metrics: None,
            now_ms: BASE_TS + 3_100,
        })
        .unwrap();
    store
        .update_ruleset_state(
            &rs_v2.id,
            "shadow",
            Some(&json!({"fn_rate": 0.01})),
            BASE_TS + 3_200,
        )
        .unwrap();
    assert!(store.get_shadow_ruleset(&v2_id).unwrap().is_some());
    store
        .update_ruleset_state(
            &rs_v2.id,
            "active",
            Some(&json!({"precision": 0.97})),
            BASE_TS + 3_300,
        )
        .unwrap();
    assert!(store.get_active_ruleset(&v2_id).unwrap().is_some());

    // 3. Definition update on `active` radar creates candidate v3 while keeping `current_version = 2`!
    let active_upd = store
        .radar_update(
            &draft.radar.id,
            &UpdateRadarInput {
                description: Some("Tìm khách thuê 2-3PN dưới 18 triệu".to_string()),
                activate_immediately: false,
                now_ms: BASE_TS + 4_000,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(active_upd.pending_confirmation);
    assert_eq!(active_upd.radar.radar.current_version, 2);
    let v3 = active_upd.radar.candidate_version.as_ref().unwrap();
    assert_eq!(v3.version, 3);

    // Add a preview evaluation on v3; confirming v3 must switch current_version -> 3,
    // retire v2's active ruleset, and delete preview evaluations!
    let (p_prev, _) = store
        .insert_post(&make_post(
            &s1,
            "p_prev",
            "u_p",
            "User P",
            "Bài chạy xem thử v3",
            "h_prev",
            42,
            BASE_TS + 4_100,
        ))
        .unwrap();
    store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p_prev.id,
            radar_version_id: v3.id.clone(),
            state: "done".to_string(),
            decided_by: Some("ai".to_string()),
            verdict: Some("match".to_string()),
            reject_reason: None,
            score: Some(0.88),
            intent: Some("demand".to_string()),
            author_role: Some("end_user".to_string()),
            summary: Some("Preview match".to_string()),
            reason: Some("OK".to_string()),
            fields: None,
            ruleset_id: None,
            ai_call_id: None,
            is_preview: true,
            created_at: BASE_TS + 4_200,
            decided_at: Some(BASE_TS + 4_300),
        })
        .unwrap();
    assert_eq!(store.list_preview_evaluations(&v3.id).unwrap().len(), 1);

    let confirmed = store
        .radar_confirm_version(&draft.radar.id, 3, BASE_TS + 5_000)
        .unwrap();
    assert_eq!(confirmed.radar.current_version, 3);
    assert!(confirmed.candidate_version.is_none());
    assert!(store.get_active_ruleset(&v2_id).unwrap().is_none());
    assert!(store.list_preview_evaluations(&v3.id).unwrap().is_empty());

    // 4. Test balanced feedback examples (4 pos + 4 neg) & labeled dataset + funnel stats
    let v3_id = confirmed.current_version.id.clone();
    for i in 0..10 {
        let (p, _) = store
            .insert_post(&make_post(
                &s1,
                &format!("fb_post_{i}"),
                &format!("u_{i}"),
                &format!("Author {i}"),
                &format!("Nội dung bài phản hồi số {i}"),
                &format!("h_fb_{i}"),
                5000 + i as i64,
                BASE_TS + 10_000 + i as i64 * 100,
            ))
            .unwrap();
        let is_pos = i % 2 == 0;
        let ev = store
            .upsert_evaluation(&EvaluationUpsertInput {
                id: None,
                post_id: p.id,
                radar_version_id: v3_id.clone(),
                state: "done".to_string(),
                decided_by: Some(if i < 4 { "rule" } else { "ai" }.to_string()),
                verdict: Some(if is_pos { "match" } else { "no_match" }.to_string()),
                reject_reason: (!is_pos).then(|| "irrelevant".to_string()),
                score: Some(if is_pos { 0.91 } else { 0.10 }),
                intent: Some("demand".to_string()),
                author_role: Some("end_user".to_string()),
                summary: Some(format!("Summary {i}")),
                reason: Some("Reason".to_string()),
                fields: None,
                ruleset_id: None,
                ai_call_id: None,
                is_preview: false,
                created_at: BASE_TS + 10_000 + i as i64 * 100,
                decided_at: Some(BASE_TS + 10_050 + i as i64 * 100),
            })
            .unwrap();

        store
            .record_feedback(&RecordFeedbackInput {
                evaluation_id: ev.id,
                label: if is_pos { "correct" } else { "irrelevant" }.to_string(),
                corrected_fields: None,
                post_text: None,
                origin: "app".to_string(),
                now_ms: BASE_TS + 20_000 + i as i64 * 100,
            })
            .unwrap();
    }

    let examples = store.get_prompt_feedback_examples(&v3_id, 8).unwrap();
    assert_eq!(examples.len(), 8);
    let pos_cnt = examples.iter().filter(|e| e.label == "correct").count();
    let neg_cnt = examples.iter().filter(|e| e.label == "irrelevant").count();
    assert_eq!(pos_cnt, 4);
    assert_eq!(neg_cnt, 4);

    let dataset = store.get_labeled_dataset(&v3_id).unwrap();
    assert_eq!(dataset.len(), 10);
    assert!(dataset
        .iter()
        .all(|s| matches!(s.origin, LabeledSampleOrigin::Feedback(_))));

    let rejected = store.evaluation_list_rejected(&draft.radar.id, 10).unwrap();
    assert_eq!(rejected.len(), 5);

    let funnel = store
        .radar_stats(Some(&draft.radar.id), BASE_TS + 50_000)
        .unwrap();
    assert_eq!(funnel.total_evaluated, 10);
    assert_eq!(funnel.rule_decided, 4);
    assert_eq!(funnel.ai_decided, 6);
    assert!((funnel.rule_handled_ratio - 0.4).abs() < 1e-6);
}

#[test]
fn test_contacts_blocklist_peer_signals_jobs_outbox_ai_usage_and_purge() {
    let store = Store::open_in_memory().expect("open_in_memory");
    let s1 = seed_source(&store, "g1", "Group 1", true);
    let s2 = seed_source(&store, "g2", "Group 2", true);
    let s3 = seed_source(&store, "g3", "Group 3", true);
    let s4 = seed_source(&store, "g4", "Group 4", true);

    // 1. Contacts merge across phone & author + Peer Signals (3 authors sharing 1 phone + 4 sources)
    let c_a = store
        .upsert_contact_from_lead(Some("auth_1"), Some("Môi giới 1"), &[], BASE_TS)
        .unwrap()
        .unwrap();
    let c_b = store
        .upsert_contact_from_lead(
            Some("auth_2"),
            Some("Môi giới 2"),
            &["+84988777666".to_string()],
            BASE_TS + 100,
        )
        .unwrap()
        .unwrap();
    assert_ne!(c_a.id, c_b.id);

    // Now `auth_1` uses `+84988777666` -> contacts `c_a` and `c_b` merge into `c_a`!
    let c_merged = store
        .upsert_contact_from_lead(
            Some("auth_1"),
            Some("Môi giới 1"),
            &["+84988777666".to_string()],
            BASE_TS + 200,
        )
        .unwrap()
        .unwrap();
    assert_eq!(c_merged.id, c_a.id);
    assert_eq!(c_merged.author_ids.len(), 2);
    assert_eq!(store.contact_list(None, 50).unwrap().len(), 1);
    store
        .contact_note(
            &c_a.id,
            Some("Môi giới chuyên đăng nhiều nick"),
            BASE_TS + 300,
        )
        .unwrap();
    assert_eq!(
        store
            .contact_get(&c_a.id)
            .unwrap()
            .unwrap()
            .contact
            .note
            .as_deref(),
        Some("Môi giới chuyên đăng nhiều nick")
    );

    // Third author posts with the same phone across 4 sources -> triggers peer override!
    let mut head_post_id: Option<String> = None;
    for (idx, sid) in [&s1, &s2, &s3, &s4].iter().enumerate() {
        let (p, _) = store
            .insert_post(&make_post(
                sid,
                &format!("peer_p_{idx}"),
                &format!("broker_ext_{idx}"),
                &format!("Broker {idx}"),
                "Cho thuê căn hộ hoa hồng cao LH o988 777 666",
                "hash_broker",
                9999,
                BASE_TS + (idx as i64) * 1_000,
            ))
            .unwrap();
        if let Some(hid) = head_post_id.as_deref() {
            store.create_or_attach_dup_cluster(hid, &p.id).unwrap();
        } else {
            head_post_id = Some(p.id);
        }
    }
    let hid = head_post_id.unwrap();
    assert!(
        store
            .count_distinct_authors_for_phone("+84988777666")
            .unwrap()
            >= 4
    );
    let peer_sig = store
        .get_peer_signals(&hid, &["+84988777666".to_string()], BASE_TS + 5_000)
        .unwrap();
    assert_eq!(peer_sig.cluster_source_count, 4);
    assert!(peer_sig.max_distinct_authors_for_phone >= 3);
    assert!(peer_sig.is_peer_override);

    // 2. Blocklist (`author` by platform external_id, `phone`, `keyword` folded)
    let bl_kw = store
        .blocklist_add("keyword", "Tuyển CTV", None, Some("Spam"), BASE_TS)
        .unwrap();
    store
        .blocklist_add("author", "broker_ext_0", None, Some("Peer"), BASE_TS)
        .unwrap();
    store
        .blocklist_add("phone", "+84900111222", None, None, BASE_TS)
        .unwrap();

    // Pass internal `author_id` of `broker_ext_0` -> resolves and matches `broker_ext_0`!
    let p0 = store.post_get(&hid).unwrap().unwrap();
    assert!(store
        .is_blocked(None, p0.post.author_id.as_deref(), &[], None)
        .unwrap());
    assert!(store
        .is_blocked(None, None, &["+84900111222".to_string()], None)
        .unwrap());
    assert!(store
        .is_blocked(None, None, &[], Some("can tuyen ctv ban hang online"))
        .unwrap());
    assert!(!store
        .is_blocked(None, None, &[], Some("khach can thue nha that"))
        .unwrap());
    store.blocklist_remove(&bl_kw.id).unwrap();
    assert_eq!(store.blocklist_list(None).unwrap().len(), 2);

    // 3. Durable `jobs` queue: deduplication while queued & running, retry, stale recovery, re-enqueue after done
    let (j1, ins1) = store
        .enqueue_job(
            "evaluate_batch",
            Some("evaluate_batch:rvid_1"),
            &json!({"rvid": "rvid_1"}),
            BASE_TS,
            BASE_TS,
        )
        .unwrap();
    assert!(ins1);

    // Duplicate while `queued` -> gracefully ignored!
    let (j_dup_q, ins_dup_q) = store
        .enqueue_job(
            "evaluate_batch",
            Some("evaluate_batch:rvid_1"),
            &json!({"rvid": "rvid_1"}),
            BASE_TS + 100,
            BASE_TS + 100,
        )
        .unwrap();
    assert!(!ins_dup_q);
    assert_eq!(j_dup_q.id, j1.id);

    // Claim job -> `running`, `attempts = 1`
    let claimed = store.claim_due_job(BASE_TS).unwrap().unwrap();
    assert_eq!(claimed.id, j1.id);
    assert_eq!(claimed.state, "running");
    assert_eq!(claimed.attempts, 1);

    // Duplicate while `running` -> ALSO gracefully ignored!
    let (_, ins_dup_run) = store
        .enqueue_job(
            "evaluate_batch",
            Some("evaluate_batch:rvid_1"),
            &json!({"rvid": "rvid_1"}),
            BASE_TS + 200,
            BASE_TS + 200,
        )
        .unwrap();
    assert!(!ins_dup_run);

    // Retry schedule check (`03-desktop.md §3.1`: 1m, 5m, 15m, then None)
    assert_eq!(
        default_job_retry_delay_ms("evaluate_batch", 1),
        Some(60_000)
    );
    assert_eq!(
        default_job_retry_delay_ms("evaluate_batch", 2),
        Some(300_000)
    );
    assert_eq!(
        default_job_retry_delay_ms("evaluate_batch", 3),
        Some(900_000)
    );
    assert_eq!(default_job_retry_delay_ms("evaluate_batch", 4), None);

    let retried = store
        .fail_or_retry_job(&j1.id, "timeout", Some(BASE_TS + 60_000))
        .unwrap();
    assert_eq!(retried.state, "queued");
    assert!(store.claim_due_job(BASE_TS + 10_000).unwrap().is_none());

    let claimed2 = store.claim_due_job(BASE_TS + 60_000).unwrap().unwrap();
    assert_eq!(claimed2.attempts, 2);

    // Simulate crash recovery of stale running job
    assert_eq!(
        store
            .recover_stale_running_jobs(BASE_TS + 60_000, BASE_TS + 120_000)
            .unwrap(),
        1
    );
    let claimed3 = store.claim_due_job(BASE_TS + 120_000).unwrap().unwrap();
    store.complete_job(&claimed3.id).unwrap();

    // Once `done`, same `dedup_key` CAN be enqueued again!
    let (j_new, ins_new) = store
        .enqueue_job(
            "evaluate_batch",
            Some("evaluate_batch:rvid_1"),
            &json!({"rvid": "rvid_1"}),
            BASE_TS + 130_000,
            BASE_TS + 130_000,
        )
        .unwrap();
    assert!(ins_new);
    assert_ne!(j_new.id, j1.id);
    // Mark `j1` old so `purge_expired` can clean it up later; complete `j_new`
    store.complete_job(&j_new.id).unwrap();

    // 4. Channels, Outbox & AI Usage
    let ch = store
        .channel_create(
            "telegram",
            "Telegram Cá nhân",
            &json!({"chat_id": 123456789, "bot_username": "dealsonar_bot"}),
            BASE_TS,
        )
        .unwrap();
    let ob1 = store
        .enqueue_outbox(&EnqueueOutboxInput {
            id: None,
            channel_id: ch.id.clone(),
            lead_id: None,
            kind: "system".to_string(),
            payload: json!({"text": "Test alert"}),
            next_try_at: BASE_TS,
            now_ms: BASE_TS,
        })
        .unwrap();
    let claimed_ob = store.claim_due_outbox(BASE_TS).unwrap().unwrap();
    assert_eq!(claimed_ob.id, ob1.id);
    store
        .mark_outbox_sent(&ob1.id, Some("tg_msg_42"), BASE_TS + 500)
        .unwrap();

    // Outbox queued > 2h drops on retry
    let ob_stale = store
        .enqueue_outbox(&EnqueueOutboxInput {
            id: None,
            channel_id: ch.id.clone(),
            lead_id: None,
            kind: "system".to_string(),
            payload: json!({"text": "Stale"}),
            next_try_at: BASE_TS,
            now_ms: BASE_TS,
        })
        .unwrap();
    let dropped = store
        .retry_or_drop_outbox(
            &ob_stale.id,
            "network down",
            Some(BASE_TS + 3 * HOUR_MS + 10_000),
            5,
            2 * HOUR_MS,
            BASE_TS + 3 * HOUR_MS,
        )
        .unwrap();
    assert_eq!(dropped.state, "dropped");

    let ai_call = store
        .record_ai_call(&RecordAiCallInput {
            id: None,
            provider: "claude_cli".to_string(),
            model: Some("haiku".to_string()),
            task: "judge_extract".to_string(),
            radar_version_id: None,
            item_count: 18,
            input_tokens: Some(7_200),
            output_tokens: Some(1_500),
            cost_usd: Some(0.012),
            duration_ms: 4_200,
            status: "ok".to_string(),
            error: None,
            now_ms: BASE_TS,
        })
        .unwrap();
    assert_eq!(store.count_ai_items_today(BASE_TS + 1_000).unwrap(), 18);
    let usage = store.ai_usage_get(7, BASE_TS + 1_000).unwrap();
    assert_eq!(usage.days.len(), 7);
    assert_eq!(usage.total_items, 18);
    assert_eq!(usage.total_input_tokens, 7_200);

    // 5. `purge_expired` lifecycle verification (`04-data-model.md §5`):
    //    Create one post with a lead (must SURVIVE purge) and one unmatched post (must have text
    //    nulled while preserving `content_hash` & `simhash`, plus FTS5 integrity preserved!).
    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Radar Lifecycle".to_string(),
            template_id: None,
            description: "Desc".to_string(),
            language_hint: None,
            user_profession: None,
            fields: sample_bds_fields(),
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![s1.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();

    let (p_keep, _) = store
        .insert_post(&make_post(
            &s1,
            "p_with_lead",
            "keep_author",
            "Author Keep",
            "Bài có lead ở Cầu Giấy được giữ mãi cho tới khi xoá tin",
            "hash_keep_lead",
            0x1111_2222_3333_4444,
            BASE_TS,
        ))
        .unwrap();
    let ev_keep = store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p_keep.id.clone(),
            radar_version_id: radar.current_version.id.clone(),
            state: "done".to_string(),
            decided_by: Some("ai".to_string()),
            verdict: Some("match".to_string()),
            reject_reason: None,
            score: Some(0.95),
            intent: Some("demand".to_string()),
            author_role: Some("end_user".to_string()),
            summary: Some("Keep summary".to_string()),
            reason: Some("Keep reason".to_string()),
            fields: Some(BTreeMap::new()),
            ruleset_id: None,
            ai_call_id: Some(ai_call.id.clone()),
            is_preview: false,
            created_at: BASE_TS,
            decided_at: Some(BASE_TS),
        })
        .unwrap();
    store
        .create_lead(&CreateLeadInput {
            id: None,
            radar_id: radar.radar.id.clone(),
            radar_version_id: radar.current_version.id.clone(),
            post_id: p_keep.id.clone(),
            evaluation_id: ev_keep.id,
            contact_id: None,
            status: "new".to_string(),
            score: 0.95,
            summary: "Keep lead".to_string(),
            fields: BTreeMap::new(),
            also_seen_in: None,
            notified_at: None,
            follow_up_at: None,
            note: None,
            tags: None,
            now_ms: BASE_TS,
        })
        .unwrap();

    let (p_unmatched, _) = store
        .insert_post(&make_post(
            &s1,
            "p_unmatched_expire",
            "ephemeral_author",
            "Author Ephemeral",
            "Bài không khớp tại Thanh Xuân sẽ hết hạn sau 30 ngày",
            "hash_preserve_after_purge",
            0x7777_6666_5555_4444,
            BASE_TS,
        ))
        .unwrap();
    let ephemeral_author_id = p_unmatched.author_id.clone().unwrap();
    let ev_unmatched = store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p_unmatched.id.clone(),
            radar_version_id: radar.current_version.id.clone(),
            state: "done".to_string(),
            decided_by: Some("ai".to_string()),
            verdict: Some("no_match".to_string()),
            reject_reason: Some("irrelevant".to_string()),
            score: Some(0.05),
            intent: Some("other".to_string()),
            author_role: Some("unknown".to_string()),
            summary: Some("Scrub me".to_string()),
            reason: Some("Scrub reason".to_string()),
            fields: Some(BTreeMap::new()),
            ruleset_id: None,
            ai_call_id: Some(ai_call.id),
            is_preview: false,
            created_at: BASE_TS,
            decided_at: Some(BASE_TS),
        })
        .unwrap();

    // Feedback snapshot on `ev_unmatched` MUST survive post text purge!
    let fb = store
        .record_feedback(&RecordFeedbackInput {
            evaluation_id: ev_unmatched.id.clone(),
            label: "irrelevant".to_string(),
            corrected_fields: None,
            post_text: None,
            origin: "app".to_string(),
            now_ms: BASE_TS + 1_000,
        })
        .unwrap();
    assert!(fb.post_text.contains("Thanh Xuân"));

    // Fast-forward 95 days:
    // - Unmatched posts (>30d) purged (text=NULL, hashes preserved, FTS cleaned)
    // - Evaluation of purged post scrubbed (row kept, summary/reason/fields=NULL)
    // - AI call (>90d) deleted cleanly without FK failure!
    // - Done jobs & sent/dropped outbox (>14d) deleted!
    // - Ephemeral author with 0 content-bearing posts deleted!
    let future_95d = BASE_TS + 95 * DAY_MS;
    let purge_report = store.purge_expired(future_95d, 30).unwrap();
    assert!(purge_report.posts_purged >= 5); // p_unmatched + 4 broker posts
    assert!(purge_report.evaluations_scrubbed >= 1);
    assert_eq!(purge_report.ai_calls_deleted, 1);
    assert_eq!(purge_report.jobs_deleted, 2);
    assert_eq!(purge_report.outbox_deleted, 2);
    assert!(purge_report.authors_deleted >= 1);

    let purged_post = store.post_get(&p_unmatched.id).unwrap().unwrap().post;
    assert!(purged_post.text.is_none());
    assert!(purged_post.text_norm.is_none());
    assert!(purged_post.text_fold.is_none());
    assert_eq!(purged_post.purged_at, Some(future_95d));
    assert_eq!(purged_post.content_hash, "hash_preserve_after_purge");
    assert_eq!(purged_post.simhash, 0x7777_6666_5555_4444);

    // Dedup still finds purged post via preserved hash & simhash!
    assert!(store
        .find_exact_dup("hash_preserve_after_purge", BASE_TS - 1_000)
        .unwrap()
        .is_some());
    assert!(!store
        .find_simhash_dups(0x7777_6666_5555_4444, 3, BASE_TS - 1_000)
        .unwrap()
        .is_empty());

    // FTS5 no longer returns purged post, while kept lead post STILL matches!
    assert!(store
        .post_search("Thanh Xuan", None, 10)
        .unwrap()
        .is_empty());
    assert_eq!(store.post_search("cau giay", None, 10).unwrap().len(), 1);

    // Scrubbed evaluation row still exists for funnel metrics, with summary/reason/fields nulled
    let scrubbed_ev = store.get_evaluation(&ev_unmatched.id).unwrap().unwrap();
    assert!(scrubbed_ev.summary.is_none());
    assert!(scrubbed_ev.reason.is_none());
    assert!(scrubbed_ev.fields.is_none());
    assert_eq!(scrubbed_ev.decided_by.as_deref(), Some("ai"));

    // Ephemeral author was deleted, while `keep_author` still exists!
    assert!(store.author_get(&ephemeral_author_id).unwrap().is_none());
    assert!(store
        .author_get(p_keep.author_id.as_deref().unwrap())
        .unwrap()
        .is_some());

    // Feedback post_text survived!
    let examples = store
        .get_prompt_feedback_examples(&radar.current_version.id, 8)
        .unwrap();
    assert_eq!(examples.len(), 1);
    assert!(examples[0].post_text.contains("Thanh Xuân"));

    // 6. `delete_all_data` wipes all application tables cleanly
    store.delete_all_data().unwrap();
    let final_counts = store.table_row_counts().unwrap();
    for (tbl, cnt) in &final_counts {
        if tbl != "schema_migrations" {
            assert_eq!(
                *cnt, 0,
                "expected table {tbl} to be empty after delete_all_data"
            );
        }
    }
}

#[test]
fn test_pending_ai_batches_failure_recovery_recent_posts_and_manual_backup() {
    let tmp = TempDir::new().expect("tempdir");
    let store = Store::open_in_memory().expect("open_in_memory");
    let s1 = seed_source(&store, "g_ai", "Group AI Batch", true);

    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Radar Batch".to_string(),
            template_id: None,
            description: "Desc".to_string(),
            language_hint: Some("vi".to_string()),
            user_profession: None,
            fields: sample_bds_fields(),
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![s1.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();
    let rvid = radar.current_version.id.clone();

    let (p1, _) = store
        .insert_post(&make_post(
            &s1,
            "b_1",
            "u1",
            "U1",
            "Bài chờ AI số 1 ở Đống Đa",
            "hb1",
            101,
            BASE_TS + 1_000,
        ))
        .unwrap();
    let (p2, _) = store
        .insert_post(&make_post(
            &s1,
            "b_2",
            "u2",
            "U2",
            "Bài chờ AI số 2 ở Ba Đình",
            "hb2",
            102,
            BASE_TS + 5_000,
        ))
        .unwrap();

    let recent = store
        .list_recent_posts_for_sources(std::slice::from_ref(&s1), 10)
        .unwrap();
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0].id, p2.id);

    let ev1 = store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p1.id.clone(),
            radar_version_id: rvid.clone(),
            state: "pending_ai".to_string(),
            decided_by: None,
            verdict: None,
            reject_reason: None,
            score: None,
            intent: None,
            author_role: None,
            summary: None,
            reason: None,
            fields: None,
            ruleset_id: None,
            ai_call_id: None,
            is_preview: false,
            created_at: BASE_TS + 2_000,
            decided_at: None,
        })
        .unwrap();
    let ev2 = store
        .upsert_evaluation(&EvaluationUpsertInput {
            id: None,
            post_id: p2.id.clone(),
            radar_version_id: rvid.clone(),
            state: "pending_ai".to_string(),
            decided_by: None,
            verdict: None,
            reject_reason: None,
            score: None,
            intent: None,
            author_role: None,
            summary: None,
            reason: None,
            fields: None,
            ruleset_id: None,
            ai_call_id: None,
            is_preview: false,
            created_at: BASE_TS + 8_000,
            decided_at: None,
        })
        .unwrap();

    let groups = store.list_pending_ai_batches().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].radar_version_id, rvid);
    assert_eq!(groups[0].count, 2);
    assert_eq!(groups[0].oldest_created_at, BASE_TS + 2_000);

    // Mark ev1 done via `EvaluationDoneInput` and ev2 `ai_failed` -> requeue
    let done_ev1 = store
        .mark_evaluation_done(
            &ev1.id,
            &EvaluationDoneInput {
                decided_by: "ai".to_string(),
                verdict: "match".to_string(),
                reject_reason: None,
                score: Some(0.89),
                intent: Some("demand".to_string()),
                author_role: Some("end_user".to_string()),
                summary: Some("Khách cần thuê Đống Đa".to_string()),
                reason: Some("Khớp".to_string()),
                fields: Some(BTreeMap::new()),
                ruleset_id: None,
                ai_call_id: None,
                decided_at: BASE_TS + 10_000,
            },
        )
        .unwrap();
    assert_eq!(done_ev1.state, "done");

    store
        .mark_evaluation_ai_failed(&ev2.id, None, Some("CLI timeout"), BASE_TS + 10_000)
        .unwrap();
    assert!(store.list_pending_ai_batches().unwrap().is_empty());

    assert_eq!(store.requeue_ai_failed_evaluations().unwrap(), 1);
    assert_eq!(store.list_pending_ai_batches().unwrap()[0].count, 1);

    // Manual `backup_database` creates a complete standalone SQLite file
    let manual_backup = tmp.path().join("manual-backup.db");
    store.backup_database(&manual_backup).unwrap();
    let reopened = Store::open(&manual_backup, tmp.path().join("bk")).unwrap();
    assert_eq!(reopened.table_row_counts().unwrap()["posts"], 2);
}

#[test]
fn test_thread_safe_send_sync_fts_integrity_and_stroked_d_search() {
    fn assert_clone_send_sync<T: Clone + Send + Sync>() {}
    assert_clone_send_sync::<Store>();

    let tmp = TempDir::new().expect("tempdir");
    let store = Store::open(tmp.path().join("concurrent.db"), tmp.path().join("backups"))
        .expect("open file store");
    let src = seed_source(&store, "g_mt", "Group Đa Luồng Đống Đa", true);

    std::thread::scope(|scope| {
        for t in 0..4 {
            let st = store.clone();
            let sid = src.clone();
            scope.spawn(move || {
                for j in 0..10 {
                    let ext = format!("mt_{t}_{j}");
                    let txt = if t == 0 && j == 0 {
                        "Chính chủ cần tìm thuê nhà nguyên căn tại Đống Đa hoặc Ba Đình".to_string()
                    } else {
                        format!("Bài đăng thử nghiệm luồng {t} mục {j} khu Cầu Giấy")
                    };
                    st.insert_post(&make_post(
                        &sid,
                        &ext,
                        &format!("auth_{t}"),
                        &format!("Người dùng {t}"),
                        &txt,
                        &format!("hash_{t}_{j}"),
                        (t * 100 + j) as i64,
                        BASE_TS + (j as i64) * 100,
                    ))
                    .expect("concurrent insert_post");
                }
            });
        }
    });

    assert_eq!(store.table_row_counts().unwrap()["posts"], 40);
    store
        .verify_fts_integrity()
        .expect("FTS integrity after concurrent inserts");

    // Verify Vietnamese stroked `đ`/`Đ` diacritic-insensitive FTS5 search (`"dong da"` -> `"Đống Đa"`, `"ba dinh"` -> `"Ba Đình"`)
    let dong_da_hits = store.post_search("dong da ba dinh", None, 10).unwrap();
    assert_eq!(dong_da_hits.len(), 1);
    assert!(dong_da_hits[0]
        .post
        .text
        .as_deref()
        .unwrap()
        .contains("Đống Đa"));

    // Purge all 40 unmatched posts and verify SQLite FTS5 `'integrity-check'` STILL passes!
    let report = store.purge_expired(BASE_TS + 45 * DAY_MS, 30).unwrap();
    assert_eq!(report.posts_purged, 40);
    store
        .verify_fts_integrity()
        .expect("FTS integrity after purging text to NULL");
    assert!(store.post_search("cau giay", None, 10).unwrap().is_empty());
}

#[test]
fn durable_feedback_migrates_rejection_labels_and_survives_preview_cleanup() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("old.db");
    let backups = tmp.path().join("backups");
    let store = Store::open_with_migrations(&db, &backups, &MIGRATIONS[..1]).unwrap();
    let source = seed_source(&store, "feedback-migration", "Migration", true);
    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: None,
            name: "Migration".into(),
            template_id: None,
            description: "Radar".into(),
            language_hint: None,
            user_profession: None,
            fields: sample_bds_fields(),
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![source.clone()],
            now_ms: BASE_TS,
        })
        .unwrap();
    let (post, _) = store
        .insert_post(&make_post(
            &source,
            "migration-post",
            "author",
            "Author",
            "Bài không khớp nhưng đã được xác nhận loại đúng",
            "hash",
            123,
            BASE_TS,
        ))
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("INSERT INTO evaluations (id,post_id,radar_version_id,state,verdict,is_preview,created_at) VALUES ('old-eval',?1,?2,'done','no_match',1,?3)",
        rusqlite::params![post.id, radar.current_version.id, BASE_TS]).unwrap();
    conn.execute("INSERT INTO feedback (id,evaluation_id,radar_version_id,post_id,label,post_text,origin,created_at) VALUES ('old-feedback','old-eval',?1,?2,'correct','Snapshot','preview',?3)",
        rusqlite::params![radar.current_version.id, post.id, BASE_TS]).unwrap();
    drop(conn);
    let store = Store::open(&db, &backups).unwrap();
    assert_eq!(
        store.list_schema_migrations().unwrap().len(),
        dealsonar_store::LATEST_SCHEMA_VERSION as usize
    );
    let examples = store
        .get_prompt_feedback_examples(&radar.current_version.id, 8)
        .unwrap();
    assert_eq!(examples.len(), 1);
    assert!(
        !examples[0].expected_match,
        "correct rejection must remain a negative example"
    );
    assert_eq!(
        store
            .cleanup_preview_evaluations(Some(&radar.current_version.id), None)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_prompt_feedback_examples(&radar.current_version.id, 8)
            .unwrap(),
        examples
    );
    let dataset = store
        .get_labeled_dataset(&radar.current_version.id)
        .unwrap();
    assert_eq!(dataset.len(), 1);
    assert!(!dataset[0].is_match);
    assert!(
        fs::read_dir(&backups).unwrap().count() > 0,
        "existing databases are backed up before migrating"
    );
}
