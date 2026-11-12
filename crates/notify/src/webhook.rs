use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use chrono::{Local, SecondsFormat, TimeZone};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use ulid::Ulid;

use crate::secrets::redact_secret;
use crate::types::{ExtractedField, NotifyError};

type HmacSha256 = Hmac<Sha256>;

/// HTTP header carrying the HMAC-SHA256 webhook signature (`07-notifications-export.md §6`).
pub const WEBHOOK_SIGNATURE_HEADER: &str = "X-DealSonar-Signature";

/// Default webhook `POST` request timeout (`10 seconds` per `07-notifications-export.md §6`).
pub const DEFAULT_WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum number of exponential retry attempts for failed webhook deliveries (`07-notifications-export.md §6`).
pub const MAX_WEBHOOK_RETRIES: u32 = 5;

/// Validates a user-configured webhook target URL (`07-notifications-export.md §6`):
///
/// Must be either:
/// - `https://<host>...`
/// - `http://localhost...`
/// - `http://127.0.0.1...`
///
/// Rejects userinfo spoofing (`http://localhost@evil.com`) and subdomain spoofing (`http://localhost.evil.com`).
pub fn validate_webhook_url(raw_url: &str) -> Result<reqwest::Url, NotifyError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(NotifyError::InsecureWebhookUrl(raw_url.to_string()));
    }

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| NotifyError::InsecureWebhookUrl(raw_url.to_string()))?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(NotifyError::InsecureWebhookUrl(raw_url.to_string()));
    }

    let Some(host) = parsed.host_str() else {
        return Err(NotifyError::InsecureWebhookUrl(raw_url.to_string()));
    };
    if host.is_empty() {
        return Err(NotifyError::InsecureWebhookUrl(raw_url.to_string()));
    }

    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" => Ok(parsed),
        _ => Err(NotifyError::InsecureWebhookUrl(raw_url.to_string())),
    }
}

/// Computes `sha256=<hex>` HMAC-SHA256 signature over raw `body` bytes using `secret`.
pub fn sign_webhook_body(secret: &str, body: &[u8]) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any size");
    mac.update(body);
    let digest = mac.finalize().into_bytes();
    format!("sha256={}", hex::encode(digest))
}

/// Verifies `X-DealSonar-Signature: sha256=<hex>` in constant time.
pub fn verify_webhook_signature(secret: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(hex_part) = signature_header.trim().strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected_bytes) = hex::decode(hex_part) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected_bytes).is_ok()
}

/// Computes exponential retry backoff in seconds (`10s -> 10m`) for `prior_attempts` (`0..5`).
pub fn webhook_retry_backoff_s(prior_attempts: u32) -> Option<u64> {
    match prior_attempts {
        0 => Some(10),
        1 => Some(30),
        2 => Some(120),
        3 => Some(300),
        4 => Some(600),
        _ => None,
    }
}

/// Top-level `lead.created` webhook JSON payload (`07-notifications-export.md §6`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookLeadCreatedPayload {
    pub event: String,
    pub id: String,
    pub created_at: String,
    pub radar: WebhookRadarRef,
    pub lead: WebhookLeadPayload,
}

/// Radar reference inside `WebhookLeadCreatedPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebhookRadarRef {
    pub id: String,
    pub name: String,
}

/// Lead body inside `WebhookLeadCreatedPayload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookLeadPayload {
    pub id: String,
    pub score: f64,
    pub summary: String,
    pub fields: HashMap<String, WebhookFieldEntry>,
    pub post: WebhookPostPayload,
}

/// Extracted field representation in webhook payloads (`{ value, raw }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookFieldEntry {
    pub value: serde_json::Value,
    pub raw: String,
}

impl From<&ExtractedField> for WebhookFieldEntry {
    fn from(field: &ExtractedField) -> Self {
        Self {
            value: field.value.clone(),
            raw: field.raw.clone(),
        }
    }
}

impl From<ExtractedField> for WebhookFieldEntry {
    fn from(field: ExtractedField) -> Self {
        Self {
            value: field.value,
            raw: field.raw,
        }
    }
}

/// Post metadata inside `WebhookLeadPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebhookPostPayload {
    pub permalink: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub source: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

fn format_rfc3339_ms(ts_ms: i64) -> String {
    match Local.timestamp_millis_opt(ts_ms).single() {
        Some(dt) => dt.to_rfc3339_opts(SecondsFormat::Secs, false),
        None => "1970-01-01T00:00:00+00:00".to_string(),
    }
}

impl WebhookLeadCreatedPayload {
    /// Builds a `lead.created` payload with a fresh ULID event `id` and RFC3339 timestamps.
    #[allow(clippy::too_many_arguments)]
    pub fn new_lead_created(
        event_created_at_ms: i64,
        radar_id: impl Into<String>,
        radar_name: impl Into<String>,
        lead_id: impl Into<String>,
        score: f64,
        summary: impl Into<String>,
        extracted_fields: &HashMap<String, ExtractedField>,
        permalink: impl Into<String>,
        post_created_at_ms: Option<i64>,
        source_name: impl Into<String>,
        author_name: impl Into<String>,
        post_text: Option<String>,
    ) -> Self {
        let fields = extracted_fields
            .iter()
            .map(|(k, v)| (k.clone(), WebhookFieldEntry::from(v)))
            .collect();

        Self {
            event: "lead.created".to_string(),
            id: Ulid::new().to_string(),
            created_at: format_rfc3339_ms(event_created_at_ms),
            radar: WebhookRadarRef {
                id: radar_id.into(),
                name: radar_name.into(),
            },
            lead: WebhookLeadPayload {
                id: lead_id.into(),
                score,
                summary: summary.into(),
                fields,
                post: WebhookPostPayload {
                    permalink: permalink.into(),
                    created_at: post_created_at_ms.map(format_rfc3339_ms),
                    source: source_name.into(),
                    author: author_name.into(),
                    text: post_text,
                },
            },
        }
    }
}

