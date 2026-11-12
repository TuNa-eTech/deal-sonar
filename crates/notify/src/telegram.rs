use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::format::{
    build_acknowledged_keyboard, build_wrong_reasons_keyboard, escape_html,
    parse_feedback_callback_data, validate_https_permalink, FormattedLeadAlert,
    InlineKeyboardButton, InlineKeyboardMarkup,
};
use crate::secrets::redact_secret;
use crate::types::NotifyError;

/// Default Telegram Bot API base URL.
pub const DEFAULT_TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";

/// Long-polling `getUpdates` default server-side wait timeout in seconds (`07-notifications-export.md §2.3`).
pub const DEFAULT_GET_UPDATES_TIMEOUT_S: u32 = 50;

/// Maximum network retry count before dropping an outbox message (`07-notifications-export.md §2.4`).
pub const MAX_TELEGRAM_NETWORK_RETRIES: u32 = 5;

/// Maximum time an outbox item may wait in queue before being dropped (`2 hours` in ms).
pub const MAX_OUTBOX_QUEUE_AGE_MS: i64 = 2 * 60 * 60 * 1000;

/// Computes the exponential backoff delay (`10s` -> `10m`) for `prior_attempts` (`0..5`).
///
/// Returns `None` once 5 retries have already been attempted (`prior_attempts >= 5`).
pub fn telegram_retry_backoff_s(prior_attempts: u32) -> Option<u64> {
    match prior_attempts {
        0 => Some(10),
        1 => Some(30),
        2 => Some(120),
        3 => Some(300),
        4 => Some(600),
        _ => None,
    }
}

/// Per-chat Telegram rate limiter (`07-notifications-export.md §2.4`):
/// - Max 1 message / second per `chat_id`
/// - Max 20 messages / minute for group chats (`chat_id < 0`)
#[derive(Debug, Default)]
pub struct ChatRateLimiter {
    state: Mutex<HashMap<i64, ChatRateWindow>>,
}

#[derive(Debug, Default)]
struct ChatRateWindow {
    last_sent: Option<Instant>,
    recent_minute: VecDeque<Instant>,
}

impl ChatRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks whether a send to `chat_id` is allowed at `now`.
    ///
    /// If allowed, records the send timestamp and returns `Ok(())`.
    /// If rate-limited, returns `Err(wait_duration)` without recording a send.
    pub fn check_and_record(&self, chat_id: i64, now: Instant) -> Result<(), Duration> {
        const PER_CHAT_MIN_GAP: Duration = Duration::from_secs(1);
        const GROUP_WINDOW: Duration = Duration::from_secs(60);
        const GROUP_MAX_PER_MIN: usize = 20;

        let mut map = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(chat_id).or_default();

        let mut required_wait = Duration::ZERO;

        if let Some(last) = entry.last_sent {
            let elapsed = now.saturating_duration_since(last);
            if elapsed < PER_CHAT_MIN_GAP {
                required_wait = required_wait.max(PER_CHAT_MIN_GAP - elapsed);
            }
        }

        if chat_id < 0 {
            while let Some(&oldest) = entry.recent_minute.front() {
                if now.saturating_duration_since(oldest) >= GROUP_WINDOW {
                    entry.recent_minute.pop_front();
                } else {
                    break;
                }
            }
            if entry.recent_minute.len() >= GROUP_MAX_PER_MIN {
                if let Some(&oldest) = entry.recent_minute.front() {
                    let elapsed = now.saturating_duration_since(oldest);
                    if elapsed < GROUP_WINDOW {
                        required_wait = required_wait.max(GROUP_WINDOW - elapsed);
                    }
                }
            }
        }

        if !required_wait.is_zero() {
            return Err(required_wait);
        }

        entry.last_sent = Some(now);
        if chat_id < 0 {
            entry.recent_minute.push_back(now);
        }
        Ok(())
    }

    /// Waits asynchronously until a message slot is available for `chat_id`, then claims it.
    pub async fn acquire(&self, chat_id: i64) {
        loop {
            match self.check_and_record(chat_id, Instant::now()) {
                Ok(()) => return,
                Err(wait) => tokio::time::sleep(wait).await,
            }
        }
    }
}

