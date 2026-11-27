//! Graceful v2 envelope parser (`01-protocol.md §2–3`).
//!
//! Distinguishes `protocol_mismatch` (`v != 2`), `unknown_type`, and `invalid_payload`
//! while retaining the incoming `id` (when valid) so the receiver can reply with
//! `reply_to: Some(id)`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::{Body, Envelope, ErrorCode, PROTOCOL_VERSION};

/// All known v2 wire message `type` identifiers (`01-protocol.md §4.1–4.2`).
pub const KNOWN_MESSAGE_TYPES: &[&str] = &[
    // Extension -> Desktop
    "hello",
    "posts.push",
    "crawl.report",
    "sources.discovered",
    "session.status",
    "ping",
    // Desktop -> Extension
    "hello.ok",
    "config.update",
    "crawl.request",
    "crawl.pause",
    "crawl.resume",
    "ack",
    "pong",
    "error",
];

/// Returns `true` if `msg_type` is one of the 14 v2 message types.
pub fn is_known_message_type(msg_type: &str) -> bool {
    KNOWN_MESSAGE_TYPES.contains(&msg_type)
}

/// Untyped v2 envelope header + raw JSON `payload` for two-stage validation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RawEnvelope {
    pub v: u32,
    pub id: String,
    pub ts: i64,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub payload: Value,
}

impl RawEnvelope {
    /// Convert a validated `RawEnvelope` into a strongly typed `Envelope`,
    /// ignoring unknown fields inside `payload` per `01-protocol.md §3`.
    pub fn into_envelope(self) -> Result<Envelope, EnvelopeParseError> {
        if self.v != PROTOCOL_VERSION {
            return Err(EnvelopeParseError {
                id: Some(self.id),
                code: ErrorCode::ProtocolMismatch,
                message: format!(
                    "unsupported protocol version {}, expected {}",
                    self.v, PROTOCOL_VERSION
                ),
            });
        }

        if !is_known_message_type(&self.msg_type) {
            let msg_type = self.msg_type;
            return Err(EnvelopeParseError {
                id: Some(self.id),
                code: ErrorCode::UnknownType,
                message: format!("unknown message type '{msg_type}'"),
            });
        }

        if !self.payload.is_object() {
            return Err(EnvelopeParseError {
                id: Some(self.id),
                code: ErrorCode::InvalidPayload,
                message: format!(
                    "expected object 'payload' for message type '{}'",
                    self.msg_type
                ),
            });
        }

        let mut tagged = Map::with_capacity(2);
        tagged.insert("type".to_owned(), Value::String(self.msg_type));
        tagged.insert("payload".to_owned(), self.payload);

        let body = serde_json::from_value::<Body>(Value::Object(tagged)).map_err(|err| {
            EnvelopeParseError {
                id: Some(self.id.clone()),
                code: ErrorCode::InvalidPayload,
                message: format!("invalid payload: {err}"),
            }
        })?;

        Ok(Envelope {
            v: self.v,
            id: self.id,
            ts: self.ts,
            reply_to: self.reply_to,
            body,
        })
    }
}

/// Structured envelope parse failure retaining `id` (when present) for `reply_to`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code}: {message}")]
pub struct EnvelopeParseError {
    /// Incoming message `id` if the frame was valid JSON with a non-empty string `"id"`.
    pub id: Option<String>,
    /// Classified protocol `ErrorCode`.
    pub code: ErrorCode,
    /// Human-readable diagnostic description.
    pub message: String,
}

impl EnvelopeParseError {
    /// Convert this parse error directly into a non-retryable v2 `error` response `Envelope`
    /// with `reply_to` set to `self.id`.
    pub fn to_error_envelope(&self) -> Envelope {
        Envelope::error(self.id.clone(), self.code, self.message.clone(), false)
    }
}

#[derive(Deserialize)]
struct MinimalIdExtractor {
    id: Option<Value>,
}

