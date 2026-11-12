use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;
use std::sync::Arc;

use dealsonar_ai_bridge::eval::{
    builtin_bds_eval_suite, format_eval_report, parse_golden_jsonl, parse_radar_context_json,
    run_offline_eval,
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
            "--json" => emit_json = true,
            other => {
                eprintln!("Error: unknown argument '{other}'. Pass --help for usage.");
                return ExitCode::FAILURE;
            }
        }
    }

    let (default_radar, default_samples) = builtin_bds_eval_suite();

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

    let samples = match dataset_path {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(raw) => match parse_golden_jsonl(&raw) {
                Ok(s) => s,
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
    if let Some(m) = model_override {
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

    let bridge = AiBridge::new(provider);
    match run_offline_eval(&bridge, &radar, &samples, batch_size).await {
        Ok(summary) => {
            print!("{}", format_eval_report(&summary));
            if emit_json {
                if let Ok(j) = serde_json::to_string_pretty(&summary) {
                    println!("\n{j}");
                }
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("Evaluation failed: {err}");
            ExitCode::FAILURE
        }
    }
}
