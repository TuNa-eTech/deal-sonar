//! HTML escaping, URL validation, and phone/money/field/time formatting.

use super::*;

/// Strict HTML escaping for Telegram `parse_mode: "HTML"`.
///
/// Escapes `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;`.
pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

pub(super) fn escape_html_attr(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Validates that `permalink` is a well-formed `https://` URL with no control characters.
pub fn validate_https_permalink(permalink: &str) -> Result<reqwest::Url, NotifyError> {
    let trimmed = permalink.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(NotifyError::InvalidPermalink(permalink.to_string()));
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| NotifyError::InvalidPermalink(permalink.to_string()))?;
    if parsed.scheme() != "https" || parsed.host_str().unwrap_or("").is_empty() {
        return Err(NotifyError::InvalidPermalink(permalink.to_string()));
    }
    Ok(parsed)
}

/// Returns `true` only when `url` is a valid `https://` URL belonging to a Facebook domain.
pub fn is_valid_facebook_https_url(url: &str) -> bool {
    let Ok(parsed) = validate_https_permalink(url) else {
        return false;
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    matches!(
        parsed.host_str().map(|h| h.to_ascii_lowercase()).as_deref(),
        Some(
            "facebook.com"
                | "www.facebook.com"
                | "m.facebook.com"
                | "web.facebook.com"
                | "fb.com"
                | "www.fb.com"
        )
    )
}

/// Converts an E.164 or raw Vietnamese phone number into domestic click-to-call format.
///
/// Examples:
/// - `"+84912345678"` -> `"0912 345 678"`
/// - `"+842438123456"` -> `"024 3812 3456"`
pub fn format_domestic_phone(phone: &str) -> String {
    let trimmed = phone.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let normalized_digits: Option<String> = if let Some(rest) = trimmed.strip_prefix("+84") {
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            Some(format!("0{digits}"))
        } else {
            None
        }
    } else {
        let only_digits_and_sep = trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '.' | '-'));
        if only_digits_and_sep {
            let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.starts_with("84") && (digits.len() == 11 || digits.len() == 12) {
                Some(format!("0{}", &digits[2..]))
            } else if digits.starts_with('0') {
                Some(digits)
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(d) = normalized_digits {
        if d.len() == 10 {
            return format!("{} {} {}", &d[0..4], &d[4..7], &d[7..10]);
        }
        if d.len() == 11 {
            return format!("{} {} {}", &d[0..3], &d[3..7], &d[7..11]);
        }
        return d;
    }

    trimmed.to_string()
}

pub(super) fn format_vn_decimal(val: f64) -> String {
    let rounded = (val * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < 1e-9 {
        format!("{}", rounded.round() as i64)
    } else {
        let s = format!("{rounded:.2}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        s.replace('.', ",")
    }
}

pub(super) fn format_plain_number(val: f64) -> String {
    if (val - val.round()).abs() < 1e-9 {
        format!("{}", val.round() as i64)
    } else {
        let s = format!("{val:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub(super) fn vnd_unit_and_scale(amount: f64) -> (&'static str, f64) {
    let abs = amount.abs();
    if abs >= 1_000_000_000.0 {
        ("tỷ", 1_000_000_000.0)
    } else if abs >= 1_000_000.0 {
        ("triệu", 1_000_000.0)
    } else if abs >= 1_000.0 {
        ("nghìn", 1_000.0)
    } else {
        ("đ", 1.0)
    }
}

pub(super) fn format_single_vnd(amount: f64) -> String {
    let (unit, scale) = vnd_unit_and_scale(amount);
    format!("{} {unit}", format_vn_decimal(amount / scale))
}

pub(super) fn format_period_vi(period: Option<&str>) -> &'static str {
    match period.map(|p| p.trim().to_ascii_lowercase()).as_deref() {
        Some("month" | "thang" | "tháng") => "/tháng",
        Some("year" | "nam" | "năm") => "/năm",
        Some("day" | "ngay" | "ngày") => "/ngày",
        Some("week" | "tuan" | "tuần") => "/tuần",
        Some("m2" | "sqm") => "/m2",
        _ => "",
    }
}

/// Formats a normalized `money` JSON value into natural Vietnamese currency text.
///
/// Examples:
/// - `{"min": 12000000, "max": 15000000, "currency": "VND", "period": "month"}` -> `"12–15 triệu/tháng"`
/// - `{"min": 2300000000, "max": 2300000000, "currency": "VND"}` -> `"2,3 tỷ"`
/// - `{"min": 500000, "max": 500000, "currency": "VND"}` -> `"500 nghìn"`
pub fn format_vietnamese_money(value: &serde_json::Value) -> Option<String> {
    if let Some(num) = value.as_f64() {
        return Some(format_single_vnd(num));
    }

    let obj = value.as_object()?;
    let min_opt = obj
        .get("min")
        .and_then(|v| v.as_f64())
        .or_else(|| obj.get("amount").and_then(|v| v.as_f64()));
    let max_opt = obj
        .get("max")
        .and_then(|v| v.as_f64())
        .or_else(|| obj.get("amount").and_then(|v| v.as_f64()));

    let (min_val, max_val) = match (min_opt, max_opt) {
        (Some(a), Some(b)) => (a, b),
        (Some(a), None) => (a, a),
        (None, Some(b)) => (b, b),
        (None, None) => return None,
    };

    let currency = obj
        .get("currency")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("VND");
    let period_suffix = format_period_vi(obj.get("period").and_then(|v| v.as_str()));

    let base = if currency.eq_ignore_ascii_case("VND") {
        if (max_val - min_val).abs() < 0.5 {
            format_single_vnd(min_val)
        } else {
            let (u_min, s_min) = vnd_unit_and_scale(min_val);
            let (u_max, s_max) = vnd_unit_and_scale(max_val);
            if u_min == u_max {
                format!(
                    "{}–{} {u_max}",
                    format_vn_decimal(min_val / s_min),
                    format_vn_decimal(max_val / s_max)
                )
            } else {
                format!(
                    "{}–{}",
                    format_single_vnd(min_val),
                    format_single_vnd(max_val)
                )
            }
        }
    } else if (max_val - min_val).abs() < 0.01 {
        format!("{} {currency}", format_vn_decimal(min_val))
    } else {
        format!(
            "{}–{} {currency}",
            format_vn_decimal(min_val),
            format_vn_decimal(max_val)
        )
    };

    Some(format!("{base}{period_suffix}"))
}

/// Formats an extracted field JSON value according to its `FieldType`.
pub fn format_field_value(field_type: FieldType, value: &serde_json::Value) -> Option<String> {
    if value.is_null() {
        return None;
    }

    let rendered = match field_type {
        FieldType::Money => format_vietnamese_money(value)?,
        FieldType::Phone => {
            let s = value.as_str()?;
            format_domestic_phone(s)
        }
        FieldType::Location => {
            if let Some(s) = value.as_str() {
                s.trim().to_string()
            } else if let Some(obj) = value.as_object() {
                let district = obj
                    .get("district")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let province = obj
                    .get("province")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let ward = obj
                    .get("ward")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let raw = obj
                    .get("raw")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());

                match (district, province) {
                    (Some(d), Some(p)) => format!("{d}, {p}"),
                    (Some(d), None) => d.to_string(),
                    (None, Some(p)) => {
                        if let Some(w) = ward {
                            format!("{w}, {p}")
                        } else {
                            p.to_string()
                        }
                    }
                    (None, None) => ward.or(raw)?.to_string(),
                }
            } else {
                return None;
            }
        }
        FieldType::Range => {
            if let Some(s) = value.as_str() {
                s.trim().to_string()
            } else if let Some(obj) = value.as_object() {
                let min_opt = obj.get("min").and_then(|v| v.as_f64());
                let max_opt = obj.get("max").and_then(|v| v.as_f64());
                let unit = obj
                    .get("unit")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let nums = match (min_opt, max_opt) {
                    (Some(a), Some(b)) if (b - a).abs() < 1e-9 => format_plain_number(a),
                    (Some(a), Some(b)) => {
                        format!("{}–{}", format_plain_number(a), format_plain_number(b))
                    }
                    (Some(a), None) => format_plain_number(a),
                    (None, Some(b)) => format_plain_number(b),
                    (None, None) => return None,
                };
                if let Some(u) = unit {
                    format!("{nums} {u}")
                } else {
                    nums
                }
            } else {
                return None;
            }
        }
        FieldType::Boolean => {
            let b = value.as_bool()?;
            if b {
                "Có".to_string()
            } else {
                "Không".to_string()
            }
        }
        FieldType::MultiEnum => {
            let arr = value.as_array()?;
            let items: Vec<&str> = arr
                .iter()
                .filter_map(|v| v.as_str().map(str::trim))
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() {
                return None;
            }
            items.join(", ")
        }
        FieldType::Number => {
            if let Some(n) = value.as_f64() {
                format_plain_number(n)
            } else if let Some(s) = value.as_str() {
                s.trim().to_string()
            } else {
                return None;
            }
        }
        FieldType::Text | FieldType::Enum | FieldType::Date | FieldType::Url => {
            if let Some(s) = value.as_str() {
                s.trim().to_string()
            } else if let Some(n) = value.as_f64() {
                format_plain_number(n)
            } else if let Some(b) = value.as_bool() {
                b.to_string()
            } else {
                return None;
            }
        }
    };

    if rendered.is_empty() {
        None
    } else {
        Some(rendered)
    }
}

/// Formats `post.created_at` relative to `now_ms` in Vietnamese (`"vừa thấy"` when `None`).
pub fn format_relative_time_vi(created_at_ms: Option<i64>, now_ms: i64) -> String {
    let Some(ts) = created_at_ms else {
        return "vừa thấy".to_string();
    };
    let diff_s = ((now_ms - ts) / 1000).max(0);
    if diff_s < 60 {
        "vừa xong".to_string()
    } else if diff_s < 3600 {
        format!("{} phút trước", diff_s / 60)
    } else if diff_s < 86_400 {
        format!("{} giờ trước", diff_s / 3600)
    } else {
        format!("{} ngày trước", diff_s / 86_400)
    }
}
