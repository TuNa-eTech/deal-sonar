//! Settings, AI, Telegram, channel, webhook, Chrome, and license commands.

use std::collections::BTreeMap;

use dealsonar_core::dto::{
    AiProviderId, Channel, ChannelRemoveResult, ChromeConnectOptions, ChromeConnectResult,
    LicenseStatus, ModelTierMap, ProbeResult, Settings, SettingsPatch, TelegramSetupStatus,
    TelegramTestResult,
};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

pub fn exec_settings_set(
    state: &DesktopState,
    patch: SettingsPatch,
) -> Result<Settings, CommandError> {
    let autostart_change = patch.launch_at_login;
    let updated = state.core().settings_set(patch)?;
    if let Some(enabled) = autostart_change {
        state.sync_autostart(enabled);
    }
    Ok(updated)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_get(state: State<'_, DesktopState>) -> Result<Settings, CommandError> {
    tracing::debug!("ipc settings_get");
    Ok(state.core().settings_get()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_set(
    state: State<'_, DesktopState>,
    patch: SettingsPatch,
) -> Result<Settings, CommandError> {
    exec_settings_set(&state, patch)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_probe(
    state: State<'_, DesktopState>,
    provider: Option<AiProviderId>,
) -> Result<BTreeMap<AiProviderId, ProbeResult>, CommandError> {
    Ok(state.core().ai_probe(provider).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_set_provider(
    state: State<'_, DesktopState>,
    provider: AiProviderId,
    model_tiers: Option<ModelTierMap>,
) -> Result<Settings, CommandError> {
    Ok(state.core().ai_set_provider(provider, model_tiers)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn telegram_set_token(
    state: State<'_, DesktopState>,
    token: String,
) -> Result<TelegramSetupStatus, CommandError> {
    Ok(state.core().telegram_set_token(&token).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn telegram_test(
    state: State<'_, DesktopState>,
    channel_id: Option<String>,
) -> Result<TelegramTestResult, CommandError> {
    Ok(state.core().telegram_test(channel_id.as_deref()).await?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn channel_list(state: State<'_, DesktopState>) -> Result<Vec<Channel>, CommandError> {
    Ok(state.core().channel_list()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn channel_remove(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<ChannelRemoveResult, CommandError> {
    Ok(state.core().channel_remove(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn webhook_add(
    state: State<'_, DesktopState>,
    name: String,
    url: String,
    secret: Option<String>,
) -> Result<Channel, CommandError> {
    Ok(state.core().webhook_add(&name, &url, secret.as_deref())?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn chrome_connect(
    state: State<'_, DesktopState>,
    extension_id: Option<String>,
    resume_crawl: Option<bool>,
) -> Result<ChromeConnectResult, CommandError> {
    Ok(state.core().chrome_connect(Some(ChromeConnectOptions {
        extension_id,
        resume_crawl: resume_crawl.unwrap_or(false),
    }))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn license_get(state: State<'_, DesktopState>) -> Result<LicenseStatus, CommandError> {
    Ok(state.core().license_get()?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn license_set(
    state: State<'_, DesktopState>,
    license_key: String,
) -> Result<LicenseStatus, CommandError> {
    Ok(state.core().license_set(&license_key)?)
}
