//! Core enums and radar schema (`ipc.ts`).

use super::*;

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

pub(super) fn default_true() -> bool {
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

pub(super) fn default_min_score() -> f64 {
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
