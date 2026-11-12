use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::types::{format_domestic_phone, ExtractionMatch};

static URL_SPAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:https?://|www\.)\S+").expect("valid url span regex"));

static PHONE_CANDIDATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)(?:\+[ \t]*84(?:[ \t]*\([ \t]*[0oO][ \t]*\))?[ \t.\-_()]*[235789]|84[ \t.\-_()]*[235789]|[0oO][ \t.\-_()]*[235789])(?:[ \t.\-_()]*[0-9oO]){7,10}",
    )
    .expect("valid phone candidate regex")
});

/// Extract all Vietnamese mobile & landline phone numbers from `text_norm` (`05-pipeline-rules.md §6.3`),
/// normalizing each to E.164 (`"+84..."`).
///
/// Handles dots, spaces, hyphens, parentheses, `+84`/`84` international prefixes,
/// and letter-`o`/`O` obfuscation (`"o912 345 678"` -> `"+84912345678"`).
pub fn extract_vn_phone(text_norm: &str) -> Vec<ExtractionMatch> {
    extract_vn_phone_impl(text_norm, false)
}

pub(crate) fn extract_vn_phone_first(text_norm: &str) -> Option<ExtractionMatch> {
    extract_vn_phone_impl(text_norm, true).into_iter().next()
}

const PHONE_BYTE_CLASS: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 0usize;
    while i < 256 {
        let b = i as u8;
        table[i] = if b >= b'2' && b <= b'9' {
            3
        } else if b == b'0' || b == b'1' || b == b'o' || b == b'O' {
            2
        } else if matches!(b, b'+' | b' ' | b'\t' | b'.' | b'-' | b'_' | b'(' | b')') {
            1
        } else {
            0
        };
        i += 1;
    }
    table
};

/// Fast `-O3` `libcore` SIMD `memchr` precheck: every valid Vietnamese phone candidate starts with
/// `'0'`, `'o'`, `'O'`, or `"84"` (including `"+84"`) and has an ASCII digit within 8 bytes.
fn has_phone_anchor(text_norm: &str) -> bool {
    let bytes = text_norm.as_bytes();
    let len = bytes.len();
    if text_norm.contains("84") {
        return true;
    }
    for anchor in ['0', 'o', 'O'] {
        let mut from = 0usize;
        while let Some(rel) = text_norm[from..].find(anchor) {
            let pos = from + rel;
            let look_end = (pos + 9).min(len);
            let mut k = pos + 1;
            while k < look_end {
                if bytes[k].is_ascii_digit() {
                    return true;
                }
                k += 1;
            }
            from = pos + 1;
        }
    }
    false
}

