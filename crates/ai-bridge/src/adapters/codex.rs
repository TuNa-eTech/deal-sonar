use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::adapters::{
    build_probe_smoke_request, combine_system_and_prompt, discover_codex_models, fetch_cli_version,
    help_contains_flag, verify_mandatory_flags, CliAdapterConfig, SharedWorkdir, WorkdirHandle,
};
use crate::classify::classify_cli_failure;
use crate::schema::{extract_json_value, validate_json_schema};
use crate::subprocess::{resolve_binary_in_path, run_cli_subprocess, ScopedTempDir};
use crate::types::{
    AiError, AiProvider, AiRequest, AiResponse, ProbeMode, ProbeResult, ProviderId, Usage,
};

pub const CODEX_MIN_TESTED_VERSION: &str = "0.150.1";

pub const CODEX_MANDATORY_FLAGS: &[&str] = &[
    "--json",
    "--output-schema",
    "--output-last-message",
    "--sandbox",
    "--skip-git-repo-check",
    "--ephemeral",
];

#[derive(Debug, Clone)]
struct CodexCapabilities {
    use_ignore_user_config: bool,
    use_ignore_rules: bool,
}

/// Hardened adapter for OpenAI Codex CLI (`codex exec`, `06-ai-bridge.md §3.3`).
#[derive(Debug, Clone)]
pub struct CodexCliProvider {
    config: CliAdapterConfig,
    workdir: SharedWorkdir,
    capabilities: Arc<RwLock<Option<Result<CodexCapabilities, AiError>>>>,
}

impl Default for CodexCliProvider {
    fn default() -> Self {
        Self::new(CliAdapterConfig::new("codex"))
    }
}

impl CodexCliProvider {
    pub fn new(config: CliAdapterConfig) -> Self {
        let workdir = Arc::new(WorkdirHandle::from_option(config.workdir.clone()));
        Self {
            config,
            workdir,
            capabilities: Arc::new(RwLock::new(None)),
        }
    }

    pub fn config(&self) -> &CliAdapterConfig {
        &self.config
    }

    pub async fn probe_quick(&self) -> ProbeResult {
        self.probe_with_mode(ProbeMode::Quick).await
    }

    pub async fn probe_full(&self) -> ProbeResult {
        self.probe_with_mode(ProbeMode::Full).await
    }

    pub async fn probe_with_mode(&self, mode: ProbeMode) -> ProbeResult {
        let started = Instant::now();
        let expanded_path = self.config.effective_path();
        let available_models = discover_codex_models(&self.config);
        if resolve_binary_in_path(&self.config.binary_path, &expanded_path).is_none() {
            return ProbeResult {
                installed: false,
                version: None,
                authenticated: false,
                flags_supported: false,
                latency_ms: None,
                error: Some(AiError::NotInstalled.to_string()),
                available_models,
            };
        }

        let version =
            match fetch_cli_version(&self.config, self.workdir.path(), &expanded_path).await {
                Ok(v) => v,
                Err(e) => {
                    return ProbeResult {
                        installed: !matches!(e, AiError::NotInstalled),
                        version: None,
                        authenticated: false,
                        flags_supported: false,
                        latency_ms: Some(started.elapsed().as_millis() as u64),
                        error: Some(e.to_string()),
                        available_models,
                    };
                }
            };

        let mut caps = match self.detect_and_cache_flags(&expanded_path).await {
            Ok(c) => c,
            Err(flag_err) => {
                return ProbeResult {
                    installed: true,
                    version,
                    authenticated: false,
                    flags_supported: false,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    error: Some(flag_err.to_string()),
                    available_models,
                };
            }
        };

        if mode == ProbeMode::Quick {
            return ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: None,
                available_models,
            };
        }

        let smoke_req = build_probe_smoke_request(self.config.probe_timeout);
        let mut smoke_res = self
            .execute_request(&smoke_req, &expanded_path, &caps, true)
            .await;

        // Per `06-ai-bridge.md §3.3`: if `--ignore-user-config` strips Codex auth credentials,
        // retry without `--ignore-user-config` and cache the working flag set.
        if matches!(smoke_res, Err(AiError::NotAuthenticated)) && caps.use_ignore_user_config {
            caps.use_ignore_user_config = false;
            let retry_res = self
                .execute_request(&smoke_req, &expanded_path, &caps, true)
                .await;
            if retry_res.is_ok() || matches!(retry_res, Err(AiError::RateLimited { .. })) {
                *self.capabilities.write().await = Some(Ok(caps.clone()));
                smoke_res = retry_res;
            }
        }

        // If configured model is not recognized on the user's Codex account, retry smoke check
        // using the CLI's default model so auth probe does not fail on stale model names.
        if matches!(smoke_res, Err(AiError::Process { .. }))
            && self
                .config
                .model_tiers
                .resolve(ProviderId::CodexCli, smoke_req.tier)
                .is_some()
        {
            let retry_res = self
                .execute_request(&smoke_req, &expanded_path, &caps, false)
                .await;
            if retry_res.is_ok() || matches!(retry_res, Err(AiError::RateLimited { .. })) {
                smoke_res = retry_res;
            }
        }

