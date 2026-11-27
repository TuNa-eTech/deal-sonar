//! Compare two radar definitions on one shared set of posts (`02-radar-spec.md §4`, "Biến thể").
//!
//! Both definitions are evaluated through the preview pipeline (T3–T6), so a comparison never
//! creates leads, contacts or notifications. Its evaluations live in a scratch scope that does
//! not collide with any radar's live or preview rows and are deleted as soon as they are read.
//! Only the verdicts are kept, as a record of which versions and which posts were compared.

use std::collections::HashSet;

use dealsonar_store::models::{EvaluationRecord, RadarWithVersion, COMPARE_EVAL_SCOPE};

use super::preview::evaluate_posts_without_side_effects;
use super::*;
use crate::dto::{
    field_def_from_store, match_policy_from_store, CompareChange, CompareCounts, CompareDefinition,
    CompareFieldChange, CompareItem, CompareVerdict, DefinitionDiff, ExtractedField,
    RadarCompareInput, RadarCompareSide, RadarComparison, RadarComparisonSummary,
};

const INDEX_KEY: &str = "radar.comparison_index";
const MAX_RETAINED_COMPARISONS: usize = 20;
const COMPARE_TIMEOUT: Duration = Duration::from_secs(300);

/// One comparison at a time: scratch evaluation rows are keyed by (post, version).
static COMPARE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Side {
    rw: RadarWithVersion,
    ver: RadarVersionRecord,
}

fn record_key(id: &str) -> String {
    format!("radar.comparison.{id}")
}

