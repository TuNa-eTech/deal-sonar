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
    AiError, AiModelOption, AiRequest, ModelTier, ModelTierMap, ProbeMode, ProviderId, TaskKind,
    Usage,
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

// ============================================================================
// Automatic Model Discovery (`claude`, `codex`, `agy`, `mock`)
// ============================================================================

pub(crate) fn user_home_dir(cfg: &CliAdapterConfig) -> Option<PathBuf> {
    for (k, v) in &cfg.extra_env {
        if (k == "HOME" || k == "USERPROFILE") && !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn push_unique_model(list: &mut Vec<AiModelOption>, opt: AiModelOption) {
    let trimmed = opt.id.trim();
    if trimmed.is_empty() {
        return;
    }
    if !list.iter().any(|m| m.id == trimmed) {
        list.push(opt);
    }
}

/// Discovers available models for Claude Code CLI (`claude`) from:
/// 1. `~/.claude/cache/model-catalog/*.json` (`provider_alias_targets` + `catalog.config.models`)
/// 2. `~/.claude/settings.json` (`model` / `env.ANTHROPIC_MODEL`)
/// 3. Built-in fallback catalog when no local catalog cache exists.
pub fn discover_claude_models(
    cfg: &CliAdapterConfig,
    help_text: Option<&str>,
) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if let Some(home) = user_home_dir(cfg) {
        let catalog_dir = home.join(".claude").join("cache").join("model-catalog");
        if let Ok(entries) = std::fs::read_dir(&catalog_dir) {
            let mut candidates: Vec<(bool, u64, Value)> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let Some(cat) = val.get("catalog").and_then(Value::as_object) else {
                    continue;
                };
                if cat
                    .get("config")
                    .and_then(|c| c.get("models"))
                    .and_then(Value::as_array)
                    .is_none()
                {
                    continue;
                }
                let is_cc = cat.get("surface").and_then(Value::as_str) == Some("cc");
                let fetched_at = val.get("fetchedAt").and_then(Value::as_u64).unwrap_or(0);
                candidates.push((is_cc, fetched_at, val));
            }

            candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));

            if let Some((_, _, best_val)) = candidates.first() {
                if let Some(config_obj) = best_val
                    .get("catalog")
                    .and_then(|c| c.get("config"))
                    .and_then(Value::as_object)
                {
                    if let Some(aliases) = config_obj
                        .get("provider_alias_targets")
                        .and_then(Value::as_object)
                    {
                        let preferred_order = ["haiku", "sonnet", "opus", "fable"];
                        for &alias in &preferred_order {
                            if let Some(target_info) = aliases.get(alias) {
                                let target_default = target_info
                                    .get("default")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let tier = if alias == "haiku" {
                                    Some(ModelTier::Fast)
                                } else {
                                    Some(ModelTier::Smart)
                                };
                                let label = if target_default.is_empty() {
                                    format!("{alias} — Bí danh tự động")
                                } else {
                                    format!("{alias} — Bí danh tự động ({target_default})")
                                };
                                push_unique_model(
                                    &mut models,
                                    AiModelOption {
                                        id: alias.to_string(),
                                        label,
                                        recommended_tier: tier,
                                        source: "local_cli".to_string(),
                                    },
                                );
                            }
                        }
                    }

                    if let Some(arr) = config_obj.get("models").and_then(Value::as_array) {
                        for item in arr {
                            let Some(id) = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                            else {
                                continue;
                            };
                            let name = item
                                .get("name")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(id);
                            let short_name =
                                item.get("short_name").and_then(Value::as_str).unwrap_or("");
                            let desc = item
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .unwrap_or("");
                            let combined_lc =
                                format!("{id} {name} {short_name} {desc}").to_ascii_lowercase();
                            let tier =
                                if combined_lc.contains("haiku") || combined_lc.contains("fast") {
                                    Some(ModelTier::Fast)
                                } else {
                                    Some(ModelTier::Smart)
                                };
                            let label = if !desc.is_empty() {
                                format!("{name} ({id}) — {desc}")
                            } else if !name.eq_ignore_ascii_case(id) {
                                format!("{name} ({id})")
                            } else {
                                id.to_string()
                            };
                            push_unique_model(
                                &mut models,
                                AiModelOption {
                                    id: id.to_string(),
                                    label,
                                    recommended_tier: tier,
                                    source: "local_cli".to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }

        let settings_path = home.join(".claude").join("settings.json");
        if let Ok(raw) = std::fs::read_to_string(&settings_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(m) = val
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let tier = if m.to_ascii_lowercase().contains("haiku") {
                        Some(ModelTier::Fast)
                    } else {
                        Some(ModelTier::Smart)
                    };
                    push_unique_model(
                        &mut models,
                        AiModelOption {
                            id: m.to_string(),
                            label: format!("{m} (từ ~/.claude/settings.json)"),
                            recommended_tier: tier,
                            source: "local_cli".to_string(),
                        },
                    );
                }
            }
        }
    }

    if let Some(h) = help_text {
        for alias in ["haiku", "sonnet", "opus", "fable"] {
            if h.contains(&format!("'{alias}'")) {
                let tier = if alias == "haiku" {
                    Some(ModelTier::Fast)
                } else {
                    Some(ModelTier::Smart)
                };
                push_unique_model(
                    &mut models,
                    AiModelOption {
                        id: alias.to_string(),
                        label: format!("{alias} — Bí danh Claude ({alias})"),
                        recommended_tier: tier,
                        source: "local_cli".to_string(),
                    },
                );
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "haiku",
                "haiku — Claude Haiku mới nhất (Nhanh, tiết kiệm)",
                ModelTier::Fast,
            ),
            (
                "sonnet",
                "sonnet — Claude Sonnet mới nhất (Cân bằng, thông minh)",
                ModelTier::Smart,
            ),
            (
                "opus",
                "opus — Claude Opus mới nhất (Suy luận sâu)",
                ModelTier::Smart,
            ),
            (
                "claude-haiku-4-5-20251001",
                "Claude Haiku 4.5 (claude-haiku-4-5-20251001)",
                ModelTier::Fast,
            ),
            (
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6 (claude-sonnet-4-6)",
                ModelTier::Smart,
            ),
            (
                "claude-opus-4-6",
                "Claude Opus 4.6 (claude-opus-4-6)",
                ModelTier::Smart,
            ),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

/// Discovers available models for OpenAI Codex CLI (`codex`) from:
/// 1. `~/.codex/models_cache.json` (`models` array with `visibility == "list"`)
/// 2. `~/.codex/config.toml` (`model = "..."`)
/// 3. Built-in fallback catalog when no local cache exists.
pub fn discover_codex_models(cfg: &CliAdapterConfig) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if let Some(home) = user_home_dir(cfg) {
        let cache_path = home.join(".codex").join("models_cache.json");
        if let Ok(raw) = std::fs::read_to_string(&cache_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(arr) = val.get("models").and_then(Value::as_array) {
                    let has_list_vis = arr
                        .iter()
                        .any(|m| m.get("visibility").and_then(Value::as_str) == Some("list"));

                    for item in arr {
                        let vis = item
                            .get("visibility")
                            .and_then(Value::as_str)
                            .unwrap_or("list");
                        if has_list_vis && vis != "list" {
                            continue;
                        }
                        if !has_list_vis && vis == "hide" {
                            continue;
                        }

                        let Some(slug) = item
                            .get("slug")
                            .or_else(|| item.get("id"))
                            .or_else(|| item.get("name"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        else {
                            continue;
                        };
                        let display_name = item
                            .get("display_name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(slug);
                        let desc = item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");

                        let combined_lc =
                            format!("{slug} {display_name} {desc}").to_ascii_lowercase();
                        let tier = if combined_lc.contains("mini")
                            || combined_lc.contains("luna")
                            || combined_lc.contains("fast")
                            || combined_lc.contains("flash")
                            || combined_lc.contains("nano")
                            || combined_lc.contains("efficient")
                            || combined_lc.contains("easier")
                        {
                            Some(ModelTier::Fast)
                        } else {
                            Some(ModelTier::Smart)
                        };

                        let label = if !desc.is_empty() {
                            if display_name.eq_ignore_ascii_case(slug) {
                                format!("{slug} — {desc}")
                            } else {
                                format!("{display_name} ({slug}) — {desc}")
                            }
                        } else if !display_name.eq_ignore_ascii_case(slug) {
                            format!("{display_name} ({slug})")
                        } else {
                            slug.to_string()
                        };

                        push_unique_model(
                            &mut models,
                            AiModelOption {
                                id: slug.to_string(),
                                label,
                                recommended_tier: tier,
                                source: "local_cli".to_string(),
                            },
                        );
                    }
                }
            }
        }

        let config_toml = home.join(".codex").join("config.toml");
        if let Ok(raw) = std::fs::read_to_string(&config_toml) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') {
                    break;
                }
                if let Some(rest) = trimmed.strip_prefix("model") {
                    let rest = rest.trim_start();
                    if let Some(val_part) = rest.strip_prefix('=') {
                        let cleaned = val_part.trim().trim_matches('"').trim_matches('\'').trim();
                        if !cleaned.is_empty() {
                            let lc = cleaned.to_ascii_lowercase();
                            let tier = if lc.contains("mini") || lc.contains("luna") {
                                Some(ModelTier::Fast)
                            } else {
                                Some(ModelTier::Smart)
                            };
                            push_unique_model(
                                &mut models,
                                AiModelOption {
                                    id: cleaned.to_string(),
                                    label: format!("{cleaned} (từ ~/.codex/config.toml)"),
                                    recommended_tier: tier,
                                    source: "local_cli".to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "codex-mini-latest",
                "Codex Mini Latest (codex-mini-latest) — Nhanh, tiết kiệm",
                ModelTier::Fast,
            ),
            (
                "gpt-5-codex",
                "GPT-5 Codex (gpt-5-codex) — Suy luận & tạo bộ luật",
                ModelTier::Smart,
            ),
            ("o4-mini", "o4-mini — Nhanh, suy luận gọn", ModelTier::Fast),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

fn is_valid_agy_model_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let has_sep = bytes.contains(&b'-') || bytes.contains(&b'.');
    has_sep
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

/// Parses `agy models` stdout (handling carriage-return spinner frames) into `AiModelOption` items.
pub fn parse_agy_models_stdout(stdout: &str) -> Vec<AiModelOption> {
    let mut models = Vec::new();
    for raw_line in stdout.lines() {
        let after_cr = raw_line.rsplit('\r').next().unwrap_or(raw_line).trim();
        if after_cr.is_empty() {
            continue;
        }
        let mut parts = after_cr.split_whitespace();
        let Some(id_tok) = parts.next() else {
            continue;
        };
        if !is_valid_agy_model_slug(id_tok) {
            continue;
        }
        let rest: String = parts.collect::<Vec<_>>().join(" ");
        let combined_lc = format!("{id_tok} {rest}").to_ascii_lowercase();
        let tier = if combined_lc.contains("flash")
            || id_tok.ends_with("-low")
            || combined_lc.contains("lite")
            || combined_lc.contains("mini")
        {
            Some(ModelTier::Fast)
        } else {
            Some(ModelTier::Smart)
        };
        let label = if !rest.is_empty() && !rest.eq_ignore_ascii_case(id_tok) {
            format!("{rest} ({id_tok})")
        } else {
            id_tok.to_string()
        };
        push_unique_model(
            &mut models,
            AiModelOption {
                id: id_tok.to_string(),
                label,
                recommended_tier: tier,
                source: "local_cli".to_string(),
            },
        );
    }
    models
}

/// Discovers available models for Antigravity CLI (`agy`) by running `agy models` when supported,
/// with a built-in fallback catalog when offline or uninstalled.
pub async fn discover_agy_models(
    cfg: &CliAdapterConfig,
    workdir: &Path,
    expanded_path: &std::ffi::OsStr,
    supports_models_subcommand: bool,
) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if supports_models_subcommand
        && resolve_binary_in_path(&cfg.binary_path, expanded_path).is_some()
    {
        if let Ok(out) = run_cli_subprocess(
            &cfg.binary_path,
            &["models".to_string()],
            None,
            workdir,
            expanded_path,
            &cfg.extra_env,
            Duration::from_secs(8).min(cfg.probe_timeout),
        )
        .await
        {
            if out.exit_code == 0 {
                models = parse_agy_models_stdout(&out.stdout);
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "gemini-3.8-flash-medium",
                "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)",
                ModelTier::Fast,
            ),
            (
                "gemini-3.8-flash-low",
                "Gemini 3.8 Flash (Low) (gemini-3.8-flash-low)",
                ModelTier::Fast,
            ),
            (
                "gemini-4-carbon-medium",
                "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)",
                ModelTier::Smart,
            ),
            (
                "gemini-4-carbon-high",
                "Gemini 4 Carbon (High) (gemini-4-carbon-high)",
                ModelTier::Smart,
            ),
            (
                "gemini-4-argon-medium",
                "Gemini 4 Argon (Medium) (gemini-4-argon-medium)",
                ModelTier::Smart,
            ),
            (
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6 (Thinking) (claude-sonnet-4-6)",
                ModelTier::Smart,
            ),
            (
                "gemini-2.5-flash",
                "Gemini 2.5 Flash (gemini-2.5-flash)",
                ModelTier::Fast,
            ),
            (
                "gemini-2.5-pro",
                "Gemini 2.5 Pro (gemini-2.5-pro)",
                ModelTier::Smart,
            ),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

pub fn discover_mock_models() -> Vec<AiModelOption> {
    vec![
        AiModelOption {
            id: "mock-fast-v1".to_string(),
            label: "Mock Fast v1 (mock-fast-v1)".to_string(),
            recommended_tier: Some(ModelTier::Fast),
            source: "builtin".to_string(),
        },
        AiModelOption {
            id: "mock-smart-v1".to_string(),
            label: "Mock Smart v1 (mock-smart-v1)".to_string(),
            recommended_tier: Some(ModelTier::Smart),
            source: "builtin".to_string(),
        },
    ]
}

/// Computes the best recommended `(fast, smart)` model IDs from a discovered model list.
pub fn recommended_models_for_provider(
    provider: ProviderId,
    models: &[AiModelOption],
) -> (Option<String>, Option<String>) {
    let find_preferred = |prefs: &[&str], tier: ModelTier| -> Option<String> {
        for &p in prefs {
            if let Some(found) = models.iter().find(|m| m.id == p) {
                return Some(found.id.clone());
            }
        }
        models
            .iter()
            .find(|m| m.recommended_tier == Some(tier))
            .or_else(|| models.first())
            .map(|m| m.id.clone())
    };

    match provider {
        ProviderId::ClaudeCli => (
            find_preferred(
                &["haiku", "claude-haiku-5-5", "claude-haiku-4-5-20251001"],
                ModelTier::Fast,
            ),
            find_preferred(
                &["sonnet", "claude-sonnet-5-5", "claude-sonnet-4-6"],
                ModelTier::Smart,
            ),
        ),
        ProviderId::CodexCli => (
            find_preferred(
                &["gpt-6-luna", "codex-mini-latest", "o4-mini"],
                ModelTier::Fast,
            ),
            find_preferred(
                &["gpt-6.1-sol", "gpt-5-codex", "gpt-6-astra"],
                ModelTier::Smart,
            ),
        ),
        ProviderId::AgyCli => (
            find_preferred(
                &[
                    "gemini-3.8-flash-medium",
                    "gemini-3.8-flash-low",
                    "gemini-2.5-flash",
                ],
                ModelTier::Fast,
            ),
            find_preferred(
                &[
                    "gemini-4-carbon-medium",
                    "gemini-4-argon-medium",
                    "gemini-2.5-pro",
                ],
                ModelTier::Smart,
            ),
        ),
        ProviderId::Mock => (
            find_preferred(&["mock-fast-v1"], ModelTier::Fast),
            find_preferred(&["mock-smart-v1"], ModelTier::Smart),
        ),
    }
}
