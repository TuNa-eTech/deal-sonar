use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use regex::RegexBuilder;
use serde_json::{json, Value};

use crate::types::{AiError, FieldDef, FieldType, JudgeExtractOutput, SuggestFieldsOutput};

mod json_extract;
mod semantic;
mod task_schemas;
mod validator;

pub use json_extract::*;
pub use semantic::*;
pub use task_schemas::*;
pub use validator::*;

const REGEX_DFA_SIZE_LIMIT: usize = 1 << 20; // 1 MiB linear-time regex cap
