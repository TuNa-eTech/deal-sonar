use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::extractors::{
    extract_date_vi, extract_gazetteer, extract_vn_area, extract_vn_money, extract_vn_phone,
    parse_standalone_number,
};
use crate::normalize::fold_text;
use crate::types::{
    ExtractedField, ExtractedFields, FieldDef, FieldType, FilterOp, HardFilter, LocationValue,
    WhenMissing,
};

/// Penalty subtracted from overall match score for each required field dropped due to failed
/// `raw` evidence verification (`05-pipeline-rules.md §8.1`).
pub const MISSING_REQUIRED_EVIDENCE_PENALTY: f64 = 0.2;

/// Outcome of renormalizing a single AI-extracted field (`05-pipeline-rules.md §8.2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenormalizeResult {
    /// Final normalized JSON value (built-in extractor wins on disagreement).
    pub value: Value,
    /// `true` when the built-in extractor produced a value differing from `ai_value`.
    pub overridden: bool,
    /// Multiplicative factor (`1.0` if unchanged, `0.75` if overridden) to apply to field confidence.
    pub confidence_factor: f64,
}

impl RenormalizeResult {
    /// Compute adjusted confidence in `[0.05, 1.0]`, strictly lowering confidence when overridden.
    pub fn apply_confidence(&self, original_confidence: f64) -> f64 {
        let clamped = original_confidence.clamp(0.0, 1.0);
        if self.overridden {
            (clamped * self.confidence_factor).clamp(0.05, (clamped - 0.05).max(0.05))
        } else {
            clamped
        }
    }
}

/// Combined result of running T6 steps 1 & 2 (`verify_evidence` + `renormalize_field`) across all fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostprocessFieldsResult {
    pub fields: ExtractedFields,
    pub dropped_keys: Vec<String>,
    pub dropped_required_count: usize,
    pub score_penalty: f64,
}

/// Behavioral signals for T6 step 3 peer-broker override (`05-pipeline-rules.md §8.3`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerSignals {
    /// Number of posts by this author in watched sources over the past 7 days (`>= 5` triggers signal).
    pub author_posts_7d: u32,
    /// Number of distinct sources where this post's dup cluster appeared (`>= 4` triggers signal).
    pub cluster_source_count: u32,
    /// Max number of distinct authors sharing any phone number found in this post (`>= 3` triggers signal).
    pub phone_distinct_authors: u32,
}

/// T6 step 5 lead disposition based on `score` and `notify.min_score` (`05-pipeline-rules.md §8.5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeadDisposition {
    /// `score >= min_score`: create lead and queue instant/digest notification.
    CreateAndNotify,
    /// `0.4 <= score < min_score`: create weak-match lead in Inbox without notification.
    CreateWeakOnly,
    /// `score < 0.4`: do not create lead.
    Discard,
}

/// T6 Step 1: Verify that `raw` actually appears as a case- and whitespace-insensitive substring
/// of `text_norm` (`05-pipeline-rules.md §8.1`, `03-risks-compliance.md §4`).
///
/// Rejects empty `raw` strings and any AI-hallucinated `raw` snippet not present in the post.
pub fn verify_evidence(text_norm: &str, raw: &str) -> bool {
    let needle = compact_for_evidence(raw);
    if needle.is_empty() {
        return false;
    }
    let haystack = compact_for_evidence(text_norm);
    haystack.contains(&needle)
}

fn compact_for_evidence(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.nfc() {
        if c.is_whitespace() || c.is_control() || is_invisible_evidence_char(c) {
            continue;
        }
        match c {
            '–' | '—' | '−' | '‒' | '―' => out.push('-'),
            '’' | '‘' => out.push('\''),
            '“' | '”' => out.push('"'),
            _ => {
                for lc in c.to_lowercase() {
                    out.push(lc);
                }
            }
        }
    }
    out
}

#[inline]
fn is_invisible_evidence_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
    )
}

