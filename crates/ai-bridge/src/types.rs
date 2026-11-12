use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Identifier of an AI provider implementation (`06-ai-bridge.md §2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    ClaudeCli,
    CodexCli,
    AgyCli,
    Mock,
}

impl ProviderId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::ClaudeCli => "claude_cli",
            ProviderId::CodexCli => "codex_cli",
            ProviderId::AgyCli => "agy_cli",
            ProviderId::Mock => "mock",
        }
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ProviderId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude_cli" | "claude-cli" => Ok(ProviderId::ClaudeCli),
            "codex" | "codex_cli" | "codex-cli" => Ok(ProviderId::CodexCli),
            "agy" | "agy_cli" | "agy-cli" | "antigravity" => Ok(ProviderId::AgyCli),
            "mock" => Ok(ProviderId::Mock),
            other => Err(format!(
                "unknown provider '{other}' (expected claude_cli, codex_cli, agy_cli, or mock)"
            )),
        }
    }
}

/// Abstract model capability tier (`06-ai-bridge.md §2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    /// High-volume post evaluation and extraction (`judge_extract`).
    Fast,
    /// Reasoning-heavy tasks (`suggest_fields`, `compile_rules`).
    Smart,
}

impl FromStr for ModelTier {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "fast" => Ok(ModelTier::Fast),
            "smart" => Ok(ModelTier::Smart),
            other => Err(format!(
                "unknown model tier '{other}' (expected fast or smart)"
            )),
        }
    }
}

/// Per-provider concrete model names for `Fast` and `Smart` tiers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTierModels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart: Option<String>,
}

/// Configurable mapping from `(ProviderId, ModelTier)` to concrete CLI `--model` names.
///
/// Stored in `settings` so users or updates can change model names without touching code.
/// When an entry is `None` (or empty), the CLI adapter omits `--model` and uses the CLI default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTierMap {
    #[serde(default)]
    pub providers: BTreeMap<ProviderId, ProviderTierModels>,
}

impl ModelTierMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recommended starting presets per provider (`06-ai-bridge.md §2`).
    pub fn recommended_defaults() -> Self {
        let mut providers = BTreeMap::new();
        providers.insert(
            ProviderId::ClaudeCli,
            ProviderTierModels {
                fast: Some("haiku".to_string()),
                smart: Some("sonnet".to_string()),
            },
        );
        providers.insert(
            ProviderId::CodexCli,
            ProviderTierModels {
                fast: Some("codex-mini-latest".to_string()),
                smart: Some("gpt-5-codex".to_string()),
            },
        );
        providers.insert(
            ProviderId::AgyCli,
            ProviderTierModels {
                fast: Some("gemini-2.5-flash".to_string()),
                smart: Some("gemini-2.5-pro".to_string()),
            },
        );
        Self { providers }
    }

    pub fn set(&mut self, provider: ProviderId, tier: ModelTier, model: Option<String>) {
        let cleaned = model.and_then(|m| {
            let trimmed = m.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        let entry = self.providers.entry(provider).or_default();
        match tier {
            ModelTier::Fast => entry.fast = cleaned,
            ModelTier::Smart => entry.smart = cleaned,
        }
    }

    pub fn resolve(&self, provider: ProviderId, tier: ModelTier) -> Option<&str> {
        let entry = self.providers.get(&provider)?;
        let model = match tier {
            ModelTier::Fast => entry.fast.as_deref(),
            ModelTier::Smart => entry.smart.as_deref(),
        }?;
        let trimmed = model.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }
}

/// AI task kind (`06-ai-bridge.md §2, §5`, `04-data-model.md §2.6`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    SuggestFields,
    JudgeExtract,
    CompileRules,
}

impl TaskKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskKind::SuggestFields => "suggest_fields",
            TaskKind::JudgeExtract => "judge_extract",
            TaskKind::CompileRules => "compile_rules",
        }
    }
}

impl fmt::Display for TaskKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Input request to an `AiProvider` (`06-ai-bridge.md §2`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRequest {
    pub task: TaskKind,
    pub system: String,
    pub prompt: String,
    pub schema: serde_json::Value,
    pub tier: ModelTier,
    pub timeout: Duration,
}

/// Token and cost usage reported by a CLI call (`06-ai-bridge.md §2`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// Validated response from an `AiProvider` (`06-ai-bridge.md §2`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    pub output: serde_json::Value,
    pub usage: Option<Usage>,
    pub model: Option<String>,
    pub duration: Duration,
}