/// Telegram bot identity returned by `getMe` (`07-notifications-export.md §2.1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotInfo {
    pub id: i64,
    #[serde(default)]
    pub username: String,
    pub first_name: String,
}

/// Outgoing `sendMessage` request payload.
#[derive(Debug, Clone, Serialize)]
pub struct SendMessageRequest {
    pub chat_id: i64,
    pub text: String,
    pub parse_mode: String,
    pub link_preview_options: LinkPreviewOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboardMarkup>,
}

/// Disables Telegram link previews per `07-notifications-export.md §2.2`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LinkPreviewOptions {
    pub is_disabled: bool,
}

impl SendMessageRequest {
    /// Creates an HTML message request with link previews disabled.
    pub fn html(
        chat_id: i64,
        html: impl Into<String>,
        reply_markup: Option<InlineKeyboardMarkup>,
    ) -> Self {
        Self {
            chat_id,
            text: html.into(),
            parse_mode: "HTML".to_string(),
            link_preview_options: LinkPreviewOptions { is_disabled: true },
            reply_markup,
        }
    }
}

/// Actionable delivery result for SQLite `outbox` processing (`07-notifications-export.md §2.4`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramDeliveryOutcome {
    /// Delivered (`200 OK`); store `message_id` in `outbox.remote_id`.
    Sent { message_id: i64 },
    /// HTTP 429 rate limit; reschedule after exact `retry_after_s`.
    RateLimited { retry_after_s: u64 },
    /// HTTP 401 or 403 (bot token revoked or bot blocked/kicked); mark `channels.state = "error"`.
    AuthRevoked,
    /// Transient network/5xx error within retry budget; reschedule after `next_delay_s`.
    RetryableNetwork { next_delay_s: u64 },
    /// Queued > 2 hours or exhausted all 5 retries; mark `outbox.state = "dropped"`.
    Dropped { reason: String },
    /// Non-retryable 4xx API rejection (e.g. malformed payload).
    PermanentFailure {
        status_code: u16,
        description: String,
    },
}

/// Summary data used to reply to `/status` commands (`07-notifications-export.md §2.3`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotStatusSummary {
    pub active_radars: usize,
    pub leads_today: usize,
    pub health_summary: String,
    pub notifications_paused: bool,
}

/// Typed incoming event emitted by the long-polling `getUpdates` receiver (`07-notifications-export.md §2.3`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TelegramIncomingEvent {
    StartCommand {
        chat_id: i64,
        chat_title: String,
        is_group: bool,
    },
    LeadFeedback {
        chat_id: i64,
        lead_id: String,
        label: String,
    },
    PauseCommand {
        chat_id: i64,
    },
    ResumeCommand {
        chat_id: i64,
    },
    StatusCommand {
        chat_id: i64,
    },
}

/// Options controlling a single `poll_updates` cycle.
#[derive(Debug, Clone)]
pub struct PollUpdatesOptions {
    pub offset: Option<i64>,
    pub timeout_s: u32,
    pub bot_username: Option<String>,
    pub registered_chat_ids: HashSet<i64>,
}

impl Default for PollUpdatesOptions {
    fn default() -> Self {
        Self {
            offset: None,
            timeout_s: DEFAULT_GET_UPDATES_TIMEOUT_S,
            bot_username: None,
            registered_chat_ids: HashSet::new(),
        }
    }
}

/// Result of a single `poll_updates` call, including the updated `offset` to persist in `settings`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollUpdatesResult {
    pub events: Vec<TelegramIncomingEvent>,
    pub next_offset: Option<i64>,
    pub rejected_unregistered_count: usize,
}

/// Configuration for `TelegramClient`.
#[derive(Debug, Clone)]
pub struct TelegramClientConfig {
    pub api_base_url: String,
    pub request_timeout: Duration,
    pub enforce_rate_limits: bool,
}

impl Default for TelegramClientConfig {
    fn default() -> Self {
        Self {
            api_base_url: DEFAULT_TELEGRAM_API_BASE_URL.to_string(),
            request_timeout: Duration::from_secs(15),
            enforce_rate_limits: true,
        }
    }
}