fn extract_vn_phone_impl(text_norm: &str, first_only: bool) -> Vec<ExtractionMatch> {
    if text_norm.len() < 9 || !has_phone_anchor(text_norm) {
        return Vec::new();
    }

    let mut url_ranges: Option<Vec<Range<usize>>> = None;

    let mut matches = Vec::new();
    let bytes = text_norm.as_bytes();
    let len = bytes.len();
    let mut scan_pos = 0usize;

    // Partition `text_norm` into maximal runs of phone-eligible ASCII bytes (`[0-9oO+ \t.\-_()]`).
    // Every `PHONE_CANDIDATE_RE` match is strictly contained within one such run having `>= 9`
    // `[0-9oO]` bytes and at least one `[2-9]` digit, avoiding regex scans over ordinary prose.
    while scan_pos < len {
        let mut cls = PHONE_BYTE_CLASS[bytes[scan_pos] as usize];
        if cls == 0 {
            scan_pos += 1;
            continue;
        }
        let run_start = scan_pos;
        let mut digit_like_count = usize::from(cls >= 2);
        let mut has_2_to_9 = cls == 3;
        scan_pos += 1;
        while scan_pos < len {
            cls = PHONE_BYTE_CLASS[bytes[scan_pos] as usize];
            if cls == 0 {
                break;
            }
            if cls >= 2 {
                digit_like_count += 1;
                if cls == 3 {
                    has_2_to_9 = true;
                }
            }
            scan_pos += 1;
        }
        let run_end = scan_pos;
        if digit_like_count < 9 || !has_2_to_9 {
            continue;
        }

        let urls = url_ranges.get_or_insert_with(|| {
            if text_norm.contains("http")
                || text_norm.contains("HTTP")
                || text_norm.contains("www.")
                || text_norm.contains("WWW.")
            {
                URL_SPAN_RE
                    .find_iter(text_norm)
                    .map(|m| m.start()..m.end())
                    .collect()
            } else {
                Vec::new()
            }
        });

        for m in PHONE_CANDIDATE_RE.find_iter(&text_norm[run_start..run_end]) {
            let mut start = run_start + m.start();
            let mut end = run_start + m.end();

            // Skip candidates overlapping URLs (e.g. facebook.com/groups/0912345678)
            if urls.iter().any(|r| start < r.end && end > r.start) {
                continue;
            }

            // Trim trailing separator chars so `raw` ends cleanly on a digit or obfuscated 'o'
            while end > start {
                if let Some(last_ch) = text_norm[start..end].chars().next_back() {
                    if last_ch.is_ascii_digit() || last_ch == 'o' || last_ch == 'O' {
                        break;
                    }
                    end -= last_ch.len_utf8();
                } else {
                    break;
                }
            }
            // Trim leading whitespace if any
            while start < end {
                if let Some(first_ch) = text_norm[start..end].chars().next() {
                    if first_ch.is_whitespace() {
                        start += first_ch.len_utf8();
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            if start >= end {
                continue;
            }

            // Enforce strict left boundary: not preceded by alphanumeric or URL slash after alphanumeric
            if start > 0 {
                if let Some(prev) = text_norm[..start].chars().next_back() {
                    let starts_with_plus = text_norm[start..end].starts_with('+');
                    if prev.is_alphanumeric() && !starts_with_plus {
                        continue;
                    }
                    if (prev == '/' || prev == '.') && start >= 2 {
                        if let Some(prev2) =
                            text_norm[..start - prev.len_utf8()].chars().next_back()
                        {
                            if prev2.is_alphanumeric() {
                                continue;
                            }
                        }
                    }
                }
            }

            // Enforce strict right boundary: not followed by alphanumeric or ".<digit>"
            if end < text_norm.len() {
                let tail = &text_norm[end..];
                if let Some(next) = tail.chars().next() {
                    if next.is_alphanumeric() {
                        continue;
                    }
                    if (next == '.' || next == ',')
                        && tail[next.len_utf8()..]
                            .chars()
                            .next()
                            .map(|c| c.is_ascii_digit())
                            .unwrap_or(false)
                    {
                        continue;
                    }
                }
            }

            let raw_slice = &text_norm[start..end];
            if let Some((e164, had_letter_o)) = parse_vn_phone_candidate(raw_slice) {
                let confidence = if had_letter_o { 0.90 } else { 0.98 };
                matches.push(ExtractionMatch {
                    value: Value::String(e164),
                    raw: raw_slice.to_string(),
                    start,
                    end,
                    confidence,
                });
                if first_only {
                    return matches;
                }
            }
        }
    }

    matches
}

/// Normalize a standalone Vietnamese phone string into E.164 (`"+84..."`), if valid.
pub fn normalize_vn_phone_str(raw: &str) -> Option<String> {
    parse_vn_phone_candidate(raw.trim()).map(|(e164, _)| e164)
}

fn parse_vn_phone_candidate(raw: &str) -> Option<(String, bool)> {
    let mut letter_o_count = 0usize;
    let chars: Vec<char> = raw.chars().collect();
    for (idx, &ch) in chars.iter().enumerate() {
        if ch == 'o' || ch == 'O' {
            letter_o_count += 1;
            // Ensure 'o'/'O' is adjacent to a digit or separator+digit, not an alphabetic word
            let has_adjacent_digit = chars[..idx]
                .iter()
                .rev()
                .find(|c| !matches!(**c, ' ' | '.' | '-' | '_' | '(' | ')'))
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
                || chars[idx + 1..]
                    .iter()
                    .find(|c| !matches!(**c, ' ' | '.' | '-' | '_' | '(' | ')'))
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false);
            if !has_adjacent_digit {
                return None;
            }
        }
    }
    if letter_o_count > 3 {
        return None;
    }

    let trimmed = raw.trim();
    let has_plus = trimmed.starts_with('+');

    let mut digits = String::with_capacity(13);
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if ch == 'o' || ch == 'O' {
            digits.push('0');
        } else if matches!(ch, '+' | ' ' | '.' | '-' | '_' | '(' | ')') {
            continue;
        } else {
            return None;
        }
    }

    let domestic = if has_plus {
        let rest = digits.strip_prefix("84")?;
        let rest = rest.strip_prefix('0').unwrap_or(rest);
        format!("0{rest}")
    } else if digits.starts_with("84") && (digits.len() == 11 || digits.len() == 12) {
        let rest = &digits[2..];
        let cand = format!("0{rest}");
        if is_valid_domestic_vn_phone(&cand) {
            cand
        } else {
            digits
        }
    } else {
        digits
    };

    if !is_valid_domestic_vn_phone(&domestic) {
        return None;
    }

    let e164 = format!("+84{}", &domestic[1..]);
    Some((e164, letter_o_count > 0))
}

fn is_valid_domestic_vn_phone(domestic: &str) -> bool {
    if !domestic.starts_with('0') || !domestic.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let bytes = domestic.as_bytes();
    match bytes.len() {
        10 => match bytes[1] {
            b'3' => (b'2'..=b'9').contains(&bytes[2]),
            b'5' => matches!(bytes[2], b'2' | b'5' | b'6' | b'8' | b'9'),
            b'7' => matches!(bytes[2], b'0' | b'6' | b'7' | b'8' | b'9'),
            b'8' => (b'1'..=b'9').contains(&bytes[2]),
            b'9' => bytes[2].is_ascii_digit(),
            b'2' => true, // 10-digit landline (e.g. legacy/short 024/028)
            _ => false,
        },
        11 => bytes[1] == b'2', // 11-digit landline (024xxxxxxxx, 028xxxxxxxx, 0236xxxxxxx, etc.)
        _ => false,
    }
}

/// Convenience re-export for formatting an E.164 phone as domestic `"0912 345 678"`.
#[inline]
pub fn to_domestic_phone(e164: &str) -> String {
    format_domestic_phone(e164)
}
