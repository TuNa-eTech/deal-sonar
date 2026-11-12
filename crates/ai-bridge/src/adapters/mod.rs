pub mod agy;
pub mod claude;
pub mod codex;
pub mod mock;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::schema::{extract_json_value, probe_smoke_schema, validate_json_schema};
use crate::subprocess::{
    expanded_path_env, resolve_binary_in_path, run_cli_subprocess, ScopedTempDir,
};
use crate::types::{
    AiError, AiRequest, ModelTier, ModelTierMap, ProbeMode, ProviderId, TaskKind, Usage,
};

/// Shared configuration for CLI-backed `AiProvider` adapters (`06-ai-bridge.md §3`).
#[derive(Debug, Clone)]
pub struct CliAdapterConfig {
    /// Executable name (searched in expanded `PATH`) or explicit binary path.
    pub binary_path: PathBuf,
    /// Dedicated empty directory used as `current_dir` for every CLI invocation.
    /// If `None`, the adapter creates and owns an isolated temporary `ai-workdir`.
    pub workdir: Option<PathBuf>,
    /// Tier-to-model mapping from user settings.
    pub model_tiers: ModelTierMap,
    /// Default mode used by `AiProvider::probe()`.
    pub default_probe_mode: ProbeMode,
    /// Timeout for `probe()` commands.
    pub probe_timeout: Duration,
    /// Optional explicit base `PATH` (mainly for hermetic tests).
    pub path_override: Option<OsString>,
    /// Whether to augment `PATH` with common user/system CLI directories (default `true`).
    pub expand_system_paths: bool,
    /// Extra environment variables passed to the CLI subprocess.
    pub extra_env: Vec<(String, String)>,
}

impl CliAdapterConfig {
    pub fn new(default_binary: &str) -> Self {
        Self {
            binary_path: PathBuf::from(default_binary),
            workdir: None,
            model_tiers: ModelTierMap::new(),
            default_probe_mode: ProbeMode::Full,
            probe_timeout: Duration::from_secs(30),
            path_override: None,
            expand_system_paths: true,
            extra_env: Vec::new(),
        }
    }

    pub fn with_binary_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary_path = path.into();
        self
    }

    pub fn with_workdir(mut self, workdir: impl Into<PathBuf>) -> Self {
        self.workdir = Some(workdir.into());
        self
    }

    pub fn with_model_tiers(mut self, tiers: ModelTierMap) -> Self {
        self.model_tiers = tiers;
        self
    }

    pub fn with_probe_mode(mut self, mode: ProbeMode) -> Self {
        self.default_probe_mode = mode;
        self
    }

    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    pub fn with_isolated_path(mut self, path: impl Into<OsString>) -> Self {
        self.path_override = Some(path.into());
        self.expand_system_paths = false;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), val.into()));
        self
    }

    pub(crate) fn effective_path(&self) -> OsString {
        let base = self
            .path_override
            .clone()
            .or_else(|| std::env::var_os("PATH"));
        if self.expand_system_paths {
            expanded_path_env(base.as_deref(), None)
        } else {
            base.unwrap_or_default()
        }
    }
}

/// Holds either a caller-configured `ai-workdir` path or an owned temporary directory.
#[derive(Debug)]
pub(crate) enum WorkdirHandle {
    Configured(PathBuf),
    Temp(ScopedTempDir),
}

impl WorkdirHandle {
    pub fn from_option(opt: Option<PathBuf>) -> Self {
        match opt {
            Some(p) => Self::Configured(p),
            None => {
                let td = ScopedTempDir::new("dealsonar-ai-workdir-")
                    .expect("create temporary ai-workdir");
                Self::Temp(td)
            }
        }
    }

    pub fn path(&self) -> &Path {
        match self {
            Self::Configured(p) => p.as_path(),
            Self::Temp(td) => td.path(),
        }
    }
}

pub(crate) type SharedWorkdir = Arc<WorkdirHandle>;

