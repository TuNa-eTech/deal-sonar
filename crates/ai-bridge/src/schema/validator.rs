//! Recursive JSON Schema validator (`06-ai-bridge.md §4`).

use super::*;

// ============================================================================
// Recursive JSON Schema Validator (`06-ai-bridge.md §4`)
// ============================================================================

/// Validates `instance` against JSON Schema `schema`, returning `Ok(())` or a
/// descriptive error path string.
pub fn validate_json_schema(schema: &Value, instance: &Value) -> Result<(), String> {
    validate_at_path(schema, instance, "$")
}

pub(super) fn validate_at_path(schema: &Value, instance: &Value, path: &str) -> Result<(), String> {
    if let Some(b) = schema.as_bool() {
        return if b {
            Ok(())
        } else {
            Err(format!("{path}: schema is false (no value allowed)"))
        };
    }

    let Some(schema_obj) = schema.as_object() else {
        return Err(format!(
            "{path}: invalid schema (expected object or boolean)"
        ));
    };

    // Combinators: allOf, anyOf, oneOf
    if let Some(all_of) = schema_obj.get("allOf").and_then(Value::as_array) {
        for sub in all_of {
            validate_at_path(sub, instance, path)?;
        }
    }

    if let Some(any_of) = schema_obj.get("anyOf").and_then(Value::as_array) {
        let mut last_err = None;
        let mut matched = false;
        for sub in any_of {
            match validate_at_path(sub, instance, path) {
                Ok(()) => {
                    matched = true;
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        if !matched {
            return Err(format!(
                "{path}: did not match anyOf schema ({})",
                last_err.unwrap_or_else(|| "empty anyOf".to_string())
            ));
        }
    }

    if let Some(one_of) = schema_obj.get("oneOf").and_then(Value::as_array) {
        let mut matches = 0usize;
        let mut last_err = None;
        for sub in one_of {
            match validate_at_path(sub, instance, path) {
                Ok(()) => matches += 1,
                Err(e) => last_err = Some(e),
            }
        }
        if matches != 1 {
            return Err(format!(
                "{path}: expected exactly 1 match in oneOf, got {matches} ({})",
                last_err.unwrap_or_default()
            ));
        }
    }

    // `const`
    if let Some(const_val) = schema_obj.get("const") {
        if instance != const_val {
            return Err(format!(
                "{path}: expected const {const_val}, got {instance}"
            ));
        }
    }

    // `enum`
    if let Some(enum_vals) = schema_obj.get("enum").and_then(Value::as_array) {
        if !enum_vals.contains(instance) {
            return Err(format!(
                "{path}: value {instance} is not in allowed enum {enum_vals:?}"
            ));
        }
    }

    // `type` (single string or union array)
    if let Some(type_spec) = schema_obj.get("type") {
        let type_ok = match type_spec {
            Value::String(t) => matches_json_type(t, instance),
            Value::Array(arr) => arr
                .iter()
                .filter_map(Value::as_str)
                .any(|t| matches_json_type(t, instance)),
            _ => false,
        };
        if !type_ok {
            return Err(format!(
                "{path}: expected type {type_spec}, got {}",
                json_type_name(instance)
            ));
        }
    }

    // Type-specific constraints
    match instance {
        Value::Object(map) => {
            if let Some(min_p) = schema_obj.get("minProperties").and_then(Value::as_u64) {
                if (map.len() as u64) < min_p {
                    return Err(format!(
                        "{path}: object has {} properties, minProperties is {min_p}",
                        map.len()
                    ));
                }
            }
            if let Some(max_p) = schema_obj.get("maxProperties").and_then(Value::as_u64) {
                if (map.len() as u64) > max_p {
                    return Err(format!(
                        "{path}: object has {} properties, maxProperties is {max_p}",
                        map.len()
                    ));
                }
            }

            if let Some(req_arr) = schema_obj.get("required").and_then(Value::as_array) {
                for req_key in req_arr.iter().filter_map(Value::as_str) {
                    if !map.contains_key(req_key) {
                        return Err(format!("{path}: missing required property '{req_key}'"));
                    }
                }
            }

            let props = schema_obj.get("properties").and_then(Value::as_object);
            if let Some(props_map) = props {
                for (k, prop_schema) in props_map {
                    if let Some(prop_val) = map.get(k) {
                        let child_path = format!("{path}.{k}");
                        validate_at_path(prop_schema, prop_val, &child_path)?;
                    }
                }
            }

            if let Some(addl) = schema_obj.get("additionalProperties") {
                for (k, v) in map {
                    let known = props.is_some_and(|p| p.contains_key(k));
                    if !known {
                        match addl {
                            Value::Bool(false) => {
                                return Err(format!(
                                    "{path}: unexpected additional property '{k}'"
                                ));
                            }
                            Value::Bool(true) => {}
                            other_schema => {
                                let child_path = format!("{path}.{k}");
                                validate_at_path(other_schema, v, &child_path)?;
                            }
                        }
                    }
                }
            }
        }
        Value::Array(items) => {
            if let Some(min_items) = schema_obj.get("minItems").and_then(Value::as_u64) {
                if (items.len() as u64) < min_items {
                    return Err(format!(
                        "{path}: array length {} is less than minItems {min_items}",
                        items.len()
                    ));
                }
            }
            if let Some(max_items) = schema_obj.get("maxItems").and_then(Value::as_u64) {
                if (items.len() as u64) > max_items {
                    return Err(format!(
                        "{path}: array length {} exceeds maxItems {max_items}",
                        items.len()
                    ));
                }
            }
            if let Some(item_schema) = schema_obj.get("items") {
                for (idx, elem) in items.iter().enumerate() {
                    let child_path = format!("{path}[{idx}]");
                    validate_at_path(item_schema, elem, &child_path)?;
                }
            }
        }
        Value::String(s) => {
            let char_len = s.chars().count() as u64;
            if let Some(min_len) = schema_obj.get("minLength").and_then(Value::as_u64) {
                if char_len < min_len {
                    return Err(format!(
                        "{path}: string length {char_len} is less than minLength {min_len}"
                    ));
                }
            }
            if let Some(max_len) = schema_obj.get("maxLength").and_then(Value::as_u64) {
                if char_len > max_len {
                    return Err(format!(
                        "{path}: string length {char_len} exceeds maxLength {max_len}"
                    ));
                }
            }
            if let Some(pat) = schema_obj.get("pattern").and_then(Value::as_str) {
                let re = RegexBuilder::new(pat)
                    .size_limit(REGEX_DFA_SIZE_LIMIT)
                    .build()
                    .map_err(|e| format!("{path}: invalid schema regex '{pat}': {e}"))?;
                if !re.is_match(s) {
                    return Err(format!(
                        "{path}: string '{s}' does not match pattern '{pat}'"
                    ));
                }
            }
        }
        Value::Number(num) => {
            let Some(val) = num.as_f64() else {
                return Err(format!("{path}: non-finite number"));
            };
            if let Some(min) = schema_obj.get("minimum").and_then(Value::as_f64) {
                if val < min {
                    return Err(format!("{path}: number {val} is less than minimum {min}"));
                }
            }
            if let Some(max) = schema_obj.get("maximum").and_then(Value::as_f64) {
                if val > max {
                    return Err(format!("{path}: number {val} exceeds maximum {max}"));
                }
            }
            if let Some(ex_min) = schema_obj.get("exclusiveMinimum").and_then(Value::as_f64) {
                if val <= ex_min {
                    return Err(format!(
                        "{path}: number {val} must be > exclusiveMinimum {ex_min}"
                    ));
                }
            }
            if let Some(ex_max) = schema_obj.get("exclusiveMaximum").and_then(Value::as_f64) {
                if val >= ex_max {
                    return Err(format!(
                        "{path}: number {val} must be < exclusiveMaximum {ex_max}"
                    ));
                }
            }
        }
        Value::Bool(_) | Value::Null => {}
    }

    Ok(())
}

pub(super) fn matches_json_type(expected: &str, val: &Value) -> bool {
    match expected {
        "object" => val.is_object(),
        "array" => val.is_array(),
        "string" => val.is_string(),
        "boolean" => val.is_boolean(),
        "null" => val.is_null(),
        "integer" => {
            val.is_i64()
                || val.is_u64()
                || val
                    .as_f64()
                    .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        }
        "number" => val.as_f64().is_some_and(f64::is_finite),
        _ => false,
    }
}

pub(super) fn json_type_name(val: &Value) -> &'static str {
    match val {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                "integer"
            } else {
                "number"
            }
        }
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
