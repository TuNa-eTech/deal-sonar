use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

const fn default_true() -> bool {
    true
}

/// All 11 radar field types (`02-radar-spec.md §3.2`).
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

/// Radar field definition (`02-radar-spec.md §3.1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
    #[serde(default)]
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

/// Provenance of an extracted field (`02-radar-spec.md §3.3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Ai,
    Rule,
    User,
}

/// Extracted field value with verbatim `raw` evidence (`02-radar-spec.md §3.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: serde_json::Value,
    pub raw: String,
    pub confidence: f64,
    pub source: FieldSource,
}

/// Deterministic map of field key -> [`ExtractedField`].
pub type ExtractedFields = BTreeMap<String, ExtractedField>;

/// Single match produced by a built-in extractor (`05-pipeline-rules.md §6.3`).
///
/// `start` and `end` are UTF-8 byte offsets into `text_norm` such that
/// `&text_norm[start..end] == raw`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractionMatch {
    pub value: serde_json::Value,
    pub raw: String,
    pub start: usize,
    pub end: usize,
    pub confidence: f64,
}

impl ExtractionMatch {
    pub fn into_extracted_field(self, source: FieldSource) -> ExtractedField {
        ExtractedField {
            value: self.value,
            raw: self.raw,
            confidence: self.confidence,
            source,
        }
    }
}

/// Billing/payment period for [`MoneyValue`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoneyPeriod {
    Day,
    Month,
    Year,
}

/// Normalized JSON value shape for `FieldType::Money` (`02-radar-spec.md §3.2–3.3`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoneyValue {
    pub min: i64,
    pub max: i64,
    pub currency: String,
    pub period: Option<MoneyPeriod>,
}

/// Normalized JSON value shape for `FieldType::Location` (`02-radar-spec.md §3.2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocationValue {
    pub raw: String,
    pub province: Option<String>,
    pub district: Option<String>,
    pub ward: Option<String>,
}

/// Normalized JSON value shape for `FieldType::Range` (`02-radar-spec.md §3.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RangeValue {
    pub min: f64,
    pub max: f64,
    pub unit: String,
}

/// Comparison operators for hard filters and DSL `field_cmp` (`03-desktop.md §4`, `05-pipeline-rules.md §8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    In,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    Contains,
    IsEmpty,
}

/// Policy when a filtered field is absent on a post (`02-radar-spec.md §2`, `05-pipeline-rules.md §8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenMissing {
    #[default]
    Pass,
    Fail,
}

/// Hard filter definition (`02-radar-spec.md §2`, `05-pipeline-rules.md §8`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardFilter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: serde_json::Value,
    #[serde(default)]
    pub when_missing: WhenMissing,
}

/// System `intent` enum (`02-radar-spec.md §3.4`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Demand,
    Supply,
    Other,
}

/// System `author_role` enum (`02-radar-spec.md §3.4`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorRole {
    EndUser,
    Peer,
    Unknown,
}

/// Lifecycle state of a ruleset (`05-pipeline-rules.md §6.4`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesetState {
    Candidate,
    Shadow,
    Active,
    Retired,
}

/// Origin of a ruleset (`04-data-model.md §2.3`, `05-pipeline-rules.md §6.4`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesetOrigin {
    Seed,
    Compiled,
    User,
}

/// Format an E.164 (or domestic) Vietnamese phone number into readable domestic form
/// (`"+84912345678"` -> `"0912 345 678"`), per `07-notifications-export.md §2.2`.
pub fn format_domestic_phone(phone: &str) -> String {
    let trimmed = phone.trim();
    let digits_only: String = if let Some(rest) = trimmed.strip_prefix("+84") {
        let mut s = String::with_capacity(rest.len() + 1);
        s.push('0');
        s.extend(rest.chars().filter(|c| c.is_ascii_digit()));
        s
    } else if let Some(rest) = trimmed.strip_prefix("84") {
        let only_digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if only_digits.len() == 9 || (only_digits.starts_with('2') && only_digits.len() == 10) {
            format!("0{only_digits}")
        } else {
            trimmed.chars().filter(|c| c.is_ascii_digit()).collect()
        }
    } else {
        trimmed.chars().filter(|c| c.is_ascii_digit()).collect()
    };

    if !digits_only.starts_with('0') {
        return trimmed.to_string();
    }

    match digits_only.len() {
        10 if digits_only.starts_with("024") || digits_only.starts_with("028") => {
            format!(
                "{} {} {}",
                &digits_only[0..3],
                &digits_only[3..6],
                &digits_only[6..10]
            )
        }
        10 => format!(
            "{} {} {}",
            &digits_only[0..4],
            &digits_only[4..7],
            &digits_only[7..10]
        ),
        11 if digits_only.starts_with("024") || digits_only.starts_with("028") => {
            format!(
                "{} {} {}",
                &digits_only[0..3],
                &digits_only[3..7],
                &digits_only[7..11]
            )
        }
        11 if digits_only.starts_with("02") => {
            format!(
                "{} {} {}",
                &digits_only[0..4],
                &digits_only[4..7],
                &digits_only[7..11]
            )
        }
        _ => trimmed.to_string(),
    }
}
