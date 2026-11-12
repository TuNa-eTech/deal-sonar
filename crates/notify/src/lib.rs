//! DealSonar notifications, OS keyring secrets, CSV/XLSX exporters, and signed webhooks.
//!
//! Implements `docs/specs/07-notifications-export.md`, `docs/specs/04-data-model.md §4`,
//! and security invariants from `docs/delivery/03-risks-compliance.md`.

pub mod export;
pub mod format;
pub mod secrets;
pub mod telegram;
pub mod types;
pub mod webhook;

pub use export::{
    export_csv, export_xlsx, format_local_iso8601, sanitize_spreadsheet_cell, ExportLeadRow,
    ExportOptions, UTF8_BOM,
};
pub use format::{
    build_acknowledged_keyboard, build_feedback_callback_data, build_lead_alert_keyboard,
    build_wrong_reasons_keyboard, escape_html, evaluate_notify_policy, format_digest_html,
    format_domestic_phone, format_field_value, format_lead_alert, format_relative_time_vi,
    format_system_alert_html, format_vietnamese_money, is_in_quiet_hours,
    is_valid_facebook_https_url, parse_feedback_callback_data, validate_callback_data_bytes,
    validate_https_permalink, DigestLeadItem, FormattedLeadAlert, InlineKeyboardButton,
    InlineKeyboardMarkup, LeadAlertInput, NotifyDecision, NotifyPolicyCheck, NotifySkipReason,
    QuietHours, SystemIncidentKind, FLOOD_LEADS_PER_HOUR_THRESHOLD, MAX_CALLBACK_DATA_BYTES,
    MAX_TELEGRAM_HTML_LEN,
};
pub use secrets::{
    redact_secret, telegram_channel_key, webhook_channel_key, InMemorySecretStore,
    KeyringSecretStore, SecretError, SecretStore, SecretString, KEYRING_SERVICE,
    TELEGRAM_BOT_TOKEN_KEY,
};
pub use telegram::{
    telegram_retry_backoff_s, BotInfo, BotStatusSummary, ChatRateLimiter, LinkPreviewOptions,
    PollUpdatesOptions, PollUpdatesResult, SendMessageRequest, TelegramClient,
    TelegramClientConfig, TelegramDeliveryOutcome, TelegramIncomingEvent,
    DEFAULT_GET_UPDATES_TIMEOUT_S, DEFAULT_TELEGRAM_API_BASE_URL, MAX_OUTBOX_QUEUE_AGE_MS,
    MAX_TELEGRAM_NETWORK_RETRIES,
};
pub use types::{ExtractedField, FieldDef, FieldSource, FieldType, NotifyError};
pub use webhook::{
    sign_webhook_body, validate_webhook_url, verify_webhook_signature, webhook_retry_backoff_s,
    WebhookClient, WebhookDeliveryOutcome, WebhookFieldEntry, WebhookLeadCreatedPayload,
    WebhookLeadPayload, WebhookPostPayload, WebhookRadarRef, DEFAULT_WEBHOOK_TIMEOUT,
    MAX_WEBHOOK_RETRIES, WEBHOOK_SIGNATURE_HEADER,
};
