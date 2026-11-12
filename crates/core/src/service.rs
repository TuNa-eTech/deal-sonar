//! Central `CoreService` Facade & Lifecycle Builder (`03-desktop.md §2–5`, `ipc.ts`, `api.ts`).
//!
//! Exposes all Tauri IPC commands as strongly typed Rust methods, wires the local multi-profile
//! `IpcServer` and background Tokio workers, enforces Ed25519 `Personal` vs `Pro` plan limits,
//! broadcasts the 6 real-time push events (`CoreEvent`), and handles graceful `shutdown()`
//! (waiting up to 10s for any in-flight AI call before closing IPC & SQLite).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use dealsonar_ai_bridge::{
    AgyCliProvider, AiBridge, AiProvider, ClaudeCliProvider, CliAdapterConfig, CodexCliProvider,
    MockAiProvider, ModelTier as BridgeModelTier, ModelTierMap as BridgeModelTierMap,
    SuggestFieldsInput as BridgeSuggestFieldsInput,
};
use dealsonar_notify::{
    export_csv, export_xlsx, validate_webhook_url, webhook_channel_key, ExportLeadRow,
    ExportOptions, InMemorySecretStore, KeyringSecretStore, SecretStore, SendMessageRequest,
    TelegramClient, TelegramClientConfig, TelegramDeliveryOutcome, WebhookClient,
    TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::ipc::{ensure_secure_socket_dir, IpcEndpoint, IpcListener};
use dealsonar_protocol::native_manifest::{
    chrome_manifest_path, verify_or_write_manifest, NativeHostManifest,
};
use dealsonar_protocol::{Body, CrawlReason, Envelope};
use dealsonar_store::models::{
    now_ms, CreateLeadInput, CreateRadarDraftInput as StoreCreateRadarDraftInput,
    ExtractedField as StoreExtractedField, FieldSource as StoreFieldSource,
    LeadFieldFilter as StoreDynamicFilter, LeadListQuery, LeadSort, NewRulesetInput,
    RecordAiCallInput, RecordFeedbackInput, SortDir, UpdateRadarInput as StoreUpdateRadarInput,
};
use dealsonar_store::Store;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, Notify};
use tokio::task::JoinHandle;

use crate::diagnostics::create_diagnostic_bundle;
use crate::dto::{
    extracted_fields_store_to_notify, field_def_from_ai, field_def_from_store,
    field_def_store_to_notify, field_def_to_store, filter_op_to_store, match_policy_to_store,
    notify_from_store, notify_to_store, radar_version_from_store, ruleset_record_to_dto,
    AiDailyUsageRow, AiProviderId, AiUsageStats, BlocklistEntry, BlocklistKind,
    BlocklistRemoveResult, Channel, ChannelConfig, ChannelRemoveResult, ChromeConnectOptions,
    ChromeConnectResult, Contact, ContactBlockResult, ContactDetail, CoreEvent, CrawlRun,
    CreateRadarDraftInput, DataBackupResult, DataDeleteAllResult, DataPurgeResult, DecidedBy,
    DiagnosticBundleResult, ExportFormat, FacebookSessionState, FeedbackLabel, FunnelStats,
    HardFilter, HealthStatus, LeadCrmPatch, LeadDetail, LeadEvent, LeadExportInput,
    LeadExportResult, LeadFeedbackInput, LeadFeedbackResult, LeadFilterQuery, LeadListResponse,
    LeadStatus, LicenseStatus, ModelTierMap, Post, PrefilterHintDto, PreviewRunState,
    PreviewStartInput, ProbeResult, Radar, RadarDetail, RadarNotifyConfig, RadarStatus,
    RadarTemplate, RadarUpdateResult, RejectReason, RejectedEvaluation, Ruleset, RulesetBody,
    RulesetCompileResult, Settings, SettingsPatch, Source, SourceCrawlNowResult, SourceState,
    SuggestFieldsInput, SuggestFieldsResult, TelegramSetupStatus, TelegramTestResult,
    UpdateRadarInput, WantIntent, WhenMissing,
};
use crate::error::{CoreError, CoreResult};
use crate::ipc_server::{push_crawl_request, spawn_ipc_server};
use crate::license::{enforce_plan_limits_on_store, LicenseVerifier, LICENSE_TOKEN_SETTING_KEY};
use crate::pipeline::{lead_detail_to_lead_dto, load_lead_dto, run_silent_backfill_24h};
use crate::preview_rules::{
    get_radar_preview, handle_negative_feedback_on_rule_eval, run_compile_ruleset_for_version,
    save_user_ruleset, start_radar_preview,
};
use crate::state::{
    AiRuntimeHealth, CoreConfig, CoreRuntime, IncidentTracker, InflightAiGuard, IpcHub,
    OsNotificationHook,
};
use crate::templates::{get_template, load_templates};
use crate::workers::{
    check_health_and_incidents, poll_telegram_once, process_due_outbox_batch, spawn_all_workers,
    tick_jobs_once,
};

/// Default Chrome Web Store / unpacked extension ID fallback used when `chrome_connect`
/// is invoked without an explicit `extension_id`.
pub const DEFAULT_CHROME_EXTENSION_ID: &str = "dealsonarchromeextensionid000001";

/// Settings table key storing the paired Chrome extension ID (`03-desktop.md §2.2`).
pub const CHROME_EXTENSION_ID_SETTING_KEY: &str = "chrome.extension_id";

/// Exact confirmation phrase required by `data_delete_all` (`04-data-model.md §5`, `03-ux-flows.md §6`).
pub const CONFIRM_DELETE_ALL_PHRASE: &str = "XOA TAT CA";

static LAST_RADAR_MUTATION_MS: AtomicI64 = AtomicI64::new(0);

