//! Protocol v2 message types, framing, local IPC transport, and Native Messaging
//! manifest helpers shared by `dealsonar-native-host` and the desktop core.
//!
//! Wire format (`docs/specs/01-protocol.md`):
//! - Framing: 4-byte little-endian `u32` byte length followed by UTF-8 JSON.
//! - Envelope:
//!   `{"v": 2, "id": "<ULID>", "ts": <i64 unix ms>, "reply_to": null | "<id>", "type": "<dot.name>", "payload": { ... }}`

pub mod framing;
pub mod ipc;
pub mod native_manifest;
pub mod parser;

use std::fmt;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

pub use framing::{
    read_envelope_sync, read_frame_async, read_frame_sync, write_envelope_async,
    write_envelope_sync, write_frame_async, write_frame_sync, FrameError, MAX_EXT_TO_HOST_BYTES,
    MAX_HOST_TO_EXT_BYTES,
};
pub use parser::{
    extract_envelope_id, is_known_message_type, parse_envelope, parse_envelope_str,
    parse_raw_envelope, EnvelopeParseError, RawEnvelope, KNOWN_MESSAGE_TYPES,
};

/// Current wire protocol version (`docs/specs/01-protocol.md`).
pub const PROTOCOL_VERSION: u32 = 2;

/// Registered Chrome Native Messaging host identifier.
pub const NATIVE_HOST_NAME: &str = "com.dealsonar.host";

/// Canonical platform identifier for Facebook sources and posts.
pub const PLATFORM_FACEBOOK: &str = "facebook";

/// Canonical source kind identifier for Facebook groups.
pub const SOURCE_KIND_GROUP: &str = "group";

/// Generate a fresh ULID string for message/entity IDs.
pub fn new_ulid() -> String {
    Ulid::new().to_string()
}

/// Current wall-clock timestamp in Unix milliseconds.
pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn empty_json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// Wire envelope wrapping every Extension <-> Desktop message (`01-protocol.md §2`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope {
    pub v: u32,
    pub id: String,
    pub ts: i64,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(flatten)]
    pub body: Body,
}

impl Envelope {
    /// Construct a new `v = 2` envelope with a fresh ULID `id`, current Unix ms `ts`,
    /// and `reply_to = None`.
    pub fn new(body: Body) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: new_ulid(),
            ts: now_unix_ms(),
            reply_to: None,
            body,
        }
    }

    /// Construct a new `v = 2` reply envelope referencing `reply_to`.
    pub fn reply(reply_to: impl Into<String>, body: Body) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: new_ulid(),
            ts: now_unix_ms(),
            reply_to: Some(reply_to.into()),
            body,
        }
    }

    /// Construct a new `v = 2` envelope with an optional `reply_to` ID.
    pub fn with_reply_to(reply_to: Option<String>, body: Body) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: new_ulid(),
            ts: now_unix_ms(),
            reply_to,
            body,
        }
    }

    /// Construct a standard protocol `error` envelope.
    pub fn error(
        reply_to: Option<String>,
        code: ErrorCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::with_reply_to(
            reply_to,
            Body::Error {
                code,
                message: message.into(),
                retryable,
            },
        )
    }

    /// Construct a retryable `desktop_unavailable` error envelope (used by `native-host`
    /// when local IPC to the desktop app is disconnected).
    pub fn desktop_unavailable(reply_to: Option<String>, message: impl Into<String>) -> Self {
        Self::error(reply_to, ErrorCode::DesktopUnavailable, message, true)
    }

    /// Wire `type` name of the enclosed message body (e.g. `"posts.push"`).
    pub fn message_type(&self) -> &'static str {
        self.body.message_type()
    }
}

/// Tagged message body (`type` + `payload`) for all v2 protocol messages (`01-protocol.md §4`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum Body {
    // ── Extension -> Desktop (§4.1) ─────────────────────────────────────────
    #[serde(rename = "hello")]
    Hello {
        profile_id: String,
        ext_version: String,
        browser: String,
        config_rev: u64,
    },

    #[serde(rename = "posts.push")]
    PostsPush {
        run_id: String,
        source_ref: SourceRef,
        posts: Vec<RawPost>,
    },

    #[serde(rename = "crawl.report")]
    CrawlReport {
        run_id: String,
        source_ref: SourceRef,
        reason: CrawlReason,
        status: CrawlStatus,
        started_at: i64,
        ended_at: i64,
        posts_seen: u32,
        posts_new: u32,
        page_loads: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        strategy: Option<ExtractionStrategy>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dropped_posts: Option<u32>,
    },

    #[serde(rename = "sources.discovered")]
    SourcesDiscovered {
        sources: Vec<SourceInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        follow: Option<bool>,
    },

    #[serde(rename = "session.status")]
    SessionStatus {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<CrawlRuntimeStatus>,
        platform: String,
        state: SessionState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },

    #[serde(rename = "ping")]
    Ping {},

    // ── Desktop -> Extension (§4.2) ─────────────────────────────────────────
    #[serde(rename = "hello.ok")]
    HelloOk {
        desktop_version: String,
        config_rev: u64,
    },

    #[serde(rename = "config.update")]
    ConfigUpdate {
        rev: u64,
        plan: CrawlPlan,
        policy: CrawlPolicy,
        extractor: ExtractorProfile,
    },

    #[serde(rename = "crawl.request")]
    CrawlRequest {
        request_id: String,
        source_ref: SourceRef,
        reason: CrawlReason,
        max_posts: u32,
    },

    #[serde(rename = "crawl.pause")]
    CrawlPause {
        #[serde(default)]
        until: Option<i64>,
        reason: String,
    },

    #[serde(rename = "crawl.resume")]
    CrawlResume {},

    #[serde(rename = "ack")]
    Ack { accepted: u32, duplicates: u32 },

    #[serde(rename = "pong")]
    Pong {},

    #[serde(rename = "error")]
    Error {
        code: ErrorCode,
        message: String,
        retryable: bool,
    },
}

