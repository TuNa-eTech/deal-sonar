//! Telegram inline keyboards and feedback callback data.

use super::*;

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
