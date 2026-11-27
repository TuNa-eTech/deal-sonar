//! DealSonar central core library (`crates/core`).
//!
//! Provides `CoreService`, the multi-profile local IPC server, Pipeline T0–T7,
//! streaming preview & silent backfill, ruleset compiler/auditor lifecycle,
//! crawl scheduler, background jobs/outbox/Telegram/health workers, offline
//! Ed25519 license verification, embedded templates, and diagnostic bundle builder.

pub mod diagnostics;
pub mod dto;
pub mod error;
pub mod ipc_server;
pub mod license;
pub mod pipeline;
pub mod preview_rules;
pub mod safety;
pub mod scheduler;
pub mod service;
pub mod state;
pub mod templates;
pub mod workers;

/// Release version reported to the extension, diagnostics and the UI: the tag set by the release
/// workflow (`DEALSONAR_VERSION`), or the crate version for development builds.
pub const DESKTOP_VERSION: &str = match option_env!("DEALSONAR_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

pub use dto::CoreEvent;
pub use error::{CoreError, CoreResult};
pub use license::{LicensePayload, LicenseSigner, LicenseVerifier};
pub use service::{
    CoreService, CoreServiceBuilder, DEFAULT_CHROME_EXTENSION_ID, KNOWN_CHROME_EXTENSION_IDS,
};
pub use state::{CoreConfig, OsNotification, OsNotificationHook};
