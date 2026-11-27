//! Restricted operations exposed to local Codex and Claude chats.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

use dealsonar_protocol::{
    agent::{AgentMethod, AgentRequest, AgentResponse, MAX_FRAME_BYTES, TOKEN_BYTES, TOKEN_FILE},
    new_ulid, PLATFORM_FACEBOOK, SOURCE_KIND_GROUP,
};
use dealsonar_store::models::{now_ms, RadarWithVersion, SourceRecord};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::dto::{
    field_def_to_store, match_policy_from_store, match_policy_to_store, AuthorRole,
    CreateRadarDraftInput, FieldDef, HardFilter, MatchPolicy, PreviewRunState, PreviewStartInput,
    PreviewStatus, SuggestFieldsInput, WantIntent,
};
use crate::error::{CoreError, CoreResult};
use crate::preview_rules::{get_radar_preview, start_radar_preview};
use crate::state::CoreRuntime;

use super::goal::{clean_assumptions, interpret_goal, resolve_peer_exclusion};
use super::radars::persist_radar_draft;

pub(crate) fn issue_agent_token(data_dir: &Path) -> io::Result<[u8; TOKEN_BYTES]> {
    let mut token = [0; TOKEN_BYTES];
    OsRng.fill_bytes(&mut token);
    let temporary = data_dir.join(format!(".agent-access-{}", new_ulid()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        options.open(&temporary)?.write_all(&token)?;
        fs::rename(&temporary, data_dir.join(TOKEN_FILE))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result.map(|()| token)
}

pub(crate) async fn handle_agent_request(
    rt: &Arc<CoreRuntime>,
    expected_token: Option<&[u8; TOKEN_BYTES]>,
    payload: &[u8],
) -> AgentResponse {
    let result = async {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(CoreError::Validation("Yêu cầu agent quá lớn.".into()));
        }
        let request: AgentRequest = serde_json::from_slice(payload)
            .map_err(|_| CoreError::Validation("Yêu cầu agent không hợp lệ.".into()))?;
        if !expected_token.is_some_and(|expected| {
            expected.iter().zip(request.token).fold(0, |diff, (a, b)| diff | (a ^ b)) == 0
        }) {
            return Err(CoreError::Validation(
                "DealSonar từ chối kết nối agent. Hãy kiểm tra đường dẫn ứng dụng và phiên desktop đang mở.".into(),
            ));
        }
        if rt.shutting_down.load(Ordering::SeqCst) {
            return Err(CoreError::ShuttingDown);
        }
        match request.method {
            AgentMethod::ListRadarSources => list_sources(rt),
            AgentMethod::InterpretRadarGoal => {
                interpret_for_agent(rt, parse_arguments(request.arguments)?).await
            }
            AgentMethod::PrepareRadar => prepare_radar(rt, parse_arguments(request.arguments)?).await,
            AgentMethod::CheckRadarPreview | AgentMethod::RetryRadarPreview => {
                let input: PreviewInput = parse_arguments(request.arguments)?;
                let radar = rt.store.radar_get(&input.radar_id)?;
                let radar = radar.as_ref().filter(|r| r.radar.status == "draft").ok_or_else(|| {
                    CoreError::Validation("Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.".into())
                })?;
                let retry = matches!(request.method, AgentMethod::RetryRadarPreview);
                preview_summary(rt, radar, retry).await
            }
        }
    }
    .await;
    match result {
        Ok(value) => AgentResponse::Ok(value),
        Err(error) => AgentResponse::Error(error.to_string()),
    }
}

fn parse_arguments<T: serde::de::DeserializeOwned>(arguments: Value) -> CoreResult<T> {
    serde_json::from_value(arguments).map_err(|error| CoreError::Validation(error.to_string()))
}

fn eligible_source(source: &SourceRecord) -> bool {
    source.platform == PLATFORM_FACEBOOK && source.kind == SOURCE_KIND_GROUP && source.state == "ok"
}

fn list_sources(rt: &CoreRuntime) -> CoreResult<Value> {
    let now = now_ms();
    let limits = rt.current_license_status(now)?.limits;
    let sources: Vec<_> = rt
        .store
        .source_list(now)?
        .into_iter()
        .filter(|item| eligible_source(&item.source))
        .map(|item| {
            json!({
                "id": item.source.id, "name": item.source.name,
                "followed": item.source.followed, "stored_post_count": item.stored_post_count,
                "recent_post_count": item.posts_last_24h,
            })
        })
        .collect();
    Ok(json!({
        "draft_id": new_ulid(), "sources": sources,
        "max_fields": limits.max_fields_per_radar, "max_groups": limits.max_followed_groups,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareInput {
    draft_id: String,
    name: String,
    description: String,
    #[serde(default)]
    user_profession: Option<String>,
    source_ids: Vec<String>,
    fields: Vec<FieldDef>,
    want_intent: WantIntent,
    #[serde(default)]
    hard_filters: Vec<HardFilter>,
    /// `None` lets the shared goal rules decide: keep peers for a neutral Radar, otherwise
    /// exclude them and record that as an assumption.
    #[serde(default)]
    exclude_peers: Option<bool>,
    #[serde(default)]
    assumptions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InterpretInput {
    description: String,
    #[serde(default)]
    user_profession: Option<String>,
}

/// Same interpretation the Desktop wizard shows: trade side, excluded audience, fields,
/// assumptions and the connected groups that look relevant. It creates nothing.
async fn interpret_for_agent(rt: &Arc<CoreRuntime>, input: InterpretInput) -> CoreResult<Value> {
    let result = interpret_goal(
        rt,
        SuggestFieldsInput {
            description: input.description,
            user_profession: input.user_profession,
            template_id: None,
            language_hint: None,
            suggest_sources: true,
        },
    )
    .await?;
    let now = now_ms();
    let suggested_sources: Vec<_> = rt
        .store
        .source_list(now)?
        .into_iter()
        .filter(|item| {
            eligible_source(&item.source) && result.suggested_source_ids.contains(&item.source.id)
        })
        .map(|item| json!({ "id": item.source.id, "name": item.source.name }))
        .collect();
    let exclude_peers = result.exclude_roles.contains(&AuthorRole::Peer);
    // Same shape `prepare_radar` accepts: no internal ordering, no null options.
    let fields: Vec<Value> = result
        .fields
        .iter()
        .map(|field| {
            let mut value = serde_json::to_value(field).unwrap_or_default();
            if let Some(object) = value.as_object_mut() {
                object.remove("order");
                if object.get("options").is_some_and(Value::is_null) {
                    object.remove("options");
                }
            }
            value
        })
        .collect();
    Ok(json!({
        "draft_id": new_ulid(),
        "name": result.suggested_name,
        "want_intent": result.want_intent,
        "side_ambiguous": result.side_ambiguous,
        "needs_clarification": result.side_ambiguous,
        "clarifying_questions": result.clarifying_questions,
        "exclude_peers": exclude_peers,
        "excluded_audiences": excluded_audience_labels(&result.exclude_roles),
        "fields": fields,
        "hard_filters": result.hard_filters,
        "assumptions": result.assumptions,
        "suggested_sources": suggested_sources,
        "next_step": if result.side_ambiguous {
            "Ask the user the clarifying question. If they do not choose, keep want_intent any and exclude_peers false."
        } else {
            "Show the user the interpretation, then call prepare_radar with these values and the chosen source IDs."
        },
    }))
}

fn excluded_audience_labels<'a>(
    roles: impl IntoIterator<Item = &'a AuthorRole>,
) -> Vec<&'static str> {
    roles
        .into_iter()
        .filter_map(|role| match role {
            AuthorRole::Peer => Some("Người cùng nghề đăng bài chào khách"),
            _ => None,
        })
        .collect()
}

fn trade_side_label(want_intent: &str) -> &'static str {
    match want_intent {
        "demand" => "Người đang cần mua, thuê hoặc tìm dịch vụ",
        "supply" => "Người đang bán, cho thuê hoặc cung cấp",
        _ => "Cả hai phía (trung tính)",
    }
}

/// What the Radar will look for, in the same terms the Desktop wizard shows.
fn describe_interpretation(rt: &CoreRuntime, radar: &RadarWithVersion) -> CoreResult<Value> {
    let version = &radar.current_version;
    let policy = match_policy_from_store(&version.match_policy);
    let sources = rt.store.source_list(now_ms())?;
    let source_names: Vec<_> = radar
        .source_ids
        .iter()
        .filter_map(|id| sources.iter().find(|item| item.source.id == *id))
        .map(|item| item.source.name.clone())
        .collect();
    Ok(json!({
        "trade_side": trade_side_label(&version.match_policy.want_intent),
        "want_intent": version.match_policy.want_intent,
        "excluded_audiences": excluded_audience_labels(&policy.exclude_roles),
        "fields": version.fields.iter().map(|field| field.label.clone()).collect::<Vec<_>>(),
        "assumptions": policy.assumptions,
        "sources": source_names,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    radar_id: String,
}

async fn prepare_radar(rt: &Arc<CoreRuntime>, input: PrepareInput) -> CoreResult<Value> {
    let id = input
        .draft_id
        .parse::<ulid::Ulid>()
        .map_err(|_| CoreError::Validation("Hãy dùng draft_id từ list_radar_sources.".into()))?
        .to_string();
    if input.fields.is_empty() {
        return Err(CoreError::Validation(
            "Chọn ít nhất một thông tin cần trích xuất.".into(),
        ));
    }
    if input
        .hard_filters
        .iter()
        .any(|filter| !input.fields.iter().any(|field| field.key == filter.field))
    {
        return Err(CoreError::Validation(
            "Mỗi điều kiện bắt buộc phải dùng một key trong fields.".into(),
        ));
    }
    let mut source_ids = input.source_ids;
    source_ids.sort();
    source_ids.dedup();
    let (exclude_peers, default_note) =
        resolve_peer_exclusion(input.want_intent, input.exclude_peers);
    let assumptions = clean_assumptions(
        default_note
            .map(str::to_owned)
            .into_iter()
            .chain(input.assumptions),
    );
    let draft = CreateRadarDraftInput {
        name: input.name,
        description: input.description,
        user_profession: input
            .user_profession
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        template_id: None,
        language_hint: None,
        fields: input
            .fields
            .into_iter()
            .enumerate()
            .map(|(index, mut field)| {
                field.order = (index + 1) as i32;
                field
            })
            .collect(),
        match_policy: MatchPolicy {
            want_intent: input.want_intent,
            exclude_roles: if exclude_peers {
                vec![AuthorRole::Peer]
            } else {
                vec![]
            },
            hard_filters: input.hard_filters,
            assumptions,
        },
        source_ids,
        notify: None,
    };
    if let Some(existing) = rt.store.radar_get(&id)? {
        let version = &existing.current_version;
        let mut saved_sources = existing.source_ids.clone();
        saved_sources.sort();
        if existing.radar.status != "draft"
            || existing.radar.name != draft.name.trim()
            || version.description != draft.description
            || version.user_profession != draft.user_profession
            || version.match_policy != match_policy_to_store(&draft.match_policy)
            || version.fields
                != draft
                    .fields
                    .iter()
                    .map(field_def_to_store)
                    .collect::<Vec<_>>()
            || saved_sources != draft.source_ids
        {
            return Err(CoreError::Validation(
                "Radar này đã thay đổi hoặc mã nháp đã được dùng cho yêu cầu khác.".into(),
            ));
        }
        let preview = get_radar_preview(rt, &id, None)?;
        if preview.preview_id != "restored" {
            return summarize(rt, &existing, &preview);
        }
        return preview_summary(rt, &existing, true).await;
    }
    validate_sources(rt, &draft.source_ids)?;
    let (saved, _) = persist_radar_draft(rt, draft, Some(id))?;
    rt.emit(crate::dto::CoreEvent::RadarDraftCreated(
        saved.radar.id.clone(),
    ));
    preview_summary(rt, &saved, true).await
}

fn validate_sources(rt: &CoreRuntime, source_ids: &[String]) -> CoreResult<()> {
    if source_ids.is_empty() {
        return Err(CoreError::Validation(
            "Chọn ít nhất một group phù hợp từ list_radar_sources.".into(),
        ));
    }
    let now = now_ms();
    let limit = rt.current_license_status(now)?.limits.max_followed_groups;
    let sources = rt.store.source_list(now)?;
    let mut followed: BTreeSet<_> = sources
        .iter()
        .filter(|row| row.source.followed)
        .map(|row| row.source.id.as_str())
        .collect();
    for id in source_ids {
        if !sources
            .iter()
            .any(|item| item.source.id == *id && eligible_source(&item.source))
        {
            return Err(CoreError::Validation(format!(
                "Group {id} không còn sẵn sàng. Hãy lấy lại danh sách nguồn."
            )));
        }
        followed.insert(id.as_str());
    }
    if followed.len() > limit {
        return Err(CoreError::LicenseLimitExceeded(format!(
            "Gói hiện tại cho phép tối đa {limit} group theo dõi."
        )));
    }
    Ok(())
}

async fn preview_summary(
    rt: &Arc<CoreRuntime>,
    radar: &RadarWithVersion,
    retry: bool,
) -> CoreResult<Value> {
    let id = &radar.radar.id;
    let current = get_radar_preview(rt, id, None)?;
    if !retry
        || matches!(
            current.status,
            PreviewStatus::Crawling | PreviewStatus::Evaluating
        )
    {
        return summarize(rt, radar, &current);
    }
    let start = async {
        validate_sources(rt, &radar.source_ids)?;
        start_radar_preview(
            rt,
            PreviewStartInput {
                radar_id: id.clone(),
                description: None,
                user_profession: None,
                fields: None,
                match_policy: None,
                source_ids: None,
            },
        )
        .await
    };
    match start.await {
        Ok(state) => summarize(rt, radar, &state),
        Err(error) => Ok(json!({
            "radar_id": id, "name": radar.radar.name, "status": "error",
            "error": error.to_string(), "review_in": "DealSonar → Radar",
        })),
    }
}

fn summarize(
    rt: &CoreRuntime,
    radar: &RadarWithVersion,
    preview: &PreviewRunState,
) -> CoreResult<Value> {
    let status = if preview.preview_id == "restored" {
        json!("not_started")
    } else {
        json!(preview.status)
    };
    let matches = preview
        .items
        .iter()
        .filter(|item| item.verdict == "match")
        .count();
    let error = if preview.status == PreviewStatus::Error && preview.total_posts == 0 {
        Some("Chưa có bài để xem thử. Kiểm tra nhóm nguồn và Chrome Extension trong DealSonar.")
    } else if preview.status == PreviewStatus::Error {
        Some("Xem thử chưa hoàn tất. Mở Radar trong DealSonar để xem chi tiết.")
    } else {
        None
    };
    Ok(json!({
        "radar_id": radar.radar.id, "name": radar.radar.name,
        "source_ids": radar.source_ids, "status": status,
        "total_posts": preview.total_posts, "evaluated_posts": preview.evaluated_posts,
        "matched_posts": matches, "failed_posts": preview.failed_posts,
        "warnings": preview.warnings, "error": error,
        "interpretation": describe_interpretation(rt, radar)?,
        "review_in": "DealSonar → Radar → Xem kết quả",
    }))
}
