//! JSON command dispatcher for UI <-> Desktop contract and E2E tests.

use dealsonar_core::dto::{AiProviderId, BlocklistKind, ChromeConnectOptions, ModelTierMap};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    exec_open_external_url, exec_settings_set, parse_lead_set_status_payload, CommandError,
};
use crate::state::DesktopState;

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
        "radar_preview_cancel" => to_json(
            c.radar_preview_cancel(
                &parse_arg::<String>(map, "radar_id")?,
                &parse_arg::<String>(map, "preview_id")?,
            )
            .await?,
        ),
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
        "lead_mark_read" => to_json(c.lead_mark_read(&parse_arg::<String>(map, "id")?)?),
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
        "workspace_action" => to_json(c.workspace_action(
            &parse_arg::<String>(map, "action")?,
            parse_arg(map, "input")?,
        )?),
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
