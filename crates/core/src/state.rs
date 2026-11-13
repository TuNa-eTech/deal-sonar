//! Shared runtime state (`CoreRuntime`), configuration (`CoreConfig`), IPC hub registry,
//! health/incident state machine, and settings persistence helpers.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use dealsonar_ai_bridge::AiBridge;
use dealsonar_notify::{
    format_system_alert_html, SecretStore, SendMessageRequest, SystemIncidentKind, TelegramClient,
    WebhookClient, TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::ipc::IpcEndpoint;
use dealsonar_protocol::{Body, Envelope};
use dealsonar_store::models::{now_ms, EnqueueOutboxInput};
use dealsonar_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{broadcast, mpsc, watch, Notify};

use crate::dto::{
    AiHealthState, AiProviderId, CoreEvent, CrawlPauseReason, CrawlRun, FacebookSessionState,
    FloodRadarInfo, HealthStatus, PreviewRunState, Settings, TelegramHealthState,
};
use crate::error::CoreResult;
use crate::license::{LicenseVerifier, LICENSE_TOKEN_SETTING_KEY};
use crate::scheduler::{build_crawl_policy, compute_crawl_plan, default_extractor_profile};

/// Desktop OS notification payload invoked when a lead qualifies for instant notification,
/// `settings.os_notifications_enabled == true`, and no Telegram channel is configured (`07-notifications-export.md §4`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsNotification {
    pub lead_id: String,
    pub radar_name: String,
    pub summary: String,
    pub group_name: String,
    pub permalink: String,
}

/// Pluggable callback allowing `dealsonar-desktop` (Tauri) or tests to display native OS notifications.
pub type OsNotificationHook = Arc<dyn Fn(OsNotification) + Send + Sync>;

/// Runtime configuration for `CoreService` and its background workers.
#[derive(Clone)]
pub struct CoreConfig {
    /// Application data directory (`backups/`, `exports/`, `diagnostics/`, `logs/`).
    pub data_dir: PathBuf,
    /// Optional local IPC socket / named pipe endpoint to bind (`None` skips binding IPC listener).
    pub ipc_endpoint: Option<IpcEndpoint>,
    /// Optional path to `dealsonar-native-host` binary for `chrome_connect`.
    pub native_host_binary_path: Option<PathBuf>,
    /// Optional override path for Chrome's `com.dealsonar.host.json` manifest.
    pub chrome_manifest_path: Option<PathBuf>,
    /// Optional override directory for radar `.json` templates.
    pub templates_dir: Option<PathBuf>,
    /// Optional directory containing `.log` files for redacted diagnostic bundles.
    pub logs_dir: Option<PathBuf>,

    // --- Pipeline & Ruleset Lifecycle Thresholds ---
    /// Live T5 AI batch trigger count (`20` per `05-pipeline-rules.md §7`).
    pub batch_trigger_count: usize,
    /// Maximum wait time (`45_000ms` per `05-pipeline-rules.md §7`) before running a partial T5 batch.
    pub batch_max_wait_ms: i64,
    /// Preview batch size (default `3` for faster first results; independently configurable).
    pub preview_batch_size: usize,
    /// Max stored posts evaluated in `radar_preview_start` (`50` per `02-radar-spec.md §5`).
    pub preview_max_posts: usize,
    /// Minimum stored posts before triggering `crawl.request(preview)` (`20` per `02-radar-spec.md §5`).
    pub preview_min_posts_before_crawl: usize,
    /// Minimum shadow-evaluated posts required before `shadow -> active` promotion (`200`).
    pub shadow_min_posts: usize,
    /// Minimum shadow age in ms required before `shadow -> active` promotion (`3 days`).
    pub shadow_min_age_ms: i64,
    /// Minimum AI evaluations before auto-triggering `compile_ruleset` (`150`).
    pub auto_compile_min_ai_evals: i64,
    /// Minimum matched AI evaluations before auto-triggering `compile_ruleset` (`20`).
    pub auto_compile_min_matches: i64,
    /// Deterministic daily audit sampling percentage on active rulesets (`5` = 5%).
    pub audit_sample_percent: u8,
    /// Disagreement rate threshold (`0.08` = 8%) above which `active` ruleset demotes to `shadow`.
    pub audit_disagreement_demote_threshold: f64,
    /// Minimum audit sample size before demoting on disagreement rate (`10`).
    pub audit_min_samples: usize,

