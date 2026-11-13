//! Real-time push events (`TauriEventMap` in `ipc.ts`).

use super::*;

// ============================================================================
// Real-time Push Events (`TauriEventMap` in `ipc.ts`)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewProgressEvent {
    pub preview_id: String,
    pub radar_id: String,
    pub status: PreviewStatus,
    pub evaluated_posts: usize,
    #[serde(default)]
    pub failed_posts: usize,
    pub total_posts: usize,
    pub new_items: Vec<PreviewItem>,
    pub warnings: Vec<PreviewWarning>,
    #[serde(default)]
    pub error: Option<String>,
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
    #[serde(rename = "lead:reminder")]
    LeadReminder(Lead),
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
            Self::LeadReminder(_) => "lead:reminder",
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
            Self::LeadNew(v) | Self::LeadUpdated(v) | Self::LeadReminder(v) => {
                serde_json::to_value(v).unwrap_or(Value::Null)
            }
            Self::PreviewProgress(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::HealthChanged(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::CrawlFinished(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            Self::JobFailed(v) => serde_json::to_value(v).unwrap_or(Value::Null),
        }
    }
}
