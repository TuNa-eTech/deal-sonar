//! Upgrading DealSonar must keep the customer's data and keep the pipeline working. This test
//! builds a database exactly as the *oldest* schema wrote it (migration 0001 only, populated with a
//! source, an active radar, a post, and a lead), then opens it with the current build the way the
//! installed app does after an in-place upgrade, and checks that:
//!   * a pre-migration backup of the old data is taken,
//!   * the radar and the old lead are still readable,
//!   * a stale native-host manifest (app moved/updated) is repaired without losing the pairing,
//!   * a new post is collected, evaluated and notified through the normal pipeline.
//!
//! It simulates the upgrade at the data layer. It is NOT evidence of an installer-level upgrade on
//! a real Windows or macOS machine; see docs/delivery/05-upgrade-and-recovery.md.

use std::path::Path;
use std::sync::{Arc, Mutex};

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{LeadFilterQuery, RadarStatus};
use dealsonar_core::{CoreConfig, CoreServiceBuilder, OsNotification, DEFAULT_CHROME_EXTENSION_ID};
use dealsonar_protocol::native_manifest::NativeHostManifest;
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_store::models::{
    now_ms, AuthorInput, DiscoveredSourceInput, FieldDef, MatchPolicy, NewPost, NotifyConfig,
};
use dealsonar_store::{Store, LATEST_SCHEMA_VERSION, MIGRATIONS};
use serde_json::json;

const OLD_LEAD_ID: &str = "lead-from-previous-release";

fn money_field() -> FieldDef {
    serde_json::from_value(json!({
        "key": "budget", "label": "Ngân sách", "type": "money",
        "description": "Ngân sách thuê", "required": false, "options": null,
        "show_in_alert": true, "order": 0
    }))
    .expect("field def")
}

/// A database as written by the previous release: schema 0001 only.
fn write_previous_release_db(db: &Path, backups: &Path, now: i64) -> (String, String) {
    let store = Store::open_with_migrations(db, backups, &MIGRATIONS[..1]).expect("old schema");
    store
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".into(),
                kind: "group".into(),
                external_id: "grp_upgrade".into(),
                name: "Thuê nhà Cầu Giấy".into(),
                url: "https://www.facebook.com/groups/grp_upgrade".into(),
                privacy: Some("public".into()),
                member_count: None,
            }],
            Some(true),
            None,
            now,
        )
        .expect("source");
    let source_id = store.source_list(now).expect("sources")[0]
        .source
        .id
        .clone();
    let (post, _) = store
        .insert_post(&NewPost {
            id: None,
            platform: "facebook".into(),
            external_id: "old_post".into(),
            source_id: source_id.clone(),
            author: Some(AuthorInput {
                external_id: Some("uid_old".into()),
                name: "Người đăng cũ".into(),
                is_anonymous: false,
            }),
            permalink: "https://www.facebook.com/groups/grp_upgrade/posts/old_post/".into(),
            text: Some("Cần thuê căn hộ 2PN Cầu Giấy ngân sách 10 triệu".into()),
            text_norm: Some("can thue can ho 2pn cau giay ngan sach 10 trieu".into()),
            text_fold: Some("can thue can ho 2pn cau giay ngan sach 10 trieu".into()),
            text_truncated: false,
            lang: Some("vi".into()),
            content_hash: "old-hash".into(),
            simhash: 11,
            attachments: None,
            counts: None,
            extracted_phones: Vec::new(),
            created_at: Some(now - 86_400_000),
            captured_at: now - 86_400_000,
            strategy: "network".into(),
        })
        .expect("post");
    drop(store);

    // The radar is written with the schema-0001 columns only. Going through the current store API
    // would fail here because it also writes columns added by later migrations (e.g. `variant_of`).
    let (radar_id, version_id) = (
        "radar-from-previous-release",
        "radar-version-from-previous-release",
    );
    let conn = rusqlite::Connection::open(db).expect("raw db");
    conn.execute(
        "INSERT INTO radars (id,name,status,template_id,current_version,notify,created_at,updated_at)
         VALUES (?1,'Khách thuê căn hộ','draft',NULL,1,?2,?3,?3)",
        rusqlite::params![
            radar_id,
            serde_json::to_string(&NotifyConfig::default()).expect("notify"),
            now - 86_400_000
        ],
    )
    .expect("radar");
    conn.execute(
        "INSERT INTO radar_versions (id,radar_id,version,description,language_hint,user_profession,fields,match_policy,created_at)
         VALUES (?1,?2,1,'Tìm khách cần thuê căn hộ Cầu Giấy','vi','Môi giới cho thuê',?3,?4,?5)",
        rusqlite::params![
            version_id,
            radar_id,
            serde_json::to_string(&vec![money_field()]).expect("fields"),
            serde_json::to_string(&MatchPolicy::default()).expect("policy"),
            now - 86_400_000
        ],
    )
    .expect("radar version");
    conn.execute(
        "INSERT INTO radar_sources (radar_id,source_id) VALUES (?1,?2)",
        rusqlite::params![radar_id, source_id],
    )
    .expect("radar source");
    conn.execute(
        "INSERT INTO evaluations (id,post_id,radar_version_id,state,decided_by,verdict,score,summary,fields,is_preview,created_at,decided_at)
         VALUES ('eval-old',?1,?2,'done','ai','match',0.9,'Khách thuê Cầu Giấy','{}',0,?3,?3)",
        rusqlite::params![post.id, version_id, now - 86_400_000],
    )
    .expect("evaluation");
    conn.execute(
        "INSERT INTO leads (id,radar_id,radar_version_id,post_id,evaluation_id,status,score,summary,fields,created_at,updated_at)
         VALUES (?1,?2,?3,?4,'eval-old','new',0.9,'Khách thuê Cầu Giấy','{}',?5,?5)",
        rusqlite::params![
            OLD_LEAD_ID,
            radar_id,
            version_id,
            post.id,
            now - 86_400_000
        ],
    )
    .expect("lead");
    conn.execute(
        "UPDATE radars SET status = 'active' WHERE id = ?1",
        [radar_id],
    )
    .expect("activate");
    (radar_id.to_string(), source_id)
}