    // --- Worker & Health Monitor Cadences ---
    /// Grace window (`30m` per `07-notifications-export.md §3`) before alerting on disconnected extension or AI.
    pub disconnect_alert_grace_ms: i64,
    /// Poll interval for the durable `jobs` loop.
    pub job_poll_interval: Duration,
    /// Poll interval for the `outbox` delivery loop.
    pub outbox_poll_interval: Duration,
    /// Long-poll `timeout` seconds passed to Telegram `getUpdates`.
    pub telegram_poll_timeout_s: u32,
    /// Sleep duration when no Telegram token is configured or between poll cycles.
    pub telegram_poll_idle_sleep: Duration,
    /// Health monitor check cadence (`60s` per `03-desktop.md §3`).
    pub health_check_interval: Duration,
    /// Crawl scheduler recomputation cadence (`300s` per `02-extension.md §6.2`).
    pub scheduler_interval: Duration,
    /// Whether to spawn background Tokio worker loops (`true` by default).
    pub spawn_background_workers: bool,
}

impl std::fmt::Debug for CoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreConfig")
            .field("data_dir", &self.data_dir)
            .field("ipc_endpoint", &self.ipc_endpoint)
            .field("batch_trigger_count", &self.batch_trigger_count)
            .field("batch_max_wait_ms", &self.batch_max_wait_ms)
            .field("spawn_background_workers", &self.spawn_background_workers)
            .finish()
    }
}

impl Default for CoreConfig {
    fn default() -> Self {
        let data_dir = dealsonar_protocol::ipc::default_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("dealsonar"));
        let logs_dir = Some(data_dir.join("logs"));
        Self {
            data_dir,
            ipc_endpoint: None,
            native_host_binary_path: None,
            chrome_manifest_path: None,
            templates_dir: None,
            logs_dir,
            batch_trigger_count: 20,
            batch_max_wait_ms: 45_000,
            preview_batch_size: 3,
            preview_max_posts: 50,
            preview_min_posts_before_crawl: 20,
            shadow_min_posts: 200,
            shadow_min_age_ms: 3 * 86_400_000,
            auto_compile_min_ai_evals: 150,
            auto_compile_min_matches: 20,
            audit_sample_percent: 5,
            audit_disagreement_demote_threshold: 0.08,
            audit_min_samples: 10,
            disconnect_alert_grace_ms: 30 * 60_000,
            job_poll_interval: Duration::from_millis(250),
            outbox_poll_interval: Duration::from_millis(250),
            telegram_poll_timeout_s: 25,
            telegram_poll_idle_sleep: Duration::from_millis(500),
            health_check_interval: Duration::from_secs(60),
            scheduler_interval: Duration::from_secs(300),
            spawn_background_workers: true,
        }
    }
}

/// Bounded LRU/FIFO cache of processed `posts.push` / `crawl.report` / `sources.discovered` message IDs.
pub struct MessageDedupCache {
    capacity: usize,
    order: VecDeque<String>,
    entries: HashMap<String, (u32, u32)>,
}

impl MessageDedupCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(64),
            order: VecDeque::new(),
            entries: HashMap::new(),
        }
    }

    pub fn get(&self, msg_id: &str) -> Option<(u32, u32)> {
        self.entries.get(msg_id).copied()
    }

    pub fn insert(&mut self, msg_id: String, ack: (u32, u32)) {
        if let std::collections::hash_map::Entry::Occupied(mut existing) =
            self.entries.entry(msg_id.clone())
        {
            existing.insert(ack);
            return;
        }
        while self.entries.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
        self.order.push_back(msg_id.clone());
        self.entries.insert(msg_id, ack);
    }
}

/// Active IPC client connection entry inside [`IpcHub`].
#[derive(Clone)]
pub struct ConnectedProfile {
    pub conn_id: u64,
    pub profile_id: String,
    pub ext_version: String,
    pub browser: String,
    pub connected_at: i64,
    pub crawl_runtime: Option<(i64, dealsonar_protocol::CrawlRuntimeStatus)>,
    pub tx: mpsc::UnboundedSender<Envelope>,
}

/// Mutable state inside [`IpcHub`].
pub struct IpcHubState {
    pub connections: HashMap<u64, ConnectedProfile>,
    pub last_disconnected_at: Option<i64>,
    pub facebook_session: FacebookSessionState,
    pub crawl_paused: bool,
    pub crawl_pause_reason: Option<CrawlPauseReason>,
    pub config_rev: u64,
    /// Distinct `source_id`s from consecutive `empty` crawl runs (`>= 3` triggers `ExtractorBroken`).
    pub consecutive_empty_sources: Vec<String>,
    pub extractor_broken: bool,
}

