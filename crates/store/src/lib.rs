pub mod contacts;
pub mod leads;
pub mod models;
pub mod ops;
pub mod posts;
pub mod radars;
pub mod sources;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection};
use thiserror::Error;

pub use models::*;

/// Embedded numbered SQL migration definition.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Canonical migrations shipped with this binary.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "0001_init",
    sql: include_str!("../migrations/0001_init.sql"),
}];

/// Latest schema version supported by this binary.
pub const LATEST_SCHEMA_VERSION: i32 = 1;

/// Maximum number of pre-migration automatic backups retained in `backups/`.
pub const MAX_PRE_MIGRATION_BACKUPS: usize = 5;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error(
        "database schema version {db_version} is newer than supported version {app_version}; please update DealSonar"
    )]
    NewerSchemaVersion { db_version: i32, app_version: i32 },

    #[error("invalid dynamic field key '{0}'")]
    InvalidFieldKey(String),

    #[error("unknown field '{field}' for radar {radar_id:?}")]
    UnknownRadarField {
        radar_id: Option<String>,
        field: String,
    },

    #[error("invalid filter value for field '{field}' ({op}): {message}")]
    InvalidFilterValue {
        field: String,
        op: String,
        message: String,
    },

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("store connection mutex poisoned")]
    LockPoisoned,
}

struct StoreInner {
    conn: Mutex<Connection>,
    db_path: Option<PathBuf>,
    backup_dir: Option<PathBuf>,
}

/// Thread-safe (`Clone + Send + Sync`) SQLite persistence handle for DealSonar.
#[derive(Clone)]
pub struct Store {
    inner: Arc<StoreInner>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("db_path", &self.inner.db_path)
            .field("backup_dir", &self.inner.backup_dir)
            .finish()
    }
}

