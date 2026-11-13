//! Codex Structured Outputs uses a stricter wire format than the application
//! schemas: every object is closed and every property is required. Optional
//! properties travel as nullable fields, then are omitted again before domain
//! validation. Dynamic JSON (DSL predicates, extractor maps, filter values)
//! travels as a JSON-encoded string so its arbitrary keys are preserved.
//! https://developers.openai.com/api/docs/guides/structured-outputs

use serde_json::{json, Value};

use crate::schema::validate_json_schema;
use crate::types::AiError;

fn is_dynamic_json(schema: &Value) -> bool {
    schema.as_object().is_some_and(|s| s.is_empty())
        || (schema.get("type").and_then(Value::as_str) == Some("object")
            && schema.get("properties").is_none())
}

pub(super) fn strict_output_schema(schema: &Value) -> Value {
    if is_dynamic_json(schema) {
        return json!({
            "type": "string",
            "description": format!("Return a JSON-encoded string containing this value (not prose). The string will be parsed as JSON and validated against: {}", schema)
        });
    }
    let mut wire = schema.clone();
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        wire["anyOf"] = branches.iter().map(strict_output_schema).collect();
    }
    if let Some(items) = schema.get("items") {
        wire["items"] = strict_output_schema(items);
    }
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        let required = schema.get("required").and_then(Value::as_array);
        let mut wire_props = serde_json::Map::new();
        for (key, property) in props {
            let projected = strict_output_schema(property);
            let is_required =
                required.is_some_and(|keys| keys.iter().any(|k| k.as_str() == Some(key)));
            wire_props.insert(
                key.clone(),
                if is_required {
                    projected
                } else {
                    // Keep optionality at the transport boundary. For example,
                    // min_len=null is removed rather than fed into an integer DTO.
                    json!({"anyOf": [projected, {"type": "null"}]})
                },
            );
        }
        wire["properties"] = Value::Object(wire_props);
        wire["required"] = props.keys().map(|key| Value::String(key.clone())).collect();
        wire["additionalProperties"] = Value::Bool(false);
    }
    if let Some(value) = wire.get("const").cloned() {
        wire.as_object_mut().expect("schema object").remove("const");
        wire["enum"] = json!([value]);
    }
    wire
}

pub(super) fn decode_strict_output(schema: &Value, wire: Value) -> Result<Value, AiError> {
    decode_at(schema, wire, "$")
}