impl Default for IpcHubState {
    fn default() -> Self {
        Self {
            connections: HashMap::new(),
            last_disconnected_at: None,
            facebook_session: FacebookSessionState::Ok,
            crawl_paused: false,
            crawl_pause_reason: None,
            config_rev: 1,
            consecutive_empty_sources: Vec::new(),
            extractor_broken: false,
        }
    }
}

/// Multi-profile IPC connection & session state registry.
pub struct IpcHub {
    next_conn_id: AtomicU64,
    pub state: Mutex<IpcHubState>,
    pub dedup: Mutex<MessageDedupCache>,
}

impl Default for IpcHub {
    fn default() -> Self {
        Self {
            next_conn_id: AtomicU64::new(1),
            state: Mutex::new(IpcHubState::default()),
            dedup: Mutex::new(MessageDedupCache::new(4_096)),
        }
    }
}

impl IpcHub {
    pub fn alloc_conn_id(&self) -> u64 {
        self.next_conn_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn is_any_connected(&self) -> bool {
        !self
            .state
            .lock()
            .expect("ipc state lock")
            .connections
            .is_empty()
    }

    /// Push an envelope to a specific Chrome `profile_id` (if `Some`), or broadcast to all connected profiles.
    /// Returns the number of active streams that accepted the message.
    pub fn send_to_profile(&self, profile_id: Option<&str>, envelope: &Envelope) -> usize {
        let guard = self.state.lock().expect("ipc state lock");
        let mut sent = 0usize;
        for conn in guard.connections.values() {
            if profile_id.is_none_or(|want| conn.profile_id == want)
                && conn.tx.send(envelope.clone()).is_ok()
            {
                sent += 1;
            }
        }
        sent
    }
}

/// Tracked AI health state for `HealthStatus` and 30m unavailability alerts.
#[derive(Debug, Clone, Default)]
pub struct AiRuntimeHealth {
    pub last_error: Option<String>,
    pub rate_limit_reset_at: Option<i64>,
    pub first_unavailable_at: Option<i64>,
    pub daily_cap_reached_date: Option<String>,
}

/// Deduplicated system incident alert tracker (`07-notifications-export.md §3`).
#[derive(Debug, Clone, Default)]
pub struct IncidentTracker {
    pub fb_session_alerted: bool,
    pub ext_disconnected_alerted: bool,
    pub ai_unavailable_alerted: bool,
    pub extractor_broken_alerted: bool,
    pub flood_alerted_radars: HashSet<String>,
}

/// RAII guard tracking in-flight AI calls so `shutdown()` can wait up to 10s cleanly.
pub struct InflightAiGuard {
    rt: Arc<CoreRuntime>,
}

impl InflightAiGuard {
    pub fn acquire(rt: &Arc<CoreRuntime>) -> Self {
        rt.inflight_ai_calls.fetch_add(1, Ordering::SeqCst);
        Self { rt: Arc::clone(rt) }
    }
}

impl Drop for InflightAiGuard {
    fn drop(&mut self) {
        let prev = self.rt.inflight_ai_calls.fetch_sub(1, Ordering::SeqCst);
        if prev <= 1 {
            self.rt.inflight_ai_notify.notify_waiters();
        }
    }
}

pub const OUTBOX_TRACKER_SETTING_KEY: &str = "runtime.outbox_tracker";

/// Persisted state of a pending or failed outbox entry so `HealthStatus.outbox_pending` and
/// `HealthStatus.outbox_failed` stay accurate across app restarts and `channel_remove`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxTrackerEntry {
    pub channel_id: String,
    pub state: String,
}