pub async fn run_radar_comparison(
    rt: &Arc<CoreRuntime>,
    input: RadarCompareInput,
) -> CoreResult<RadarComparison> {
    let left = resolve_side(rt, &input.left)?;
    let right = resolve_side(rt, &input.right)?;
    let cap = rt.config.preview_max_posts.max(1);
    let max_posts = input.max_posts.unwrap_or(cap).clamp(1, cap);
    let (posts, source_ids, skipped_post_ids) =
        resolve_posts(rt, &input, &left.rw, &right.rw, max_posts)?;

    let _one_at_a_time = COMPARE_LOCK.lock().await;
    // Scratch rows only outlive a comparison if the app was killed mid-run.
    rt.store.cleanup_compare_evaluations(None)?;
    let mut shutdown = rt.shutdown_tx.subscribe();
    let work = async {
        let left_rows = evaluate_side(rt, &left, &posts).await?;
        let right_rows = if left.ver.id == right.ver.id {
            left_rows.clone()
        } else {
            evaluate_side(rt, &right, &posts).await?
        };
        Ok::<_, CoreError>((left_rows, right_rows))
    };
    let (left_rows, right_rows) = tokio::select! {
        result = tokio::time::timeout(COMPARE_TIMEOUT, work) => result.unwrap_or_else(|_| {
            Err(CoreError::Validation(
                "So sánh vượt quá 5 phút. Hãy kiểm tra AI và thử lại với ít bài hơn.".into(),
            ))
        })?,
        _ = async {
            let already = rt.shutting_down.load(std::sync::atomic::Ordering::SeqCst)
                || *shutdown.borrow_and_update();
            if !already { let _ = shutdown.changed().await; }
        } => return Err(CoreError::ShuttingDown),
    };

    let left_def = definition_of(&left);
    let right_def = definition_of(&right);
    let definition_diff = diff_definitions(&left_def, &right_def);
    let mut items: Vec<CompareItem> = posts
        .iter()
        .map(|post| {
            build_item(
                &post.id,
                verdict_of(left_rows.get(&post.id)),
                verdict_of(right_rows.get(&post.id)),
                &left_def,
                &right_def,
                &definition_diff,
            )
        })
        .collect();
    items.sort_by(|a, b| {
        change_rank(a.change)
            .cmp(&change_rank(b.change))
            .then_with(|| {
                b.right
                    .score
                    .partial_cmp(&a.right.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let comparison = RadarComparison {
        id: new_ulid(),
        created_at: now_ms(),
        left: left_def,
        right: right_def,
        source_ids,
        post_ids: posts.iter().map(|p| p.id.clone()).collect(),
        skipped_post_ids,
        counts: count_items(&items),
        definition_diff,
        items,
    };
    retain_comparison(rt, &comparison)?;
    let mut returned = comparison;
    hydrate_posts(rt, &mut returned);
    Ok(returned)
}

pub fn get_radar_comparison(rt: &CoreRuntime, id: &str) -> CoreResult<RadarComparison> {
    let mut comparison = rt
        .store
        .get_setting::<RadarComparison>(&record_key(id))?
        .ok_or_else(|| CoreError::NotFound {
            entity: "radar_comparison",
            id: id.to_string(),
        })?;
    hydrate_posts(rt, &mut comparison);
    Ok(comparison)
}

pub fn list_radar_comparisons(rt: &CoreRuntime) -> CoreResult<Vec<RadarComparisonSummary>> {
    Ok(rt
        .store
        .get_setting::<Vec<RadarComparisonSummary>>(INDEX_KEY)?
        .unwrap_or_default())
}

fn resolve_side(rt: &CoreRuntime, side: &RadarCompareSide) -> CoreResult<Side> {
    let rw = rt
        .store
        .radar_get(&side.radar_id)?
        .ok_or_else(|| CoreError::NotFound {
            entity: "radar",
            id: side.radar_id.clone(),
        })?;
    let ver = match side.version {
        None => rw.current_version.clone(),
        Some(number) => rt
            .store
            .radar_versions(&side.radar_id)?
            .into_iter()
            .find(|v| v.version == number)
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar_version",
                id: format!("{}@v{number}", side.radar_id),
            })?,
    };
    Ok(Side { rw, ver })
}

/// Returns the shared posts, the groups they came from, and requested posts that were skipped.
fn resolve_posts(
    rt: &CoreRuntime,
    input: &RadarCompareInput,
    left: &RadarWithVersion,
    right: &RadarWithVersion,
    max_posts: usize,
) -> CoreResult<(
    Vec<dealsonar_store::models::PostRecord>,
    Vec<String>,
    Vec<String>,
)> {
    let explicit_posts = input.post_ids.as_ref().filter(|ids| !ids.is_empty());
    let explicit_sources = input.source_ids.as_ref().filter(|ids| !ids.is_empty());
    if explicit_posts.is_some() && explicit_sources.is_some() {
        return Err(CoreError::Validation(
            "Chọn bài cụ thể hoặc chọn group, không chọn cả hai.".into(),
        ));
    }

    if let Some(post_ids) = explicit_posts {
        let mut seen = HashSet::new();
        let wanted: Vec<String> = post_ids
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .take(max_posts)
            .cloned()
            .collect();
        let posts = rt.store.list_posts_by_ids(&wanted)?;
        let found: HashSet<&str> = posts.iter().map(|p| p.id.as_str()).collect();
        let skipped = wanted
            .iter()
            .filter(|id| !found.contains(id.as_str()))
            .cloned()
            .collect();
        if posts.is_empty() {
            return Err(CoreError::Validation(
                "Không còn bài nào trong danh sách để so sánh.".into(),
            ));
        }
        return Ok((posts, Vec::new(), skipped));
    }

    let mut source_ids: Vec<String> = match explicit_sources {
        Some(ids) => ids.clone(),
        None => left
            .source_ids
            .iter()
            .filter(|id| right.source_ids.contains(id))
            .cloned()
            .collect(),
    };
    source_ids.sort();
    source_ids.dedup();
    if source_ids.is_empty() {
        return Err(CoreError::Validation(
            "Hãy chọn ít nhất một group; hai radar không có group chung.".into(),
        ));
    }
    for id in &source_ids {
        if rt.store.source_get(id)?.is_none() {
            return Err(CoreError::NotFound {
                entity: "source",
                id: id.clone(),
            });
        }
    }
    let posts = rt
        .store
        .list_recent_posts_for_sources(&source_ids, max_posts)?;
    if posts.is_empty() {
        return Err(CoreError::Validation(
            "Chưa có bài nào trong các group đã chọn để so sánh.".into(),
        ));
    }
    Ok((posts, source_ids, Vec::new()))
}

/// Evaluate `posts` under one definition and return its verdicts by post, leaving no
/// comparison rows behind.
async fn evaluate_side(
    rt: &Arc<CoreRuntime>,
    side: &Side,
    posts: &[dealsonar_store::models::PostRecord],
) -> CoreResult<HashMap<String, EvaluationRecord>> {
    rt.store.cleanup_compare_evaluations(Some(&side.ver.id))?;
    let mut scratch = PreviewRunState {
        preview_id: String::new(),
        radar_id: side.rw.radar.id.clone(),
        radar_version: side.ver.version,
        source_ids: None,
        status: PreviewStatus::Evaluating,
        total_posts: posts.len(),
        evaluated_posts: 0,
        failed_posts: 0,
        items: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };
    let outcome = evaluate_posts_without_side_effects(
        rt,
        &side.rw,
        &side.ver,
        posts,
        &mut scratch,
        EvalMode::Compare,
    )
    .await;
    let rows = rt
        .store
        .list_evaluations_in_scope(&side.ver.id, COMPARE_EVAL_SCOPE);
    let cleaned = rt.store.cleanup_compare_evaluations(Some(&side.ver.id));
    outcome?;
    let rows = rows?;
    cleaned?;
    let wanted: HashSet<&str> = posts.iter().map(|p| p.id.as_str()).collect();
    Ok(rows
        .into_iter()
        .filter(|row| wanted.contains(row.post.id.as_str()))
        .map(|row| (row.post.id.clone(), row.evaluation))
        .collect())
}

fn definition_of(side: &Side) -> CompareDefinition {
    CompareDefinition {
        radar_id: side.rw.radar.id.clone(),
        radar_name: side.rw.radar.name.clone(),
        version_id: side.ver.id.clone(),
        version: side.ver.version,
        description: side.ver.description.clone(),
        user_profession: side.ver.user_profession.clone(),
        fields: side.ver.fields.iter().map(field_def_from_store).collect(),
        match_policy: match_policy_from_store(&side.ver.match_policy),
    }
}

fn verdict_of(row: Option<&EvaluationRecord>) -> CompareVerdict {
    let Some(row) = row else {
        return CompareVerdict {
            state: "not_evaluated".into(),
            verdict: None,
            score: None,
            decided_by: None,
            reject_reason: None,
            reason: None,
            summary: None,
            intent: None,
            author_role: None,
            fields: BTreeMap::new(),
        };
    };
    let done = row.state == "done";
    CompareVerdict {
        state: row.state.clone(),
        verdict: done.then(|| row.verdict.clone()).flatten(),
        score: done.then_some(row.score).flatten(),
        decided_by: row.decided_by.clone(),
        reject_reason: row.reject_reason.clone(),
        reason: row.reason.clone(),
        summary: row.summary.clone(),
        intent: row.intent.clone(),
        author_role: row.author_role.clone(),
        fields: row
            .fields
            .as_ref()
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), extracted_field_from_store(v)))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn is_match(v: &CompareVerdict) -> bool {
    v.verdict.as_deref() == Some("match")
}

fn is_scored(v: &CompareVerdict) -> bool {
    v.verdict.is_some()
}

fn diff_definitions(left: &CompareDefinition, right: &CompareDefinition) -> DefinitionDiff {
    let normalized = |f: &crate::dto::FieldDef| {
        let mut f = f.clone();
        f.order = 0;
        f.show_in_alert = true;
        f
    };
    let roles = |d: &CompareDefinition| {
        let mut r: Vec<_> = d
            .match_policy
            .exclude_roles
            .iter()
            .map(|r| r.as_str())
            .collect();
        r.sort_unstable();
        r
    };
    let left_keys: HashSet<&str> = left.fields.iter().map(|f| f.key.as_str()).collect();
    let right_keys: HashSet<&str> = right.fields.iter().map(|f| f.key.as_str()).collect();
    DefinitionDiff {
        same_version: left.version_id == right.version_id,
        description_changed: left.description.trim() != right.description.trim(),
        user_profession_changed: left.user_profession != right.user_profession,
        want_intent_changed: left.match_policy.want_intent != right.match_policy.want_intent,
        exclude_roles_changed: roles(left) != roles(right),
        hard_filters_changed: left.match_policy.hard_filters != right.match_policy.hard_filters,
        fields_only_left: left
            .fields
            .iter()
            .filter(|f| !right_keys.contains(f.key.as_str()))
            .map(|f| f.key.clone())
            .collect(),
        fields_only_right: right
            .fields
            .iter()
            .filter(|f| !left_keys.contains(f.key.as_str()))
            .map(|f| f.key.clone())
            .collect(),
        fields_changed: left
            .fields
            .iter()
            .filter(|lf| {
                right
                    .fields
                    .iter()
                    .any(|rf| rf.key == lf.key && normalized(rf) != normalized(lf))
            })
            .map(|f| f.key.clone())
            .collect(),
    }
}

fn field_changes(
    left: &CompareVerdict,
    right: &CompareVerdict,
    left_def: &CompareDefinition,
    right_def: &CompareDefinition,
) -> Vec<CompareFieldChange> {
    right_def
        .fields
        .iter()
        .filter_map(|rf| {
            left_def.fields.iter().find(|lf| lf.key == rf.key)?;
            let before = left.fields.get(&rf.key);
            let after = right.fields.get(&rf.key);
            (before.map(|f| &f.value) != after.map(|f| &f.value)).then(|| CompareFieldChange {
                key: rf.key.clone(),
                label: rf.label.clone(),
                before: before.cloned(),
                after: after.cloned(),
            })
        })
        .collect()
}

fn build_item(
    post_id: &str,
    left: CompareVerdict,
    right: CompareVerdict,
    left_def: &CompareDefinition,
    right_def: &CompareDefinition,
    diff: &DefinitionDiff,
) -> CompareItem {
    let changes = if is_match(&left) && is_match(&right) {
        field_changes(&left, &right, left_def, right_def)
    } else {
        Vec::new()
    };
    let change = if !is_scored(&left) || !is_scored(&right) {
        CompareChange::NotCompared
    } else {
        match (is_match(&left), is_match(&right)) {
            (false, true) => CompareChange::NewlyMatched,
            (true, false) => CompareChange::NoLongerMatched,
            (true, true) if !changes.is_empty() => CompareChange::FieldsChanged,
            (true, true) => CompareChange::StillMatched,
            (false, false) => CompareChange::StillUnmatched,
        }
    };
    let reason = explain(change, &left, &right, &changes, diff);
    CompareItem {
        post_id: post_id.to_string(),
        change,
        reason,
        left,
        right,
        field_changes: changes,
        source_name: String::new(),
        author_name: String::new(),
        permalink: String::new(),
        post_text: None,
        post_created_at: None,
    }
}

fn reject_label(reason: &str) -> &str {
    match reason {
        "duplicate" => "trùng bài",
        "prefilter" => "bị lọc sơ bộ",
        "irrelevant" => "không liên quan",
        "peer" => "người cùng nghề",
        "spam" => "rác",
        "blocked" => "bị chặn",
        "hard_filter" => "không đạt điều kiện lọc cứng",
        other => other,
    }
}

/// How one side judged the post, in a sentence fragment: "khớp 82% — lý do" / "bị loại (…) — lý do".
fn describe(v: &CompareVerdict) -> String {
    let because = v
        .reason
        .as_deref()
        .map(|r| r.trim().trim_end_matches('.'))
        .filter(|r| !r.is_empty())
        .map(|r| format!(" — {r}"))
        .unwrap_or_default();
    if is_match(v) {
        format!("khớp {:.0}%{because}", v.score.unwrap_or(0.0) * 100.0)
    } else if is_scored(v) {
        let label = v
            .reject_reason
            .as_deref()
            .map(reject_label)
            .unwrap_or("không khớp");
        format!("bị loại ({label}){because}")
    } else {
        format!("chưa chấm được ({})", v.state)
    }
}

/// Which definition difference most plausibly explains a rejection.
fn definition_hint(rejected: &CompareVerdict, diff: &DefinitionDiff) -> &'static str {
    match rejected.reject_reason.as_deref() {
        Some("hard_filter") if diff.hard_filters_changed => {
            " Điều kiện lọc cứng của hai định nghĩa khác nhau."
        }
        Some("peer") if diff.exclude_roles_changed => {
            " Cách loại người cùng nghề của hai định nghĩa khác nhau."
        }
        Some("irrelevant") if diff.want_intent_changed => {
            " Chiều cần tìm (cần/có) của hai định nghĩa khác nhau."
        }
        Some("irrelevant" | "prefilter") if diff.description_changed => {
            " Mô tả nhu cầu của hai định nghĩa khác nhau."
        }
        _ => "",
    }
}

fn show_field(f: Option<&ExtractedField>) -> String {
    match f {
        None => "(không có)".to_string(),
        Some(f) => f
            .raw
            .clone()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| f.value.to_string()),
    }
}

