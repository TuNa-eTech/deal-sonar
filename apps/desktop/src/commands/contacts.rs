//! Contact and blocklist commands (`contact_*`, `blocklist_*`).

use dealsonar_core::dto::{
    BlocklistEntry, BlocklistKind, BlocklistRemoveResult, Contact, ContactBlockResult,
    ContactDetail,
};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

#[tauri::command(rename_all = "snake_case")]
pub async fn contact_list(
    state: State<'_, DesktopState>,
    search: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Contact>, CommandError> {
    Ok(state
        .core()
        .contact_list(search.as_deref(), limit.unwrap_or(100))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn contact_get(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<ContactDetail, CommandError> {
    Ok(state.core().contact_get(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn contact_block(
    state: State<'_, DesktopState>,
    id: String,
    reason: Option<String>,
    radar_id: Option<String>,
) -> Result<ContactBlockResult, CommandError> {
    Ok(state
        .core()
        .contact_block(&id, reason.as_deref(), radar_id.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn contact_note(
    state: State<'_, DesktopState>,
    id: String,
    note: String,
) -> Result<Contact, CommandError> {
    Ok(state.core().contact_note(&id, &note)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn blocklist_list(
    state: State<'_, DesktopState>,
    radar_id: Option<String>,
) -> Result<Vec<BlocklistEntry>, CommandError> {
    Ok(state.core().blocklist_list(radar_id.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn blocklist_add(
    state: State<'_, DesktopState>,
    kind: BlocklistKind,
    value: String,
    reason: Option<String>,
    radar_id: Option<String>,
) -> Result<BlocklistEntry, CommandError> {
    Ok(state
        .core()
        .blocklist_add(kind, &value, reason.as_deref(), radar_id.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn blocklist_remove(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<BlocklistRemoveResult, CommandError> {
    Ok(state.core().blocklist_remove(&id)?)
}
