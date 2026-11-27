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

mod compile;
mod compiled;
mod describe;
mod eval;
mod types;

pub use compile::*;
pub use compiled::*;
pub use describe::*;
pub use eval::*;
pub use types::*;

/// Supported DSL schema version (`05-pipeline-rules.md §6.2`).
pub const SUPPORTED_DSL_VERSION: u32 = 1;
/// Maximum allowed nesting depth for `Condition` trees (`all`/`any`/`not`).
pub const MAX_CONDITION_DEPTH: usize = 16;
/// Maximum median execution time on a 5,000-character Vietnamese post (`05-pipeline-rules.md §6.4`).
pub const MAX_RULESET_EXEC_DURATION: Duration = Duration::from_millis(1);
