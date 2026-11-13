//! Radars, versions, and rulesets.

use super::*;

// ============================================================================
// Radars, Versions & Rulesets
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarRecord {
    pub id: String,
    pub name: String,
    pub status: String,
    pub template_id: Option<String>,
    pub current_version: i32,
    pub notify: NotifyConfig,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarVersionRecord {
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
pub struct RadarWithVersion {
    pub radar: RadarRecord,
    pub current_version: RadarVersionRecord,
    pub candidate_version: Option<RadarVersionRecord>,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateRadarDraftInput {
    pub id: Option<String>,
    pub name: String,
    pub template_id: Option<String>,
    pub description: String,
    pub language_hint: Option<String>,
    pub user_profession: Option<String>,
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub match_policy: MatchPolicy,
    #[serde(default)]
    pub notify: NotifyConfig,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRadarInput {
    pub name: Option<String>,
    pub notify: Option<NotifyConfig>,
    pub source_ids: Option<Vec<String>>,
    pub description: Option<String>,
    pub language_hint: Option<Option<String>>,
    pub user_profession: Option<Option<String>>,
    pub fields: Option<Vec<FieldDef>>,
    pub match_policy: Option<MatchPolicy>,
    /// When `false` (default) on an `active` radar, definition edits create a candidate preview
    /// `radar_versions` row while keeping `radars.current_version` unchanged until confirmed.
    /// Set `true` to immediately switch `radars.current_version` to the new version.
    #[serde(default)]
    pub activate_immediately: bool,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarUpdateResult {
    pub radar: RadarWithVersion,
    pub version_created: Option<RadarVersionRecord>,
    pub pending_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarListItem {
    pub radar: RadarRecord,
    pub current_version: RadarVersionRecord,
    pub source_ids: Vec<String>,
    pub leads_24h: i64,
    pub evaluated_posts_total: i64,
    pub false_positive_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarFunnelStats {
    pub total_evaluated: i64,
    pub dedup_rejected: i64,
    pub prefilter_rejected: i64,
    pub rule_decided: i64,
    pub rule_matched: i64,
    pub ai_decided: i64,
    pub ai_matched: i64,
    pub postfilter_rejected: i64,
    pub pending_ai: i64,
    pub ai_failed: i64,
    pub leads_total: i64,
    pub leads_notified: i64,
    pub leads_weak_match: i64,
    pub false_positive_count: i64,
    pub false_positive_rate: f64,
    pub rule_handled_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewRulesetInput {
    pub id: Option<String>,
    pub radar_version_id: String,
    pub state: String,
    pub origin: String,
    pub body: serde_json::Value,
    pub metrics: Option<serde_json::Value>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetRecord {
    pub id: String,
    pub radar_version_id: String,
    pub revision: i32,
    pub state: String,
    pub origin: String,
    pub body: serde_json::Value,
    pub metrics: Option<serde_json::Value>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
}
