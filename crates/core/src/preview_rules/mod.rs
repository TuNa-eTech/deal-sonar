//! Streaming Radar Preview (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`) and
//! Declarative Ruleset Lifecycle (`compile_ruleset`, `audit_ruleset`, `ruleset_save_user`,
//! `05-pipeline-rules.md §6.4`).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use dealsonar_ai_bridge::{
    AuthorRole as AiAuthorRole, BatchConfig, CompileRulesInput, DetectedIntent,
    LabeledSample as AiLabeledSample, PostEvalOutcome, PostPromptInput,
};
use dealsonar_protocol::{Body, CrawlReason, Envelope, SourceRef};
use dealsonar_rules::{
    evaluate_gate_with_fields, normalize_text, validate_ruleset,
    LabeledSample as GateLabeledSample, RulesetBody as EngineRulesetBody,
};
use dealsonar_store::models::{
    new_ulid, now_ms, EvaluationRecord, NewRulesetInput, PendingAiEvaluationItem,
    RadarVersionRecord, RecordAiCallInput, RulesetRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::dto::{
    dto_ruleset_body_to_rules, extracted_field_ai_to_rules, extracted_field_from_store,
    extracted_field_store_to_rules, field_def_store_to_rules, field_def_to_store,
    match_policy_to_store, ruleset_record_to_dto,
};
use crate::dto::{
    AuthorRole, CoreEvent, DecidedBy, PostIntent, PreviewItem, PreviewProgressEvent,
    PreviewRunState, PreviewStartInput, PreviewStatus, PreviewWarning, PreviewWarningCode, Ruleset,
    RulesetBody as DtoRulesetBody, RulesetMetrics,
};
use crate::error::{CoreError, CoreResult};
use crate::pipeline::{
    build_radar_prompt_context, evaluate_post_for_radar_sync, finalize_candidate_evaluation,
    CandidateDecision, EvalMode,
};
use crate::state::{CoreRuntime, InflightAiGuard};

mod preview;
mod rulesets;

pub use preview::*;
pub use rulesets::*;
