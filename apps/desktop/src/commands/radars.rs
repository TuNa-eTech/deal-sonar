//! Radar commands (`radar_*`).

use dealsonar_core::dto::{
    CreateRadarDraftInput, FunnelStats, PreviewRunState, PreviewStartInput, Radar, RadarDetail,
    RadarStatus, RadarUpdateResult, SuggestFieldsInput, SuggestFieldsResult, UpdateRadarInput,
};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_list(state: State<'_, DesktopState>) -> Result<Vec<Radar>, CommandError> {
    Ok(state.core().radar_list()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_get(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<RadarDetail, CommandError> {
    Ok(state.core().radar_get(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_create_draft(
    state: State<'_, DesktopState>,
    input: CreateRadarDraftInput,
) -> Result<RadarDetail, CommandError> {
    Ok(state.core().radar_create_draft(input)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_update(
    state: State<'_, DesktopState>,
    input: UpdateRadarInput,
) -> Result<RadarUpdateResult, CommandError> {
    Ok(state.core().radar_update(input)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_suggest_fields(
    state: State<'_, DesktopState>,
    input: SuggestFieldsInput,
) -> Result<SuggestFieldsResult, CommandError> {
    Ok(state.core().radar_suggest_fields(input).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_set_status(
    state: State<'_, DesktopState>,
    id: String,
    status: RadarStatus,
) -> Result<Radar, CommandError> {
    Ok(state.core().radar_set_status(&id, status).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_preview_start(
    state: State<'_, DesktopState>,
    input: PreviewStartInput,
) -> Result<PreviewRunState, CommandError> {
    Ok(state.core().radar_preview_start(input).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_preview_cancel(
    state: State<'_, DesktopState>,
    radar_id: String,
    preview_id: String,
) -> Result<PreviewRunState, CommandError> {
    Ok(state
        .core()
        .radar_preview_cancel(&radar_id, &preview_id)
        .await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_preview_get(
    state: State<'_, DesktopState>,
    radar_id: String,
    preview_id: Option<String>,
) -> Result<PreviewRunState, CommandError> {
    Ok(state
        .core()
        .radar_preview_get(&radar_id, preview_id.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_stats(
    state: State<'_, DesktopState>,
    radar_id: Option<String>,
    days: Option<u32>,
) -> Result<FunnelStats, CommandError> {
    Ok(state
        .core()
        .radar_stats(radar_id.as_deref(), days.unwrap_or(7))?)
}