/// Shared runtime state held by `CoreService`, `IpcServer`, pipeline, preview, and background workers.
pub struct CoreRuntime {
    pub config: CoreConfig,
    pub store: Store,
    pub ai_bridge: Arc<AiBridge>,
    pub secrets: Arc<dyn SecretStore>,
    pub telegram: TelegramClient,
    pub webhook: WebhookClient,
    pub license_verifier: LicenseVerifier,
    pub ipc_hub: Arc<IpcHub>,
    pub ai_health: Mutex<AiRuntimeHealth>,
    pub incidents: Mutex<IncidentTracker>,
    pub previews: Mutex<HashMap<String, PreviewRunState>>,
    pub preview_cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
    pub latest_preview_by_radar: Mutex<HashMap<String, String>>,
    pub last_emitted_health: Mutex<Option<HealthStatus>>,
    pub outbox_tracker: Mutex<BTreeMap<String, OutboxTrackerEntry>>,
    pub os_notify_hook: RwLock<Option<OsNotificationHook>>,
    pub event_tx: broadcast::Sender<CoreEvent>,
    pub job_wake: Arc<Notify>,
    pub outbox_wake: Arc<Notify>,
    pub outbox_pending: AtomicUsize,
    pub outbox_failed: AtomicUsize,
    pub shutting_down: AtomicBool,
    pub shutdown_tx: watch::Sender<bool>,
    pub inflight_ai_calls: AtomicUsize,
    pub inflight_ai_notify: Arc<Notify>,
    pub started_at_ms: i64,
}

impl CoreRuntime {
    /// Emit a real-time push event to all active subscribers.
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Load typed [`Settings`] from the SQLite `settings` table, filling defaults for unset keys.
    pub fn load_settings(&self) -> CoreResult<Settings> {
        if let Some(saved) = self.store.get_setting::<Settings>("app.settings")? {
            return Ok(saved);
        }
        Ok(Settings::default())
    }

    /// Persist [`Settings`] into the SQLite `settings` table.
    pub fn save_settings(&self, settings: &Settings) -> CoreResult<()> {
        self.store.set_setting("app.settings", settings)?;
        Ok(())
    }

    /// Evaluate current [`LicenseStatus`] against the embedded/configured Ed25519 public key.
    pub fn current_license_status(&self, now: i64) -> CoreResult<crate::dto::LicenseStatus> {
        let token = self
            .store
            .get_setting::<String>(LICENSE_TOKEN_SETTING_KEY)?;
        Ok(self.license_verifier.evaluate_status(token.as_deref(), now))
    }

    /// Recompute `CrawlPlan` + `CrawlPolicy` + `ExtractorProfile`, bump `config_rev`, and push
    /// `config.update` to connected Chrome profiles (`01-protocol.md §4.2`).
    pub fn bump_and_push_config(&self) -> CoreResult<u64> {
        let settings = self.load_settings()?;
        let active_sources = self.store.list_sources_for_active_radars()?;

        let (rev, profiles): (u64, Vec<(String, mpsc::UnboundedSender<Envelope>)>) = {
            let mut guard = self.ipc_hub.state.lock().expect("ipc state lock");
            guard.config_rev = guard.config_rev.saturating_add(1);
            let rev = guard.config_rev;
            let conns = guard
                .connections
                .values()
                .map(|c| (c.profile_id.clone(), c.tx.clone()))
                .collect();
            (rev, conns)
        };

        let policy = build_crawl_policy(&settings.crawl_policy);
        let extractor = default_extractor_profile(1);

        for (profile_id, tx) in profiles {
            let plan =
                compute_crawl_plan(&active_sources, &settings.crawl_policy, Some(&profile_id));
            let env = Envelope::new(Body::ConfigUpdate {
                rev,
                plan,
                policy: policy.clone(),
                extractor: extractor.clone(),
            });
            let _ = tx.send(env);
        }

        Ok(rev)
    }

    /// Build a `ConfigUpdate` envelope tailored for a single `profile_id` at the current `config_rev`.
    pub fn build_config_update_for_profile(&self, profile_id: &str) -> CoreResult<(u64, Envelope)> {
        let settings = self.load_settings()?;
        let active_sources = self.store.list_sources_for_active_radars()?;
        let rev = self
            .ipc_hub
            .state
            .lock()
            .expect("ipc state lock")
            .config_rev;
        let plan = compute_crawl_plan(&active_sources, &settings.crawl_policy, Some(profile_id));
        let policy = build_crawl_policy(&settings.crawl_policy);
        let extractor = default_extractor_profile(1);
        let env = Envelope::new(Body::ConfigUpdate {
            rev,
            plan,
            policy,
            extractor,
        });
        Ok((rev, env))
    }