/// Outcome of delivering a webhook `POST` for `outbox` state transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookDeliveryOutcome {
    /// Target endpoint responded with `2xx` within the 10-second timeout.
    Sent { status_code: u16 },
    /// Transient HTTP or network error; schedule next retry in `next_delay_s`.
    Retryable { next_delay_s: u64, reason: String },
    /// Exhausted all 5 retries.
    Exhausted { reason: String },
}

/// Webhook HTTP sender with URL scheme enforcement, HMAC-SHA256 signing, and 10s timeout.
#[derive(Clone)]
pub struct WebhookClient {
    http: reqwest::Client,
    timeout: Duration,
}

impl fmt::Debug for WebhookClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebhookClient")
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl WebhookClient {
    /// Creates a `WebhookClient` with the default 10-second timeout (`07-notifications-export.md §6`).
    pub fn new() -> Result<Self, NotifyError> {
        Self::with_timeout(DEFAULT_WEBHOOK_TIMEOUT)
    }

    /// Creates a `WebhookClient` with a custom request timeout.
    pub fn with_timeout(timeout: Duration) -> Result<Self, NotifyError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| NotifyError::WebhookHttp(e.without_url().to_string()))?;
        Ok(Self { http, timeout })
    }

    /// Validates `url`, signs the JSON body with `secret`, and executes a single `POST` attempt.
    ///
    /// Classifies `2xx` as `Sent` and non-2xx / network timeouts into 5-attempt exponential retry.
    pub async fn send_once(
        &self,
        url: &str,
        secret: &str,
        payload: &WebhookLeadCreatedPayload,
        prior_attempts: u32,
    ) -> Result<WebhookDeliveryOutcome, NotifyError> {
        let validated_url = validate_webhook_url(url)?;
        let body_bytes =
            serde_json::to_vec(payload).map_err(|e| NotifyError::Serialization(e.to_string()))?;
        let signature = sign_webhook_body(secret, &body_bytes);

        let resp_res = self
            .http
            .post(validated_url)
            .timeout(self.timeout)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(WEBHOOK_SIGNATURE_HEADER, signature)
            .body(body_bytes)
            .send()
            .await;

        match resp_res {
            Ok(resp) if resp.status().is_success() => Ok(WebhookDeliveryOutcome::Sent {
                status_code: resp.status().as_u16(),
            }),
            Ok(resp) => {
                let code = resp.status().as_u16();
                let reason = format!("HTTP {code}");
                Ok(Self::classify_failure(prior_attempts, reason))
            }
            Err(err) => {
                let reason = redact_secret(&err.without_url().to_string(), secret);
                Ok(Self::classify_failure(prior_attempts, reason))
            }
        }
    }

    /// Sends a webhook payload and automatically retries up to `retry_delays.len()` times
    /// (up to 5 retries) when transient errors occur.
    pub async fn send_with_retries(
        &self,
        url: &str,
        secret: &str,
        payload: &WebhookLeadCreatedPayload,
        retry_delays: &[Duration],
    ) -> Result<WebhookDeliveryOutcome, NotifyError> {
        let delays_slice = &retry_delays[..retry_delays.len().min(MAX_WEBHOOK_RETRIES as usize)];
        for (attempt, delay) in delays_slice.iter().enumerate() {
            let prior = u32::try_from(attempt).unwrap_or(MAX_WEBHOOK_RETRIES);
            let outcome = self.send_once(url, secret, payload, prior).await?;
            match outcome {
                WebhookDeliveryOutcome::Sent { .. } => return Ok(outcome),
                WebhookDeliveryOutcome::Retryable { .. } => {
                    tokio::time::sleep(*delay).await;
                }
                WebhookDeliveryOutcome::Exhausted { .. } => return Ok(outcome),
            }
        }
        let final_prior = u32::try_from(delays_slice.len()).unwrap_or(MAX_WEBHOOK_RETRIES);
        match self.send_once(url, secret, payload, final_prior).await? {
            sent @ WebhookDeliveryOutcome::Sent { .. } => Ok(sent),
            WebhookDeliveryOutcome::Retryable { reason, .. }
            | WebhookDeliveryOutcome::Exhausted { reason } => {
                Ok(WebhookDeliveryOutcome::Exhausted { reason })
            }
        }
    }

    fn classify_failure(prior_attempts: u32, reason: String) -> WebhookDeliveryOutcome {
        match webhook_retry_backoff_s(prior_attempts) {
            Some(next_delay_s) => WebhookDeliveryOutcome::Retryable {
                next_delay_s,
                reason,
            },
            None => WebhookDeliveryOutcome::Exhausted { reason },
        }
    }
}