fn explain(
    change: CompareChange,
    left: &CompareVerdict,
    right: &CompareVerdict,
    changes: &[CompareFieldChange],
    diff: &DefinitionDiff,
) -> String {
    match change {
        CompareChange::NewlyMatched => format!(
            "Mới khớp ở B: {}. Ở A: {}.{}",
            describe(right),
            describe(left),
            definition_hint(left, diff)
        ),
        CompareChange::NoLongerMatched => format!(
            "Hết khớp ở B: {}. Ở A: {}.{}",
            describe(right),
            describe(left),
            definition_hint(right, diff)
        ),
        CompareChange::FieldsChanged => format!(
            "Vẫn khớp ở cả hai nhưng đổi trường trích: {}.",
            changes
                .iter()
                .map(|c| format!(
                    "{}: «{}» → «{}»",
                    c.label,
                    show_field(c.before.as_ref()),
                    show_field(c.after.as_ref())
                ))
                .collect::<Vec<_>>()
                .join("; ")
        ),
        CompareChange::StillMatched => "Khớp ở cả hai, các trường trích giống nhau.".to_string(),
        CompareChange::StillUnmatched => format!(
            "Không khớp ở cả hai. A: {}. B: {}.",
            describe(left),
            describe(right)
        ),
        CompareChange::NotCompared => format!(
            "Chưa so sánh được vì một bên chưa chấm xong. A: {}. B: {}.",
            describe(left),
            describe(right)
        ),
    }
}