/// Strictly monotonic millisecond timestamp for radar creation/mutation so creation-order
/// preservation (`enforce_plan_limits_on_store`) is 100% deterministic even within a single ms.
fn monotonic_radar_now_ms() -> i64 {
    let wall = now_ms();
    let mut prev = LAST_RADAR_MUTATION_MS.load(Ordering::SeqCst);
    loop {
        let next = wall.max(prev.saturating_add(1));
        match LAST_RADAR_MUTATION_MS.compare_exchange_weak(
            prev,
            next,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return next,
            Err(actual) => prev = actual,
        }
    }
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

fn prepare_data_directories(config: &CoreConfig) -> CoreResult<()> {
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
    store: Store,
    config: CoreConfig,
    ai_bridge: Option<Arc<AiBridge>>,
    secrets: Option<Arc<dyn SecretStore>>,
    telegram: Option<TelegramClient>,
    webhook: Option<WebhookClient>,
    license_verifier: Option<LicenseVerifier>,
    os_notify_hook: Option<OsNotificationHook>,
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

/// Central DealSonar Desktop Service (`03-desktop.md`).
pub struct CoreService {
    rt: Arc<CoreRuntime>,
    bound_ipc_endpoint: Option<IpcEndpoint>,
    worker_tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl CoreService {
    pub fn builder(store: Store) -> CoreServiceBuilder {
        CoreServiceBuilder::new(store)
    }

    /// Subscribe to real-time backend push events (`lead:new`, `lead:updated`, `preview:progress`,
    /// `health:changed`, `crawl:finished`, `job:failed`).
    pub fn subscribe_events(&self) -> broadcast::Receiver<CoreEvent> {
        self.rt.event_tx.subscribe()
    }

    /// Underlying shared runtime handle.
    pub fn runtime(&self) -> &Arc<CoreRuntime> {
        &self.rt
    }

    /// Underlying SQLite store handle.
    pub fn store(&self) -> &Store {
        &self.rt.store
    }

    /// Bound local IPC socket / named pipe endpoint (if configured).
    pub fn ipc_endpoint(&self) -> Option<&IpcEndpoint> {
        self.bound_ipc_endpoint.as_ref()
    }

    /// Register or replace the native desktop OS notification callback (`07-notifications-export.md §4`).
    pub fn set_os_notification_hook(&self, hook: Option<OsNotificationHook>) {
        *self.rt.os_notify_hook.write().expect("os hook lock") = hook;
    }

    /// Deterministic single-step worker pump useful in tests (`jobs` -> `outbox` -> `telegram` -> `health`).
    pub async fn tick_workers_now(&self) -> CoreResult<()> {
        let _ = tick_jobs_once(&self.rt).await?;
        let _ = process_due_outbox_batch(&self.rt).await?;
        let _ = poll_telegram_once(&self.rt).await;
        check_health_and_incidents(&self.rt, now_ms())?;
        Ok(())
    }

    /// Graceful shutdown (`03-desktop.md §2`):
    /// 1. Stops accepting new jobs and IPC connections (`shutting_down = true`).
    /// 2. Waits up to 10 seconds for any in-flight AI call (`inflight_ai_calls`) to complete.
    /// 3. Signals `shutdown_tx` and joins/aborts background Tokio tasks cleanly.
    pub async fn shutdown(&self) -> CoreResult<()> {
        self.rt.shutting_down.store(true, Ordering::SeqCst);
        let _ = self.rt.shutdown_tx.send(true);
        self.rt.job_wake.notify_waiters();
        self.rt.outbox_wake.notify_waiters();

        // Wait up to 10s for in-flight AI calls to finish cleanly
        let wait_in_flight = async {
            loop {
                let notified = self.rt.inflight_ai_notify.notified();
                if self.rt.inflight_ai_calls.load(Ordering::SeqCst) == 0 {
                    break;
                }
                notified.await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(10), wait_in_flight).await;

        let handles: Vec<JoinHandle<()>> = {
            let mut guard = self.worker_tasks.lock().expect("worker tasks lock");
            std::mem::take(&mut *guard)
        };
        for mut handle in handles {
            if tokio::time::timeout(Duration::from_millis(500), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
                let _ = handle.await;
            }
        }

        // Clear active IPC sender channels so connected relays observe clean EOF
        {
            let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
            hub.connections.clear();
        }

        Ok(())
    }

    fn ensure_not_shutting_down(&self) -> CoreResult<()> {
        if self.rt.shutting_down.load(Ordering::SeqCst) {
            return Err(CoreError::ShuttingDown);
        }
        Ok(())
    }

    // ========================================================================
    // 1. Radars (`radar_*`)
    // ========================================================================

    pub fn radar_list(&self) -> CoreResult<Vec<Radar>> {
        let now = now_ms();
        let items = self.rt.store.radar_list(false, now)?;
        let flood_set = self.rt.get_flood_auto_digest_radars()?;

        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let stats = self.rt.store.radar_stats(Some(&item.radar.id), now)?;
            let is_flood = flood_set.contains(&item.radar.id);
            out.push(Radar {
                id: item.radar.id,
                name: item.radar.name,
                status: RadarStatus::from_db(&item.radar.status),
                template_id: item.radar.template_id,
                current_version: item.radar.current_version,
                source_ids: item.source_ids,
                notify: notify_from_store(&item.radar.notify),
                created_at: item.radar.created_at,
                updated_at: item.radar.updated_at,
                leads_24h: Some(item.leads_24h),
                false_positive_rate: Some(item.false_positive_rate),
                evaluated_posts_total: Some(item.evaluated_posts_total),
                rule_handled_pct: Some(stats.rule_handled_ratio * 100.0),
                auto_digest_flood: is_flood.then_some(true),
            });
        }
        Ok(out)
    }

    pub fn radar_get(&self, id: &str) -> CoreResult<RadarDetail> {
        let now = now_ms();
        let rw = self
            .rt
            .store
            .radar_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: id.to_string(),
            })?;
        self.build_radar_detail_dto(&rw, now)
    }

    pub fn radar_create_draft(&self, input: CreateRadarDraftInput) -> CoreResult<RadarDetail> {
        self.ensure_not_shutting_down()?;
        if input.name.trim().is_empty() {
            return Err(CoreError::Validation(
                "Radar name cannot be empty".to_string(),
            ));
        }
        if input.description.trim().is_empty() {
            return Err(CoreError::Validation(
                "Radar description cannot be empty".to_string(),
            ));
        }

        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        if input.fields.len() > license.limits.max_fields_per_radar {
            return Err(CoreError::LicenseLimitExceeded(format!(
                "Current {:?} plan allows at most {} fields per radar (got {})",
                license.plan,
                license.limits.max_fields_per_radar,
                input.fields.len()
            )));
        }

        let settings = self.rt.load_settings()?;
        let mut base_notify = RadarNotifyConfig {
            channel_ids: Vec::new(),
            mode: settings.default_notify_mode,
            min_score: 0.6,
            quiet_hours: None,
        };
        if let Some(patch) = &input.notify {
            base_notify = patch.apply_onto(&base_notify);
        }

        // If `channel_ids` wasn't explicitly specified, default to all healthy channels so out-of-the-box alerts work seamlessly
        if input
            .notify
            .as_ref()
            .and_then(|n| n.channel_ids.as_ref())
            .is_none()
        {
            let channels = self.rt.store.channel_list()?;
            base_notify.channel_ids = channels
                .into_iter()
                .filter(|c| c.state == "ok")
                .map(|c| c.id)
                .collect();
        }

        let store_fields: Vec<_> = input.fields.iter().map(field_def_to_store).collect();
        let rw = self
            .rt
            .store
            .radar_create_draft(&StoreCreateRadarDraftInput {
                id: None,
                name: input.name.trim().to_string(),
                template_id: input.template_id.clone(),
                description: input.description,
                language_hint: input.language_hint.or_else(|| Some("vi".to_string())),
                user_profession: input.user_profession,
                fields: store_fields,
                match_policy: match_policy_to_store(&input.match_policy),
                source_ids: input.source_ids,
                notify: notify_to_store(&base_notify),
                now_ms: now,
            })?;

        // Auto-attach seed ruleset (`bds-vi-v1`) when creating from a template specifying it (`05-pipeline-rules.md §6.3`)
        if let Some(tid) = &input.template_id {
            if let Ok(tpl) = get_template(tid, self.rt.config.templates_dir.as_deref()) {
                if let Some(seed_name) = &tpl.seed_ruleset {
                    if let Some(seed_body) = dealsonar_rules::seed_ruleset(seed_name) {
                        let _ = self.rt.store.insert_ruleset(&NewRulesetInput {
                            id: None,
                            radar_version_id: rw.current_version.id.clone(),
                            state: "active".to_string(),
                            origin: "seed".to_string(),
                            body: serde_json::to_value(&seed_body)?,
                            metrics: None,
                            now_ms: now,
                        })?;
                    }
                }
            }
        }

        self.build_radar_detail_dto(&rw, now)
    }

    pub fn radar_update(&self, input: UpdateRadarInput) -> CoreResult<RadarUpdateResult> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let existing = self
            .rt
            .store
            .radar_get(&input.id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: input.id.clone(),
            })?;

        if let Some(fields) = &input.fields {
            let license = self.rt.current_license_status(now)?;
            if fields.len() > license.limits.max_fields_per_radar {
                return Err(CoreError::LicenseLimitExceeded(format!(
                    "Current {:?} plan allows at most {} fields per radar (got {})",
                    license.plan,
                    license.limits.max_fields_per_radar,
                    fields.len()
                )));
            }
        }

        // Case A: User is confirming an existing candidate version without additional field/description edits
        let no_def_edits = input.description.is_none()
            && input.user_profession.is_none()
            && input.fields.is_none()
            && input.match_policy.is_none();

        if input.confirm_version_upgrade == Some(true)
            && no_def_edits
            && existing.candidate_version.is_some()
        {
            let cand_ver = existing
                .candidate_version
                .as_ref()
                .expect("checked Some")
                .version;
            if input.name.is_some() || input.notify.is_some() || input.source_ids.is_some() {
                let next_notify = input.notify.as_ref().map(|patch| {
                    let cur = notify_from_store(&existing.radar.notify);
                    notify_to_store(&patch.apply_onto(&cur))
                });
                let _ = self.rt.store.radar_update(
                    &input.id,
                    &StoreUpdateRadarInput {
                        name: input.name.clone(),
                        notify: next_notify,
                        source_ids: input.source_ids.clone(),
                        description: None,
                        language_hint: None,
                        user_profession: None,
                        fields: None,
                        match_policy: None,
                        activate_immediately: true,
                        now_ms: now,
                    },
                )?;
            }

            let confirmed = self
                .rt
                .store
                .radar_confirm_version(&input.id, cand_ver, now)?;
            if confirmed.radar.status == "active" {
                let _ = self.rt.bump_and_push_config()?;
            }
            let detail = self.build_radar_detail_dto(&confirmed, now)?;
            return Ok(RadarUpdateResult {
                detail,
                created_new_version: false,
                requires_confirmation: false,
            });
        }

        let next_notify = input.notify.as_ref().map(|patch| {
            let cur = notify_from_store(&existing.radar.notify);
            notify_to_store(&patch.apply_onto(&cur))
        });
        let next_user_prof = match &input.user_profession {
            Some(opt) => opt.clone(),
            None => existing.current_version.user_profession.clone(),
        };
        let activate_immediately =
            existing.radar.status != "active" || input.confirm_version_upgrade == Some(true);

        let store_res = self.rt.store.radar_update(
            &input.id,
            &StoreUpdateRadarInput {
                name: input.name,
                notify: next_notify,
                source_ids: input.source_ids.clone(),
                description: input.description,
                language_hint: None,
                user_profession: input.user_profession.as_ref().map(|_| next_user_prof),
                fields: input
                    .fields
                    .as_ref()
                    .map(|fs| fs.iter().map(field_def_to_store).collect()),
                match_policy: input.match_policy.as_ref().map(match_policy_to_store),
                activate_immediately,
                now_ms: now,
            },
        )?;

        if store_res.radar.radar.status == "active" && input.source_ids.is_some() {
            let _ = self.rt.bump_and_push_config()?;
        }

        let detail = self.build_radar_detail_dto(&store_res.radar, now)?;
        Ok(RadarUpdateResult {
            detail,
            created_new_version: store_res.version_created.is_some(),
            requires_confirmation: store_res.pending_confirmation,
        })
    }

    pub async fn radar_suggest_fields(
        &self,
        input: SuggestFieldsInput,
    ) -> CoreResult<SuggestFieldsResult> {
        self.ensure_not_shutting_down()?;
        if input.description.trim().is_empty() {
            return Err(CoreError::Validation(
                "Description cannot be empty for field suggestion".to_string(),
            ));
        }

        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        let _inflight = InflightAiGuard::acquire(&self.rt);

        let bridge_input = BridgeSuggestFieldsInput {
            description: input.description,
            user_profession: input.user_profession,
            language_hint: input.language_hint.or_else(|| Some("vi".to_string())),
            closest_template: None,
        };

        let task_res = self.rt.ai_bridge.suggest_fields(&bridge_input).await?;
        for c in &task_res.calls {
            let _ = self.rt.store.record_ai_call(&RecordAiCallInput {
                id: None,
                provider: c.provider.as_str().to_string(),
                model: c.model.clone(),
                task: "suggest_fields".to_string(),
                radar_version_id: None,
                item_count: 1,
                input_tokens: c.input_tokens.map(|v| v as i64),
                output_tokens: c.output_tokens.map(|v| v as i64),
                cost_usd: c.cost_usd,
                duration_ms: c.duration_ms as i64,
                status: c.status.as_str().to_string(),
                error: c.error.clone(),
                now_ms: now,
            });
        }

        let out = task_res.output;
        let max_fields = license.limits.max_fields_per_radar;
        let fields: Vec<_> = out
            .fields
            .iter()
            .take(max_fields)
            .enumerate()
            .map(|(idx, sf)| {
                let mut f = field_def_from_ai(sf, idx as i32);
                f.order = idx as i32;
                f
            })
            .collect();

        let hard_filters = out
            .hard_filters
            .iter()
            .map(|hf| HardFilter {
                field: hf.field.clone(),
                op: crate::dto::FilterOperator::from_str_lossy(&hf.op),
                value: hf.value.clone(),
                when_missing: if hf.when_missing == "fail" {
                    WhenMissing::Fail
                } else {
                    WhenMissing::Pass
                },
            })
            .collect();

        let want_intent = match out.want_intent {
            dealsonar_ai_bridge::WantIntent::Demand => WantIntent::Demand,
            dealsonar_ai_bridge::WantIntent::Supply => WantIntent::Supply,
            dealsonar_ai_bridge::WantIntent::Any => WantIntent::Any,
        };

        let prefilter_hint = out.prefilter_hint.map(|ph| PrefilterHintDto {
            any: ph.any,
            none: ph.none,
        });

        Ok(SuggestFieldsResult {
            suggested_name: out.suggested_name,
            want_intent,
            fields,
            hard_filters,
            clarifying_questions: out.clarifying_questions,
            prefilter_hint,
        })
    }

    pub async fn radar_set_status(&self, id: &str, status: RadarStatus) -> CoreResult<Radar> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let existing = self
            .rt
            .store
            .radar_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: id.to_string(),
            })?;

        let prev_status = RadarStatus::from_db(&existing.radar.status);
        if status == RadarStatus::Active && prev_status != RadarStatus::Active {
            let license = self.rt.current_license_status(now)?;
            if let Some(max_active) = license.limits.max_active_radars {
                let cur_active =
                    usize::try_from(self.rt.store.count_active_radars()?.max(0)).unwrap_or(0);
                if cur_active >= max_active {
                    return Err(CoreError::LicenseLimitExceeded(format!(
                        "Current {:?} plan allows at most {} active radars",
                        license.plan, max_active
                    )));
                }
            }
        }

        let _ = self.rt.store.radar_set_status(id, status.as_str(), now)?;

        // If transitioning `Paused -> Active` (`02-radar-spec.md §4`), backfill last 24h silently!
        if status == RadarStatus::Active && prev_status == RadarStatus::Paused {
            let refreshed = self.rt.store.radar_get(id)?.unwrap_or(existing);
            let _ = run_silent_backfill_24h(&self.rt, &refreshed, now).await?;
            self.rt.job_wake.notify_one();
        }

        let _ = self.rt.bump_and_push_config()?;
        let _ = self.rt.emit_health_if_changed(now)?;

        let detail = self.radar_get(id)?;
        Ok(detail.radar)
    }

    pub async fn radar_preview_start(
        &self,
        input: PreviewStartInput,
    ) -> CoreResult<PreviewRunState> {
        self.ensure_not_shutting_down()?;
        start_radar_preview(&self.rt, input).await
    }

    pub fn radar_preview_get(
        &self,
        radar_id: &str,
        preview_id: Option<&str>,
    ) -> CoreResult<PreviewRunState> {
        get_radar_preview(&self.rt, radar_id, preview_id)
    }

    pub fn radar_stats(&self, radar_id: Option<&str>, days: u32) -> CoreResult<FunnelStats> {
        let now = now_ms();
        let s = self.rt.store.radar_stats(radar_id, now)?;
        Ok(FunnelStats {
            days: days.max(1),
            posts_captured: s.total_evaluated,
            dedup_dropped: s.dedup_rejected,
            prefilter_dropped: s.prefilter_rejected,
            rule_decided: s.rule_decided,
            rule_matched: s.rule_matched,
            ai_decided: s.ai_decided,
            ai_matched: s.ai_matched,
            leads_created: s.leads_total,
            leads_notified: s.leads_notified,
            leads_weak: s.leads_weak_match,
            false_positives: s.false_positive_count,
        })
    }

    fn build_radar_detail_dto(
        &self,
        rw: &dealsonar_store::models::RadarWithVersion,
        now: i64,
    ) -> CoreResult<RadarDetail> {
        let stats = self.rt.store.radar_stats(Some(&rw.radar.id), now)?;
        let flood_set = self.rt.get_flood_auto_digest_radars()?;
        let is_flood = flood_set.contains(&rw.radar.id);
        let list_items = self.rt.store.radar_list(true, now)?;
        let list_meta = list_items.iter().find(|i| i.radar.id == rw.radar.id);

        let cur_ver_dto = radar_version_from_store(&rw.current_version);
        let cand_ver_dto = rw.candidate_version.as_ref().map(radar_version_from_store);

        let mut versions = vec![cur_ver_dto.clone()];
        if let Some(cv) = &cand_ver_dto {
            if cv.id != cur_ver_dto.id {
                versions.push(cv.clone());
            }
        }
        versions.sort_by(|a, b| b.version.cmp(&a.version));

        let radar_dto = Radar {
            id: rw.radar.id.clone(),
            name: rw.radar.name.clone(),
            status: RadarStatus::from_db(&rw.radar.status),
            template_id: rw.radar.template_id.clone(),
            current_version: rw.radar.current_version,
            source_ids: rw.source_ids.clone(),
            notify: notify_from_store(&rw.radar.notify),
            created_at: rw.radar.created_at,
            updated_at: rw.radar.updated_at,
            leads_24h: list_meta.map(|m| m.leads_24h),
            false_positive_rate: list_meta.map(|m| m.false_positive_rate),
            evaluated_posts_total: list_meta.map(|m| m.evaluated_posts_total),
            rule_handled_pct: Some(stats.rule_handled_ratio * 100.0),
            auto_digest_flood: is_flood.then_some(true),
        };

        Ok(RadarDetail {
            radar: radar_dto,
            current_version_data: cur_ver_dto,
            pending_version_data: cand_ver_dto,
            versions,
        })
    }

    // ========================================================================
    // 2. Templates (`template_*`)
    // ========================================================================

    pub fn template_list(&self) -> CoreResult<Vec<RadarTemplate>> {
        load_templates(self.rt.config.templates_dir.as_deref())
    }

    pub fn template_get(&self, id: &str) -> CoreResult<RadarTemplate> {
        get_template(id, self.rt.config.templates_dir.as_deref())
    }

    // ========================================================================
    // 3. Sources (`source_*`)
    // ========================================================================

    pub fn source_list(&self) -> CoreResult<Vec<Source>> {
        let now = now_ms();
        let items = self.rt.store.source_list(now)?;
        let last_errors = self.rt.get_source_last_errors()?;

        Ok(items
            .into_iter()
            .map(|item| {
                let s = item.source;
                let last_error = last_errors.get(&s.id).cloned();
                Source {
                    id: s.id,
                    platform: s.platform,
                    kind: s.kind,
                    external_id: s.external_id,
                    name: s.name,
                    url: s.url,
                    privacy: s.privacy,
                    member_count: s.member_count,
                    profile_id: s.profile_id,
                    followed: s.followed,
                    priority: s.priority > 0,
                    state: SourceState::from_db(&s.state),
                    last_crawl_at: s.last_crawl_at,
                    avg_new_posts: s.avg_new_posts,
                    posts_per_day: item.posts_last_24h,
                    stored_post_count: item.stored_post_count,
                    last_error,
                    created_at: s.created_at,
                }
            })
            .collect())
    }

    pub fn source_follow(&self, id: &str) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let existing = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;

        if !existing.followed {
            let license = self.rt.current_license_status(now)?;
            let cur_followed =
                usize::try_from(self.rt.store.count_followed_sources()?.max(0)).unwrap_or(0);
            if cur_followed >= license.limits.max_followed_groups {
                return Err(CoreError::LicenseLimitExceeded(format!(
                    "Current {:?} plan allows following at most {} groups",
                    license.plan, license.limits.max_followed_groups
                )));
            }
            self.rt.store.source_follow(id)?;
            let _ = self.rt.bump_and_push_config()?;
        }

        self.get_source_dto(id)
    }

    pub fn source_unfollow(&self, id: &str) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let _ = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;
        self.rt.store.source_unfollow(id)?;
        let _ = self.rt.bump_and_push_config()?;
        self.get_source_dto(id)
    }

    pub fn source_set_priority(&self, id: &str, priority: bool) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let existing = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;

        if priority && existing.priority <= 0 {
            let all_sources = self.rt.store.source_list(now_ms())?;
            let cur_priority_count = all_sources
                .iter()
                .filter(|s| s.source.priority > 0 && s.source.id != id)
                .count();
            if cur_priority_count >= crate::scheduler::MAX_PRIORITY_SOURCES {
                return Err(CoreError::Validation(format!(
                    "Maximum {} priority groups allowed (`02-extension.md §6.2`)",
                    crate::scheduler::MAX_PRIORITY_SOURCES
                )));
            }
        }

        self.rt
            .store
            .source_set_priority(id, if priority { 1 } else { 0 })?;
        let _ = self.rt.bump_and_push_config()?;
        self.get_source_dto(id)
    }

    pub fn source_crawl_now(
        &self,
        id: &str,
        reason: Option<&str>,
    ) -> CoreResult<SourceCrawlNowResult> {
        self.ensure_not_shutting_down()?;
        let source = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;
        let crawl_reason = match reason {
            Some("preview") => CrawlReason::Preview,
            _ => CrawlReason::Manual,
        };
        let settings = self.rt.load_settings()?;
        let sent = push_crawl_request(
            &self.rt,
            &source,
            crawl_reason,
            settings.crawl_policy.max_posts_per_visit,
        );
        Ok(SourceCrawlNowResult {
            queued: sent > 0,
            run_id: dealsonar_protocol::new_ulid(),
        })
    }

    fn get_source_dto(&self, id: &str) -> CoreResult<Source> {
        self.source_list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })
    }

    // ========================================================================
    // 4. Leads (`lead_*`)
    // ========================================================================

    pub fn lead_list(&self, query: LeadFilterQuery) -> CoreResult<LeadListResponse> {
        let store_query = self.build_store_lead_query(&query)?;
        let page = self.rt.store.lead_list(&store_query)?;

        let mut items = Vec::with_capacity(page.items.len());
        for item in &page.items {
            if let Some(dto) = load_lead_dto(&self.rt, &item.lead.id)? {
                if query.include_weak == Some(false) && dto.is_weak_match {
                    continue;
                }
                items.push(dto);
            }
        }

        let total = items.len();
        Ok(LeadListResponse {
            items,
            total,
            next_cursor: page.next_cursor,
        })
    }

    pub fn lead_get(&self, id: &str) -> CoreResult<LeadDetail> {
        let detail = self
            .rt
            .store
            .lead_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "lead",
                id: id.to_string(),
            })?;

        let rw = self.rt.store.radar_get(&detail.lead.radar_id)?;
        let min_score = rw.as_ref().map(|r| r.radar.notify.min_score).unwrap_or(0.6);
        let ver = self
            .rt
            .store
            .radar_get_version(&detail.lead.radar_version_id)?;
        let radar_fields: Vec<_> = ver
            .as_ref()
            .map(|v| v.fields.iter().map(field_def_from_store).collect())
            .unwrap_or_default();

        let fb_map = self.rt.get_eval_feedback_labels()?;
        let feedback_label = fb_map
            .get(&detail.lead.evaluation_id)
            .and_then(|s| FeedbackLabel::from_db(s));

        let lead_dto = lead_detail_to_lead_dto(&detail, min_score, feedback_label);

        let post_rec = self
            .rt
            .store
            .post_get(&detail.lead.post_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "post",
                id: detail.lead.post_id.clone(),
            })?;
        let post_dto = post_detail_to_dto(&post_rec);

        let events = detail
            .events
            .iter()
            .map(|ev| LeadEvent {
                id: ev.id.clone(),
                lead_id: ev.lead_id.clone(),
                kind: ev.kind.clone(),
                data: ev.data.as_ref().and_then(|v| {
                    v.as_object()
                        .map(|m| m.iter().map(|(k, val)| (k.clone(), val.clone())).collect())
                }),
                created_at: ev.created_at,
            })
            .collect();

        Ok(LeadDetail {
            lead: lead_dto,
            post: post_dto,
            radar_fields,
            events,
        })
    }

    pub fn lead_set_status(
        &self,
        id: &str,
        status: LeadStatus,
        crm_patch: Option<LeadCrmPatch>,
    ) -> CoreResult<LeadDetail> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let existing = self
            .rt
            .store
            .lead_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "lead",
                id: id.to_string(),
            })?;

        self.rt.store.lead_set_status(id, status.as_str(), now)?;

        if let Some(patch) = crm_patch {
            if patch.note.is_some() || patch.tags.is_some() || patch.follow_up_at.is_some() {
                let next_note = match patch.note {
                    Some(n) => n,
                    None => existing.lead.note,
                };
                let next_tags = match patch.tags {
                    Some(t) => t,
                    None => Some(existing.lead.tags),
                };
                let next_followup = match patch.follow_up_at {
                    Some(f) => f,
                    None => existing.lead.follow_up_at,
                };
                self.rt.store.lead_set_note_tags_followup(
                    id,
                    next_note,
                    next_tags,
                    next_followup,
                    now,
                )?;
            }
        }

        let detail = self.lead_get(id)?;
        self.rt.emit(CoreEvent::LeadUpdated(detail.lead.clone()));
        Ok(detail)
    }

    pub fn lead_update_field(
        &self,
        id: &str,
        field_key: &str,
        value: Value,
        raw: Option<String>,
    ) -> CoreResult<LeadDetail> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        self.rt
            .store
            .lead_update_field(id, field_key, value, raw, now)?;
        let detail = self.lead_get(id)?;
        self.rt.emit(CoreEvent::LeadUpdated(detail.lead.clone()));
        Ok(detail)
    }

    pub fn lead_feedback(&self, input: LeadFeedbackInput) -> CoreResult<LeadFeedbackResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();

        // Optional corrected_fields conversion
        let corrected_store = input.corrected_fields.as_ref().map(|map| {
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        StoreExtractedField {
                            value: v.clone(),
                            raw: None,
                            confidence: 1.0,
                            source: StoreFieldSource::User,
                        },
                    )
                })
                .collect::<BTreeMap<String, StoreExtractedField>>()
        });

        let fb_rec = self.rt.store.record_feedback(&RecordFeedbackInput {
            evaluation_id: input.evaluation_id.clone(),
            label: input.label.as_str().to_string(),
            corrected_fields: corrected_store,
            post_text: None,
            origin: input.origin.as_str().to_string(),
            now_ms: now,
        })?;
        self.rt
            .set_eval_feedback_label(&input.evaluation_id, input.label.as_str())?;

        // Apply `corrected_fields` onto the lead as `source = user` if `lead_id` is given
        if let (Some(lid), Some(corr)) = (&input.lead_id, &input.corrected_fields) {
            for (fkey, fval) in corr {
                let _ = self
                    .rt
                    .store
                    .lead_update_field(lid, fkey, fval.clone(), None, now);
            }
        }

        // Check immediate demote if negative feedback on rule-decided evaluation
        if input.label.is_negative() {
            if let Some(eval_rec) = self.rt.store.get_evaluation(&input.evaluation_id)? {
                let _ = handle_negative_feedback_on_rule_eval(&self.rt, &eval_rec, now)?;
            }
        }

        // If `label == Missed` on a rejected evaluation (`origin == App`), promote to Inbox lead silently
        let mut target_lead_id = input.lead_id.clone();
        let mut created_new_lead = false;
        if input.label == FeedbackLabel::Missed && target_lead_id.is_none() {
            if let Some(ver) = self.rt.store.radar_get_version(&fb_rec.radar_version_id)? {
                let (created_lead, was_created) = self.rt.store.create_lead(&CreateLeadInput {
                    id: None,
                    radar_id: ver.radar_id,
                    radar_version_id: ver.id,
                    post_id: fb_rec.post_id.clone(),
                    evaluation_id: fb_rec.evaluation_id.clone(),
                    contact_id: None,
                    status: "new".to_string(),
                    score: 0.75,
                    summary: fb_rec.post_text.chars().take(120).collect::<String>(),
                    fields: BTreeMap::new(),
                    also_seen_in: None,
                    notified_at: None,
                    follow_up_at: None,
                    note: None,
                    tags: Some(Vec::new()),
                    now_ms: now,
                })?;
                target_lead_id = Some(created_lead.id);
                created_new_lead = was_created;
            }
        }

        // Optional `block_author` shortcut (`03-ux-flows.md §3`)
        let mut blocked_entry = None;
        if input.block_author == Some(true) {
            if let Some(post_detail) = self.rt.store.post_get(&fb_rec.post_id)? {
                if let Some(aid) = &post_detail.post.author_id {
                    let blk = self.rt.store.blocklist_add(
                        "author",
                        aid,
                        None,
                        Some("blocked_from_feedback"),
                        now,
                    )?;
                    blocked_entry = Some(blocklist_record_to_dto(&blk, post_detail.author_name));
                }
            }
        }

        let updated_lead = match &target_lead_id {
            Some(lid) => load_lead_dto(&self.rt, lid)?,
            None => None,
        };
        if let Some(l) = &updated_lead {
            if created_new_lead {
                self.rt.emit(CoreEvent::LeadNew(l.clone()));
            } else {
                self.rt.emit(CoreEvent::LeadUpdated(l.clone()));
            }
        }

        Ok(LeadFeedbackResult {
            feedback_id: fb_rec.id,
            updated_lead,
            blocked_entry,
        })
    }

    pub fn lead_export(&self, input: LeadExportInput) -> CoreResult<LeadExportResult> {
        let now = now_ms();
        if input.format == ExportFormat::Xlsx {
            let license = self.rt.current_license_status(now)?;
            if !license.limits.allow_xlsx_export {
                return Err(CoreError::LicenseLimitExceeded(
                    "XLSX export requires the Pro (Chuyên nghiệp) plan; CSV export is available on all plans".to_string(),
                ));
            }
        }

        let mut export_query = input.query.clone();
        if export_query.limit.is_none() {
            export_query.limit = Some(500);
        }
        let store_query = self.build_store_lead_query(&export_query)?;
        let page = self.rt.store.lead_list(&store_query)?;

        // Collect union of field definitions across matching radars (or specific radar)
        let notify_fields: Vec<dealsonar_notify::FieldDef> =
            if let Some(rid) = &input.query.radar_id {
                self.rt
                    .store
                    .radar_get(rid)?
                    .map(|rw| {
                        rw.current_version
                            .fields
                            .iter()
                            .map(field_def_store_to_notify)
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                let mut seen = HashSet::new();
                let mut defs = Vec::new();
                for r in self.rt.store.radar_list(true, now)? {
                    for f in &r.current_version.fields {
                        if seen.insert(f.key.clone()) {
                            defs.push(field_def_store_to_notify(f));
                        }
                    }
                }
                defs
            };

        let mut rows = Vec::with_capacity(page.items.len());
        for item in &page.items {
            if input.query.include_weak == Some(false) {
                let min_s = self
                    .rt
                    .store
                    .radar_get(&item.lead.radar_id)?
                    .map(|rw| rw.radar.notify.min_score)
                    .unwrap_or(0.6);
                if item.lead.score < min_s {
                    continue;
                }
            }
            rows.push(ExportLeadRow {
                post_created_at: item.post_created_at,
                radar_name: item.radar_name.clone(),
                status: item.lead.status.clone(),
                score: item.lead.score,
                summary: item.lead.summary.clone(),
                group_name: item.source_name.clone(),
                author_name: item
                    .author_name
                    .clone()
                    .unwrap_or_else(|| "Ẩn danh".to_string()),
                permalink: item.permalink.clone(),
                post_text: input
                    .include_post_text
                    .then(|| item.post_text.clone())
                    .flatten(),
                fields: extracted_fields_store_to_notify(&item.lead.fields),
            });
        }

        let export_opts = ExportOptions {
            include_post_text: input.include_post_text,
        };
        let bytes = match input.format {
            ExportFormat::Csv => export_csv(&export_opts, &notify_fields, &rows)?,
            ExportFormat::Xlsx => export_xlsx(&export_opts, &notify_fields, &rows)?,
        };

        let out_path = match &input.dest_path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => {
                let export_dir = self.rt.config.data_dir.join("exports");
                fs::create_dir_all(&export_dir)?;
                export_dir.join(format!("leads-{now}.{}", input.format.as_str()))
            }
        };
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(&out_path, &bytes)?;

        let content_preview = (input.format == ExportFormat::Csv).then(|| {
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(4_096)
                .collect()
        });

        Ok(LeadExportResult {
            path: out_path.to_string_lossy().into_owned(),
            format: input.format,
            row_count: rows.len(),
            content_preview,
        })
    }

    fn build_store_lead_query(&self, q: &LeadFilterQuery) -> CoreResult<LeadListQuery> {
        let min_score = if q.include_weak == Some(false) {
            if let Some(rid) = &q.radar_id {
                self.rt
                    .store
                    .radar_get(rid)?
                    .map(|rw| rw.radar.notify.min_score)
            } else {
                Some(0.6)
            }
        } else {
            None
        };

        let filters = q
            .filters
            .as_ref()
            .map(|fs| {
                fs.iter()
                    .map(|f| StoreDynamicFilter {
                        field: f.field.clone(),
                        op: filter_op_to_store(f.op),
                        value: f.value.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let sort = q.sort.as_ref().map(|s| LeadSort {
            by: s.by.clone(),
            dir: if s.dir.eq_ignore_ascii_case("asc") {
                SortDir::Asc
            } else {
                SortDir::Desc
            },
        });

        Ok(LeadListQuery {
            radar_id: q.radar_id.clone(),
            status: q
                .status
                .as_ref()
                .map(|sts| sts.iter().map(|st| st.as_str().to_string()).collect()),
            since: q.since,
            min_score,
            search: q.search.clone(),
            filters,
            sort,
            limit: q.limit.unwrap_or(50).clamp(1, 500),
            cursor: q.cursor.clone(),
        })
    }

    // ========================================================================
    // 5. Posts & Rejected Evaluations (`post_*`, `evaluation_list_rejected`)
    // ========================================================================

    pub fn post_get(&self, id: &str) -> CoreResult<Post> {
        let detail = self
            .rt
            .store
            .post_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "post",
                id: id.to_string(),
            })?;
        Ok(post_detail_to_dto(&detail))
    }

    pub fn post_search(
        &self,
        query: &str,
        source_id: Option<&str>,
        limit: usize,
    ) -> CoreResult<Vec<Post>> {
        let items = self.rt.store.post_search(query, source_id, limit)?;
        Ok(items.iter().map(post_detail_to_dto).collect())
    }

    pub fn evaluation_list_rejected(
        &self,
        radar_id: &str,
        limit: usize,
    ) -> CoreResult<Vec<RejectedEvaluation>> {
        let items = self.rt.store.evaluation_list_rejected(radar_id, limit)?;
        let fb_map = self.rt.get_eval_feedback_labels()?;

        Ok(items
            .into_iter()
            .map(|it| {
                let marked_missed = fb_map
                    .get(&it.evaluation_id)
                    .is_some_and(|l| l == "missed")
                    .then_some(true);
                RejectedEvaluation {
                    evaluation_id: it.evaluation_id,
                    post_id: it.post_id,
                    radar_id: radar_id.to_string(),
                    radar_version_id: it.radar_version_id,
                    decided_by: DecidedBy::from_db(it.decided_by.as_deref()),
                    reject_reason: RejectReason::from_db(it.reject_reason.as_deref()),
                    score: it.score,
                    reason: it.reason,
                    source_name: it.source_name,
                    author_name: it.author_name.unwrap_or_else(|| "Ẩn danh".to_string()),
                    permalink: it.permalink,
                    post_text: it.post_text.unwrap_or_default(),
                    captured_at: it.created_at,
                    marked_missed,
                }
            })
            .collect())
    }

    // ========================================================================
    // 6. Contacts & Blocklist (`contact_*`, `blocklist_*`)
    // ========================================================================

    pub fn contact_list(&self, search: Option<&str>, limit: usize) -> CoreResult<Vec<Contact>> {
        let summaries = self.rt.store.contact_list(search, limit)?;
        let blocklist = self.rt.store.blocklist_list(None)?;

        Ok(summaries
            .into_iter()
            .map(|cs| contact_record_to_dto(&cs.contact, cs.lead_count, &blocklist))
            .collect())
    }

    pub fn contact_get(&self, id: &str) -> CoreResult<ContactDetail> {
        let detail = self
            .rt
            .store
            .contact_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;
        let blocklist = self.rt.store.blocklist_list(None)?;
        let contact_dto =
            contact_record_to_dto(&detail.contact, detail.leads.len() as i64, &blocklist);

        let mut leads = Vec::with_capacity(detail.leads.len());
        for item in &detail.leads {
            if let Some(dto) = load_lead_dto(&self.rt, &item.lead.id)? {
                leads.push(dto);
            }
        }

        Ok(ContactDetail {
            contact: contact_dto,
            leads,
        })
    }

    pub fn contact_block(
        &self,
        id: &str,
        reason: Option<&str>,
        radar_id: Option<&str>,
    ) -> CoreResult<ContactBlockResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let detail = self
            .rt
            .store
            .contact_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;

        let mut blocked_entries = Vec::new();
        for phone in &detail.contact.phones {
            let rec = self
                .rt
                .store
                .blocklist_add("phone", phone, radar_id, reason, now)?;
            blocked_entries.push(blocklist_record_to_dto(
                &rec,
                detail.contact.display_name.clone(),
            ));
        }
        for aid in &detail.contact.author_ids {
            let rec = self
                .rt
                .store
                .blocklist_add("author", aid, radar_id, reason, now)?;
            blocked_entries.push(blocklist_record_to_dto(
                &rec,
                detail.contact.display_name.clone(),
            ));
        }

        Ok(ContactBlockResult { blocked_entries })
    }

    pub fn contact_note(&self, id: &str, note: &str) -> CoreResult<Contact> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let note_opt = (!note.trim().is_empty()).then_some(note);
        let updated = self
            .rt
            .store
            .contact_note(id, note_opt, now)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;
        let detail = self.rt.store.contact_get(id)?;
        let lead_count = detail.map(|d| d.leads.len() as i64).unwrap_or(0);
        let blocklist = self.rt.store.blocklist_list(None)?;
        Ok(contact_record_to_dto(&updated, lead_count, &blocklist))
    }

    pub fn blocklist_list(&self, radar_id: Option<&str>) -> CoreResult<Vec<BlocklistEntry>> {
        let entries = self.rt.store.blocklist_list(radar_id)?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let label = if e.kind == "author" {
                    self.rt
                        .store
                        .author_get(&e.value)
                        .ok()
                        .flatten()
                        .map(|a| a.name)
                } else {
                    None
                };
                blocklist_record_to_dto(&e, label)
            })
            .collect())
    }

    pub fn blocklist_add(
        &self,
        kind: BlocklistKind,
        value: &str,
        reason: Option<&str>,
        radar_id: Option<&str>,
    ) -> CoreResult<BlocklistEntry> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let rec = self
            .rt
            .store
            .blocklist_add(kind.as_str(), value, radar_id, reason, now)?;
        let label = if rec.kind == "author" {
            self.rt
                .store
                .author_get(&rec.value)
                .ok()
                .flatten()
                .map(|a| a.name)
        } else {
            None
        };
        Ok(blocklist_record_to_dto(&rec, label))
    }

    pub fn blocklist_remove(&self, id: &str) -> CoreResult<BlocklistRemoveResult> {
        self.ensure_not_shutting_down()?;
        let removed = self.rt.store.blocklist_remove(id)?;
        Ok(BlocklistRemoveResult { removed })
    }

    // ========================================================================
    // 7. Rulesets (`ruleset_*`)
    // ========================================================================

    pub fn ruleset_list(
        &self,
        radar_id: &str,
        radar_version_id: Option<&str>,
    ) -> CoreResult<Vec<Ruleset>> {
        let target_rvid = match radar_version_id {
            Some(rvid) if !rvid.trim().is_empty() => rvid.to_string(),
            _ => {
                let rw = self
                    .rt
                    .store
                    .radar_get(radar_id)?
                    .ok_or_else(|| CoreError::NotFound {
                        entity: "radar",
                        id: radar_id.to_string(),
                    })?;
                rw.current_version.id
            }
        };
        let records = self.rt.store.list_rulesets(&target_rvid)?;
        Ok(records.iter().map(ruleset_record_to_dto).collect())
    }

    pub fn ruleset_save_user(
        &self,
        radar_id: &str,
        radar_version_id: &str,
        body: RulesetBody,
    ) -> CoreResult<Ruleset> {
        self.ensure_not_shutting_down()?;
        let rw = self
            .rt
            .store
            .radar_get(radar_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        if rw.current_version.id != radar_version_id
            && rw
                .candidate_version
                .as_ref()
                .is_none_or(|c| c.id != radar_version_id)
        {
            return Err(CoreError::Validation(format!(
                "radar_version_id '{}' does not belong to radar '{}'",
                radar_version_id, radar_id
            )));
        }
        save_user_ruleset(&self.rt, radar_version_id, body, now_ms())
    }

    pub async fn ruleset_compile_now(&self, radar_id: &str) -> CoreResult<RulesetCompileResult> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        if !license.limits.allow_auto_rulesets {
            return Err(CoreError::LicenseLimitExceeded(
                "AI auto-ruleset compilation requires the Pro (Chuyên nghiệp) plan; manual ruleset editing is available on all plans".to_string(),
            ));
        }

        let rw = self
            .rt
            .store
            .radar_get(radar_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        let rvid = rw.current_version.id.clone();

        // Record a durable job and run compilation immediately so UI gets instant feedback when samples exist
        let dedup = format!("compile_ruleset:{rvid}");
        let (job, _) = self.rt.store.enqueue_job(
            "compile_ruleset",
            Some(&dedup),
            &json!({ "radar_version_id": rvid }),
            now,
            now,
        )?;

        if let Some(claimed) = self.rt.store.claim_due_job(now)? {
            if claimed.id == job.id {
                match run_compile_ruleset_for_version(&self.rt, &rvid).await {
                    Ok(opt_rs) => {
                        let _ = self.rt.store.complete_job(&claimed.id);
                        return Ok(RulesetCompileResult {
                            job_id: claimed.id,
                            ruleset: opt_rs.as_ref().map(ruleset_record_to_dto),
                        });
                    }
                    Err(err) => {
                        let _ =
                            self.rt
                                .store
                                .fail_or_retry_job(&claimed.id, &err.to_string(), None);
                        return Err(err);
                    }
                }
            }
        }

        Ok(RulesetCompileResult {
            job_id: job.id,
            ruleset: None,
        })
    }

    // ========================================================================
    // 8. Settings, AI, Telegram, Channels, Webhook, Chrome, License
    // ========================================================================

    pub fn settings_get(&self) -> CoreResult<Settings> {
        self.rt.load_settings()
    }

    pub fn settings_set(&self, patch: SettingsPatch) -> CoreResult<Settings> {
        self.ensure_not_shutting_down()?;
        let mut settings = self.rt.load_settings()?;
        let mut crawl_changed = false;

        if let Some(v) = patch.privacy_consent_accepted {
            settings.privacy_consent_accepted = v;
        }
        if let Some(v) = patch.onboarding_completed {
            settings.onboarding_completed = v;
        }
        if let Some(v) = patch.launch_at_login {
            settings.launch_at_login = v;
        }
        if let Some(v) = patch.ai_provider {
            settings.ai_provider = v;
        }
        if let Some(v) = patch.model_tiers {
            settings.model_tiers = v;
        }
        if let Some(v) = patch.daily_ai_post_cap {
            settings.daily_ai_post_cap = v.max(1);
        }
        if let Some(v) = patch.default_notify_mode {
            settings.default_notify_mode = v;
        }
        if let Some(v) = patch.digest_interval_minutes {
            settings.digest_interval_minutes = v.max(1);
        }
        if let Some(v) = patch.quiet_hours_enabled {
            settings.quiet_hours_enabled = v;
        }
        if let Some(v) = patch.quiet_hours {
            settings.quiet_hours = v;
        }
        if let Some(v) = patch.os_notifications_enabled {
            settings.os_notifications_enabled = v;
        }
        if let Some(cp) = patch.crawl_policy {
            if let Some(v) = cp.group_interval_minutes {
                settings.crawl_policy.group_interval_minutes = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.priority_interval_minutes {
                settings.crawl_policy.priority_interval_minutes = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.hourly_page_load_budget {
                settings.crawl_policy.hourly_page_load_budget = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.daily_page_load_budget {
                settings.crawl_policy.daily_page_load_budget = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.active_hours {
                settings.crawl_policy.active_hours = v;
                crawl_changed = true;
            }
            if let Some(v) = cp.max_scroll_steps {
                settings.crawl_policy.max_scroll_steps = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.max_posts_per_visit {
                settings.crawl_policy.max_posts_per_visit = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.only_when_idle {
                settings.crawl_policy.only_when_idle = v;
                crawl_changed = true;
            }
        }
        if let Some(v) = patch.unmatched_retention_days {
            settings.unmatched_retention_days = v.max(1);
        }
        if let Some(v) = patch.debug_keep_ai_io {
            settings.debug_keep_ai_io = v;
        }

        self.rt.save_settings(&settings)?;
        if crawl_changed {
            let _ = self.rt.bump_and_push_config()?;
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(settings)
    }

    pub async fn ai_probe(
        &self,
        provider: Option<AiProviderId>,
    ) -> CoreResult<BTreeMap<AiProviderId, ProbeResult>> {
        let settings = self.rt.load_settings()?;
        let targets = match provider {
            Some(p) => vec![p],
            None => vec![
                AiProviderId::ClaudeCli,
                AiProviderId::CodexCli,
                AiProviderId::AgyCli,
            ],
        };

        let mut out = BTreeMap::new();
        for pid in targets {
            let raw_probe = if self.rt.ai_bridge.provider_id()
                == dealsonar_ai_bridge::ProviderId::Mock
                || self.rt.ai_bridge.provider_id() == pid.to_bridge_id()
            {
                self.rt.ai_bridge.probe().await
            } else {
                let adapter = build_cli_provider_for_settings(pid, &settings, &self.rt.config);
                adapter.probe().await
            };

            out.insert(
                pid,
                ProbeResult {
                    provider: pid,
                    binary_name: pid.binary_name().to_string(),
                    installed: raw_probe.installed,
                    version: raw_probe.version,
                    authenticated: raw_probe.authenticated,
                    flags_supported: raw_probe.flags_supported,
                    latency_ms: raw_probe.latency_ms,
                    error: raw_probe.error,
                    install_hint: pid.install_hint().to_string(),
                    login_command: pid.login_command().to_string(),
                },
            );
        }
        Ok(out)
    }

    pub fn ai_set_provider(
        &self,
        provider: AiProviderId,
        model_tiers: Option<ModelTierMap>,
    ) -> CoreResult<Settings> {
        self.ensure_not_shutting_down()?;
        let mut settings = self.rt.load_settings()?;
        settings.ai_provider = Some(provider);
        if let Some(tiers) = model_tiers {
            settings.model_tiers.insert(provider, tiers);
        }
        self.rt.save_settings(&settings)?;

        if self.rt.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock {
            let adapter = build_cli_provider_for_settings(provider, &settings, &self.rt.config);
            self.rt.ai_bridge.set_provider(adapter);
        }

        {
            let mut ai_guard = self.rt.ai_health.lock().expect("ai health lock");
            ai_guard.last_error = None;
            ai_guard.first_unavailable_at = None;
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(settings)
    }

    pub async fn telegram_set_token(&self, token: &str) -> CoreResult<TelegramSetupStatus> {
        self.ensure_not_shutting_down()?;
        let cleaned = token.trim();
        if cleaned.is_empty() {
            return Err(CoreError::Validation(
                "Telegram bot token cannot be empty".to_string(),
            ));
        }

        let bot_info = self.rt.telegram.get_me(cleaned).await?;
        self.rt
            .secrets
            .set_secret(TELEGRAM_BOT_TOKEN_KEY, cleaned)?;
        self.rt
            .store
            .set_setting("telegram.bot_username", &bot_info.username)?;

        let channels = self.channel_list()?;
        let tg_channels: Vec<_> = channels
            .into_iter()
            .filter(|c| c.kind == "telegram")
            .collect();
        let waiting_for_start = tg_channels.is_empty();

        let _ = self.rt.emit_health_if_changed(now_ms())?;

        Ok(TelegramSetupStatus {
            bot_username: bot_info.username.clone(),
            bot_link: format!("https://t.me/{}?start=dealsonar", bot_info.username),
            waiting_for_start,
            channels: tg_channels,
        })
    }

    pub async fn telegram_test(&self, channel_id: Option<&str>) -> CoreResult<TelegramTestResult> {
        let Some(token) = self.rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY)? else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Chưa cấu hình Telegram Bot Token".to_string(),
            });
        };

        let all_channels = self.rt.store.channel_list()?;
        let target = match channel_id {
            Some(cid) => all_channels
                .into_iter()
                .find(|c| c.id == cid && c.kind == "telegram"),
            None => all_channels.into_iter().find(|c| c.kind == "telegram"),
        };

        let Some(ch) = target else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Chưa có kênh Telegram nào gửi /start tới bot".to_string(),
            });
        };

        let Some(chat_id) = ch.config.get("chat_id").and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| v.as_i64())
        }) else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Cấu hình kênh Telegram thiếu chat_id".to_string(),
            });
        };

        let req = SendMessageRequest::html(
            chat_id,
            "✅ <b>DealSonar</b>: Tin nhắn kiểm tra kết nối Telegram thành công!",
            None,
        );
        match self
            .rt
            .telegram
            .deliver_outbox_message(&token, &req, 0, 0)
            .await
        {
            TelegramDeliveryOutcome::Sent { message_id } => {
                if ch.state != "ok" {
                    let _ = self.rt.store.channel_set_state(&ch.id, "ok");
                    let _ = self.rt.emit_health_if_changed(now_ms());
                }
                Ok(TelegramTestResult {
                    ok: true,
                    message: format!("Đã gửi thành công (message_id={message_id})"),
                })
            }
            TelegramDeliveryOutcome::AuthRevoked => {
                let _ = self.rt.store.channel_set_state(&ch.id, "error");
                let _ = self.rt.emit_health_if_changed(now_ms());
                Ok(TelegramTestResult {
                    ok: false,
                    message: "Bot bị chặn hoặc token đã bị thu hồi (401/403)".to_string(),
                })
            }
            other => Ok(TelegramTestResult {
                ok: false,
                message: format!("Gửi thử thất bại: {other:?}"),
            }),
        }
    }

    pub fn channel_list(&self) -> CoreResult<Vec<Channel>> {
        let records = self.rt.store.channel_list()?;
        let bot_username: Option<String> = self.rt.store.get_setting("telegram.bot_username")?;

        Ok(records
            .into_iter()
            .map(|r| channel_record_to_dto(&r, bot_username.as_deref()))
            .collect())
    }

    pub fn channel_remove(&self, id: &str) -> CoreResult<ChannelRemoveResult> {
        self.ensure_not_shutting_down()?;
        let existing = self.rt.store.channel_get(id)?;
        let removed = self.rt.store.channel_delete(id)?;
        if removed {
            self.rt.remove_channel_from_outbox_tracker(id)?;
        }
        if let Some(ch) = existing {
            if ch.kind == "webhook" {
                let _ = self.rt.secrets.delete_secret(&webhook_channel_key(&ch.id));
            }
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(ChannelRemoveResult { removed })
    }

    pub fn webhook_add(&self, name: &str, url: &str, secret: Option<&str>) -> CoreResult<Channel> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        if !license.limits.allow_webhooks {
            return Err(CoreError::LicenseLimitExceeded(
                "Webhook channels require the Pro (Chuyên nghiệp) plan".to_string(),
            ));
        }
        if name.trim().is_empty() {
            return Err(CoreError::Validation(
                "Webhook channel name cannot be empty".to_string(),
            ));
        }

        let validated_url = validate_webhook_url(url)?;
        let effective_secret = match secret.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => generate_webhook_secret(),
        };

        let cfg = json!({
            "url": validated_url.as_str(),
            "include_post_text": false,
        });
        let created = self
            .rt
            .store
            .channel_create("webhook", name.trim(), &cfg, now)?;
        self.rt
            .secrets
            .set_secret(&webhook_channel_key(&created.id), &effective_secret)?;

        let bot_username: Option<String> = self.rt.store.get_setting("telegram.bot_username")?;
        Ok(channel_record_to_dto(&created, bot_username.as_deref()))
    }

    pub fn chrome_connect(
        &self,
        opts: Option<ChromeConnectOptions>,
    ) -> CoreResult<ChromeConnectResult> {
        self.ensure_not_shutting_down()?;
        let opts = opts.unwrap_or_default();
        let now = now_ms();

        if opts.resume_crawl {
            let resumed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if hub.crawl_paused {
                    hub.crawl_paused = false;
                    hub.crawl_pause_reason = None;
                    hub.facebook_session = FacebookSessionState::Ok;
                    true
                } else {
                    false
                }
            };
            if resumed {
                self.rt
                    .ipc_hub
                    .send_to_profile(None, &Envelope::new(Body::CrawlResume {}));
            }
        }

        let target_manifest_path = match &self.rt.config.chrome_manifest_path {
            Some(p) => p.clone(),
            None => chrome_manifest_path().map_err(|e| CoreError::Internal(e.to_string()))?,
        };

        let explicit_ext_id = opts
            .extension_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let stored_or_existing_ext_id = if explicit_ext_id.is_none() {
            self.rt
                .store
                .get_setting::<String>(CHROME_EXTENSION_ID_SETTING_KEY)?
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    fs::read_to_string(&target_manifest_path)
                        .ok()
                        .and_then(|raw| serde_json::from_str::<NativeHostManifest>(&raw).ok())
                        .and_then(|m| m.allowed_origins.into_iter().next())
                })
        } else {
            None
        };

        let ext_id = explicit_ext_id
            .or(stored_or_existing_ext_id.as_deref())
            .unwrap_or(DEFAULT_CHROME_EXTENSION_ID);

        let bin_path = self
            .rt
            .config
            .native_host_binary_path
            .clone()
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("/usr/local/bin/dealsonar-native-host"));

        let manifest = NativeHostManifest::new(ext_id, &bin_path)
            .map_err(|e| CoreError::Validation(e.to_string()))?;
        let native_host_installed = verify_or_write_manifest(&target_manifest_path, &manifest)
            .map(|_| true)
            .unwrap_or(false);

        if let Some(origin) = manifest.allowed_origins.first() {
            let clean_id = origin
                .strip_prefix("chrome-extension://")
                .unwrap_or(origin)
                .strip_suffix('/')
                .unwrap_or(origin);
            let _ = self
                .rt
                .store
                .set_setting(CHROME_EXTENSION_ID_SETTING_KEY, &clean_id.to_string());
        }

        let health = self.rt.emit_health_if_changed(now)?;
        let message = if health.extension_connected {
            "Đã kết nối thành công với DealSonar Chrome Extension".to_string()
        } else {
            "Đã cài đặt cấu hình Native Messaging cho Chrome; vui lòng mở tiện ích DealSonar trên trình duyệt".to_string()
        };

        Ok(ChromeConnectResult {
            native_host_installed,
            manifest_path: target_manifest_path.to_string_lossy().into_owned(),
            extension_connected: health.extension_connected,
            facebook_session: health.facebook_session,
            message,
        })
    }

    /// Startup check (`03-desktop.md §2`): if Chrome was previously paired (saved `chrome.extension_id`
    /// or existing `com.dealsonar.host.json`) and the manifest is missing or points to a stale
    /// `dealsonar-native-host` binary path after an app update/move, rewrite it automatically.
    ///
    /// Returns `Ok(true)` if the manifest file was created or updated, or `Ok(false)` if unchanged
    /// or if Chrome has never been paired yet.
    pub fn refresh_native_host_manifest_if_paired(&self) -> CoreResult<bool> {
        let target_manifest_path = match &self.rt.config.chrome_manifest_path {
            Some(p) => p.clone(),
            None => match chrome_manifest_path() {
                Ok(p) => p,
                Err(_) => return Ok(false),
            },
        };

        let existing_manifest = fs::read_to_string(&target_manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<NativeHostManifest>(&raw).ok());

        let saved_ext_id = self
            .rt
            .store
            .get_setting::<String>(CHROME_EXTENSION_ID_SETTING_KEY)?
            .filter(|s| !s.trim().is_empty());

        let ext_id_or_origin = match saved_ext_id {
            Some(id) => id,
            None => match existing_manifest
                .as_ref()
                .and_then(|m| m.allowed_origins.first().cloned())
            {
                Some(origin) => origin,
                None => return Ok(false),
            },
        };

        let Some(bin_path) = self
            .rt
            .config
            .native_host_binary_path
            .clone()
            .or_else(|| std::env::current_exe().ok())
        else {
            return Ok(false);
        };

        let expected = NativeHostManifest::new(&ext_id_or_origin, &bin_path)
            .map_err(|e| CoreError::Validation(e.to_string()))?;
        let updated = verify_or_write_manifest(&target_manifest_path, &expected)
            .map_err(|e| CoreError::Internal(e.to_string()))?;
        Ok(updated)
    }

    /// Manually pause or resume extension crawling (`03-desktop.md §2` System Tray).
    /// Resuming is refused if `facebook_session` is not `Ok` (`02-extension.md §7`).
    pub fn set_crawl_paused(&self, paused: bool) -> CoreResult<HealthStatus> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();

        if paused {
            let changed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if !hub.crawl_paused {
                    hub.crawl_paused = true;
                    hub.crawl_pause_reason = Some(crate::dto::CrawlPauseReason::Manual);
                    true
                } else {
                    false
                }
            };
            if changed {
                self.rt.ipc_hub.send_to_profile(
                    None,
                    &Envelope::new(Body::CrawlPause {
                        until: None,
                        reason: "manual".to_string(),
                    }),
                );
            }
        } else {
            let changed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if hub.facebook_session != FacebookSessionState::Ok {
                    return Err(CoreError::Validation(
                        "Không thể tiếp tục quét khi phiên Facebook đang có sự cố".to_string(),
                    ));
                }
                if hub.crawl_paused {
                    hub.crawl_paused = false;
                    hub.crawl_pause_reason = None;
                    true
                } else {
                    false
                }
            };
            if changed {
                self.rt
                    .ipc_hub
                    .send_to_profile(None, &Envelope::new(Body::CrawlResume {}));
            }
        }

        self.rt.emit_health_if_changed(now)
    }

    /// Toggle manual crawl pause/resume (`03-desktop.md §2` System Tray).
    pub fn toggle_crawl_paused(&self) -> CoreResult<HealthStatus> {
        let currently_paused = self
            .rt
            .ipc_hub
            .state
            .lock()
            .expect("ipc state lock")
            .crawl_paused;
        self.set_crawl_paused(!currently_paused)
    }

    pub fn license_get(&self) -> CoreResult<LicenseStatus> {
        self.rt.current_license_status(now_ms())
    }

    pub fn license_set(&self, license_key: &str) -> CoreResult<LicenseStatus> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let trimmed = license_key.trim();

        if trimmed.is_empty() {
            // Clear license -> revert to Personal plan and auto-pause excess active radars (`03-desktop.md §5`)
            self.rt.store.delete_setting(LICENSE_TOKEN_SETTING_KEY)?;
            let status = self.rt.current_license_status(now)?;
            let paused = enforce_plan_limits_on_store(&self.rt.store, &status.limits, now)?;
            if !paused.is_empty() {
                let _ = self.rt.bump_and_push_config()?;
            }
            return Ok(status);
        }

        // Verify cryptographic Ed25519 signature before storing
        let payload = self.rt.license_verifier.verify_token(trimmed)?;
        self.rt
            .store
            .set_setting(LICENSE_TOKEN_SETTING_KEY, &trimmed.to_string())?;

        let status = self.rt.current_license_status(now)?;
        let paused = enforce_plan_limits_on_store(&self.rt.store, &status.limits, now)?;
        if !paused.is_empty() || payload.expires_at.is_some_and(|exp| exp <= now) {
            let _ = self.rt.bump_and_push_config()?;
        }

        Ok(status)
    }

    // ========================================================================
    // 9. Health, Diagnostics & Data Lifecycle
    // ========================================================================

    pub fn health_get(&self) -> CoreResult<HealthStatus> {
        self.rt.compute_health_status(now_ms())
    }

    pub fn crawl_run_list(
        &self,
        source_id: Option<&str>,
        limit: usize,
    ) -> CoreResult<Vec<CrawlRun>> {
        let runs = self.rt.store.crawl_run_list(source_id, limit)?;
        Ok(runs.iter().map(|r| self.rt.crawl_run_to_dto(r)).collect())
    }

    pub fn ai_usage_get(&self, days: u32) -> CoreResult<AiUsageStats> {
        let now = now_ms();
        let settings = self.rt.load_settings()?;
        let today_items = self.rt.store.count_ai_items_today(now)?;
        let report = self.rt.store.ai_usage_get(days.max(1), now)?;

        let daily = report
            .days
            .into_iter()
            .map(|d| AiDailyUsageRow {
                date: d.date,
                calls: d.calls,
                items: d.items,
                input_tokens: d.input_tokens,
                output_tokens: d.output_tokens,
                cost_usd: (d.cost_usd > 0.0).then_some(d.cost_usd),
                ai_escalation_pct: d.ai_escalation_rate * 100.0,
            })
            .collect();

        Ok(AiUsageStats {
            today_items,
            daily_cap: settings.daily_ai_post_cap,
            total_calls: report.total_calls,
            total_items: report.total_items,
            total_input_tokens: report.total_input_tokens,
            total_output_tokens: report.total_output_tokens,
            total_cost_usd: report.total_cost_usd,
            avg_ai_escalation_pct: report.overall_ai_escalation_rate * 100.0,
            daily,
        })
    }

    pub fn diagnostic_bundle_create(&self) -> CoreResult<DiagnosticBundleResult> {
        let now = now_ms();
        let settings = self.rt.load_settings()?;
        let health = self.rt.compute_health_status(now)?;
        let diag_dir = self.rt.config.data_dir.join("diagnostics");
        fs::create_dir_all(&diag_dir)?;
        let dest_path = diag_dir.join(format!("dealsonar-diagnostics-{now}.zip"));

        // Gather active secrets in memory ONLY to scrub any accidental appearance in `.log` files
        let mut extra_secrets = Vec::new();
        if let Ok(Some(bot_tok)) = self.rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY) {
            extra_secrets.push(bot_tok);
        }
        if let Ok(Some(lic_tok)) = self
            .rt
            .store
            .get_setting::<String>(LICENSE_TOKEN_SETTING_KEY)
        {
            extra_secrets.push(lic_tok);
        }
        if let Ok(channels) = self.rt.store.channel_list() {
            for ch in channels {
                if ch.kind == "webhook" {
                    if let Ok(Some(sec)) = self.rt.secrets.get_secret(&webhook_channel_key(&ch.id))
                    {
                        extra_secrets.push(sec);
                    }
                }
            }
        }

        create_diagnostic_bundle(
            &self.rt.store,
            &health,
            &settings,
            self.rt.config.logs_dir.as_deref(),
            &dest_path,
            &extra_secrets,
            now,
        )
    }

    pub fn data_backup(&self) -> CoreResult<DataBackupResult> {
        let now = now_ms();
        let backup_dir = self.rt.config.data_dir.join("backups");
        fs::create_dir_all(&backup_dir)?;
        let dest = backup_dir.join(format!("dealsonar-backup-{now}.sqlite3"));
        self.rt.store.backup_database(&dest)?;
        Ok(DataBackupResult {
            path: dest.to_string_lossy().into_owned(),
            created_at: now,
        })
    }

    pub fn data_purge(&self, unmatched_retention_days: Option<u32>) -> CoreResult<DataPurgeResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let days = match unmatched_retention_days {
            Some(d) => d,
            None => self.rt.load_settings()?.unmatched_retention_days,
        };
        let report = self.rt.store.purge_expired(now, days)?;
        let prev_cleaned = self
            .rt
            .store
            .cleanup_preview_evaluations(None, Some(now.saturating_sub(86_400_000)))?;
        Ok(DataPurgeResult {
            posts_purged: report.posts_purged,
            evaluations_cleaned: report.evaluations_scrubbed + prev_cleaned,
        })
    }

    pub fn data_delete_all(&self, confirm_phrase: &str) -> CoreResult<DataDeleteAllResult> {
        self.ensure_not_shutting_down()?;
        let normalized = dealsonar_store::models::fold_vi(confirm_phrase);
        if !matches!(normalized.trim(), "xoa toan bo" | "xoa tat ca") {
            return Err(CoreError::Validation(
                "Cụm xác nhận không khớp; vui lòng nhập đúng 'XOA TOAN BO'".to_string(),
            ));
        }

        // Collect webhook secret keys before wiping DB
        let existing_channels = self.rt.store.channel_list().unwrap_or_default();
        self.rt.store.delete_all_data()?;

        let _ = self.rt.secrets.delete_secret(TELEGRAM_BOT_TOKEN_KEY);
        for ch in existing_channels {
            if ch.kind == "webhook" {
                let _ = self.rt.secrets.delete_secret(&webhook_channel_key(&ch.id));
            }
        }

        self.rt.clear_outbox_tracker_in_memory();
        self.rt.previews.lock().expect("previews lock").clear();
        self.rt
            .latest_preview_by_radar
            .lock()
            .expect("latest preview lock")
            .clear();

        let _ = self.rt.bump_and_push_config()?;
        let _ = self.rt.emit_health_if_changed(now_ms())?;

        Ok(DataDeleteAllResult { deleted: true })
    }
}