    /// Compute the full 4-lamp [`HealthStatus`] snapshot (`03-desktop.md §4`, `ipc.ts`).
    pub fn compute_health_status(&self, now: i64) -> CoreResult<HealthStatus> {
        let settings = self.load_settings()?;

        let (ext_connected, ext_version, fb_session, crawl_paused, crawl_pause_reason) = {
            let guard = self.ipc_hub.state.lock().expect("ipc state lock");
            let ext_connected = !guard.connections.is_empty();
            let ext_version = guard
                .connections
                .values()
                .max_by_key(|c| c.connected_at)
                .map(|c| c.ext_version.clone());
            (
                ext_connected,
                ext_version,
                guard.facebook_session,
                guard.crawl_paused,
                guard.crawl_pause_reason,
            )
        };

        let (automatic_scanning, extension_paused, next_crawl_at, runtime_checked_at) = {
            let guard = self.ipc_hub.state.lock().expect("ipc state lock");
            let reports: Vec<_> = guard
                .connections
                .values()
                .filter_map(|c| c.crawl_runtime.as_ref())
                .filter(|(at, _)| now.saturating_sub(*at) < 90_000)
                .collect();
            let complete =
                !guard.connections.is_empty() && reports.len() == guard.connections.len();
            (
                if complete {
                    Some(reports.iter().any(|(_, s)| s.automatic_scanning))
                } else {
                    None
                },
                reports.iter().any(|(_, s)| s.paused),
                reports.iter().filter_map(|(_, s)| s.next_crawl_at).min(),
                reports.iter().map(|(at, _)| *at).min(),
            )
        };
        let crawl_paused = crawl_paused || extension_paused;

        // Page loads in last hour and today from `crawl_runs`
        let runs = self.store.crawl_run_list(None, 500)?;
        let one_hour_ago = now.saturating_sub(3_600_000);
        let day_start = start_of_local_day_ms(now);
        let mut page_loads_last_hour = 0i64;
        let mut page_loads_today = 0i64;
        for r in &runs {
            if r.started_at >= one_hour_ago {
                page_loads_last_hour += r.page_loads;
            }
            if r.started_at >= day_start {
                page_loads_today += r.page_loads;
            }
        }

        // Pending AI count
        let pending_groups = self.store.list_pending_ai_batches()?;
        let pending_ai_posts: usize = pending_groups
            .iter()
            .filter(|g| !g.is_preview)
            .map(|g| g.count)
            .sum();

        let today_ai_items = self.store.count_ai_items_today(now)?;
        let (ai_state, ai_error, ai_rate_limit_reset_at) = {
            let mut ai_guard = self.ai_health.lock().expect("ai health lock");
            if let Some(reset_at) = ai_guard.rate_limit_reset_at {
                if reset_at <= now {
                    ai_guard.rate_limit_reset_at = None;
                }
            }

            let state = if settings.ai_provider.is_none()
                && self.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock
            {
                AiHealthState::NotConfigured
            } else if ai_guard.rate_limit_reset_at.is_some() {
                AiHealthState::RateLimited
            } else if today_ai_items >= i64::from(settings.daily_ai_post_cap) {
                AiHealthState::DailyCapReached
            } else if ai_guard.last_error.is_some() {
                AiHealthState::Error
            } else {
                AiHealthState::Ok
            };
            (
                state,
                ai_guard.last_error.clone(),
                ai_guard.rate_limit_reset_at,
            )
        };

        let ai_provider = settings.ai_provider.or_else(|| {
            if self.ai_bridge.provider_id() == dealsonar_ai_bridge::ProviderId::Mock {
                Some(AiProviderId::ClaudeCli)
            } else {
                None
            }
        });

        // Telegram & Outbox health
        let channels = self.store.channel_list()?;
        let tg_channels: Vec<_> = channels.iter().filter(|c| c.kind == "telegram").collect();
        let telegram_channel_count = tg_channels.len();
        let has_bot_token = self
            .secrets
            .get_secret(TELEGRAM_BOT_TOKEN_KEY)
            .ok()
            .flatten()
            .is_some();

        let telegram_state = if !has_bot_token && telegram_channel_count == 0 {
            TelegramHealthState::NotConfigured
        } else if tg_channels.iter().any(|c| c.state == "error") {
            TelegramHealthState::Error
        } else if telegram_channel_count > 0 {
            TelegramHealthState::Ok
        } else {
            TelegramHealthState::NotConfigured
        };

        let (outbox_pending, outbox_failed) = self.count_outbox_states()?;

        // Flood radars (>30 leads in last hour)
        let active_radars = self.store.radar_list(false, now)?;
        let mut flood_radars = Vec::new();
        for item in active_radars {
            if item.radar.status == "active" {
                let last_hr = self.store.count_leads_in_last_hour(&item.radar.id, now)? as usize;
                if last_hr > dealsonar_notify::FLOOD_LEADS_PER_HOUR_THRESHOLD {
                    flood_radars.push(FloodRadarInfo {
                        radar_id: item.radar.id,
                        radar_name: item.radar.name,
                        leads_last_hour: last_hr,
                    });
                }
            }
        }

        Ok(HealthStatus {
            automatic_scanning,
            next_crawl_at,
            runtime_checked_at,
            last_crawl_at: runs
                .iter()
                .filter(|r| r.status == "ok" || r.status == "empty")
                .filter_map(|r| r.ended_at)
                .max(),
            extension_connected: ext_connected,
            extension_version: ext_version,
            facebook_session: fb_session,
            crawl_paused,
            crawl_pause_reason,
            page_loads_last_hour,
            page_loads_today,
            ai_state,
            ai_provider,
            ai_error,
            ai_rate_limit_reset_at,
            pending_ai_posts,
            telegram_state,
            telegram_channel_count,
            outbox_pending,
            outbox_failed,
            flood_radars,
            checked_at: now,
        })
    }

