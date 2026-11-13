//! SQL builder for dynamic extracted-field filters and sort expressions.

use super::*;

pub(super) fn extract_f64(
    val: &serde_json::Value,
    field: &str,
    op: FilterOp,
) -> Result<f64, StoreError> {
    val.as_f64()
        .or_else(|| val.as_str().and_then(|s| s.parse::<f64>().ok()))
        .ok_or_else(|| StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected numeric value".to_string(),
        })
}

pub(super) fn extract_str(
    val: &serde_json::Value,
    field: &str,
    op: FilterOp,
) -> Result<String, StoreError> {
    match val {
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        _ => Err(StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected string/scalar value".to_string(),
        }),
    }
}

pub(super) fn extract_between_f64(
    val: &serde_json::Value,
    field: &str,
) -> Result<(f64, f64), StoreError> {
    if let Some(arr) = val.as_array() {
        if arr.len() == 2 {
            let lo = extract_f64(&arr[0], field, FilterOp::Between)?;
            let hi = extract_f64(&arr[1], field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    if let Some(obj) = val.as_object() {
        if let (Some(lo_v), Some(hi_v)) = (obj.get("min"), obj.get("max")) {
            let lo = extract_f64(lo_v, field, FilterOp::Between)?;
            let hi = extract_f64(hi_v, field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    Err(StoreError::InvalidFilterValue {
        field: field.to_string(),
        op: "Between".to_string(),
        message: "expected [min, max] array or {min, max} object".to_string(),
    })
}

pub(super) fn extract_between_str(
    val: &serde_json::Value,
    field: &str,
) -> Result<(String, String), StoreError> {
    if let Some(arr) = val.as_array() {
        if arr.len() == 2 {
            let lo = extract_str(&arr[0], field, FilterOp::Between)?;
            let hi = extract_str(&arr[1], field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    if let Some(obj) = val.as_object() {
        if let (Some(lo_v), Some(hi_v)) = (obj.get("min"), obj.get("max")) {
            let lo = extract_str(lo_v, field, FilterOp::Between)?;
            let hi = extract_str(hi_v, field, FilterOp::Between)?;
            return Ok((lo, hi));
        }
    }
    Err(StoreError::InvalidFilterValue {
        field: field.to_string(),
        op: "Between".to_string(),
        message: "expected [low, high] array or {min, max} object".to_string(),
    })
}

pub(super) fn is_empty_expected(val: &serde_json::Value) -> bool {
    match val {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Null => true,
        _ => true,
    }
}

pub(super) fn build_dynamic_sort_expr(fdef: &FieldDef, params: &mut Vec<SqlValue>) -> String {
    let key = &fdef.key;
    match fdef.r#type {
        FieldType::Money | FieldType::Range => {
            let p_min = push_param(params, SqlValue::Text(format!("$.{key}.value.min")));
            let p_amt = push_param(params, SqlValue::Text(format!("$.{key}.value.amount")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!(
                "CAST(COALESCE(json_extract(l.fields, {p_min}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END) AS REAL)"
            )
        }
        FieldType::Number => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!("CAST(json_extract(l.fields, {p_val}) AS REAL)")
        }
        FieldType::Location => {
            let p_dist = push_param(params, SqlValue::Text(format!("$.{key}.value.district")));
            let p_prov = push_param(params, SqlValue::Text(format!("$.{key}.value.province")));
            let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.value.raw")));
            format!(
                "COALESCE(json_extract(l.fields, {p_dist}), json_extract(l.fields, {p_prov}), json_extract(l.fields, {p_raw}))"
            )
        }
        _ => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            format!("json_extract(l.fields, {p_val})")
        }
    }
}

pub(super) fn build_dynamic_filter_clause(
    fdef: &FieldDef,
    filter: &LeadFieldFilter,
    params: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    let key = &fdef.key;
    let op = filter.op;

    match fdef.r#type {
        FieldType::Money | FieldType::Range => {
            let p_min = push_param(params, SqlValue::Text(format!("$.{key}.value.min")));
            let p_max = push_param(params, SqlValue::Text(format!("$.{key}.value.max")));
            let p_amt = push_param(params, SqlValue::Text(format!("$.{key}.value.amount")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));

            let min_expr = format!(
                "COALESCE(json_extract(l.fields, {p_min}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END)"
            );
            let max_expr = format!(
                "COALESCE(json_extract(l.fields, {p_max}), json_extract(l.fields, {p_amt}), \
                 CASE WHEN json_type(l.fields, {p_val}) IN ('integer', 'real') THEN json_extract(l.fields, {p_val}) END)"
            );

            match op {
                FilterOp::Lte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({max_expr} AS REAL) <= {px}"))
                }
                FilterOp::Lt => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({max_expr} AS REAL) < {px}"))
                }
                FilterOp::Gte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({min_expr} AS REAL) >= {px}"))
                }
                FilterOp::Gt => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("CAST({min_expr} AS REAL) > {px}"))
                }
                FilterOp::Eq => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px1 = push_param(params, SqlValue::Real(x));
                    let px2 = push_param(params, SqlValue::Real(x));
                    Ok(format!(
                        "(CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2})"
                    ))
                }
                FilterOp::Ne => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px1 = push_param(params, SqlValue::Real(x));
                    let px2 = push_param(params, SqlValue::Real(x));
                    Ok(format!(
                        "({min_expr} IS NOT NULL AND NOT (CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2}))"
                    ))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_f64(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Real(lo));
                    let phi = push_param(params, SqlValue::Real(hi));
                    Ok(format!(
                        "(CAST({min_expr} AS REAL) >= {plo} AND CAST({max_expr} AS REAL) <= {phi})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of numbers".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut disj = Vec::with_capacity(arr.len());
                    for item in arr {
                        let x = extract_f64(item, key, op)?;
                        let px1 = push_param(params, SqlValue::Real(x));
                        let px2 = push_param(params, SqlValue::Real(x));
                        disj.push(format!(
                            "(CAST({min_expr} AS REAL) <= {px1} AND CAST({max_expr} AS REAL) >= {px2})"
                        ));
                    }
                    Ok(format!("({})", disj.join(" OR ")))
                }
                FilterOp::Contains => {
                    let needle = extract_str(&filter.value, key, op)?;
                    let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.raw")));
                    let pn = push_param(params, SqlValue::Text(needle));
                    Ok(format!(
                        "dealsonar_fold_contains(COALESCE(json_extract(l.fields, {p_raw}), CAST(json_extract(l.fields, {p_val}) AS TEXT)), {pn}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("({min_expr} IS NULL AND {max_expr} IS NULL)"))
                    } else {
                        Ok(format!(
                            "({min_expr} IS NOT NULL OR {max_expr} IS NOT NULL)"
                        ))
                    }
                }
            }
        }

        FieldType::Location => {
            let p_prov = push_param(params, SqlValue::Text(format!("$.{key}.value.province")));
            let p_dist = push_param(params, SqlValue::Text(format!("$.{key}.value.district")));
            let p_ward = push_param(params, SqlValue::Text(format!("$.{key}.value.ward")));
            let p_raw = push_param(params, SqlValue::Text(format!("$.{key}.value.raw")));
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));

            let prov = format!("json_extract(l.fields, {p_prov})");
            let dist = format!("json_extract(l.fields, {p_dist})");
            let ward = format!("json_extract(l.fields, {p_ward})");
            let raw = format!("json_extract(l.fields, {p_raw})");
            let scalar = format!(
                "(CASE WHEN json_type(l.fields, {p_val}) = 'text' THEN json_extract(l.fields, {p_val}) END)"
            );

            match op {
                FilterOp::Eq => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "({prov} = {ps} OR {dist} = {ps} OR {ward} = {ps} OR {raw} = {ps} OR {scalar} = {ps})"
                    ))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_extract(l.fields, {p_val}) IS NOT NULL \
                          AND COALESCE({prov}, '') != {ps} \
                          AND COALESCE({dist}, '') != {ps} \
                          AND COALESCE({ward}, '') != {ps} \
                          AND COALESCE({raw}, '') != {ps} \
                          AND COALESCE({scalar}, '') != {ps})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of location strings".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    let list = ph.join(", ");
                    Ok(format!(
                        "({prov} IN ({list}) OR {dist} IN ({list}) OR {ward} IN ({list}) OR {raw} IN ({list}) OR {scalar} IN ({list}))"
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(\
                           COALESCE({prov}, '') || ' ' || COALESCE({dist}, '') || ' ' || \
                           COALESCE({ward}, '') || ' ' || COALESCE({raw}, '') || ' ' || COALESCE({scalar}, ''), \
                           {ps}\
                         ) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NULL \
                              OR ({prov} IS NULL AND {dist} IS NULL AND {ward} IS NULL AND {raw} IS NULL AND {scalar} IS NULL))"
                        ))
                    } else {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NOT NULL \
                              AND ({prov} IS NOT NULL OR {dist} IS NOT NULL OR {ward} IS NOT NULL OR {raw} IS NOT NULL OR {scalar} IS NOT NULL))"
                        ))
                    }
                }
                FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!(
                        "COALESCE({dist}, {prov}, {raw}, {scalar}) {sql_op} {ps}"
                    ))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_str(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Text(lo));
                    let phi = push_param(params, SqlValue::Text(hi));
                    Ok(format!(
                        "COALESCE({dist}, {prov}, {raw}, {scalar}) BETWEEN {plo} AND {phi}"
                    ))
                }
            }
        }

        FieldType::MultiEnum => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            match op {
                FilterOp::Eq => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value = {ps}\
                         ))"
                    ))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND NOT EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value = {ps}\
                         ))"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of strings".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je WHERE je.value IN ({})\
                         ))",
                        ph.join(", ")
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "(json_type(l.fields, {p_val}) = 'array' AND EXISTS (\
                           SELECT 1 FROM json_each(json_extract(l.fields, {p_val})) je \
                           WHERE dealsonar_fold_contains(CAST(je.value AS TEXT), {ps}) = 1\
                         ))"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!(
                            "(json_extract(l.fields, {p_val}) IS NULL \
                              OR (json_type(l.fields, {p_val}) = 'array' AND json_array_length(json_extract(l.fields, {p_val})) = 0))"
                        ))
                    } else {
                        Ok(format!(
                            "(json_type(l.fields, {p_val}) = 'array' AND json_array_length(json_extract(l.fields, {p_val})) > 0)"
                        ))
                    }
                }
                _ => Err(StoreError::InvalidFilterValue {
                    field: key.clone(),
                    op: format!("{op:?}"),
                    message: "unsupported operator for multi_enum field".to_string(),
                }),
            }
        }

        FieldType::Number => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");
            let num_expr = format!("CAST({val_expr} AS REAL)");

            match op {
                FilterOp::Eq | FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} {sql_op} {px})"
                    ))
                }
                FilterOp::Ne => {
                    let x = extract_f64(&filter.value, key, op)?;
                    let px = push_param(params, SqlValue::Real(x));
                    Ok(format!("({val_expr} IS NOT NULL AND {num_expr} != {px})"))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_f64(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Real(lo));
                    let phi = push_param(params, SqlValue::Real(hi));
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} BETWEEN {plo} AND {phi})"
                    ))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of numbers".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let x = extract_f64(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Real(x)));
                    }
                    Ok(format!(
                        "({val_expr} IS NOT NULL AND {num_expr} IN ({}))",
                        ph.join(", ")
                    ))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(CAST({val_expr} AS TEXT), {ps}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("{val_expr} IS NULL"))
                    } else {
                        Ok(format!("{val_expr} IS NOT NULL"))
                    }
                }
            }
        }

        FieldType::Boolean => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");

            match op {
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("{val_expr} IS NULL"))
                    } else {
                        Ok(format!("{val_expr} IS NOT NULL"))
                    }
                }
                FilterOp::Eq | FilterOp::Ne => {
                    let b = parse_bool_filter(&filter.value, key, op)?;
                    let pb = push_param(params, SqlValue::Integer(i64::from(b)));
                    if op == FilterOp::Eq {
                        Ok(format!("{val_expr} = {pb}"))
                    } else {
                        Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != {pb})"))
                    }
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of booleans".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let b = parse_bool_filter(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Integer(i64::from(b))));
                    }
                    Ok(format!("{val_expr} IN ({})", ph.join(", ")))
                }
                _ => Err(StoreError::InvalidFilterValue {
                    field: key.clone(),
                    op: format!("{op:?}"),
                    message: "unsupported operator for boolean field".to_string(),
                }),
            }
        }

        FieldType::Text | FieldType::Phone | FieldType::Enum | FieldType::Date | FieldType::Url => {
            let p_val = push_param(params, SqlValue::Text(format!("$.{key}.value")));
            let val_expr = format!("json_extract(l.fields, {p_val})");

            match op {
                FilterOp::Eq | FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    let sql_op = cmp_op_sql(op);
                    Ok(format!("{val_expr} {sql_op} {ps}"))
                }
                FilterOp::Ne => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != {ps})"))
                }
                FilterOp::Between => {
                    let (lo, hi) = extract_between_str(&filter.value, key)?;
                    let plo = push_param(params, SqlValue::Text(lo));
                    let phi = push_param(params, SqlValue::Text(hi));
                    Ok(format!("{val_expr} BETWEEN {plo} AND {phi}"))
                }
                FilterOp::In => {
                    let arr =
                        filter
                            .value
                            .as_array()
                            .ok_or_else(|| StoreError::InvalidFilterValue {
                                field: key.clone(),
                                op: "In".to_string(),
                                message: "expected array of scalar values".to_string(),
                            })?;
                    if arr.is_empty() {
                        return Ok("0 = 1".to_string());
                    }
                    let mut ph = Vec::with_capacity(arr.len());
                    for item in arr {
                        let s = extract_str(item, key, op)?;
                        ph.push(push_param(params, SqlValue::Text(s)));
                    }
                    Ok(format!("{val_expr} IN ({})", ph.join(", ")))
                }
                FilterOp::Contains => {
                    let s = extract_str(&filter.value, key, op)?;
                    let ps = push_param(params, SqlValue::Text(s));
                    Ok(format!(
                        "dealsonar_fold_contains(CAST({val_expr} AS TEXT), {ps}) = 1"
                    ))
                }
                FilterOp::IsEmpty => {
                    if is_empty_expected(&filter.value) {
                        Ok(format!("({val_expr} IS NULL OR {val_expr} = '')"))
                    } else {
                        Ok(format!("({val_expr} IS NOT NULL AND {val_expr} != '')"))
                    }
                }
            }
        }
    }
}

pub(super) fn cmp_op_sql(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "=",
        FilterOp::Ne => "!=",
        FilterOp::Lt => "<",
        FilterOp::Lte => "<=",
        FilterOp::Gt => ">",
        FilterOp::Gte => ">=",
        _ => "=",
    }
}

pub(super) fn parse_bool_filter(
    val: &serde_json::Value,
    field: &str,
    op: FilterOp,
) -> Result<bool, StoreError> {
    match val {
        serde_json::Value::Bool(b) => Ok(*b),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(StoreError::InvalidFilterValue {
                field: field.to_string(),
                op: format!("{op:?}"),
                message: "expected boolean".to_string(),
            }),
        },
        serde_json::Value::String(s) => match s.as_str() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(StoreError::InvalidFilterValue {
                field: field.to_string(),
                op: format!("{op:?}"),
                message: "expected boolean".to_string(),
            }),
        },
        _ => Err(StoreError::InvalidFilterValue {
            field: field.to_string(),
            op: format!("{op:?}"),
            message: "expected boolean".to_string(),
        }),
    }
}
