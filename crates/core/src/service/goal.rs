//! One way to read a free-text Radar goal, shared by the Desktop wizard and local agents.
//!
//! The interpretation never silently picks a side of the trade or drops same-trade authors.
//! When the brief is ambiguous the Radar stays neutral (`any`, nobody excluded) and a
//! clarifying question is returned. Every choice that was not stated by the user is listed in
//! `assumptions` so it can be reviewed and edited before anything is enabled.

use super::*;
use crate::dto::AuthorRole;

const MAX_ASSUMPTIONS: usize = 5;

pub(crate) const SIDE_NEUTRAL_ASSUMPTION: &str =
    "Chưa rõ bạn muốn tìm bài của người cần hay người cung cấp, nên giữ trung tính cả hai chiều và không loại bài của người cùng nghề.";
pub(crate) const PEERS_EXCLUDED_ASSUMPTION: &str =
    "Loại bài của người cùng nghề vì mô tả không nói bạn muốn nhận bài từ họ.";
const SIDE_QUESTION: &str =
    "Bạn muốn tìm bài của người đang cần hay người đang cung cấp (ví dụ tìm xe hay tìm hàng)?";

/// Whether same-trade authors are excluded, plus the assumption to show when that was a default.
pub(crate) fn resolve_peer_exclusion(
    want_intent: WantIntent,
    explicit: Option<bool>,
) -> (bool, Option<&'static str>) {
    match (explicit, want_intent) {
        (Some(exclude), _) => (exclude, None),
        (None, WantIntent::Any) => (false, None),
        (None, _) => (true, Some(PEERS_EXCLUDED_ASSUMPTION)),
    }
}

/// Trim, deduplicate and cap user-facing assumptions.
pub(crate) fn clean_assumptions(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim().to_owned();
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    out.truncate(MAX_ASSUMPTIONS);
    out
}

pub(crate) async fn interpret_goal(
    rt: &Arc<CoreRuntime>,
    input: SuggestFieldsInput,
) -> CoreResult<SuggestFieldsResult> {
    if rt.shutting_down.load(Ordering::SeqCst) {
        return Err(CoreError::ShuttingDown);
    }
    if input.description.trim().is_empty() {
        return Err(CoreError::Validation(
            "Description cannot be empty for field suggestion".to_string(),
        ));
    }

    let now = monotonic_radar_now_ms();
    let license = rt.current_license_status(now)?;
    let _inflight = InflightAiGuard::acquire(rt);
    let sources = if input.suggest_sources {
        rt.store.source_list(now)?
    } else {
        Vec::new()
    };
    let mut followed: HashSet<&str> = sources
        .iter()
        .filter(|row| row.source.followed)
        .map(|row| row.source.id.as_str())
        .collect();
    let max_groups = license.limits.max_followed_groups;
    // Only groups that are connected and working may be suggested.
    let source_candidates = sources
        .iter()
        .filter(|row| {
            row.source.platform == dealsonar_protocol::PLATFORM_FACEBOOK
                && row.source.kind == dealsonar_protocol::SOURCE_KIND_GROUP
                && row.source.state == "ok"
                && (row.source.followed || followed.len() < max_groups)
        })
        .map(|row| dealsonar_ai_bridge::RadarSourceCandidate {
            id: row.source.id.clone(),
            name: row.source.name.clone(),
            stored_posts: row.stored_post_count,
        })
        .collect();

    let bridge_input = BridgeSuggestFieldsInput {
        description: input.description,
        user_profession: input.user_profession,
        language_hint: input.language_hint.or_else(|| Some("vi".to_string())),
        closest_template: input
            .template_id
            .as_deref()
            .and_then(|id| get_template(id, rt.config.templates_dir.as_deref()).ok())
            .and_then(|template| serde_json::to_value(template).ok()),
        source_candidates,
    };

    let task_res = rt.ai_bridge.suggest_fields(&bridge_input).await?;
    for c in &task_res.calls {
        let _ = rt.store.record_ai_call(&RecordAiCallInput {
            id: None,
            provider: c.provider.as_str().to_string(),
            model: c.model.clone(),
            task: "suggest_fields".to_string(),
            radar_version_id: None,
            item_count: 1,
            input_tokens: c.input_tokens.map(|v| v as i64),
            output_tokens: c.output_tokens.map(|v| v as i64),
            cost_usd: c.cost_usd,
            duration_ms: c.duration_ms as i64,
            status: c.status.as_str().to_string(),
            error: c.error.clone(),
            now_ms: now,
        });
    }

    let out = task_res.output;
    let mut suggested_source_ids = Vec::new();
    for id in &out.suggested_source_ids {
        if suggested_source_ids.len() == 3 {
            break;
        }
        if bridge_input
            .source_candidates
            .iter()
            .any(|candidate| candidate.id == *id)
            && !suggested_source_ids.contains(id)
            && (followed.contains(id.as_str()) || followed.len() < max_groups)
        {
            followed.insert(id);
            suggested_source_ids.push(id.clone());
        }
    }
    let max_fields = license.limits.max_fields_per_radar;
    let fields: Vec<_> = out
        .fields
        .iter()
        .take(max_fields)
        .enumerate()
        .map(|(idx, sf)| {
            let mut f = field_def_from_ai(sf, idx as i32);
            f.order = idx as i32;
            f
        })
        .collect();

    let hard_filters = out
        .hard_filters
        .iter()
        .filter(|filter| fields.iter().any(|field| field.key == filter.field))
        .map(|hf| HardFilter {
            field: hf.field.clone(),
            op: crate::dto::FilterOperator::from_str_lossy(&hf.op),
            value: hf.value.clone(),
            when_missing: if hf.when_missing == "fail" {
                WhenMissing::Fail
            } else {
                WhenMissing::Pass
            },
        })
        .collect();

    let side_ambiguous = out.side_ambiguous;
    let want_intent = if side_ambiguous {
        WantIntent::Any
    } else {
        match out.want_intent {
            dealsonar_ai_bridge::WantIntent::Demand => WantIntent::Demand,
            dealsonar_ai_bridge::WantIntent::Supply => WantIntent::Supply,
            dealsonar_ai_bridge::WantIntent::Any => WantIntent::Any,
        }
    };
    let (exclude_peers, default_note) = if side_ambiguous {
        (false, Some(SIDE_NEUTRAL_ASSUMPTION))
    } else {
        resolve_peer_exclusion(want_intent, out.exclude_peers)
    };
    let assumptions = clean_assumptions(
        default_note
            .map(str::to_owned)
            .into_iter()
            .chain(out.assumptions.iter().cloned()),
    );
    let mut clarifying_questions = out.clarifying_questions;
    if side_ambiguous && clarifying_questions.is_empty() {
        clarifying_questions.push(SIDE_QUESTION.to_string());
    }

    let prefilter_hint = out.prefilter_hint.map(|ph| PrefilterHintDto {
        any: ph.any,
        none: ph.none,
    });

    Ok(SuggestFieldsResult {
        suggested_name: out.suggested_name,
        want_intent,
        fields,
        hard_filters,
        clarifying_questions,
        prefilter_hint,
        suggested_source_ids,
        exclude_roles: if exclude_peers {
            vec![AuthorRole::Peer]
        } else {
            Vec::new()
        },
        assumptions,
        side_ambiguous,
    })
}
