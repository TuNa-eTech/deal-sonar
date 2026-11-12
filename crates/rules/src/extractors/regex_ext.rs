use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::extractors::number::number_to_json_value;
use crate::normalize::{fold_with_spans, FoldedView};
use crate::types::ExtractionMatch;

/// Maximum allowed regex pattern length in characters (`03-risks-compliance.md §4`).
pub const MAX_REGEX_PATTERN_LEN: usize = 512;
/// Maximum compiled NFA/DFA size in bytes for user/AI-supplied regexes (`03-risks-compliance.md §4`).
pub const REGEX_COMPILED_SIZE_LIMIT: usize = 256 * 1024;
/// Maximum bounded quantifier count `{N}` allowed in a DSL regex.
pub const MAX_REGEX_BOUNDED_REPEAT: u32 = 120;

/// Type cast applied to the captured group of a `regex` extractor (`05-pipeline-rules.md §6.2`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegexCast {
    #[default]
    String,
    Int,
    Float,
    Bool,
}

/// Errors produced when validating or compiling a DSL regular expression.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RegexSafetyError {
    #[error("regex pattern must not be empty")]
    EmptyPattern,
    #[error("regex pattern length {0} exceeds limit of {MAX_REGEX_PATTERN_LEN} bytes")]
    PatternTooLong(usize),
    #[error("regex pattern contains nested repetition quantifiers (`06-ai-bridge.md §5.3`)")]
    NestedQuantifier,
    #[error("regex pattern contains excessive bounded repetition `{{{0}}}` (max {MAX_REGEX_BOUNDED_REPEAT})")]
    ExcessiveRepetition(u32),
    #[error("capture group {group} out of bounds for regex with {max_group} groups")]
    InvalidCaptureGroup { group: usize, max_group: usize },
    #[error("failed to compile linear-time regex: {0}")]
    Compile(String),
}

