//! Shared domain contracts (02-radar-spec.md §3.1–3.3).

use super::*;

// ============================================================================
// Shared Domain Contracts (02-radar-spec.md §3.1–3.3)
// ============================================================================

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_confidence() -> f64 {
    1.0
}

pub(super) fn default_notify_mode() -> String {
    "instant".to_string()
}

pub(super) fn default_min_score() -> f64 {
    0.6
}

pub(super) fn default_want_intent() -> String {
    "any".to_string()
}

pub(super) fn default_when_missing() -> String {
    "pass".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Ai,
    Rule,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: serde_json::Value,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    pub source: FieldSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuietHours {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotifyConfig {
    #[serde(default)]
    pub channel_ids: Vec<String>,
    #[serde(default = "default_notify_mode")]
    pub mode: String,
    #[serde(default = "default_min_score")]
    pub min_score: f64,
    #[serde(default)]
    pub quiet_hours: Option<QuietHours>,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            channel_ids: Vec::new(),
            mode: default_notify_mode(),
            min_score: default_min_score(),
            quiet_hours: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardFilter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: serde_json::Value,
    #[serde(default = "default_when_missing")]
    pub when_missing: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchPolicy {
    #[serde(default = "default_want_intent")]
    pub want_intent: String,
    #[serde(default)]
    pub exclude_roles: Vec<String>,
    #[serde(default)]
    pub hard_filters: Vec<HardFilter>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for MatchPolicy {
    fn default() -> Self {
        Self {
            want_intent: default_want_intent(),
            exclude_roles: vec!["peer".to_string()],
            hard_filters: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}
