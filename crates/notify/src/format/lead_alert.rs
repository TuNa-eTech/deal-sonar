//! Lead alert HTML assembly within Telegram length limits.

use super::*;

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

pub(super) fn truncate_chars_raw(s: &str, max_chars: usize) -> String {
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

pub(super) fn telegram_len(html: &str) -> usize {
    // UTF-16 code units are always >= Unicode scalar count (`chars().count()`),
    // so keeping `encode_utf16().count() <= 4096` satisfies both Telegram's UTF-16
    // length limit and `chars().count() <= 4096`.
    html.encode_utf16().count()
}

pub(super) struct PreparedBullet {
    pub(super) label: String,
    pub(super) value: String,
    pub(super) is_text: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn assemble_lead_html(
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
