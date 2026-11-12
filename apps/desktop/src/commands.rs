//! Complete Tauri v2 IPC command handlers (`03-desktop.md §4`, `apps/desktop/ui/src/lib/api.ts`).
//!
//! Exposes all 54 domain commands consumed by the React UI plus `open_external_url`, along with
//! [`invoke_command_json`] so integration/contract tests exercise the exact JSON argument
//! deserialization and return payload shapes used by `api.ts`.

use std::collections::BTreeMap;

use dealsonar_core::dto::{
    AiProviderId, AiUsageStats, BlocklistEntry, BlocklistKind, BlocklistRemoveResult, Channel,
    ChannelRemoveResult, ChromeConnectOptions, ChromeConnectResult, Contact, ContactBlockResult,
    ContactDetail, CrawlRun, CreateRadarDraftInput, DataBackupResult, DataDeleteAllResult,
    DataPurgeResult, DiagnosticBundleResult, FunnelStats, HealthStatus, LeadCrmPatch, LeadDetail,
    LeadExportInput, LeadExportResult, LeadFeedbackInput, LeadFeedbackResult, LeadFilterQuery,
    LeadListResponse, LeadStatus, LicenseStatus, ModelTierMap, Post, PreviewRunState,
    PreviewStartInput, ProbeResult, Radar, RadarDetail, RadarStatus, RadarTemplate,
    RadarUpdateResult, RejectedEvaluation, Ruleset, RulesetBody, RulesetCompileResult, Settings,
    SettingsPatch, Source, SourceCrawlNowResult, SuggestFieldsInput, SuggestFieldsResult,
    TelegramSetupStatus, TelegramTestResult, UpdateRadarInput,
};
use dealsonar_core::CoreError;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::security::{open_in_default_browser, validate_safe_external_url};
use crate::state::DesktopState;

/// Serializable command error returned across the Tauri IPC boundary.
/// Serializes on the wire as a human-readable string so `String(err)` in the React UI
/// displays clean Vietnamese messages rather than `[object Object]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.message)
    }
}

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        let code = match &err {
            CoreError::NotFound { .. } => "not_found",
            CoreError::Validation(_) | CoreError::RulesValidation(_) => "validation_error",
            CoreError::LicenseInvalid(_) => "license_invalid",
            CoreError::LicenseLimitExceeded(_) => "license_limit_exceeded",
            CoreError::ShuttingDown => "shutting_down",
            CoreError::Ai(_) => "ai_error",
            CoreError::Notify(_) => "notify_error",
            CoreError::Secret(_) => "secret_error",
            CoreError::Manifest(_) => "manifest_error",
            CoreError::Store(_) => "store_error",
            CoreError::ProtocolFrame(_) | CoreError::ProtocolParse(_) => "protocol_error",
            CoreError::Io(_) | CoreError::Zip(_) | CoreError::Json(_) | CoreError::Internal(_) => {
                "internal_error"
            }
        };
        Self::new(code, err.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenExternalUrlResult {
    pub opened: bool,
}

/// Parses the top-level JSON payload sent by `api.leadSetStatus`:
/// `{ id, status, note?, tags?, follow_up_at? }` while preserving exact distinction between
/// omitted keys (`None` -> keep existing value) and explicit `null` (`Some(None)` -> clear value).
pub fn parse_lead_set_status_payload(
    raw: &Value,
) -> Result<(String, LeadStatus, Option<LeadCrmPatch>), CommandError> {
    let Some(map) = raw.as_object() else {
        return Err(CommandError::new(
            "validation_error",
            "dữ liệu đầu vào lead_set_status phải là đối tượng JSON",
        ));
    };

    let id = map
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::new("validation_error", "thiếu tham số 'id'"))?
        .to_string();

    let status_val = map
        .get("status")
        .cloned()
        .ok_or_else(|| CommandError::new("validation_error", "thiếu tham số 'status'"))?;
    let status: LeadStatus = serde_json::from_value(status_val)
        .map_err(|e| CommandError::new("validation_error", format!("status không hợp lệ: {e}")))?;

    let note = match map.get("note") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(serde_json::from_value::<String>(v.clone()).map_err(
            |e| CommandError::new("validation_error", format!("note không hợp lệ: {e}")),
        )?)),
    };

    let tags = match map.get("tags") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(
            serde_json::from_value::<Vec<String>>(v.clone()).map_err(|e| {
                CommandError::new("validation_error", format!("tags không hợp lệ: {e}"))
            })?,
        )),
    };

    let follow_up_at = match map.get("follow_up_at") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(serde_json::from_value::<i64>(v.clone()).map_err(
            |e| {
                CommandError::new(
                    "validation_error",
                    format!("follow_up_at không hợp lệ: {e}"),
                )
            },
        )?)),
    };

    let crm = if note.is_some() || tags.is_some() || follow_up_at.is_some() {
        Some(LeadCrmPatch {
            note,
            tags,
            follow_up_at,
        })
    } else {
        None
    };

    Ok((id, status, crm))
}

