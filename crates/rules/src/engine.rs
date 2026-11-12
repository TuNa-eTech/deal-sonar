use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::extractors::area::extract_vn_area_from_folded;
use crate::extractors::date_vi::extract_date_vi_from_folded;
use crate::extractors::enum_kw::{
    compile_enum_patterns, extract_enum_kw_compiled, matches_any_enum_kw, CompiledEnumPatterns,
};
use crate::extractors::gazetteer::extract_gazetteer_from_folded;
use crate::extractors::money::extract_vn_money_from_folded;
use crate::extractors::number::{extract_number_from_folded, NumberExtractorConfig};
use crate::extractors::phone::extract_vn_phone_first;
use crate::extractors::regex_ext::{
    compile_safe_regex, extract_compiled_regex_first, RegexCast, RegexSafetyError,
};
use crate::extractors::ExtractorConfig;
use crate::normalize::{
    canonical_lang_code, fold_text, fold_with_spans, normalize_text, FoldedText, FoldedView,
    NormalizedText,
};
use crate::postfilter::compare_field_value;
use crate::prefilter::kw_contains_folded;
use crate::types::{ExtractedFields, FieldDef, FieldSource, FilterOp};

/// Supported DSL schema version (`05-pipeline-rules.md §6.2`).
pub const SUPPORTED_DSL_VERSION: u32 = 1;
/// Maximum allowed nesting depth for `Condition` trees (`all`/`any`/`not`).
pub const MAX_CONDITION_DEPTH: usize = 16;
/// Maximum median execution time on a 5,000-character Vietnamese post (`05-pipeline-rules.md §6.4`).
pub const MAX_RULESET_EXEC_DURATION: Duration = Duration::from_millis(1);

const fn default_dsl_version() -> u32 {
    SUPPORTED_DSL_VERSION
}