fn raw_post(post_id: &str, text: &str, now: i64) -> RawPost {
    RawPost {
        platform: "facebook".into(),
        source_external_id: "grp_upgrade".into(),
        post_id: post_id.into(),
        permalink: format!("https://www.facebook.com/groups/grp_upgrade/posts/{post_id}"),
        author: AuthorInfo {
            name: "Thu Hà".into(),
            external_id: Some(format!("uid_{post_id}")),
            is_anonymous: false,
        },
        text: text.into(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(now - 60_000),
        captured_at: now - 1_000,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgrade_keeps_radar_and_leads_repairs_pairing_and_still_notifies_new_posts() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("dealsonar.db");
    let backups = tmp.path().join("backups");
    let now = now_ms();
    let (radar_id, source_id) = write_previous_release_db(&db, &backups, now);

    // The previous release had paired Chrome and registered a manifest for an install location
    // that the new installer no longer uses.
    let manifest_path = tmp
        .path()
        .join("NativeMessagingHosts/com.dealsonar.host.json");
    let old_bin = tmp.path().join("old-location/dealsonar-native-host");
    std::fs::create_dir_all(old_bin.parent().unwrap()).unwrap();
    std::fs::write(&old_bin, b"old").unwrap();
    let stale = NativeHostManifest::new(DEFAULT_CHROME_EXTENSION_ID, &old_bin).unwrap();
    dealsonar_protocol::native_manifest::write_manifest_file(&manifest_path, &stale).unwrap();
    let new_bin = tmp
        .path()
        .join("Applications/DealSonar/dealsonar-native-host");
    std::fs::create_dir_all(new_bin.parent().unwrap()).unwrap();
    std::fs::write(&new_bin, b"new").unwrap();

    // --- The customer installs the new version over the old one and opens the app ---
    let upgraded = Store::open(&db, &backups).expect("new build opens the old database");
    assert_eq!(
        upgraded.list_schema_migrations().unwrap().len(),
        LATEST_SCHEMA_VERSION as usize,
        "all migrations applied"
    );
    let backup_files: Vec<_> = std::fs::read_dir(&backups)
        .expect("a pre-migration backup directory exists")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        backup_files
            .iter()
            .any(|n| n.starts_with("dealsonar-pre-v0002-")),
        "old data was backed up before migrating: {backup_files:?}"
    );

    let service = CoreServiceBuilder::new(upgraded)
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            batch_trigger_count: 1,
            batch_max_wait_ms: 0,
            spawn_background_workers: false,
            chrome_manifest_path: Some(manifest_path.clone()),
            native_host_binary_path: Some(new_bin.clone()),
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service");
    let notified: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notified);
    service.set_os_notification_hook(Some(Arc::new(move |n: OsNotification| {
        sink.lock().unwrap().push(n.lead_id);
    })));

    // Pairing is repaired automatically at startup; nothing to retype.
    assert!(service
        .refresh_native_host_manifest_if_paired()
        .expect("refresh"));
    let repaired: NativeHostManifest =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    assert_eq!(repaired.path, new_bin.to_string_lossy());
    assert!(repaired.allowed_origins.contains(&format!(
        "chrome-extension://{DEFAULT_CHROME_EXTENSION_ID}/"
    )));

    // Reopen the radar and read the old lead.
    let radar = service.radar_get(&radar_id).expect("radar survives");
    assert_eq!(radar.radar.name, "Khách thuê căn hộ");
    assert_eq!(radar.radar.status, RadarStatus::Active);
    let leads = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(radar_id.clone()),
            ..Default::default()
        })
        .expect("leads");
    assert_eq!(leads.items.len(), 1);
    assert_eq!(leads.items[0].id, OLD_LEAD_ID);
    assert_eq!(leads.items[0].summary, "Khách thuê Cầu Giấy");
    service
        .lead_get(OLD_LEAD_ID)
        .expect("old lead detail opens");

    // Collect one new post and confirm the notification path still works.
    let source = service.store().source_get(&source_id).unwrap().unwrap();
    dealsonar_core::pipeline::ingest_raw_post(
        service.runtime(),
        &source,
        &raw_post(
            "new_post",
            "Mình cần thuê căn hộ 2PN Cầu Giấy tài chính 10 triệu/tháng dọn vào ngay LH 0912999888",
            now,
        ),
        now,
    )
    .expect("ingest");
    service.tick_workers_now().await.expect("tick");

    let leads = service
        .lead_list(LeadFilterQuery {
            radar_id: Some(radar_id),
            ..Default::default()
        })
        .expect("leads after new post");
    assert_eq!(leads.items.len(), 2, "old lead kept, new lead created");
    let new_lead = leads
        .items
        .iter()
        .find(|l| l.id != OLD_LEAD_ID)
        .expect("new lead");
    assert!(
        notified.lock().unwrap().contains(&new_lead.id),
        "the new lead was notified after the upgrade"
    );
    service.shutdown().await.expect("shutdown");
}

#[test]
fn every_checked_in_release_database_still_migrates_and_opens() {
    // Each release should add `crates/store/tests/fixtures/releases/<tag>.sqlite3` (see the README
    // next to it). Every one must upgrade in place and keep its row counts.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../store/tests/fixtures/releases");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
            continue;
        }
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("copy.db");
        std::fs::copy(&path, &work).unwrap();
        let before = rusqlite::Connection::open(&work)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM leads", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0);
        let store = Store::open(&work, tmp.path().join("backups"))
            .unwrap_or_else(|e| panic!("{} no longer upgrades: {e}", path.display()));
        let after = store
            .table_row_counts()
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
            .get("leads")
            .copied()
            .unwrap_or(0);
        assert_eq!(
            before,
            after,
            "{} lost leads while upgrading",
            path.display()
        );
    }
}
