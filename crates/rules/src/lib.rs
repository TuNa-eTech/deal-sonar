//! DealSonar pipeline rules engine (`crates/rules`).
//!
//! Implements:
//! - **Shared radar field contracts** (`02-radar-spec.md §3.1–3.3`): [`FieldType`], [`FieldDef`],
//!   [`ExtractedField`], [`FieldSource`], [`MoneyValue`], [`LocationValue`], [`RangeValue`].
//! - **T1 Text Normalization & T2 SimHash Dedup** (`05-pipeline-rules.md §3–4`): [`normalize_text`],
//!   [`NormalizedText`], [`simhash_bands`], [`hamming_distance`], [`is_near_duplicate`].
//! - **T3 Basic Prefilter** (`05-pipeline-rules.md §5`): [`run_basic_prefilter`], [`is_too_short`],
//!   [`is_url_only`], [`matches_blocklist`].
//! - **Built-in Vietnamese Extractors** (`05-pipeline-rules.md §6.3`): `vn_money`, `vn_phone`,
//!   `vn_area`, `gazetteer` (`vn_admin`), `number`, `date_vi`, `enum_kw`, and linear-time `regex`.
//! - **Declarative Ruleset DSL v1 & Lifecycle Gate** (`05-pipeline-rules.md §6.2, §6.4`):
//!   [`RulesetBody`], [`validate_ruleset`], [`evaluate_ruleset`], [`evaluate_gate`], [`seed_ruleset`].
//! - **T6 Postfilter Verification** (`05-pipeline-rules.md §8`): [`verify_evidence`],
//!   [`renormalize_field`], [`evaluate_hard_filters`], [`postprocess_fields`].

pub mod engine;
pub mod extractors;
pub mod gate;
pub mod normalize;
pub mod postfilter;
pub mod prefilter;
pub mod seed;
pub mod types;

pub use engine::{
    compile_ruleset_unchecked, describe_ruleset, evaluate_ruleset, validate_ruleset, ClassifyRule,
    CompiledRuleset, Condition, ExtractRule, FieldCmp, PrefilterSpec, RuleVerdict, RulesetBody,
    RulesetOutcome, RulesetSummary, RulesetValidationError, Thresholds, MAX_CONDITION_DEPTH,
    MAX_RULESET_EXEC_DURATION, SUPPORTED_DSL_VERSION,
};
pub use extractors::{
    check_regex_pattern_safety, compile_safe_regex, extract_date_vi, extract_enum_kw,
    extract_gazetteer, extract_number, extract_regex, extract_vn_area, extract_vn_money,
    extract_vn_phone, normalize_vn_phone_str, parse_standalone_number, ref_date_from_ts_ms,
    to_domestic_phone, ExtractorConfig, NumberExtractorConfig, RegexCast, RegexSafetyError,
    DEFAULT_MONEY_WINDOW, MAX_REGEX_BOUNDED_REPEAT, MAX_REGEX_PATTERN_LEN,
    REGEX_COMPILED_SIZE_LIMIT,
};
pub use gate::{
    evaluate_gate, evaluate_gate_with_fields, GateReport, LabeledSample,
    GATE_MAX_FALSE_NEGATIVE_RATE, GATE_MIN_ACCEPT_PRECISION, GATE_MIN_FIELD_ACCURACY,
};
pub use normalize::{
    canonical_lang_code, compute_content_hash, compute_simhash, detect_lang, fold_text,
    fold_with_spans, hamming_distance, hamming_distance_i64, is_near_duplicate,
    normalize_nfc_clean, normalize_text, simhash_bands, simhash_bands_i64, simhash_from_i64,
    simhash_to_i64, truncate_for_ai, FoldedText, NormalizedText, DEDUP_WINDOW_MS,
    LANG_DETECT_MIN_CHARS, NEAR_DUP_MAX_HAMMING, NEAR_DUP_MIN_CHARS, REPOST_ALLOW_AFTER_MS,
};
pub use postfilter::{
    classify_lead_tier, compare_field_value, evaluate_hard_filters, evaluate_single_filter,
    postprocess_fields, renormalize_extracted_field, renormalize_field, should_override_peer,
    values_equivalent, verify_evidence, LeadDisposition, PeerSignals, PostprocessFieldsResult,
    RenormalizeResult, MISSING_REQUIRED_EVIDENCE_PENALTY,
};
pub use prefilter::{
    is_too_short, is_url_only, kw_contains_folded, matches_blocklist, matches_blocklist_keyword,
    matches_blocklist_phone, run_basic_prefilter, BasicPrefilterInput, BlocklistEntry,
    BlocklistKind, PrefilterRejectReason, PREFILTER_MIN_CHARS_NO_MEDIA,
};
pub use seed::{seed_ruleset, SEED_BDS_VI_V1};
pub use types::{
    format_domestic_phone, AuthorRole, ExtractedField, ExtractedFields, ExtractionMatch, FieldDef,
    FieldSource, FieldType, FilterOp, HardFilter, Intent, LocationValue, MoneyPeriod, MoneyValue,
    RangeValue, RulesetOrigin, RulesetState, WhenMissing,
};
