use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::prefilter::{has_alnum_at, has_alnum_before};
use crate::types::ExtractionMatch;

/// Open-addressed FNV-1a word table so `enum_kw` avoids `SipHash` overhead per candidate word.
#[derive(Debug, Clone)]
struct FastWordMap<V> {
    mask: usize,
    slots: Vec<Option<(String, V)>>,
}

impl<V> FastWordMap<V> {
    fn with_capacity(entries_len: usize) -> Self {
        let cap = (entries_len.saturating_mul(4)).next_power_of_two().max(16);
        let mut slots = Vec::with_capacity(cap);
        slots.resize_with(cap, || None);
        Self {
            mask: cap - 1,
            slots,
        }
    }

    #[inline(always)]
    fn hash_word(bytes: &[u8]) -> usize {
        let mut h = 0xcbf2_9ce4_8422_2325_u64;
        let mut i = 0usize;
        while i < bytes.len() {
            h = (h ^ (bytes[i] as u64)).wrapping_mul(0x0100_0000_01b3);
            i += 1;
        }
        (h ^ (h >> 32)) as usize
    }

    fn insert(&mut self, key: String, val: V) {
        let mut idx = Self::hash_word(key.as_bytes()) & self.mask;
        loop {
            match &mut self.slots[idx] {
                None => {
                    self.slots[idx] = Some((key, val));
                    return;
                }
                Some((k, existing)) if *k == key => {
                    *existing = val;
                    return;
                }
                Some(_) => {
                    idx = (idx + 1) & self.mask;
                }
            }
        }
    }

    #[inline(always)]
    fn get(&self, key: &str) -> Option<&V> {
        let kb = key.as_bytes();
        let mut idx = Self::hash_word(kb) & self.mask;
        loop {
            match &self.slots[idx] {
                None => return None,
                Some((k, v)) => {
                    if k.len() == kb.len() && k.as_bytes() == kb {
                        return Some(v);
                    }
                    idx = (idx + 1) & self.mask;
                }
            }
        }
    }
}

/// Pre-indexed folded keyword lookup table for fast single-pass `enum_kw` extraction.
#[derive(Debug, Clone)]
pub(crate) struct CompiledEnumPatterns {
    first_word_mask: [u64; 256],
    first_two_mask: [u128; 128],
    by_first_word: FastWordMap<Vec<(String, String)>>,
    has_first_words: bool,
    other: Vec<(String, String)>,
}

