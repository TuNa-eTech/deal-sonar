use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::types::{ExtractedField, FieldDef, FieldType, NotifyError};

/// Telegram `sendMessage` maximum message length in characters / UTF-16 code units.
pub const MAX_TELEGRAM_HTML_LEN: usize = 4096;

/// Telegram `callback_data` strict upper bound (`< 64` bytes per `07-notifications-export.md §2.3`).
pub const MAX_CALLBACK_DATA_BYTES: usize = 64;

/// Radar hourly lead flood threshold triggering automatic digest mode (`07-notifications-export.md §3`).
pub const FLOOD_LEADS_PER_HOUR_THRESHOLD: usize = 30;

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

fn escape_html_attr(input: &str) -> String {
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

fn format_vn_decimal(val: f64) -> String {
    let rounded = (val * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < 1e-9 {
        format!("{}", rounded.round() as i64)
    } else {
        let s = format!("{rounded:.2}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        s.replace('.', ",")
    }
}

fn format_plain_number(val: f64) -> String {
    if (val - val.round()).abs() < 1e-9 {
        format!("{}", val.round() as i64)
    } else {
        let s = format!("{val:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn vnd_unit_and_scale(amount: f64) -> (&'static str, f64) {
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

fn format_single_vnd(amount: f64) -> String {
    let (unit, scale) = vnd_unit_and_scale(amount);
    format!("{} {unit}", format_vn_decimal(amount / scale))
}

fn format_period_vi(period: Option<&str>) -> &'static str {
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

/// Telegram inline keyboard markup (`reply_markup`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

/// Single button inside a Telegram inline keyboard row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineKeyboardButton {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_data: Option<String>,
}

impl InlineKeyboardButton {
    /// Creates a URL button after validating `https://`.
    pub fn url(text: impl Into<String>, url: &str) -> Result<Self, NotifyError> {
        let parsed = validate_https_permalink(url)?;
        Ok(Self {
            text: text.into(),
            url: Some(parsed.to_string()),
            callback_data: None,
        })
    }

    /// Creates a callback button while strictly enforcing `< 64` UTF-8 bytes on `callback_data`.
    pub fn callback(
        text: impl Into<String>,
        callback_data: impl Into<String>,
    ) -> Result<Self, NotifyError> {
        let data = callback_data.into();
        validate_callback_data_bytes(&data)?;
        Ok(Self {
            text: text.into(),
            url: None,
            callback_data: Some(data),
        })
    }
}

/// Enforces `1 <= len < 64` bytes on any Telegram `callback_data` payload.
pub fn validate_callback_data_bytes(data: &str) -> Result<(), NotifyError> {
    let len = data.len();
    if len == 0 || len >= MAX_CALLBACK_DATA_BYTES {
        return Err(NotifyError::InvalidCallbackData { len });
    }
    Ok(())
}

/// Builds `"fb:{lead_id}:{label}"` and enforces the `< 64` byte Telegram callback limit.
pub fn build_feedback_callback_data(lead_id: &str, label: &str) -> Result<String, NotifyError> {
    let lead_trimmed = lead_id.trim();
    let label_trimmed = label.trim();
    if lead_trimmed.is_empty()
        || label_trimmed.is_empty()
        || lead_trimmed.contains(':')
        || label_trimmed.contains(':')
    {
        return Err(NotifyError::InvalidCallbackData {
            len: lead_id.len() + label.len() + 4,
        });
    }
    let data = format!("fb:{lead_trimmed}:{label_trimmed}");
    validate_callback_data_bytes(&data)?;
    Ok(data)
}

/// Parses `"fb:<lead_id>:<action>"` from incoming Telegram `callback_query.data`.
pub fn parse_feedback_callback_data(data: &str) -> Option<(&str, &str)> {
    if data.is_empty() || data.len() >= MAX_CALLBACK_DATA_BYTES {
        return None;
    }
    let rest = data.strip_prefix("fb:")?;
    let (lead_id, action) = rest.split_once(':')?;
    if lead_id.is_empty() || action.is_empty() || action.contains(':') {
        return None;
    }
    Some((lead_id, action))
}

/// Builds the initial 3-button inline keyboard for a lead alert (`Mở bài viết`, `✅ Đúng`, `❌ Sai`).
pub fn build_lead_alert_keyboard(
    lead_id: &str,
    permalink: &str,
) -> Result<InlineKeyboardMarkup, NotifyError> {
    // Also pre-validate the longest reason callback ("irrelevant", 10 bytes) so follow-up
    // reason buttons are guaranteed `< 64` bytes for this `lead_id`.
    let _ = build_feedback_callback_data(lead_id, "irrelevant")?;
    let open_btn = InlineKeyboardButton::url("Mở bài viết", permalink)?;
    let correct_btn = InlineKeyboardButton::callback(
        "✅ Đúng",
        build_feedback_callback_data(lead_id, "correct")?,
    )?;
    let wrong_btn =
        InlineKeyboardButton::callback("❌ Sai", build_feedback_callback_data(lead_id, "wrong")?)?;
    Ok(InlineKeyboardMarkup {
        inline_keyboard: vec![vec![open_btn, correct_btn, wrong_btn]],
    })
}

/// Builds the 4-reason inline keyboard shown when a user clicks `❌ Sai`, preserving any URL button.
pub fn build_wrong_reasons_keyboard(
    lead_id: &str,
    existing_url_button: Option<InlineKeyboardButton>,
) -> Result<InlineKeyboardMarkup, NotifyError> {
    let irrelevant = InlineKeyboardButton::callback(
        "Không liên quan",
        build_feedback_callback_data(lead_id, "irrelevant")?,
    )?;
    let peer = InlineKeyboardButton::callback(
        "Cùng nghề",
        build_feedback_callback_data(lead_id, "peer")?,
    )?;
    let duplicate = InlineKeyboardButton::callback(
        "Trùng",
        build_feedback_callback_data(lead_id, "duplicate")?,
    )?;
    let spam =
        InlineKeyboardButton::callback("Rác", build_feedback_callback_data(lead_id, "spam")?)?;

    let mut rows = Vec::with_capacity(3);
    if let Some(url_btn) = existing_url_button {
        rows.push(vec![url_btn]);
    }
    rows.push(vec![irrelevant, peer]);
    rows.push(vec![duplicate, spam]);
    Ok(InlineKeyboardMarkup {
        inline_keyboard: rows,
    })
}

/// Builds the post-feedback confirmation keyboard (`✅ Đã ghi nhận` or `📝 Đã ghi nhận`),
/// preserving any original `"Mở bài viết"` URL button.
pub fn build_acknowledged_keyboard(
    ack_label: &str,
    existing_url_button: Option<InlineKeyboardButton>,
) -> Result<InlineKeyboardMarkup, NotifyError> {
    let ack_btn = InlineKeyboardButton::callback(ack_label, "noop")?;
    let row = match existing_url_button {
        Some(url_btn) => vec![url_btn, ack_btn],
        None => vec![ack_btn],
    };
    Ok(InlineKeyboardMarkup {
        inline_keyboard: vec![row],
    })
}

/// Input data required to format a Telegram lead alert (`07-notifications-export.md §2.2`).
#[derive(Debug, Clone)]
pub struct LeadAlertInput {
    pub lead_id: String,
    pub radar_name: String,
    pub summary: String,
    pub field_defs: Vec<FieldDef>,
    pub extracted_fields: HashMap<String, ExtractedField>,
    pub group_name: String,
    pub author_name: Option<String>,
    pub post_created_at_ms: Option<i64>,
    pub now_ms: i64,
    pub other_group_count: usize,
    pub permalink: String,
}

/// Rendered Telegram HTML lead alert and its validated inline keyboard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormattedLeadAlert {
    pub html: String,
    pub reply_markup: InlineKeyboardMarkup,
}

fn truncate_chars_raw(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let keep = max_chars.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

fn telegram_len(html: &str) -> usize {
    // UTF-16 code units are always >= Unicode scalar count (`chars().count()`),
    // so keeping `encode_utf16().count() <= 4096` satisfies both Telegram's UTF-16
    // length limit and `chars().count() <= 4096`.
    html.encode_utf16().count()
}

struct PreparedBullet {
    label: String,
    value: String,
    is_text: bool,
}

#[allow(clippy::too_many_arguments)]
fn assemble_lead_html(
    radar_name_raw: &str,
    summary_raw: &str,
    bullets: &[PreparedBullet],
    text_field_cap: Option<usize>,
    group_name_raw: &str,
    author_name_raw: &str,
    rel_time_raw: &str,
    other_group_count: usize,
) -> String {
    let mut parts = Vec::with_capacity(4);
    parts.push(format!("🎯 <b>{}</b>", escape_html(radar_name_raw)));
    parts.push(escape_html(summary_raw));

    let mut bullet_lines = Vec::with_capacity(bullets.len());
    for b in bullets {
        let val = match (b.is_text, text_field_cap) {
            (true, Some(cap)) => truncate_chars_raw(&b.value, cap),
            _ => b.value.clone(),
        };
        if !val.is_empty() {
            bullet_lines.push(format!(
                "• {}: {}",
                escape_html(&b.label),
                escape_html(&val)
            ));
        }
    }
    if !bullet_lines.is_empty() {
        parts.push(bullet_lines.join("\n"));
    }

    let mut footer = format!(
        "👥 {} · {} · {}",
        escape_html(group_name_raw),
        escape_html(author_name_raw),
        escape_html(rel_time_raw)
    );
    if other_group_count > 0 {
        footer.push_str(&format!(
            "\n🔁 Cũng xuất hiện ở {other_group_count} group khác"
        ));
    }
    parts.push(footer);

    parts.join("\n\n")
}

/// Formats a lead alert into escaped Telegram HTML + inline keyboard (`07-notifications-export.md §2.2`).
///
/// Security & length invariants:
/// - Escapes `<`, `>`, `&` in every dynamic string.
/// - Validates `permalink` is `https://` and never truncates it.
/// - Enforces `< 64` bytes on every `callback_data`.
/// - Truncates `summary` and `text`-type field values *before* HTML-escaping when length exceeds 4096.
pub fn format_lead_alert(input: &LeadAlertInput) -> Result<FormattedLeadAlert, NotifyError> {
    let parsed_permalink = validate_https_permalink(&input.permalink)?;
    let reply_markup = build_lead_alert_keyboard(&input.lead_id, parsed_permalink.as_str())?;

    let mut sorted_defs: Vec<&FieldDef> = input
        .field_defs
        .iter()
        .filter(|f| f.show_in_alert)
        .collect();
    sorted_defs.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));

    let mut bullets = Vec::new();
    for def in sorted_defs {
        if let Some(extracted) = input.extracted_fields.get(&def.key) {
            if let Some(formatted_val) = format_field_value(def.r#type, &extracted.value) {
                bullets.push(PreparedBullet {
                    label: def.label.clone(),
                    value: formatted_val,
                    is_text: def.r#type == FieldType::Text,
                });
            }
        }
    }

    let author_raw = input
        .author_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Ẩn danh");
    let rel_time = format_relative_time_vi(input.post_created_at_ms, input.now_ms);

    let initial_html = assemble_lead_html(
        &input.radar_name,
        &input.summary,
        &bullets,
        None,
        &input.group_name,
        author_raw,
        &rel_time,
        input.other_group_count,
    );

    if telegram_len(&initial_html) <= MAX_TELEGRAM_HTML_LEN {
        return Ok(FormattedLeadAlert {
            html: initial_html,
            reply_markup,
        });
    }

    // Step 1: Try truncating only `text`-type field values first (keeping full `summary` if possible).
    let max_text_chars = bullets
        .iter()
        .filter(|b| b.is_text)
        .map(|b| b.value.chars().count())
        .max()
        .unwrap_or(0);

    if max_text_chars > 0 {
        let min_text_html = assemble_lead_html(
            &input.radar_name,
            &input.summary,
            &bullets,
            Some(0),
            &input.group_name,
            author_raw,
            &rel_time,
            input.other_group_count,
        );
        if telegram_len(&min_text_html) <= MAX_TELEGRAM_HTML_LEN {
            let mut lo = 0usize;
            let mut hi = max_text_chars;
            let mut best = min_text_html;
            while lo <= hi {
                let mid = lo + (hi - lo) / 2;
                let candidate = assemble_lead_html(
                    &input.radar_name,
                    &input.summary,
                    &bullets,
                    Some(mid),
                    &input.group_name,
                    author_raw,
                    &rel_time,
                    input.other_group_count,
                );
                if telegram_len(&candidate) <= MAX_TELEGRAM_HTML_LEN {
                    best = candidate;
                    lo = mid + 1;
                } else if mid == 0 {
                    break;
                } else {
                    hi = mid - 1;
                }
            }
            return Ok(FormattedLeadAlert {
                html: best,
                reply_markup,
            });
        }
    }

    // Step 2: Jointly truncate both `summary` and `text`-type field values before HTML-escaping.
    let summary_chars = input.summary.chars().count();
    let max_joint = summary_chars.max(max_text_chars);
    let zero_joint_html = assemble_lead_html(
        &input.radar_name,
        "",
        &bullets,
        Some(0),
        &input.group_name,
        author_raw,
        &rel_time,
        input.other_group_count,
    );
    if telegram_len(&zero_joint_html) <= MAX_TELEGRAM_HTML_LEN {
        let mut lo = 0usize;
        let mut hi = max_joint;
        let mut best = zero_joint_html;
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            let truncated_summary = truncate_chars_raw(&input.summary, mid);
            let candidate = assemble_lead_html(
                &input.radar_name,
                &truncated_summary,
                &bullets,
                Some(mid),
                &input.group_name,
                author_raw,
                &rel_time,
                input.other_group_count,
            );
            if telegram_len(&candidate) <= MAX_TELEGRAM_HTML_LEN {
                best = candidate;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        return Ok(FormattedLeadAlert {
            html: best,
            reply_markup,
        });
    }

    // Step 3: Defensive fallback if non-text fields / metadata alone exceeded 4096 chars.
    let mut kept_bullets = bullets;
    while !kept_bullets.is_empty() {
        kept_bullets.pop();
        let candidate = assemble_lead_html(
            &input.radar_name,
            "",
            &kept_bullets,
            Some(0),
            &input.group_name,
            author_raw,
            &rel_time,
            input.other_group_count,
        );
        if telegram_len(&candidate) <= MAX_TELEGRAM_HTML_LEN {
            return Ok(FormattedLeadAlert {
                html: candidate,
                reply_markup,
            });
        }
    }

    let safe_radar = truncate_chars_raw(&input.radar_name, 200);
    let safe_group = truncate_chars_raw(&input.group_name, 120);
    let safe_author = truncate_chars_raw(author_raw, 80);
    let fallback = assemble_lead_html(
        &safe_radar,
        "",
        &[],
        Some(0),
        &safe_group,
        &safe_author,
        &rel_time,
        input.other_group_count,
    );
    Ok(FormattedLeadAlert {
        html: fallback,
        reply_markup,
    })
}

/// Summary item for a single lead inside a periodic digest message (`07-notifications-export.md §3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DigestLeadItem {
    pub lead_id: String,
    pub summary: String,
    pub score: f64,
    pub source_name: Option<String>,
    pub permalink: Option<String>,
}

/// Formats up to 10 leads into a compact digest HTML message (`07-notifications-export.md §3`).
pub fn format_digest_html(
    radar_name: &str,
    leads_top_10: &[DigestLeadItem],
    remaining_count: usize,
) -> String {
    let shown = &leads_top_10[..leads_top_10.len().min(10)];
    let overflow = leads_top_10.len().saturating_sub(10);
    let total_remaining = remaining_count + overflow;

    let render_with_cap = |summary_cap: usize| -> String {
        let mut lines = Vec::with_capacity(shown.len() + 3);
        lines.push(format!("📋 <b>Gộp tin: {}</b>", escape_html(radar_name)));
        lines.push(String::new());

        for (idx, item) in shown.iter().enumerate() {
            let truncated = truncate_chars_raw(&item.summary, summary_cap);
            let mut line = format!("{}. {}", idx + 1, escape_html(&truncated));
            if let Some(src) = item
                .source_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                line.push_str(&format!(" · <i>{}</i>", escape_html(src)));
            }
            if let Some(link) = item.permalink.as_deref() {
                if let Ok(parsed) = validate_https_permalink(link) {
                    line.push_str(&format!(
                        " (<a href=\"{}\">Mở</a>)",
                        escape_html_attr(parsed.as_str())
                    ));
                }
            }
            lines.push(line);
        }

        if total_remaining > 0 {
            lines.push(String::new());
            lines.push(format!("… và {total_remaining} tin khác"));
        }

        lines.join("\n")
    };

    let full = render_with_cap(140);
    if telegram_len(&full) <= MAX_TELEGRAM_HTML_LEN {
        return full;
    }

    for cap in [100, 70, 45, 25, 12] {
        let candidate = render_with_cap(cap);
        if telegram_len(&candidate) <= MAX_TELEGRAM_HTML_LEN {
            return candidate;
        }
    }
    render_with_cap(8)
}

/// System incident types covered by `07-notifications-export.md §3`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemIncidentKind {
    /// Facebook requires re-login or checkpoint verification.
    FacebookSessionIssue,
    /// Chrome extension disconnected for >30 minutes during active hours.
    ExtensionDisconnected,
    /// AI CLI unavailable for >30 minutes with `pending_posts` waiting.
    AiUnavailable { pending_posts: usize },
    /// Facebook DOM/GraphQL structure changed so extractor cannot read posts.
    ExtractorBroken,
    /// Radar generated >30 leads in 1 hour and was automatically switched to digest mode.
    RadarFloodAutoDigest {
        radar_name: String,
        leads_last_hour: usize,
    },
}

/// Formats a system incident or resolution alert into escaped Telegram HTML (`07-notifications-export.md §3`).
pub fn format_system_alert_html(incident_kind: &SystemIncidentKind, resolved: bool) -> String {
    if !resolved {
        match incident_kind {
            SystemIncidentKind::FacebookSessionIssue => {
                "⚠️ <b>Cảnh báo hệ thống</b>\n\nDealSonar đã dừng quét vì Facebook yêu cầu đăng nhập lại / xác minh".to_string()
            }
            SystemIncidentKind::ExtensionDisconnected => {
                "⚠️ <b>Cảnh báo hệ thống</b>\n\nKhông thấy Chrome. Radar đang tạm ngừng".to_string()
            }
            SystemIncidentKind::AiUnavailable { pending_posts } => format!(
                "⚠️ <b>Cảnh báo hệ thống</b>\n\nKhông gọi được AI. {pending_posts} bài đang chờ"
            ),
            SystemIncidentKind::ExtractorBroken => {
                "⚠️ <b>Cảnh báo hệ thống</b>\n\nFacebook có thay đổi, cần cập nhật DealSonar".to_string()
            }
            SystemIncidentKind::RadarFloodAutoDigest {
                radar_name,
                leads_last_hour,
            } => format!(
                "⚠️ <b>Chống dồn dập: {}</b>\n\nRadar đã tạo {leads_last_hour} tin trong 1 giờ qua (vượt ngưỡng {FLOOD_LEADS_PER_HOUR_THRESHOLD} tin/giờ) nên tự chuyển sang gửi gộp. Đề nghị xem lại mô tả radar.",
                escape_html(radar_name)
            ),
        }
    } else {
        match incident_kind {
            SystemIncidentKind::FacebookSessionIssue => {
                "✅ <b>Đã khôi phục</b>\n\nPhiên Facebook đã hoạt động bình thường trở lại. DealSonar đã tiếp tục quét.".to_string()
            }
            SystemIncidentKind::ExtensionDisconnected => {
                "✅ <b>Đã khôi phục</b>\n\nĐã kết nối lại với Chrome. Radar tiếp tục hoạt động.".to_string()
            }
            SystemIncidentKind::AiUnavailable { .. } => {
                "✅ <b>Đã khôi phục</b>\n\nKết nối AI đã hoạt động trở lại. Đang xử lý các bài chờ.".to_string()
            }
            SystemIncidentKind::ExtractorBroken => {
                "✅ <b>Đã khôi phục</b>\n\nBộ trích đã đọc lại được bài viết bình thường.".to_string()
            }
            SystemIncidentKind::RadarFloodAutoDigest { radar_name, .. } => format!(
                "✅ <b>Đã khôi phục: {}</b>\n\nLượng tin của radar đã ổn định trở lại.",
                escape_html(radar_name)
            ),
        }
    }
}

/// Quiet hours window (`"HH:MM"` 24-hour local time, e.g. `22:30` to `06:30`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuietHours {
    pub from: String,
    pub to: String,
}

