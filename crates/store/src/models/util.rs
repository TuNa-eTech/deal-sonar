//! Id, time, text folding, FTS5 query, SimHash, and phone normalization helpers.

use super::*;

/// Generate a new monotonic-style ULID string.
pub fn new_ulid() -> String {
    Ulid::new().to_string()
}

/// Current Unix timestamp in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Validate a dynamic radar field key against `^[a-z][a-z0-9_]{0,30}$`.
pub fn is_valid_field_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 31 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// Split a 64-bit SimHash (`i64` two's complement representation) into four 16-bit bands.
pub fn simhash_bands(simhash: i64) -> [u16; 4] {
    let u = simhash as u64;
    [
        (u & 0xFFFF) as u16,
        ((u >> 16) & 0xFFFF) as u16,
        ((u >> 32) & 0xFFFF) as u16,
        ((u >> 48) & 0xFFFF) as u16,
    ]
}

/// Exact 64-bit Hamming distance between two SimHash values.
pub fn hamming_distance(a: i64, b: i64) -> u32 {
    ((a as u64) ^ (b as u64)).count_ones()
}

/// Fold Vietnamese diacritics (including `đ`/`Đ` -> `d`), lowercase, and collapse whitespace.
pub fn fold_vi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_space = true;
    for ch in input.chars() {
        if ('\u{0300}'..='\u{036F}').contains(&ch) {
            continue;
        }
        let mapped = map_vi_char(ch);
        if mapped.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            for lc in mapped.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

pub(super) fn map_vi_char(ch: char) -> char {
    match ch {
        'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ' | 'ấ' | 'ẩ'
        | 'ẫ' | 'ậ' | 'À' | 'Á' | 'Ả' | 'Ã' | 'Ạ' | 'Ă' | 'Ằ' | 'Ắ' | 'Ẳ' | 'Ẵ' | 'Ặ' | 'Â'
        | 'Ầ' | 'Ấ' | 'Ẩ' | 'Ẫ' | 'Ậ' => 'a',
        'đ' | 'Đ' => 'd',
        'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' | 'È' | 'É' | 'Ẻ' | 'Ẽ'
        | 'Ẹ' | 'Ê' | 'Ề' | 'Ế' | 'Ể' | 'Ễ' | 'Ệ' => 'e',
        'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' | 'Ì' | 'Í' | 'Ỉ' | 'Ĩ' | 'Ị' => 'i',
        'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ' | 'ớ' | 'ở'
        | 'ỡ' | 'ợ' | 'Ò' | 'Ó' | 'Ỏ' | 'Õ' | 'Ọ' | 'Ô' | 'Ồ' | 'Ố' | 'Ổ' | 'Ỗ' | 'Ộ' | 'Ơ'
        | 'Ờ' | 'Ớ' | 'Ở' | 'Ỡ' | 'Ợ' => 'o',
        'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' | 'Ù' | 'Ú' | 'Ủ' | 'Ũ'
        | 'Ụ' | 'Ư' | 'Ừ' | 'Ứ' | 'Ử' | 'Ữ' | 'Ự' => 'u',
        'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' | 'Ỳ' | 'Ý' | 'Ỷ' | 'Ỹ' | 'Ỵ' => 'y',
        other => other,
    }
}

/// Sanitize arbitrary user search text into a safe FTS5 `MATCH` expression.
/// Expands `d`/`đ` variants per token (up to 3 positions) because SQLite's `unicode61 remove_diacritics 2`
/// strips combining marks (`Cầu Giấy` -> `cau giay`) but keeps stroked `đ` (`Đống Đa` -> `đong đa`).
/// Returns `None` if no searchable alphanumeric tokens exist.
pub fn build_fts5_query(raw: &str) -> Option<String> {
    let tokens: Vec<&str> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(16)
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let parts: Vec<String> = tokens
        .into_iter()
        .map(|tok| {
            let variants = expand_vi_d_variants(tok);
            if variants.len() == 1 {
                let escaped = variants[0].replace('"', "\"\"");
                format!("\"{escaped}\"*")
            } else {
                let disj: Vec<String> = variants
                    .into_iter()
                    .map(|v| {
                        let escaped = v.replace('"', "\"\"");
                        format!("\"{escaped}\"*")
                    })
                    .collect();
                format!("({})", disj.join(" OR "))
            }
        })
        .collect();
    Some(parts.join(" AND "))
}

pub(super) fn expand_vi_d_variants(token: &str) -> Vec<String> {
    let lower_chars: Vec<char> = token.chars().flat_map(|c| c.to_lowercase()).collect();
    let d_positions: Vec<usize> = lower_chars
        .iter()
        .enumerate()
        .filter_map(|(idx, c)| matches!(*c, 'd' | 'đ').then_some(idx))
        .collect();

    if d_positions.is_empty() || d_positions.len() > 3 {
        return vec![lower_chars.into_iter().collect()];
    }

    let combos = 1usize << d_positions.len();
    let mut out = Vec::with_capacity(combos);
    for mask in 0..combos {
        let mut buf = lower_chars.clone();
        for (bit_idx, &char_pos) in d_positions.iter().enumerate() {
            buf[char_pos] = if (mask & (1 << bit_idx)) != 0 {
                'đ'
            } else {
                'd'
            };
        }
        out.push(buf.into_iter().collect());
    }
    out
}

/// Lightweight Vietnamese E.164 phone extractor used during post ingestion so peer phone signals
/// work across all captured posts even before T4/T5 evaluation.
pub fn extract_e164_phones_light(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];
        let starts_plus84 = ch == '+' && i + 2 < len && chars[i + 1] == '8' && chars[i + 2] == '4';
        let starts_zero = ch == '0'
            || ((ch == 'o' || ch == 'O')
                && (i == 0 || !chars[i - 1].is_alphabetic())
                && i + 1 < len
                && chars[i + 1].is_ascii_digit());
        let starts_84 = ch == '8'
            && i + 1 < len
            && chars[i + 1] == '4'
            && (i == 0 || !chars[i - 1].is_ascii_digit());

        if starts_plus84 || starts_zero || starts_84 {
            let mut digits = String::new();
            let mut j = i;
            if starts_plus84 {
                digits.push_str("84");
                j += 3;
            } else if starts_zero {
                digits.push('0');
                j += 1;
            } else {
                digits.push_str("84");
                j += 2;
            }

            while j < len && digits.len() < 13 {
                let c = chars[j];
                if c.is_ascii_digit() {
                    digits.push(c);
                    j += 1;
                } else if c == '.' || c == '-' || c == ' ' {
                    // Only consume separator if followed immediately by a digit
                    if j + 1 < len && chars[j + 1].is_ascii_digit() {
                        j += 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }

            // Ensure we didn't stop right in the middle of a longer number
            let trailing_digit = j < len && chars[j].is_ascii_digit();
            if !trailing_digit {
                if let Some(e164) = normalize_vn_digits_to_e164(&digits) {
                    if !results.contains(&e164) {
                        results.push(e164);
                    }
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }

    results
}

pub(super) fn normalize_vn_digits_to_e164(digits: &str) -> Option<String> {
    if let Some(rest) = digits.strip_prefix("0") {
        // Mobile (9 digits after 0 -> total 10) or landline (02x... total 10 or 11)
        let first = rest.as_bytes().first().copied()?;
        let valid = matches!(first, b'3' | b'5' | b'7' | b'8' | b'9') && rest.len() == 9
            || (first == b'2' && (rest.len() == 9 || rest.len() == 10));
        if valid {
            return Some(format!("+84{rest}"));
        }
    } else if let Some(rest) = digits.strip_prefix("84") {
        let first = rest.as_bytes().first().copied()?;
        let valid = matches!(first, b'3' | b'5' | b'7' | b'8' | b'9') && rest.len() == 9
            || (first == b'2' && (rest.len() == 9 || rest.len() == 10));
        if valid {
            return Some(format!("+84{rest}"));
        }
    }
    None
}
