//! Lead commands (`lead_*`) and the `lead_set_status` payload parser.

use dealsonar_core::dto::{
    LeadCrmPatch, LeadDetail, LeadExportInput, LeadExportResult, LeadFeedbackInput,
    LeadFeedbackResult, LeadFilterQuery, LeadListResponse, LeadStatus,
};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use super::CommandError;
use crate::state::DesktopState;

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
pub async fn lead_mark_read(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<LeadDetail, CommandError> {
    Ok(state.core().lead_mark_read(&id)?)
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