/// Combines `system` and `prompt` into a single `stdin` payload for CLIs (`codex`, `agy`)
/// that do not take a separate `--system-prompt` flag (`06-ai-bridge.md §3.3–3.4`).
pub(crate) fn combine_system_and_prompt(system: &str, prompt: &str) -> String {
    let sys = system.trim();
    if sys.is_empty() {
        prompt.to_string()
    } else {
        format!("<SYSTEM_INSTRUCTIONS>\n{sys}\n</SYSTEM_INSTRUCTIONS>\n\n{prompt}")
    }
}

/// Builds the minimal smoke-check request for `probe()` (`06-ai-bridge.md §3.5`).
pub(crate) fn build_probe_smoke_request(timeout: Duration) -> AiRequest {
    AiRequest {
        task: TaskKind::JudgeExtract,
        system: "Return strictly valid JSON matching the provided schema.".to_string(),
        prompt: "Smoke check: respond with {\"ok\": true}.".to_string(),
        schema: probe_smoke_schema(),
        tier: ModelTier::Fast,
        timeout,
    }
}

/// Runs `--version` and returns the first non-empty line.
pub(crate) async fn fetch_cli_version(
    cfg: &CliAdapterConfig,
    workdir: &Path,
    expanded_path: &std::ffi::OsStr,
) -> Result<Option<String>, AiError> {
    if resolve_binary_in_path(&cfg.binary_path, expanded_path).is_none() {
        return Err(AiError::NotInstalled);
    }
    let out = run_cli_subprocess(
        &cfg.binary_path,
        &["--version".to_string()],
        None,
        workdir,
        expanded_path,
        &cfg.extra_env,
        Duration::from_secs(10).min(cfg.probe_timeout),
    )
    .await?;

    let combined = if !out.stdout.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    let line = combined
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(ToOwned::to_owned);
    Ok(line)
}

/// Checks that every mandatory flag substring appears in `help_text`.
pub(crate) fn verify_mandatory_flags(
    provider: ProviderId,
    min_tested_version: &str,
    help_text: &str,
    mandatory_flags: &[&str],
) -> Result<(), AiError> {
    let missing: Vec<&str> = mandatory_flags
        .iter()
        .copied()
        .filter(|flag| !help_contains_flag(help_text, flag))
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(AiError::SecurityFlagsUnsupported(format!(
            "{provider} thiếu cờ bảo mật/đầu ra bắt buộc [{}] — phiên bản quá cũ, cần cập nhật (tối thiểu đã kiểm thử: {min_tested_version})",
            missing.join(", ")
        )))
    }
}

pub(crate) fn help_contains_flag(help_text: &str, flag: &str) -> bool {
    help_text.contains(flag)
}

