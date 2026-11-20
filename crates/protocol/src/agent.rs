//! Local request format shared by the MCP adapter and the desktop core.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FRAME_PREFIX: &[u8] = b"DealSonarAgent/1\n";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const TOKEN_FILE: &str = "agent-access";
pub const TOKEN_BYTES: usize = 32;

#[derive(Serialize, Deserialize)]
pub struct AgentRequest {
    pub token: [u8; TOKEN_BYTES],
    pub method: AgentMethod,
    pub arguments: Value,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMethod {
    ListRadarSources,
    PrepareRadar,
    CheckRadarPreview,
    RetryRadarPreview,
}

#[derive(Serialize, Deserialize)]
pub enum AgentResponse {
    Ok(Value),
    Error(String),
}