fn parse_hh_mm(s: &str) -> Option<u16> {
    let (h_str, m_str) = s.trim().split_once(':')?;
    let h: u16 = h_str.parse().ok()?;
    let m: u16 = m_str.parse().ok()?;
    if h < 24 && m < 60 {
        Some(h * 60 + m)
    } else {
        None
    }
}

/// Returns `true` if `local_minutes_since_midnight` (`hour * 60 + minute`) falls inside `quiet`.
pub fn is_in_quiet_hours(quiet: &QuietHours, hour: u8, minute: u8) -> bool {
    let Some(from_m) = parse_hh_mm(&quiet.from) else {
        return false;
    };
    let Some(to_m) = parse_hh_mm(&quiet.to) else {
        return false;
    };
    let cur = u16::from(hour) * 60 + u16::from(minute);
    match from_m.cmp(&to_m) {
        std::cmp::Ordering::Equal => false,
        std::cmp::Ordering::Less => cur >= from_m && cur < to_m,
        std::cmp::Ordering::Greater => cur >= from_m || cur < to_m,
    }
}

/// Reason a lead was not queued for notification (`07-notifications-export.md §3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifySkipReason {
    RadarNotActive,
    NoChannelsConfigured,
    BelowMinScore,
    DuplicateClusterMember,
    StaleEvaluation,
    PreviewOrBackfill,
}