/// Telegram Bot API client supporting `getMe`, rate-limited HTML alerts, and long-polling `getUpdates`.
#[derive(Clone)]
pub struct TelegramClient {
    http: reqwest::Client,
    api_base_url: String,
    request_timeout: Duration,
    enforce_rate_limits: bool,
    rate_limiter: Arc<ChatRateLimiter>,
}

impl fmt::Debug for TelegramClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TelegramClient")
            .field("api_base_url", &self.api_base_url)
            .field("request_timeout", &self.request_timeout)
            .field("enforce_rate_limits", &self.enforce_rate_limits)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
struct TgEnvelope<T> {
    ok: bool,
    result: Option<T>,
    error_code: Option<i32>,
    description: Option<String>,
    parameters: Option<TgResponseParameters>,
}

#[derive(Debug, Deserialize)]
struct TgResponseParameters {
    retry_after: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TgSentMessage {
    message_id: i64,
}

#[derive(Debug, Deserialize)]
struct TgUpdate {
    update_id: i64,
    message: Option<TgMessage>,
    callback_query: Option<TgCallbackQuery>,
}

#[derive(Debug, Deserialize)]
struct TgMessage {
    message_id: i64,
    chat: TgChat,
    text: Option<String>,
    reply_markup: Option<InlineKeyboardMarkup>,
}

#[derive(Debug, Deserialize)]
struct TgChat {
    id: i64,
    #[serde(rename = "type", default)]
    kind: String,
    title: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgCallbackQuery {
    id: String,
    message: Option<TgMessage>,
    data: Option<String>,
}

impl TelegramClient {
    /// Creates a `TelegramClient` pointing at `https://api.telegram.org`.
    pub fn new() -> Result<Self, NotifyError> {
        Self::with_config(TelegramClientConfig::default())
    }

    /// Creates a `TelegramClient` with a custom `api_base_url` (e.g. local mock server in tests).
    pub fn with_base_url(api_base_url: impl Into<String>) -> Result<Self, NotifyError> {
        Self::with_config(TelegramClientConfig {
            api_base_url: api_base_url.into(),
            ..TelegramClientConfig::default()
        })
    }

    /// Creates a `TelegramClient` from `TelegramClientConfig`.
    pub fn with_config(config: TelegramClientConfig) -> Result<Self, NotifyError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| NotifyError::TelegramHttp(e.without_url().to_string()))?;
        let base = config.api_base_url.trim_end_matches('/').to_string();
        Ok(Self {
            http,
            api_base_url: base,
            request_timeout: config.request_timeout,
            enforce_rate_limits: config.enforce_rate_limits,
            rate_limiter: Arc::new(ChatRateLimiter::new()),
        })
    }

    /// Accesses the shared per-chat rate limiter.
    pub fn rate_limiter(&self) -> &ChatRateLimiter {
        &self.rate_limiter
    }

    fn endpoint(&self, token: &str, method: &str) -> String {
        format!("{}/bot{}/{}", self.api_base_url, token, method)
    }

    fn sanitize_reqwest_err(err: reqwest::Error, token: &str) -> String {
        redact_secret(&err.without_url().to_string(), token)
    }

    /// Verifies a bot token via `getMe` and returns `BotInfo { id, username, first_name }`.
    pub async fn get_me(&self, token: &str) -> Result<BotInfo, NotifyError> {
        let resp = self
            .http
            .get(self.endpoint(token, "getMe"))
            .timeout(self.request_timeout)
            .send()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        if let Ok(parsed) = serde_json::from_str::<TgEnvelope<BotInfo>>(&body_text) {
            if parsed.ok {
                if let Some(info) = parsed.result {
                    return Ok(info);
                }
            }
            return Err(NotifyError::TelegramApi {
                error_code: parsed.error_code.unwrap_or(i32::from(status.as_u16())),
                description: redact_secret(
                    &parsed
                        .description
                        .unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
                    token,
                ),
                retry_after_s: parsed.parameters.and_then(|p| p.retry_after),
            });
        }

        Err(NotifyError::TelegramApi {
            error_code: i32::from(status.as_u16()),
            description: redact_secret(&body_text, token),
            retry_after_s: None,
        })
    }

