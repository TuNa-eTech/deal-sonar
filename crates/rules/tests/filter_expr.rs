//! `all` / `any` / `not` filter expressions: parsing, validation, and evaluation semantics.

use std::collections::BTreeMap;

use dealsonar_rules::*;
use serde_json::{json, Value};

fn field(key: &str, ty: FieldType) -> FieldDef {
    FieldDef {
        key: key.to_string(),
        label: key.to_string(),
        r#type: ty,
        description: String::new(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 0,
    }
}

fn fields() -> Vec<FieldDef> {
    vec![
        field("price", FieldType::Money),
        field("district", FieldType::Text),
        field("role", FieldType::Text),
    ]
}

fn post(entries: &[(&str, Value)]) -> ExtractedFields {
    entries
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                ExtractedField {
                    value: v.clone(),
                    raw: String::new(),
                    confidence: 0.9,
                    source: FieldSource::Ai,
                },
            )
        })
        .collect::<BTreeMap<_, _>>()
}

fn parse(v: Value) -> FilterExpr {
    FilterExpr::from_value(&v, "condition").expect("valid expression")
}

fn leaf(field: &str, op: &str, value: Value, when_missing: &str) -> Value {
    json!({ "field": field, "op": op, "value": value, "when_missing": when_missing })
}

/// price <= 5tr AND (district = Cầu Giấy OR district = Đống Đa) AND NOT (role = môi giới)
fn sample_condition() -> FilterExpr {
    parse(json!({ "all": [
        leaf("price", "lte", json!(5_000_000), "fail"),
        { "any": [
            leaf("district", "eq", json!("Cầu Giấy"), "fail"),
            leaf("district", "eq", json!("Đống Đa"), "fail"),
        ]},
        { "not": leaf("role", "eq", json!("môi giới"), "fail") },
    ]}))
}

#[test]
fn each_any_branch_passes_and_exception_rejects() {
    let expr = sample_condition();
    let cau_giay = post(&[("price", json!(4_000_000)), ("district", json!("Cầu Giấy"))]);
    let dong_da = post(&[("price", json!(4_000_000)), ("district", json!("Đống Đa"))]);
    let other = post(&[("price", json!(4_000_000)), ("district", json!("Hà Đông"))]);
    let broker = post(&[
        ("price", json!(4_000_000)),
        ("district", json!("Cầu Giấy")),
        ("role", json!("môi giới")),
    ]);
    let too_pricey = post(&[("price", json!(9_000_000)), ("district", json!("Cầu Giấy"))]);

    assert!(evaluate_filter_expr(&expr, &cau_giay), "first branch");
    assert!(evaluate_filter_expr(&expr, &dong_da), "second branch");
    assert!(!evaluate_filter_expr(&expr, &other), "no branch matches");
    assert!(!evaluate_filter_expr(&expr, &broker), "exception excludes");
    assert!(
        !evaluate_filter_expr(&expr, &too_pricey),
        "all requires price"
    );
}

#[test]
fn missing_field_follows_each_leafs_own_policy() {
    let expr = sample_condition();
    // `role` missing: leaf is `fail` (false) so `not` keeps the post.
    let no_role = post(&[("price", json!(4_000_000)), ("district", json!("Cầu Giấy"))]);
    assert!(evaluate_filter_expr(&expr, &no_role));
    // `district` missing: both branch leaves are `fail`, so `any` rejects.
    let no_district = post(&[("price", json!(4_000_000))]);
    assert!(!evaluate_filter_expr(&expr, &no_district));
    // `price` missing with `fail` rejects.
    let no_price = post(&[("district", json!("Cầu Giấy"))]);
    assert!(!evaluate_filter_expr(&expr, &no_price));

    // Same missing `price`, but the leaf says `pass`: the condition no longer blocks.
    let lenient = parse(json!({ "all": [
        leaf("price", "lte", json!(5_000_000), "pass"),
        leaf("district", "eq", json!("Cầu Giấy"), "fail"),
    ]}));
    assert!(evaluate_filter_expr(&lenient, &no_price));
    // `not` flips the leaf result, so a `pass` leaf under `not` excludes posts missing the field.
    let negated_pass = parse(json!({ "not": leaf("role", "eq", json!("môi giới"), "pass") }));
    assert!(!evaluate_filter_expr(&negated_pass, &post(&[])));
}