/// Routing decision for a newly matched lead (`07-notifications-export.md §3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyDecision {
    SendInstant { trigger_flood_auto_digest: bool },
    QueueDigest { trigger_flood_auto_digest: bool },
    Skip(NotifySkipReason),
}

/// Input parameters for evaluating `07-notifications-export.md §3` notification rules.
#[derive(Debug, Clone)]
pub struct NotifyPolicyCheck<'a> {
    pub radar_active: bool,
    pub has_channels: bool,
    pub digest_mode: bool,
    pub score: f64,
    pub min_score: f64,
    pub is_cluster_head: bool,
    pub repost_after_72h: bool,
    pub captured_at_ms: i64,
    pub decided_at_ms: i64,
    pub quiet_hours: Option<&'a QuietHours>,
    pub local_hour: u8,
    pub local_minute: u8,
    pub is_preview_or_backfill: bool,
    pub leads_in_last_hour: usize,
}

/// Evaluates all 6 notification rules + quiet hours + `> 30/hr` flood guard (`07-notifications-export.md §3`).
pub fn evaluate_notify_policy(check: &NotifyPolicyCheck<'_>) -> NotifyDecision {
    const SIX_HOURS_MS: i64 = 6 * 60 * 60 * 1000;

    if !check.radar_active {
        return NotifyDecision::Skip(NotifySkipReason::RadarNotActive);
    }
    if !check.has_channels {
        return NotifyDecision::Skip(NotifySkipReason::NoChannelsConfigured);
    }
    if check.is_preview_or_backfill {
        return NotifyDecision::Skip(NotifySkipReason::PreviewOrBackfill);
    }
    if check.score < check.min_score {
        return NotifyDecision::Skip(NotifySkipReason::BelowMinScore);
    }
    if !check.is_cluster_head && !check.repost_after_72h {
        return NotifyDecision::Skip(NotifySkipReason::DuplicateClusterMember);
    }
    if check.decided_at_ms.saturating_sub(check.captured_at_ms) > SIX_HOURS_MS {
        return NotifyDecision::Skip(NotifySkipReason::StaleEvaluation);
    }

    let flood = check.leads_in_last_hour > FLOOD_LEADS_PER_HOUR_THRESHOLD;
    let in_quiet = check
        .quiet_hours
        .is_some_and(|qh| is_in_quiet_hours(qh, check.local_hour, check.local_minute));

    if check.digest_mode || flood || in_quiet {
        NotifyDecision::QueueDigest {
            trigger_flood_auto_digest: flood && !check.digest_mode,
        }
    } else {
        NotifyDecision::SendInstant {
            trigger_flood_auto_digest: false,
        }
    }
}