/// T6 Step 2: Re-run the corresponding built-in extractor on `raw` (`05-pipeline-rules.md §8.2`).
///
/// If the built-in extractor produces a normalized value differing from `ai_value`,
/// the built-in extractor's value wins and `overridden = true` (`confidence_factor = 0.75`).
pub fn renormalize_field(
    field_def: &FieldDef,
    raw: &str,
    ai_value: &Value,
    ref_ts_ms: i64,
) -> RenormalizeResult {
    let extractor_value: Option<Value> = match field_def.r#type {
        FieldType::Money => extract_vn_money(raw, None, None)
            .into_iter()
            .next()
            .map(|m| m.value),
        FieldType::Phone => extract_vn_phone(raw).into_iter().next().map(|m| m.value),
        FieldType::Location => extract_gazetteer(raw, None)
            .into_iter()
            .next()
            .and_then(|m| {
                let mut loc: LocationValue = serde_json::from_value(m.value).ok()?;
                loc.raw = raw.trim().to_string();
                serde_json::to_value(loc).ok()
            }),
        FieldType::Range => extract_vn_area(raw).into_iter().next().map(|m| m.value),
        FieldType::Number => parse_standalone_number(raw),
        FieldType::Date => extract_date_vi(raw, ref_ts_ms)
            .into_iter()
            .next()
            .map(|m| m.value),
        FieldType::Enum => normalize_enum_option(ai_value, field_def.options.as_deref()),
        FieldType::MultiEnum => {
            normalize_multi_enum_options(ai_value, field_def.options.as_deref())
        }
        FieldType::Boolean | FieldType::Text | FieldType::Url => None,
    };

    if let Some(ext_val) = extractor_value {
        if values_equivalent(&ext_val, ai_value) {
            RenormalizeResult {
                value: ext_val,
                overridden: false,
                confidence_factor: 1.0,
            }
        } else {
            RenormalizeResult {
                value: ext_val,
                overridden: true,
                confidence_factor: 0.75,
            }
        }
    } else {
        RenormalizeResult {
            value: ai_value.clone(),
            overridden: false,
            confidence_factor: 1.0,
        }
    }
}

/// Convenience wrapper applying [`renormalize_field`] directly to an [`ExtractedField`],
/// lowering `confidence` when the built-in extractor overrides `field.value`.
pub fn renormalize_extracted_field(
    field_def: &FieldDef,
    field: &ExtractedField,
    ref_ts_ms: i64,
) -> ExtractedField {
    let res = renormalize_field(field_def, &field.raw, &field.value, ref_ts_ms);
    let new_conf = res.apply_confidence(field.confidence);
    ExtractedField {
        value: res.value,
        raw: field.raw.clone(),
        confidence: new_conf,
        source: field.source,
    }
}

/// Run T6 steps 1 (`verify_evidence`) and 2 (`renormalize_field`) across all candidate fields.
/// Drops hallucinated fields and accumulates the `0.2` score penalty for dropped required fields.
pub fn postprocess_fields(
    text_norm: &str,
    field_defs: &[FieldDef],
    candidate_fields: &ExtractedFields,
    ref_ts_ms: i64,
) -> PostprocessFieldsResult {
    let mut verified = ExtractedFields::new();
    let mut dropped_keys = Vec::new();
    let mut dropped_required_count = 0usize;

    for (key, field) in candidate_fields {
        let def_opt = field_defs.iter().find(|d| d.key == *key);
        if !verify_evidence(text_norm, &field.raw) {
            dropped_keys.push(key.clone());
            if def_opt.map(|d| d.required).unwrap_or(false) {
                dropped_required_count += 1;
            }
            continue;
        }
        let final_field = if let Some(def) = def_opt {
            renormalize_extracted_field(def, field, ref_ts_ms)
        } else {
            field.clone()
        };
        verified.insert(key.clone(), final_field);
    }

    let score_penalty = (dropped_required_count as f64) * MISSING_REQUIRED_EVIDENCE_PENALTY;
    PostprocessFieldsResult {
        fields: verified,
        dropped_keys,
        dropped_required_count,
        score_penalty,
    }
}

fn normalize_enum_option(ai_value: &Value, options: Option<&[String]>) -> Option<Value> {
    let opts = options?;
    let s = ai_value.as_str()?.trim();
    if opts.iter().any(|o| o == s) {
        return Some(Value::String(s.to_string()));
    }
    let s_fold = fold_text(s);
    opts.iter()
        .find(|o| fold_text(o) == s_fold)
        .map(|canonical| Value::String(canonical.clone()))
}

fn normalize_multi_enum_options(ai_value: &Value, options: Option<&[String]>) -> Option<Value> {
    let opts = options?;
    let arr = ai_value.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        if let Some(mapped) = normalize_enum_option(item, Some(opts)) {
            if !out.contains(&mapped) {
                out.push(mapped);
            }
        }
    }
    Some(Value::Array(out))
}