fn decode_at(schema: &Value, wire: Value, path: &str) -> Result<Value, AiError> {
    if is_dynamic_json(schema) {
        let text = wire.as_str().ok_or_else(|| {
            AiError::InvalidOutput(format!("{path}: expected JSON-encoded string"))
        })?;
        return serde_json::from_str(text)
            .map_err(|_| AiError::InvalidOutput(format!("{path}: invalid JSON-encoded value")));
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        for branch in branches {
            if let Ok(decoded) = decode_at(branch, wire.clone(), path) {
                if validate_json_schema(branch, &decoded).is_ok() {
                    return Ok(decoded);
                }
            }
        }
        return Err(AiError::InvalidOutput(format!(
            "{path}: output did not match any schema branch"
        )));
    }
    match wire {
        Value::Object(mut values) => {
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                let required = schema.get("required").and_then(Value::as_array);
                for (key, property) in props {
                    if let Some(value) = values.remove(key) {
                        let is_required = required
                            .is_some_and(|keys| keys.iter().any(|k| k.as_str() == Some(key)));
                        if value.is_null() && !is_required {
                            continue;
                        }
                        values.insert(
                            key.clone(),
                            decode_at(property, value, &format!("{path}.{key}"))?,
                        );
                    }
                }
            }
            Ok(Value::Object(values))
        }
        Value::Array(values) => {
            if let Some(items) = schema.get("items") {
                let decoded: Result<Vec<_>, _> = values
                    .into_iter()
                    .enumerate()
                    .map(|(idx, value)| decode_at(items, value, &format!("{path}[{idx}]")))
                    .collect();
                Ok(Value::Array(decoded?))
            } else {
                Ok(Value::Array(values))
            }
        }
        value => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{
        build_judge_extract_schema, compile_rules_schema, probe_smoke_schema,
        suggest_fields_schema, validate_compile_rules_output, validate_suggest_fields_output,
    };
    use crate::types::{FieldDef, FieldType};

    fn fields() -> Vec<FieldDef> {
        [
            FieldType::Text,
            FieldType::Number,
            FieldType::Money,
            FieldType::Phone,
            FieldType::Location,
            FieldType::Enum,
            FieldType::MultiEnum,
            FieldType::Boolean,
            FieldType::Date,
            FieldType::Range,
            FieldType::Url,
        ]
        .into_iter()
        .enumerate()
        .map(|(i, kind)| FieldDef {
            key: format!("field_{i}"),
            label: "Test".into(),
            r#type: kind,
            description: "Test".into(),
            required: false,
            options: Some(vec!["option".into()]),
            show_in_alert: true,
            order: i as i32,
        })
        .collect()
    }

    fn assert_strict(schema: &Value) {
        assert!(
            schema.get("type").is_some() || schema.get("anyOf").is_some(),
            "untyped schema: {schema}"
        );
        if schema.get("type").and_then(Value::as_str) == Some("object") {
            assert_eq!(schema.get("additionalProperties"), Some(&json!(false)));
            let props = schema["properties"]
                .as_object()
                .expect("declared properties");
            let required: std::collections::BTreeSet<_> = schema["required"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| k.as_str().unwrap())
                .collect();
            assert_eq!(required, props.keys().map(String::as_str).collect());
            for property in props.values() {
                assert_strict(property);
            }
        }
        if let Some(items) = schema.get("items") {
            assert_strict(items);
        }
        if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
            for branch in branches {
                assert_strict(branch);
            }
        }
    }

    #[test]
    fn every_task_and_all_eleven_field_types_produce_strict_schemas() {
        for schema in [
            probe_smoke_schema(),
            suggest_fields_schema(),
            build_judge_extract_schema(&fields()),
            compile_rules_schema(),
        ] {
            let wire = strict_output_schema(&schema);
            assert_eq!(wire["type"], "object");
            assert_strict(&wire);
        }
        let judge = build_judge_extract_schema(&fields());
        assert!(judge["properties"]["results"]["items"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("is_spam")));
    }

    #[test]
    fn suggest_fields_restores_optional_fields_and_typed_filter_values() {
        let schema = suggest_fields_schema();
        for value in [
            json!(12),
            json!(true),
            json!([10, 20]),
            json!({"min": 10, "max": 20}),
            json!("Cầu Giấy"),
            Value::Null,
        ] {
            let wire = json!({
                "suggested_name": "Radar", "want_intent": "demand",
                "fields": [{"key": "budget", "label": "Ngân sách", "type": "number", "description": "Ngân sách", "required": false, "options": null}],
                "hard_filters": [{"field": "budget", "op": "eq", "value": value.to_string(), "when_missing": null}],
                "clarifying_questions": null, "prefilter_hint": {"any": null, "none": null}
            });
            validate_json_schema(&strict_output_schema(&schema), &wire).unwrap();
            let output = decode_strict_output(&schema, wire).unwrap();
            validate_json_schema(&schema, &output).unwrap();
            validate_suggest_fields_output(&output).unwrap();
            assert_eq!(output["hard_filters"][0]["value"], value);
            assert!(output.get("clarifying_questions").is_none());
            assert!(output["hard_filters"][0].get("when_missing").is_none());
        }
    }

    #[test]
    fn compile_rules_restores_recursive_dsl_and_dynamic_maps() {
        let schema = compile_rules_schema();
        let condition = json!({"all": [{"kw_any": ["cần thuê"]}, {"not": {"kw_none": ["spam"]}}]});
        let map = json!({"option": ["từ khóa", "tùy chọn"]});
        let wire = json!({
            "dsl": 1, "prefilter": {"any": [], "none": [], "min_len": null},
            "classify": [{"id": "rule", "when": condition.to_string(), "verdict": "match", "confidence": 0.9, "set": null}],
            "extract": [{"field": "field_5", "extractor": "enum_kw", "near": null, "window": null, "dict": null,
                "scope": null, "pattern": null, "group": null, "cast": null, "unit": null, "map": map.to_string()}],
            "thresholds": {"accept": 0.9, "reject": 0.9}
        });
        validate_json_schema(&strict_output_schema(&schema), &wire).unwrap();
        let output = decode_strict_output(&schema, wire).unwrap();
        validate_json_schema(&schema, &output).unwrap();
        validate_compile_rules_output(&output, &fields()).unwrap();
        assert_eq!(output["classify"][0]["when"], condition);
        assert_eq!(output["extract"][0]["map"], map);
        assert!(output["extract"][0].get("pattern").is_none());
        assert!(output["prefilter"].get("min_len").is_none());
    }

    #[test]
    fn bad_encoded_json_is_rejected_before_domain_use() {
        assert!(decode_strict_output(&json!({}), json!("not JSON")).is_err());
        assert!(decode_strict_output(&json!({}), json!({"unexpected": "object"})).is_err());
    }
}
