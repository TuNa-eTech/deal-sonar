//! Radar template commands (`template_*`).

use dealsonar_core::dto::RadarTemplate;
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn template_list(
    state: State<'_, DesktopState>,
) -> Result<Vec<RadarTemplate>, CommandError> {
    Ok(state.core().template_list()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn template_get(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<RadarTemplate, CommandError> {
    Ok(state.core().template_get(&id)?)
}