/// Depth of `probe()` checks (`06-ai-bridge.md §3.5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeMode {
    /// Locate binary + verify `--version` and mandatory security flags in `--help` only.
    Quick,
    /// Quick checks + execute minimal `{"ok": boolean}` smoke completion to verify auth & quota.
    Full,
}

/// A model option discovered from the local CLI installation or built-in provider catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiModelOption {
    /// Concrete model identifier or alias passed to `--model <id>`.
    pub id: String,
    /// Human-friendly display label for UI selectors.
    pub label: String,
    /// Suggested capability tier (`fast` or `smart`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_tier: Option<ModelTier>,
    /// Origin of this model option (`"local_cli"` or `"builtin"`).
    #[serde(default = "default_model_source")]
    pub source: String,
}

fn default_model_source() -> String {
    "builtin".to_string()
}

/// Result of probing an `AiProvider` (`06-ai-bridge.md §2, §3.5`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProbeResult {
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub flags_supported: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub available_models: Vec<AiModelOption>,
}

impl ProbeResult {
    /// True when the CLI is installed, supports all mandatory security flags,
    /// is authenticated, and had no probe error.
    pub fn is_healthy(&self) -> bool {
        self.installed && self.flags_supported && self.authenticated && self.error.is_none()
    }
}

/// Classified error returned by AI bridge providers (`06-ai-bridge.md §2, §6`).
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum AiError {
    #[error("CLI AI chưa được cài đặt trên máy")]
    NotInstalled,

    #[error("CLI AI chưa đăng nhập hoặc phiên đăng nhập đã hết hạn")]
    NotAuthenticated,

    #[error("Đã chạm giới hạn hạn mức AI (thử lại sau: {retry_after:?})")]
    RateLimited { retry_after: Option<Duration> },

    #[error("Lời gọi AI quá thời gian chờ")]
    Timeout,

    #[error("Đầu ra AI không hợp lệ theo schema: {0}")]
    InvalidOutput(String),

    #[error("Mô hình từ chối xử lý yêu cầu: {0}")]
    Refused(String),

    #[error("Phiên bản CLI không hỗ trợ các cờ bảo mật bắt buộc: {0}")]
    SecurityFlagsUnsupported(String),

    #[error("Tiến trình CLI kết thúc với mã lỗi {code}: {stderr}")]
    Process { code: i32, stderr: String },
}

impl AiError {
    /// Maps an `AiError` to the `ai_calls.status` value in `04-data-model.md §2.6`.
    pub fn call_status(&self) -> AiCallStatus {
        match self {
            AiError::InvalidOutput(_) => AiCallStatus::InvalidOutput,
            AiError::Timeout => AiCallStatus::Timeout,
            AiError::RateLimited { .. } => AiCallStatus::RateLimited,
            AiError::NotInstalled
            | AiError::NotAuthenticated
            | AiError::Refused(_)
            | AiError::SecurityFlagsUnsupported(_)
            | AiError::Process { .. } => AiCallStatus::Error,
        }
    }

    /// True if this failure may be caused by malformed model output or a single bad post in a batch.
    pub fn is_bisectable_batch_failure(&self) -> bool {
        matches!(self, AiError::InvalidOutput(_) | AiError::Refused(_))
    }
}

/// Common async trait implemented by all AI providers (`06-ai-bridge.md §2`).
#[async_trait]
pub trait AiProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    async fn probe(&self) -> ProbeResult;
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError>;
}

// ============================================================================
// Shared Domain Contracts (`02-radar-spec.md §2–3`, `04-data-model.md §2.6`)
// ============================================================================

/// All 11 supported field types (`02-radar-spec.md §3.2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl FieldType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FieldType::Text => "text",
            FieldType::Number => "number",
            FieldType::Money => "money",
            FieldType::Phone => "phone",
            FieldType::Location => "location",
            FieldType::Enum => "enum",
            FieldType::MultiEnum => "multi_enum",
            FieldType::Boolean => "boolean",
            FieldType::Date => "date",
            FieldType::Range => "range",
            FieldType::Url => "url",
        }
    }
}

/// Radar field definition (`02-radar-spec.md §3.1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
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

fn default_true() -> bool {
    true
}

