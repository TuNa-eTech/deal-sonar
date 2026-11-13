//! Jobs, outbox, channels, AI calls, and lifecycle records.

use super::*;

// ============================================================================
// Jobs, Outbox, Channels, AI Calls, Lifecycle
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub kind: String,
    pub dedup_key: Option<String>,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub run_at: i64,
    pub locked_at: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: serde_json::Value,
    pub state: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnqueueOutboxInput {
    pub id: Option<String>,
    pub channel_id: String,
    pub lead_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub next_try_at: i64,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutboxRecord {
    pub id: String,
    pub channel_id: String,
    pub lead_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub next_try_at: i64,
    pub sent_at: Option<i64>,
    pub remote_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordAiCallInput {
    pub id: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub task: String,
    pub radar_version_id: Option<String>,
    pub item_count: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
    pub status: String,
    pub error: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiCallRecord {
    pub id: String,
    pub provider: String,
    pub model: Option<String>,
    pub task: String,
    pub radar_version_id: Option<String>,
    pub item_count: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAiUsage {
    pub day_start_ms: i64,
    pub date: String,
    pub calls: i64,
    pub items: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub evaluated_posts: i64,
    pub ai_escalated_posts: i64,
    pub ai_escalation_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageReport {
    pub days: Vec<DailyAiUsage>,
    pub total_calls: i64,
    pub total_items: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub overall_ai_escalation_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PurgeReport {
    pub posts_purged: usize,
    pub evaluations_scrubbed: usize,
    pub crawl_runs_deleted: usize,
    pub ai_calls_deleted: usize,
    pub jobs_deleted: usize,
    pub outbox_deleted: usize,
    pub authors_deleted: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaMigrationRecord {
    pub version: i32,
    pub name: String,
    pub applied_at: i64,
}
