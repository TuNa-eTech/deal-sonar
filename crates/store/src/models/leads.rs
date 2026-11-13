//! Evaluations, leads, feedback, and dynamic queries.

use super::*;

// ============================================================================
// Evaluations, Leads, Feedback & Dynamic Query
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationUpsertInput {
    pub id: Option<String>,
    pub post_id: String,
    pub radar_version_id: String,
    pub state: String,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    #[serde(default)]
    pub is_preview: bool,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationDoneInput {
    pub decided_by: String,
    pub verdict: String,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub decided_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRecord {
    pub id: String,
    pub post_id: String,
    pub radar_version_id: String,
    pub state: String,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub is_preview: bool,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingAiEvaluationItem {
    pub evaluation: EvaluationRecord,
    pub post: PostRecord,
    pub source_name: String,
    pub author_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingAiGroup {
    pub radar_version_id: String,
    pub is_preview: bool,
    pub count: usize,
    pub oldest_created_at: i64,
    pub items: Vec<PendingAiEvaluationItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedEvaluationItem {
    pub evaluation_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub post_text: Option<String>,
    pub permalink: String,
    pub source_id: String,
    pub source_name: String,
    pub author_name: Option<String>,
    pub decided_by: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub reason: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateLeadInput {
    pub id: Option<String>,
    pub radar_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    #[serde(default = "default_lead_status")]
    pub status: String,
    pub score: f64,
    pub summary: String,
    pub fields: BTreeMap<String, ExtractedField>,
    pub also_seen_in: Option<Vec<AlsoSeenInEntry>>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Option<Vec<String>>,
    pub now_ms: i64,
}

pub(super) fn default_lead_status() -> String {
    "new".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadRecord {
    pub id: String,
    pub radar_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    pub status: String,
    pub read_at: Option<i64>,
    pub score: f64,
    pub summary: String,
    pub fields: BTreeMap<String, ExtractedField>,
    pub also_seen_in: Vec<AlsoSeenInEntry>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEventRecord {
    pub id: String,
    pub lead_id: String,
    pub kind: String,
    pub data: Option<serde_json::Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEvaluationInfo {
    pub id: String,
    pub radar_version: i32,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub reason: Option<String>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadDetail {
    pub lead: LeadRecord,
    pub radar_name: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub post_text: Option<String>,
    pub post_text_norm: Option<String>,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub post_captured_at: i64,
    pub evaluation: LeadEvaluationInfo,
    pub events: Vec<LeadEventRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListItem {
    pub lead: LeadRecord,
    pub radar_name: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub post_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFieldFilter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadSort {
    pub by: String,
    #[serde(default = "default_sort_desc")]
    pub dir: SortDir,
}

pub(super) fn default_sort_desc() -> SortDir {
    SortDir::Desc
}

impl Default for LeadSort {
    fn default() -> Self {
        Self {
            by: "created_at".to_string(),
            dir: SortDir::Desc,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LeadListQuery {
    pub unread_only: Option<bool>,
    pub follow_up_before: Option<i64>,
    pub exclude_weak: Option<bool>,
    pub radar_id: Option<String>,
    pub status: Option<Vec<String>>,
    pub since: Option<i64>,
    pub min_score: Option<f64>,
    #[serde(default)]
    pub filters: Vec<LeadFieldFilter>,
    pub search: Option<String>,
    pub sort: Option<LeadSort>,
    #[serde(default = "default_lead_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}

pub(super) fn default_lead_limit() -> usize {
    50
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListPage {
    pub total: usize,
    pub items: Vec<LeadListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordFeedbackInput {
    pub evaluation_id: String,
    pub label: String,
    pub corrected_fields: Option<BTreeMap<String, ExtractedField>>,
    pub post_text: Option<String>,
    pub origin: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedbackRecord {
    pub expected_match: bool,
    pub id: String,
    pub evaluation_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub label: String,
    pub corrected_fields: Option<BTreeMap<String, ExtractedField>>,
    pub post_text: String,
    pub origin: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabeledSampleOrigin {
    Feedback(String),
    AiHighConfidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabeledSample {
    pub post_id: String,
    pub evaluation_id: String,
    pub post_text: String,
    pub text_fold: Option<String>,
    pub is_match: bool,
    pub author_role: Option<String>,
    pub score: Option<f64>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub origin: LabeledSampleOrigin,
}
