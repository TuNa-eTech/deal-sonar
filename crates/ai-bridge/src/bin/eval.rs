use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;
use std::sync::Arc;

use dealsonar_ai_bridge::eval::{
    builtin_bds_eval_suite, compute_stability, fnv1a64_hex, format_eval_report,
    format_stability_report, parse_golden_jsonl, parse_radar_context_json, run_offline_eval,
    threshold_checks, EvalRunReport,
};
use dealsonar_ai_bridge::{
    AgyCliProvider, AiBridge, AiProvider, ClaudeCliProvider, CliAdapterConfig, CodexCliProvider,
    MockAiProvider, ModelTier, ModelTierMap, ProviderId,
};

fn print_help() {
    println!(
        "\
DealSonar Offline AI Quality Evaluator (`06-ai-bridge.md §8`)

USAGE:
  cargo run -p dealsonar-ai-bridge --bin eval -- [OPTIONS]

OPTIONS:
  --dataset <path.jsonl>     Path to labeled golden JSONL dataset (omit to run built-in BĐS suite)
  --radar <radar.json>       Path to radar definition JSON (omit to use built-in BĐS radar)
  --provider <id>            Provider: mock | claude | codex | agy (default: mock)
  --model <name>             Optional concrete model override for evaluation tier
  --tier <fast|smart>        Model tier when --model is set (default: fast)
  --batch-size <n>           Number of posts per judge_extract batch (default: 20)
  --repeat <n>               Run the whole dataset n times and report decision stability (default: 1)
  --out <report.json>        Write the full machine-readable study record (config, every run, stability)
  --json                     Also print machine-readable JSON summary at the end
  -h, --help                 Show this help message"
    );
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut dataset_path: Option<PathBuf> = None;
    let mut radar_path: Option<PathBuf> = None;
    let mut provider_id = ProviderId::Mock;
    let mut model_override: Option<String> = None;
    let mut tier = ModelTier::Fast;
    let mut batch_size: usize = 20;
    let mut emit_json = false;
    let mut repeat: usize = 1;
    let mut out_path: Option<PathBuf> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                return ExitCode::SUCCESS;
            }
            "--dataset" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --dataset requires a file path");
                    return ExitCode::FAILURE;
                };
                dataset_path = Some(PathBuf::from(val));
            }
            "--radar" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --radar requires a file path");
                    return ExitCode::FAILURE;
                };
                radar_path = Some(PathBuf::from(val));
            }
            "--provider" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --provider requires mock|claude|codex|agy");
                    return ExitCode::FAILURE;
                };
                match ProviderId::from_str(&val) {
                    Ok(p) => provider_id = p,
                    Err(e) => {
                        eprintln!("Error: {e}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--model" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --model requires a model name");
                    return ExitCode::FAILURE;
                };
                model_override = Some(val);
            }
            "--tier" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --tier requires fast or smart");
                    return ExitCode::FAILURE;
                };
                match ModelTier::from_str(&val) {
                    Ok(t) => tier = t,
                    Err(e) => {
                        eprintln!("Error: {e}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--batch-size" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --batch-size requires a positive integer");
                    return ExitCode::FAILURE;
                };
                match val.parse::<usize>() {
                    Ok(n) if n > 0 => batch_size = n,
                    _ => {
                        eprintln!("Error: invalid --batch-size '{val}'");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--repeat" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --repeat requires a positive integer");
                    return ExitCode::FAILURE;
                };
                match val.parse::<usize>() {
                    Ok(n) if n > 0 => repeat = n,
                    _ => {
                        eprintln!("Error: invalid --repeat '{val}'");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--out" => {
                let Some(val) = args.next() else {
                    eprintln!("Error: --out requires a file path");
                    return ExitCode::FAILURE;
                };
                out_path = Some(PathBuf::from(val));
            }
            "--json" => emit_json = true,
            other => {
                eprintln!("Error: unknown argument '{other}'. Pass --help for usage.");
                return ExitCode::FAILURE;
            }
        }
    }

    let (default_radar, default_samples) = builtin_bds_eval_suite();

    let radar_label = radar_path
        .as_ref()
        .map_or_else(|| "builtin:bds".to_string(), |p| p.display().to_string());
    let radar = match radar_path {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(raw) => match parse_radar_context_json(&raw) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("Error parsing radar '{}': {e}", path.display());
                    return ExitCode::FAILURE;
                }
            },
            Err(e) => {
                eprintln!("Error reading radar '{}': {e}", path.display());
                return ExitCode::FAILURE;
            }
        },
        None => default_radar,
    };

    let dataset_label = dataset_path
        .as_ref()
        .map_or_else(|| "builtin:bds".to_string(), |p| p.display().to_string());
    let mut dataset_fingerprint = fnv1a64_hex(b"builtin:bds");
    let samples = match dataset_path {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(raw) => match parse_golden_jsonl(&raw) {
                Ok(s) => {
                    dataset_fingerprint = fnv1a64_hex(raw.as_bytes());
                    s
                }
                Err(e) => {
                    eprintln!("Error parsing dataset '{}': {e}", path.display());
                    return ExitCode::FAILURE;
                }
            },
            Err(e) => {
                eprintln!("Error reading dataset '{}': {e}", path.display());
                return ExitCode::FAILURE;
            }
        },
        None => default_samples,
    };

    let mut tiers = ModelTierMap::new();
    if let Some(m) = model_override.clone() {
        tiers.set(provider_id, tier, Some(m));
    }

    let provider: Arc<dyn AiProvider> = match provider_id {
        ProviderId::Mock => Arc::new(MockAiProvider::new()),
        ProviderId::ClaudeCli => Arc::new(ClaudeCliProvider::new(
            CliAdapterConfig::new("claude").with_model_tiers(tiers),
        )),
        ProviderId::CodexCli => Arc::new(CodexCliProvider::new(
            CliAdapterConfig::new("codex").with_model_tiers(tiers),
        )),
        ProviderId::AgyCli => Arc::new(AgyCliProvider::new(
            CliAdapterConfig::new("agy").with_model_tiers(tiers),
        )),
    };

    let cli_version = match provider_id {
        ProviderId::Mock => None,
        ProviderId::ClaudeCli => cli_version("claude"),
        ProviderId::CodexCli => cli_version("codex"),
        ProviderId::AgyCli => cli_version("agy"),
    };

    let bridge = AiBridge::new(provider);
    let mut runs = Vec::with_capacity(repeat);
    let mut aborted: Option<String> = None;
    for i in 1..=repeat {
        match run_offline_eval(&bridge, &radar, &samples, batch_size).await {
            Ok(summary) => {
                if repeat > 1 {
                    println!("######## Lượt {i}/{repeat} ########");
                }
                print!("{}", format_eval_report(&summary));
                if emit_json && repeat == 1 {
                    if let Ok(j) = serde_json::to_string_pretty(&summary) {
                        println!("\n{j}");
                    }
                }
                runs.push(summary);
            }
            Err(err) => {
                eprintln!("Evaluation failed (run {i}/{repeat}): {err}");
                aborted = Some(format!("run {i}/{repeat}: {err}"));
                break;
            }
        }
    }
    if runs.is_empty() {
        return ExitCode::FAILURE;
    }

    let stability = compute_stability(&runs);
    if repeat > 1 {
        println!("\n{}", format_stability_report(&stability));
    }

    let report = EvalRunReport {
        schema_version: 1,
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
        provider: runs[0].provider.clone(),
        tier: format!("{tier:?}").to_lowercase(),
        model_override,
        cli_version,
        batch_size: runs[0].batch_size,
        dataset: dataset_label,
        dataset_fingerprint_fnv1a64: dataset_fingerprint,
        dataset_posts: samples.len(),
        radar: radar_label,
        radar_version_id: radar.radar_version_id.clone(),
        repeat,
        run_checks: runs.iter().map(threshold_checks).collect(),
        runs,
        stability,
        aborted: aborted.clone(),
    };
    if emit_json && repeat > 1 {
        if let Ok(j) = serde_json::to_string_pretty(&report) {
            println!("\n{j}");
        }
    }
    if let Some(path) = out_path {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("Error creating '{}': {e}", dir.display());
                return ExitCode::FAILURE;
            }
        }
        let body = match serde_json::to_string_pretty(&report) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("Error serializing report: {e}");
                return ExitCode::FAILURE;
            }
        };
        if let Err(e) = std::fs::write(&path, body) {
            eprintln!("Error writing '{}': {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("Đã ghi báo cáo nghiên cứu: {}", path.display());
    }
    if aborted.is_some() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// First line of `<bin> --version`, if the CLI is installed.
fn cli_version(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}
