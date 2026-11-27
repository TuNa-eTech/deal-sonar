//! [`CommandError`]: the error type returned across the Tauri IPC boundary.

use dealsonar_core::CoreError;
use serde::{Serialize, Serializer};

/// Serializable command error returned across the Tauri IPC boundary.
/// Serializes on the wire as a human-readable string so `String(err)` in the React UI
/// displays clean Vietnamese messages rather than `[object Object]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.message)
    }
}

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        let code = match &err {
            CoreError::NotFound { .. } => "not_found",
            CoreError::Validation(_) | CoreError::RulesValidation(_) => "validation_error",
            CoreError::LicenseInvalid(_) => "license_invalid",
            CoreError::LicenseLimitExceeded(_) => "license_limit_exceeded",
            CoreError::ShuttingDown => "shutting_down",
            CoreError::Ai(_) => "ai_error",
            CoreError::Notify(_) => "notify_error",
            CoreError::Secret(_) => "secret_error",
            CoreError::Manifest(_) => "manifest_error",
            CoreError::Store(_) => "store_error",
            CoreError::ProtocolFrame(_) | CoreError::ProtocolParse(_) => "protocol_error",
            CoreError::Io(_) | CoreError::Zip(_) | CoreError::Json(_) | CoreError::Internal(_) => {
                "internal_error"
            }
        };
        Self::new(code, err.to_string())
    }
}
