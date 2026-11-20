//! Generates SQLite fixtures and golden outputs with the Rust store, the behaviour oracle for
//! `packages/desktop-core`:
//!
//!   cargo run --manifest-path packages/desktop-core/tools/gen-tauri-fixture/Cargo.toml -- \
//!       packages/desktop-core/test/fixtures/tauri
//!
//! Outputs (all synthetic data, no credentials):
//!   tauri-v1.sqlite3        schema v1 database written by the Rust store (upgrade / rollback tests)
//!   tauri-v3.sqlite3        schema v3 database with sources, radar, posts, leads, contacts, queue rows
//!   golden.json             what the Rust store returns for fixed queries over tauri-v3.sqlite3
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use dealsonar_store::models::*;
use dealsonar_store::{Store, MIGRATIONS};
use serde_json::{json, Value};

const T: i64 = 1_700_000_000_000;

fn field(key: &str, label: &str, ty: FieldType) -> FieldDef {
    FieldDef {
        key: key.into(),
        label: label.into(),
        r#type: ty,
        description: String::new(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 0,
    }
}

fn new_post(n: i64, source_id: &str, text: &str, author: Option<AuthorInput>) -> NewPost {
    NewPost {
        id: Some(format!("01POST{n:020}")),
        platform: "facebook".into(),
        external_id: format!("ext-{n}"),
        source_id: source_id.into(),
        author,
        permalink: format!("https://facebook.com/groups/g1/posts/{n}"),
        text: Some(text.into()),
        text_norm: Some(text.to_lowercase()),
        text_fold: Some(fold_vi(text)),
        text_truncated: false,
        lang: Some("vi".into()),
        content_hash: format!("hash-{n}"),
        simhash: (n as i64).wrapping_mul(0x9E37_79B9_7F4A_7C15u64 as i64),
        attachments: None,
        counts: Some(json!({"reactions": n})),
        extracted_phones: vec![],
        created_at: Some(T + n),
        captured_at: T + n,
        strategy: "dom".into(),
    }
}

fn seed(store: &Store, legacy_v1_db: Option<&Path>) -> (String, RadarWithVersion, Vec<String>) {
    let sources = store
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: "g1".into(),
                name: "Nhà đất Cầu Giấy".into(),
                url: "https://facebook.com/groups/g1".into(),
                privacy: Some("public".into()),
                member_count: Some(1200),
            }],
            Some(true),
            Some("profile-1"),
            T,
        )
        .unwrap();
    let sid = sources.source_ids[0].clone();
    let radar = store
        .radar_create_draft(&CreateRadarDraftInput {
            id: Some("01RADAR00000000000000000001".into()),
            name: "Tìm nhà".into(),
            template_id: None,
            description: "Cho thuê căn hộ".into(),
            language_hint: Some("vi".into()),
            user_profession: None,
            fields: vec![
                field("price", "Giá", FieldType::Money),
                field("area", "Diện tích", FieldType::Number),
            ],
            match_policy: MatchPolicy::default(),
            notify: NotifyConfig::default(),
            source_ids: vec![sid.clone()],
            now_ms: T,
        })
        .unwrap();

    let mut leads = Vec::new();
    let rows = [
        ("Cho thuê căn hộ Cầu Giấy 12 triệu", 12.0, 40.0, "a1", "0912345678"),
        ("Bán nhà Đống Đa 3 tỷ", 3000.0, 60.0, "a2", "0987654321"),
        ("Thuê phòng trọ Hà Đông", 4.0, 20.0, "a3", "0911111111"),
    ];
    for (i, (text, price, area, author, phone)) in rows.iter().enumerate() {
        let n = i as i64 + 1;
        let full_text = format!("{text} liên hệ {phone}");
        let (post, _) = store
            .insert_post(&new_post(
                n,
                &sid,
                &full_text,
                Some(AuthorInput {
                    external_id: Some((*author).into()),
                    name: format!("Author {author}"),
                    is_anonymous: false,
                }),
            ))
            .unwrap();
        let mut fields = BTreeMap::new();
        fields.insert(
            "price".to_string(),
            ExtractedField {
                value: json!({"min": price, "max": price, "currency": "VND", "period": null}),
                raw: Some(format!("{price}")),
                confidence: 0.9,
                source: FieldSource::Ai,
            },
        );
        fields.insert(
            "area".to_string(),
            ExtractedField {
                value: json!(area),
                raw: None,
                confidence: 1.0,
                source: FieldSource::Rule,
            },
        );
        let ev = store
            .upsert_evaluation(&EvaluationUpsertInput {
                id: Some(format!("01EVAL{n:021}")),
                post_id: post.id.clone(),
                radar_version_id: radar.current_version.id.clone(),
                state: "done".into(),
                decided_by: Some("ai".into()),
                verdict: Some("match".into()),
                reject_reason: None,
                score: Some(0.9),
                intent: Some("offer".into()),
                author_role: Some("owner".into()),
                summary: Some((*text).into()),
                reason: None,
                fields: Some(fields.clone()),
                ruleset_id: None,
                ai_call_id: None,
                is_preview: false,
                created_at: T + n,
                decided_at: Some(T + n),
            })
            .unwrap();
        let contact = store
            .upsert_contact_from_lead(
                Some(*author),
                Some(&format!("Author {author}")),
                &[format!("+84{}", &phone[1..])],
                T + n,
            )
            .unwrap();
        let lead_id = format!("01LEAD{n:021}");
        let contact_id = contact.map(|c| c.id);
        let score = 0.9 - n as f64 / 100.0;
        if let Some(db_path) = legacy_v1_db {
            // Schema v1 has no `leads.read_at` (added by migration 0003), and the current
            // `Store::create_lead` reads it, so legacy rows are written the way the v1 app did:
            // plain SQL with the 0001 columns only. Statuses cover what 0003 rewrites on upgrade.
            let status = ["new", "contacted", "viewed"][i];
            insert_legacy_v1_lead(
                db_path,
                &LegacyLead {
                    id: &lead_id,
                    radar_id: &radar.radar.id,
                    radar_version_id: &radar.current_version.id,
                    post_id: &post.id,
                    evaluation_id: &ev.id,
                    contact_id: contact_id.as_deref(),
                    status,
                    score,
                    summary: *text,
                    fields_json: &serde_json::to_string(&fields).unwrap(),
                    now_ms: T + n,
                },
            );
        } else {
            store
                .create_lead(&CreateLeadInput {
                    id: Some(lead_id.clone()),
                    radar_id: radar.radar.id.clone(),
                    radar_version_id: radar.current_version.id.clone(),
                    post_id: post.id.clone(),
                    evaluation_id: ev.id.clone(),
                    contact_id,
                    status: "new".into(),
                    score,
                    summary: (*text).into(),
                    fields,
                    also_seen_in: None,
                    notified_at: None,
                    follow_up_at: None,
                    note: None,
                    tags: None,
                    now_ms: T + n,
                })
                .unwrap();
        }
        leads.push(lead_id);
    }
    (sid, radar, leads)
}

