//! Messages exchanged between the Chrome extension and the desktop app.
//!
//! The wire format is JSON. The extension talks to the native host over Chrome
//! Native Messaging (stdio, 4-byte little-endian length prefix); the native host
//! relays the same JSON to the desktop app over local IPC.
//!
//! Keep the TypeScript mirror in `apps/extension/src/protocol.ts` in sync.

use serde::{Deserialize, Serialize};

/// Bump on breaking changes so both sides can detect a mismatch.
pub const PROTOCOL_VERSION: u32 = 1;

/// Extension -> desktop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping { version: u32 },
}

/// Desktop -> extension.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong { version: u32 },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let req = Request::Ping {
            version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(json, r#"{"type":"ping","version":1}"#);
        assert_eq!(serde_json::from_str::<Request>(&json).unwrap(), req);
    }
}
