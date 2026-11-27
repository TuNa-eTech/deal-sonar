//! Digest and system incident alert formatting.

use super::*;

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
