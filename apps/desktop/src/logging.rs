//! Structured rotating file logging & 7-day log retention (`03-desktop.md §2, §6`).
//!
//! Privacy invariant: never log post bodies, Telegram bot tokens, webhook secrets,
//! or license keys.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Default log file retention period in days (`03-desktop.md §6`).
pub const LOG_RETENTION_DAYS: u64 = 7;

/// Prefix for daily rotating log files inside `<data_dir>/logs/`.
pub const LOG_FILE_PREFIX: &str = "dealsonar.log";

/// Prunes rotated log files inside `logs_dir` whose last-modified timestamp is strictly
/// older than `retention_days` days. Returns the count of deleted log files.
pub fn prune_old_logs(logs_dir: &Path, retention_days: u64) -> io::Result<usize> {
    if !logs_dir.exists() {
        return Ok(0);
    }

    let max_age = Duration::from_secs(retention_days.saturating_mul(86_400));
    let now = SystemTime::now();
    let mut deleted = 0usize;

    for entry in fs::read_dir(logs_dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !(name.starts_with(LOG_FILE_PREFIX) || name.ends_with(".log")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > max_age && fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }

    Ok(deleted)
}

/// Initializes daily rotating structured JSON file logs in `logs_dir` and prunes
/// log files older than 7 days (`03-desktop.md §6`).
///
/// Safe to call multiple times in tests (`try_init()` ignores duplicate global subscriber errors).
pub fn init_logging(logs_dir: &Path) -> io::Result<WorkerGuard> {
    fs::create_dir_all(logs_dir)?;
    let _ = prune_old_logs(logs_dir, LOG_RETENTION_DAYS);

    let file_appender = tracing_appender::rolling::daily(logs_dir, LOG_FILE_PREFIX);
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_env("DEALSONAR_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| {
            EnvFilter::new("info,dealsonar=info,dealsonar_desktop=info,dealsonar_core=info")
        });

    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_target(true)
        .with_writer(non_blocking);

    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .try_init();

    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn prunes_logs_older_than_seven_days_and_keeps_recent_logs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let old_log = dir.path().join("dealsonar.log.2020-01-01");
        let recent_log = dir.path().join("dealsonar.log.today");
        let unrelated = dir.path().join("keep.txt");

        fs::write(&old_log, b"{\"level\":\"INFO\",\"message\":\"boot\"}\n").unwrap();
        fs::write(
            &recent_log,
            b"{\"level\":\"INFO\",\"message\":\"recent\"}\n",
        )
        .unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        #[cfg(unix)]
        {
            let status = Command::new("touch")
                .args(["-t", "202001010000", old_log.to_str().unwrap()])
                .status()
                .expect("touch old log");
            assert!(status.success());

            let status_txt = Command::new("touch")
                .args(["-t", "202001010000", unrelated.to_str().unwrap()])
                .status()
                .expect("touch unrelated");
            assert!(status_txt.success());
        }

        let pruned = prune_old_logs(dir.path(), LOG_RETENTION_DAYS).expect("prune");
        #[cfg(unix)]
        {
            assert_eq!(pruned, 1);
            assert!(!old_log.exists(), "old log must be pruned");
        }
        assert!(recent_log.exists(), "recent log must be preserved");
        assert!(unrelated.exists(), "non-log files must not be deleted");
    }
}