const fn default_threshold() -> f64 {
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

// ---------- Precompiled engine structures ----------

#[derive(Debug, Clone)]
enum CompiledPatternItem {
    Keyword(String),
    Regex(Regex),
}

/// Precompiled pattern list using shared [`FoldedView::words`] lookup (`CompiledEnumPatterns`)
/// plus linear-time compiled regexes.
#[derive(Debug, Clone, Default)]
struct CompiledPatternList {
    keyword_items: Vec<String>,
    kw_patterns: Option<Box<CompiledEnumPatterns>>,
    regex_items: Vec<Regex>,
}

impl CompiledPatternList {
    fn from_items(items: Vec<CompiledPatternItem>) -> Self {
        let mut keyword_items = Vec::new();
        let mut regex_items = Vec::new();
        for item in items {
            match item {
                CompiledPatternItem::Keyword(kw) => keyword_items.push(kw),
                CompiledPatternItem::Regex(re) => regex_items.push(re),
            }
        }
        let kw_patterns = if keyword_items.len() >= 3 {
            let mut map = BTreeMap::new();
            map.insert("_".to_string(), keyword_items.clone());
            Some(Box::new(compile_enum_patterns(&map)))
        } else {
            None
        };

        Self {
            keyword_items,
            kw_patterns,
            regex_items,
        }
    }

    #[inline]
    fn is_empty(&self) -> bool {
        self.keyword_items.is_empty() && self.regex_items.is_empty()
    }

    fn matches_any(&self, folded: &FoldedView<'_>) -> bool {
        let kw_match = if let Some(pat) = &self.kw_patterns {
            matches_any_enum_kw(folded, pat)
        } else {
            self.keyword_items
                .iter()
                .any(|kw| kw_contains_folded(folded.text_fold, kw))
        };
        kw_match
            || self
                .regex_items
                .iter()
                .any(|re| re.is_match(folded.text_fold))
    }
}

#[derive(Debug, Clone)]
struct CompiledPrefilter {
    any: CompiledPatternList,
    none: CompiledPatternList,
    min_len: Option<usize>,
}

#[derive(Debug, Clone)]
enum CompiledCondition {
    All(Vec<CompiledCondition>),
    Any(Vec<CompiledCondition>),
    Not(Box<CompiledCondition>),
    KwAny(CompiledPatternList),
    KwNone(CompiledPatternList),
    Re(Regex),
    HasField(String),
    LenLt(usize),
    LenGt(usize),
    LangIn(Vec<String>),
    FieldCmp(FieldCmp),
}

#[derive(Debug, Clone)]
struct CompiledClassifyRule {
    id: String,
    when: CompiledCondition,
    verdict: RuleVerdict,
    confidence: f64,
    set: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
enum CompiledExtractor {
    VnMoney {
        near_folded: Vec<String>,
        window: usize,
    },
    VnPhone,
    VnArea,
    Gazetteer {
        scope: Option<String>,
    },
    Number(NumberExtractorConfig),
    DateVi,
    EnumKw {
        patterns: Box<CompiledEnumPatterns>,
        multi: bool,
    },
    Regex {
        regex: Regex,
        group: usize,
        cast: RegexCast,
    },
}

#[derive(Debug, Clone)]
struct CompiledExtractRule {
    field: String,
    extractor: CompiledExtractor,
}

/// Precompiled, linear-time executable ruleset (`< 1 ms` per post).
#[derive(Debug, Clone)]
pub struct CompiledRuleset {
    prefilter: Option<CompiledPrefilter>,
    classify: Vec<CompiledClassifyRule>,
    extract: Vec<CompiledExtractRule>,
    thresholds: Thresholds,
}

static BENCHMARK_POST_5000: LazyLock<(NormalizedText, FoldedText)> = LazyLock::new(|| {
    let paragraph = "Cần thuê căn hộ chung cư 2 phòng ngủ ở khu vực Dịch Vọng, Cầu Giấy, Hà Nội. \
        Gia đình trẻ ở sạch sẽ giữ gìn đồ đạc, tài chính tầm 12 - 15 triệu/tháng, diện tích khoảng \
        65m2 - 75m2, dọn vào đầu tháng sau hoặc ngày 15/11/2026. Liên hệ chính chủ không qua trung gian \
        theo số 0912.345.678. Yêu cầu có ban công thoáng mát, nội thất cơ bản điều hoà nóng lạnh tủ bếp, \
        gần trường học và công viên Cầu Giấy. ";
    let mut buf = String::with_capacity(5_200);
    while buf.chars().count() < 5_000 {
        buf.push_str(paragraph);
    }
    let truncated: String = buf.chars().take(5_000).collect();
    let norm = normalize_text(&truncated);
    let folded = fold_with_spans(&norm.text_norm);
    (norm, folded)
});

/// Validate a [`RulesetBody`] (`05-pipeline-rules.md §6.4`):
/// 1. Checks DSL version, thresholds, unique rule IDs, field identifiers, and nesting depth.
/// 2. Compiles every regex with linear-time NFA/DFA size limits and nested-quantifier guards.
/// 3. Benchmarks execution on a 5,000-character Vietnamese post and verifies median latency `< 1ms`
///    (retrying once across 5 runs to tolerate OS scheduling jitter in shared CI).
pub fn validate_ruleset(ruleset: &RulesetBody) -> Result<CompiledRuleset, RulesetValidationError> {
    let compiled = compile_ruleset_unchecked(ruleset)?;

    let (bench_norm, bench_folded) = &*BENCHMARK_POST_5000;
    let bench_view = bench_folded.as_view(&bench_norm.text_norm);
    let ref_ts_ms = 1_794_384_000_000_i64;

    // Warmup pass
    let _ = compiled.evaluate_with_folded(bench_norm, &bench_view, &[], ref_ts_ms);

    let mut median = measure_median_5(&compiled, bench_norm, &bench_view, ref_ts_ms);
    for _ in 0..3 {
        if median < MAX_RULESET_EXEC_DURATION {
            break;
        }
        // Retry if the thread experienced transient OS CPU preemption during parallel CI test runs
        let retry_median = measure_median_5(&compiled, bench_norm, &bench_view, ref_ts_ms);
        median = median.min(retry_median);
    }

    if median >= MAX_RULESET_EXEC_DURATION {
        return Err(RulesetValidationError::TooSlow {
            median_us: median.as_micros(),
        });
    }

    Ok(compiled)
}

fn measure_median_5(
    compiled: &CompiledRuleset,
    norm: &NormalizedText,
    folded: &FoldedView<'_>,
    ref_ts_ms: i64,
) -> Duration {
    let mut samples = [Duration::ZERO; 5];
    for slot in &mut samples {
        let t0 = Instant::now();
        // Run both extraction and classification unconditionally in the benchmark so a slow rule/extractor
        // cannot hide behind an early `prefilter` short-circuit!
        let _ = std::hint::black_box(compiled.benchmark_full_pass(norm, folded, ref_ts_ms));
        *slot = t0.elapsed();
    }
    samples.sort_unstable();
    samples[2]
}

/// Compile a [`RulesetBody`] checking all schema & regex invariants (without running the benchmark).
pub fn compile_ruleset_unchecked(
    ruleset: &RulesetBody,
) -> Result<CompiledRuleset, RulesetValidationError> {
    if ruleset.dsl != SUPPORTED_DSL_VERSION {
        return Err(RulesetValidationError::UnsupportedDslVersion(ruleset.dsl));
    }
    if !ruleset.thresholds.accept.is_finite()
        || ruleset.thresholds.accept <= 0.0
        || ruleset.thresholds.accept > 1.0
        || !ruleset.thresholds.reject.is_finite()
        || ruleset.thresholds.reject <= 0.0
        || ruleset.thresholds.reject > 1.0
    {
        return Err(RulesetValidationError::InvalidThresholds {
            accept: ruleset.thresholds.accept,
            reject: ruleset.thresholds.reject,
        });
    }

    let prefilter = match &ruleset.prefilter {
        Some(pf) => Some(compile_prefilter(pf)?),
        None => None,
    };

    let mut seen_ids = HashSet::with_capacity(ruleset.classify.len());
    let mut classify = Vec::with_capacity(ruleset.classify.len());
    for rule in &ruleset.classify {
        let id = rule.id.trim();
        if id.is_empty() {
            return Err(RulesetValidationError::EmptyRuleId);
        }
        if !seen_ids.insert(id.to_string()) {
            return Err(RulesetValidationError::DuplicateRuleId(id.to_string()));
        }
        if !rule.confidence.is_finite() || !(0.0..=1.0).contains(&rule.confidence) {
            return Err(RulesetValidationError::InvalidConfidence {
                rule_id: id.to_string(),
                confidence: rule.confidence,
            });
        }
        let when = compile_condition(&rule.when, 0, id)?;
        classify.push(CompiledClassifyRule {
            id: id.to_string(),
            when,
            verdict: rule.verdict,
            confidence: rule.confidence,
            set: rule.set.clone(),
        });
    }

    let mut extract = Vec::with_capacity(ruleset.extract.len());
    for ext in &ruleset.extract {
        if !is_valid_field_key(&ext.field) {
            return Err(RulesetValidationError::InvalidFieldKey(ext.field.clone()));
        }
        let compiled_ext = compile_extractor(&ext.field, &ext.config)?;
        extract.push(CompiledExtractRule {
            field: ext.field.clone(),
            extractor: compiled_ext,
        });
    }

    Ok(CompiledRuleset {
        prefilter,
        classify,
        extract,
        thresholds: ruleset.thresholds.clone(),
    })
}

fn is_valid_field_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn compile_pattern_item(
    raw: &str,
    context: &str,
) -> Result<CompiledPatternItem, RulesetValidationError> {
    if let Some(re_pat) = raw.strip_prefix("re:") {
        let re = compile_safe_regex(re_pat).map_err(|source| RulesetValidationError::Regex {
            context: context.to_string(),
            source,
        })?;
        Ok(CompiledPatternItem::Regex(re))
    } else {
        let folded = fold_text(raw);
        if folded.is_empty() {
            return Err(RulesetValidationError::EmptyConditionList("keyword"));
        }
        Ok(CompiledPatternItem::Keyword(folded))
    }
}

fn compile_prefilter(pf: &PrefilterSpec) -> Result<CompiledPrefilter, RulesetValidationError> {
    let mut any = Vec::with_capacity(pf.any.len());
    for item in &pf.any {
        any.push(compile_pattern_item(item, "prefilter.any")?);
    }
    let mut none = Vec::with_capacity(pf.none.len());
    for item in &pf.none {
        none.push(compile_pattern_item(item, "prefilter.none")?);
    }
    Ok(CompiledPrefilter {
        any: CompiledPatternList::from_items(any),
        none: CompiledPatternList::from_items(none),
        min_len: pf.min_len,
    })
}

fn compile_condition(
    cond: &Condition,
    depth: usize,
    rule_id: &str,
) -> Result<CompiledCondition, RulesetValidationError> {
    if depth > MAX_CONDITION_DEPTH {
        return Err(RulesetValidationError::ConditionTooDeep);
    }
    match cond {
        Condition::All(items) => {
            if items.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("all"));
            }
            let mut out = Vec::with_capacity(items.len());
            for c in items {
                out.push(compile_condition(c, depth + 1, rule_id)?);
            }
            // Evaluate O(1) metadata/field predicates (`HasField`, `FieldCmp`, `LenLt`, `LenGt`, `LangIn`)
            // before full-text `KwAny` / `KwNone` / `Re` scans so conjunctions short-circuit immediately.
            out.sort_by_key(condition_eval_cost);
            Ok(CompiledCondition::All(out))
        }
        Condition::Any(items) => {
            if items.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("any"));
            }
            let mut out = Vec::with_capacity(items.len());
            for c in items {
                out.push(compile_condition(c, depth + 1, rule_id)?);
            }
            out.sort_by_key(condition_eval_cost);
            Ok(CompiledCondition::Any(out))
        }
        Condition::Not(inner) => Ok(CompiledCondition::Not(Box::new(compile_condition(
            inner,
            depth + 1,
            rule_id,
        )?))),
        Condition::KwAny(kws) => {
            if kws.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("kw_any"));
            }
            let mut out = Vec::with_capacity(kws.len());
            for kw in kws {
                out.push(compile_pattern_item(
                    kw,
                    &format!("rule `{rule_id}` kw_any"),
                )?);
            }
            Ok(CompiledCondition::KwAny(CompiledPatternList::from_items(
                out,
            )))
        }
        Condition::KwNone(kws) => {
            if kws.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("kw_none"));
            }
            let mut out = Vec::with_capacity(kws.len());
            for kw in kws {
                out.push(compile_pattern_item(
                    kw,
                    &format!("rule `{rule_id}` kw_none"),
                )?);
            }
            Ok(CompiledCondition::KwNone(CompiledPatternList::from_items(
                out,
            )))
        }
        Condition::Re(pat) => {
            let re = compile_safe_regex(pat).map_err(|source| RulesetValidationError::Regex {
                context: format!("rule `{rule_id}` re"),
                source,
            })?;
            Ok(CompiledCondition::Re(re))
        }
        Condition::HasField(f) => {
            if !is_valid_field_key(f) {
                return Err(RulesetValidationError::InvalidFieldKey(f.clone()));
            }
            Ok(CompiledCondition::HasField(f.clone()))
        }
        Condition::LenLt(n) => Ok(CompiledCondition::LenLt(*n)),
        Condition::LenGt(n) => Ok(CompiledCondition::LenGt(*n)),
        Condition::LangIn(langs) => {
            if langs.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("lang_in"));
            }
            let norm_langs = langs
                .iter()
                .map(|l| canonical_lang_code(l).to_string())
                .collect();
            Ok(CompiledCondition::LangIn(norm_langs))
        }
        Condition::FieldCmp(cmp) => {
            if !is_valid_field_key(&cmp.field) {
                return Err(RulesetValidationError::InvalidFieldKey(cmp.field.clone()));
            }
            Ok(CompiledCondition::FieldCmp(cmp.clone()))
        }
    }
}