    fn sync_outbox_atomics_from_map(&self, map: &BTreeMap<String, OutboxTrackerEntry>) {
        let mut pending = 0usize;
        let mut failed = 0usize;
        for entry in map.values() {
            match entry.state.as_str() {
                "pending" => pending += 1,
                "failed" => failed += 1,
                _ => {}
            }
        }
        self.outbox_pending.store(pending, Ordering::Relaxed);
        self.outbox_failed.store(failed, Ordering::Relaxed);
    }

    /// Restore persisted `runtime.outbox_tracker` on startup, pruning orphaned channels or terminal states.
    pub fn restore_outbox_tracker(&self) -> CoreResult<()> {
        let existing_channel_ids: HashSet<String> = self
            .store
            .channel_list()?
            .into_iter()
            .map(|c| c.id)
            .collect();

        let mut loaded: BTreeMap<String, OutboxTrackerEntry> = self
            .store
            .get_setting(OUTBOX_TRACKER_SETTING_KEY)?
            .unwrap_or_default();
        let before_len = loaded.len();
        loaded.retain(|_, entry| {
            existing_channel_ids.contains(&entry.channel_id)
                && matches!(entry.state.as_str(), "pending" | "failed")
        });
        if loaded.len() != before_len {
            if loaded.is_empty() {
                self.store.delete_setting(OUTBOX_TRACKER_SETTING_KEY)?;
            } else {
                self.store
                    .set_setting(OUTBOX_TRACKER_SETTING_KEY, &loaded)?;
            }
        }
        self.sync_outbox_atomics_from_map(&loaded);
        *self.outbox_tracker.lock().expect("outbox tracker lock") = loaded;
        Ok(())
    }

    fn count_outbox_states(&self) -> CoreResult<(usize, usize)> {
        Ok((
            self.outbox_pending.load(Ordering::Relaxed),
            self.outbox_failed.load(Ordering::Relaxed),
        ))
    }

    /// Enqueue an outbox row and persist its `pending` state in `runtime.outbox_tracker`.
    pub fn enqueue_outbox_tracked(
        &self,
        input: &EnqueueOutboxInput,
    ) -> CoreResult<dealsonar_store::models::OutboxRecord> {
        let rec = self.store.enqueue_outbox(input)?;
        let snapshot = {
            let mut guard = self.outbox_tracker.lock().expect("outbox tracker lock");
            guard.insert(
                rec.id.clone(),
                OutboxTrackerEntry {
                    channel_id: rec.channel_id.clone(),
                    state: "pending".to_string(),
                },
            );
            self.sync_outbox_atomics_from_map(&guard);
            guard.clone()
        };
        self.store
            .set_setting(OUTBOX_TRACKER_SETTING_KEY, &snapshot)?;
        Ok(rec)
    }

