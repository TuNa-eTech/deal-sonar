use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::types::ExtractionMatch;

/// Configuration for the built-in `number` extractor (`05-pipeline-rules.md §6.3`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NumberExtractorConfig {
    /// Allowed unit suffixes (e.g. `["tấn", "kg"]`, `["pn", "phòng ngủ"]`, `["vạn km", "km"]`).
    /// When both `units` and `prefixes` are empty, built-in Vietnamese units/prefixes are used.
    #[serde(default)]
    pub units: Vec<String>,
    /// Allowed prefix cues before a number (e.g. `["đời", "năm", "sx"]` for `"đời 2019"`).
    #[serde(default)]
    pub prefixes: Vec<String>,
    /// Optional custom multipliers keyed by folded unit name (e.g. `{"van km": 10000}`).
    #[serde(default)]
    pub multipliers: BTreeMap<String, f64>,
}

static DEFAULT_UNITS: &[(&str, f64)] = &[
    ("van km", 10_000.0),
    ("van", 10_000.0),
    ("nghin km", 1_000.0),
    ("ngan km", 1_000.0),
    ("km", 1.0),
    ("tan", 1.0),
    ("ta", 1.0),
    ("yen", 1.0),
    ("kg", 1.0),
    ("phong ngu", 1.0),
    ("p.ngu", 1.0),
    ("pn", 1.0),
    ("ngu", 1.0),
    ("wc", 1.0),
    ("tang", 1.0),
    ("lau", 1.0),
    ("cho", 1.0),
    ("ghe", 1.0),
    ("suat", 1.0),
    ("chiec", 1.0),
    ("cai", 1.0),
    ("bo", 1.0),
    ("thung", 1.0),
    ("kien", 1.0),
    ("pallet", 1.0),
    ("nam kinh nghiem", 1.0),
    ("nam kn", 1.0),
];

static DEFAULT_PREFIXES: &[&str] = &["doi", "nam sx", "san xuat", "sx", "so luong", "sl"];

static PLAIN_NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)^\s*[+-]?(?P<n>\d+(?:[.,]\d+)?)\s*$").expect("valid plain number regex")
});

static NUM_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)\d+(?:[.,]\d+)?").expect("valid num regex"));

/// Extract numbers with configurable Vietnamese unit/prefix patterns (`3 tấn`, `đời 2019`,
/// `5 vạn km` -> `50000`, `2pn` -> `2`) (`05-pipeline-rules.md §6.3`).
pub fn extract_number(text_norm: &str, config: &NumberExtractorConfig) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }
    let folded = fold_with_spans(text_norm);
    extract_number_from_folded(text_norm, &folded.as_view(text_norm), config)
}