/// Pre-fold and index `(folded_keyword, enum_key)` pairs by first word (longest keyword first).
pub(crate) fn compile_enum_patterns(map: &BTreeMap<String, Vec<String>>) -> CompiledEnumPatterns {
    let mut raw_by_first_word: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut other: Vec<(String, String)> = Vec::new();

    for (enum_val, kws) in map {
        for kw in kws {
            let kf = fold_text(kw);
            if kf.is_empty() {
                continue;
            }
            let first_len = scan_alnum_prefix(&kf);
            if first_len > 0 {
                let first_tok = kf[..first_len].to_string();
                raw_by_first_word
                    .entry(first_tok)
                    .or_default()
                    .push((kf, enum_val.clone()));
            } else {
                other.push((kf, enum_val.clone()));
            }
        }
    }

    let mut first_word_mask = [0u64; 256];
    let mut first_two_mask = [0u128; 128];
    let has_first_words = !raw_by_first_word.is_empty();
    let mut by_first_word = FastWordMap::with_capacity(raw_by_first_word.len());
    for (word, mut bucket) in raw_by_first_word {
        let wb = word.as_bytes();
        if let Some(&b0) = wb.first() {
            first_word_mask[b0 as usize] |= 1u64 << word.len().min(63);
            if b0 < 128 {
                let b1 = wb.get(1).copied().unwrap_or(0);
                if b1 < 128 {
                    first_two_mask[b0 as usize] |= 1u128 << b1;
                }
            }
        }
        bucket.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));
        by_first_word.insert(word, bucket);
    }
    other.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));

    CompiledEnumPatterns {
        first_word_mask,
        first_two_mask,
        by_first_word,
        has_first_words,
        other,
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

/// Fast boolean keyword-set check reusing [`FoldedView::words`] without computing `text_norm` spans.
pub(crate) fn matches_any_enum_kw(
    folded: &FoldedView<'_>,
    patterns: &CompiledEnumPatterns,
) -> bool {
    let tf = folded.text_fold;
    if tf.is_empty() || (!patterns.has_first_words && patterns.other.is_empty()) {
        return false;
    }
    let bytes = tf.as_bytes();
    let len = bytes.len();

    if patterns.has_first_words {
        for &(ws_u32, we_u32) in folded.words() {
            let word_start = ws_u32 as usize;
            let word_end = we_u32 as usize;
            let wlen = word_end - word_start;
            let b0 = bytes[word_start];
            let wlen_bit = 1u64 << if wlen < 63 { wlen } else { 63 };
            if (patterns.first_word_mask[b0 as usize] & wlen_bit) == 0 {
                continue;
            }
            if b0 < 128 {
                let b1 = if wlen >= 2 { bytes[word_start + 1] } else { 0 };
                if b1 < 128 && (patterns.first_two_mask[b0 as usize] & (1u128 << b1)) == 0 {
                    continue;
                }
            }
            if let Some(candidates) = patterns.by_first_word.get(&tf[word_start..word_end]) {
                for (kw_fold, _) in candidates {
                    let end = word_start + kw_fold.len();
                    if end <= len && tf[word_start..].starts_with(kw_fold.as_str()) {
                        let check_right = has_alnum_before(kw_fold, kw_fold.len());
                        if !check_right || !has_alnum_at(tf, end) {
                            return true;
                        }
                    }
                }
            }
        }
    }

    patterns
        .other
        .iter()
        .any(|(kw_fold, _)| tf.contains(kw_fold.as_str()))
}

pub(crate) fn extract_enum_kw_compiled<'a>(
    text_norm: &str,
    folded: &FoldedView<'_>,
    patterns: &'a CompiledEnumPatterns,
    multi: bool,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    if tf.is_empty() || (!patterns.has_first_words && patterns.other.is_empty()) {
        return Vec::new();
    }

    let mut chosen: Vec<(usize, usize, &'a str)> = Vec::new();
    let bytes = tf.as_bytes();
    let len = bytes.len();

    if patterns.has_first_words {
        let mut skip_until = 0usize;
        for &(ws_u32, we_u32) in folded.words() {
            let word_start = ws_u32 as usize;
            if word_start < skip_until {
                continue;
            }
            let word_end = we_u32 as usize;
            let wlen = word_end - word_start;
            let b0 = bytes[word_start];
            let wlen_bit = 1u64 << if wlen < 63 { wlen } else { 63 };
            if (patterns.first_word_mask[b0 as usize] & wlen_bit) == 0 {
                continue;
            }
            if b0 < 128 {
                let b1 = if wlen >= 2 { bytes[word_start + 1] } else { 0 };
                if b1 < 128 && (patterns.first_two_mask[b0 as usize] & (1u128 << b1)) == 0 {
                    continue;
                }
            }
            if let Some(candidates) = patterns.by_first_word.get(&tf[word_start..word_end]) {
                for (kw_fold, enum_val) in candidates {
                    let end = word_start + kw_fold.len();
                    if end <= len && tf[word_start..].starts_with(kw_fold.as_str()) {
                        let check_right = has_alnum_before(kw_fold, kw_fold.len());
                        if !check_right || !has_alnum_at(tf, end) {
                            chosen.push((word_start, end, enum_val.as_str()));
                            skip_until = end;
                            break;
                        }
                    }
                }
                if !chosen.is_empty() && !multi && first_only && patterns.other.is_empty() {
                    break;
                }
            }
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
