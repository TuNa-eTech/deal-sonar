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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherit_channels: Option<bool>,
    #[serde(default = "default_notify_mode")]
    pub mode: String,
    #[serde(default = "default_min_score")]
    pub min_score: f64,
    #[serde(default)]
    pub quiet_hours: Option<QuietHours>,
    /// How long a lead stays worth acting on, counted from the post time. `None` never expires.
    /// Lives with delivery settings (not the versioned definition) because it changes how a
    /// lead is delivered and queued, not what matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_ttl_hours: Option<u32>,
}

impl NotifyConfig {
    pub fn sends_to_channel(&self, channel_id: &str) -> bool {
        self.inherit_channels.unwrap_or(self.channel_ids.is_empty())
            || self.channel_ids.iter().any(|id| id == channel_id)
    }
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            channel_ids: Vec::new(),
            inherit_channels: None,
            mode: default_notify_mode(),
            min_score: default_min_score(),
            quiet_hours: None,
            lead_ttl_hours: None,
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
    /// Optional `all`/`any`/`not` expression (JSON) ANDed with `hard_filters`. Kept as raw JSON so a
    /// malformed value can never make the radar unreadable; `dealsonar-rules` parses and validates it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for MatchPolicy {
    fn default() -> Self {
        Self {
            want_intent: default_want_intent(),
            exclude_roles: vec!["peer".to_string()],
            hard_filters: Vec::new(),
            condition: None,
            extra: BTreeMap::new(),
        }
    }
}
