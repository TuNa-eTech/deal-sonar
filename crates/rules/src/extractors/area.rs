use std::sync::LazyLock;

use regex::Regex;

use crate::normalize::{fold_with_spans, FoldedView};
use crate::prefilter::has_alnum_at;
use crate::types::{ExtractionMatch, RangeValue};

static AREA_RANGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^(?x)
        (?P<n1>\d+(?:[.,]\d+)?)
        \s*(?:m2|met\s+vuong|m\s+vuong)?
        \s*(?:-|den|toi|~)\s*
        (?P<n2>\d+(?:[.,]\d+)?)
        \s*(?:m2|met\s+vuong|m\s+vuong)\b
        ",
    )
    .expect("valid area range regex")
});

static AREA_DIM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)^(?x)
        (?P<w>\d+m\d+|\d+(?:[.,]\d+)?)(?:\s*(?P<wu>m|met))?
        \s*x\s*
        (?P<l>\d+m\d+|\d+(?:[.,]\d+)?)(?:\s*(?P<lu>m2|m|met))?\b
        ",
    )
    .expect("valid area dimensions regex")
});

static AREA_SINGLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)^(?P<n>\d+(?:[.,]\d+)?)\s*(?:m2|met\s+vuong|m\s+vuong)\b")
        .expect("valid single area regex")
});

/// Fast precheck using `libcore` `-O3` `str::contains` / `str::find` so posts without area units
/// or `<num> x <num>` dimensions return immediately (even when words like `"hang xom"` contain `'x'`).
#[inline]
fn has_area_cue(tf: &str) -> bool {
    if tf.contains("m2") || tf.contains("vuong") {
        return true;
    }
    let bytes = tf.as_bytes();
    let len = bytes.len();
    let mut from = 0usize;
    while let Some(rel) = tf[from..].find('x') {
        let x_pos = from + rel;
        let mut r = x_pos + 1;
        while r < len && bytes[r] == b' ' {
            r += 1;
        }
        if r < len && bytes[r].is_ascii_digit() && x_pos > 0 {
            let mut l = x_pos;
            while l > 0 && bytes[l - 1] == b' ' {
                l -= 1;
            }
            if l > 0 {
                let lb = bytes[l - 1];
                if lb.is_ascii_digit() || lb == b'm' || lb == b't' {
                    return true;
                }
            }
        }
        from = x_pos + 1;
    }
    false
}

/// Extract Vietnamese area expressions (`50m2`, `50 m²`, `5x20`, `4.5m x 16m`,
/// `50-70m2`, `70 mét vuông`) into `{"min": ..., "max": ..., "unit": "m2"}` (`05-pipeline-rules.md §6.3`).
pub fn extract_vn_area(text_norm: &str) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }
    let folded = fold_with_spans(text_norm);
    extract_vn_area_from_folded(text_norm, &folded.as_view(text_norm), false)
}

