//! Soak-run report from a DealSonar database. Opens the database read-only.
//!
//! ```text
//! dealsonar-soak-report --db ~/…/dealsonar.db --label "10 group sôi động" \
//!     --interruptions interruptions.json --format markdown --out report.md
//! ```
//!
//! `interruptions.json` is an array of `{ "kind", "start_ms", "end_ms", "note" }`; see
//! `docs/delivery/04-soak-runbook.md`.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use dealsonar_store::soak::{build_soak_report, render_markdown, Interruption, SoakOptions};
use rusqlite::{Connection, OpenFlags};

const USAGE: &str = "Usage: dealsonar-soak-report --db <dealsonar.db> [--label <name>] \
[--from-ms <epoch ms>] [--until-ms <epoch ms>] [--now-ms <epoch ms>] \
[--interruptions <file.json>] [--slow-minutes <n>] [--rules-active-from-ms <epoch ms>] \
[--format markdown|json] [--out <file>]";

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut db: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut format = "markdown".to_string();
    let mut interruptions_file: Option<PathBuf> = None;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let mut opts = SoakOptions::new(now);

    while let Some(flag) = args.next() {
        let mut value = |name: &str| {
            args.next()
                .ok_or_else(|| format!("{name} needs a value\n{USAGE}"))
        };
        let number = |name: &str, v: String| -> Result<i64, String> {
            v.parse::<i64>()
                .map_err(|_| format!("{name} expects an integer, got '{v}'"))
        };
        match flag.as_str() {
            "--db" => db = Some(value("--db")?.into()),
            "--out" => out = Some(value("--out")?.into()),
            "--format" => format = value("--format")?,
            "--label" => opts.label = Some(value("--label")?),
            "--interruptions" => interruptions_file = Some(value("--interruptions")?.into()),
            "--from-ms" => opts.from_ms = Some(number("--from-ms", value("--from-ms")?)?),
            "--until-ms" => opts.until_ms = Some(number("--until-ms", value("--until-ms")?)?),
            "--now-ms" => opts.now_ms = number("--now-ms", value("--now-ms")?)?,
            "--rules-active-from-ms" => {
                opts.rules_active_from_ms = Some(number(
                    "--rules-active-from-ms",
                    value("--rules-active-from-ms")?,
                )?)
            }
            "--slow-minutes" => {
                opts.slow_after_ms = number("--slow-minutes", value("--slow-minutes")?)? * 60_000
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => return Err(format!("unknown argument '{other}'\n{USAGE}")),
        }
    }
    let db = db.ok_or_else(|| format!("--db is required\n{USAGE}"))?;
    if let Some(path) = interruptions_file {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        opts.interruptions = serde_json::from_str::<Vec<Interruption>>(&raw)
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }

    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("{}: {e}", db.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let report = build_soak_report(&conn, &opts).map_err(|e| e.to_string())?;

    let text = match format.as_str() {
        "markdown" | "md" => render_markdown(&report),
        "json" => serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
        other => return Err(format!("unknown format '{other}'\n{USAGE}")),
    };
    match out {
        Some(path) => {
            std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?
        }
        None => println!("{text}"),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
