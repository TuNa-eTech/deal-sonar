//! `match_policy.condition` (`all` / `any` / `not`): validation on every save entry point, legacy
//! radars unchanged, and identical decisions for preview and live pipeline on the same extraction.

use std::collections::BTreeMap;
use std::sync::Arc;

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::{
    AuthorRole, CreateRadarDraftInput, FieldDef, FieldType, HardFilter, MatchPolicy, PostIntent,
    PreviewStartInput, UpdateRadarInput, WantIntent, WhenMissing,
};
use dealsonar_core::pipeline::{
    finalize_candidate_evaluation, ingest_raw_post, CandidateDecision, EvalMode, IngestPostOutcome,
};
use dealsonar_core::{CoreConfig, CoreService, CoreServiceBuilder};
use dealsonar_protocol::{AuthorInfo, ExtractionInfo, ExtractionStrategy, RawPost};
use dealsonar_rules::{ExtractedField, FieldSource, FilterExpr};
use dealsonar_store::models::{now_ms, DiscoveredSourceInput, EvaluationUpsertInput};
use dealsonar_store::Store;
use serde_json::{json, Value};

fn text_field(key: &str) -> FieldDef {
    FieldDef {
        key: key.to_string(),
        label: key.to_string(),
        r#type: FieldType::Text,
        description: key.to_string(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 0,
    }
}

fn number_field(key: &str) -> FieldDef {
    FieldDef {
        r#type: FieldType::Number,
        ..text_field(key)
    }
}

fn leaf(field: &str, op: &str, value: Value, when_missing: &str) -> Value {
    json!({ "field": field, "op": op, "value": value, "when_missing": when_missing })
}

/// budget <= 15 AND (district = Cầu Giấy OR district = Đống Đa) AND NOT (note contains "ở ghép")
fn condition() -> FilterExpr {
    FilterExpr::from_value(
        &json!({ "all": [
            leaf("budget", "lte", json!(15), "fail"),
            { "any": [
                leaf("district", "eq", json!("Cầu Giấy"), "fail"),
                leaf("district", "eq", json!("Đống Đa"), "fail"),
            ]},
            { "not": leaf("note", "contains", json!("ở ghép"), "fail") },
        ]}),
        "condition",
    )
    .expect("condition")
}

fn policy(condition: Option<FilterExpr>, hard_filters: Vec<HardFilter>) -> MatchPolicy {
    MatchPolicy {
        want_intent: WantIntent::Demand,
        exclude_roles: vec![AuthorRole::Peer],
        hard_filters,
        condition,
    }
}

fn draft_input(src_id: &str, match_policy: MatchPolicy) -> CreateRadarDraftInput {
    CreateRadarDraftInput {
        name: "Khách thuê nhóm điều kiện".to_string(),
        template_id: None,
        description: "Tìm khách cần thuê căn hộ".to_string(),
        language_hint: Some("vi".to_string()),
        user_profession: Some("Môi giới cho thuê".to_string()),
        fields: vec![
            number_field("budget"),
            text_field("district"),
            text_field("note"),
        ],
        match_policy,
        source_ids: vec![src_id.to_string()],
        notify: None,
    }
}

fn raw_post(post_id: &str, text: &str, now: i64) -> RawPost {
    RawPost {
        platform: "facebook".to_string(),
        source_external_id: "grp_cond".to_string(),
        post_id: post_id.to_string(),
        permalink: format!("https://www.facebook.com/groups/grp_cond/posts/{post_id}"),
        author: AuthorInfo {
            name: format!("Người đăng {post_id}"),
            external_id: Some(format!("uid_{post_id}")),
            is_anonymous: false,
        },
        text: text.to_string(),
        text_truncated: false,
        attachments: Vec::new(),
        created_at: Some(now - 60_000),
        captured_at: now - 1_000,
        counts: None,
        extraction: ExtractionInfo {
            strategy: ExtractionStrategy::Network,
            profile_rev: 1,
        },
    }
}

fn extracted(value: Value, raw: &str) -> ExtractedField {
    ExtractedField {
        value,
        raw: raw.to_string(),
        confidence: 0.9,
        source: FieldSource::Ai,
    }
}

fn start_service(tmp: &tempfile::TempDir) -> CoreService {
    CoreServiceBuilder::new(Store::open_in_memory().expect("store"))
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service")
}

fn add_source(service: &CoreService, now: i64) -> String {
    service
        .store()
        .upsert_discovered_sources(
            &[DiscoveredSourceInput {
                platform: "facebook".to_string(),
                kind: "group".to_string(),
                external_id: "grp_cond".to_string(),
                name: "Thuê nhà Cầu Giấy".to_string(),
                url: "https://www.facebook.com/groups/grp_cond".to_string(),
                privacy: Some("public".to_string()),
                member_count: None,
            }],
            Some(true),
            None,
            now,
        )
        .expect("source");
    service.source_list().expect("sources")[0].id.clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_conditions_are_rejected_with_specific_errors_on_every_entry_point() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let now = now_ms();
    let src_id = add_source(&service, now);

    // Unknown field deep in the tree is named with its path.
    let bad_field = FilterExpr::from_value(
        &json!({ "any": [
            leaf("budget", "lte", json!(15), "pass"),
            { "not": leaf("distict", "eq", json!("Cầu Giấy"), "pass") },
        ]}),
        "condition",
    )
    .unwrap();
    let err = service
        .radar_create_draft(draft_input(
            &src_id,
            policy(Some(bad_field.clone()), vec![]),
        ))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("condition.any[1].not") && err.contains("`distict`"),
        "{err}"
    );

    // Empty group and malformed value are rejected too.
    let empty = FilterExpr::Any(vec![]);
    let err = service
        .radar_create_draft(draft_input(&src_id, policy(Some(empty), vec![])))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("`any`") && err.contains("không có điều kiện"),
        "{err}"
    );
    let bad_value =
        FilterExpr::from_value(&leaf("budget", "between", json!([1]), "pass"), "condition")
            .unwrap();
    let err = service
        .radar_create_draft(draft_input(&src_id, policy(Some(bad_value), vec![])))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("`budget`") && err.contains("`between`"),
        "{err}"
    );

    // Legacy hard_filters referencing an unknown field are rejected as well.
    let legacy_bad = vec![HardFilter {
        field: "ghost".to_string(),
        op: dealsonar_core::dto::FilterOperator::Eq,
        value: json!(1),
        when_missing: WhenMissing::Pass,
    }];
    let err = service
        .radar_create_draft(draft_input(&src_id, policy(None, legacy_bad)))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("hard_filters[0]") && err.contains("`ghost`"),
        "{err}"
    );

    // Update and preview apply the same validation to an existing radar.
    let ok = service
        .radar_create_draft(draft_input(&src_id, policy(Some(condition()), vec![])))
        .expect("valid condition is saved");
    assert_eq!(
        ok.current_version_data.match_policy.condition,
        Some(condition())
    );
    let rid = ok.radar.id.clone();
    let err = service
        .radar_update(UpdateRadarInput {
            id: rid.clone(),
            match_policy: Some(policy(Some(bad_field.clone()), vec![])),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(err.contains("`distict`"), "{err}");
    let err = service
        .radar_preview_start(PreviewStartInput {
            radar_id: rid.clone(),
            description: None,
            user_profession: None,
            fields: None,
            match_policy: Some(policy(Some(bad_field), vec![])),
            source_ids: None,
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("`distict`"), "{err}");

    // The stored radar still has the valid condition and reads back identically.
    let reread = service.radar_get(&rid).expect("get");
    assert_eq!(
        reread.current_version_data.match_policy.condition,
        Some(condition())
    );

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_radar_without_condition_reads_back_unchanged() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let now = now_ms();
    let src_id = add_source(&service, now);
    let legacy = vec![HardFilter {
        field: "budget".to_string(),
        op: dealsonar_core::dto::FilterOperator::Lte,
        value: json!(15),
        when_missing: WhenMissing::Fail,
    }];
    let created = service
        .radar_create_draft(draft_input(&src_id, policy(None, legacy.clone())))
        .expect("legacy policy");
    assert_eq!(
        created.current_version_data.match_policy.hard_filters,
        legacy
    );
    assert_eq!(created.current_version_data.match_policy.condition, None);

    // Stored JSON has no `condition` key and a pre-feature row (no key at all) deserializes.
    let stored = serde_json::to_value(
        &service
            .store()
            .radar_get(&created.radar.id)
            .unwrap()
            .unwrap()
            .current_version
            .match_policy,
    )
    .unwrap();
    assert!(stored.get("condition").is_none());
    let old_json = json!({
        "want_intent": "demand",
        "exclude_roles": ["peer"],
        "hard_filters": [leaf("budget", "lte", json!(15), "fail")],
    });
    let old: MatchPolicy = serde_json::from_value(old_json).expect("old policy");
    assert_eq!(old.condition, None);
    assert_eq!(old.hard_filters, legacy);

    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_and_live_pipeline_decide_identically_on_the_same_extraction() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let service = start_service(&tmp);
    let now = now_ms();
    let src_id = add_source(&service, now);
    let source = service.store().source_get(&src_id).unwrap().unwrap();
    let legacy_and = vec![HardFilter {
        field: "budget".to_string(),
        op: dealsonar_core::dto::FilterOperator::Gte,
        value: json!(1),
        when_missing: WhenMissing::Pass,
    }];
    let created = service
        .radar_create_draft(draft_input(&src_id, policy(Some(condition()), legacy_and)))
        .expect("draft");
    let rw = service
        .store()
        .radar_get(&created.radar.id)
        .unwrap()
        .unwrap();
    let version = rw.current_version.clone();

    // (post id, text, extracted fields, expected to pass the filters)
    type Case<'a> = (&'a str, &'a str, Vec<(&'a str, Value, &'a str)>, bool);
    let cases: Vec<Case> = vec![
        (
            "branch_cau_giay",
            "Cần thuê căn hộ Cầu Giấy ngân sách 12 triệu",
            vec![
                ("budget", json!(12), "12 triệu"),
                ("district", json!("Cầu Giấy"), "Cầu Giấy"),
            ],
            true,
        ),
        (
            "branch_dong_da",
            "Cần thuê căn hộ Đống Đa ngân sách 9 triệu",
            vec![
                ("budget", json!(9), "9 triệu"),
                ("district", json!("Đống Đa"), "Đống Đa"),
            ],
            true,
        ),
        (
            "excluded_by_exception",
            "Cần thuê căn hộ Cầu Giấy ngân sách 10 triệu, ở ghép được",
            vec![
                ("budget", json!(10), "10 triệu"),
                ("district", json!("Cầu Giấy"), "Cầu Giấy"),
                ("note", json!("ở ghép được"), "ở ghép được"),
            ],
            false,
        ),
        (
            "wrong_district",
            "Cần thuê căn hộ Hà Đông ngân sách 8 triệu",
            vec![
                ("budget", json!(8), "8 triệu"),
                ("district", json!("Hà Đông"), "Hà Đông"),
            ],
            false,
        ),
        (
            "missing_district",
            "Cần thuê căn hộ ngân sách 8 triệu",
            vec![("budget", json!(8), "8 triệu")],
            false,
        ),
    ];

    for (idx, (post_id, text, fields, expect_pass)) in cases.iter().enumerate() {
        let outcome = ingest_raw_post(
            service.runtime(),
            &source,
            &raw_post(post_id, text, now),
            now + idx as i64,
        )
        .expect("ingest");
        let IngestPostOutcome::Processed(post) = outcome else {
            panic!("post {post_id} should be stored");
        };
        let candidate: BTreeMap<String, ExtractedField> = fields
            .iter()
            .map(|(k, v, raw)| (k.to_string(), extracted(v.clone(), raw)))
            .collect();

        let mut decisions = Vec::new();
        for mode in [
            EvalMode::Preview,
            EvalMode::Live {
                repost_after_72h: false,
            },
        ] {
            let placeholder = service
                .store()
                .upsert_evaluation(&EvaluationUpsertInput {
                    id: None,
                    post_id: post.id.clone(),
                    radar_version_id: version.id.clone(),
                    state: "pending_ai".to_string(),
                    decided_by: Some("ai".to_string()),
                    verdict: None,
                    reject_reason: None,
                    score: None,
                    intent: None,
                    author_role: None,
                    summary: None,
                    reason: None,
                    fields: None,
                    ruleset_id: None,
                    ai_call_id: None,
                    is_preview: mode.is_preview(),
                    created_at: now,
                    decided_at: None,
                })
                .expect("placeholder");
            let finalized = finalize_candidate_evaluation(
                service.runtime(),
                &placeholder.id,
                &post,
                text,
                &rw.radar.id,
                &rw.radar.name,
                &rw.radar.status,
                &rw.radar.notify,
                &version,
                CandidateDecision {
                    decided_by: "ai",
                    ruleset_id: None,
                    ai_call_id: None,
                    is_match: true,
                    raw_score: 0.9,
                    intent: PostIntent::Demand,
                    author_role: AuthorRole::EndUser,
                    is_spam: false,
                    summary: "khách thuê".to_string(),
                    reason: "khớp".to_string(),
                    candidate_fields: candidate.clone(),
                },
                mode,
                now,
            )
            .expect("finalize");
            decisions.push((finalized.verdict.clone(), finalized.reject_reason.clone()));
        }

        assert_eq!(
            decisions[0], decisions[1],
            "{post_id}: preview and live must agree"
        );
        let rejected_by_filter = decisions[0].1.as_deref() == Some("hard_filter");
        assert_eq!(
            !rejected_by_filter, *expect_pass,
            "{post_id}: unexpected filter decision {:?}",
            decisions[0]
        );
    }

    service.shutdown().await.expect("shutdown");
}
