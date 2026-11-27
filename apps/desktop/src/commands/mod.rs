//! Complete Tauri v2 IPC command handlers (`03-desktop.md §4`, `apps/desktop/ui/src/lib/api.ts`).
//!
//! Exposes all 54 domain commands consumed by the React UI plus `open_external_url`, along with
//! [`invoke_command_json`] so integration/contract tests exercise the exact JSON argument
//! deserialization and return payload shapes used by `api.ts`.

mod contacts;
mod dispatch;
mod error;
mod leads;
mod posts;
mod radars;
mod rulesets;
mod settings;
mod sources;
mod system;
mod templates;

pub use contacts::*;
pub use dispatch::*;
pub use error::*;
pub use leads::*;
pub use posts::*;
pub use radars::*;
pub use rulesets::*;
pub use settings::*;
pub use sources::*;
pub use system::*;
pub use templates::*;