    /// Convenience helper sending a formatted lead alert immediately (`prior_attempts = 0, queued_age_ms = 0`).
    pub async fn send_lead_alert(
        &self,
        token: &str,
        chat_id: i64,
        alert: &FormattedLeadAlert,
    ) -> TelegramDeliveryOutcome {
        let req = SendMessageRequest::html(
            chat_id,
            alert.html.clone(),
            Some(alert.reply_markup.clone()),
        );
        self.deliver_outbox_message(token, &req, 0, 0).await
    }

    /// Delivers a `SendMessageRequest` while enforcing rate limits, 2h queue expiry, 5-attempt
    /// exponential retry backoff, HTTP 429 `retry_after`, and HTTP 401/403 `AuthRevoked`.
    pub async fn deliver_outbox_message(
        &self,
        token: &str,
        req: &SendMessageRequest,
        prior_attempts: u32,
        queued_age_ms: i64,
    ) -> TelegramDeliveryOutcome {
        if queued_age_ms > MAX_OUTBOX_QUEUE_AGE_MS {
            return TelegramDeliveryOutcome::Dropped {
                reason: format!(
                    "queued_age_ms ({queued_age_ms}) exceeded max queue age ({MAX_OUTBOX_QUEUE_AGE_MS})"
                ),
            };
        }

        if self.enforce_rate_limits {
            self.rate_limiter.acquire(req.chat_id).await;
        }

        let send_res = self
            .http
            .post(self.endpoint(token, "sendMessage"))
            .timeout(self.request_timeout)
            .json(req)
            .send()
            .await;

        let resp = match send_res {
            Ok(r) => r,
            Err(err) => {
                let reason = Self::sanitize_reqwest_err(err, token);
                return Self::classify_transient_failure(prior_attempts, &reason);
            }
        };

        let status = resp.status();
        let retry_header = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());

        let body_text = match resp.text().await {
            Ok(t) => t,
            Err(err) => {
                let reason = Self::sanitize_reqwest_err(err, token);
                return Self::classify_transient_failure(prior_attempts, &reason);
            }
        };

        let parsed = serde_json::from_str::<TgEnvelope<TgSentMessage>>(&body_text).ok();

        if status.is_success() {
            if let Some(env) = &parsed {
                if env.ok {
                    if let Some(msg) = &env.result {
                        return TelegramDeliveryOutcome::Sent {
                            message_id: msg.message_id,
                        };
                    }
                }
            }
        }

        let code_u16 = parsed
            .as_ref()
            .and_then(|p| p.error_code)
            .and_then(|c| u16::try_from(c).ok())
            .unwrap_or_else(|| status.as_u16());