#[test]
fn legacy_list_and_condition_are_anded_and_legacy_alone_is_unchanged() {
    let legacy = vec![
        serde_json::from_value::<HardFilter>(leaf("price", "lte", json!(5_000_000), "fail"))
            .unwrap(),
        serde_json::from_value::<HardFilter>(leaf("district", "eq", json!("Cầu Giấy"), "pass"))
            .unwrap(),
    ];
    let samples = [
        post(&[("price", json!(4_000_000)), ("district", json!("Cầu Giấy"))]),
        post(&[("price", json!(4_000_000))]),
        post(&[("price", json!(9_000_000)), ("district", json!("Cầu Giấy"))]),
        post(&[("district", json!("Cầu Giấy"))]),
        post(&[("price", json!(4_000_000)), ("district", json!("Hà Đông"))]),
    ];
    for fields in &samples {
        assert_eq!(
            evaluate_match_filters(&legacy, None, fields),
            evaluate_hard_filters(&legacy, fields),
            "no condition == legacy AND list"
        );
    }
    // The same list written as an explicit `all` gives identical decisions.
    let as_all = FilterExpr::All(legacy.iter().cloned().map(FilterExpr::Filter).collect());
    for fields in &samples {
        assert_eq!(
            evaluate_filter_expr(&as_all, fields),
            evaluate_hard_filters(&legacy, fields)
        );
    }
    // Legacy filters still apply when a condition is present.
    let cond = parse(leaf("role", "eq", json!("chính chủ"), "pass"));
    let hay = post(&[("price", json!(9_000_000)), ("district", json!("Cầu Giấy"))]);
    assert!(!evaluate_match_filters(&legacy, Some(&cond), &hay));
}

#[test]
fn json_round_trip_and_legacy_leaf_shape() {
    let expr = sample_condition();
    let encoded = serde_json::to_value(&expr).unwrap();
    assert_eq!(encoded["all"][1]["any"][0]["field"], "district");
    assert_eq!(encoded["all"][2]["not"]["field"], "role");
    let decoded: FilterExpr = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded, expr);

    // A bare legacy hard filter object is a valid expression.
    let bare = parse(leaf("price", "lte", json!(1), "pass"));
    assert!(matches!(bare, FilterExpr::Filter(_)));
}

#[test]
fn malformed_shapes_report_the_path() {
    let err = |v: Value| {
        FilterExpr::from_value(&v, "condition")
            .unwrap_err()
            .to_string()
    };

    let msg = err(json!({ "all": [ leaf("price", "lte", json!(1), "pass"), { "any": "x" } ] }));
    assert!(
        msg.contains("condition.all[1]") && msg.contains("`any`"),
        "{msg}"
    );

    let msg = err(json!({ "all": [], "any": [] }));
    assert!(msg.contains("chỉ được dùng một"), "{msg}");

    let msg = err(json!({ "not": leaf("price", "lte", json!(1), "pass"), "extra": 1 }));
    assert!(msg.contains("không được kèm khóa khác"), "{msg}");

    // A typo such as `whenMissing` must not silently fall back to the default policy.
    let msg = err(json!({ "field": "price", "op": "lte", "value": 1, "whenMissing": "fail" }));
    assert!(msg.contains("whenMissing"), "{msg}");

    let msg = err(json!({ "field": "price", "op": "approx", "value": 1 }));
    assert!(msg.contains("condition"), "{msg}");

    let mut deep = leaf("price", "lte", json!(1), "pass");
    for _ in 0..MAX_FILTER_EXPR_DEPTH {
        deep = json!({ "not": deep });
    }
    assert!(err(deep).contains("lồng quá sâu"));
}

#[test]
fn validation_rejects_unknown_fields_empty_groups_and_bad_values() {
    let fs = fields();
    let check = |v: Value| validate_filter_expr(&parse(v), &fs, "condition");

    assert_eq!(check(sample_condition().to_value()), Ok(()));

    assert_eq!(
        check(
            json!({ "any": [ leaf("price", "lte", json!(1), "pass"), { "not": leaf("pirce", "eq", json!(1), "pass") } ] })
        ),
        Err(FilterExprError::UnknownField {
            path: "condition.any[1].not".to_string(),
            field: "pirce".to_string(),
        })
    );
    assert_eq!(
        check(json!({ "all": [ { "any": [] } ] })),
        Err(FilterExprError::EmptyGroup {
            path: "condition.all[0]".to_string(),
            kind: "any",
        })
    );
    for (op, value) in [
        ("in", json!("Cầu Giấy")),
        ("in", json!([])),
        ("between", json!([1])),
        ("lte", json!("rẻ")),
        ("contains", json!(5)),
        ("is_empty", json!("yes")),
        ("eq", Value::Null),
    ] {
        let got = check(leaf("price", op, value.clone(), "pass"));
        assert!(
            matches!(got, Err(FilterExprError::InvalidValue { .. })),
            "{op} {value} -> {got:?}"
        );
    }
    let msg = check(leaf("price", "lte", json!("rẻ"), "pass"))
        .unwrap_err()
        .to_string();
    assert!(msg.contains("`condition`") && msg.contains("`price`") && msg.contains("`lte`"));

    let mut wide = Vec::new();
    for _ in 0..MAX_FILTER_EXPR_NODES {
        wide.push(leaf("price", "lte", json!(1), "pass"));
    }
    assert_eq!(
        check(json!({ "all": wide })),
        Err(FilterExprError::TooManyNodes)
    );

    // Legacy list is validated with indexed paths.
    let legacy =
        vec![serde_json::from_value::<HardFilter>(leaf("nope", "eq", json!(1), "pass")).unwrap()];
    assert_eq!(
        validate_hard_filters(&legacy, &fs),
        Err(FilterExprError::UnknownField {
            path: "hard_filters[0]".to_string(),
            field: "nope".to_string(),
        })
    );
}