/// Semantic equality check between two normalized field JSON values (used by `renormalize_field`
/// and `evaluate_gate`). Treats `12000000` and `12000000.0` as equal, and compares structured
/// `LocationValue` fields (`province`, `district`, `ward`) cleanly.
pub fn values_equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(ba), Value::Bool(bb)) => ba == bb,
        (Value::Number(na), Value::Number(nb)) => match (na.as_f64(), nb.as_f64()) {
            (Some(fa), Some(fb)) => (fa - fb).abs() <= 1e-6 * fa.abs().max(fb.abs()).max(1.0),
            _ => na == nb,
        },
        (Value::String(sa), Value::String(sb)) => {
            sa.trim().eq_ignore_ascii_case(sb.trim()) || sa.trim() == sb.trim()
        }
        (Value::Array(aa), Value::Array(ab)) => {
            aa.len() == ab.len()
                && aa
                    .iter()
                    .zip(ab.iter())
                    .all(|(va, vb)| values_equivalent(va, vb))
        }
        (Value::Object(oa), Value::Object(ob)) => {
            // Location object check: if either has `province` or `district`, compare administrative fields
            let is_location = oa.contains_key("province")
                || oa.contains_key("district")
                || ob.contains_key("province")
                || ob.contains_key("district");
            if is_location {
                return opt_field_eq(oa.get("province"), ob.get("province"))
                    && opt_field_eq(oa.get("district"), ob.get("district"))
                    && opt_field_eq(oa.get("ward"), ob.get("ward"));
            }
            if oa.len() != ob.len() {
                return false;
            }
            oa.iter().all(|(k, va)| {
                ob.get(k)
                    .map(|vb| values_equivalent(va, vb))
                    .unwrap_or(false)
            })
        }
        _ => false,
    }
}

fn opt_field_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    let sa = a.and_then(|v| v.as_str()).map(fold_text);
    let sb = b.and_then(|v| v.as_str()).map(fold_text);
    sa == sb
}

/// T6 Step 4: Evaluate all `hard_filters` against `extracted_fields` (`05-pipeline-rules.md §8.4`).
///
/// Supports `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `between`, `contains`, `is_empty`,
/// plus `when_missing: "pass" | "fail"`.
pub fn evaluate_hard_filters(
    hard_filters: &[HardFilter],
    extracted_fields: &ExtractedFields,
) -> bool {
    hard_filters
        .iter()
        .all(|filter| evaluate_single_filter(filter, extracted_fields))
}

/// Evaluate a single [`HardFilter`] against `extracted_fields`.
pub fn evaluate_single_filter(filter: &HardFilter, extracted_fields: &ExtractedFields) -> bool {
    let field_val_opt = extracted_fields
        .get(&filter.field)
        .map(|ef| &ef.value)
        .filter(|v| !v.is_null());

    if matches!(filter.op, FilterOp::IsEmpty) {
        let is_empty = match field_val_opt {
            None => true,
            Some(v) => is_value_empty(v),
        };
        return match filter.value {
            Value::Bool(expected) => is_empty == expected,
            _ => is_empty,
        };
    }

    let Some(field_val) = field_val_opt else {
        return match filter.when_missing {
            WhenMissing::Pass => true,
            WhenMissing::Fail => false,
        };
    };

    compare_field_value(field_val, filter.op, &filter.value)
}

/// Compare an extracted JSON value against `target` using `op` (shared by `evaluate_hard_filters`
/// and DSL `Condition::FieldCmp`).
pub fn compare_field_value(field_val: &Value, op: FilterOp, target: &Value) -> bool {
    match op {
        FilterOp::IsEmpty => {
            let empty = is_value_empty(field_val);
            match target {
                Value::Bool(expected) => empty == *expected,
                _ => empty,
            }
        }
        FilterOp::Eq => value_matches_eq(field_val, target),
        FilterOp::Ne => !value_matches_eq(field_val, target),
        FilterOp::In => {
            let Some(targets) = target.as_array() else {
                return false;
            };
            if let Value::Array(items) = field_val {
                items
                    .iter()
                    .any(|item| targets.iter().any(|t| value_matches_eq(item, t)))
            } else {
                targets.iter().any(|t| value_matches_eq(field_val, t))
            }
        }
        FilterOp::Lt => compare_numeric_or_date(field_val, target, |vmin, vmax, t| {
            let _ = vmin;
            vmax < t
        }),
        FilterOp::Lte => compare_numeric_or_date(field_val, target, |vmin, vmax, t| {
            let _ = vmin;
            vmax <= t
        }),
        FilterOp::Gt => compare_numeric_or_date(field_val, target, |vmin, _vmax, t| vmin > t),
        FilterOp::Gte => compare_numeric_or_date(field_val, target, |vmin, _vmax, t| vmin >= t),
        FilterOp::Between => {
            let Some((lo_v, hi_v)) = extract_between_bounds(target) else {
                return false;
            };
            compare_numeric_or_date(field_val, lo_v, |vmin, _vmax, lo| vmin >= lo)
                && compare_numeric_or_date(field_val, hi_v, |_vmin, vmax, hi| vmax <= hi)
        }
        FilterOp::Contains => value_contains(field_val, target),
    }
}

