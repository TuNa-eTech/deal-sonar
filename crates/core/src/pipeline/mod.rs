//! Full T0–T7 Post Ingestion, Ruleset/AI Evaluation, Postfilter, and Lead Creation Pipeline
//! (`05-pipeline-rules.md §2–9`, `06-ai-bridge.md`, `07-notifications-export.md §2–4`).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use chrono::{Local, TimeZone, Timelike};
use dealsonar_ai_bridge::{
    AiError, AuthorRole as AiAuthorRole, BatchConfig, DetectedIntent, FeedbackExample,
    PostEvalOutcome, PostPromptInput, RadarPromptContext, WantIntent as AiWantIntent,
};
use dealsonar_notify::{
    evaluate_notify_policy, format_lead_alert, LeadAlertInput, NotifyDecision, NotifyPolicyCheck,
    QuietHours as NotifyQuietHours, SendMessageRequest, SystemIncidentKind,
    WebhookLeadCreatedPayload, TELEGRAM_BOT_TOKEN_KEY,
};
use dealsonar_protocol::RawPost;
use dealsonar_rules::{
    classify_lead_tier, compile_ruleset_unchecked, evaluate_hard_filters, extract_vn_phone,
    normalize_text, postprocess_fields, run_basic_prefilter, BasicPrefilterInput, LeadDisposition,
    NormalizedText, RulesetBody as EngineRulesetBody, RulesetOutcome, DEDUP_WINDOW_MS,
    NEAR_DUP_MAX_HAMMING, NEAR_DUP_MIN_CHARS,
};
use dealsonar_store::models::{
    extract_e164_phones_light, now_ms, AuthorInput, CreateLeadInput, EnqueueOutboxInput,
    EvaluationDoneInput, EvaluationRecord, EvaluationUpsertInput,
    ExtractedField as StoreExtractedField, NewPost, PostRecord, RadarVersionRecord,
    RadarWithVersion, RecordAiCallInput, SourceRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dto::{
    extracted_field_ai_to_rules, extracted_field_from_store, extracted_field_rules_to_store,
    extracted_field_store_to_rules, extracted_fields_store_to_notify, field_def_store_to_ai,
    field_def_store_to_notify, field_def_store_to_rules, hard_filters_store_to_rules,
};
use crate::dto::{
    AlsoSeenSource, AuthorRole, CoreEvent, DecidedBy, FeedbackLabel, Lead, LeadStatus, PostIntent,
    RulesetMetrics,
};
use crate::error::{CoreError, CoreResult};
use crate::state::{CoreRuntime, InflightAiGuard, OsNotification};

mod ai_batch;
mod evaluate;
mod finalize;
mod ingest;
mod notify;
mod shadow;

pub use ai_batch::*;
pub use evaluate::*;
pub use finalize::*;
pub use ingest::*;
use notify::*;
pub use shadow::*;

/// Pipeline execution mode for a single `(post, radar_version)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalMode {
    /// Normal live ingestion (`is_preview = false`, notifications enabled).
    Live { repost_after_72h: bool },
    /// Silent 24h backfill on `paused -> active` (`is_preview = false`, notifications suppressed).
    BackfillSilent,
    /// Interactive preview (`is_preview = true`, T2 skipped, no leads or notifications).
    Preview,
}

impl EvalMode {
    pub fn is_preview(&self) -> bool {
        matches!(self, Self::Preview)
    }

    pub fn is_silent_or_preview(&self) -> bool {
        matches!(self, Self::BackfillSilent | Self::Preview)
    }

    pub fn repost_after_72h(&self) -> bool {
        matches!(
            self,
            Self::Live {
                repost_after_72h: true
            }
        )
    }
}

/// Result of ingesting a single [`RawPost`] through T0–T4.
#[derive(Debug, Clone)]
pub enum IngestPostOutcome {
    /// Post `(platform, post_id)` was already stored; skipped idempotently.
    DuplicateStored(PostRecord),
    /// Newly stored post attached to an existing `< 72h` duplicate cluster (`also_seen_in` updated).
    ClusterDuplicate(PostRecord),
    /// Newly stored post processed synchronously through T3–T4 across subscribed active radars.
    Processed(PostRecord),
}

impl IngestPostOutcome {
    pub fn was_inserted(&self) -> bool {
        !matches!(self, Self::DuplicateStored(_))
    }
}

/// Persistent shadow evaluation tracker stored in `settings` (`runtime.shadow.<ruleset_id>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShadowTrackerState {
    pub total_evaluated: usize,
    pub rule_self_handled: usize,
    pub definite_match_total: usize,
    pub definite_match_correct: usize,
    pub positive_truth_total: usize,
    pub positive_falsely_rejected: usize,
    /// Pending predictions (`post_id -> "match" | "no_match" | "uncertain"`) awaiting T5 AI truth.
    #[serde(default)]
    pub pending_predictions: HashMap<String, String>,
}

/// Candidate match/no-match judgment entering T6 Postfilter (from either T4 Ruleset or T5 AI).
#[derive(Debug, Clone)]
pub struct CandidateDecision {
    pub decided_by: &'static str, // "rule" | "ai"
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub is_match: bool,
    pub raw_score: f64,
    pub intent: PostIntent,
    pub author_role: AuthorRole,
    pub is_spam: bool,
    pub summary: String,
    pub reason: String,
    pub candidate_fields: BTreeMap<String, dealsonar_rules::ExtractedField>,
}
