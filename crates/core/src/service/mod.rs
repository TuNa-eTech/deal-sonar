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
    chrome_manifest_path, secondary_chromium_manifest_paths, verify_or_write_manifest,
    NativeHostManifest,
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
use sha2::{Digest, Sha256};
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
    cancel_radar_preview, get_radar_preview, handle_negative_feedback_on_rule_eval,
    run_compile_ruleset_for_version, save_user_ruleset, start_radar_preview,
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

mod builder;
mod channels;
mod chrome;
mod contacts;
mod leads;
mod posts;
mod radars;
mod rulesets;
mod settings;
mod sources;
mod system;

pub use builder::*;
use contacts::*;
use posts::*;
use settings::*;

/// Default Chrome Web Store / deterministic MV3 `manifest.json` `"key"` extension ID
/// (`SHA256(SPKI_DER)[0..16]` mapped `0..15 -> 'a'..'p'`).
pub const DEFAULT_CHROME_EXTENSION_ID: &str = "hkmjpcenjjebhpjicnbpmogidfcbmbjn";

const LEGACY_PLACEHOLDER_EXTENSION_ID: &str = "dealsonarchromeextensionid000001";

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
}