    /// Update or remove a tracked outbox item's state (`pending`, `failed`, `sent`, `dropped`).
    pub fn update_outbox_tracked_state(
        &self,
        outbox_id: &str,
        channel_id: &str,
        new_state: &str,
    ) -> CoreResult<()> {
        let snapshot = {
            let mut guard = self.outbox_tracker.lock().expect("outbox tracker lock");
            match new_state {
                "pending" | "failed" => {
                    guard.insert(
                        outbox_id.to_string(),
                        OutboxTrackerEntry {
                            channel_id: channel_id.to_string(),
                            state: new_state.to_string(),
                        },
                    );
                }
                _ => {
                    guard.remove(outbox_id);
                }
            }
            self.sync_outbox_atomics_from_map(&guard);
            guard.clone()
        };
        if snapshot.is_empty() {
            self.store.delete_setting(OUTBOX_TRACKER_SETTING_KEY)?;
        } else {
            self.store
                .set_setting(OUTBOX_TRACKER_SETTING_KEY, &snapshot)?;
        }
        Ok(())
    }

    /// Remove all tracked pending/failed outbox entries belonging to a deleted channel.
    pub fn remove_channel_from_outbox_tracker(&self, channel_id: &str) -> CoreResult<()> {
        let snapshot = {
            let mut guard = self.outbox_tracker.lock().expect("outbox tracker lock");
            guard.retain(|_, entry| entry.channel_id != channel_id);
            self.sync_outbox_atomics_from_map(&guard);
            guard.clone()
        };
        if snapshot.is_empty() {
            self.store.delete_setting(OUTBOX_TRACKER_SETTING_KEY)?;
        } else {
            self.store
                .set_setting(OUTBOX_TRACKER_SETTING_KEY, &snapshot)?;
        }
        Ok(())
    }

    /// Clear in-memory outbox tracker after `store.delete_all_data()`.
    pub fn clear_outbox_tracker_in_memory(&self) {
        self.outbox_tracker
            .lock()
            .expect("outbox tracker lock")
            .clear();
        self.outbox_pending.store(0, Ordering::Relaxed);
        self.outbox_failed.store(0, Ordering::Relaxed);
    }

    /// Emit `health:changed` only when operational fields differ from the previous snapshot.
    pub fn emit_health_if_changed(&self, now: i64) -> CoreResult<HealthStatus> {
        let current = self.compute_health_status(now)?;
        let should_emit = {
            let mut prev_guard = self.last_emitted_health.lock().expect("health lock");
            let changed = match prev_guard.as_ref() {
                None => true,
                Some(prev) => {
                    let mut p = prev.clone();
                    p.checked_at = current.checked_at;
                    p != current
                }
            };
            if changed {
                *prev_guard = Some(current.clone());
            }
            changed
        };
        if should_emit {
            self.emit(CoreEvent::HealthChanged(current.clone()));
        }
        Ok(current)
    }

