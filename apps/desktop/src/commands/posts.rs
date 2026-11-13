//! Post and rejected-evaluation commands (`post_*`, `evaluation_list_rejected`).

use dealsonar_core::dto::{Post, RejectedEvaluation};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn post_get(state: State<'_, DesktopState>, id: String) -> Result<Post, CommandError> {
    Ok(state.core().post_get(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn post_search(
    state: State<'_, DesktopState>,
    query: String,
    source_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Post>, CommandError> {
    Ok(state
        .core()
        .post_search(&query, source_id.as_deref(), limit.unwrap_or(30))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn evaluation_list_rejected(
    state: State<'_, DesktopState>,
    radar_id: String,
    limit: Option<usize>,
) -> Result<Vec<RejectedEvaluation>, CommandError> {
    Ok(state
        .core()
        .evaluation_list_rejected(&radar_id, limit.unwrap_or(30))?)
}
