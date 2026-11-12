use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::adapters::{
    build_probe_smoke_request, combine_system_and_prompt, fetch_cli_version,
    unwrap_cli_json_envelope, verify_mandatory_flags, CliAdapterConfig, SharedWorkdir,
    WorkdirHandle,
};
use crate::classify::classify_cli_failure;
use crate::subprocess::{resolve_binary_in_path, run_cli_subprocess, ScopedTempDir};
use crate::types::{
    AiError, AiProvider, AiRequest, AiResponse, ProbeMode, ProbeResult, ProviderId,
};

pub const AGY_MIN_TESTED_VERSION: &str = "1.5.4";

pub const AGY_MANDATORY_FLAGS: &[&str] = &[
    "--print",
    "--output-format",
    "--json-schema",
    "--print-timeout",
    "--sandbox",
    "--disable-slash-commands",
];

/// Hardened adapter for Antigravity CLI (`agy`, `06-ai-bridge.md §3.4`).
#[derive(Debug, Clone)]
pub struct AgyCliProvider {
    config: CliAdapterConfig,
    workdir: SharedWorkdir,
    verified_flags: Arc<RwLock<Option<Result<(), AiError>>>>,
}

impl Default for AgyCliProvider {
    fn default() -> Self {
        Self::new(CliAdapterConfig::new("agy"))
    }
}

impl AgyCliProvider {
    pub fn new(config: CliAdapterConfig) -> Self {
        let workdir = Arc::new(WorkdirHandle::from_option(config.workdir.clone()));
        Self {
            config,
            workdir,
            verified_flags: Arc::new(RwLock::new(None)),
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
        if resolve_binary_in_path(&self.config.binary_path, &expanded_path).is_none() {
            return ProbeResult {
                installed: false,
                version: None,
                authenticated: false,
                flags_supported: false,
                latency_ms: None,
                error: Some(AiError::NotInstalled.to_string()),
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
                    };
                }
            };

        if let Err(flag_err) = self.verify_and_cache_flags(&expanded_path).await {
            return ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: false,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(flag_err.to_string()),
            };
        }

        if mode == ProbeMode::Quick {
            return ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: None,
            };
        }

        let smoke_req = build_probe_smoke_request(self.config.probe_timeout);
        match self.execute_request(&smoke_req, &expanded_path).await {
            Ok(resp) => ProbeResult {
                installed: true,
                version,
                authenticated: true,
                flags_supported: true,
                latency_ms: Some(resp.duration.as_millis() as u64),
                error: None,
            },
            Err(AiError::NotAuthenticated) => ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(AiError::NotAuthenticated.to_string()),
            },
            Err(err @ AiError::RateLimited { .. }) => ProbeResult {
                installed: true,
                version,
                authenticated: true,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(format!("rate_limited: {err}")),
            },
            Err(other) => ProbeResult {
                installed: true,
                version,
                authenticated: false,
                flags_supported: true,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(other.to_string()),
            },
        }
    }

    async fn ensure_flags_verified(&self, expanded_path: &std::ffi::OsStr) -> Result<(), AiError> {
        if let Some(cached) = self.verified_flags.read().await.clone() {
            return cached;
        }
        self.verify_and_cache_flags(expanded_path).await
    }

    async fn verify_and_cache_flags(&self, expanded_path: &std::ffi::OsStr) -> Result<(), AiError> {
        let out = run_cli_subprocess(
            &self.config.binary_path,
            &["--help".to_string()],
            None,
            self.workdir.path(),
            expanded_path,
            &self.config.extra_env,
            Duration::from_secs(10).min(self.config.probe_timeout),
        )
        .await?;

        let help_text = format!("{}\n{}", out.stdout, out.stderr);
        let check = verify_mandatory_flags(
            ProviderId::AgyCli,
            AGY_MIN_TESTED_VERSION,
            &help_text,
            AGY_MANDATORY_FLAGS,
        );
        *self.verified_flags.write().await = Some(check.clone());
        check
    }

    async fn execute_request(
        &self,
        req: &AiRequest,
        expanded_path: &std::ffi::OsStr,
    ) -> Result<AiResponse, AiError> {
        // Per-call temp directory holding `schema.json`, cleaned up automatically on `Drop`.
        let call_tmp = ScopedTempDir::new("dealsonar-agy-call-").map_err(|e| AiError::Process {
            code: -1,
            stderr: format!("failed to create agy temp dir: {e}"),
        })?;
        let schema_path = call_tmp.path().join("schema.json");
        let schema_bytes = serde_json::to_vec(&req.schema)
            .map_err(|e| AiError::InvalidOutput(format!("invalid schema JSON: {e}")))?;
        tokio::fs::write(&schema_path, &schema_bytes)
            .await
            .map_err(|e| AiError::Process {
                code: -1,
                stderr: format!("failed to write agy schema file: {e}"),
            })?;

        let resolved_model = self
            .config
            .model_tiers
            .resolve(ProviderId::AgyCli, req.tier)
            .map(ToOwned::to_owned);

        let timeout_secs = req.timeout.as_secs().max(1);
        let mut args = vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
            "--json-schema".to_string(),
            schema_path.to_string_lossy().into_owned(),
        ];
        if let Some(ref m) = resolved_model {
            args.push("--model".to_string());
            args.push(m.clone());
        }
        args.extend([
            "--print-timeout".to_string(),
            format!("{timeout_secs}s"),
            "--sandbox".to_string(),
            "--disable-slash-commands".to_string(),
        ]);

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

        if raw.exit_code != 0 {
            return Err(classify_cli_failure(
                ProviderId::AgyCli,
                raw.exit_code,
                &raw.stderr,
                &raw.stdout,
            ));
        }

        let (output, usage, model) =
            unwrap_cli_json_envelope(&raw.stdout, &req.schema, resolved_model)?;

        Ok(AiResponse {
            output,
            usage,
            model,
            duration: raw.duration,
        })
    }
}

#[async_trait]
impl AiProvider for AgyCliProvider {
    fn id(&self) -> ProviderId {
        ProviderId::AgyCli
    }

    async fn probe(&self) -> ProbeResult {
        self.probe_with_mode(self.config.default_probe_mode).await
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        let expanded_path = self.config.effective_path();
        if resolve_binary_in_path(&self.config.binary_path, &expanded_path).is_none() {
            return Err(AiError::NotInstalled);
        }
        self.ensure_flags_verified(&expanded_path).await?;
        self.execute_request(&req, &expanded_path).await
    }
}
