use std::sync::LazyLock;

use regex::Regex;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::types::{ExtractionMatch, MoneyPeriod, MoneyValue};

/// Default character window for `near` keyword filtering (`05-pipeline-rules.md §6.2`).
pub const DEFAULT_MONEY_WINDOW: usize = 40;

// Matches Vietnamese money amounts & ranges in `text_fold`:
// Examples:
// - "tầm 12 - 15 triệu/tháng" -> folded "tam 12 - 15 trieu/thang"
// - "12-15tr/th"
// - "dưới 400 triệu" -> folded "duoi 400 trieu"
// - "3tr5", "2 tỷ 3", "15 củ", "500k", "1.2 tỉ", "25tr/năm", "15.000.000đ"
// - "từ 800 triệu đến 1.2 tỷ"
// Digit-anchored regexes so the linear-time engine uses SIMD byte literal scan on `\d`
// rather than evaluating optional keyword prefixes at every byte of long posts!
static MONEY_COMPOUND_RANGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^(?x)
        (?P<n1>\d+(?:[.,]\d+)?)
        (?:\s*(?P<u1>ty|ti|toi|trieu|tr|cu|lit|nghin|ngan|ka|k)(?:\s*(?P<f1>\d{1,3}))?)?
        \s*(?:-|den|toi|~)\s*
        (?P<n2>\d+(?:[.,]\d+)?)
        \s*(?P<u2>ty|ti|toi|trieu|tr|cu|lit|nghin|ngan|ka|k)
        (?:\s*(?P<f2>\d{1,3})(?:\s*(?P<sub2>trieu|tr|nghin|ngan|k))?)?
        (?P<period>\s*(?:/\s*(?:thang|thg|th|month|mo|nam|yr|year|ngay|dem|day)|(?:moi|1|mot)\s+(?:thang|nam|ngay|dem)))?
        \b
        ",
    )
    .expect("valid money compound range regex")
});

static MONEY_SINGLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^(?x)
        (?P<n>\d+(?:[.,]\d+)?)
        \s*(?P<u>ty|ti|toi|trieu|tr|cu|lit|nghin|ngan|ka|k)
        (?:\s*(?P<f>\d{1,3})(?:\s*(?P<sub>trieu|tr|nghin|ngan|k))?)?
        (?P<period>\s*(?:/\s*(?:thang|thg|th|month|mo|nam|yr|year|ngay|dem|day)|(?:moi|1|mot)\s+(?:thang|nam|ngay|dem)))?
        \b
        ",
    )
    .expect("valid money single regex")
});

static MONEY_GROUPED_VND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^(?x)
        (?P<n>\d{1,3}(?:[.,]\d{3})+|\d{5,12})
        \s*(?P<u>vnd|dong|d)
        (?P<period>\s*(?:/\s*(?:thang|thg|th|month|mo|nam|yr|year|ngay|dem|day)|(?:moi|1|mot)\s+(?:thang|nam|ngay|dem)))?
        \b
        ",
    )
    .expect("valid grouped vnd regex")
});

static NON_MONEY_NOUN_AFTER_DIGIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^\s*(?:pn|p\.ngu|phong|ngu|tang|lau|m2|m\b|met|wc|ve\s+sinh|nguoi|cho|suat|tan|kg|km|nam\b|thang\b|ngay\b|gio\b|h\b|%)",
    )
    .expect("valid non-money noun regex")
});

/// Extract Vietnamese money amounts and ranges from `text_norm` (`05-pipeline-rules.md §6.3`).
///
/// When `near` is non-empty, only returns matches within `window` characters of at least
/// one `near` keyword, ordered by proximity to the nearest keyword.
pub fn extract_vn_money(
    text_norm: &str,
    near: Option<&[String]>,
    window: Option<usize>,
) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }
    let folded = fold_with_spans(text_norm);
    let near_folded: Vec<String> = near
        .unwrap_or(&[])
        .iter()
        .map(|s| fold_text(s))
        .filter(|s| !s.is_empty())
        .collect();
    extract_vn_money_from_folded(
        text_norm,
        &folded.as_view(text_norm),
        &near_folded,
        window,
        false,
    )
}