impl Body {
    /// Wire `type` string for this variant.
    pub fn message_type(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::PostsPush { .. } => "posts.push",
            Self::CrawlReport { .. } => "crawl.report",
            Self::SourcesDiscovered { .. } => "sources.discovered",
            Self::SessionStatus { .. } => "session.status",
            Self::Ping {} => "ping",
            Self::HelloOk { .. } => "hello.ok",
            Self::ConfigUpdate { .. } => "config.update",
            Self::CrawlRequest { .. } => "crawl.request",
            Self::CrawlPause { .. } => "crawl.pause",
            Self::CrawlResume {} => "crawl.resume",
            Self::Ack { .. } => "ack",
            Self::Pong {} => "pong",
            Self::Error { .. } => "error",
        }
    }

    /// Returns `true` if this message originates from the Chrome extension (`§4.1`).
    pub fn is_extension_to_desktop(&self) -> bool {
        matches!(
            self,
            Self::Hello { .. }
                | Self::PostsPush { .. }
                | Self::CrawlReport { .. }
                | Self::SourcesDiscovered { .. }
                | Self::SessionStatus { .. }
                | Self::Ping {}
        )
    }

    /// Returns `true` if this message originates from the desktop app or native host (`§4.2`).
    pub fn is_desktop_to_extension(&self) -> bool {
        !self.is_extension_to_desktop()
    }
}

/// Protocol error codes (`01-protocol.md §4.2`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolMismatch,
    UnknownType,
    InvalidPayload,
    DesktopUnavailable,
    Busy,
    Internal,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::UnknownType => "unknown_type",
            Self::InvalidPayload => "invalid_payload",
            Self::DesktopUnavailable => "desktop_unavailable",
            Self::Busy => "busy",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Immutable source identifier (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SourceRef {
    pub platform: String,
    pub kind: String,
    pub external_id: String,
}

impl SourceRef {
    /// Construct a Facebook group `SourceRef`.
    pub fn facebook_group(external_id: impl Into<String>) -> Self {
        Self {
            platform: PLATFORM_FACEBOOK.to_owned(),
            kind: SOURCE_KIND_GROUP.to_owned(),
            external_id: external_id.into(),
        }
    }
}

/// Group visibility setting (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SourcePrivacy {
    Public,
    Private,
}

impl SourcePrivacy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
        }
    }
}

impl fmt::Display for SourcePrivacy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SourcePrivacy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "public" => Ok(Self::Public),
            "private" => Ok(Self::Private),
            other => Err(format!("unknown source privacy '{other}'")),
        }
    }
}

/// Discovered source metadata (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceInfo {
    pub platform: String,
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<SourcePrivacy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u64>,
}

impl SourceInfo {
    /// Extract the `SourceRef` identity of this source.
    pub fn source_ref(&self) -> SourceRef {
        SourceRef {
            platform: self.platform.clone(),
            kind: self.kind.clone(),
            external_id: self.external_id.clone(),
        }
    }
}

/// Raw post extracted by the extension (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RawPost {
    pub platform: String,
    pub post_id: String,
    pub source_external_id: String,
    pub permalink: String,
    pub author: AuthorInfo,
    pub text: String,
    pub text_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    pub captured_at: i64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<PostCounts>,
    pub extraction: ExtractionInfo,
}

/// Post author metadata (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    pub name: String,
    pub is_anonymous: bool,
}

/// Post attachment metadata (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attachment {
    pub kind: AttachmentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// Attachment media type (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Photo,
    Video,
    Link,
    Other,
}

impl AttachmentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Photo => "photo",
            Self::Video => "video",
            Self::Link => "link",
            Self::Other => "other",
        }
    }
}

impl fmt::Display for AttachmentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Engagement counters captured alongside a post (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PostCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactions: Option<u64>,
}

