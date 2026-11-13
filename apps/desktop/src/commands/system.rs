//! Health, diagnostics, data lifecycle, and the safe external URL opener.

use dealsonar_core::dto::{
    AiUsageStats, CrawlRun, DataBackupResult, DataDeleteAllResult, DataPurgeResult,
    DiagnosticBundleResult, HealthStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::CommandError;
use crate::security::{open_in_default_browser, validate_safe_external_url};
use crate::state::DesktopState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenExternalUrlResult {
    pub opened: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn health_get(state: State<'_, DesktopState>) -> Result<HealthStatus, CommandError> {
    Ok(state.core().health_get()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn crawl_run_list(
    state: State<'_, DesktopState>,
    source_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<CrawlRun>, CommandError> {
    Ok(state
        .core()
        .crawl_run_list(source_id.as_deref(), limit.unwrap_or(50))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_usage_get(
    state: State<'_, DesktopState>,
    days: Option<u32>,
) -> Result<AiUsageStats, CommandError> {
    Ok(state.core().ai_usage_get(days.unwrap_or(7))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn diagnostic_bundle_create(
    state: State<'_, DesktopState>,
) -> Result<DiagnosticBundleResult, CommandError> {
    Ok(state.core().diagnostic_bundle_create()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn data_backup(state: State<'_, DesktopState>) -> Result<DataBackupResult, CommandError> {
    Ok(state.core().data_backup()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn workspace_action(
    state: State<'_, DesktopState>,
    action: String,
    input: Value,
) -> Result<Value, CommandError> {
    Ok(state.core().workspace_action(&action, input)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn data_purge(
    state: State<'_, DesktopState>,
    unmatched_retention_days: Option<u32>,
) -> Result<DataPurgeResult, CommandError> {
    Ok(state.core().data_purge(unmatched_retention_days)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn data_delete_all(
    state: State<'_, DesktopState>,
    confirm_phrase: String,
) -> Result<DataDeleteAllResult, CommandError> {
    Ok(state.core().data_delete_all(&confirm_phrase)?)
}

pub fn exec_open_external_url(url: &str) -> Result<OpenExternalUrlResult, CommandError> {
    let safe_url = validate_safe_external_url(url)
        .map_err(|msg| CommandError::new("blocked_external_url", msg))?;
    open_in_default_browser(&safe_url)
        .map_err(|e| CommandError::new("browser_open_failed", e.to_string()))?;
    Ok(OpenExternalUrlResult { opened: true })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn open_external_url(url: String) -> Result<OpenExternalUrlResult, CommandError> {
    exec_open_external_url(&url)
}