// ============================================================================
// Internal DTO Helpers
// ============================================================================

fn generate_webhook_secret() -> String {
    use rand::RngCore;
    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let mut hex = String::with_capacity(6 + raw.len() * 2);
    hex.push_str("whsec_");
    for b in raw {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

fn build_cli_provider_for_settings(
    provider: AiProviderId,
    settings: &Settings,
    config: &CoreConfig,
) -> Arc<dyn AiProvider> {
    let mut bridge_tiers = BridgeModelTierMap::recommended_defaults();
    for (pid, tier_map) in &settings.model_tiers {
        let bpid = pid.to_bridge_id();
        bridge_tiers.set(bpid, BridgeModelTier::Fast, Some(tier_map.fast.clone()));
        bridge_tiers.set(bpid, BridgeModelTier::Smart, Some(tier_map.smart.clone()));
    }

    let workdir = config.data_dir.join("ai-workdir");
    let _ = fs::create_dir_all(&workdir);

    let cli_cfg = CliAdapterConfig::new(provider.binary_name())
        .with_model_tiers(bridge_tiers)
        .with_workdir(workdir);

    match provider {
        AiProviderId::ClaudeCli => Arc::new(ClaudeCliProvider::new(cli_cfg)),
        AiProviderId::CodexCli => Arc::new(CodexCliProvider::new(cli_cfg)),
        AiProviderId::AgyCli => Arc::new(AgyCliProvider::new(cli_cfg)),
    }
}

fn post_detail_to_dto(detail: &dealsonar_store::models::PostDetail) -> Post {
    Post {
        id: detail.post.id.clone(),
        platform: detail.post.platform.clone(),
        external_id: detail.post.external_id.clone(),
        source_id: detail.post.source_id.clone(),
        source_name: detail.source_name.clone(),
        author_id: detail.post.author_id.clone(),
        author_name: detail
            .author_name
            .clone()
            .unwrap_or_else(|| "Ẩn danh".to_string()),
        permalink: detail.post.permalink.clone(),
        text: detail.post.text.clone(),
        text_truncated: detail.post.text_truncated,
        lang: detail.post.lang.clone(),
        created_at: detail.post.created_at,
        captured_at: detail.post.captured_at,
        strategy: detail.post.strategy.clone(),
        purged_at: detail.post.purged_at,
    }
}

fn contact_record_to_dto(
    c: &dealsonar_store::models::ContactRecord,
    lead_count: i64,
    blocklist: &[dealsonar_store::models::BlocklistRecord],
) -> Contact {
    let is_blocked = blocklist.iter().any(|b| match b.kind.as_str() {
        "phone" => c.phones.iter().any(|p| p == &b.value),
        "author" => c.author_ids.iter().any(|a| a == &b.value),
        _ => false,
    });

    Contact {
        id: c.id.clone(),
        display_name: c
            .display_name
            .clone()
            .unwrap_or_else(|| "Liên hệ chưa rõ tên".to_string()),
        phones: c.phones.clone(),
        author_ids: c.author_ids.clone(),
        note: c.note.clone(),
        lead_count,
        is_blocked,
        created_at: c.created_at,
        updated_at: c.updated_at,
    }
}

fn blocklist_record_to_dto(
    b: &dealsonar_store::models::BlocklistRecord,
    display_label: Option<String>,
) -> BlocklistEntry {
    BlocklistEntry {
        id: b.id.clone(),
        kind: BlocklistKind::from_db(&b.kind),
        value: b.value.clone(),
        display_label,
        radar_id: b.radar_id.clone(),
        reason: b.reason.clone(),
        created_at: b.created_at,
    }
}

fn channel_record_to_dto(
    r: &dealsonar_store::models::ChannelRecord,
    bot_username: Option<&str>,
) -> Channel {
    let chat_id = r.config.get("chat_id").and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|n| n.to_string()))
    });
    let chat_type = r
        .config
        .get("chat_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let url = r
        .config
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string);

    Channel {
        id: r.id.clone(),
        kind: r.kind.clone(),
        name: r.name.clone(),
        config: ChannelConfig {
            chat_id,
            bot_username: (r.kind == "telegram")
                .then(|| bot_username.map(str::to_string))
                .flatten(),
            chat_type,
            url,
        },
        state: r.state.clone(),
        last_error: (r.state == "error").then(|| "Channel delivery failed".to_string()),
        created_at: r.created_at,
    }
}