/// Provenance of an extracted field value (`02-radar-spec.md §3.3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Ai,
    Rule,
    User,
}

/// Canonical extracted field stored in `evaluations.fields` and `leads.fields` (`02-radar-spec.md §3.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: serde_json::Value,
    pub raw: String,
    pub confidence: f64,
    pub source: FieldSource,
}

/// Desired post intent in radar `match_policy` (`02-radar-spec.md §2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WantIntent {
    Demand,
    Supply,
    Any,
}

impl WantIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            WantIntent::Demand => "demand",
            WantIntent::Supply => "supply",
            WantIntent::Any => "any",
        }
    }
}

/// Classified post intent (`02-radar-spec.md §3.4`, `06-ai-bridge.md §5.2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedIntent {
    Demand,
    Supply,
    Other,
}

/// Classified author role (`02-radar-spec.md §3.4`, `06-ai-bridge.md §5.2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorRole {
    EndUser,
    Peer,
    Unknown,
}

/// Hard filter condition in `match_policy` (`02-radar-spec.md §2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardFilter {
    pub field: String,
    pub op: String,
    pub value: serde_json::Value,
    #[serde(default = "default_when_missing")]
    pub when_missing: String,
}

fn default_when_missing() -> String {
    "pass".to_string()
}

// ============================================================================
// Task Input & Output DTOs (`06-ai-bridge.md §5`)
// ============================================================================

/// Input to `suggest_fields` (`06-ai-bridge.md §5.1`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestFieldsInput {
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
    #[serde(default)]
    pub closest_template: Option<serde_json::Value>,
}

/// Field item proposed by `suggest_fields` (`06-ai-bridge.md §5.1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestedField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
    pub description: String,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

impl SuggestedField {
    pub fn into_field_def(self, order: i32) -> FieldDef {
        FieldDef {
            key: self.key,
            label: self.label,
            r#type: self.r#type,
            description: self.description,
            required: self.required,
            options: self.options,
            show_in_alert: true,
            order,
        }
    }
}

/// Coarse day-1 prefilter keywords suggested by AI (`06-ai-bridge.md §5.1`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PrefilterHint {
    #[serde(default)]
    pub any: Vec<String>,
    #[serde(default)]
    pub none: Vec<String>,
}

/// Validated output of `suggest_fields` (`06-ai-bridge.md §5.1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestFieldsOutput {
    pub suggested_name: String,
    pub want_intent: WantIntent,
    pub fields: Vec<SuggestedField>,
    #[serde(default)]
    pub hard_filters: Vec<HardFilter>,
    #[serde(default)]
    pub clarifying_questions: Vec<String>,
    #[serde(default)]
    pub prefilter_hint: Option<PrefilterHint>,
}

/// User feedback example included in `judge_extract` prompts (`06-ai-bridge.md §5.2`, `02-radar-spec.md §6`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedbackExample {
    pub is_positive: bool,
    pub label: String,
    pub post_text: String,
    #[serde(default)]
    pub author_role: Option<AuthorRole>,
    #[serde(default)]
    pub corrected_fields: Option<BTreeMap<String, serde_json::Value>>,
}

/// Radar version context for `judge_extract` and `compile_rules` (`06-ai-bridge.md §5.2–5.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarPromptContext {
    pub radar_version_id: String,
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
    pub want_intent: WantIntent,
    #[serde(default)]
    pub exclude_roles: Vec<AuthorRole>,
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub feedback_examples: Vec<FeedbackExample>,
}

/// Privacy-safe post input for `judge_extract` (`06-ai-bridge.md §5.2, §6`).
///
/// Deliberately excludes `author.external_id`, `permalink`, and out-of-post phone metadata
/// so third-party identifiers never leave the machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostPromptInput {
    /// Local post ID (kept inside Rust to map results back; NEVER sent to the CLI).
    pub post_id: String,
    /// Numeric reference (`ref`) inside the prompt batch.
    pub r#ref: u32,
    /// Display name of the Facebook group (`source.name`).
    pub group_name: String,
    /// Display name of the post author ONLY (never external_id).
    #[serde(default)]
    pub author_name: Option<String>,
    /// Post creation timestamp in Unix ms, if known.
    #[serde(default)]
    pub created_at_ms: Option<i64>,
    /// Normalized post text (`text_norm` or `text`).
    pub text: String,
    /// Optional values already extracted by T4 ruleset as hints (`05-pipeline-rules.md §6.2`).
    #[serde(default)]
    pub rule_hints: Option<BTreeMap<String, serde_json::Value>>,
}

