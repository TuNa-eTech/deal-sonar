//! Ruleset DSL types, outcomes, and validation errors.

use super::*;

pub(super) const fn default_dsl_version() -> u32 {
    SUPPORTED_DSL_VERSION
}

pub(super) const fn default_threshold() -> f64 {
    0.9
}

/// Top-level declarative ruleset JSON (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetBody {
    #[serde(default = "default_dsl_version")]
    pub dsl: u32,
    #[serde(default)]
    pub prefilter: Option<PrefilterSpec>,
    #[serde(default)]
    pub classify: Vec<ClassifyRule>,
    #[serde(default)]
    pub extract: Vec<ExtractRule>,
    #[serde(default)]
    pub thresholds: Thresholds,
}

/// Ruleset-level prefilter (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefilterSpec {
    /// Post must match at least one item (when non-empty). Prefix `"re:"` denotes regex on `text_fold`.
    #[serde(default)]
    pub any: Vec<String>,
    /// Post must match none of these items. Prefix `"re:"` denotes regex on `text_fold`.
    #[serde(default)]
    pub none: Vec<String>,
    /// Minimum character length of `text_norm`.
    #[serde(default)]
    pub min_len: Option<usize>,
}

/// Ordered classification rule (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassifyRule {
    pub id: String,
    pub when: Condition,
    pub verdict: RuleVerdict,
    pub confidence: f64,
    #[serde(default)]
    pub set: BTreeMap<String, Value>,
}

/// Verdict emitted by a matching [`ClassifyRule`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleVerdict {
    Match,
    NoMatch,
}

/// Field comparison predicate inside `Condition::FieldCmp`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldCmp {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Value,
}

/// Recursive boolean condition tree (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    All(Vec<Condition>),
    Any(Vec<Condition>),
    Not(Box<Condition>),
    KwAny(Vec<String>),
    KwNone(Vec<String>),
    Re(String),
    HasField(String),
    LenLt(usize),
    LenGt(usize),
    LangIn(Vec<String>),
    FieldCmp(FieldCmp),
}

/// Field extraction rule binding a radar field key to a built-in extractor (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractRule {
    pub field: String,
    #[serde(flatten)]
    pub config: ExtractorConfig,
}

/// Decision confidence thresholds (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thresholds {
    #[serde(default = "default_threshold")]
    pub accept: f64,
    #[serde(default = "default_threshold")]
    pub reject: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            accept: 0.9,
            reject: 0.9,
        }
    }
}

/// Outcome of evaluating a [`RulesetBody`] on a post at T3/T4 (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RulesetOutcome {
    /// Rejected cheaply by `ruleset.prefilter`.
    PrefilterReject,
    /// `verdict = match`, `confidence >= thresholds.accept`, and all required fields extracted.
    DefiniteMatch {
        rule_id: String,
        confidence: f64,
        fields: ExtractedFields,
        set: BTreeMap<String, Value>,
    },
    /// `verdict = no_match` and `confidence >= thresholds.reject`.
    DefiniteNoMatch {
        rule_id: String,
        confidence: f64,
        set: BTreeMap<String, Value>,
    },
    /// Ambiguous or missing required fields — escalate to T5 AI with extracted hint fields.
    Uncertain {
        hint_fields: ExtractedFields,
        matched_rule_id: Option<String>,
        verdict: Option<RuleVerdict>,
        confidence: Option<f64>,
        set: BTreeMap<String, Value>,
    },
}

/// Human-readable summary of a ruleset for the Radar Inspector UI (`05-pipeline-rules.md §6.5`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RulesetSummary {
    pub accept_keywords: Vec<String>,
    pub reject_keywords: Vec<String>,
    pub extracted_fields: Vec<String>,
}

/// Schema, regex safety, or latency errors reported by [`validate_ruleset`].
#[derive(Debug, Clone, PartialEq, Error)]
pub enum RulesetValidationError {
    #[error("unsupported DSL version {0} (expected {SUPPORTED_DSL_VERSION})")]
    UnsupportedDslVersion(u32),
    #[error("invalid thresholds: accept={accept}, reject={reject} (must be in (0.0, 1.0])")]
    InvalidThresholds { accept: f64, reject: f64 },
    #[error("classify rule has empty id")]
    EmptyRuleId,
    #[error("duplicate classify rule id `{0}`")]
    DuplicateRuleId(String),
    #[error("invalid confidence {confidence} on rule `{rule_id}` (must be in [0.0, 1.0])")]
    InvalidConfidence { rule_id: String, confidence: f64 },
    #[error("condition tree exceeds maximum nesting depth of {MAX_CONDITION_DEPTH}")]
    ConditionTooDeep,
    #[error("empty condition list or keyword list in `{0}`")]
    EmptyConditionList(&'static str),
    #[error("invalid field name `{0}`")]
    InvalidFieldKey(String),
    #[error("unsupported gazetteer dictionary `{0}` (expected `vn_admin`)")]
    UnsupportedGazetteerDict(String),
    #[error("empty `enum_kw` map on field `{0}`")]
    EmptyEnumMap(String),
    #[error("regex error in {context}: {source}")]
    Regex {
        context: String,
        #[source]
        source: RegexSafetyError,
    },
    #[error(
        "ruleset median execution time {median_us}µs exceeded 1000µs budget on 5,000-char post"
    )]
    TooSlow { median_us: u128 },
}