pub(crate) fn extract_number_from_folded(
    text_norm: &str,
    folded: &FoldedView<'_>,
    config: &NumberExtractorConfig,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    if tf.is_empty() {
        return Vec::new();
    }

    let use_defaults = config.units.is_empty() && config.prefixes.is_empty();

    let mut unit_specs: Vec<(String, f64)> = if use_defaults {
        DEFAULT_UNITS
            .iter()
            .map(|&(u, mult)| {
                let custom = config.multipliers.get(u).copied().unwrap_or(mult);
                (u.to_string(), custom)
            })
            .collect()
    } else {
        config
            .units
            .iter()
            .map(|u| {
                let uf = fold_text(u);
                let mult = config
                    .multipliers
                    .get(&uf)
                    .copied()
                    .unwrap_or_else(|| builtin_unit_multiplier(&uf));
                (uf, mult)
            })
            .filter(|(uf, _)| !uf.is_empty())
            .collect()
    };
    // Match longest units first ("van km" before "van" or "km", "phong ngu" before "ngu")
    unit_specs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

    let mut prefix_specs: Vec<String> = if use_defaults {
        DEFAULT_PREFIXES.iter().map(|s| (*s).to_string()).collect()
    } else {
        config
            .prefixes
            .iter()
            .map(|p| fold_text(p))
            .filter(|p| !p.is_empty())
            .collect()
    };
    prefix_specs.sort_by_key(|b| std::cmp::Reverse(b.len()));

    let mut hits: Vec<(usize, usize, Value, f64)> = Vec::new();

    // 1. Number + Unit suffix matches (using cached `folded.digit_starts()` instead of DFA scan)
    let bytes = tf.as_bytes();
    for &n_start in folded.digit_starts() {
        let mut n_end = n_start + 1;
        while n_end < bytes.len() && bytes[n_end].is_ascii_digit() {
            n_end += 1;
        }
        if n_end + 1 < bytes.len()
            && (bytes[n_end] == b'.' || bytes[n_end] == b',')
            && bytes[n_end + 1].is_ascii_digit()
        {
            n_end += 2;
            while n_end < bytes.len() && bytes[n_end].is_ascii_digit() {
                n_end += 1;
            }
        }
        let after_num = &tf[n_end..];
        let ws_bytes = after_num.len() - after_num.trim_start_matches(' ').len();
        let unit_start = n_end + ws_bytes;
        if unit_start >= tf.len() {
            continue;
        }
        for (unit_str, mult) in &unit_specs {
            let unit_end = unit_start + unit_str.len();
            if unit_end <= tf.len() && tf[unit_start..].starts_with(unit_str.as_str()) {
                let right_ok = unit_end == tf.len()
                    || !tf[unit_end..]
                        .chars()
                        .next()
                        .map(|c| c.is_alphanumeric())
                        .unwrap_or(false);
                if right_ok {
                    if let Some(base) = parse_float(&tf[n_start..n_end]) {
                        if !overlaps(&hits, n_start, unit_end) {
                            let scaled = base * (*mult);
                            if let Some(jv) = number_to_json_value(scaled) {
                                hits.push((n_start, unit_end, jv, 0.93));
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    // 2. Prefix cue + Number matches (e.g. "đời 2019", "sx 2021")
    for prefix in &prefix_specs {
        let mut from = 0usize;
        while let Some(rel) = tf[from..].find(prefix.as_str()) {
            let p_start = from + rel;
            let p_end = p_start + prefix.len();
            let left_ok = p_start == 0
                || !tf[..p_start]
                    .chars()
                    .next_back()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false);
            let right_sep = p_end < tf.len()
                && !tf[p_end..]
                    .chars()
                    .next()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(true);
            if left_ok && right_sep {
                let rest = &tf[p_end..];
                let trimmed = rest.trim_start_matches([' ', ':', '-', '.']);
                let skip = rest.len() - trimmed.len();
                if let Some(nm) = NUM_TOKEN_RE.find(trimmed) {
                    if nm.start() == 0 {
                        let full_end = p_end + skip + nm.end();
                        let end_ok = full_end == tf.len()
                            || !tf[full_end..]
                                .chars()
                                .next()
                                .map(|c| c.is_alphanumeric())
                                .unwrap_or(false);
                        if end_ok && !overlaps(&hits, p_start, full_end) {
                            if let Some(val) = parse_float(nm.as_str()) {
                                if let Some(jv) = number_to_json_value(val) {
                                    hits.push((p_start, full_end, jv, 0.92));
                                }
                            }
                        }
                    }
                }
            }
            let step = tf[p_start..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(1);
            from = p_start + step;
        }
    }

    hits.sort_by_key(|h| h.0);
    hits.into_iter()
        .filter_map(|(s, e, val, conf)| {
            let (ns, ne) = folded.map_span(s, e)?;
            Some(ExtractionMatch {
                value: val,
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: conf,
            })
        })
        .collect()
}

/// Parse a standalone `raw` snippet for `FieldType::Number` renormalization:
/// runs `extract_number` first, and falls back to parsing a bare numeric literal (`"42"` -> `42`).
pub fn parse_standalone_number(raw: &str) -> Option<Value> {
    let matches = extract_number(raw, &NumberExtractorConfig::default());
    if let Some(first) = matches.into_iter().next() {
        return Some(first.value);
    }
    let folded = fold_text(raw);
    let caps = PLAIN_NUMBER_RE.captures(&folded)?;
    let f = parse_float(caps.name("n")?.as_str())?;
    let sign = if folded.trim_start().starts_with('-') {
        -1.0
    } else {
        1.0
    };
    number_to_json_value(sign * f)
}

fn builtin_unit_multiplier(folded_unit: &str) -> f64 {
    if folded_unit == "van" || folded_unit.starts_with("van ") {
        10_000.0
    } else if folded_unit == "nghin"
        || folded_unit.starts_with("nghin ")
        || folded_unit == "ngan"
        || folded_unit.starts_with("ngan ")
    {
        1_000.0
    } else {
        1.0
    }
}

fn parse_float(s: &str) -> Option<f64> {
    s.replace(',', ".").parse::<f64>().ok()
}

pub(crate) fn number_to_json_value(v: f64) -> Option<Value> {
    if !v.is_finite() {
        return None;
    }
    let rounded = v.round();
    if (v - rounded).abs() < 1e-9 && rounded >= (i64::MIN as f64) && rounded <= (i64::MAX as f64) {
        Some(Value::Number((rounded as i64).into()))
    } else {
        let clean = (v * 10_000.0).round() / 10_000.0;
        serde_json::Number::from_f64(clean).map(Value::Number)
    }
}

fn overlaps(existing: &[(usize, usize, Value, f64)], s: usize, e: usize) -> bool {
    existing.iter().any(|&(es, ee, _, _)| s < ee && e > es)
}