/// Compile a regex safely using the linear-time Rust `regex` engine with strict size/complexity caps.
pub fn compile_safe_regex(pattern: &str) -> Result<Regex, RegexSafetyError> {
    check_regex_pattern_safety(pattern)?;
    // Folded Vietnamese patterns are pure ASCII (`06-ai-bridge.md §5.3`). Compiling ASCII patterns
    // with `unicode(false)` keeps `\d`, `\s`, `\w`, and `\b` inside the 1-byte Lazy DFA instead of
    // Unicode `\b` NFA fallback; if the pattern uses Unicode `\p{...}` properties or non-ASCII chars,
    // we transparently compile with `unicode(true)`.
    if pattern.is_ascii() {
        if let Ok(re) = RegexBuilder::new(pattern)
            .case_insensitive(true)
            .unicode(false)
            .size_limit(REGEX_COMPILED_SIZE_LIMIT)
            .dfa_size_limit(REGEX_COMPILED_SIZE_LIMIT)
            .build()
        {
            return Ok(re);
        }
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .unicode(true)
        .size_limit(REGEX_COMPILED_SIZE_LIMIT)
        .dfa_size_limit(REGEX_COMPILED_SIZE_LIMIT)
        .build()
        .map_err(|e| RegexSafetyError::Compile(e.to_string()))
}

/// Inspect a regex string for emptiness, length limits, oversized `{m,n}` bounds,
/// and nested repetition quantifiers (`(a+)+`, `(.*)+`, etc.).
pub fn check_regex_pattern_safety(pattern: &str) -> Result<(), RegexSafetyError> {
    if pattern.is_empty() {
        return Err(RegexSafetyError::EmptyPattern);
    }
    if pattern.len() > MAX_REGEX_PATTERN_LEN {
        return Err(RegexSafetyError::PatternTooLong(pattern.len()));
    }

    // Track group stack: each entry records whether the group currently contains an inner repetition quantifier.
    let mut group_has_quantifier: Vec<bool> = Vec::new();
    let mut in_char_class = false;
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            i += 2;
            continue;
        }
        if in_char_class {
            if ch == ']' {
                in_char_class = false;
            }
            i += 1;
            continue;
        }
        match ch {
            '[' => {
                in_char_class = true;
                i += 1;
            }
            '(' => {
                group_has_quantifier.push(false);
                i += 1;
            }
            ')' => {
                let inner_quantified = group_has_quantifier.pop().unwrap_or(false);
                // Check if this closing group is immediately followed by a repetition quantifier
                if let Some((is_repeat, max_bound)) = peek_quantifier(&chars, i + 1) {
                    if let Some(bound) = max_bound {
                        if bound > MAX_REGEX_BOUNDED_REPEAT {
                            return Err(RegexSafetyError::ExcessiveRepetition(bound));
                        }
                    }
                    if is_repeat && inner_quantified {
                        return Err(RegexSafetyError::NestedQuantifier);
                    }
                    if is_repeat {
                        if let Some(parent) = group_has_quantifier.last_mut() {
                            *parent = true;
                        }
                    }
                } else if inner_quantified {
                    if let Some(parent) = group_has_quantifier.last_mut() {
                        *parent = true;
                    }
                }
                i += 1;
            }
            '*' | '+' => {
                if let Some(top) = group_has_quantifier.last_mut() {
                    *top = true;
                }
                i += 1;
            }
            '{' => {
                if let Some((is_repeat, max_bound)) = peek_quantifier(&chars, i) {
                    if let Some(bound) = max_bound {
                        if bound > MAX_REGEX_BOUNDED_REPEAT {
                            return Err(RegexSafetyError::ExcessiveRepetition(bound));
                        }
                    }
                    if is_repeat {
                        if let Some(top) = group_has_quantifier.last_mut() {
                            *top = true;
                        }
                    }
                }
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    Ok(())
}

/// Inspect `chars[idx..]` for a quantifier (`*`, `+`, `?`, `{m}`, `{m,}`, `{m,n}`).
/// Returns `Some((is_unbounded_or_gt1_repeat, optional_max_finite_bound))`.
fn peek_quantifier(chars: &[char], idx: usize) -> Option<(bool, Option<u32>)> {
    let ch = *chars.get(idx)?;
    match ch {
        '*' | '+' => Some((true, None)),
        '?' => Some((false, Some(1))),
        '{' => {
            let mut end = idx + 1;
            while end < chars.len() && chars[end] != '}' {
                if !chars[end].is_ascii_digit() && chars[end] != ',' {
                    return None;
                }
                end += 1;
            }
            if end >= chars.len() || end == idx + 1 {
                return None;
            }
            let inside: String = chars[idx + 1..end].iter().collect();
            if let Some((lo_s, hi_s)) = inside.split_once(',') {
                let lo = lo_s.parse::<u32>().ok().unwrap_or(0);
                if hi_s.is_empty() {
                    // `{m,}` is unbounded!
                    Some((true, Some(lo)))
                } else {
                    let hi = hi_s.parse::<u32>().ok()?;
                    let max_b = lo.max(hi);
                    Some((max_b > 1, Some(max_b)))
                }
            } else {
                let exact = inside.parse::<u32>().ok()?;
                Some((exact > 1, Some(exact)))
            }
        }
        _ => None,
    }
}

/// Run a safe `regex` extraction on `text_norm` (with automatic fallback to `text_fold` mapped
/// back to `text_norm` spans when the pattern is written in folded ASCII, per `06-ai-bridge.md §5.3`).
pub fn extract_regex(
    text_norm: &str,
    pattern: &str,
    group: usize,
    cast: RegexCast,
) -> Result<Vec<ExtractionMatch>, RegexSafetyError> {
    let compiled = compile_safe_regex(pattern)?;
    let max_group = compiled.captures_len().saturating_sub(1);
    if group > max_group {
        return Err(RegexSafetyError::InvalidCaptureGroup { group, max_group });
    }
    let folded = fold_with_spans(text_norm);
    Ok(extract_compiled_regex(
        text_norm,
        &folded.as_view(text_norm),
        &compiled,
        group,
        cast,
    ))
}

pub(crate) fn extract_compiled_regex(
    text_norm: &str,
    folded: &FoldedView<'_>,
    regex: &Regex,
    group: usize,
    cast: RegexCast,
) -> Vec<ExtractionMatch> {
    extract_compiled_regex_impl(text_norm, folded, regex, group, cast, false)
}

pub(crate) fn extract_compiled_regex_first(
    text_norm: &str,
    folded: &FoldedView<'_>,
    regex: &Regex,
    group: usize,
    cast: RegexCast,
) -> Option<ExtractionMatch> {
    extract_compiled_regex_impl(text_norm, folded, regex, group, cast, true)
        .into_iter()
        .next()
}

fn extract_compiled_regex_impl(
    text_norm: &str,
    folded: &FoldedView<'_>,
    regex: &Regex,
    group: usize,
    cast: RegexCast,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }

    // Match on `folded.text_fold` first (DSL patterns are folded ASCII per `06-ai-bridge.md §5.3`),
    // using `find_iter` (1-byte Lazy DFA) and only running `captures` on the tiny matched slice!
    let tf = folded.text_fold;
    let mut out = Vec::new();
    for m0 in regex.find_iter(tf) {
        let Some((ns, ne)) = folded.map_span(m0.start(), m0.end()) else {
            continue;
        };
        let cap_text = if group == 0 {
            &text_norm[ns..ne]
        } else if let Some(caps) = regex.captures(m0.as_str()) {
            let Some(mg) = caps.get(group) else {
                continue;
            };
            let g_start = m0.start() + mg.start();
            let g_end = m0.start() + mg.end();
            if let Some((gs, ge)) = folded.map_span(g_start, g_end) {
                &text_norm[gs..ge]
            } else {
                mg.as_str()
            }
        } else {
            let win_s = m0.start().saturating_sub(1);
            let win_e = (m0.end() + 1).min(tf.len());
            let Some(caps) = regex.captures(&tf[win_s..win_e]) else {
                continue;
            };
            let Some(mg) = caps.get(group) else {
                continue;
            };
            let g_start = win_s + mg.start();
            let g_end = win_s + mg.end();
            if let Some((gs, ge)) = folded.map_span(g_start, g_end) {
                &text_norm[gs..ge]
            } else {
                mg.as_str()
            }
        };
        if let Some(val) = cast_capture(cap_text, cast) {
            out.push(ExtractionMatch {
                value: val,
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: 0.90,
            });
            if first_only {
                return out;
            }
        }
    }
    if !out.is_empty() || regex.as_str().is_ascii() {
        return out;
    }

    // Fallback for patterns containing explicit accented Unicode characters
    for m0 in regex.find_iter(text_norm) {
        let cap_text = if group == 0 {
            m0.as_str()
        } else {
            let Some(caps) = regex.captures(m0.as_str()) else {
                continue;
            };
            let Some(mg) = caps.get(group) else {
                continue;
            };
            mg.as_str()
        };
        if let Some(val) = cast_capture(cap_text, cast) {
            out.push(ExtractionMatch {
                value: val,
                raw: m0.as_str().to_string(),
                start: m0.start(),
                end: m0.end(),
                confidence: 0.90,
            });
            if first_only {
                return out;
            }
        }
    }

    out
}

fn cast_capture(s: &str, cast: RegexCast) -> Option<Value> {
    let trimmed = s.trim();
    match cast {
        RegexCast::String => Some(Value::String(trimmed.to_string())),
        RegexCast::Int => {
            let cleaned: String = trimmed
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            let v: i64 = cleaned.parse().ok()?;
            Some(Value::Number(v.into()))
        }
        RegexCast::Float => {
            let normalized = trimmed.replace(',', ".");
            let v: f64 = normalized.parse().ok()?;
            number_to_json_value(v)
        }
        RegexCast::Bool => {
            let lower = trimmed.to_ascii_lowercase();
            let b = !matches!(
                lower.as_str(),
                "" | "false" | "0" | "no" | "khong" | "không"
            );
            Some(Value::Bool(b))
        }
    }
}
