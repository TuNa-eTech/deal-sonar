//! Redacted diagnostic bundle generator (`03-desktop.md §4`, `03-risks-compliance.md §4`).
//!
//! Creates a `.zip` archive containing:
//! - `version.json`: app version, protocol version, OS/arch, timestamp
//! - `health.json`: current 4-lamp health status (sanitized)
//! - `settings_redacted.json`: operational settings with zero tokens or secrets
//! - `table_counts.json`: row counts per SQLite table (`posts`, `leads`, `evaluations`, etc.)
//! - `schema_migrations.json`: applied SQLite schema migrations
//! - `logs/*`: recent `.log` files from `logs/` with any accidental token/key patterns scrubbed
//!
//! Privacy invariant: **zero** Telegram bot tokens, webhook secrets, license tokens, or raw
//! Facebook post/lead/contact content are ever included in the diagnostic bundle.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use dealsonar_protocol::PROTOCOL_VERSION;
use dealsonar_store::Store;
use serde_json::json;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::dto::{DiagnosticBundleResult, HealthStatus, Settings};
use crate::error::CoreResult;

/// Scrub any accidental secret-shaped substrings from log lines before bundling (`03-risks-compliance.md §4`).
pub fn scrub_log_text(raw: &str, extra_secrets: &[String]) -> String {
    static BOT_TOKEN_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:bot)?\b\d{6,12}:[A-Za-z0-9_-]{20,}\b")
            .expect("valid bot token regex")
    });
    static LICENSE_TOKEN_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\bDS1\.[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+").expect("valid DS1 regex")
    });
    static BEARER_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)(bearer\s+|whsec_|sk-[A-Za-z0-9_-]{12,})[^\s\x22\x27]*")
            .expect("valid bearer regex")
    });

    let mut scrubbed = raw.to_string();
    for secret in extra_secrets {
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            scrubbed = scrubbed.replace(trimmed, "[REDACTED]");
        }
    }
    scrubbed = BOT_TOKEN_RE
        .replace_all(&scrubbed, "[REDACTED_TELEGRAM_TOKEN]")
        .into_owned();
    scrubbed = LICENSE_TOKEN_RE
        .replace_all(&scrubbed, "[REDACTED_LICENSE_KEY]")
        .into_owned();
    scrubbed = BEARER_RE
        .replace_all(&scrubbed, "[REDACTED_SECRET]")
        .into_owned();
    scrubbed
}

/// Write a redacted `.zip` diagnostic bundle to `dest_path`.
pub fn create_diagnostic_bundle(
    store: &Store,
    health: &HealthStatus,
    settings: &Settings,
    logs_dir: Option<&Path>,
    dest_path: &Path,
    extra_secrets_to_scrub: &[String],
    now_ms: i64,
) -> CoreResult<DiagnosticBundleResult> {
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let file = File::create(dest_path)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);

    // 1. version.json
    let version_json = serde_json::to_vec_pretty(&json!({
        "app_name": "DealSonar",
        "app_version": env!("CARGO_PKG_VERSION"),
        "protocol_version": PROTOCOL_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "created_at": now_ms,
    }))?;
    zip.start_file("version.json", opts)?;
    zip.write_all(&version_json)?;

    // 2. health.json (scrubbed error strings)
    let mut safe_health = health.clone();
    if let Some(err) = &safe_health.ai_error {
        safe_health.ai_error = Some(scrub_log_text(err, extra_secrets_to_scrub));
    }
    let health_json = serde_json::to_vec_pretty(&safe_health)?;
    zip.start_file("health.json", opts)?;
    zip.write_all(&health_json)?;

    // 3. settings_redacted.json
    let settings_json = serde_json::to_vec_pretty(settings)?;
    zip.start_file("settings_redacted.json", opts)?;
    zip.write_all(&settings_json)?;

    // 4. table_counts.json (row counts ONLY — never post or lead rows!)
    let counts = store.table_row_counts()?;
    let counts_json = serde_json::to_vec_pretty(&counts)?;
    zip.start_file("table_counts.json", opts)?;
    zip.write_all(&counts_json)?;

    // 5. schema_migrations.json
    let migrations = store.list_schema_migrations()?;
    let migrations_json = serde_json::to_vec_pretty(&migrations)?;
    zip.start_file("schema_migrations.json", opts)?;
    zip.write_all(&migrations_json)?;

    // 6. logs/*.log (up to 5 most recent log files, capped to 512 KiB each, scrubbed)
    if let Some(dir) = logs_dir {
        if dir.is_dir() {
            let mut log_files: Vec<_> = fs::read_dir(dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.extension().and_then(|s| s.to_str()).is_some_and(|ext| {
                            ext.eq_ignore_ascii_case("log") || ext.eq_ignore_ascii_case("txt")
                        })
                })
                .collect();
            log_files.sort();
            for log_path in log_files.into_iter().rev().take(5) {
                if let Some(fname) = log_path.file_name().and_then(|s| s.to_str()) {
                    if let Ok(raw) = fs::read_to_string(&log_path) {
                        let tail = if raw.len() > 512 * 1024 {
                            let mut idx = raw.len() - 512 * 1024;
                            while !raw.is_char_boundary(idx) && idx < raw.len() {
                                idx += 1;
                            }
                            &raw[idx..]
                        } else {
                            raw.as_str()
                        };
                        let scrubbed = scrub_log_text(tail, extra_secrets_to_scrub);
                        zip.start_file(format!("logs/{fname}"), opts)?;
                        zip.write_all(scrubbed.as_bytes())?;
                    }
                }
            }
        }
    }

    let finished_file = zip.finish()?;
    finished_file.sync_all()?;
    let size_bytes = finished_file.metadata()?.len();

    Ok(DiagnosticBundleResult {
        path: dest_path.to_string_lossy().into_owned(),
        size_bytes,
        created_at: now_ms,
    })
}
