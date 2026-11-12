//! Hardened CLI AI Bridge for DealSonar (`docs/specs/06-ai-bridge.md`).
//!
//! Provides:
//! - Common `AiProvider` trait & types (`ClaudeCliProvider`, `CodexCliProvider`, `AgyCliProvider`, `MockAiProvider`).
//! - Shell-free `tokio::process::Command` execution with `stdin`-only prompts, empty `ai-workdir`,
//!   expanded GUI `PATH`, process-group `SIGKILL` timeouts, and mandatory security-flag verification.
//! - JSON extraction, recursive JSON Schema validation, task semantic validation, 1x retry,
//!   and recursive batch bisection (`AiBridge::judge_extract_batch`) isolating poison posts.
//! - Anti-injection boundary nonces, privacy stripping, and dynamic schema caching per `radar_version_id`.
//! - Offline quality evaluation harness (`eval` module & `eval` binary).

pub mod adapters;
pub mod bridge;
pub mod classify;
pub mod eval;
pub mod prompts;
pub mod schema;
pub mod subprocess;
pub mod types;

pub use adapters::agy::AgyCliProvider;
pub use adapters::claude::ClaudeCliProvider;
pub use adapters::codex::CodexCliProvider;
pub use adapters::mock::MockAiProvider;
pub use adapters::{
    discover_agy_models, discover_claude_models, discover_codex_models, discover_mock_models,
    parse_agy_models_stdout, recommended_models_for_provider, CliAdapterConfig,
};
pub use bridge::{AiBridge, JudgeBatchReport, PostEvalOutcome, TaskResult};
pub use classify::{classify_cli_failure, parse_retry_after};
pub use prompts::{
    boundary_close_tag, boundary_open_tag, build_compile_rules_request,
    build_judge_extract_request, build_suggest_fields_request, generate_boundary_nonce,
    select_balanced_examples, split_posts_into_batches, truncate_post_text, verify_raw_in_post,
    BatchConfig,
};
pub use schema::{
    build_judge_extract_schema, compile_rules_schema, extract_json_value, probe_smoke_schema,
    suggest_fields_schema, validate_compile_rules_output, validate_json_schema,
    validate_judge_extract_output, validate_safe_regex, validate_suggest_fields_output,
    SchemaCache,
};
pub use subprocess::{
    ensure_empty_workdir, expanded_path_env, is_executable_file, resolve_binary_in_path,
    run_cli_subprocess, ScopedTempDir, SubprocessOutput,
};
pub use types::{
    AiCallRecord, AiCallStatus, AiError, AiFieldCandidate, AiModelOption, AiProvider, AiRequest,
    AiResponse, AuthorRole, CompileRulesInput, DetectedIntent, ExtractedField, FeedbackExample,
    FieldDef, FieldSource, FieldType, HardFilter, JudgeExtractOutput, JudgeItemResult,
    LabeledSample, ModelTier, ModelTierMap, PostPromptInput, PrefilterHint, ProbeMode, ProbeResult,
    ProviderId, ProviderTierModels, RadarPromptContext, SuggestFieldsInput, SuggestFieldsOutput,
    SuggestedField, TaskKind, Usage, WantIntent,
};