impl PostPromptInput {
    /// Privacy-enforcing constructor that accepts raw metadata and explicitly drops
    /// `author_external_id` and `permalink` (`06-ai-bridge.md §6`).
    #[allow(clippy::too_many_arguments)]
    pub fn sanitized(
        post_id: impl Into<String>,
        r#ref: u32,
        group_name: impl Into<String>,
        author_name: Option<String>,
        _author_external_id_ignored: Option<&str>,
        _permalink_ignored: Option<&str>,
        created_at_ms: Option<i64>,
        text: impl Into<String>,
        rule_hints: Option<BTreeMap<String, serde_json::Value>>,
    ) -> Self {
        Self {
            post_id: post_id.into(),
            r#ref,
            group_name: group_name.into(),
            author_name,
            created_at_ms,
            text: text.into(),
            rule_hints,
        }
    }
}

/// Raw AI field entry in `judge_extract` response (`06-ai-bridge.md §5.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiFieldCandidate {
    pub raw: Option<String>,
    pub value: serde_json::Value,
    pub confidence: f64,
}

impl AiFieldCandidate {
    /// Converts a non-null AI candidate into a canonical `ExtractedField` (`source: "ai"`).
    /// Returns `None` if either `raw` (empty/null) or `value` (`null`) is missing.
    pub fn into_extracted_field(self) -> Option<ExtractedField> {
        let raw = self.raw?;
        if raw.trim().is_empty() || self.value.is_null() {
            return None;
        }
        Some(ExtractedField {
            value: self.value,
            raw,
            confidence: self.confidence.clamp(0.0, 1.0),
            source: FieldSource::Ai,
        })
    }
}

/// Single post judgment in `judge_extract` response (`06-ai-bridge.md §5.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeItemResult {
    #[serde(rename = "ref")]
    pub r#ref: u32,
    #[serde(rename = "match")]
    pub is_match: bool,
    pub score: f64,
    pub intent: DetectedIntent,
    pub author_role: AuthorRole,
    #[serde(default)]
    pub is_spam: bool,
    pub summary: String,
    pub reason: String,
    pub fields: BTreeMap<String, AiFieldCandidate>,
}

impl JudgeItemResult {
    /// Converts all non-null AI field candidates into canonical `ExtractedField` entries.
    pub fn extracted_fields(&self) -> BTreeMap<String, ExtractedField> {
        self.fields
            .iter()
            .filter_map(|(k, v)| v.clone().into_extracted_field().map(|ef| (k.clone(), ef)))
            .collect()
    }
}

/// Top-level JSON envelope returned by `judge_extract` (`06-ai-bridge.md §5.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeExtractOutput {
    pub results: Vec<JudgeItemResult>,
}

/// Labeled post sample used to compile rulesets (`06-ai-bridge.md §5.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabeledSample {
    pub post_text: String,
    pub is_match: bool,
    #[serde(default)]
    pub author_role: Option<AuthorRole>,
    #[serde(default)]
    pub expected_fields: BTreeMap<String, serde_json::Value>,
}

/// Input to `compile_rules` (`06-ai-bridge.md §5.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompileRulesInput {
    pub radar: RadarPromptContext,
    pub labeled_samples: Vec<LabeledSample>,
    #[serde(default)]
    pub current_ruleset: Option<serde_json::Value>,
    #[serde(default)]
    pub current_ruleset_errors: Vec<String>,
}

/// Status string matching `ai_calls.status` in `04-data-model.md §2.6`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiCallStatus {
    Ok,
    InvalidOutput,
    Timeout,
    RateLimited,
    Error,
}

impl AiCallStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AiCallStatus::Ok => "ok",
            AiCallStatus::InvalidOutput => "invalid_output",
            AiCallStatus::Timeout => "timeout",
            AiCallStatus::RateLimited => "rate_limited",
            AiCallStatus::Error => "error",
        }
    }
}

/// Telemetry record for a single underlying provider invocation (`04-data-model.md §2.6`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiCallRecord {
    pub provider: ProviderId,
    pub model: Option<String>,
    pub task: TaskKind,
    pub radar_version_id: Option<String>,
    pub item_count: usize,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub status: AiCallStatus,
    pub error: Option<String>,
}
