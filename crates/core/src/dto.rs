//! Typed Tauri IPC DTOs, command inputs/outputs, real-time push events, and cross-crate
//! type converters matching `apps/desktop/ui/src/types/ipc.ts` & `apps/desktop/ui/src/lib/api.ts`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================================================
// Core Enums & Radar Schema (`ipc.ts`)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RadarStatus {
    Draft,
    Active,
    Paused,
    Archived,
}

impl RadarStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Archived => "archived",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "active" => Self::Active,
            "paused" => Self::Paused,
            "archived" => Self::Archived,
            _ => Self::Draft,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Number,
    Money,
    Phone,
    Location,
    Enum,
    MultiEnum,
    Boolean,
    Date,
    Range,
    Url,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WantIntent {
    Demand,
    Supply,
    Any,
}

impl WantIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Demand => "demand",
            Self::Supply => "supply",
            Self::Any => "any",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "demand" => Self::Demand,
            "supply" => Self::Supply,
            _ => Self::Any,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostIntent {
    Demand,
    Supply,
    Other,
}

impl PostIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Demand => "demand",
            Self::Supply => "supply",
            Self::Other => "other",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("demand") => Self::Demand,
            Some("supply") => Self::Supply,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorRole {
    EndUser,
    Peer,
    Unknown,
}

impl AuthorRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EndUser => "end_user",
            Self::Peer => "peer",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("end_user") => Self::EndUser,
            Some("peer") => Self::Peer,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Ai,
    Rule,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOperator {
    Eq,
    Ne,
    In,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    Contains,
    IsEmpty,
}

