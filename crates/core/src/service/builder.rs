//! [`CoreServiceBuilder`]: opens storage, wires dependencies, and starts the service.

use super::*;

pub(super) fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

pub(super) fn prepare_data_directories(config: &CoreConfig) -> CoreResult<()> {
    ensure_secure_socket_dir(&config.data_dir)?;
    fs::create_dir_all(config.data_dir.join("backups"))?;
    fs::create_dir_all(config.data_dir.join("ai-workdir"))?;
    if let Some(logs_dir) = &config.logs_dir {
        fs::create_dir_all(logs_dir)?;
    }
    Ok(())
}

/// Builder for [`CoreService`].
pub struct CoreServiceBuilder {
    pub(super) store: Store,
    pub(super) config: CoreConfig,
    pub(super) ai_bridge: Option<Arc<AiBridge>>,
    pub(super) secrets: Option<Arc<dyn SecretStore>>,
    pub(super) telegram: Option<TelegramClient>,
    pub(super) webhook: Option<WebhookClient>,
    pub(super) license_verifier: Option<LicenseVerifier>,
    pub(super) os_notify_hook: Option<OsNotificationHook>,
}

impl CoreServiceBuilder {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            config: CoreConfig::default(),
            ai_bridge: None,
            secrets: None,
            telegram: None,
            webhook: None,
            license_verifier: None,
            os_notify_hook: None,
        }
    }

    /// Open a production file-backed [`CoreServiceBuilder`] at `config.data_dir` (`03-desktop.md §1–2`):
    /// - Initializes `<data_dir>` (`0700` on Unix), `backups/`, `logs/`, and `ai-workdir/`.
    /// - Opens `dealsonar.db` in WAL mode with automatic pre-migration backups.
    /// - Wires [`KeyringSecretStore`] (OS keychain) unless `DEALSONAR_IN_MEMORY_SECRETS=1`.
    /// - Wires a real CLI [`AiProvider`] (`claude` / `codex` / `agy`, switching to persisted
    ///   `settings.ai_provider` on `start()`) unless `DEALSONAR_MOCK_AI=1`.
    pub fn open_production(config: CoreConfig) -> CoreResult<Self> {
        prepare_data_directories(&config)?;
        let db_path = config.data_dir.join("dealsonar.db");
        let backup_dir = config.data_dir.join("backups");
        Store::apply_pending_restore(&db_path, &backup_dir)?;
        let store = Store::open(&db_path, &backup_dir)?;

        let secrets: Arc<dyn SecretStore> = if env_flag_enabled("DEALSONAR_IN_MEMORY_SECRETS") {
            Arc::new(InMemorySecretStore::new())
        } else {
            Arc::new(KeyringSecretStore::new())
        };

        let ai_provider: Arc<dyn AiProvider> = if env_flag_enabled("DEALSONAR_MOCK_AI") {
            Arc::new(MockAiProvider::new())
        } else {
            let cli_cfg =
                CliAdapterConfig::new("claude").with_workdir(config.data_dir.join("ai-workdir"));
            Arc::new(ClaudeCliProvider::new(cli_cfg))
        };

        Ok(Self::new(store)
            .with_config(config)
            .with_secrets(secrets)
            .with_ai_provider(ai_provider))
    }

    /// Open a file-backed [`CoreServiceBuilder`] at `config.data_dir` using deterministic
    /// in-memory secrets and `MockAiProvider` for integration/contract tests.
    pub fn open_for_test(config: CoreConfig) -> CoreResult<Self> {
        prepare_data_directories(&config)?;
        let db_path = config.data_dir.join("dealsonar.db");
        let backup_dir = config.data_dir.join("backups");
        Store::apply_pending_restore(&db_path, &backup_dir)?;
        let store = Store::open(&db_path, &backup_dir)?;

        Ok(Self::new(store)
            .with_config(config)
            .with_secrets(Arc::new(InMemorySecretStore::new()))
            .with_ai_provider(Arc::new(MockAiProvider::new())))
    }

    pub fn with_config(mut self, config: CoreConfig) -> Self {
        self.config = config;
        self
    }

    pub fn with_ai_bridge(mut self, bridge: Arc<AiBridge>) -> Self {
        self.ai_bridge = Some(bridge);
        self
    }

    pub fn with_ai_provider(mut self, provider: Arc<dyn AiProvider>) -> Self {
        self.ai_bridge = Some(Arc::new(AiBridge::new(provider)));
        self
    }

    pub fn with_secrets(mut self, secrets: Arc<dyn SecretStore>) -> Self {
        self.secrets = Some(secrets);
        self
    }

    pub fn with_telegram_client(mut self, telegram: TelegramClient) -> Self {
        self.telegram = Some(telegram);
        self
    }

    /// Override the Telegram Bot API base URL (used by local mock HTTP servers in tests).
    pub fn with_telegram_api_base_url(
        mut self,
        api_base_url: impl Into<String>,
    ) -> CoreResult<Self> {
        let cfg = TelegramClientConfig {
            api_base_url: api_base_url.into(),
            ..TelegramClientConfig::default()
        };
        self.telegram = Some(TelegramClient::with_config(cfg)?);
        Ok(self)
    }

    pub fn with_webhook_client(mut self, webhook: WebhookClient) -> Self {
        self.webhook = Some(webhook);
        self
    }

    pub fn with_license_verifier(mut self, verifier: LicenseVerifier) -> Self {
        self.license_verifier = Some(verifier);
        self
    }

    pub fn with_os_notification_hook(mut self, hook: OsNotificationHook) -> Self {
        self.os_notify_hook = Some(hook);
        self
    }

    /// Start `CoreService`, binding `IpcListener` (if `config.ipc_endpoint` is set), enforcing
    /// license limits on startup, and spawning background workers (if `config.spawn_background_workers`).
    pub fn start(self) -> CoreResult<CoreService> {
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(CoreError::Internal(
                "CoreService must be started within the context of a Tokio 1.x runtime (enter a runtime handle or run inside an async task)".to_string(),
            ));
        }

        let ai_bridge = match self.ai_bridge {
            Some(b) => b,
            None => Arc::new(AiBridge::new(Arc::new(MockAiProvider::new()))),
        };
        let secrets: Arc<dyn SecretStore> = self
            .secrets
            .unwrap_or_else(|| Arc::new(InMemorySecretStore::new()));
        let telegram = match self.telegram {
            Some(t) => t,
            None => TelegramClient::new()?,
        };
        let webhook = match self.webhook {
            Some(w) => w,
            None => WebhookClient::new()?,
        };
        let license_verifier = self.license_verifier.unwrap_or_default();

        let (event_tx, _) = broadcast::channel(512);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let started_at_ms = now_ms();

        let rt = Arc::new(CoreRuntime {
            config: self.config.clone(),
            store: self.store,
            ai_bridge,
            secrets,
            telegram,
            webhook,
            license_verifier,
            ipc_hub: Arc::new(IpcHub::default()),
            ai_health: Mutex::new(AiRuntimeHealth::default()),
            incidents: Mutex::new(IncidentTracker::default()),
            previews: Mutex::new(std::collections::HashMap::new()),
            preview_cancellations: Mutex::new(std::collections::HashMap::new()),
            latest_preview_by_radar: Mutex::new(std::collections::HashMap::new()),
            last_emitted_health: Mutex::new(None),
            outbox_tracker: Mutex::new(BTreeMap::new()),
            os_notify_hook: RwLock::new(self.os_notify_hook),
            event_tx,
            job_wake: Arc::new(Notify::new()),
            outbox_wake: Arc::new(Notify::new()),
            outbox_pending: AtomicUsize::new(0),
            outbox_failed: AtomicUsize::new(0),
            shutting_down: AtomicBool::new(false),
            shutdown_tx,
            inflight_ai_calls: AtomicUsize::new(0),
            inflight_ai_notify: Arc::new(Notify::new()),
            started_at_ms,
        });

        // Restore persisted outbox pending/failed state across restarts
        rt.restore_outbox_tracker()?;

        // Enforce license limits on startup (e.g. if a Pro license expired while app was closed)
        let boot_license = rt.current_license_status(started_at_ms)?;
        let _ = enforce_plan_limits_on_store(&rt.store, &boot_license.limits, started_at_ms)?;

        // Restore persisted AI provider selection if no custom Mock provider was injected
        if rt.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock {
            if let Ok(settings) = rt.load_settings() {
                if let Some(pid) = settings.ai_provider {
                    let adapter = build_cli_provider_for_settings(pid, &settings, &rt.config);
                    rt.ai_bridge.set_provider(adapter);
                }
            }
        }

        let mut tasks = Vec::new();
        let bound_endpoint = if let Some(ep) = &self.config.ipc_endpoint {
            let listener = IpcListener::bind(ep)?;
            let actual_ep = ep.clone();
            tasks.push(spawn_ipc_server(
                listener,
                Arc::clone(&rt),
                shutdown_rx.clone(),
            ));
            Some(actual_ep)
        } else {
            None
        };

        if self.config.spawn_background_workers {
            tasks.extend(spawn_all_workers(&rt, &shutdown_rx));
        }

        Ok(CoreService {
            rt,
            bound_ipc_endpoint: bound_endpoint,
            worker_tasks: Mutex::new(tasks),
        })
    }
}