    /// Queue a deduplicated Telegram system incident alert (`resolved = false`) or recovery alert
    /// (`resolved = true`) across all healthy Telegram channels (`07-notifications-export.md §3`).
    pub fn queue_system_incident_alert(
        &self,
        incident: &SystemIncidentKind,
        resolved: bool,
        now: i64,
    ) -> CoreResult<usize> {
        let paused = self
            .store
            .get_setting::<bool>("telegram.notifications_paused")?
            .unwrap_or(false);
        if paused && !resolved {
            return Ok(0);
        }

        let html = format_system_alert_html(incident, resolved);
        let channels = self.store.channel_list()?;
        let mut queued = 0usize;
        for ch in channels {
            if ch.kind == "telegram" && ch.state == "ok" {
                if let Some(chat_id) = ch.config.get("chat_id").and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                        .or_else(|| v.as_i64())
                }) {
                    let req = SendMessageRequest::html(chat_id, html.clone(), None);
                    let payload = serde_json::to_value(&req)?;
                    self.enqueue_outbox_tracked(&EnqueueOutboxInput {
                        id: None,
                        channel_id: ch.id,
                        lead_id: None,
                        kind: "system".to_string(),
                        payload,
                        next_try_at: now,
                        now_ms: now,
                    })?;
                    queued += 1;
                }
            }
        }
        if queued > 0 {
            self.outbox_wake.notify_one();
        }
        Ok(queued)
    }

    /// Convert a `CrawlRunRecord` into UI [`CrawlRun`].
    pub fn crawl_run_to_dto(&self, r: &dealsonar_store::models::CrawlRunRecord) -> CrawlRun {
        CrawlRun {
            id: r.id.clone(),
            source_id: r.source_id.clone(),
            source_name: r.source_name.clone().unwrap_or_default(),
            reason: r.reason.clone(),
            status: r.status.clone(),
            started_at: r.started_at,
            ended_at: r.ended_at,
            posts_seen: r.posts_seen,
            posts_new: r.posts_new,
            page_loads: r.page_loads,
            strategy: r.strategy.clone(),
            error: r.error.clone(),
        }
    }

    /// Helper to record a system metadata map in settings when needed.
    pub fn set_source_last_error(&self, source_id: &str, error: Option<&str>) -> CoreResult<()> {
        let mut map: BTreeMap<String, String> = self
            .store
            .get_setting("runtime.source_last_errors")?
            .unwrap_or_default();
        match error.map(str::trim).filter(|s| !s.is_empty()) {
            Some(e) => {
                map.insert(source_id.to_string(), e.to_string());
            }
            None => {
                map.remove(source_id);
            }
        }
        self.store.set_setting("runtime.source_last_errors", &map)?;
        Ok(())
    }

    pub fn get_source_last_errors(&self) -> CoreResult<BTreeMap<String, String>> {
        Ok(self
            .store
            .get_setting("runtime.source_last_errors")?
            .unwrap_or_default())
    }

    /// Record whether a radar was auto-switched to digest mode due to `>30/hr` flood.
    pub fn mark_radar_flood_auto_digest(&self, radar_id: &str, active: bool) -> CoreResult<()> {
        let mut set: HashSet<String> = self
            .store
            .get_setting("runtime.flood_auto_digest_radars")?
            .unwrap_or_default();
        if active {
            set.insert(radar_id.to_string());
        } else {
            set.remove(radar_id);
        }
        self.store
            .set_setting("runtime.flood_auto_digest_radars", &set)?;
        Ok(())
    }

    pub fn get_flood_auto_digest_radars(&self) -> CoreResult<HashSet<String>> {
        Ok(self
            .store
            .get_setting("runtime.flood_auto_digest_radars")?
            .unwrap_or_default())
    }

    pub fn set_eval_feedback_label(&self, evaluation_id: &str, label: &str) -> CoreResult<()> {
        let mut map: BTreeMap<String, String> = self
            .store
            .get_setting("runtime.feedback_by_eval")?
            .unwrap_or_default();
        map.insert(evaluation_id.to_string(), label.to_string());
        self.store.set_setting("runtime.feedback_by_eval", &map)?;
        Ok(())
    }

    pub fn get_eval_feedback_labels(&self) -> CoreResult<BTreeMap<String, String>> {
        Ok(self
            .store
            .get_setting("runtime.feedback_by_eval")?
            .unwrap_or_default())
    }

    /// Wake the durable job loop immediately after enqueueing a due job.
    pub fn enqueue_and_wake_job(
        &self,
        kind: &str,
        dedup_key: Option<&str>,
        payload: &serde_json::Value,
        run_at: i64,
    ) -> CoreResult<(dealsonar_store::models::JobRecord, bool)> {
        let now = now_ms();
        let res = self
            .store
            .enqueue_job(kind, dedup_key, payload, run_at, now)?;
        if run_at <= now {
            self.job_wake.notify_one();
        }
        Ok(res)
    }

    pub fn enqueue_digest_lead(&self, radar_id: &str, lead_id: &str, now: i64) -> CoreResult<()> {
        let key = format!("runtime.digest_pending.{radar_id}");
        let mut pending: Vec<String> = self.store.get_setting(&key)?.unwrap_or_default();
        if !pending.iter().any(|id| id == lead_id) {
            pending.push(lead_id.to_string());
            self.store.set_setting(&key, &pending)?;
        }

        let settings = self.load_settings()?;
        let delay_ms = i64::from(settings.digest_interval_minutes.max(1)) * 60_000;
        let dedup = format!("flush_digest:{radar_id}");
        let _ = self.store.enqueue_job(
            "flush_digest",
            Some(&dedup),
            &json!({ "radar_id": radar_id }),
            now.saturating_add(delay_ms),
            now,
        )?;
        Ok(())
    }
}

/// Start of the local calendar day (`00:00:00`) in Unix milliseconds.
pub fn start_of_local_day_ms(ts_ms: i64) -> i64 {
    use chrono::{Local, TimeZone};
    if let Some(dt) = Local.timestamp_millis_opt(ts_ms).single() {
        if let Some(midnight) = dt.date_naive().and_hms_opt(0, 0, 0) {
            if let Some(local_mid) = Local.from_local_datetime(&midnight).earliest() {
                return local_mid.timestamp_millis();
            }
        }
    }
    ts_ms - (ts_ms.rem_euclid(86_400_000))
}