impl FilterOperator {
    pub fn from_str_lossy(s: &str) -> Self {
        match s.trim() {
            "ne" => Self::Ne,
            "in" => Self::In,
            "lt" => Self::Lt,
            "lte" => Self::Lte,
            "gt" => Self::Gt,
            "gte" => Self::Gte,
            "between" => Self::Between,
            "contains" => Self::Contains,
            "is_empty" => Self::IsEmpty,
            _ => Self::Eq,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenMissing {
    Pass,
    Fail,
}

impl Default for WhenMissing {
    fn default() -> Self {
        Self::Pass
    }
}

impl WhenMissing {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "fail" => Self::Fail,
            _ => Self::Pass,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub show_in_alert: bool,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardFilter {
    pub field: String,
    pub op: FilterOperator,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub when_missing: WhenMissing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchPolicy {
    pub want_intent: WantIntent,
    #[serde(default)]
    pub exclude_roles: Vec<AuthorRole>,
    #[serde(default)]
    pub hard_filters: Vec<HardFilter>,
}

impl Default for MatchPolicy {
    fn default() -> Self {
        Self {
            want_intent: WantIntent::Any,
            exclude_roles: vec![AuthorRole::Peer],
            hard_filters: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuietHours {
    pub from: String,
    pub to: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            from: "22:30".to_string(),
            to: "06:30".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyMode {
    Instant,
    Digest,
}

impl Default for NotifyMode {
    fn default() -> Self {
        Self::Instant
    }
}

impl NotifyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Instant => "instant",
            Self::Digest => "digest",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "digest" => Self::Digest,
            _ => Self::Instant,
        }
    }
}

fn default_min_score() -> f64 {
    0.6
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarNotifyConfig {
    #[serde(default)]
    pub channel_ids: Vec<String>,
    #[serde(default)]
    pub mode: NotifyMode,
    #[serde(default = "default_min_score")]
    pub min_score: f64,
    #[serde(default)]
    pub quiet_hours: Option<QuietHours>,
}

impl Default for RadarNotifyConfig {
    fn default() -> Self {
        Self {
            channel_ids: Vec::new(),
            mode: NotifyMode::Instant,
            min_score: 0.6,
            quiet_hours: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Radar {
    pub id: String,
    pub name: String,
    pub status: RadarStatus,
    pub template_id: Option<String>,
    pub current_version: i32,
    pub source_ids: Vec<String>,
    pub notify: RadarNotifyConfig,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leads_24h: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub false_positive_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluated_posts_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_handled_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_digest_flood: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarVersion {
    pub id: String,
    pub radar_id: String,
    pub version: i32,
    pub description: String,
    pub language_hint: Option<String>,
    pub user_profession: Option<String>,
    pub fields: Vec<FieldDef>,
    pub match_policy: MatchPolicy,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarDetail {
    pub radar: Radar,
    pub current_version_data: RadarVersion,
    pub pending_version_data: Option<RadarVersion>,
    pub versions: Vec<RadarVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplatePlaceholder {
    pub key: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarTemplate {
    pub id: String,
    pub industry: String,
    pub name: String,
    pub description_template: String,
    #[serde(default)]
    pub placeholders: Vec<TemplatePlaceholder>,
    pub user_profession: String,
    pub fields: Vec<FieldDef>,
    pub match_policy: MatchPolicy,
    #[serde(default)]
    pub seed_ruleset: Option<String>,
}

// ============================================================================
// Sources, Posts, Leads, Contacts, Blocklist (`ipc.ts`)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Ok,
    Error,
    Inaccessible,
}

impl SourceState {
    pub fn from_db(s: &str) -> Self {
        match s {
            "error" => Self::Error,
            "inaccessible" => Self::Inaccessible,
            _ => Self::Ok,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub platform: String,
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub url: String,
    pub privacy: Option<String>,
    pub member_count: Option<i64>,
    pub profile_id: Option<String>,
    pub followed: bool,
    pub priority: bool,
    pub state: SourceState,
    pub last_crawl_at: Option<i64>,
    pub avg_new_posts: f64,
    pub posts_per_day: i64,
    pub stored_post_count: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: Value,
    pub raw: Option<String>,
    pub confidence: f64,
    pub source: FieldSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeadStatus {
    New,
    Viewed,
    Contacted,
    Negotiating,
    Won,
    Lost,
    Ignored,
}

impl LeadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Viewed => "viewed",
            Self::Contacted => "contacted",
            Self::Negotiating => "negotiating",
            Self::Won => "won",
            Self::Lost => "lost",
            Self::Ignored => "ignored",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "viewed" => Self::Viewed,
            "contacted" => Self::Contacted,
            "negotiating" => Self::Negotiating,
            "won" => Self::Won,
            "lost" => Self::Lost,
            "ignored" => Self::Ignored,
            _ => Self::New,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    Dedup,
    Prefilter,
    Rule,
    Ai,
    Postfilter,
}

impl DecidedBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dedup => "dedup",
            Self::Prefilter => "prefilter",
            Self::Rule => "rule",
            Self::Ai => "ai",
            Self::Postfilter => "postfilter",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("dedup") => Self::Dedup,
            Some("prefilter") => Self::Prefilter,
            Some("rule") => Self::Rule,
            Some("postfilter") => Self::Postfilter,
            _ => Self::Ai,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Duplicate,
    Prefilter,
    Irrelevant,
    Peer,
    Spam,
    Blocked,
    HardFilter,
}

impl RejectReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::Prefilter => "prefilter",
            Self::Irrelevant => "irrelevant",
            Self::Peer => "peer",
            Self::Spam => "spam",
            Self::Blocked => "blocked",
            Self::HardFilter => "hard_filter",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("duplicate") => Self::Duplicate,
            Some("prefilter") => Self::Prefilter,
            Some("peer") => Self::Peer,
            Some("spam") => Self::Spam,
            Some("blocked") => Self::Blocked,
            Some("hard_filter") => Self::HardFilter,
            _ => Self::Irrelevant,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackLabel {
    Correct,
    Irrelevant,
    WrongFields,
    Peer,
    Duplicate,
    Spam,
    Missed,
}

impl FeedbackLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Correct => "correct",
            Self::Irrelevant => "irrelevant",
            Self::WrongFields => "wrong_fields",
            Self::Peer => "peer",
            Self::Duplicate => "duplicate",
            Self::Spam => "spam",
            Self::Missed => "missed",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "correct" => Some(Self::Correct),
            "irrelevant" => Some(Self::Irrelevant),
            "wrong_fields" => Some(Self::WrongFields),
            "peer" => Some(Self::Peer),
            "duplicate" => Some(Self::Duplicate),
            "spam" => Some(Self::Spam),
            "missed" => Some(Self::Missed),
            _ => None,
        }
    }

    pub fn is_negative(&self) -> bool {
        matches!(
            self,
            Self::Irrelevant | Self::Peer | Self::Duplicate | Self::Spam
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlsoSeenSource {
    pub source_id: String,
    pub source_name: String,
    pub permalink: String,
    pub captured_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lead {
    pub id: String,
    pub radar_id: String,
    pub radar_name: String,
    pub radar_version_id: String,
    pub radar_version: i32,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    pub status: LeadStatus,
    pub score: f64,
    pub is_weak_match: bool,
    pub summary: String,
    pub reason: Option<String>,
    pub decided_by: DecidedBy,
    pub fields: BTreeMap<String, ExtractedField>,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub also_seen_in: Vec<AlsoSeenSource>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub feedback_label: Option<FeedbackLabel>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEvent {
    pub id: String,
    pub lead_id: String,
    pub kind: String,
    pub data: Option<BTreeMap<String, Value>>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Post {
    pub id: String,
    pub platform: String,
    pub external_id: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub permalink: String,
    pub text: Option<String>,
    pub text_truncated: bool,
    pub lang: Option<String>,
    pub created_at: Option<i64>,
    pub captured_at: i64,
    pub strategy: String,
    pub purged_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadDetail {
    pub lead: Lead,
    pub post: Post,
    pub radar_fields: Vec<FieldDef>,
    pub events: Vec<LeadEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DynamicFieldFilter {
    pub field: String,
    pub op: FilterOperator,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadSortInput {
    pub by: String,
    pub dir: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LeadFilterQuery {
    #[serde(default)]
    pub radar_id: Option<String>,
    #[serde(default)]
    pub status: Option<Vec<LeadStatus>>,
    #[serde(default)]
    pub include_weak: Option<bool>,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub filters: Option<Vec<DynamicFieldFilter>>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: Option<LeadSortInput>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListResponse {
    pub items: Vec<Lead>,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedEvaluation {
    pub evaluation_id: String,
    pub post_id: String,
    pub radar_id: String,
    pub radar_version_id: String,
    pub decided_by: DecidedBy,
    pub reject_reason: RejectReason,
    pub score: Option<f64>,
    pub reason: Option<String>,
    pub source_name: String,
    pub author_name: String,
    pub permalink: String,
    pub post_text: String,
    pub captured_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked_missed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub display_name: String,
    pub phones: Vec<String>,
    pub author_ids: Vec<String>,
    pub note: Option<String>,
    pub lead_count: i64,
    pub is_blocked: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContactDetail {
    pub contact: Contact,
    pub leads: Vec<Lead>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlocklistKind {
    Author,
    Phone,
    Keyword,
}

impl BlocklistKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Phone => "phone",
            Self::Keyword => "keyword",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "author" => Self::Author,
            "phone" => Self::Phone,
            _ => Self::Keyword,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocklistEntry {
    pub id: String,
    pub kind: BlocklistKind,
    pub value: String,
    #[serde(default)]
    pub display_label: Option<String>,
    pub radar_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
}

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

fn default_dsl_one() -> u32 {
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

mod double_option {
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

// ============================================================================
// Command Input & Output Contracts (`ipc.ts` & `api.ts`)
// ============================================================================

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RadarNotifyPatch {
    pub channel_ids: Option<Vec<String>>,
    pub mode: Option<NotifyMode>,
    pub min_score: Option<f64>,
    #[serde(default, with = "double_option")]
    pub quiet_hours: Option<Option<QuietHours>>,
}

impl RadarNotifyPatch {
    pub fn apply_onto(&self, base: &RadarNotifyConfig) -> RadarNotifyConfig {
        RadarNotifyConfig {
            channel_ids: self
                .channel_ids
                .clone()
                .unwrap_or_else(|| base.channel_ids.clone()),
            mode: self.mode.unwrap_or(base.mode),
            min_score: self.min_score.unwrap_or(base.min_score),
            quiet_hours: match &self.quiet_hours {
                Some(qh) => qh.clone(),
                None => base.quiet_hours.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateRadarDraftInput {
    pub name: String,
    #[serde(default)]
    pub template_id: Option<String>,
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub match_policy: MatchPolicy,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub notify: Option<RadarNotifyPatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRadarInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default, with = "double_option")]
    pub user_profession: Option<Option<String>>,
    pub fields: Option<Vec<FieldDef>>,
    pub match_policy: Option<MatchPolicy>,
    pub source_ids: Option<Vec<String>>,
    pub notify: Option<RadarNotifyPatch>,
    #[serde(default)]
    pub confirm_version_upgrade: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarUpdateResult {
    pub detail: RadarDetail,
    pub created_new_version: bool,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestFieldsInput {
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefilterHintDto {
    pub any: Vec<String>,
    pub none: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestFieldsResult {
    pub suggested_name: String,
    pub want_intent: WantIntent,
    pub fields: Vec<FieldDef>,
    pub hard_filters: Vec<HardFilter>,
    pub clarifying_questions: Vec<String>,
    pub prefilter_hint: Option<PrefilterHintDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewItem {
    pub evaluation_id: String,
    pub post_id: String,
    pub verdict: String,
    pub score: f64,
    pub intent: PostIntent,
    pub author_role: AuthorRole,
    pub summary: String,
    pub reason: String,
    pub decided_by: DecidedBy,
    pub fields: BTreeMap<String, ExtractedField>,
    pub source_name: String,
    pub author_name: String,
    pub permalink: String,
    pub post_text: String,
    pub post_created_at: Option<i64>,
    pub feedback_label: Option<FeedbackLabel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewWarningCode {
    ZeroMatches,
    TooBroad,
    MissingRequiredField,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewWarning {
    pub code: PreviewWarningCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_label: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStatus {
    Crawling,
    Evaluating,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewRunState {
    pub preview_id: String,
    pub radar_id: String,
    pub radar_version: i32,
    pub status: PreviewStatus,
    pub total_posts: usize,
    pub evaluated_posts: usize,
    pub items: Vec<PreviewItem>,
    pub warnings: Vec<PreviewWarning>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewStartInput {
    pub radar_id: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, with = "double_option")]
    pub user_profession: Option<Option<String>>,
    #[serde(default)]
    pub fields: Option<Vec<FieldDef>>,
    #[serde(default)]
    pub match_policy: Option<MatchPolicy>,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackOrigin {
    App,
    Preview,
}

impl FeedbackOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Preview => "preview",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFeedbackInput {
    pub evaluation_id: String,
    #[serde(default)]
    pub lead_id: Option<String>,
    #[serde(default)]
    pub post_id: Option<String>,
    #[serde(default)]
    pub radar_version_id: Option<String>,
    pub label: FeedbackLabel,
    #[serde(default)]
    pub corrected_fields: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub duplicate_of_lead_id: Option<String>,
    #[serde(default)]
    pub block_author: Option<bool>,
    pub origin: FeedbackOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFeedbackResult {
    pub feedback_id: String,
    pub updated_lead: Option<Lead>,
    pub blocked_entry: Option<BlocklistEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Xlsx,
}

impl ExportFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadExportInput {
    pub query: LeadFilterQuery,
    pub format: ExportFormat,
    pub include_post_text: bool,
    #[serde(default)]
    pub dest_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadExportResult {
    pub path: String,
    pub format: ExportFormat,
    pub row_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramSetupStatus {
    pub bot_username: String,
    pub bot_link: String,
    pub waiting_for_start: bool,
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeConnectOptions {
    #[serde(default)]
    pub extension_id: Option<String>,
    #[serde(default)]
    pub resume_crawl: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeConnectResult {
    pub native_host_installed: bool,
    pub manifest_path: String,
    pub extension_connected: bool,
    pub facebook_session: FacebookSessionState,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceCrawlNowResult {
    pub queued: bool,
    pub run_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadCrmPatch {
    #[serde(default, with = "double_option")]
    pub note: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default, with = "double_option")]
    pub follow_up_at: Option<Option<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContactBlockResult {
    pub blocked_entries: Vec<BlocklistEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocklistRemoveResult {
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetCompileResult {
    pub job_id: String,
    pub ruleset: Option<Ruleset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelRemoveResult {
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticBundleResult {
    pub path: String,
    pub size_bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataBackupResult {
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataPurgeResult {
    pub posts_purged: usize,
    pub evaluations_cleaned: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataDeleteAllResult {
    pub deleted: bool,
}

// ============================================================================
// Real-time Push Events (`TauriEventMap` in `ipc.ts`)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewProgressEvent {
    pub preview_id: String,
    pub radar_id: String,
    pub status: PreviewStatus,
    pub evaluated_posts: usize,
    pub total_posts: usize,
    pub new_items: Vec<PreviewItem>,
    pub warnings: Vec<PreviewWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobFailedEvent {
    pub job_id: String,
    pub kind: String,
    pub error: String,
    pub failed_at: i64,
}

/// Exact 6 push events emitted to the Tauri UI (`03-desktop.md §4`, `TauriEventMap`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum CoreEvent {
    #[serde(rename = "lead:new")]
    LeadNew(Lead),
    #[serde(rename = "lead:updated")]
    LeadUpdated(Lead),
    #[serde(rename = "preview:progress")]
    PreviewProgress(PreviewProgressEvent),
    #[serde(rename = "health:changed")]
    HealthChanged(HealthStatus),
    #[serde(rename = "crawl:finished")]
    CrawlFinished(CrawlRun),
    #[serde(rename = "job:failed")]
    JobFailed(JobFailedEvent),
}

impl CoreEvent {
    /// Tauri event name (`"lead:new"`, `"lead:updated"`, `"preview:progress"`,
    /// `"health:changed"`, `"crawl:finished"`, `"job:failed"`).
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::LeadNew(_) => "lead:new",
            Self::LeadUpdated(_) => "lead:updated",
            Self::PreviewProgress(_) => "preview:progress",
            Self::HealthChanged(_) => "health:changed",
            Self::CrawlFinished(_) => "crawl:finished",
            Self::JobFailed(_) => "job:failed",
        }
    }

    /// Serialize the event's inner payload matching `TauriEventMap[event_name]`.
    pub fn to_payload_value(&self) -> Value {
        match self {
            Self::LeadNew(v) | Self::LeadUpdated(v) => {
                serde_json::to_value(v).unwrap_or(Value::Null)
            }
            Self::PreviewProgress(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::HealthChanged(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::CrawlFinished(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::JobFailed(v) => serde_json::to_value(v).unwrap_or(Value::Null),
        }
    }
}

// ============================================================================
// Cross-Crate Type Converters (`store` <-> `rules` <-> `ai-bridge` <-> `notify` <-> `dto`)
// ============================================================================

pub fn field_type_to_store(ft: FieldType) -> dealsonar_store::models::FieldType {
    match ft {
        FieldType::Text => dealsonar_store::models::FieldType::Text,
        FieldType::Number => dealsonar_store::models::FieldType::Number,
        FieldType::Money => dealsonar_store::models::FieldType::Money,
        FieldType::Phone => dealsonar_store::models::FieldType::Phone,
        FieldType::Location => dealsonar_store::models::FieldType::Location,
        FieldType::Enum => dealsonar_store::models::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_store::models::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_store::models::FieldType::Boolean,
        FieldType::Date => dealsonar_store::models::FieldType::Date,
        FieldType::Range => dealsonar_store::models::FieldType::Range,
        FieldType::Url => dealsonar_store::models::FieldType::Url,
    }
}

pub fn field_type_from_store(ft: dealsonar_store::models::FieldType) -> FieldType {
    match ft {
        dealsonar_store::models::FieldType::Text => FieldType::Text,
        dealsonar_store::models::FieldType::Number => FieldType::Number,
        dealsonar_store::models::FieldType::Money => FieldType::Money,
        dealsonar_store::models::FieldType::Phone => FieldType::Phone,
        dealsonar_store::models::FieldType::Location => FieldType::Location,
        dealsonar_store::models::FieldType::Enum => FieldType::Enum,
        dealsonar_store::models::FieldType::MultiEnum => FieldType::MultiEnum,
        dealsonar_store::models::FieldType::Boolean => FieldType::Boolean,
        dealsonar_store::models::FieldType::Date => FieldType::Date,
        dealsonar_store::models::FieldType::Range => FieldType::Range,
        dealsonar_store::models::FieldType::Url => FieldType::Url,
    }
}

pub fn field_type_to_rules(ft: FieldType) -> dealsonar_rules::FieldType {
    match ft {
        FieldType::Text => dealsonar_rules::FieldType::Text,
        FieldType::Number => dealsonar_rules::FieldType::Number,
        FieldType::Money => dealsonar_rules::FieldType::Money,
        FieldType::Phone => dealsonar_rules::FieldType::Phone,
        FieldType::Location => dealsonar_rules::FieldType::Location,
        FieldType::Enum => dealsonar_rules::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_rules::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_rules::FieldType::Boolean,
        FieldType::Date => dealsonar_rules::FieldType::Date,
        FieldType::Range => dealsonar_rules::FieldType::Range,
        FieldType::Url => dealsonar_rules::FieldType::Url,
    }
}

pub fn field_type_to_ai(ft: FieldType) -> dealsonar_ai_bridge::FieldType {
    match ft {
        FieldType::Text => dealsonar_ai_bridge::FieldType::Text,
        FieldType::Number => dealsonar_ai_bridge::FieldType::Number,
        FieldType::Money => dealsonar_ai_bridge::FieldType::Money,
        FieldType::Phone => dealsonar_ai_bridge::FieldType::Phone,
        FieldType::Location => dealsonar_ai_bridge::FieldType::Location,
        FieldType::Enum => dealsonar_ai_bridge::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_ai_bridge::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_ai_bridge::FieldType::Boolean,
        FieldType::Date => dealsonar_ai_bridge::FieldType::Date,
        FieldType::Range => dealsonar_ai_bridge::FieldType::Range,
        FieldType::Url => dealsonar_ai_bridge::FieldType::Url,
    }
}

pub fn field_type_from_ai(ft: dealsonar_ai_bridge::FieldType) -> FieldType {
    match ft {
        dealsonar_ai_bridge::FieldType::Text => FieldType::Text,
        dealsonar_ai_bridge::FieldType::Number => FieldType::Number,
        dealsonar_ai_bridge::FieldType::Money => FieldType::Money,
        dealsonar_ai_bridge::FieldType::Phone => FieldType::Phone,
        dealsonar_ai_bridge::FieldType::Location => FieldType::Location,
        dealsonar_ai_bridge::FieldType::Enum => FieldType::Enum,
        dealsonar_ai_bridge::FieldType::MultiEnum => FieldType::MultiEnum,
        dealsonar_ai_bridge::FieldType::Boolean => FieldType::Boolean,
        dealsonar_ai_bridge::FieldType::Date => FieldType::Date,
        dealsonar_ai_bridge::FieldType::Range => FieldType::Range,
        dealsonar_ai_bridge::FieldType::Url => FieldType::Url,
    }
}

pub fn field_type_to_notify(ft: FieldType) -> dealsonar_notify::FieldType {
    match ft {
        FieldType::Text => dealsonar_notify::FieldType::Text,
        FieldType::Number => dealsonar_notify::FieldType::Number,
        FieldType::Money => dealsonar_notify::FieldType::Money,
        FieldType::Phone => dealsonar_notify::FieldType::Phone,
        FieldType::Location => dealsonar_notify::FieldType::Location,
        FieldType::Enum => dealsonar_notify::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_notify::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_notify::FieldType::Boolean,
        FieldType::Date => dealsonar_notify::FieldType::Date,
        FieldType::Range => dealsonar_notify::FieldType::Range,
        FieldType::Url => dealsonar_notify::FieldType::Url,
    }
}

pub fn field_def_from_ai(sf: &dealsonar_ai_bridge::SuggestedField, order: i32) -> FieldDef {
    FieldDef {
        key: sf.key.clone(),
        label: sf.label.clone(),
        r#type: field_type_from_ai(sf.r#type),
        description: sf.description.clone(),
        required: sf.required,
        options: sf.options.clone(),
        show_in_alert: true,
        order,
    }
}

pub fn field_def_to_store(f: &FieldDef) -> dealsonar_store::models::FieldDef {
    dealsonar_store::models::FieldDef {
        key: f.key.clone(),
        label: f.label.clone(),
        r#type: field_type_to_store(f.r#type),
        description: f.description.clone(),
        required: f.required,
        options: f.options.clone(),
        show_in_alert: f.show_in_alert,
        order: f.order,
    }
}

pub fn field_def_from_store(f: &dealsonar_store::models::FieldDef) -> FieldDef {
    FieldDef {
        key: f.key.clone(),
        label: f.label.clone(),
        r#type: field_type_from_store(f.r#type),
        description: f.description.clone(),
        required: f.required,
        options: f.options.clone(),
        show_in_alert: f.show_in_alert,
        order: f.order,
    }
}

pub fn field_def_store_to_rules(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_rules::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_rules::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_rules(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn field_def_store_to_ai(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_ai_bridge::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_ai_bridge::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_ai(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn field_def_store_to_notify(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_notify::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_notify::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_notify(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn filter_op_to_store(op: FilterOperator) -> dealsonar_store::models::FilterOp {
    match op {
        FilterOperator::Eq => dealsonar_store::models::FilterOp::Eq,
        FilterOperator::Ne => dealsonar_store::models::FilterOp::Ne,
        FilterOperator::In => dealsonar_store::models::FilterOp::In,
        FilterOperator::Lt => dealsonar_store::models::FilterOp::Lt,
        FilterOperator::Lte => dealsonar_store::models::FilterOp::Lte,
        FilterOperator::Gt => dealsonar_store::models::FilterOp::Gt,
        FilterOperator::Gte => dealsonar_store::models::FilterOp::Gte,
        FilterOperator::Between => dealsonar_store::models::FilterOp::Between,
        FilterOperator::Contains => dealsonar_store::models::FilterOp::Contains,
        FilterOperator::IsEmpty => dealsonar_store::models::FilterOp::IsEmpty,
    }
}

pub fn filter_op_from_store(op: dealsonar_store::models::FilterOp) -> FilterOperator {
    match op {
        dealsonar_store::models::FilterOp::Eq => FilterOperator::Eq,
        dealsonar_store::models::FilterOp::Ne => FilterOperator::Ne,
        dealsonar_store::models::FilterOp::In => FilterOperator::In,
        dealsonar_store::models::FilterOp::Lt => FilterOperator::Lt,
        dealsonar_store::models::FilterOp::Lte => FilterOperator::Lte,
        dealsonar_store::models::FilterOp::Gt => FilterOperator::Gt,
        dealsonar_store::models::FilterOp::Gte => FilterOperator::Gte,
        dealsonar_store::models::FilterOp::Between => FilterOperator::Between,
        dealsonar_store::models::FilterOp::Contains => FilterOperator::Contains,
        dealsonar_store::models::FilterOp::IsEmpty => FilterOperator::IsEmpty,
    }
}

pub fn filter_op_store_to_rules(
    op: dealsonar_store::models::FilterOp,
) -> dealsonar_rules::FilterOp {
    match op {
        dealsonar_store::models::FilterOp::Eq => dealsonar_rules::FilterOp::Eq,
        dealsonar_store::models::FilterOp::Ne => dealsonar_rules::FilterOp::Ne,
        dealsonar_store::models::FilterOp::In => dealsonar_rules::FilterOp::In,
        dealsonar_store::models::FilterOp::Lt => dealsonar_rules::FilterOp::Lt,
        dealsonar_store::models::FilterOp::Lte => dealsonar_rules::FilterOp::Lte,
        dealsonar_store::models::FilterOp::Gt => dealsonar_rules::FilterOp::Gt,
        dealsonar_store::models::FilterOp::Gte => dealsonar_rules::FilterOp::Gte,
        dealsonar_store::models::FilterOp::Between => dealsonar_rules::FilterOp::Between,
        dealsonar_store::models::FilterOp::Contains => dealsonar_rules::FilterOp::Contains,
        dealsonar_store::models::FilterOp::IsEmpty => dealsonar_rules::FilterOp::IsEmpty,
    }
}

pub fn match_policy_to_store(mp: &MatchPolicy) -> dealsonar_store::models::MatchPolicy {
    dealsonar_store::models::MatchPolicy {
        want_intent: mp.want_intent.as_str().to_string(),
        exclude_roles: mp
            .exclude_roles
            .iter()
            .map(|r| r.as_str().to_string())
            .collect(),
        hard_filters: mp
            .hard_filters
            .iter()
            .map(|hf| dealsonar_store::models::HardFilter {
                field: hf.field.clone(),
                op: filter_op_to_store(hf.op),
                value: hf.value.clone(),
                when_missing: hf.when_missing.as_str().to_string(),
            })
            .collect(),
        extra: BTreeMap::new(),
    }
}

pub fn match_policy_from_store(mp: &dealsonar_store::models::MatchPolicy) -> MatchPolicy {
    MatchPolicy {
        want_intent: WantIntent::from_db(&mp.want_intent),
        exclude_roles: mp
            .exclude_roles
            .iter()
            .map(|r| AuthorRole::from_db(Some(r.as_str())))
            .collect(),
        hard_filters: mp
            .hard_filters
            .iter()
            .map(|hf| HardFilter {
                field: hf.field.clone(),
                op: filter_op_from_store(hf.op),
                value: hf.value.clone(),
                when_missing: WhenMissing::from_db(&hf.when_missing),
            })
            .collect(),
    }
}

pub fn hard_filters_store_to_rules(
    filters: &[dealsonar_store::models::HardFilter],
) -> Vec<dealsonar_rules::HardFilter> {
    filters
        .iter()
        .map(|hf| dealsonar_rules::HardFilter {
            field: hf.field.clone(),
            op: filter_op_store_to_rules(hf.op),
            value: hf.value.clone(),
            when_missing: if hf.when_missing == "fail" {
                dealsonar_rules::WhenMissing::Fail
            } else {
                dealsonar_rules::WhenMissing::Pass
            },
        })
        .collect()
}

pub fn notify_to_store(n: &RadarNotifyConfig) -> dealsonar_store::models::NotifyConfig {
    dealsonar_store::models::NotifyConfig {
        channel_ids: n.channel_ids.clone(),
        mode: n.mode.as_str().to_string(),
        min_score: n.min_score,
        quiet_hours: n
            .quiet_hours
            .as_ref()
            .map(|q| dealsonar_store::models::QuietHours {
                from: q.from.clone(),
                to: q.to.clone(),
            }),
    }
}

pub fn notify_from_store(n: &dealsonar_store::models::NotifyConfig) -> RadarNotifyConfig {
    RadarNotifyConfig {
        channel_ids: n.channel_ids.clone(),
        mode: NotifyMode::from_db(&n.mode),
        min_score: n.min_score,
        quiet_hours: n.quiet_hours.as_ref().map(|q| QuietHours {
            from: q.from.clone(),
            to: q.to.clone(),
        }),
    }
}

pub fn radar_version_from_store(rv: &dealsonar_store::models::RadarVersionRecord) -> RadarVersion {
    RadarVersion {
        id: rv.id.clone(),
        radar_id: rv.radar_id.clone(),
        version: rv.version,
        description: rv.description.clone(),
        language_hint: rv.language_hint.clone(),
        user_profession: rv.user_profession.clone(),
        fields: rv.fields.iter().map(field_def_from_store).collect(),
        match_policy: match_policy_from_store(&rv.match_policy),
        created_at: rv.created_at,
    }
}

pub fn extracted_field_from_store(ef: &dealsonar_store::models::ExtractedField) -> ExtractedField {
    ExtractedField {
        value: ef.value.clone(),
        raw: ef.raw.clone(),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_store::models::FieldSource::Ai => FieldSource::Ai,
            dealsonar_store::models::FieldSource::Rule => FieldSource::Rule,
            dealsonar_store::models::FieldSource::User => FieldSource::User,
        },
    }
}

pub fn extracted_field_rules_to_store(
    ef: &dealsonar_rules::ExtractedField,
) -> dealsonar_store::models::ExtractedField {
    dealsonar_store::models::ExtractedField {
        value: ef.value.clone(),
        raw: Some(ef.raw.clone()),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_rules::FieldSource::Ai => dealsonar_store::models::FieldSource::Ai,
            dealsonar_rules::FieldSource::Rule => dealsonar_store::models::FieldSource::Rule,
            dealsonar_rules::FieldSource::User => dealsonar_store::models::FieldSource::User,
        },
    }
}

pub fn extracted_field_store_to_rules(
    ef: &dealsonar_store::models::ExtractedField,
) -> Option<dealsonar_rules::ExtractedField> {
    let raw = ef.raw.clone().unwrap_or_default();
    if raw.trim().is_empty() {
        return None;
    }
    Some(dealsonar_rules::ExtractedField {
        value: ef.value.clone(),
        raw,
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_store::models::FieldSource::Ai => dealsonar_rules::FieldSource::Ai,
            dealsonar_store::models::FieldSource::Rule => dealsonar_rules::FieldSource::Rule,
            dealsonar_store::models::FieldSource::User => dealsonar_rules::FieldSource::User,
        },
    })
}

pub fn extracted_field_ai_to_rules(
    ef: &dealsonar_ai_bridge::ExtractedField,
) -> dealsonar_rules::ExtractedField {
    dealsonar_rules::ExtractedField {
        value: ef.value.clone(),
        raw: ef.raw.clone(),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_ai_bridge::FieldSource::Ai => dealsonar_rules::FieldSource::Ai,
            dealsonar_ai_bridge::FieldSource::Rule => dealsonar_rules::FieldSource::Rule,
            dealsonar_ai_bridge::FieldSource::User => dealsonar_rules::FieldSource::User,
        },
    }
}

pub fn extracted_fields_store_to_notify(
    fields: &BTreeMap<String, dealsonar_store::models::ExtractedField>,
) -> HashMap<String, dealsonar_notify::ExtractedField> {
    fields
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                dealsonar_notify::ExtractedField {
                    value: v.value.clone(),
                    raw: v.raw.clone().unwrap_or_default(),
                    confidence: v.confidence,
                    source: match v.source {
                        dealsonar_store::models::FieldSource::Ai => {
                            dealsonar_notify::FieldSource::Ai
                        }
                        dealsonar_store::models::FieldSource::Rule => {
                            dealsonar_notify::FieldSource::Rule
                        }
                        dealsonar_store::models::FieldSource::User => {
                            dealsonar_notify::FieldSource::User
                        }
                    },
                },
            )
        })
        .collect()
}

/// Convert canonical [`dealsonar_rules::RulesetBody`] into UI [`RulesetBody`] (`ipc.ts`).
pub fn rules_to_dto_ruleset_body(body: &dealsonar_rules::RulesetBody) -> RulesetBody {
    let prefilter = match &body.prefilter {
        Some(pf) => RulesetPrefilter {
            any: pf.any.clone(),
            none: pf.none.clone(),
            min_len: pf.min_len,
        },
        None => RulesetPrefilter::default(),
    };

    let classify = body
        .classify
        .iter()
        .map(|rule| {
            let mut kw_any_acc = Vec::new();
            let mut kw_none_acc = Vec::new();
            let mut has_field_acc = None;
            extract_flat_condition_hints(
                &rule.when,
                &mut kw_any_acc,
                &mut kw_none_acc,
                &mut has_field_acc,
            );
            RulesetClassifyRule {
                id: rule.id.clone(),
                description: None,
                kw_any: (!kw_any_acc.is_empty()).then_some(kw_any_acc),
                kw_none: (!kw_none_acc.is_empty()).then_some(kw_none_acc),
                has_field: has_field_acc,
                when: Some(rule.when.clone()),
                verdict: match rule.verdict {
                    dealsonar_rules::RuleVerdict::Match => "match".to_string(),
                    dealsonar_rules::RuleVerdict::NoMatch => "no_match".to_string(),
                },
                confidence: rule.confidence,
                set: (!rule.set.is_empty()).then(|| rule.set.clone()),
            }
        })
        .collect();

    let extract = body
        .extract
        .iter()
        .map(|er| match &er.config {
            dealsonar_rules::ExtractorConfig::VnMoney { near, window } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_money".to_string(),
                near: (!near.is_empty()).then(|| near.clone()),
                window: Some(*window),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::VnPhone => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_phone".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::VnArea => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_area".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Gazetteer { dict, scope } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "gazetteer".to_string(),
                dict: Some(dict.clone()),
                scope: scope.clone(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Number {
                units,
                prefixes,
                multipliers,
            } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "number".to_string(),
                units: Some(units.clone()),
                prefixes: Some(prefixes.clone()),
                multipliers: Some(multipliers.clone()),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::DateVi => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "date_vi".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::EnumKw { map, multi } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "enum_kw".to_string(),
                map: Some(map.clone()),
                multi: Some(*multi),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Regex {
                pattern,
                group,
                cast,
            } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "regex".to_string(),
                pattern: Some(pattern.clone()),
                group: Some(*group),
                cast: Some(*cast),
                ..Default::default()
            },
        })
        .collect();

    RulesetBody {
        dsl: body.dsl,
        prefilter,
        classify,
        extract,
        thresholds: RulesetThresholds {
            accept: body.thresholds.accept,
            reject: body.thresholds.reject,
        },
    }
}

fn extract_flat_condition_hints(
    cond: &dealsonar_rules::Condition,
    kw_any: &mut Vec<String>,
    kw_none: &mut Vec<String>,
    has_field: &mut Option<String>,
) {
    match cond {
        dealsonar_rules::Condition::KwAny(kws) => {
            for kw in kws {
                if !kw_any.contains(kw) {
                    kw_any.push(kw.clone());
                }
            }
        }
        dealsonar_rules::Condition::KwNone(kws) => {
            for kw in kws {
                if !kw_none.contains(kw) {
                    kw_none.push(kw.clone());
                }
            }
        }
        dealsonar_rules::Condition::HasField(f) => {
            if has_field.is_none() {
                *has_field = Some(f.clone());
            }
        }
        dealsonar_rules::Condition::All(children) => {
            for c in children {
                extract_flat_condition_hints(c, kw_any, kw_none, has_field);
            }
        }
        _ => {}
    }
}

/// Convert UI [`RulesetBody`] (or full DSL JSON) into canonical [`dealsonar_rules::RulesetBody`].
pub fn dto_ruleset_body_to_rules(dto: &RulesetBody) -> dealsonar_rules::RulesetBody {
    let prefilter = if dto.prefilter.any.is_empty()
        && dto.prefilter.none.is_empty()
        && dto.prefilter.min_len.is_none()
    {
        None
    } else {
        Some(dealsonar_rules::PrefilterSpec {
            any: dto.prefilter.any.clone(),
            none: dto.prefilter.none.clone(),
            min_len: dto.prefilter.min_len,
        })
    };

    let classify = dto
        .classify
        .iter()
        .map(|r| {
            let cur_any = r.kw_any.as_ref().filter(|v| !v.is_empty()).cloned();
            let cur_none = r.kw_none.as_ref().filter(|v| !v.is_empty()).cloned();
            let cur_hf = r
                .has_field
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            // Preserve `existing_when` whenever `r.when` is present and the flat hint fields
            // (`kw_any`, `kw_none`, `has_field`) were not modified relative to `existing_when`
            // (so `ruleset_list -> ruleset_save_user` roundtrips never clobber `FieldOp`, `Any`,
            // `Not`, `LenGt`, `Regex`, or multi-`HasField` trees!).
            let preserve_existing = if let Some(existing_when) = &r.when {
                let mut orig_any_vec = Vec::new();
                let mut orig_none_vec = Vec::new();
                let mut orig_hf = None;
                extract_flat_condition_hints(
                    existing_when,
                    &mut orig_any_vec,
                    &mut orig_none_vec,
                    &mut orig_hf,
                );
                let orig_any = (!orig_any_vec.is_empty()).then_some(orig_any_vec);
                let orig_none = (!orig_none_vec.is_empty()).then_some(orig_none_vec);
                let orig_hf_clean = orig_hf
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                (cur_any == orig_any && cur_none == orig_none && cur_hf == orig_hf_clean)
                    || (cur_any.is_none() && cur_none.is_none() && cur_hf.is_none())
            } else {
                false
            };

            let when = if preserve_existing {
                r.when.clone().expect("checked Some")
            } else {
                let mut clauses = Vec::new();
                if let Some(any_kws) = cur_any {
                    clauses.push(dealsonar_rules::Condition::KwAny(any_kws));
                }
                if let Some(none_kws) = cur_none {
                    clauses.push(dealsonar_rules::Condition::KwNone(none_kws));
                }
                if let Some(hf) = cur_hf {
                    clauses.push(dealsonar_rules::Condition::HasField(hf));
                }
                if clauses.is_empty() {
                    r.when
                        .clone()
                        .unwrap_or(dealsonar_rules::Condition::LenGt(0))
                } else if clauses.len() == 1 {
                    clauses.remove(0)
                } else {
                    dealsonar_rules::Condition::All(clauses)
                }
            };

            dealsonar_rules::ClassifyRule {
                id: r.id.clone(),
                when,
                verdict: if r.verdict == "no_match" {
                    dealsonar_rules::RuleVerdict::NoMatch
                } else {
                    dealsonar_rules::RuleVerdict::Match
                },
                confidence: r.confidence,
                set: r.set.clone().unwrap_or_default(),
            }
        })
        .collect();

    let extract = dto
        .extract
        .iter()
        .map(|er| {
            let config = match er.extractor.as_str() {
                "vn_money" => dealsonar_rules::ExtractorConfig::VnMoney {
                    near: er.near.clone().unwrap_or_default(),
                    window: er.window.unwrap_or(dealsonar_rules::DEFAULT_MONEY_WINDOW),
                },
                "vn_phone" => dealsonar_rules::ExtractorConfig::VnPhone,
                "vn_area" => dealsonar_rules::ExtractorConfig::VnArea,
                "gazetteer" => dealsonar_rules::ExtractorConfig::Gazetteer {
                    dict: er.dict.clone().unwrap_or_else(|| "vn_admin".to_string()),
                    scope: er.scope.clone(),
                },
                "number" => dealsonar_rules::ExtractorConfig::Number {
                    units: er.units.clone().unwrap_or_default(),
                    prefixes: er.prefixes.clone().unwrap_or_default(),
                    multipliers: er.multipliers.clone().unwrap_or_default(),
                },
                "date_vi" => dealsonar_rules::ExtractorConfig::DateVi,
                "enum_kw" => dealsonar_rules::ExtractorConfig::EnumKw {
                    map: er.map.clone().unwrap_or_default(),
                    multi: er.multi.unwrap_or(false),
                },
                "regex" => dealsonar_rules::ExtractorConfig::Regex {
                    pattern: er.pattern.clone().unwrap_or_default(),
                    group: er.group.unwrap_or(0),
                    cast: er.cast.unwrap_or_default(),
                },
                _ => dealsonar_rules::ExtractorConfig::VnPhone,
            };
            dealsonar_rules::ExtractRule {
                field: er.field.clone(),
                config,
            }
        })
        .collect();

    dealsonar_rules::RulesetBody {
        dsl: dto.dsl,
        prefilter,
        classify,
        extract,
        thresholds: dealsonar_rules::Thresholds {
            accept: dto.thresholds.accept,
            reject: dto.thresholds.reject,
        },
    }
}

pub fn ruleset_record_to_dto(rec: &dealsonar_store::models::RulesetRecord) -> Ruleset {
    let dto_body = if let Ok(engine_body) =
        serde_json::from_value::<dealsonar_rules::RulesetBody>(rec.body.clone())
    {
        rules_to_dto_ruleset_body(&engine_body)
    } else {
        serde_json::from_value::<RulesetBody>(rec.body.clone()).unwrap_or(RulesetBody {
            dsl: 1,
            prefilter: RulesetPrefilter::default(),
            classify: Vec::new(),
            extract: Vec::new(),
            thresholds: RulesetThresholds::default(),
        })
    };

    let metrics = rec
        .metrics
        .as_ref()
        .and_then(|v| serde_json::from_value::<RulesetMetrics>(v.clone()).ok());

    Ruleset {
        id: rec.id.clone(),
        radar_version_id: rec.radar_version_id.clone(),
        revision: rec.revision,
        state: rec.state.clone(),
        origin: rec.origin.clone(),
        body: dto_body,
        metrics,
        created_at: rec.created_at,
        activated_at: rec.activated_at,
    }
}