fn condition_eval_cost(cond: &CompiledCondition) -> u8 {
    match cond {
        CompiledCondition::HasField(_)
        | CompiledCondition::LenLt(_)
        | CompiledCondition::LenGt(_)
        | CompiledCondition::LangIn(_)
        | CompiledCondition::FieldCmp(_) => 0,
        CompiledCondition::Not(inner) => condition_eval_cost(inner).saturating_add(1),
        CompiledCondition::All(items) | CompiledCondition::Any(items) => items
            .iter()
            .map(condition_eval_cost)
            .max()
            .unwrap_or(1)
            .max(1),
        CompiledCondition::KwAny(_) | CompiledCondition::KwNone(_) | CompiledCondition::Re(_) => 3,
    }
}

fn compile_extractor(
    field: &str,
    cfg: &ExtractorConfig,
) -> Result<CompiledExtractor, RulesetValidationError> {
    match cfg {
        ExtractorConfig::VnMoney { near, window } => Ok(CompiledExtractor::VnMoney {
            near_folded: near
                .iter()
                .map(|s| fold_text(s))
                .filter(|s| !s.is_empty())
                .collect(),
            window: *window,
        }),
        ExtractorConfig::VnPhone => Ok(CompiledExtractor::VnPhone),
        ExtractorConfig::VnArea => Ok(CompiledExtractor::VnArea),
        ExtractorConfig::Gazetteer { dict, scope } => {
            if dict != "vn_admin" {
                return Err(RulesetValidationError::UnsupportedGazetteerDict(
                    dict.clone(),
                ));
            }
            Ok(CompiledExtractor::Gazetteer {
                scope: scope.clone(),
            })
        }
        ExtractorConfig::Number {
            units,
            prefixes,
            multipliers,
        } => Ok(CompiledExtractor::Number(NumberExtractorConfig {
            units: units.clone(),
            prefixes: prefixes.clone(),
            multipliers: multipliers.clone(),
        })),
        ExtractorConfig::DateVi => Ok(CompiledExtractor::DateVi),
        ExtractorConfig::EnumKw { map, multi } => {
            if map.is_empty() || map.values().any(|kws| kws.is_empty()) {
                return Err(RulesetValidationError::EmptyEnumMap(field.to_string()));
            }
            Ok(CompiledExtractor::EnumKw {
                patterns: Box::new(compile_enum_patterns(map)),
                multi: *multi,
            })
        }
        ExtractorConfig::Regex {
            pattern,
            group,
            cast,
        } => {
            let regex =
                compile_safe_regex(pattern).map_err(|source| RulesetValidationError::Regex {
                    context: format!("extract `{field}`"),
                    source,
                })?;
            let max_group = regex.captures_len().saturating_sub(1);
            if *group > max_group {
                return Err(RulesetValidationError::Regex {
                    context: format!("extract `{field}`"),
                    source: RegexSafetyError::InvalidCaptureGroup {
                        group: *group,
                        max_group,
                    },
                });
            }
            Ok(CompiledExtractor::Regex {
                regex,
                group: *group,
                cast: *cast,
            })
        }
    }
}

