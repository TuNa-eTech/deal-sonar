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
pub mod scheduler;
pub mod service;
pub mod state;
pub mod templates;
pub mod workers;

pub use dto::CoreEvent;
pub use error::{CoreError, CoreResult};
pub use license::{LicensePayload, LicenseSigner, LicenseVerifier};
pub use service::{CoreService, CoreServiceBuilder};
pub use state::{CoreConfig, OsNotification, OsNotificationHook};