pub(crate) fn extract_vn_area_from_folded(
    text_norm: &str,
    folded: &FoldedView<'_>,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    let bytes = tf.as_bytes();
    let len = bytes.len();
    if len < 2 || !has_area_cue(tf) {
        return Vec::new();
    }

    let mut raw_hits: Vec<(usize, usize, RangeValue, f64)> = Vec::new();
    let mut min_pos = 0usize;

    for &d_pos in folded.digit_starts() {
        if d_pos < min_pos {
            continue;
        }

        let tail_end = floor_utf8_boundary(tf, (d_pos + 96).min(len));
        let tail = &tf[d_pos..tail_end];

        // Fast 2-byte guard: skip numbers not followed by `m2`/`met`/`m `, `x`, or `-`/`~`/`den `/`toi `
        let after_num = skip_number_token(tail.as_bytes());
        let tail_bytes = tail.as_bytes();
        let mut ws_idx = after_num;
        while ws_idx < tail_bytes.len() && tail_bytes[ws_idx] == b' ' {
            ws_idx += 1;
        }
        let after_slice = &tail_bytes[ws_idx..];
        let b0 = after_slice.first().copied().unwrap_or(0);
        let b1 = after_slice.get(1).copied().unwrap_or(0);

        let is_m_unit = b0 == b'm'
            && (b1 == b'2'
                || b1 == b'e'
                || b1 == b' '
                || b1.is_ascii_digit()
                || !b1.is_ascii_alphanumeric());
        let is_x_dim = b0 == b'x';
        let is_range_conn = b0 == b'-'
            || b0 == b'~'
            || after_slice.starts_with(b"den ")
            || after_slice.starts_with(b"toi ");

        if !is_m_unit && !is_x_dim && !is_range_conn {
            min_pos = d_pos + after_num.max(1);
            continue;
        }

        let after_str = &tail[ws_idx..];
        let can_match_range = (is_range_conn
            || (is_m_unit
                && (after_slice.contains(&b'-')
                    || after_slice.contains(&b'~')
                    || after_str.contains(" den ")
                    || after_str.contains(" toi "))))
            && after_slice.contains(&b'm');

        if can_match_range && AREA_RANGE_RE.is_match(tail) {
            if let Some(caps) = AREA_RANGE_RE.captures(tail) {
                let m0 = caps.get(0).unwrap();
                let abs_end = d_pos + m0.end();
                if !has_alnum_at(tf, abs_end) {
                    if let (Some(v1), Some(v2)) = (
                        parse_dim_number(caps.name("n1").unwrap().as_str()),
                        parse_dim_number(caps.name("n2").unwrap().as_str()),
                    ) {
                        if v1 > 0.0 && v2 > 0.0 {
                            let (min_v, max_v) = if v1 <= v2 { (v1, v2) } else { (v2, v1) };
                            raw_hits.push((
                                d_pos,
                                abs_end,
                                RangeValue {
                                    min: round_2(min_v),
                                    max: round_2(max_v),
                                    unit: "m2".to_string(),
                                },
                                0.96,
                            ));
                            if first_only {
                                break;
                            }
                            min_pos = abs_end;
                            continue;
                        }
                    }
                }
            }
        }

        if (is_x_dim || (is_m_unit && after_slice.contains(&b'x'))) && AREA_DIM_RE.is_match(tail) {
            if let Some(caps) = AREA_DIM_RE.captures(tail) {
                let m0 = caps.get(0).unwrap();
                let abs_end = d_pos + m0.end();
                if !has_alnum_at(tf, abs_end) {
                    let w_str = caps.name("w").unwrap().as_str();
                    let l_str = caps.name("l").unwrap().as_str();
                    if let (Some(w), Some(l)) = (parse_dim_number(w_str), parse_dim_number(l_str)) {
                        let has_explicit_meter = caps.name("wu").is_some()
                            || caps.name("lu").is_some()
                            || w_str.contains('m')
                            || l_str.contains('m');
                        let product = round_2(w * l);
                        if w > 0.5
                            && w <= 500.0
                            && l > 0.5
                            && l <= 1_000.0
                            && (has_explicit_meter || product >= 6.0)
                        {
                            raw_hits.push((
                                d_pos,
                                abs_end,
                                RangeValue {
                                    min: product,
                                    max: product,
                                    unit: "m2".to_string(),
                                },
                                if has_explicit_meter { 0.94 } else { 0.88 },
                            ));
                            if first_only {
                                break;
                            }
                            min_pos = abs_end;
                            continue;
                        }
                    }
                }
            }
        }

        if is_m_unit {
            if let Some(m0) = AREA_SINGLE_RE.find(tail) {
                let abs_end = d_pos + m0.end();
                if !has_alnum_at(tf, abs_end) {
                    let s = m0.as_str();
                    let num_end = s
                        .bytes()
                        .position(|b| !(b.is_ascii_digit() || b == b'.' || b == b','))
                        .unwrap_or(s.len());
                    if let Some(val) = parse_dim_number(&s[..num_end]) {
                        if val > 0.0 {
                            let v = round_2(val);
                            raw_hits.push((
                                d_pos,
                                abs_end,
                                RangeValue {
                                    min: v,
                                    max: v,
                                    unit: "m2".to_string(),
                                },
                                0.96,
                            ));
                            if first_only {
                                break;
                            }
                            min_pos = abs_end;
                            continue;
                        }
                    }
                }
            }
        }
    }

    raw_hits.sort_by_key(|h| h.0);
    raw_hits
        .into_iter()
        .filter_map(|(s, e, val, conf)| {
            let (ns, ne) = folded.map_span(s, e)?;
            Some(ExtractionMatch {
                value: serde_json::to_value(val).ok()?,
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: conf,
            })
        })
        .collect()
}

fn parse_dim_number(s: &str) -> Option<f64> {
    if let Some((whole, frac)) = s.split_once('m') {
        let w: f64 = whole.parse().ok()?;
        let f: f64 = frac.parse().ok()?;
        let scale = 10_f64.powi(frac.len() as i32);
        return Some(w + f / scale);
    }
    s.replace(',', ".").parse::<f64>().ok()
}

fn round_2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn skip_number_token(bytes: &[u8]) -> usize {
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 < bytes.len()
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