/// Provenance of how a post was extracted (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractionInfo {
    pub strategy: ExtractionStrategy,
    pub profile_rev: u64,
}

/// Feed extraction strategy (`01-protocol.md §4.3`, `02-extension.md §4`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionStrategy {
    Network,
    Embedded,
    Dom,
}

impl ExtractionStrategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Embedded => "embedded",
            Self::Dom => "dom",
        }
    }
}

impl fmt::Display for ExtractionStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ExtractionStrategy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "network" => Ok(Self::Network),
            "embedded" => Ok(Self::Embedded),
            "dom" => Ok(Self::Dom),
            other => Err(format!("unknown extraction strategy '{other}'")),
        }
    }
}

/// Platform session health reported by the extension (`01-protocol.md §4.1`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Ok,
    LoggedOut,
    Checkpoint,
    RateLimited,
    Unknown,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::LoggedOut => "logged_out",
            Self::Checkpoint => "checkpoint",
            Self::RateLimited => "rate_limited",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SessionState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ok" => Ok(Self::Ok),
            "logged_out" => Ok(Self::LoggedOut),
            "checkpoint" => Ok(Self::Checkpoint),
            "rate_limited" => Ok(Self::RateLimited),
            "unknown" => Ok(Self::Unknown),
            other => Err(format!("unknown session state '{other}'")),
        }
    }
}

/// Outcome of a single source crawl visit (`01-protocol.md §4.1`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CrawlStatus {
    Ok,
    Empty,
    Blocked,
    Error,
}

impl CrawlStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Empty => "empty",
            Self::Blocked => "blocked",
            Self::Error => "error",
        }
    }
}

impl fmt::Display for CrawlStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CrawlStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ok" => Ok(Self::Ok),
            "empty" => Ok(Self::Empty),
            "blocked" => Ok(Self::Blocked),
            "error" => Ok(Self::Error),
            other => Err(format!("unknown crawl status '{other}'")),
        }
    }
}

/// Trigger reason for a crawl visit (`01-protocol.md §4.1–4.2`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CrawlReason {
    Scheduled,
    Manual,
    Preview,
    Passive,
}

impl CrawlReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
            Self::Preview => "preview",
            Self::Passive => "passive",
        }
    }
}

impl fmt::Display for CrawlReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CrawlReason {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "scheduled" => Ok(Self::Scheduled),
            "manual" => Ok(Self::Manual),
            "preview" => Ok(Self::Preview),
            "passive" => Ok(Self::Passive),
            other => Err(format!("unknown crawl reason '{other}'")),
        }
    }
}

/// Crawl schedule computed by desktop (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrawlPlan {
    pub entries: Vec<CrawlPlanEntry>,
}

/// Per-source crawl schedule entry (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrawlPlanEntry {
    pub source_ref: SourceRef,
    pub interval_s: u32,
    pub priority: u32,
    pub max_posts_per_visit: u32,
}

/// Global crawl frequency and safety policy (`01-protocol.md §4.3`, `02-extension.md §6.1`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CrawlPolicy {
    pub max_loads_per_hour: u32,
    pub max_loads_per_day: u32,
    pub active_hours: ActiveHours,
    pub jitter: f64,
    pub max_scroll_steps: u32,
    pub only_when_idle: bool,
}

impl Default for CrawlPolicy {
    fn default() -> Self {
        Self {
            max_loads_per_hour: 60,
            max_loads_per_day: 600,
            active_hours: ActiveHours::default(),
            jitter: 0.3,
            max_scroll_steps: 3,
            only_when_idle: false,
        }
    }
}

/// Daily local-time active window (`"HH:MM"`..`"HH:MM"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveHours {
    pub from: String,
    pub to: String,
}

impl Default for ActiveHours {
    fn default() -> Self {
        Self {
            from: "07:00".to_owned(),
            to: "23:00".to_owned(),
        }
    }
}

/// Declarative data-only extractor configuration (`01-protocol.md §4.3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractorProfile {
    pub rev: u64,
    pub strategies: Vec<ExtractionStrategy>,
    #[serde(default = "empty_json_object")]
    pub network: serde_json::Value,
    #[serde(default = "empty_json_object")]
    pub dom: serde_json::Value,
    #[serde(default = "empty_json_object")]
    pub session_markers: serde_json::Value,
}

impl Default for ExtractorProfile {
    fn default() -> Self {
        Self {
            rev: 1,
            strategies: vec![
                ExtractionStrategy::Network,
                ExtractionStrategy::Embedded,
                ExtractionStrategy::Dom,
            ],
            network: empty_json_object(),
            dom: empty_json_object(),
            session_markers: empty_json_object(),
        }
    }
}

/// Optional extension capability; old extensions leave operation status unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlRuntimeStatus {
    pub automatic_scanning: bool,
    pub paused: bool,
    pub next_crawl_at: Option<i64>,
    pub last_crawl_at: Option<i64>,
}
