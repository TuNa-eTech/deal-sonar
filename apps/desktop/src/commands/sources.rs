//! Source commands (`source_*`).

use dealsonar_core::dto::{Source, SourceCrawlNowResult};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn source_list(state: State<'_, DesktopState>) -> Result<Vec<Source>, CommandError> {
    Ok(state.core().source_list()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn source_follow(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<Source, CommandError> {
    Ok(state.core().source_follow(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn source_unfollow(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<Source, CommandError> {
    Ok(state.core().source_unfollow(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn source_set_priority(
    state: State<'_, DesktopState>,
    id: String,
    priority: bool,
) -> Result<Source, CommandError> {
    Ok(state.core().source_set_priority(&id, priority)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn source_crawl_now(
    state: State<'_, DesktopState>,
    id: String,
    reason: Option<String>,
) -> Result<SourceCrawlNowResult, CommandError> {
    Ok(state.core().source_crawl_now(&id, reason.as_deref())?)
}
