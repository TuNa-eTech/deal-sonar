//! Background Tokio Workers (`03-desktop.md §2–3`, `07-notifications-export.md §2–6`):
//! 1. Durable `jobs` queue runner (`evaluate_batch`, `notify_lead`, `flush_digest`, `compile_ruleset`, `audit_ruleset`, `purge_expired`).
//! 2. Outbound `outbox` delivery worker (`TelegramClient` + `WebhookClient` with retries, rate limits, 2h expiry, and `AuthRevoked` handling).
//! 3. Long-polling Telegram `getUpdates` bot worker (`/start`, `fb:<lead_id>:<label>`, `/pause`, `/resume`, `/status`).
//! 4. Health monitor (`health:changed` + 30m incident alerts), 5m `CrawlPlan` scheduler, and daily license/audit/retention maintenance.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Local, TimeZone, Timelike};
use dealsonar_notify::{
    escape_html, format_digest_html, webhook_channel_key, BotStatusSummary, DigestLeadItem,
    InlineKeyboardMarkup, PollUpdatesOptions, SendMessageRequest, SystemIncidentKind,
    TelegramDeliveryOutcome, TelegramIncomingEvent, WebhookDeliveryOutcome,
    WebhookLeadCreatedPayload, MAX_OUTBOX_QUEUE_AGE_MS, TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::{Body, Envelope};
use dealsonar_store::models::{
    now_ms, EnqueueOutboxInput, JobRecord, OutboxRecord, RecordFeedbackInput,
};
use dealsonar_store::ops::default_job_retry_delay_ms;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::dto::{CoreEvent, FacebookSessionState, FeedbackLabel, JobFailedEvent, QuietHours};
use crate::error::{CoreError, CoreResult};
use crate::license::enforce_plan_limits_on_store;
use crate::pipeline::{load_lead_dto, run_evaluate_batch_for_version, schedule_evaluate_batch_job};
use crate::preview_rules::{
    handle_negative_feedback_on_rule_eval, run_audit_ruleset, run_compile_ruleset_for_version,
};
use crate::state::{start_of_local_day_ms, CoreRuntime};

mod health;
mod jobs;
mod outbox;
mod telegram_poller;

pub use health::*;
pub use jobs::*;
pub use outbox::*;
pub use telegram_poller::*;

/// Spawn all four background loops and return their `JoinHandle`s for graceful `shutdown()`.
pub fn spawn_all_workers(
    rt: &Arc<CoreRuntime>,
    shutdown_rx: &watch::Receiver<bool>,
) -> Vec<JoinHandle<()>> {
    vec![
        spawn_jobs_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_outbox_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_telegram_poller_worker(Arc::clone(rt), shutdown_rx.clone()),
        spawn_health_and_maintenance_worker(Arc::clone(rt), shutdown_rx.clone()),
    ]
}