fn change_rank(change: CompareChange) -> u8 {
    match change {
        CompareChange::NewlyMatched => 0,
        CompareChange::NoLongerMatched => 1,
        CompareChange::FieldsChanged => 2,
        CompareChange::StillMatched => 3,
        CompareChange::StillUnmatched => 4,
        CompareChange::NotCompared => 5,
    }
}

fn count_items(items: &[CompareItem]) -> CompareCounts {
    let mut counts = CompareCounts {
        total: items.len(),
        ..CompareCounts::default()
    };
    for item in items {
        match item.change {
            CompareChange::NewlyMatched => counts.newly_matched += 1,
            CompareChange::NoLongerMatched => counts.no_longer_matched += 1,
            CompareChange::FieldsChanged => counts.fields_changed += 1,
            CompareChange::StillMatched => counts.still_matched += 1,
            CompareChange::StillUnmatched => counts.still_unmatched += 1,
            CompareChange::NotCompared => counts.not_compared += 1,
        }
        counts.left_matches += usize::from(is_match(&item.left));
        counts.right_matches += usize::from(is_match(&item.right));
    }
    counts
}

/// Keep the record (versions, posts and verdicts, no post text) and prune the oldest ones.
fn retain_comparison(rt: &CoreRuntime, comparison: &RadarComparison) -> CoreResult<()> {
    rt.store
        .set_setting(&record_key(&comparison.id), comparison)?;
    let mut index = list_radar_comparisons(rt)?;
    index.insert(
        0,
        RadarComparisonSummary {
            id: comparison.id.clone(),
            created_at: comparison.created_at,
            left_radar_name: comparison.left.radar_name.clone(),
            left_version: comparison.left.version,
            right_radar_name: comparison.right.radar_name.clone(),
            right_version: comparison.right.version,
            post_count: comparison.post_ids.len(),
        },
    );
    for old in index.split_off(index.len().min(MAX_RETAINED_COMPARISONS)) {
        rt.store.delete_setting(&record_key(&old.id))?;
    }
    rt.store.set_setting(INDEX_KEY, &index)?;
    Ok(())
}

/// Post text follows the post's retention, so it is looked up when a comparison is read.
fn hydrate_posts(rt: &CoreRuntime, comparison: &mut RadarComparison) {
    for item in &mut comparison.items {
        if let Ok(Some(detail)) = rt.store.post_get(&item.post_id) {
            item.source_name = detail.source_name;
            item.author_name = detail.author_name.unwrap_or_default();
            item.permalink = detail.post.permalink;
            item.post_text = detail.post.text;
            item.post_created_at = detail.post.created_at;
        }
    }
}
