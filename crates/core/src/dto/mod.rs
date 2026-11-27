//! Typed Tauri IPC DTOs, command inputs/outputs, real-time push events, and cross-crate
//! type converters matching `apps/desktop/ui/src/types/ipc.ts` & `apps/desktop/ui/src/lib/api.ts`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod commands;
mod convert;
mod events;
mod leads;
mod radar;
mod ruleset_convert;
mod system;

pub use commands::*;
pub use convert::*;
pub use events::*;
pub use leads::*;
pub use radar::*;
pub use ruleset_convert::*;
pub use system::*;
