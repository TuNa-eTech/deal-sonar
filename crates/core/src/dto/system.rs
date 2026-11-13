//! Health, crawl runs, AI usage, rulesets, settings, license, and channels.

use super::*;

// ============================================================================
// Health, Crawl Runs, AI Usage, Rulesets, Settings, License, Channels
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FacebookSessionState {
    Ok,
    LoggedOut,
    Checkpoint,
    RateLimited,
}

impl Default for FacebookSessionState {
    fn default() -> Self {
        Self::Ok
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderId {
    ClaudeCli,
    CodexCli,
    AgyCli,
}

impl AiProviderId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCli => "claude_cli",
            Self::CodexCli => "codex_cli",
            Self::AgyCli => "agy_cli",
        }
    }

    pub fn binary_name(&self) -> &'static str {
        match self {
            Self::ClaudeCli => "claude",
            Self::CodexCli => "codex",
            Self::AgyCli => "agy",
        }
    }

    pub fn install_hint(&self) -> &'static str {
        match self {
            Self::ClaudeCli => "npm install -g @anthropic-ai/claude-code",
            Self::CodexCli => "npm install -g @openai/codex",
            Self::AgyCli => "Cài đặt Google Antigravity IDE / CLI (agy)",
        }
    }

    pub fn login_command(&self) -> &'static str {
        match self {
            Self::ClaudeCli => "claude login",
            Self::CodexCli => "codex login",
            Self::AgyCli => "agy auth login",
        }
    }

    pub fn to_bridge_id(&self) -> dealsonar_ai_bridge::ProviderId {
        match self {
            Self::ClaudeCli => dealsonar_ai_bridge::ProviderId::ClaudeCli,
            Self::CodexCli => dealsonar_ai_bridge::ProviderId::CodexCli,
            Self::AgyCli => dealsonar_ai_bridge::ProviderId::AgyCli,
        }
    }

    pub fn from_bridge_id(id: dealsonar_ai_bridge::ProviderId) -> Option<Self> {
        match id {
            dealsonar_ai_bridge::ProviderId::ClaudeCli => Some(Self::ClaudeCli),
            dealsonar_ai_bridge::ProviderId::CodexCli => Some(Self::CodexCli),
            dealsonar_ai_bridge::ProviderId::AgyCli => Some(Self::AgyCli),
            dealsonar_ai_bridge::ProviderId::Mock => Some(Self::ClaudeCli),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiHealthState {
    Ok,
    NotConfigured,
    Error,
    RateLimited,
    DailyCapReached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrawlPauseReason {
    Manual,
    CheckpointAwaitingResume,
    RateLimited,
    LoggedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramHealthState {
    Ok,
    NotConfigured,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FloodRadarInfo {
    pub radar_id: String,
    pub radar_name: String,
    pub leads_last_hour: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthStatus {
    pub automatic_scanning: Option<bool>,
    pub next_crawl_at: Option<i64>,
    pub last_crawl_at: Option<i64>,
    pub runtime_checked_at: Option<i64>,
    pub extension_connected: bool,
    pub extension_version: Option<String>,
    pub facebook_session: FacebookSessionState,
    pub crawl_paused: bool,
    pub crawl_pause_reason: Option<CrawlPauseReason>,
    pub page_loads_last_hour: i64,
    pub page_loads_today: i64,
    pub ai_state: AiHealthState,
    pub ai_provider: Option<AiProviderId>,
    pub ai_error: Option<String>,
    pub ai_rate_limit_reset_at: Option<i64>,
    pub pending_ai_posts: usize,
    pub telegram_state: TelegramHealthState,
    pub telegram_channel_count: usize,
    pub outbox_pending: usize,
    pub outbox_failed: usize,
    pub flood_radars: Vec<FloodRadarInfo>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlRun {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub reason: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub posts_seen: i64,
    pub posts_new: i64,
    pub page_loads: i64,
    pub strategy: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiDailyUsageRow {
    pub date: String,
    pub calls: i64,
    pub items: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: Option<f64>,
    pub ai_escalation_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageStats {
    pub today_items: i64,
    pub daily_cap: u32,
    pub total_calls: i64,
    pub total_items: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub avg_ai_escalation_pct: f64,
    pub daily: Vec<AiDailyUsageRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunnelStats {
    pub days: u32,
    pub posts_captured: i64,
    pub dedup_dropped: i64,
    pub prefilter_dropped: i64,
    pub rule_decided: i64,
    pub rule_matched: i64,
    pub ai_decided: i64,
    pub ai_matched: i64,
    pub leads_created: i64,
    pub leads_notified: i64,
    pub leads_weak: i64,
    pub false_positives: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RulesetExtractorRule {
    pub field: String,
    pub extractor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub near: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dict: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefixes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multipliers: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cast: Option<dealsonar_rules::RegexCast>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetClassifyRule {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kw_any: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kw_none: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<dealsonar_rules::Condition>,
    pub verdict: String,
    pub confidence: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RulesetPrefilter {
    #[serde(default)]
    pub any: Vec<String>,
    #[serde(default)]
    pub none: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_len: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetThresholds {
    pub accept: f64,
    pub reject: f64,
}

impl Default for RulesetThresholds {
    fn default() -> Self {
        Self {
            accept: 0.9,
            reject: 0.9,
        }
    }
}

pub(super) fn default_dsl_one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetBody {
    #[serde(default = "default_dsl_one")]
    pub dsl: u32,
    #[serde(default)]
    pub prefilter: RulesetPrefilter,
    #[serde(default)]
    pub classify: Vec<RulesetClassifyRule>,
    #[serde(default)]
    pub extract: Vec<RulesetExtractorRule>,
    #[serde(default)]
    pub thresholds: RulesetThresholds,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetMetrics {
    pub rule_handled_pct: f64,
    pub ai_handled_pct: f64,
    pub accept_precision: f64,
    pub false_negative_rate: f64,
    pub sample_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ruleset {
    pub id: String,
    pub radar_version_id: String,
    pub revision: i32,
    pub state: String,
    pub origin: String,
    pub body: RulesetBody,
    pub metrics: Option<RulesetMetrics>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTierMap {
    pub fast: String,
    pub smart: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlPolicySettings {
    pub group_interval_minutes: u32,
    pub priority_interval_minutes: u32,
    pub hourly_page_load_budget: u32,
    pub daily_page_load_budget: u32,
    pub active_hours: QuietHours,
    pub max_scroll_steps: u32,
    pub max_posts_per_visit: u32,
    pub only_when_idle: bool,
}

impl Default for CrawlPolicySettings {
    fn default() -> Self {
        Self {
            group_interval_minutes: 15,
            priority_interval_minutes: 5,
            hourly_page_load_budget: 60,
            daily_page_load_budget: 600,
            active_hours: QuietHours {
                from: "07:00".to_string(),
                to: "23:00".to_string(),
            },
            max_scroll_steps: 3,
            max_posts_per_visit: 25,
            only_when_idle: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub privacy_consent_accepted: bool,
    pub onboarding_completed: bool,
    pub launch_at_login: bool,
    pub ai_provider: Option<AiProviderId>,
    pub model_tiers: BTreeMap<AiProviderId, ModelTierMap>,
    pub daily_ai_post_cap: u32,
    pub default_notify_mode: NotifyMode,
    pub digest_interval_minutes: u32,
    pub quiet_hours_enabled: bool,
    pub quiet_hours: QuietHours,
    pub os_notifications_enabled: bool,
    pub crawl_policy: CrawlPolicySettings,
    pub unmatched_retention_days: u32,
    pub debug_keep_ai_io: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let mut model_tiers = BTreeMap::new();
        model_tiers.insert(
            AiProviderId::ClaudeCli,
            ModelTierMap {
                fast: "haiku".to_string(),
                smart: "sonnet".to_string(),
            },
        );
        model_tiers.insert(
            AiProviderId::CodexCli,
            ModelTierMap {
                fast: "codex-mini-latest".to_string(),
                smart: "gpt-5-codex".to_string(),
            },
        );
        model_tiers.insert(
            AiProviderId::AgyCli,
            ModelTierMap {
                fast: "gemini-2.5-flash".to_string(),
                smart: "gemini-2.5-pro".to_string(),
            },
        );

        Self {
            privacy_consent_accepted: false,
            onboarding_completed: false,
            launch_at_login: true,
            ai_provider: None,
            model_tiers,
            daily_ai_post_cap: 2_000,
            default_notify_mode: NotifyMode::Instant,
            digest_interval_minutes: 30,
            quiet_hours_enabled: false,
            quiet_hours: QuietHours::default(),
            os_notifications_enabled: true,
            crawl_policy: CrawlPolicySettings::default(),
            unmatched_retention_days: 90,
            debug_keep_ai_io: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlPolicySettingsPatch {
    pub group_interval_minutes: Option<u32>,
    pub priority_interval_minutes: Option<u32>,
    pub hourly_page_load_budget: Option<u32>,
    pub daily_page_load_budget: Option<u32>,
    pub active_hours: Option<QuietHours>,
    pub max_scroll_steps: Option<u32>,
    pub max_posts_per_visit: Option<u32>,
    pub only_when_idle: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsPatch {
    pub privacy_consent_accepted: Option<bool>,
    pub onboarding_completed: Option<bool>,
    pub launch_at_login: Option<bool>,
    /// Outer `Some(None)` clears `ai_provider`; `None` leaves unchanged.
    #[serde(default, with = "double_option")]
    pub ai_provider: Option<Option<AiProviderId>>,
    pub model_tiers: Option<BTreeMap<AiProviderId, ModelTierMap>>,
    pub daily_ai_post_cap: Option<u32>,
    pub default_notify_mode: Option<NotifyMode>,
    pub digest_interval_minutes: Option<u32>,
    pub quiet_hours_enabled: Option<bool>,
    pub quiet_hours: Option<QuietHours>,
    pub os_notifications_enabled: Option<bool>,
    pub crawl_policy: Option<CrawlPolicySettingsPatch>,
    pub unmatched_retention_days: Option<u32>,
    pub debug_keep_ai_io: Option<bool>,
}

pub(super) mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }

    pub fn serialize<T, S>(val: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        T: Serialize,
        S: Serializer,
    {
        match val {
            None => serializer.serialize_none(),
            Some(inner) => inner.serialize(serializer),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanTier {
    Personal,
    Pro,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseLimits {
    pub max_active_radars: Option<usize>,
    pub max_followed_groups: usize,
    pub max_fields_per_radar: usize,
    pub allow_xlsx_export: bool,
    pub allow_webhooks: bool,
    pub allow_auto_rulesets: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseStatus {
    pub plan: PlanTier,
    pub licensee: Option<String>,
    pub issued_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub is_valid: bool,
    pub key_preview: Option<String>,
    pub limits: LicenseLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiModelOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_tier: Option<String>,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeResult {
    pub provider: AiProviderId,
    pub binary_name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub flags_supported: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub install_hint: String,
    pub login_command: String,
    #[serde(default)]
    pub available_models: Vec<AiModelOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_fast_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_smart_model: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: ChannelConfig,
    pub state: String,
    #[serde(default)]
    pub last_error: Option<String>,
    pub created_at: i64,
}