        match code_u16 {
            401 | 403 => TelegramDeliveryOutcome::AuthRevoked,
            429 => {
                let retry_after_s = parsed
                    .as_ref()
                    .and_then(|p| p.parameters.as_ref())
                    .and_then(|p| p.retry_after)
                    .or(retry_header)
                    .unwrap_or(5)
                    .max(1);
                TelegramDeliveryOutcome::RateLimited { retry_after_s }
            }
            500..=599 => {
                let desc = parsed
                    .and_then(|p| p.description)
                    .unwrap_or_else(|| format!("HTTP {code_u16}"));
                Self::classify_transient_failure(prior_attempts, &redact_secret(&desc, token))
            }
            _ => {
                let desc = parsed.and_then(|p| p.description).unwrap_or(body_text);
                TelegramDeliveryOutcome::PermanentFailure {
                    status_code: code_u16,
                    description: redact_secret(&desc, token),
                }
            }
        }
    }

    fn classify_transient_failure(prior_attempts: u32, reason: &str) -> TelegramDeliveryOutcome {
        match telegram_retry_backoff_s(prior_attempts) {
            Some(next_delay_s) => TelegramDeliveryOutcome::RetryableNetwork { next_delay_s },
            None => TelegramDeliveryOutcome::Dropped {
                reason: format!("exhausted {MAX_TELEGRAM_NETWORK_RETRIES} retries: {reason}"),
            },
        }
    }

    /// Sends the Vietnamese onboarding welcome message after `/start` (`07-notifications-export.md §2.1`).
    pub async fn send_welcome_message(
        &self,
        token: &str,
        chat_id: i64,
        chat_title: &str,
    ) -> TelegramDeliveryOutcome {
        let html = format!(
            "👋 <b>Đã kết nối DealSonar!</b>\n\nKênh <b>{}</b> đã sẵn sàng nhận thông báo tin mới. Bạn có thể dùng lệnh /status, /pause hoặc /resume bất cứ lúc nào.",
            escape_html(chat_title)
        );
        let req = SendMessageRequest::html(chat_id, html, None);
        self.deliver_outbox_message(token, &req, 0, 0).await
    }

    /// Sends a formatted `/status` reply to a registered chat (`07-notifications-export.md §2.3`).
    pub async fn send_status_reply(
        &self,
        token: &str,
        chat_id: i64,
        summary: &BotStatusSummary,
    ) -> TelegramDeliveryOutcome {
        let notify_state = if summary.notifications_paused {
            "Đang tạm dừng (/resume để bật lại)"
        } else {
            "Đang bật"
        };
        let html = format!(
            "📊 <b>Trạng thái DealSonar</b>\n\n• Radar đang chạy: {}\n• Tin khớp hôm nay: {}\n• Thông báo: {}\n• Sức khoẻ: {}",
            summary.active_radars,
            summary.leads_today,
            notify_state,
            escape_html(&summary.health_summary)
        );
        let req = SendMessageRequest::html(chat_id, html, None);
        self.deliver_outbox_message(token, &req, 0, 0).await
    }

    /// Updates a message's inline keyboard via `editMessageReplyMarkup`.
    pub async fn edit_message_reply_markup(
        &self,
        token: &str,
        chat_id: i64,
        message_id: i64,
        reply_markup: &InlineKeyboardMarkup,
    ) -> Result<(), NotifyError> {
        #[derive(Serialize)]
        struct Body<'a> {
            chat_id: i64,
            message_id: i64,
            reply_markup: &'a InlineKeyboardMarkup,
        }

        let resp = self
            .http
            .post(self.endpoint(token, "editMessageReplyMarkup"))
            .timeout(self.request_timeout)
            .json(&Body {
                chat_id,
                message_id,
                reply_markup,
            })
            .send()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        if let Ok(parsed) = serde_json::from_str::<TgEnvelope<serde_json::Value>>(&text) {
            if parsed.ok {
                return Ok(());
            }
            return Err(NotifyError::TelegramApi {
                error_code: parsed.error_code.unwrap_or(i32::from(status.as_u16())),
                description: redact_secret(&parsed.description.unwrap_or_default(), token),
                retry_after_s: parsed.parameters.and_then(|p| p.retry_after),
            });
        }

        if status.is_success() {
            Ok(())
        } else {
            Err(NotifyError::TelegramApi {
                error_code: i32::from(status.as_u16()),
                description: redact_secret(&text, token),
                retry_after_s: None,
            })
        }
    }

    /// Acknowledges an inline button press via `answerCallbackQuery` so Telegram stops its spinner.
    pub async fn answer_callback_query(
        &self,
        token: &str,
        callback_query_id: &str,
        text: Option<&str>,
    ) -> Result<(), NotifyError> {
        #[derive(Serialize)]
        struct Body<'a> {
            callback_query_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            text: Option<&'a str>,
        }

        let resp = self
            .http
            .post(self.endpoint(token, "answerCallbackQuery"))
            .timeout(self.request_timeout)
            .json(&Body {
                callback_query_id,
                text,
            })
            .send()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        if let Ok(parsed) = serde_json::from_str::<TgEnvelope<serde_json::Value>>(&body) {
            if parsed.ok {
                return Ok(());
            }
            return Err(NotifyError::TelegramApi {
                error_code: parsed.error_code.unwrap_or(i32::from(status.as_u16())),
                description: redact_secret(&parsed.description.unwrap_or_default(), token),
                retry_after_s: parsed.parameters.and_then(|p| p.retry_after),
            });
        }

        if status.is_success() {
            Ok(())
        } else {
            Err(NotifyError::TelegramApi {
                error_code: i32::from(status.as_u16()),
                description: redact_secret(&body, token),
                retry_after_s: None,
            })
        }
    }

    /// Polls `getUpdates` (`timeout = 50` by default) and processes commands and feedback callbacks.
    ///
    /// Security invariant (`07-notifications-export.md §2.3`):
    /// Feedback callbacks and control commands (`/pause`, `/resume`, `/status`) are strictly
    /// rejected unless `chat_id` is in `options.registered_chat_ids`.
    pub async fn poll_updates(
        &self,
        token: &str,
        options: &PollUpdatesOptions,
    ) -> Result<PollUpdatesResult, NotifyError> {
        #[derive(Serialize)]
        struct GetUpdatesReq {
            #[serde(skip_serializing_if = "Option::is_none")]
            offset: Option<i64>,
            timeout: u32,
            allowed_updates: [&'static str; 2],
        }

        let http_timeout = Duration::from_secs(u64::from(options.timeout_s).saturating_add(15))
            .max(self.request_timeout);

        let resp = self
            .http
            .post(self.endpoint(token, "getUpdates"))
            .timeout(http_timeout)
            .json(&GetUpdatesReq {
                offset: options.offset,
                timeout: options.timeout_s,
                allowed_updates: ["message", "callback_query"],
            })
            .send()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| NotifyError::TelegramHttp(Self::sanitize_reqwest_err(e, token)))?;

        let parsed: TgEnvelope<Vec<TgUpdate>> =
            serde_json::from_str(&body).map_err(|_| NotifyError::TelegramApi {
                error_code: i32::from(status.as_u16()),
                description: redact_secret(&body, token),
                retry_after_s: None,
            })?;

        if !parsed.ok {
            return Err(NotifyError::TelegramApi {
                error_code: parsed.error_code.unwrap_or(i32::from(status.as_u16())),
                description: redact_secret(&parsed.description.unwrap_or_default(), token),
                retry_after_s: parsed.parameters.and_then(|p| p.retry_after),
            });
        }

        let updates = parsed.result.unwrap_or_default();
        let mut next_offset = options.offset;
        let mut events = Vec::new();
        let mut rejected_unregistered_count = 0usize;

        for upd in updates {
            let candidate_next = upd.update_id.saturating_add(1);
            next_offset = Some(next_offset.map_or(candidate_next, |cur| cur.max(candidate_next)));

            if let Some(msg) = upd.message {
                if let Some(text) = msg.text.as_deref() {
                    if let Some((cmd, target_bot)) = parse_bot_command(text) {
                        if !bot_mention_matches(target_bot, options.bot_username.as_deref()) {
                            continue;
                        }
                        let chat_id = msg.chat.id;
                        match cmd {
                            "/start" => {
                                let is_group =
                                    matches!(msg.chat.kind.as_str(), "group" | "supergroup")
                                        || chat_id < 0;
                                let chat_title = extract_chat_title(&msg.chat);
                                events.push(TelegramIncomingEvent::StartCommand {
                                    chat_id,
                                    chat_title,
                                    is_group,
                                });
                            }
                            "/pause" => {
                                if options.registered_chat_ids.contains(&chat_id) {
                                    events.push(TelegramIncomingEvent::PauseCommand { chat_id });
                                } else {
                                    rejected_unregistered_count += 1;
                                }
                            }
                            "/resume" => {
                                if options.registered_chat_ids.contains(&chat_id) {
                                    events.push(TelegramIncomingEvent::ResumeCommand { chat_id });
                                } else {
                                    rejected_unregistered_count += 1;
                                }
                            }
                            "/status" => {
                                if options.registered_chat_ids.contains(&chat_id) {
                                    events.push(TelegramIncomingEvent::StatusCommand { chat_id });
                                } else {
                                    rejected_unregistered_count += 1;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            if let Some(cb) = upd.callback_query {
                let Some(msg) = cb.message else {
                    rejected_unregistered_count += 1;
                    continue;
                };
                let chat_id = msg.chat.id;
                if !options.registered_chat_ids.contains(&chat_id) {
                    rejected_unregistered_count += 1;
                    continue;
                }

                let Some(raw_data) = cb.data.as_deref() else {
                    continue;
                };
                if raw_data == "noop" {
                    let _ = self.answer_callback_query(token, &cb.id, None).await;
                    continue;
                }

                let existing_url_btn = extract_existing_url_button(msg.reply_markup.as_ref());

                if let Some((lead_id, action)) = parse_feedback_callback_data(raw_data) {
                    match action {
                        "correct" => {
                            if let Ok(kb) =
                                build_acknowledged_keyboard("✅ Đã ghi nhận", existing_url_btn)
                            {
                                let _ = self
                                    .edit_message_reply_markup(token, chat_id, msg.message_id, &kb)
                                    .await;
                            }
                            let _ = self
                                .answer_callback_query(token, &cb.id, Some("✅ Đã ghi nhận"))
                                .await;
                            events.push(TelegramIncomingEvent::LeadFeedback {
                                chat_id,
                                lead_id: lead_id.to_string(),
                                label: "correct".to_string(),
                            });
                        }
                        "wrong" => {
                            if let Ok(kb) = build_wrong_reasons_keyboard(lead_id, existing_url_btn)
                            {
                                let _ = self
                                    .edit_message_reply_markup(token, chat_id, msg.message_id, &kb)
                                    .await;
                            }
                            let _ = self
                                .answer_callback_query(
                                    token,
                                    &cb.id,
                                    Some("Chọn lý do tin chưa đúng"),
                                )
                                .await;
                        }
                        "irrelevant" | "peer" | "duplicate" | "spam" => {
                            if let Ok(kb) =
                                build_acknowledged_keyboard("📝 Đã ghi nhận", existing_url_btn)
                            {
                                let _ = self
                                    .edit_message_reply_markup(token, chat_id, msg.message_id, &kb)
                                    .await;
                            }
                            let _ = self
                                .answer_callback_query(token, &cb.id, Some("📝 Đã ghi nhận"))
                                .await;
                            events.push(TelegramIncomingEvent::LeadFeedback {
                                chat_id,
                                lead_id: lead_id.to_string(),
                                label: action.to_string(),
                            });
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(PollUpdatesResult {
            events,
            next_offset,
            rejected_unregistered_count,
        })
    }
}

fn parse_bot_command(text: &str) -> Option<(&str, Option<&str>)> {
    let first_token = text.split_whitespace().next()?;
    if !first_token.starts_with('/') {
        return None;
    }
    if let Some((cmd, mention)) = first_token.split_once('@') {
        if cmd.len() > 1 && !mention.is_empty() {
            Some((cmd, Some(mention)))
        } else {
            None
        }
    } else if first_token.len() > 1 {
        Some((first_token, None))
    } else {
        None
    }
}

fn bot_mention_matches(mentioned: Option<&str>, expected_bot_username: Option<&str>) -> bool {
    let Some(m) = mentioned else {
        return true;
    };
    let Some(expected) = expected_bot_username
        .map(|s| s.trim().trim_start_matches('@'))
        .filter(|s| !s.is_empty())
    else {
        return true;
    };
    m.eq_ignore_ascii_case(expected)
}

fn extract_chat_title(chat: &TgChat) -> String {
    if let Some(title) = chat
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return title.to_string();
    }
    let first = chat
        .first_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let last = chat
        .last_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (first, last) {
        (Some(f), Some(l)) => format!("{f} {l}"),
        (Some(f), None) => f.to_string(),
        (None, Some(l)) => l.to_string(),
        (None, None) => chat
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| chat.id.to_string()),
    }
}

fn extract_existing_url_button(
    markup: Option<&InlineKeyboardMarkup>,
) -> Option<InlineKeyboardButton> {
    let markup = markup?;
    for row in &markup.inline_keyboard {
        for btn in row {
            if let Some(url) = btn.url.as_deref() {
                if validate_https_permalink(url).is_ok() {
                    return Some(btn.clone());
                }
            }
        }
    }
    None
}