// ============================================================================
// 1. Radars (`radar_*`)
// ============================================================================

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

// ============================================================================
// 2. Templates (`template_*`)
// ============================================================================

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

// ============================================================================
// 3. Sources (`source_*`)
// ============================================================================

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

// ============================================================================
// 4. Leads (`lead_*`)
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_list(
    state: State<'_, DesktopState>,
    query: LeadFilterQuery,
) -> Result<LeadListResponse, CommandError> {
    Ok(state.core().lead_list(query)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_get(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<LeadDetail, CommandError> {
    Ok(state.core().lead_get(&id)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_set_status(
    state: State<'_, DesktopState>,
    request: Request<'_>,
) -> Result<LeadDetail, CommandError> {
    let raw_json = match request.body() {
        InvokeBody::Json(val) => val.clone(),
        InvokeBody::Raw(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|e| {
            CommandError::new("validation_error", format!("JSON không hợp lệ: {e}"))
        })?,
    };
    let (id, status, crm) = parse_lead_set_status_payload(&raw_json)?;
    Ok(state.core().lead_set_status(&id, status, crm)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_update_field(
    state: State<'_, DesktopState>,
    id: String,
    field_key: String,
    value: Value,
    raw: Option<String>,
) -> Result<LeadDetail, CommandError> {
    Ok(state
        .core()
        .lead_update_field(&id, &field_key, value, raw)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_feedback(
    state: State<'_, DesktopState>,
    input: LeadFeedbackInput,
) -> Result<LeadFeedbackResult, CommandError> {
    Ok(state.core().lead_feedback(input)?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lead_export(
    state: State<'_, DesktopState>,
    input: LeadExportInput,
) -> Result<LeadExportResult, CommandError> {
    Ok(state.core().lead_export(input)?)
}

// ============================================================================
// 5. Posts & Rejected Evaluations (`post_*`, `evaluation_list_rejected`)
// ============================================================================

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

// ============================================================================
// 6. Contacts & Blocklist (`contact_*`, `blocklist_*`)
// ============================================================================

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

// ============================================================================
// 7. Rulesets (`ruleset_*`)
// ============================================================================

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

// ============================================================================
// 8. Settings, AI, Telegram, Channels, Webhook, Chrome, License
// ============================================================================

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

// ============================================================================
// 9. Health, Diagnostics, Data Lifecycle & Safe External URL Opener
// ============================================================================

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

// ============================================================================
// JSON Command Dispatcher for UI <-> Desktop Contract & E2E Tests
// ============================================================================

fn parse_arg<T: for<'de> Deserialize<'de>>(
    map: &Map<String, Value>,
    key: &str,
) -> Result<T, CommandError> {
    let val = map
        .get(key)
        .cloned()
        .ok_or_else(|| CommandError::new("validation_error", format!("thiếu tham số '{key}'")))?;
    serde_json::from_value(val).map_err(|e| {
        CommandError::new(
            "validation_error",
            format!("tham số '{key}' không hợp lệ: {e}"),
        )
    })
}

fn parse_opt_arg<T: for<'de> Deserialize<'de>>(
    map: &Map<String, Value>,
    key: &str,
) -> Result<Option<T>, CommandError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| {
            CommandError::new(
                "validation_error",
                format!("tham số '{key}' không hợp lệ: {e}"),
            )
        }),
    }
}

fn to_json<T: Serialize>(val: T) -> Result<Value, CommandError> {
    serde_json::to_value(val).map_err(|e| CommandError::new("internal_error", e.to_string()))
}

/// Dispatches any DealSonar desktop command using the exact JSON payload object sent by
/// `apps/desktop/ui/src/lib/api.ts` and returns its serialized JSON response.
pub async fn invoke_command_json(
    state: &DesktopState,
    cmd: &str,
    args: Value,
) -> Result<Value, CommandError> {
    let empty = Map::new();
    let map = match &args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => {
            return Err(CommandError::new(
                "validation_error",
                "tham số lệnh IPC phải là đối tượng JSON",
            ))
        }
    };

    let c = state.core();
    match cmd {
        // 1. Radars
        "radar_list" => to_json(c.radar_list()?),
        "radar_get" => to_json(c.radar_get(&parse_arg::<String>(map, "id")?)?),
        "radar_create_draft" => to_json(c.radar_create_draft(parse_arg(map, "input")?)?),
        "radar_update" => to_json(c.radar_update(parse_arg(map, "input")?)?),
        "radar_suggest_fields" => to_json(c.radar_suggest_fields(parse_arg(map, "input")?).await?),
        "radar_set_status" => to_json(
            c.radar_set_status(&parse_arg::<String>(map, "id")?, parse_arg(map, "status")?)
                .await?,
        ),
        "radar_preview_start" => to_json(c.radar_preview_start(parse_arg(map, "input")?).await?),
        "radar_preview_get" => {
            let radar_id: String = parse_arg(map, "radar_id")?;
            let preview_id: Option<String> = parse_opt_arg(map, "preview_id")?;
            to_json(c.radar_preview_get(&radar_id, preview_id.as_deref())?)
        }
        "radar_stats" => {
            let radar_id: Option<String> = parse_opt_arg(map, "radar_id")?;
            let days: Option<u32> = parse_opt_arg(map, "days")?;
            to_json(c.radar_stats(radar_id.as_deref(), days.unwrap_or(7))?)
        }

        // 2. Templates
        "template_list" => to_json(c.template_list()?),
        "template_get" => to_json(c.template_get(&parse_arg::<String>(map, "id")?)?),

        // 3. Sources
        "source_list" => to_json(c.source_list()?),
        "source_follow" => to_json(c.source_follow(&parse_arg::<String>(map, "id")?)?),
        "source_unfollow" => to_json(c.source_unfollow(&parse_arg::<String>(map, "id")?)?),
        "source_set_priority" => to_json(c.source_set_priority(
            &parse_arg::<String>(map, "id")?,
            parse_arg::<bool>(map, "priority")?,
        )?),
        "source_crawl_now" => {
            let id: String = parse_arg(map, "id")?;
            let reason: Option<String> = parse_opt_arg(map, "reason")?;
            to_json(c.source_crawl_now(&id, reason.as_deref())?)
        }

        // 4. Leads
        "lead_list" => to_json(c.lead_list(parse_arg(map, "query")?)?),
        "lead_get" => to_json(c.lead_get(&parse_arg::<String>(map, "id")?)?),
        "lead_set_status" => {
            let (id, status, crm) = parse_lead_set_status_payload(&args)?;
            to_json(c.lead_set_status(&id, status, crm)?)
        }
        "lead_update_field" => {
            let id: String = parse_arg(map, "id")?;
            let field_key: String = parse_arg(map, "field_key")?;
            let value: Value = map.get("value").cloned().unwrap_or(Value::Null);
            let raw: Option<String> = parse_opt_arg(map, "raw")?;
            to_json(c.lead_update_field(&id, &field_key, value, raw)?)
        }
        "lead_feedback" => to_json(c.lead_feedback(parse_arg(map, "input")?)?),
        "lead_export" => to_json(c.lead_export(parse_arg(map, "input")?)?),

        // 5. Posts & Rejected Evaluations
        "post_get" => to_json(c.post_get(&parse_arg::<String>(map, "id")?)?),
        "post_search" => {
            let query: String = parse_arg(map, "query")?;
            let source_id: Option<String> = parse_opt_arg(map, "source_id")?;
            let limit: Option<usize> = parse_opt_arg(map, "limit")?;
            to_json(c.post_search(&query, source_id.as_deref(), limit.unwrap_or(30))?)
        }
        "evaluation_list_rejected" => {
            let radar_id: String = parse_arg(map, "radar_id")?;
            let limit: Option<usize> = parse_opt_arg(map, "limit")?;
            to_json(c.evaluation_list_rejected(&radar_id, limit.unwrap_or(30))?)
        }

        // 6. Contacts & Blocklist
        "contact_list" => {
            let search: Option<String> = parse_opt_arg(map, "search")?;
            let limit: Option<usize> = parse_opt_arg(map, "limit")?;
            to_json(c.contact_list(search.as_deref(), limit.unwrap_or(100))?)
        }
        "contact_get" => to_json(c.contact_get(&parse_arg::<String>(map, "id")?)?),
        "contact_block" => {
            let id: String = parse_arg(map, "id")?;
            let reason: Option<String> = parse_opt_arg(map, "reason")?;
            let radar_id: Option<String> = parse_opt_arg(map, "radar_id")?;
            to_json(c.contact_block(&id, reason.as_deref(), radar_id.as_deref())?)
        }
        "contact_note" => to_json(c.contact_note(
            &parse_arg::<String>(map, "id")?,
            &parse_arg::<String>(map, "note")?,
        )?),
        "blocklist_list" => {
            let radar_id: Option<String> = parse_opt_arg(map, "radar_id")?;
            to_json(c.blocklist_list(radar_id.as_deref())?)
        }
        "blocklist_add" => {
            let kind: BlocklistKind = parse_arg(map, "kind")?;
            let value: String = parse_arg(map, "value")?;
            let reason: Option<String> = parse_opt_arg(map, "reason")?;
            let radar_id: Option<String> = parse_opt_arg(map, "radar_id")?;
            to_json(c.blocklist_add(kind, &value, reason.as_deref(), radar_id.as_deref())?)
        }
        "blocklist_remove" => to_json(c.blocklist_remove(&parse_arg::<String>(map, "id")?)?),

        // 7. Rulesets
        "ruleset_list" => {
            let radar_id: String = parse_arg(map, "radar_id")?;
            let radar_version_id: Option<String> = parse_opt_arg(map, "radar_version_id")?;
            to_json(c.ruleset_list(&radar_id, radar_version_id.as_deref())?)
        }
        "ruleset_save_user" => to_json(c.ruleset_save_user(
            &parse_arg::<String>(map, "radar_id")?,
            &parse_arg::<String>(map, "radar_version_id")?,
            parse_arg(map, "body")?,
        )?),
        "ruleset_compile_now" => to_json(
            c.ruleset_compile_now(&parse_arg::<String>(map, "radar_id")?)
                .await?,
        ),

        // 8. Settings, AI, Telegram, Channels, Webhook, Chrome, License
        "settings_get" => to_json(c.settings_get()?),
        "settings_set" => to_json(exec_settings_set(state, parse_arg(map, "patch")?)?),
        "ai_probe" => {
            let provider: Option<AiProviderId> = parse_opt_arg(map, "provider")?;
            to_json(c.ai_probe(provider).await?)
        }
        "ai_set_provider" => {
            let provider: AiProviderId = parse_arg(map, "provider")?;
            let model_tiers: Option<ModelTierMap> = parse_opt_arg(map, "model_tiers")?;
            to_json(c.ai_set_provider(provider, model_tiers)?)
        }
        "telegram_set_token" => to_json(
            c.telegram_set_token(&parse_arg::<String>(map, "token")?)
                .await?,
        ),
        "telegram_test" => {
            let channel_id: Option<String> = parse_opt_arg(map, "channel_id")?;
            to_json(c.telegram_test(channel_id.as_deref()).await?)
        }
        "channel_list" => to_json(c.channel_list()?),
        "channel_remove" => to_json(c.channel_remove(&parse_arg::<String>(map, "id")?)?),
        "webhook_add" => {
            let name: String = parse_arg(map, "name")?;
            let url: String = parse_arg(map, "url")?;
            let secret: Option<String> = parse_opt_arg(map, "secret")?;
            to_json(c.webhook_add(&name, &url, secret.as_deref())?)
        }
        "chrome_connect" => {
            let extension_id: Option<String> = parse_opt_arg(map, "extension_id")?;
            let resume_crawl: Option<bool> = parse_opt_arg(map, "resume_crawl")?;
            to_json(c.chrome_connect(Some(ChromeConnectOptions {
                extension_id,
                resume_crawl: resume_crawl.unwrap_or(false),
            }))?)
        }
        "license_get" => to_json(c.license_get()?),
        "license_set" => to_json(c.license_set(&parse_arg::<String>(map, "license_key")?)?),

        // 9. Health, Diagnostics, Data Lifecycle, External URL
        "health_get" => to_json(c.health_get()?),
        "crawl_run_list" => {
            let source_id: Option<String> = parse_opt_arg(map, "source_id")?;
            let limit: Option<usize> = parse_opt_arg(map, "limit")?;
            to_json(c.crawl_run_list(source_id.as_deref(), limit.unwrap_or(50))?)
        }
        "ai_usage_get" => {
            let days: Option<u32> = parse_opt_arg(map, "days")?;
            to_json(c.ai_usage_get(days.unwrap_or(7))?)
        }
        "diagnostic_bundle_create" => to_json(c.diagnostic_bundle_create()?),
        "data_backup" => to_json(c.data_backup()?),
        "data_purge" => {
            let days: Option<u32> = parse_opt_arg(map, "unmatched_retention_days")?;
            to_json(c.data_purge(days)?)
        }
        "data_delete_all" => {
            to_json(c.data_delete_all(&parse_arg::<String>(map, "confirm_phrase")?)?)
        }
        "open_external_url" => to_json(exec_open_external_url(&parse_arg::<String>(map, "url")?)?),

        other => Err(CommandError::new(
            "unknown_command",
            format!("lệnh IPC không tồn tại: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lead_set_status_distinguishes_omitted_vs_explicit_null_crm_fields() {
        let omitted = json!({ "id": "01J0001", "status": "viewed" });
        let (_, st, crm) = parse_lead_set_status_payload(&omitted).unwrap();
        assert_eq!(st, LeadStatus::Viewed);
        assert!(crm.is_none());

        let clear_followup = json!({
            "id": "01J0001",
            "status": "contacted",
            "note": "Gọi khách chiều nay",
            "follow_up_at": null
        });
        let (_, st2, crm2) = parse_lead_set_status_payload(&clear_followup).unwrap();
        assert_eq!(st2, LeadStatus::Contacted);
        let patch = crm2.expect("crm patch present");
        assert_eq!(patch.note, Some(Some("Gọi khách chiều nay".to_string())));
        assert_eq!(patch.tags, None);
        assert_eq!(patch.follow_up_at, Some(None));
    }
}