/// Best-effort extraction of top-level string `"id"` from raw JSON bytes without
/// validating protocol version or payload (used by `native-host` when IPC is down).
pub fn extract_envelope_id(bytes: &[u8]) -> Option<String> {
    let parsed: MinimalIdExtractor = serde_json::from_slice(bytes).ok()?;
    match parsed.id {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// Parse UTF-8 JSON bytes into a `RawEnvelope`, checking protocol version first so
/// `v != 2` always yields `ErrorCode::ProtocolMismatch` even if other fields changed.
pub fn parse_raw_envelope(bytes: &[u8]) -> Result<RawEnvelope, EnvelopeParseError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|err| EnvelopeParseError {
        id: None,
        code: ErrorCode::InvalidPayload,
        message: format!("malformed JSON frame: {err}"),
    })?;

    let Value::Object(mut obj) = value else {
        return Err(EnvelopeParseError {
            id: None,
            code: ErrorCode::InvalidPayload,
            message: "envelope must be a JSON object".to_owned(),
        });
    };

    let extracted_id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    // 1. Check protocol version `v` BEFORE requiring v2-specific fields so mismatched
    //    versions (including legacy v1 `{"type":"ping","version":1}`) report `protocol_mismatch`.
    let v = match obj.get("v") {
        Some(Value::Number(num)) => {
            if let Some(ver) = num.as_u64() {
                if ver != u64::from(PROTOCOL_VERSION) {
                    return Err(EnvelopeParseError {
                        id: extracted_id,
                        code: ErrorCode::ProtocolMismatch,
                        message: format!(
                            "unsupported protocol version {ver}, expected {PROTOCOL_VERSION}"
                        ),
                    });
                }
                PROTOCOL_VERSION
            } else if let Some(ver) = num.as_i64() {
                return Err(EnvelopeParseError {
                    id: extracted_id,
                    code: ErrorCode::ProtocolMismatch,
                    message: format!(
                        "unsupported protocol version {ver}, expected {PROTOCOL_VERSION}"
                    ),
                });
            } else {
                return Err(EnvelopeParseError {
                    id: extracted_id,
                    code: ErrorCode::InvalidPayload,
                    message: "field 'v' must be an integer".to_owned(),
                });
            }
        }
        None => {
            if let Some(legacy_ver) = obj.get("version").and_then(Value::as_i64) {
                if legacy_ver != i64::from(PROTOCOL_VERSION) {
                    return Err(EnvelopeParseError {
                        id: extracted_id,
                        code: ErrorCode::ProtocolMismatch,
                        message: format!(
                            "unsupported legacy protocol version {legacy_ver}, expected {PROTOCOL_VERSION}"
                        ),
                    });
                }
            }
            return Err(EnvelopeParseError {
                id: extracted_id,
                code: ErrorCode::InvalidPayload,
                message: "missing integer field 'v'".to_owned(),
            });
        }
        Some(_) => {
            return Err(EnvelopeParseError {
                id: extracted_id,
                code: ErrorCode::InvalidPayload,
                message: "field 'v' must be an integer".to_owned(),
            });
        }
    };

    // 2. Validate `id`.
    let Some(id) = extracted_id else {
        return Err(EnvelopeParseError {
            id: None,
            code: ErrorCode::InvalidPayload,
            message: "missing or invalid non-empty string field 'id'".to_owned(),
        });
    };

    // 3. Validate `ts` (i64 Unix ms).
    let Some(ts) = obj.get("ts").and_then(Value::as_i64) else {
        return Err(EnvelopeParseError {
            id: Some(id),
            code: ErrorCode::InvalidPayload,
            message: "missing or invalid integer field 'ts'".to_owned(),
        });
    };

    // 4. Validate `reply_to` (optional string or null).
    let reply_to = match obj.remove("reply_to") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        Some(Value::String(_)) => {
            return Err(EnvelopeParseError {
                id: Some(id),
                code: ErrorCode::InvalidPayload,
                message: "field 'reply_to' must be null or a non-empty string".to_owned(),
            });
        }
        Some(_) => {
            return Err(EnvelopeParseError {
                id: Some(id),
                code: ErrorCode::InvalidPayload,
                message: "field 'reply_to' must be null or a string".to_owned(),
            });
        }
    };

    // 5. Validate `type`.
    let msg_type = match obj.remove("type") {
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => {
            return Err(EnvelopeParseError {
                id: Some(id),
                code: ErrorCode::InvalidPayload,
                message: "missing or invalid string field 'type'".to_owned(),
            });
        }
    };

    let payload = obj.remove("payload").unwrap_or(Value::Null);

    Ok(RawEnvelope {
        v,
        id,
        ts,
        reply_to,
        msg_type,
        payload,
    })
}

/// Parse UTF-8 JSON bytes into a typed v2 `Envelope` with structured error classification.
pub fn parse_envelope(bytes: &[u8]) -> Result<Envelope, EnvelopeParseError> {
    parse_raw_envelope(bytes)?.into_envelope()
}

/// Parse a JSON `&str` into a typed v2 `Envelope` with structured error classification.
pub fn parse_envelope_str(json: &str) -> Result<Envelope, EnvelopeParseError> {
    parse_envelope(json.as_bytes())
}
