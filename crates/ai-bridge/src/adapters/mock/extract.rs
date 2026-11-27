//! Heuristic Vietnamese text extractors (money, phone, area, numbers, enums, locations).

use super::*;

// ============================================================================
// Heuristic Vietnamese Engines
// ============================================================================

pub(super) fn fold_vi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        for lc in ch.to_lowercase() {
            let mapped = match lc {
                'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ'
                | 'ấ' | 'ẩ' | 'ẫ' | 'ậ' => 'a',
                'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' => {
                    'e'
                }
                'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' => 'i',
                'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ'
                | 'ớ' | 'ở' | 'ỡ' | 'ợ' => 'o',
                'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' => {
                    'u'
                }
                'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' => 'y',
                'đ' => 'd',
                other => other,
            };
            out.push(mapped);
        }
    }
    out
}

pub(super) fn extract_vn_money(text: &str) -> Option<(String, Value)> {
    // Range first: e.g. `12-15tr/th`, `12 - 15 triệu/tháng`, `tầm 10-12 củ`
    let range_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*[-–~]\s*(\d+(?:[.,]\d+)?)\s*(tỷ|ty|tỉ|ti|triệu|trieu|tr|củ|cu|k|nghìn|nghin)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?",
    )
    .expect("money range re");
    if let Some(caps) = range_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let min_num = parse_decimal(&caps[1])?;
        let max_num = parse_decimal(&caps[2])?;
        let mult = unit_multiplier(&caps[3]);
        let period = caps.get(4).and_then(|m| normalize_period(m.as_str()));
        let min_vnd = (min_num * mult).round();
        let max_vnd = (max_num * mult).round();
        return Some((
            full,
            json!({
                "min": min_vnd,
                "max": max_vnd,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    // Shorthand compound: `3tr5`, `13tr5/tháng`, `2 tỷ 3`
    let compound_re = Regex::new(
        r"(?i)(\d+)\s*(tỷ|ty|tỉ|ti|tr|triệu|trieu)\s*(\d)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?\b",
    )
    .expect("compound money re");
    if let Some(caps) = compound_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let major: f64 = caps[1].parse().ok()?;
        let minor: f64 = caps[3].parse().ok()?;
        let mult = unit_multiplier(&caps[2]);
        let amount = ((major + minor * 0.1) * mult).round();
        let period = caps.get(4).and_then(|m| normalize_period(m.as_str()));
        return Some((
            full,
            json!({
                "min": amount,
                "max": amount,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    // Single value: `15 triệu/tháng`, `dưới 15tr`, `450 triệu`, `15 củ`, `500k`
    let single_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*(tỷ|ty|tỉ|ti|triệu|trieu|tr|củ|cu|k|nghìn|nghin)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?\b",
    )
    .expect("single money re");
    if let Some(caps) = single_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let val = parse_decimal(&caps[1])?;
        let mult = unit_multiplier(&caps[2]);
        let amount = (val * mult).round();
        let period = caps.get(3).and_then(|m| normalize_period(m.as_str()));
        return Some((
            full,
            json!({
                "min": amount,
                "max": amount,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    None
}

pub(super) fn parse_decimal(s: &str) -> Option<f64> {
    s.replace(',', ".").parse::<f64>().ok()
}

pub(super) fn unit_multiplier(unit: &str) -> f64 {
    match fold_vi(unit).as_str() {
        "ty" | "ti" => 1_000_000_000.0,
        "trieu" | "tr" | "cu" => 1_000_000.0,
        "k" | "nghin" => 1_000.0,
        _ => 1.0,
    }
}

pub(super) fn normalize_period(raw_period: &str) -> Option<&'static str> {
    match fold_vi(raw_period).as_str() {
        "thang" | "th" => Some("month"),
        "nam" => Some("year"),
        "ngay" => Some("day"),
        _ => None,
    }
}

pub(super) fn extract_vn_phone(text: &str) -> Option<(String, String)> {
    let phone_re = Regex::new(r"(?i)(?:\+84|0|[oO])(?:[\s.\-]*\d){8,10}").expect("phone re");
    for m in phone_re.find_iter(text) {
        let raw = m.as_str().trim().to_string();
        let mut digits = String::new();
        for (i, ch) in raw.chars().enumerate() {
            if i == 0 && (ch == 'o' || ch == 'O') {
                digits.push('0');
            } else if ch.is_ascii_digit() {
                digits.push(ch);
            }
        }
        let e164 = if raw.starts_with("+84") && (digits.len() == 11 || digits.len() == 12) {
            format!("+{digits}")
        } else if digits.starts_with('0') && (digits.len() == 10 || digits.len() == 11) {
            format!("+84{}", &digits[1..])
        } else {
            continue;
        };
        return Some((raw, e164));
    }
    None
}

pub(super) fn extract_vn_area(text: &str) -> Option<(String, Value)> {
    let range_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*[-–~]\s*(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mét vuông|met vuong)",
    )
    .expect("area range re");
    if let Some(caps) = range_re.captures(text) {
        let raw = caps.get(0)?.as_str().to_string();
        let min_v = parse_decimal(&caps[1])?;
        let max_v = parse_decimal(&caps[2])?;
        return Some((raw, json!({ "min": min_v, "max": max_v, "unit": "m2" })));
    }

    let single_re = Regex::new(r"(?i)(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mét vuông|met vuong)")
        .expect("area single re");
    if let Some(caps) = single_re.captures(text) {
        let raw = caps.get(0)?.as_str().to_string();
        let v = parse_decimal(&caps[1])?;
        return Some((raw, json!({ "min": v, "max": v, "unit": "m2" })));
    }
    None
}

pub(super) fn extract_number_by_key(field_key: &str, text: &str) -> Option<(String, f64)> {
    let key_lc = field_key.to_ascii_lowercase();
    if key_lc.contains("bed") || key_lc.contains("phong_ngu") || key_lc.contains("pn") {
        let re = Regex::new(r"(?i)\b(\d+)\s*(?:pn|phòng ngủ|phong ngu|ngủ|ngu)\b").expect("bed re");
        if let Some(caps) = re.captures(text) {
            let raw = caps.get(0)?.as_str().to_string();
            let n: f64 = caps[1].parse().ok()?;
            return Some((raw, n));
        }
    }
    let generic_re = Regex::new(r"\b(\d+(?:\.\d+)?)\b").expect("num re");
    let caps = generic_re.captures(text)?;
    let raw = caps.get(0)?.as_str().to_string();
    let n: f64 = caps[1].parse().ok()?;
    Some((raw, n))
}

pub(super) fn match_enum_option(opts: &[Value], text: &str) -> Option<(String, String)> {
    for opt in opts.iter().filter_map(Value::as_str) {
        let opt_fold = fold_vi(opt);
        if let Some(raw) = find_case_fold_span(text, &opt_fold) {
            return Some((raw, opt.to_string()));
        }
        // Common Vietnamese synonyms for standard template enums
        let synonyms: &[&str] = match opt {
            "rent" => &["can thue", "cho thue", "thue"],
            "buy" => &["can mua", "mua"],
            "apartment" => &["can ho", "chung cu"],
            "house" => &["nha nguyen can", "nha rieng"],
            _ => &[],
        };
        for syn in synonyms {
            if let Some(raw) = find_case_fold_span(text, syn) {
                return Some((raw, opt.to_string()));
            }
        }
    }
    None
}

pub(super) fn detect_location_in_text(text: &str) -> Option<(String, Value)> {
    const PLACES: &[(&[&str], &str, Option<&str>)] = &[
        (
            &["cau giay", "dich vong", "trung hoa", "nghia tan"],
            "Hà Nội",
            Some("Cầu Giấy"),
        ),
        (
            &["nam tu liem", "my dinh", "me tri"],
            "Hà Nội",
            Some("Nam Từ Liêm"),
        ),
        (&["bac tu liem"], "Hà Nội", Some("Bắc Từ Liêm")),
        (&["thanh xuan", "nhan chinh"], "Hà Nội", Some("Thanh Xuân")),
        (
            &["dong da", "lang ha", "chua lang"],
            "Hà Nội",
            Some("Đống Đa"),
        ),
        (&["ba dinh", "lieu giai"], "Hà Nội", Some("Ba Đình")),
        (&["tay ho", "ho tay"], "Hà Nội", Some("Tây Hồ")),
        (
            &["hai ba trung", "minh khai", "times city"],
            "Hà Nội",
            Some("Hai Bà Trưng"),
        ),
        (&["hoang mai", "linh dam"], "Hà Nội", Some("Hoàng Mai")),
        (&["long bien"], "Hà Nội", Some("Long Biên")),
        (&["ha dong"], "Hà Nội", Some("Hà Đông")),
        (&["hoan kiem"], "Hà Nội", Some("Hoàn Kiếm")),
        (
            &["tp thu duc", "thu duc", "thao dien"],
            "TP. Hồ Chí Minh",
            Some("Thủ Đức"),
        ),
        (
            &["quan 7", "q7", "phu my hung"],
            "TP. Hồ Chí Minh",
            Some("Quận 7"),
        ),
        (&["quan 1", "q1"], "TP. Hồ Chí Minh", Some("Quận 1")),
        (&["quan 3", "q3"], "TP. Hồ Chí Minh", Some("Quận 3")),
        (&["binh thanh"], "TP. Hồ Chí Minh", Some("Bình Thạnh")),
        (&["go vap"], "TP. Hồ Chí Minh", Some("Gò Vấp")),
        (&["tan binh"], "TP. Hồ Chí Minh", Some("Tân Bình")),
        (&["phu nhuan"], "TP. Hồ Chí Minh", Some("Phú Nhuận")),
        (&["hai chau"], "Đà Nẵng", Some("Hải Châu")),
        (&["son tra"], "Đà Nẵng", Some("Sơn Trà")),
        (&["ha noi"], "Hà Nội", None),
        (&["tp.hcm", "tphcm", "sai gon"], "TP. Hồ Chí Minh", None),
        (&["da nang"], "Đà Nẵng", None),
    ];

    for (aliases, province, district) in PLACES {
        for alias in *aliases {
            if let Some(raw) = find_case_fold_span(text, alias) {
                return Some((
                    raw.clone(),
                    json!({
                        "raw": raw,
                        "province": province,
                        "district": district,
                        "ward": Value::Null
                    }),
                ));
            }
        }
    }

    None
}

/// Finds an exact verbatim character slice of `original` whose diacritic-folded text matches
/// `needle_folded` on word boundaries, guaranteeing `raw` is always an exact substring of `original`!
pub(super) fn find_case_fold_span(original: &str, needle_folded: &str) -> Option<String> {
    if needle_folded.is_empty() {
        return None;
    }

    // Map each character index in `folded` back to `(orig_byte_start, orig_byte_end)` in `original`.
    let mut folded = String::with_capacity(original.len());
    let mut byte_ranges: Vec<(usize, usize)> = Vec::with_capacity(original.len());

    for (byte_idx, ch) in original.char_indices() {
        let ch_end = byte_idx + ch.len_utf8();
        let piece = fold_vi(&ch.to_string());
        for fc in piece.chars() {
            folded.push(fc);
            byte_ranges.push((byte_idx, ch_end));
        }
    }

    // Since `folded` here contains only ASCII/BMP single-byte chars for ASCII `needle_folded`,
    // work with char indices safely.
    let folded_chars: Vec<char> = folded.chars().collect();
    let needle_chars: Vec<char> = needle_folded.chars().collect();
    if needle_chars.len() > folded_chars.len() {
        return None;
    }

    for start in 0..=(folded_chars.len() - needle_chars.len()) {
        if folded_chars[start..start + needle_chars.len()] == needle_chars[..] {
            let before_ok = start == 0 || !folded_chars[start - 1].is_alphanumeric();
            let end = start + needle_chars.len();
            let after_ok = end == folded_chars.len() || !folded_chars[end].is_alphanumeric();
            if before_ok && after_ok {
                let orig_start = byte_ranges[start].0;
                let orig_end = byte_ranges[end - 1].1;
                return Some(original[orig_start..orig_end].to_string());
            }
        }
    }

    None
}