fn is_value_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

fn value_matches_eq(field_val: &Value, target: &Value) -> bool {
    if let (Some((vmin, vmax)), Some(t)) = (extract_numeric_bounds(field_val), value_as_f64(target))
    {
        return (vmin - t).abs() <= 1e-6 && (vmax - t).abs() <= 1e-6;
    }
    if let (Value::Object(obj), Value::String(ts)) = (field_val, target) {
        let tf = fold_text(ts);
        if tf.is_empty() {
            return false;
        }
        for key in ["province", "district", "ward", "raw"] {
            if let Some(s) = obj.get(key).and_then(|v| v.as_str()) {
                if fold_text(s) == tf {
                    return true;
                }
            }
        }
        return false;
    }
    if let (Value::String(sa), Value::String(sb)) = (field_val, target) {
        return fold_text(sa) == fold_text(sb);
    }
    values_equivalent(field_val, target)
}

fn compare_numeric_or_date<F>(field_val: &Value, target: &Value, pred: F) -> bool
where
    F: FnOnce(f64, f64, f64) -> bool,
{
    if let (Some((vmin, vmax)), Some(t)) = (extract_numeric_bounds(field_val), value_as_f64(target))
    {
        return pred(vmin, vmax, t);
    }
    if let (Value::String(sa), Value::String(sb)) = (field_val, target) {
        // ISO 8601 date strings ("YYYY-MM-DD") compare chronologically via lexicographic order
        if is_iso_date_str(sa) && is_iso_date_str(sb) {
            let ord = sa.as_str().cmp(sb.as_str()) as i8 as f64;
            return pred(ord, ord, 0.0);
        }
    }
    false
}

fn is_iso_date_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn extract_numeric_bounds(v: &Value) -> Option<(f64, f64)> {
    if let Some(n) = value_as_f64(v) {
        return Some((n, n));
    }
    let obj = v.as_object()?;
    let min_v = obj.get("min").and_then(value_as_f64)?;
    let max_v = obj.get("max").and_then(value_as_f64)?;
    Some((min_v, max_v))
}

fn value_as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn extract_between_bounds(target: &Value) -> Option<(&Value, &Value)> {
    match target {
        Value::Array(arr) if arr.len() == 2 => Some((&arr[0], &arr[1])),
        Value::Object(obj) => Some((obj.get("min")?, obj.get("max")?)),
        _ => None,
    }
}

fn value_contains(field_val: &Value, target: &Value) -> bool {
    match field_val {
        Value::String(s) => {
            let Some(needle) = target.as_str() else {
                return false;
            };
            let nf = fold_text(needle);
            !nf.is_empty() && fold_text(s).contains(&nf)
        }
        Value::Array(items) => items
            .iter()
            .any(|item| value_matches_eq(item, target) || value_contains(item, target)),
        Value::Object(obj) => {
            let Some(needle) = target.as_str() else {
                return false;
            };
            let nf = fold_text(needle);
            if nf.is_empty() {
                return false;
            }
            ["raw", "province", "district", "ward"]
                .iter()
                .filter_map(|k| obj.get(*k).and_then(|v| v.as_str()))
                .any(|s| fold_text(s).contains(&nf))
        }
        _ => false,
    }
}

/// T6 Step 3: Check whether behavioral signals override `author_role` to `peer`
/// (`05-pipeline-rules.md §8.3`: 2 or more active signals -> `true`).
pub fn should_override_peer(signals: &PeerSignals) -> bool {
    let mut count = 0u8;
    if signals.author_posts_7d >= 5 {
        count += 1;
    }
    if signals.cluster_source_count >= 4 {
        count += 1;
    }
    if signals.phone_distinct_authors >= 3 {
        count += 1;
    }
    count >= 2
}

/// T6 Step 5: Classify lead creation & notification tier from `score` and `min_score` (`05-pipeline-rules.md §8.5`).
pub fn classify_lead_tier(score: f64, min_score: f64) -> LeadDisposition {
    let effective_min = min_score.max(0.4);
    if score >= effective_min {
        LeadDisposition::CreateAndNotify
    } else if score >= 0.4 {
        LeadDisposition::CreateWeakOnly
    } else {
        LeadDisposition::Discard
    }
}