impl Store {
    /// Open an in-memory SQLite store with all migrations applied.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        configure_connection(&conn)?;
        apply_migrations(&mut conn, None, MIGRATIONS)?;
        Ok(Self {
            inner: Arc::new(StoreInner {
                conn: Mutex::new(conn),
                db_path: None,
                backup_dir: None,
            }),
        })
    }

    /// Open a file-backed SQLite store in WAL mode, guarding against newer schemas and
    /// creating automatic pre-migration backups before upgrading existing databases.
    pub fn open(
        db_path: impl AsRef<Path>,
        backup_dir: impl AsRef<Path>,
    ) -> Result<Self, StoreError> {
        Self::open_with_migrations(db_path, backup_dir, MIGRATIONS)
    }

    /// Open a file-backed SQLite store with a custom migration table (used by `Store::open`
    /// and multi-version migration/backup tests).
    pub fn open_with_migrations(
        db_path: impl AsRef<Path>,
        backup_dir: impl AsRef<Path>,
        migrations: &[Migration],
    ) -> Result<Self, StoreError> {
        let db_path = db_path.as_ref().to_path_buf();
        let backup_dir = backup_dir.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }

        let mut conn = Connection::open(&db_path)?;
        configure_connection(&conn)?;
        apply_migrations(&mut conn, Some(&backup_dir), migrations)?;

        Ok(Self {
            inner: Arc::new(StoreInner {
                conn: Mutex::new(conn),
                db_path: Some(db_path),
                backup_dir: Some(backup_dir),
            }),
        })
    }

    pub(crate) fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.inner.conn.lock().map_err(|_| StoreError::LockPoisoned)
    }

    /// Return applied migrations ordered by version.
    pub fn list_schema_migrations(&self) -> Result<Vec<SchemaMigrationRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SchemaMigrationRecord {
                    version: row.get(0)?,
                    name: row.get(1)?,
                    applied_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Return current `PRAGMA journal_mode` (e.g. `"wal"` for file-backed stores).
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let conn = self.lock_conn()?;
        let mode: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0))?;
        Ok(mode.to_lowercase())
    }

    /// Perform an online hot backup of the SQLite database to `dest_path`.
    pub fn backup_database(&self, dest_path: impl AsRef<Path>) -> Result<(), StoreError> {
        let conn = self.lock_conn()?;
        backup_connection_to_path(&conn, dest_path.as_ref())
    }

    /// Run SQLite FTS5 `'integrity-check'` on both `posts_fts` and `leads_fts` external-content indexes.
    pub fn verify_fts_integrity(&self) -> Result<(), StoreError> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')",
            [],
        )?;
        conn.execute(
            "INSERT INTO leads_fts(leads_fts) VALUES ('integrity-check')",
            [],
        )?;
        Ok(())
    }

    /// Daily retention cleanup (`04-data-model.md §5`):
    /// - Unmatched posts older than `unmatched_retention_days`: null out `text`, `text_norm`,
    ///   `text_fold`, `attachments`, `extracted_phones`, record `purged_at = now_ms`, while
    ///   preserving `content_hash` and `simhash` for deduplication.
    /// - Evaluations of purged posts: scrub `summary`, `reason`, `fields` while keeping row.
    /// - `crawl_runs` & `ai_calls` older than 90 days: delete rows.
    /// - Completed `jobs` & sent/dropped `outbox` older than 14 days: delete rows.
    /// - Authors with no remaining posts keeping content: delete rows.
    pub fn purge_expired(
        &self,
        now_ms: i64,
        unmatched_retention_days: u32,
    ) -> Result<PurgeReport, StoreError> {
        const DAY_MS: i64 = 86_400_000;
        let post_cutoff = now_ms.saturating_sub(i64::from(unmatched_retention_days) * DAY_MS);
        let cutoff_90d = now_ms.saturating_sub(90 * DAY_MS);
        let cutoff_14d = now_ms.saturating_sub(14 * DAY_MS);

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let posts_purged = tx.execute(
            "UPDATE posts
             SET text = NULL,
                 text_norm = NULL,
                 text_fold = NULL,
                 attachments = NULL,
                 extracted_phones = NULL,
                 purged_at = ?1
             WHERE purged_at IS NULL
               AND captured_at < ?2
               AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.post_id = posts.id)",
            params![now_ms, post_cutoff],
        )?;

        let evaluations_scrubbed = tx.execute(
            "UPDATE evaluations
             SET summary = NULL,
                 reason = NULL,
                 fields = NULL
             WHERE post_id IN (SELECT id FROM posts WHERE purged_at IS NOT NULL)
               AND (summary IS NOT NULL OR reason IS NOT NULL OR fields IS NOT NULL)",
            [],
        )?;

        let crawl_runs_deleted = tx.execute(
            "DELETE FROM crawl_runs WHERE started_at < ?1",
            params![cutoff_90d],
        )?;

        tx.execute(
            "UPDATE evaluations
             SET ai_call_id = NULL
             WHERE ai_call_id IN (SELECT id FROM ai_calls WHERE created_at < ?1)",
            params![cutoff_90d],
        )?;

        let ai_calls_deleted = tx.execute(
            "DELETE FROM ai_calls WHERE created_at < ?1",
            params![cutoff_90d],
        )?;

        let jobs_deleted = tx.execute(
            "DELETE FROM jobs WHERE state IN ('done', 'failed') AND created_at < ?1",
            params![cutoff_14d],
        )?;

        let outbox_deleted = tx.execute(
            "DELETE FROM outbox
             WHERE state IN ('sent', 'dropped')
               AND COALESCE(sent_at, created_at) < ?1",
            params![cutoff_14d],
        )?;

        // Detach purged posts from authors that no longer have any content-bearing posts,
        // then remove those orphan author rows.
        tx.execute(
            "UPDATE posts
             SET author_id = NULL
             WHERE author_id IS NOT NULL
               AND text IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM posts p2
                 WHERE p2.author_id = posts.author_id AND p2.text IS NOT NULL
               )",
            [],
        )?;

        let authors_deleted = tx.execute(
            "DELETE FROM authors
             WHERE NOT EXISTS (
               SELECT 1 FROM posts p
               WHERE p.author_id = authors.id AND p.text IS NOT NULL
             )",
            [],
        )?;

        tx.commit()?;

        Ok(PurgeReport {
            posts_purged,
            evaluations_scrubbed,
            crawl_runs_deleted,
            ai_calls_deleted,
            jobs_deleted,
            outbox_deleted,
            authors_deleted,
        })
    }

    /// Delete all user data in the database and remove stored backups in `backup_dir` (`04-data-model.md §5`).
    pub fn delete_all_data(&self) -> Result<(), StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        // Delete in reverse foreign-key order for cleanliness.
        for table in [
            "jobs",
            "outbox",
            "blocklist",
            "feedback",
            "lead_events",
            "leads",
            "evaluations",
            "ai_calls",
            "rulesets",
            "radar_sources",
            "radar_versions",
            "radars",
            "posts",
            "crawl_runs",
            "sources",
            "authors",
            "dup_clusters",
            "contacts",
            "channels",
            "settings",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }

        // Rebuild FTS5 indexes to ensure zero residual tokens.
        tx.execute("INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')", [])?;
        tx.execute("INSERT INTO leads_fts(leads_fts) VALUES ('rebuild')", [])?;
        tx.commit()?;

        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");

        if let Some(backup_dir) = &self.inner.backup_dir {
            if backup_dir.exists() {
                for entry in fs::read_dir(backup_dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.is_file() {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }

        Ok(())
    }

    /// Remove SQLite `.db`, `-wal`, `-shm` files and backup files from disk after closing `Store`.
    pub fn destroy_files(
        db_path: impl AsRef<Path>,
        backup_dir: impl AsRef<Path>,
    ) -> Result<(), StoreError> {
        let db_path = db_path.as_ref();
        for suffix in ["", "-wal", "-shm"] {
            let candidate = PathBuf::from(format!("{}{suffix}", db_path.display()));
            if candidate.exists() {
                fs::remove_file(candidate)?;
            }
        }
        let backup_dir = backup_dir.as_ref();
        if backup_dir.exists() {
            fs::remove_dir_all(backup_dir)?;
        }
        Ok(())
    }

    /// Return row counts of all application tables for diagnostic bundles (`03-desktop.md §6`).
    pub fn table_row_counts(&self) -> Result<BTreeMap<String, i64>, StoreError> {
        const APP_TABLES: &[&str] = &[
            "ai_calls",
            "authors",
            "blocklist",
            "channels",
            "contacts",
            "crawl_runs",
            "dup_clusters",
            "evaluations",
            "feedback",
            "jobs",
            "lead_events",
            "leads",
            "outbox",
            "posts",
            "radar_sources",
            "radar_versions",
            "radars",
            "rulesets",
            "schema_migrations",
            "settings",
            "sources",
        ];

        let conn = self.lock_conn()?;
        let mut counts = BTreeMap::new();
        for table in APP_TABLES {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
            counts.insert((*table).to_string(), count);
        }
        Ok(counts)
    }
}

fn configure_connection(conn: &Connection) -> Result<(), StoreError> {
    conn.busy_timeout(Duration::from_millis(5000))?;
    let _: String = conn.query_row("PRAGMA journal_mode = WAL;", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;

    // Register deterministic Vietnamese diacritic-insensitive & case-insensitive substring matcher.
    conn.create_scalar_function(
        "dealsonar_fold_contains",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let haystack: Option<String> = ctx.get(0)?;
            let needle: Option<String> = ctx.get(1)?;
            match (haystack, needle) {
                (Some(h), Some(n)) => {
                    let h_fold = fold_vi(&h);
                    let n_fold = fold_vi(&n);
                    if n_fold.is_empty() {
                        Ok(1i64)
                    } else {
                        Ok(i64::from(h_fold.contains(&n_fold)))
                    }
                }
                _ => Ok(0i64),
            }
        },
    )?;

    Ok(())
}

fn apply_migrations(
    conn: &mut Connection,
    backup_dir: Option<&Path>,
    migrations: &[Migration],
) -> Result<(), StoreError> {
    let latest_known = migrations.iter().map(|m| m.version).max().unwrap_or(0);

    let has_migrations_table: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
         )",
        [],
        |r| r.get(0),
    )?;

    let db_version: i32 = if has_migrations_table {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?
    } else {
        0
    };

    if db_version > latest_known {
        return Err(StoreError::NewerSchemaVersion {
            db_version,
            app_version: latest_known,
        });
    }

    let mut pending: Vec<&Migration> = migrations
        .iter()
        .filter(|m| m.version > db_version)
        .collect();
    pending.sort_by_key(|m| m.version);

    if pending.is_empty() {
        return Ok(());
    }

    let user_tables: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name != 'schema_migrations'",
        [],
        |r| r.get(0),
    )?;

    let is_existing_non_empty = db_version > 0 || user_tables > 0;

    if is_existing_non_empty {
        if let Some(dir) = backup_dir {
            create_pre_migration_backup(conn, dir, pending[0].version)?;
            prune_pre_migration_backups(dir, MAX_PRE_MIGRATION_BACKUPS)?;
        }
    }

    for m in pending {
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![m.version, m.name, now_ms()],
        )?;
        tx.commit()?;
    }

    Ok(())
}