impl CompiledRuleset {
    /// Evaluate this compiled ruleset against a normalized post (`05-pipeline-rules.md §6.2`).
    pub fn evaluate(
        &self,
        post: &NormalizedText,
        field_defs: &[FieldDef],
        ref_ts_ms: i64,
    ) -> RulesetOutcome {
        let view = FoldedView::lazy(&post.text_norm, &post.text_fold);
        self.evaluate_with_folded(post, &view, field_defs, ref_ts_ms)
    }

    pub(crate) fn evaluate_with_folded(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        field_defs: &[FieldDef],
        ref_ts_ms: i64,
    ) -> RulesetOutcome {
        let char_len_cache = std::cell::OnceCell::new();
        if let Some(pf) = &self.prefilter {
            if !eval_prefilter(pf, &post.text_norm, folded, &char_len_cache) {
                return RulesetOutcome::PrefilterReject;
            }
        }

        let extracted = self.run_extractors(post, folded, ref_ts_ms);
        self.classify_extracted(post, folded, &char_len_cache, field_defs, extracted)
    }

    /// Runs prefilter, all extractors, and all classify rules without short-circuiting prefilter
    /// so `validate_ruleset` measures full worst-case ruleset latency.
    fn benchmark_full_pass(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        ref_ts_ms: i64,
    ) -> usize {
        let char_len_cache = std::cell::OnceCell::new();
        let pf_ok = self
            .prefilter
            .as_ref()
            .map(|pf| eval_prefilter(pf, &post.text_norm, folded, &char_len_cache))
            .unwrap_or(true);
        let extracted = self.run_extractors(post, folded, ref_ts_ms);
        for rule in &self.classify {
            let _ = eval_condition(&rule.when, post, folded, &char_len_cache, &extracted);
        }
        usize::from(pf_ok) + extracted.len()
    }