struct LegacyLead<'a> {
    id: &'a str,
    radar_id: &'a str,
    radar_version_id: &'a str,
    post_id: &'a str,
    evaluation_id: &'a str,
    contact_id: Option<&'a str>,
    status: &'a str,
    score: f64,
    summary: &'a str,
    fields_json: &'a str,
    now_ms: i64,
}

/// Inserts a lead (and its `created` event) using only the schema-0001 columns.
fn insert_legacy_v1_lead(db_path: &Path, lead: &LegacyLead<'_>) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute(
        "INSERT INTO leads (
           id, radar_id, radar_version_id, post_id, evaluation_id, contact_id,
           status, score, summary, fields, also_seen_in,
           notified_at, follow_up_at, note, tags, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL, NULL, NULL, ?11, ?11)",
        rusqlite::params![
            lead.id,
            lead.radar_id,
            lead.radar_version_id,
            lead.post_id,
            lead.evaluation_id,
            lead.contact_id,
            lead.status,
            lead.score,
            lead.summary,
            lead.fields_json,
            lead.now_ms,
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lead_events (id, lead_id, kind, data, created_at) VALUES (?1, ?2, 'created', ?3, ?4)",
        rusqlite::params![
            format!("{}-created", lead.id),
            lead.id,
            json!({ "score": lead.score }).to_string(),
            lead.now_ms,
        ],
    )
    .unwrap();
}

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).expect("usage: gen-tauri-fixture <out-dir>"));
    std::fs::create_dir_all(&out).unwrap();
    let scratch = out.join(".scratch");
    let _ = std::fs::remove_dir_all(&scratch);

    // --- schema v1 database written by the Rust store ---------------------------------------
    let v1_path = out.join("tauri-v1.sqlite3");
    let _ = std::fs::remove_file(&v1_path);
    {
        let store = Store::open_with_migrations(&v1_path, scratch.join("bk1"), &MIGRATIONS[..1]).unwrap();
        let _ = seed(&store, Some(&v1_path));
        store.set_setting("launch_at_login", &true).unwrap();
    }

    // --- schema v3 database + golden query results ------------------------------------------
    let v3_path = out.join("tauri-v3.sqlite3");
    let _ = std::fs::remove_file(&v3_path);
    let store = Store::open(&v3_path, scratch.join("bk3")).unwrap();
    let (sid, radar, leads) = seed(&store, None);
    store.set_setting("launch_at_login", &true).unwrap();
    let ch = store
        .channel_upsert("01CHAN0000000000000000001", "webhook", "Hook", &json!({"url": "https://example.test/h"}), "ok", T)
        .unwrap();
    store
        .enqueue_outbox(&EnqueueOutboxInput {
            id: Some("01OUTBOX00000000000000001".into()),
            channel_id: ch.id.clone(),
            lead_id: Some(leads[0].clone()),
            kind: "lead".into(),
            payload: json!({"lead_id": leads[0]}),
            next_try_at: T,
            now_ms: T,
        })
        .unwrap();
    store.enqueue_job("evaluate_batch", Some("k1"), &json!({"n": 1}), T, T).unwrap();

    let query = |q: LeadListQuery| serde_json::to_value(store.lead_list(&q).unwrap()).unwrap();
    let base = || LeadListQuery { radar_id: Some(radar.radar.id.clone()), limit: 50, ..Default::default() };
    let golden: Value = json!({
        "ids": { "source": sid, "radar": radar.radar.id },
        "lead_list_default": query(base()),
        "lead_list_price_lte_100": query(LeadListQuery { filters: vec![LeadFieldFilter { field: "price".into(), op: FilterOp::Lte, value: json!(100.0) }], ..base() }),
        "lead_list_area_sort_asc": query(LeadListQuery { sort: Some(LeadSort { by: "area".into(), dir: SortDir::Asc }), ..base() }),
        "lead_list_search_thue": query(LeadListQuery { search: Some("thue".into()), ..base() }),
        "lead_list_page_1": query(LeadListQuery { limit: 2, ..base() }),
        "post_search_dong_da": serde_json::to_value(store.post_search("dong da", None, 10).unwrap().into_iter().map(|p| p.post.id).collect::<Vec<_>>()).unwrap(),
        "contact_list": serde_json::to_value(store.contact_list(None, 10).unwrap()).unwrap(),
        "contact_search_phone": serde_json::to_value(store.contact_list(Some("0912"), 10).unwrap().len()).unwrap(),
        "radar_get": serde_json::to_value(store.radar_get(&radar.radar.id).unwrap()).unwrap(),
        "source_list": serde_json::to_value(store.source_list(T + 1000).unwrap()).unwrap(),
        "radar_stats": serde_json::to_value(store.radar_stats(Some(&radar.radar.id), T + 1000).unwrap()).unwrap(),
        "lead_get_1": serde_json::to_value(store.lead_get(&leads[0]).unwrap()).unwrap(),
        "table_row_counts": serde_json::to_value(store.table_row_counts().unwrap()).unwrap(),
    });
    std::fs::write(out.join("golden.json"), serde_json::to_string_pretty(&golden).unwrap()).unwrap();
    drop(store);
    let _ = std::fs::remove_dir_all(&scratch);
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", v3_path.display()));
        let _ = std::fs::remove_file(format!("{}{suffix}", v1_path.display()));
    }
    println!("wrote {}", out.display());
}