        match smoke_res {
            Ok(resp) => ProbeResult {
                installed: true,
                version,
                authenticated: true,
                flags_supported: true,
                latency_ms: Some(resp.duration.as_millis() as u64),
                error: None,
                available_models,
            },
            Err(AiError::NotAuthenticated) => ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(AiError::NotAuthenticated.to_string()),
                available_models,
            },
            Err(err @ AiError::RateLimited { .. }) => ProbeResult {
                installed: true,
                version,
                authenticated: true,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(format!("rate_limited: {err}")),
                available_models,
            },
            Err(other) => ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(other.to_string()),
                available_models,
            },
        }
    }

    async fn ensure_capabilities(
        &self,
        expanded_path: &std::ffi::OsStr,
    ) -> Result<CodexCapabilities, AiError> {
        if let Some(cached) = self.capabilities.read().await.clone() {
            return cached;
        }
        self.detect_and_cache_flags(expanded_path).await
    }

    async fn detect_and_cache_flags(
        &self,
        expanded_path: &std::ffi::OsStr,
    ) -> Result<CodexCapabilities, AiError> {
        let help_timeout = Duration::from_secs(10).min(self.config.probe_timeout);
        let exec_help = run_cli_subprocess(
            &self.config.binary_path,
            &["exec".to_string(), "--help".to_string()],
            None,
            self.workdir.path(),
            expanded_path,
            &self.config.extra_env,
            help_timeout,
        )
        .await?;

        let mut combined_help = format!("{}\n{}", exec_help.stdout, exec_help.stderr);

        // Also check top-level `--help` in case flags are documented on root command.
        if verify_mandatory_flags(
            ProviderId::CodexCli,
            CODEX_MIN_TESTED_VERSION,
            &combined_help,
            CODEX_MANDATORY_FLAGS,
        )
        .is_err()
        {
            if let Ok(root_help) = run_cli_subprocess(
                &self.config.binary_path,
                &["--help".to_string()],
                None,
                self.workdir.path(),
                expanded_path,
                &self.config.extra_env,
                help_timeout,
            )
            .await
            {
                combined_help.push('\n');
                combined_help.push_str(&root_help.stdout);
                combined_help.push('\n');
                combined_help.push_str(&root_help.stderr);
            }
        }

        let check = verify_mandatory_flags(
            ProviderId::CodexCli,
            CODEX_MIN_TESTED_VERSION,
            &combined_help,
            CODEX_MANDATORY_FLAGS,
        )
        .map(|()| CodexCapabilities {
            use_ignore_user_config: help_contains_flag(&combined_help, "--ignore-user-config"),
            use_ignore_rules: help_contains_flag(&combined_help, "--ignore-rules"),
        });

        *self.capabilities.write().await = Some(check.clone());
        check
    }

    async fn execute_request(
        &self,
        req: &AiRequest,
        expanded_path: &std::ffi::OsStr,
        caps: &CodexCapabilities,
        use_configured_model: bool,
    ) -> Result<AiResponse, AiError> {
        // Per-call temp directory holding `schema.json` and `last_message.json`.
        // Automatically deleted when `call_tmp` drops on any return/error/timeout path!
        let call_tmp =
            ScopedTempDir::new("dealsonar-codex-call-").map_err(|e| AiError::Process {
                code: -1,
                stderr: format!("failed to create codex temp dir: {e}"),
            })?;
        let schema_path = call_tmp.path().join("schema.json");
        let out_path = call_tmp.path().join("last_message.json");

        let schema_bytes = serde_json::to_vec(&req.schema)
            .map_err(|e| AiError::InvalidOutput(format!("invalid schema JSON: {e}")))?;
        tokio::fs::write(&schema_path, &schema_bytes)
            .await
            .map_err(|e| AiError::Process {
                code: -1,
                stderr: format!("failed to write codex schema file: {e}"),
            })?;

        let resolved_model = if use_configured_model {
            self.config
                .model_tiers
                .resolve(ProviderId::CodexCli, req.tier)
                .map(ToOwned::to_owned)
        } else {
            None
        };

        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--output-schema".to_string(),
            schema_path.to_string_lossy().into_owned(),
            "--output-last-message".to_string(),
            out_path.to_string_lossy().into_owned(),
        ];
        if let Some(ref m) = resolved_model {
            args.push("--model".to_string());
            args.push(m.clone());
        }
        args.extend([
            "--sandbox".to_string(),
            "read-only".to_string(),
            "--skip-git-repo-check".to_string(),
            "--ephemeral".to_string(),
        ]);
        if caps.use_ignore_user_config {
            args.push("--ignore-user-config".to_string());
        }
        if caps.use_ignore_rules {
            args.push("--ignore-rules".to_string());
        }
        // "-" instructs `codex exec` to read prompt from stdin (`06-ai-bridge.md §3.3`).
        args.push("-".to_string());

        let stdin_payload = combine_system_and_prompt(&req.system, &req.prompt);

        let raw = run_cli_subprocess(
            &self.config.binary_path,
            &args,
            Some(stdin_payload.as_bytes()),
            self.workdir.path(),
            expanded_path,
            &self.config.extra_env,
            req.timeout,
        )
        .await?;

        let jsonl_info = parse_codex_jsonl_stdout(&raw.stdout);

        if raw.exit_code != 0 {
            let err_context = jsonl_info
                .error_message
                .as_deref()
                .map(|m| format!("{}\n{m}", raw.stderr))
                .unwrap_or_else(|| raw.stderr.clone());
            return Err(classify_cli_failure(
                ProviderId::CodexCli,
                raw.exit_code,
                &err_context,
                &raw.stdout,
            ));
        }

        if let Some(ref err_msg) = jsonl_info.error_message {
            if !tokio::fs::try_exists(&out_path).await.unwrap_or(false) {
                return Err(classify_cli_failure(
                    ProviderId::CodexCli,
                    1,
                    err_msg,
                    &raw.stdout,
                ));
            }
        }

        let raw_message = match tokio::fs::read_to_string(&out_path).await {
            Ok(content) if !content.trim().is_empty() => content,
            _ => jsonl_info
                .last_assistant_text
                .unwrap_or_else(|| raw.stdout.clone()),
        };

        let output = extract_json_value(&raw_message)?;
        validate_json_schema(&req.schema, &output).map_err(AiError::InvalidOutput)?;

        Ok(AiResponse {
            output,
            usage: jsonl_info.usage,
            model: jsonl_info.model.or(resolved_model),
            duration: raw.duration,
        })
    }
}