pub(crate) fn extract_vn_money_from_folded(
    text_norm: &str,
    folded: &FoldedView<'_>,
    near_folded: &[String],
    window: Option<usize>,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    let bytes = tf.as_bytes();
    let len = bytes.len();
    if len < 2 {
        return Vec::new();
    }

    let mut raw_candidates: Vec<(usize, usize, MoneyValue, f64)> = Vec::new();
    let win = window.unwrap_or(DEFAULT_MONEY_WINDOW);
    let max_kw_bytes = near_folded.iter().map(|s| s.len()).max().unwrap_or(0);

    let mut min_pos = 0usize;
    for &base in folded.digit_starts() {
        if base < min_pos {
            continue;
        }

        let tail_end = floor_utf8_boundary(tf, (base + 128).min(len));
        let tail = &tf[base..tail_end];

        // Fast 2-byte guard: skip numbers not followed by a money unit or range connector
        let num_tok_len = skip_grouped_or_decimal_number(tail.as_bytes());
        let mut ws_idx = num_tok_len;
        let tail_bytes = tail.as_bytes();
        while ws_idx < tail_bytes.len() && tail_bytes[ws_idx] == b' ' {
            ws_idx += 1;
        }
        let after_slice = &tail_bytes[ws_idx..];
        let b0 = after_slice.first().copied().unwrap_or(0);
        let b1 = after_slice.get(1).copied().unwrap_or(0);
        let b2 = after_slice.get(2).copied().unwrap_or(0);

        let is_unit_prefix = match b0 {
            // ty, ti, toi, tr, trieu (rejects "tre", "trong", "tren", "tinh", "thanh")
            b't' => {
                ((b1 == b'y' || b1 == b'i') && !b2.is_ascii_alphabetic())
                    || (b1 == b'o' && b2 == b'i')
                    || (b1 == b'r' && (b2 == b'i' || !b2.is_ascii_alphabetic()))
            }
            b'c' => b1 == b'u' && !b2.is_ascii_alphabetic(), // cu (rejects "cua", "cung")
            b'l' => b1 == b'i' && b2 == b't',                // lit
            b'n' => b1 == b'g' && (b2 == b'h' || b2 == b'a'), // nghin, ngan (rejects "nguoi", "ngay")
            b'k' => (b1 == b'a' && !b2.is_ascii_alphabetic()) || !b1.is_ascii_alphanumeric(), // ka, k
            _ => false,
        };
        let is_range_connector = b0 == b'-'
            || b0 == b'~'
            || after_slice.starts_with(b"den ")
            || after_slice.starts_with(b"toi ");
        let is_vnd_prefix = num_tok_len >= 5
            && ((b0 == b'v' && b1 == b'n')
                || (b0 == b'd' && (b1 == b'o' || !b1.is_ascii_alphanumeric())));

        if !is_unit_prefix && !is_range_connector && !is_vnd_prefix {
            min_pos = base + num_tok_len.max(1);
            continue;
        }

        let after_str = &tail[ws_idx..];
        let can_have_range = is_range_connector
            || (is_unit_prefix
                && (after_slice.contains(&b'-')
                    || after_slice.contains(&b'~')
                    || after_str.contains(" den ")
                    || after_str.contains(" toi ")));

        // 1. Compound ranges ("12 - 15tr/th", "từ 800 triệu đến 1.2 tỷ")
        if can_have_range && MONEY_COMPOUND_RANGE_RE.is_match(tail) {
            if let Some(caps) = MONEY_COMPOUND_RANGE_RE.captures(tail) {
                let m0 = caps.get(0).unwrap();
                let full_end = base + m0.end();
                if !crate::prefilter::has_alnum_at(tf, full_end) {
                    let u2_str = caps.name("u2").unwrap().as_str();
                    let mult2 = unit_multiplier(u2_str);
                    let mult1 = caps
                        .name("u1")
                        .map(|cm| unit_multiplier(cm.as_str()))
                        .unwrap_or(mult2);

                    if let (Some(n1), Some(n2)) = (
                        parse_decimal_num(caps.name("n1").unwrap().as_str()),
                        parse_decimal_num(caps.name("n2").unwrap().as_str()),
                    ) {
                        let f1_str = caps.name("f1").map(|cm| cm.as_str());
                        let amount1 = compute_unit_amount(
                            caps.name("n1").unwrap().as_str(),
                            n1,
                            mult1,
                            f1_str,
                            None,
                            true,
                        );

                        let mut end_fold = full_end;
                        let mut f2_opt = caps.name("f2").map(|cm| cm.as_str());
                        let sub2_opt = caps.name("sub2").map(|cm| cm.as_str());
                        if let Some(f2_m) = caps.name("f2") {
                            let u2_end = base + caps.name("u2").unwrap().end();
                            let had_space = (base + f2_m.start()) > u2_end;
                            let f2_end = base + f2_m.end();
                            if had_space
                                && sub2_opt.is_none()
                                && NON_MONEY_NOUN_AFTER_DIGIT_RE.is_match(&tf[f2_end..])
                            {
                                f2_opt = None;
                                if caps.name("period").is_none() {
                                    end_fold = u2_end;
                                }
                            }
                        }
                        let amount2 = compute_unit_amount(
                            caps.name("n2").unwrap().as_str(),
                            n2,
                            mult2,
                            f2_opt,
                            sub2_opt,
                            true,
                        );

                        if amount1 > 0 && amount2 > 0 {
                            let (min_v, max_v) = if amount1 <= amount2 {
                                (amount1, amount2)
                            } else {
                                (amount2, amount1)
                            };
                            let period =
                                caps.name("period").and_then(|cm| parse_period(cm.as_str()));
                            let (start_fold, _) = absorb_money_prefix(tf, base, true);
                            raw_candidates.push((
                                start_fold,
                                end_fold,
                                MoneyValue {
                                    min: min_v,
                                    max: max_v,
                                    currency: "VND".to_string(),
                                    period,
                                },
                                0.95,
                            ));
                            if first_only
                                && (near_folded.is_empty()
                                    || min_distance_to_near_keywords(
                                        tf,
                                        start_fold,
                                        end_fold,
                                        near_folded,
                                        win,
                                        max_kw_bytes,
                                    ) == Some(0))
                            {
                                break;
                            }
                            min_pos = end_fold;
                            continue;
                        }
                    }
                }
            }
        }

        // 2. Single shorthand/unit amounts ("3tr5", "2 tỷ 3", "15 củ", "500k", "dưới 400 triệu")
        if is_unit_prefix && MONEY_SINGLE_RE.is_match(tail) {
            if let Some(caps) = MONEY_SINGLE_RE.captures(tail) {
                let m0 = caps.get(0).unwrap();
                let full_end = base + m0.end();
                if !crate::prefilter::has_alnum_at(tf, full_end) {
                    let n_str = caps.name("n").unwrap().as_str();
                    if let Some(n_val) = parse_decimal_num(n_str) {
                        let u_m = caps.name("u").unwrap();
                        let mult = unit_multiplier(u_m.as_str());

                        let mut end_fold = full_end;
                        let mut f_opt = caps.name("f").map(|cm| cm.as_str());
                        let sub_opt = caps.name("sub").map(|cm| cm.as_str());

                        if let Some(f_m) = caps.name("f") {
                            let u_end = base + u_m.end();
                            let had_space = (base + f_m.start()) > u_end;
                            let f_end = base + f_m.end();
                            let has_decimal = n_str.contains('.') || n_str.contains(',');
                            if has_decimal
                                || mult < 1_000_000
                                || (had_space
                                    && sub_opt.is_none()
                                    && NON_MONEY_NOUN_AFTER_DIGIT_RE.is_match(&tf[f_end..]))
                            {
                                f_opt = None;
                                if caps.name("period").is_none() {
                                    end_fold = u_end;
                                }
                            }
                        }

                        let (start_fold, is_upper_bound) = absorb_money_prefix(tf, base, false);
                        let amount = compute_unit_amount(n_str, n_val, mult, f_opt, sub_opt, false);
                        if amount > 0 && !overlaps_any(&raw_candidates, start_fold, end_fold) {
                            let min_v = if is_upper_bound { 0 } else { amount };
                            let period =
                                caps.name("period").and_then(|cm| parse_period(cm.as_str()));
                            raw_candidates.push((
                                start_fold,
                                end_fold,
                                MoneyValue {
                                    min: min_v,
                                    max: amount,
                                    currency: "VND".to_string(),
                                    period,
                                },
                                0.94,
                            ));
                            if first_only
                                && (near_folded.is_empty()
                                    || min_distance_to_near_keywords(
                                        tf,
                                        start_fold,
                                        end_fold,
                                        near_folded,
                                        win,
                                        max_kw_bytes,
                                    ) == Some(0))
                            {
                                break;
                            }
                            min_pos = end_fold;
                            continue;
                        }
                    }
                }
            }
        }

        // 3. Grouped VND amounts ("15.000.000đ", "500,000 vnd")
        if is_vnd_prefix && MONEY_GROUPED_VND_RE.is_match(tail) {
            if let Some(caps) = MONEY_GROUPED_VND_RE.captures(tail) {
                let m0 = caps.get(0).unwrap();
                let full_end = base + m0.end();
                if !crate::prefilter::has_alnum_at(tf, full_end) {
                    let digits_only: String = caps
                        .name("n")
                        .unwrap()
                        .as_str()
                        .chars()
                        .filter(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(amount) = digits_only.parse::<i64>() {
                        if amount >= 1_000 {
                            let (start_fold, is_upper_bound) = absorb_money_prefix(tf, base, false);
                            if !overlaps_any(&raw_candidates, start_fold, full_end) {
                                let min_v = if is_upper_bound { 0 } else { amount };
                                let period =
                                    caps.name("period").and_then(|cm| parse_period(cm.as_str()));
                                raw_candidates.push((
                                    start_fold,
                                    full_end,
                                    MoneyValue {
                                        min: min_v,
                                        max: amount,
                                        currency: "VND".to_string(),
                                        period,
                                    },
                                    0.93,
                                ));
                                if first_only && near_folded.is_empty() {
                                    break;
                                }
                                min_pos = full_end;
                                continue;
                            }
                        }
                    }
                }
            }
        }
    }

    if raw_candidates.is_empty() {
        return Vec::new();
    }

    raw_candidates.sort_by_key(|c| c.0);

    // Apply optional `near` keyword window filter & proximity ranking (local window slice around each candidate!)
    if !near_folded.is_empty() {
        let win = window.unwrap_or(DEFAULT_MONEY_WINDOW);
        let max_kw_bytes = near_folded.iter().map(|s| s.len()).max().unwrap_or(0);
        let mut filtered: Vec<(usize, usize, usize, MoneyValue, f64)> = Vec::new();
        for (f_start, f_end, val, conf) in raw_candidates {
            if let Some(min_dist) =
                min_distance_to_near_keywords(tf, f_start, f_end, near_folded, win, max_kw_bytes)
            {
                filtered.push((min_dist, f_start, f_end, val, conf));
                if first_only && min_dist == 0 {
                    break;
                }
            }
        }
        filtered.sort_by_key(|item| (item.0, item.1));
        filtered
            .into_iter()
            .filter_map(|(_, f_start, f_end, val, conf)| {
                let (norm_start, norm_end) = folded.map_span(f_start, f_end)?;
                Some(ExtractionMatch {
                    value: serde_json::to_value(val).ok()?,
                    raw: text_norm[norm_start..norm_end].to_string(),
                    start: norm_start,
                    end: norm_end,
                    confidence: conf,
                })
            })
            .collect()
    } else {
        raw_candidates
            .into_iter()
            .filter_map(|(f_start, f_end, val, conf)| {
                let (norm_start, norm_end) = folded.map_span(f_start, f_end)?;
                Some(ExtractionMatch {
                    value: serde_json::to_value(val).ok()?,
                    raw: text_norm[norm_start..norm_end].to_string(),
                    start: norm_start,
                    end: norm_end,
                    confidence: conf,
                })
            })
            .collect()
    }
}

fn absorb_money_prefix(tf: &str, num_start: usize, allow_tu: bool) -> (usize, bool) {
    let before = tf[..num_start].trim_end_matches(' ');
    if before.len() == num_start {
        return (num_start, false); // require whitespace between modifier word and number
    }
    const UPPER_PREFIXES: &[&str] = &["khong qua", "toi da", "duoi"];
    for &p in UPPER_PREFIXES {
        if let Some(rest) = before.strip_suffix(p) {
            if !crate::prefilter::has_alnum_before(before, rest.len()) {
                return (rest.len(), true);
            }
        }
    }
    const APPROX_PREFIXES: &[&str] = &["khoang", "tam", "tren"];
    for &p in APPROX_PREFIXES {
        if let Some(rest) = before.strip_suffix(p) {
            if !crate::prefilter::has_alnum_before(before, rest.len()) {
                return (rest.len(), false);
            }
        }
    }
    if allow_tu {
        if let Some(rest) = before.strip_suffix("tu") {
            if !crate::prefilter::has_alnum_before(before, rest.len()) {
                return (rest.len(), false);
            }
        }
    }
    (num_start, false)
}

fn overlaps_any(existing: &[(usize, usize, MoneyValue, f64)], start: usize, end: usize) -> bool {
    existing.iter().any(|&(s, e, _, _)| start < e && end > s)
}

fn unit_multiplier(unit: &str) -> i64 {
    match unit {
        "ty" | "ti" | "toi" => 1_000_000_000,
        "trieu" | "tr" | "cu" => 1_000_000,
        "lit" => 100_000,
        "nghin" | "ngan" | "ka" | "k" => 1_000,
        _ => 1,
    }
}

fn parse_decimal_num(s: &str) -> Option<f64> {
    let normalized = s.replace(',', ".");
    normalized.parse::<f64>().ok()
}

fn compute_unit_amount(
    n_raw: &str,
    n_val: f64,
    mult: i64,
    frac_opt: Option<&str>,
    sub_unit_opt: Option<&str>,
    allow_frac_on_decimal: bool,
) -> i64 {
    let base = (n_val * (mult as f64)).round() as i64;
    let has_decimal = n_raw.contains('.') || n_raw.contains(',');
    if has_decimal && !allow_frac_on_decimal {
        return base;
    }
    if let Some(f_str) = frac_opt {
        if !has_decimal && mult >= 1_000_000 {
            if let Ok(f_val) = f_str.parse::<i64>() {
                if let Some(sub) = sub_unit_opt {
                    let sub_mult = unit_multiplier(sub);
                    if sub_mult < mult {
                        return base + f_val * sub_mult;
                    }
                }
                let scale = mult / 10_i64.pow(f_str.len() as u32);
                return base + f_val * scale;
            }
        }
    }
    base
}

fn parse_period(raw_period: &str) -> Option<MoneyPeriod> {
    let p = raw_period.trim();
    if p.ends_with("thang")
        || p.ends_with("thg")
        || p.ends_with("th")
        || p.ends_with("month")
        || p.ends_with("mo")
    {
        Some(MoneyPeriod::Month)
    } else if p.ends_with("nam") || p.ends_with("yr") || p.ends_with("year") {
        Some(MoneyPeriod::Year)
    } else if p.ends_with("ngay") || p.ends_with("dem") || p.ends_with("day") {
        Some(MoneyPeriod::Day)
    } else {
        None
    }
}

fn skip_grouped_or_decimal_number(bytes: &[u8]) -> usize {
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    while i + 1 < bytes.len()
        && (bytes[i] == b'.' || bytes[i] == b',')
        && bytes[i + 1].is_ascii_digit()
    {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    i
}

fn floor_utf8_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_utf8_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

fn min_distance_to_near_keywords(
    tf: &str,
    f_start: usize,
    f_end: usize,
    keywords: &[String],
    max_chars: usize,
    max_kw_bytes: usize,
) -> Option<usize> {
    let byte_margin = max_chars
        .saturating_mul(if tf.is_ascii() { 1 } else { 4 })
        .saturating_add(max_kw_bytes)
        .saturating_add(2);
    let win_s = floor_utf8_boundary(tf, f_start.saturating_sub(byte_margin));
    let win_e = ceil_utf8_boundary(tf, (f_end + byte_margin).min(tf.len()));
    let local = &tf[win_s..win_e];

    let mut min_dist = usize::MAX;
    for kw in keywords {
        if kw.is_empty() || kw.len() > local.len() {
            continue;
        }
        let mut from = 0usize;
        while let Some(rel) = local[from..].find(kw.as_str()) {
            let ks = win_s + from + rel;
            let ke = ks + kw.len();
            if !crate::prefilter::has_alnum_before(tf, ks)
                && !crate::prefilter::has_alnum_at(tf, ke)
            {
                if let Some(d) = char_distance_within(tf, f_start, f_end, ks, ke, max_chars) {
                    if d < min_dist {
                        min_dist = d;
                        if d == 0 {
                            return Some(0);
                        }
                    }
                }
            }
            let b = local.as_bytes()[from + rel];
            let step = if b < 0x80 {
                1
            } else {
                local[from + rel..]
                    .chars()
                    .next()
                    .map(|c| c.len_utf8())
                    .unwrap_or(1)
            };
            from += rel + step;
        }
    }

    if min_dist <= max_chars {
        Some(min_dist)
    } else {
        None
    }
}

fn char_distance_within(
    tf: &str,
    a_start: usize,
    a_end: usize,
    b_start: usize,
    b_end: usize,
    max_chars: usize,
) -> Option<usize> {
    let (gap_start, gap_end) = if a_end < b_start {
        (a_end, b_start)
    } else if b_end < a_start {
        (b_end, a_start)
    } else {
        return Some(0);
    };
    let byte_gap = gap_end - gap_start;
    if byte_gap > max_chars.saturating_mul(4) {
        return None;
    }
    let slice = &tf[gap_start..gap_end];
    let chars = if slice.is_ascii() {
        slice.len()
    } else {
        slice.chars().count()
    };
    if chars <= max_chars {
        Some(chars)
    } else {
        None
    }
}