/// Parses a wrapper JSON object commonly emitted by `--output-format json` CLIs (`claude`, `agy`),
/// extracting `(structured_payload, Option<Usage>, Option<model_name>)` and checking schema validity.
pub(crate) fn unwrap_cli_json_envelope(
    raw_stdout: &str,
    expected_schema: &Value,
    fallback_model: Option<String>,
) -> Result<(Value, Option<Usage>, Option<String>), AiError> {
    let top = extract_json_value(raw_stdout)?;

    // Check explicit error/refusal envelope fields before treating `top` as model output.
    if let Some(obj) = top.as_object() {
        if obj.get("is_error").and_then(Value::as_bool) == Some(true) {
            let err_msg = obj
                .get("result")
                .or_else(|| obj.get("error"))
                .or_else(|| obj.get("message"))
                .map(|v| {
                    v.as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_else(|| "CLI reported is_error=true".to_string());
            return Err(crate::classify::classify_cli_failure(
                ProviderId::ClaudeCli,
                1,
                &err_msg,
                raw_stdout,
            ));
        }

        if obj.get("stop_reason").and_then(Value::as_str) == Some("refusal")
            || obj.get("subtype").and_then(Value::as_str) == Some("refusal")
        {
            let msg = obj
                .get("refusal")
                .or_else(|| obj.get("result"))
                .and_then(Value::as_str)
                .unwrap_or("model refused request");
            return Err(AiError::Refused(msg.to_string()));
        }
    }

    let usage = extract_usage_from_obj(&top);
    let model = extract_model_from_obj(&top).or(fallback_model);

    // Candidate payload extraction order:
    // 1. `structured_output` (Claude Code `--json-schema` canonical field)
    // 2. `result` / `output` / `response` (string containing JSON, or direct object)
    // 3. `content` blocks (Anthropic/MCP style text or `StructuredOutput` tool_use block)
    // 4. `top` itself (when CLI prints the structured JSON directly)
    let mut candidates: Vec<Value> = Vec::new();

    if let Some(obj) = top.as_object() {
        if let Some(so) = obj.get("structured_output").filter(|v| !v.is_null()) {
            candidates.push(so.clone());
        }
        for key in ["result", "output", "response", "data"] {
            if let Some(val) = obj.get(key).filter(|v| !v.is_null()) {
                match val {
                    Value::String(s) => {
                        if let Ok(parsed) = extract_json_value(s) {
                            candidates.push(parsed);
                        }
                    }
                    Value::Object(_) | Value::Array(_) => {
                        candidates.push(val.clone());
                    }
                    _ => {}
                }
            }
        }
        if let Some(content_arr) = obj.get("content").and_then(Value::as_array) {
            for item in content_arr {
                if let Some(input) = item.get("input").filter(|v| v.is_object()) {
                    candidates.push(input.clone());
                }
                if let Some(txt) = item.get("text").and_then(Value::as_str) {
                    if let Ok(parsed) = extract_json_value(txt) {
                        candidates.push(parsed);
                    }
                }
            }
        }
    }
    candidates.push(top);

    // Prefer the first candidate that validates against `expected_schema`.
    let mut first_err = None;
    for cand in &candidates {
        match validate_json_schema(expected_schema, cand) {
            Ok(()) => return Ok((cand.clone(), usage, model)),
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }

    Err(AiError::InvalidOutput(first_err.unwrap_or_else(|| {
        "output did not match schema".to_string()
    })))
}

pub(crate) fn extract_usage_from_obj(val: &Value) -> Option<Usage> {
    let obj = val.as_object()?;
    let usage_obj = obj.get("usage").and_then(Value::as_object);

    let cost_usd = obj
        .get("total_cost_usd")
        .or_else(|| obj.get("cost_usd"))
        .and_then(Value::as_f64)
        .or_else(|| {
            usage_obj.and_then(|u| {
                u.get("cost_usd")
                    .or_else(|| u.get("total_cost_usd"))
                    .and_then(Value::as_f64)
            })
        });

    if let Some(u) = usage_obj {
        let base_in = u
            .get("input_tokens")
            .or_else(|| u.get("prompt_tokens"))
            .or_else(|| u.get("promptTokenCount"))
            .and_then(Value::as_u64);
        let cache_create = u
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cache_read = u
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let out_tok = u
            .get("output_tokens")
            .or_else(|| u.get("completion_tokens"))
            .or_else(|| u.get("candidatesTokenCount"))
            .and_then(Value::as_u64);

        if base_in.is_some() || out_tok.is_some() || cost_usd.is_some() {
            return Some(Usage {
                input_tokens: base_in.unwrap_or(0) + cache_create + cache_read,
                output_tokens: out_tok.unwrap_or(0),
                cost_usd,
            });
        }
    }

    cost_usd.map(|cost| Usage {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: Some(cost),
    })
}

pub(crate) fn extract_model_from_obj(val: &Value) -> Option<String> {
    let obj = val.as_object()?;
    if let Some(m) = obj
        .get("model")
        .or_else(|| obj.get("modelVersion"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Some(m.to_string());
    }
    if let Some(mu) = obj.get("modelUsage").and_then(Value::as_object) {
        if let Some(first_key) = mu.keys().next() {
            return Some(first_key.clone());
        }
    }
    None
}