#[derive(Default)]
struct CodexJsonlSummary {
    usage: Option<Usage>,
    model: Option<String>,
    last_assistant_text: Option<String>,
    error_message: Option<String>,
}

fn parse_codex_jsonl_stdout(stdout: &str) -> CodexJsonlSummary {
    let mut summary = CodexJsonlSummary::default();
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut saw_tokens = false;
    let mut total_cost: Option<f64> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(obj) = ev.as_object() else {
            continue;
        };

        if let Some(m) = obj
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            summary.model = Some(m.to_string());
        }

        let ev_type = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        if ev_type == "error" || ev_type == "turn.failed" {
            if let Some(msg) = obj.get("message").and_then(Value::as_str).or_else(|| {
                obj.get("error").and_then(|e| {
                    e.get("message")
                        .and_then(Value::as_str)
                        .or_else(|| e.as_str())
                })
            }) {
                summary.error_message = Some(msg.to_string());
            }
        }

        // Token usage in `turn.completed` or `token_count` events
        if let Some(u) = obj.get("usage").and_then(Value::as_object) {
            let in_tok = u
                .get("input_tokens")
                .or_else(|| u.get("prompt_tokens"))
                .and_then(Value::as_u64);
            let cached_in = u
                .get("cached_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let out_tok = u
                .get("output_tokens")
                .or_else(|| u.get("completion_tokens"))
                .and_then(Value::as_u64);

            if in_tok.is_some() || out_tok.is_some() {
                total_in += in_tok.unwrap_or(0) + cached_in;
                total_out += out_tok.unwrap_or(0);
                saw_tokens = true;
            }
            if let Some(c) = u.get("cost_usd").and_then(Value::as_f64) {
                total_cost = Some(total_cost.unwrap_or(0.0) + c);
            }
        }

        // Capture last assistant message text as fallback if `--output-last-message` file is empty
        if let Some(item) = obj.get("item").and_then(Value::as_object) {
            if let Some(txt) = item.get("text").and_then(Value::as_str) {
                summary.last_assistant_text = Some(txt.to_string());
            } else if let Some(content) = item.get("content").and_then(Value::as_array) {
                for block in content {
                    if let Some(txt) = block.get("text").and_then(Value::as_str) {
                        summary.last_assistant_text = Some(txt.to_string());
                    }
                }
            }
        }
    }

    if saw_tokens || total_cost.is_some() {
        summary.usage = Some(Usage {
            input_tokens: total_in,
            output_tokens: total_out,
            cost_usd: total_cost,
        });
    }

    summary
}

#[async_trait]
impl AiProvider for CodexCliProvider {
    fn id(&self) -> ProviderId {
        ProviderId::CodexCli
    }

    async fn probe(&self) -> ProbeResult {
        self.probe_with_mode(self.config.default_probe_mode).await
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        let expanded_path = self.config.effective_path();
        if resolve_binary_in_path(&self.config.binary_path, &expanded_path).is_none() {
            return Err(AiError::NotInstalled);
        }
        let caps = self.ensure_capabilities(&expanded_path).await?;
        self.execute_request(&req, &expanded_path, &caps, true)
            .await
    }
}
