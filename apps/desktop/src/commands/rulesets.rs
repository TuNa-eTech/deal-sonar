//! Ruleset commands (`ruleset_*`).

use dealsonar_core::dto::{Ruleset, RulesetBody, RulesetCompileResult};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn ruleset_list(
    state: State<'_, DesktopState>,
    radar_id: String,
    radar_version_id: Option<String>,
) -> Result<Vec<Ruleset>, CommandError> {
    Ok(state
        .core()
        .ruleset_list(&radar_id, radar_version_id.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ruleset_save_user(
    state: State<'_, DesktopState>,
    radar_id: String,
    radar_version_id: String,
    body: RulesetBody,
) -> Result<Ruleset, CommandError> {
    Ok(state
        .core()
        .ruleset_save_user(&radar_id, &radar_version_id, body)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ruleset_compile_now(
    state: State<'_, DesktopState>,
    radar_id: String,
) -> Result<RulesetCompileResult, CommandError> {
    Ok(state.core().ruleset_compile_now(&radar_id).await?)
}
