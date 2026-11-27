//! Radar commands (`radar_*`).

use dealsonar_core::dto::{
    CreateRadarDraftInput, CreateRadarVariantInput, FunnelStats, PreviewRunState,
    PreviewStartInput, Radar, RadarCompareInput, RadarComparison, RadarComparisonSummary,
    RadarDetail, RadarStatus, RadarUpdateResult, RadarVariantDraft,
    SuggestFieldsInput, SuggestFieldsResult, UpdateRadarInput,
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
pub async fn radar_variant_prepare(
    state: State<'_, DesktopState>,
    source_radar_id: String,
) -> Result<RadarVariantDraft, CommandError> {
    Ok(state.core().radar_variant_prepare(&source_radar_id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_create_variant(
    state: State<'_, DesktopState>,
    input: CreateRadarVariantInput,
) -> Result<RadarDetail, CommandError> {
    Ok(state.core().radar_create_variant(input)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_compare_run(
    state: State<'_, DesktopState>,
    input: RadarCompareInput,
) -> Result<RadarComparison, CommandError> {
    Ok(state.core().radar_compare_run(input).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_compare_get(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<RadarComparison, CommandError> {
    Ok(state.core().radar_compare_get(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn radar_compare_list(
    state: State<'_, DesktopState>,
) -> Result<Vec<RadarComparisonSummary>, CommandError> {
    Ok(state.core().radar_compare_list()?)
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
    preview_id: Option<String>,
) -> Result<Radar, CommandError> {
    Ok(state.core().radar_set_status_from_desktop(&id, status, preview_id.as_deref()).await?)
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
