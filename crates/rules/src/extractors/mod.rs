pub mod area;
pub mod date_vi;
pub mod enum_kw;
pub mod gazetteer;
pub mod money;
pub mod number;
pub mod phone;
pub mod regex_ext;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use area::extract_vn_area;
pub use date_vi::{extract_date_vi, ref_date_from_ts_ms};
pub use enum_kw::extract_enum_kw;
pub use gazetteer::extract_gazetteer;
pub use money::{extract_vn_money, DEFAULT_MONEY_WINDOW};
pub use number::{extract_number, parse_standalone_number, NumberExtractorConfig};
pub use phone::{extract_vn_phone, normalize_vn_phone_str, to_domestic_phone};
pub use regex_ext::{
    check_regex_pattern_safety, compile_safe_regex, extract_regex, RegexCast, RegexSafetyError,
    MAX_REGEX_BOUNDED_REPEAT, MAX_REGEX_PATTERN_LEN, REGEX_COMPILED_SIZE_LIMIT,
};

const fn default_money_window() -> usize {
    DEFAULT_MONEY_WINDOW
}

fn default_gazetteer_dict() -> String {
    "vn_admin".to_string()
}

/// Declarative configuration of a built-in extractor inside `RulesetBody.extract` (`05-pipeline-rules.md §6.2–6.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "extractor", rename_all = "snake_case")]
pub enum ExtractorConfig {
    VnMoney {
        #[serde(default)]
        near: Vec<String>,
        #[serde(default = "default_money_window")]
        window: usize,
    },
    VnPhone,
    VnArea,
    Gazetteer {
        #[serde(default = "default_gazetteer_dict")]
        dict: String,
        #[serde(default)]
        scope: Option<String>,
    },
    Number {
        #[serde(default)]
        units: Vec<String>,
        #[serde(default)]
        prefixes: Vec<String>,
        #[serde(default)]
        multipliers: BTreeMap<String, f64>,
    },
    DateVi,
    EnumKw {
        map: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        multi: bool,
    },
    Regex {
        pattern: String,
        #[serde(default)]
        group: usize,
        #[serde(default)]
        cast: RegexCast,
    },
}
