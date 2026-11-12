use std::collections::{BTreeMap, HashMap};

use regex::{Regex, RegexBuilder};
use serde_json::Value;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::prefilter::{has_alnum_at, has_alnum_before};
use crate::types::ExtractionMatch;

/// Pre-indexed folded keyword lookup table for fast single-pass `enum_kw` extraction.
#[derive(Debug, Clone)]
pub(crate) struct CompiledEnumPatterns {
    first_word_mask: [u64; 256],
    by_first_word: HashMap<String, Vec<(String, String)>>,
    other: Vec<(String, String)>,
    fast_filters: Vec<Regex>,
}

/// Pre-fold and index `(folded_keyword, enum_key)` pairs by first word (longest keyword first).
pub(crate) fn compile_enum_patterns(map: &BTreeMap<String, Vec<String>>) -> CompiledEnumPatterns {
    let mut by_first_word: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut other: Vec<(String, String)> = Vec::new();
    let mut all_folded: Vec<String> = Vec::new();

    for (enum_val, kws) in map {
        for kw in kws {
            let kf = fold_text(kw);
            if kf.is_empty() {
                continue;
            }
            all_folded.push(kf.clone());
            let first_len = scan_alnum_prefix(&kf);
            if first_len > 0 {
                let first_tok = kf[..first_len].to_string();
                by_first_word
                    .entry(first_tok)
                    .or_default()
                    .push((kf, enum_val.clone()));
            } else {
                other.push((kf, enum_val.clone()));
            }
        }
    }

    let mut first_word_mask = [0u64; 256];
    for (word, bucket) in &mut by_first_word {
        if let Some(&b0) = word.as_bytes().first() {
            first_word_mask[b0 as usize] |= 1u64 << word.len().min(63);
        }
        bucket.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));
    }
    other.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));

    // Chunk literal alternations into groups of <= 10 so `regex-automata` always uses SIMD Teddy!
    let mut fast_filters = Vec::new();
    if all_folded.len() >= 2 && all_folded.iter().all(|s| s.is_ascii()) {
        for chunk in all_folded.chunks(10) {
            let pat = chunk
                .iter()
                .map(|s| regex::escape(s))
                .collect::<Vec<_>>()
                .join("|");
            if let Ok(re) = RegexBuilder::new(&pat)
                .unicode(false)
                .size_limit(512 * 1024)
                .dfa_size_limit(512 * 1024)
                .build()
            {
                fast_filters.push(re);
            } else {
                fast_filters.clear();
                break;
            }
        }
    }

    CompiledEnumPatterns {
        first_word_mask,
        by_first_word,
        other,
        fast_filters,
    }
}

fn scan_alnum_prefix(s: &str) -> usize {
    let bytes = s.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        let b = bytes[idx];
        if b < 0x80 {
            if b.is_ascii_alphanumeric() {
                idx += 1;
            } else {
                break;
            }
        } else if let Some(ch) = s[idx..].chars().next() {
            if ch.is_alphanumeric() {
                idx += ch.len_utf8();
            } else {
                break;
            }
        } else {
            break;
        }
    }
    idx
}

/// Extract enum values using a folded keyword -> enum key map (`05-pipeline-rules.md §6.3`).
pub fn extract_enum_kw(
    text_norm: &str,
    map: &BTreeMap<String, Vec<String>>,
    multi: bool,
) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() || map.is_empty() {
        return Vec::new();
    }
    let patterns = compile_enum_patterns(map);
    let folded = fold_with_spans(text_norm);
    extract_enum_kw_compiled(
        text_norm,
        &folded.as_view(text_norm),
        &patterns,
        multi,
        false,
    )
}

pub(crate) fn extract_enum_kw_compiled<'a>(
    text_norm: &str,
    folded: &FoldedView<'_>,
    patterns: &'a CompiledEnumPatterns,
    multi: bool,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    if tf.is_empty() || (patterns.by_first_word.is_empty() && patterns.other.is_empty()) {
        return Vec::new();
    }
    if !patterns.fast_filters.is_empty() && !patterns.fast_filters.iter().any(|re| re.is_match(tf))
    {
        return Vec::new();
    }

    let mut chosen: Vec<(usize, usize, &'a str)> = Vec::new();
    let bytes = tf.as_bytes();
    let mut pos = 0usize;

    while pos < bytes.len() {
        let b = bytes[pos];
        let is_alnum = if b < 0x80 {
            b.is_ascii_alphanumeric()
        } else {
            tf[pos..]
                .chars()
                .next()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false)
        };

        if is_alnum && !has_alnum_before(tf, pos) {
            let tok_len = scan_alnum_prefix(&tf[pos..]);
            let first_tok = &tf[pos..pos + tok_len];
            let wlen_bit = 1u64 << first_tok.len().min(63);
            let candidates_opt = ((patterns.first_word_mask[b as usize] & wlen_bit) != 0)
                .then(|| patterns.by_first_word.get(first_tok))
                .flatten();
            if let Some(candidates) = candidates_opt {
                let mut matched = false;
                for (kw_fold, enum_val) in candidates {
                    let end = pos + kw_fold.len();
                    if end <= tf.len() && tf[pos..].starts_with(kw_fold.as_str()) {
                        let check_right = has_alnum_before(kw_fold, kw_fold.len());
                        if !check_right || !has_alnum_at(tf, end) {
                            chosen.push((pos, end, enum_val.as_str()));
                            pos = end;
                            matched = true;
                            if !multi && first_only && patterns.other.is_empty() {
                                break;
                            }
                            break;
                        }
                    }
                }
                if matched {
                    if !multi && first_only && patterns.other.is_empty() {
                        break;
                    }
                    continue;
                }
            }
            pos += tok_len;
        } else if b < 0x80 {
            pos += 1;
        } else {
            pos += tf[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }

    for (kw_fold, enum_val) in &patterns.other {
        let mut from = 0usize;
        while let Some(rel) = tf[from..].find(kw_fold.as_str()) {
            let start = from + rel;
            let end = start + kw_fold.len();
            if !chosen.iter().any(|(cs, ce, _)| start < *ce && end > *cs) {
                chosen.push((start, end, enum_val.as_str()));
                if !multi {
                    break;
                }
            }
            from = start + 1;
        }
    }

    if chosen.is_empty() {
        return Vec::new();
    }

    chosen.sort_by_key(|c| c.0);

    if multi {
        let mut distinct_vals: Vec<Value> = Vec::new();
        let mut first_span: Option<(usize, usize)> = None;
        for (s, e, val) in chosen {
            if let Some((ns, ne)) = folded.map_span(s, e) {
                if first_span.is_none() {
                    first_span = Some((ns, ne));
                }
                let jv = Value::String(val.to_string());
                if !distinct_vals.contains(&jv) {
                    distinct_vals.push(jv);
                }
            }
        }
        if let Some((ns, ne)) = first_span {
            return vec![ExtractionMatch {
                value: Value::Array(distinct_vals),
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: 0.90,
            }];
        }
        return Vec::new();
    }

    chosen
        .into_iter()
        .filter_map(|(s, e, val)| {
            let (ns, ne) = folded.map_span(s, e)?;
            Some(ExtractionMatch {
                value: Value::String(val.to_string()),
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: 0.92,
            })
        })
        .collect()
}
