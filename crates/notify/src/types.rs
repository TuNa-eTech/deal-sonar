use serde::{Deserialize, Serialize};
use thiserror::Error;

/// All 11 radar field types defined in `docs/product/02-radar-spec.md §3.2`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Number,
    Money,
    Phone,
    Location,
    Enum,
    MultiEnum,
    Boolean,
    Date,
    Range,
    Url,
}

/// Radar field definition (`docs/product/02-radar-spec.md §3.1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub show_in_alert: bool,
    #[serde(default)]
    pub order: i32,
}

/// Provenance of an extracted field (`docs/product/02-radar-spec.md §3.3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    #[default]
    Ai,
    Rule,
    User,
}

fn default_confidence() -> f64 {
    1.0
}

/// Extracted field value with verbatim evidence (`docs/product/02-radar-spec.md §3.3`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: serde_json::Value,
    #[serde(default)]
    pub raw: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub source: FieldSource,
}

/// Errors produced by `dealsonar-notify`.
///
/// Security invariant: tokens and signing secrets are NEVER stored unredacted in error messages.
#[derive(Debug, Error)]
pub enum NotifyError {
    #[error("secret store error: {0}")]
    Secret(#[from] crate::secrets::SecretError),

    #[error("invalid permalink (must be a valid https:// URL): {0}")]
    InvalidPermalink(String),

    #[error("telegram callback_data exceeds <64 byte limit ({len} bytes) or is invalid")]
    InvalidCallbackData { len: usize },

    #[error("telegram HTTP failure: {0}")]
    TelegramHttp(String),

    #[error("telegram API error (code {error_code}): {description}")]
    TelegramApi {
        error_code: i32,
        description: String,
        retry_after_s: Option<u64>,
    },

    #[error("insecure or invalid webhook URL (must be https:// or http://localhost / http://127.0.0.1): {0}")]
    InsecureWebhookUrl(String),

    #[error("webhook delivery failed: {0}")]
    WebhookHttp(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("xlsx export error: {0}")]
    Xlsx(String),
}