fn create_pre_migration_backup(
    conn: &Connection,
    backup_dir: &Path,
    next_version: i32,
) -> Result<PathBuf, StoreError> {
    fs::create_dir_all(backup_dir)?;
    let mut ts = now_ms();
    let dest = loop {
        let candidate = backup_dir.join(format!("dealsonar-pre-v{next_version:04}-{ts}.db"));
        if !candidate.exists() {
            break candidate;
        }
        ts += 1;
    };
    backup_connection_to_path(conn, &dest)?;
    Ok(dest)
}

fn prune_pre_migration_backups(backup_dir: &Path, keep: usize) -> Result<(), StoreError> {
    if !backup_dir.exists() {
        return Ok(());
    }
    let mut backups: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(backup_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.starts_with("dealsonar-pre-v") && name.ends_with(".db") {
                // Sort key uses timestamp portion `<ts>` then full filename so chronological order holds
                // even across v0002 -> v0010!
                let ts_key = name
                    .strip_suffix(".db")
                    .and_then(|stem| stem.rsplit('-').next())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                backups.push((format!("{ts_key:020}-{name}"), path));
            }
        }
    }

    backups.sort_by(|a, b| a.0.cmp(&b.0));
    if backups.len() > keep {
        let remove_count = backups.len() - keep;
        for (_, old_path) in backups.into_iter().take(remove_count) {
            let _ = fs::remove_file(old_path);
        }
    }
    Ok(())
}

fn backup_connection_to_path(src: &Connection, dest_path: &Path) -> Result<(), StoreError> {
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    if dest_path.exists() {
        fs::remove_file(dest_path)?;
    }
    let mut dst = Connection::open(dest_path)?;
    {
        let backup = Backup::new(src, &mut dst)?;
        backup.run_to_completion(256, Duration::from_millis(10), None)?;
    }
    Ok(())
}
