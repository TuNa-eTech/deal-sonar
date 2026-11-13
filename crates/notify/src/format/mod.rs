use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::types::{ExtractedField, FieldDef, FieldType, NotifyError};

mod digest;
mod keyboard;
mod lead_alert;
mod policy;
mod values;

pub use digest::*;
pub use keyboard::*;
pub use lead_alert::*;
pub use policy::*;
pub use values::*;

/// Telegram `sendMessage` maximum message length in characters / UTF-16 code units.
pub const MAX_TELEGRAM_HTML_LEN: usize = 4096;

/// Telegram `callback_data` strict upper bound (`< 64` bytes per `07-notifications-export.md §2.3`).
pub const MAX_CALLBACK_DATA_BYTES: usize = 64;

/// Radar hourly lead flood threshold triggering automatic digest mode (`07-notifications-export.md §3`).
pub const FLOOD_LEADS_PER_HOUR_THRESHOLD: usize = 30;
