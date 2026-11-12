//! Unified error type for `dealsonar-core`.
//!
//! All error messages are safe to surface to the desktop UI and logs without leaking
//! OS keyring secrets, Telegram bot tokens, webhook secrets, or raw post contents.

use std::io;

use thiserror::Error;

/// Result alias for `dealsonar-core` operations.
pub type CoreResult<T> = Result<T, CoreError>;

/// Categorized domain, storage, IPC, AI, notification, and licensing errors.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("lỗi cơ sở dữ liệu: {0}")]
    Store(#[from] dealsonar_store::StoreError),

    #[error("lỗi đóng gói giao thức IPC: {0}")]
    ProtocolFrame(#[from] dealsonar_protocol::FrameError),

    #[error("lỗi phân tích thông điệp IPC: {0}")]
    ProtocolParse(#[from] dealsonar_protocol::EnvelopeParseError),

    #[error("lỗi cấu hình Chrome Native Host: {0}")]
    Manifest(#[from] dealsonar_protocol::native_manifest::ManifestError),

    #[error("bộ quy tắc không hợp lệ: {0}")]
    RulesValidation(#[from] dealsonar_rules::RulesetValidationError),

    #[error("lỗi AI Bridge: {0}")]
    Ai(#[from] dealsonar_ai_bridge::AiError),

    #[error("lỗi thông báo / xuất dữ liệu: {0}")]
    Notify(#[from] dealsonar_notify::NotifyError),

    #[error("lỗi khoá bí mật hệ điều hành: {0}")]
    Secret(#[from] dealsonar_notify::SecretError),

    #[error("mã bản quyền không hợp lệ: {0}")]
    LicenseInvalid(String),

    #[error("đã đạt giới hạn gói bản quyền: {0}")]
    LicenseLimitExceeded(String),

    #[error("dữ liệu đầu vào không hợp lệ: {0}")]
    Validation(String),

    #[error("không tìm thấy {entity}: {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("lỗi nội bộ hệ thống: {0}")]
    Internal(String),

    #[error("hệ thống đang tắt")]
    ShuttingDown,

    #[error("lỗi I/O: {0}")]
    Io(#[from] io::Error),

    #[error("lỗi nén gói chẩn đoán: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("lỗi dữ liệu JSON: {0}")]
    Json(#[from] serde_json::Error),
}