    pub(crate) fn run_extractors(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        ref_ts_ms: i64,
    ) -> ExtractedFields {
        let mut out = ExtractedFields::new();
        for item in &self.extract {
            if out.contains_key(&item.field) {
                continue;
            }
            let first_match = match &item.extractor {
                CompiledExtractor::VnMoney {
                    near_folded,
                    window,
                } => extract_vn_money_from_folded(
                    &post.text_norm,
                    folded,
                    near_folded,
                    Some(*window),
                    true,
                )
                .into_iter()
                .next(),
                CompiledExtractor::VnPhone => extract_vn_phone_first(&post.text_norm),
                CompiledExtractor::VnArea => {
                    extract_vn_area_from_folded(&post.text_norm, folded, true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Gazetteer { scope } => {
                    extract_gazetteer_from_folded(&post.text_norm, folded, scope.as_deref(), true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Number(cfg) => {
                    extract_number_from_folded(&post.text_norm, folded, cfg)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::DateVi => {
                    extract_date_vi_from_folded(&post.text_norm, folded, ref_ts_ms)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::EnumKw { patterns, multi } => {
                    extract_enum_kw_compiled(&post.text_norm, folded, patterns, *multi, true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Regex { regex, group, cast } => {
                    extract_compiled_regex_first(&post.text_norm, folded, regex, *group, *cast)
                }
            };
            if let Some(first) = first_match {
                out.insert(
                    item.field.clone(),
                    first.into_extracted_field(FieldSource::Rule),
                );
            }
        }
        out
    }

    fn classify_extracted(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        char_len_cache: &std::cell::OnceCell<usize>,
        field_defs: &[FieldDef],
        extracted: ExtractedFields,
    ) -> RulesetOutcome {
        for rule in &self.classify {
            if eval_condition(&rule.when, post, folded, char_len_cache, &extracted) {
                match rule.verdict {
                    RuleVerdict::Match => {
                        let all_required_present = field_defs
                            .iter()
                            .filter(|d| d.required)
                            .all(|d| extracted.contains_key(&d.key));
                        if rule.confidence >= self.thresholds.accept && all_required_present {
                            return RulesetOutcome::DefiniteMatch {
                                rule_id: rule.id.clone(),
                                confidence: rule.confidence,
                                fields: extracted,
                                set: rule.set.clone(),
                            };
                        }
                        return RulesetOutcome::Uncertain {
                            hint_fields: extracted,
                            matched_rule_id: Some(rule.id.clone()),
                            verdict: Some(RuleVerdict::Match),
                            confidence: Some(rule.confidence),
                            set: rule.set.clone(),
                        };
                    }
                    RuleVerdict::NoMatch => {
                        if rule.confidence >= self.thresholds.reject {
                            return RulesetOutcome::DefiniteNoMatch {
                                rule_id: rule.id.clone(),
                                confidence: rule.confidence,
                                set: rule.set.clone(),
                            };
                        }
                        return RulesetOutcome::Uncertain {
                            hint_fields: extracted,
                            matched_rule_id: Some(rule.id.clone()),
                            verdict: Some(RuleVerdict::NoMatch),
                            confidence: Some(rule.confidence),
                            set: rule.set.clone(),
                        };
                    }
                }
            }
        }

        RulesetOutcome::Uncertain {
            hint_fields: extracted,
            matched_rule_id: None,
            verdict: None,
            confidence: None,
            set: BTreeMap::new(),
        }
    }
}

#[inline]
fn get_char_len(text_norm: &str, cache: &std::cell::OnceCell<usize>) -> usize {
    *cache.get_or_init(|| {
        text_norm
            .as_bytes()
            .iter()
            .filter(|&&b| (b as i8) >= -64)
            .count()
    })
}

fn eval_prefilter(
    pf: &CompiledPrefilter,
    text_norm: &str,
    folded: &FoldedView<'_>,
    char_len_cache: &std::cell::OnceCell<usize>,
) -> bool {
    if let Some(min_len) = pf.min_len {
        if text_norm.len() < min_len {
            return false;
        }
        if text_norm.len() < min_len.saturating_mul(4)
            && get_char_len(text_norm, char_len_cache) < min_len
        {
            return false;
        }
    }
    if !pf.any.is_empty() && !pf.any.matches_any(folded) {
        return false;
    }
    if pf.none.matches_any(folded) {
        return false;
    }
    true
}

fn eval_condition(
    cond: &CompiledCondition,
    post: &NormalizedText,
    folded: &FoldedView<'_>,
    char_len_cache: &std::cell::OnceCell<usize>,
    extracted: &ExtractedFields,
) -> bool {
    match cond {
        CompiledCondition::All(items) => items
            .iter()
            .all(|c| eval_condition(c, post, folded, char_len_cache, extracted)),
        CompiledCondition::Any(items) => items
            .iter()
            .any(|c| eval_condition(c, post, folded, char_len_cache, extracted)),
        CompiledCondition::Not(inner) => {
            !eval_condition(inner, post, folded, char_len_cache, extracted)
        }
        CompiledCondition::KwAny(items) => items.matches_any(folded),
        CompiledCondition::KwNone(items) => !items.matches_any(folded),
        CompiledCondition::Re(re) => {
            re.is_match(folded.text_fold)
                || (!re.as_str().is_ascii() && re.is_match(&post.text_norm))
        }
        CompiledCondition::HasField(f) => extracted
            .get(f)
            .map(|ef| !ef.value.is_null())
            .unwrap_or(false),
        CompiledCondition::LenLt(limit) => {
            if post.text_norm.len() < *limit {
                true
            } else if post.text_norm.len() >= limit.saturating_mul(4) {
                false
            } else {
                get_char_len(&post.text_norm, char_len_cache) < *limit
            }
        }
        CompiledCondition::LenGt(limit) => {
            if post.text_norm.len() <= *limit {
                false
            } else if post.text_norm.len() > limit.saturating_mul(4) {
                true
            } else {
                get_char_len(&post.text_norm, char_len_cache) > *limit
            }
        }
        CompiledCondition::LangIn(langs) => {
            let post_lang = canonical_lang_code(&post.lang);
            langs.iter().any(|l| l == post_lang)
        }
        CompiledCondition::FieldCmp(cmp) => extracted
            .get(&cmp.field)
            .map(|ef| compare_field_value(&ef.value, cmp.op, &cmp.value))
            .unwrap_or(false),
    }
}

/// Evaluate a [`RulesetBody`] on a normalized post (`05-pipeline-rules.md §6.2`).
pub fn evaluate_ruleset(
    ruleset: &RulesetBody,
    post: &NormalizedText,
    field_defs: &[FieldDef],
    ref_ts_ms: i64,
) -> Result<RulesetOutcome, RulesetValidationError> {
    let compiled = compile_ruleset_unchecked(ruleset)?;
    Ok(compiled.evaluate(post, field_defs, ref_ts_ms))
}

/// Extract a human-readable summary of accept keywords, reject keywords, and extracted field keys
/// for the Radar Ruleset Inspector UI (`05-pipeline-rules.md §6.5`).
pub fn describe_ruleset(ruleset: &RulesetBody) -> RulesetSummary {
    let mut accept_keywords = Vec::new();
    let mut reject_keywords = Vec::new();

    if let Some(pf) = &ruleset.prefilter {
        for kw in &pf.any {
            push_unique(&mut accept_keywords, kw);
        }
        for kw in &pf.none {
            push_unique(&mut reject_keywords, kw);
        }
    }

    for rule in &ruleset.classify {
        collect_condition_keywords(
            &rule.when,
            rule.verdict == RuleVerdict::Match,
            &mut accept_keywords,
            &mut reject_keywords,
        );
    }

    let mut extracted_fields = Vec::new();
    for ext in &ruleset.extract {
        push_unique(&mut extracted_fields, &ext.field);
    }

    RulesetSummary {
        accept_keywords,
        reject_keywords,
        extracted_fields,
    }
}

fn collect_condition_keywords(
    cond: &Condition,
    positive_branch: bool,
    accept: &mut Vec<String>,
    reject: &mut Vec<String>,
) {
    match cond {
        Condition::All(items) | Condition::Any(items) => {
            for item in items {
                collect_condition_keywords(item, positive_branch, accept, reject);
            }
        }
        Condition::Not(inner) => {
            collect_condition_keywords(inner, !positive_branch, accept, reject);
        }
        Condition::KwAny(kws) => {
            let dest = if positive_branch { accept } else { reject };
            for kw in kws {
                push_unique(dest, kw);
            }
        }
        Condition::KwNone(kws) => {
            let dest = if positive_branch { reject } else { accept };
            for kw in kws {
                push_unique(dest, kw);
            }
        }
        _ => {}
    }
}

fn push_unique(vec: &mut Vec<String>, item: &str) {
    if !vec.iter().any(|existing| existing == item) {
        vec.push(item.to_string());
    }
}
