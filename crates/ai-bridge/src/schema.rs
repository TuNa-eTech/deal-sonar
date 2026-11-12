use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use regex::RegexBuilder;
use serde_json::{json, Value};

use crate::types::{AiError, FieldDef, FieldType, JudgeExtractOutput, SuggestFieldsOutput};

const REGEX_DFA_SIZE_LIMIT: usize = 1 << 20; // 1 MiB linear-time regex cap

/// Extracts a JSON `Value` from raw CLI text (`06-ai-bridge.md §4`).
///
/// 1. Tries direct `serde_json::from_str`.
/// 2. Tries stripping markdown code fences (` ```json ... ``` `).
/// 3. Extracts the first balanced `{ ... }` JSON object from surrounding prose.
pub fn extract_json_value(raw: &str) -> Result<Value, AiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AiError::InvalidOutput("empty CLI output".to_string()));
    }

    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        return Ok(val);
    }

    // Check markdown fenced blocks: ```json ... ``` or ``` ... ```
    for fenced in extract_fenced_blocks(trimmed) {
        if let Ok(val) = serde_json::from_str::<Value>(fenced.trim()) {
            return Ok(val);
        }
    }

    // Scan for the first valid balanced `{ ... }` object in prose.
    let bytes = trimmed.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'{' {
            if let Some(end_exclusive) = find_balanced_object_end(trimmed, idx) {
                let candidate = &trimmed[idx..end_exclusive];
                if let Ok(val) = serde_json::from_str::<Value>(candidate) {
                    return Ok(val);
                }
            }
        }
        idx += 1;
    }

    Err(AiError::InvalidOutput(
        "could not parse valid JSON object from CLI output".to_string(),
    ))
}

fn extract_fenced_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(start_fence) = rest.find("```") {
        let after_ticks = &rest[start_fence + 3..];
        let Some(newline_pos) = after_ticks.find('\n') else {
            break;
        };
        let body_start = &after_ticks[newline_pos + 1..];
        let Some(end_fence) = body_start.find("```") else {
            break;
        };
        blocks.push(&body_start[..end_fence]);
        rest = &body_start[end_fence + 3..];
    }
    blocks
}

fn find_balanced_object_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = start;

    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }

    None
}

// ============================================================================
// Recursive JSON Schema Validator (`06-ai-bridge.md §4`)
// ============================================================================

/// Validates `instance` against JSON Schema `schema`, returning `Ok(())` or a
/// descriptive error path string.
pub fn validate_json_schema(schema: &Value, instance: &Value) -> Result<(), String> {
    validate_at_path(schema, instance, "$")
}

fn validate_at_path(schema: &Value, instance: &Value, path: &str) -> Result<(), String> {
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

fn matches_json_type(expected: &str, val: &Value) -> bool {
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

fn json_type_name(val: &Value) -> &'static str {
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

// ============================================================================
// Task JSON Schemas & Dynamic Schema Cache (`06-ai-bridge.md §3.5, §5`)
// ============================================================================

/// Minimal smoke-test schema used by `probe()` (`06-ai-bridge.md §3.5`).
pub fn probe_smoke_schema() -> Value {
    json!({
        "type": "object",
        "required": ["ok"],
        "additionalProperties": false,
        "properties": {
            "ok": { "type": "boolean" }
        }
    })
}

/// Output JSON Schema for `suggest_fields` (`06-ai-bridge.md §5.1`).
pub fn suggest_fields_schema() -> Value {
    json!({
        "type": "object",
        "required": ["fields", "want_intent", "suggested_name"],
        "additionalProperties": false,
        "properties": {
            "suggested_name": { "type": "string", "minLength": 1, "maxLength": 60 },
            "want_intent": { "type": "string", "enum": ["demand", "supply", "any"] },
            "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 10,
                "items": {
                    "type": "object",
                    "required": ["key", "label", "type", "description", "required"],
                    "additionalProperties": false,
                    "properties": {
                        "key": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,30}$" },
                        "label": { "type": "string", "minLength": 1 },
                        "type": {
                            "type": "string",
                            "enum": [
                                "text", "number", "money", "phone", "location",
                                "enum", "multi_enum", "boolean", "date", "range", "url"
                            ]
                        },
                        "description": { "type": "string", "minLength": 1 },
                        "required": { "type": "boolean" },
                        "options": {
                            "type": ["array", "null"],
                            "items": { "type": "string", "minLength": 1 }
                        }
                    }
                }
            },
            "hard_filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["field", "op", "value"],
                    "additionalProperties": false,
                    "properties": {
                        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,30}$" },
                        "op": {
                            "type": "string",
                            "enum": ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"]
                        },
                        "value": {},
                        "when_missing": { "type": "string", "enum": ["pass", "fail"] }
                    }
                }
            },
            "clarifying_questions": {
                "type": "array",
                "maxItems": 2,
                "items": { "type": "string", "minLength": 1 }
            },
            "prefilter_hint": {
                "anyOf": [
                    {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "any": { "type": "array", "items": { "type": "string" } },
                            "none": { "type": "array", "items": { "type": "string" } }
                        }
                    },
                    { "type": "null" }
                ]
            }
        }
    })
}

/// Builds the dynamic `judge_extract` JSON Schema for a radar version's fields (`06-ai-bridge.md §5.2`).
pub fn build_judge_extract_schema(fields: &[FieldDef]) -> Value {
    let mut field_props = serde_json::Map::new();
    let mut required_keys = Vec::with_capacity(fields.len());

    for f in fields {
        required_keys.push(Value::String(f.key.clone()));
        field_props.insert(
            f.key.clone(),
            json!({
                "type": "object",
                "required": ["raw", "value", "confidence"],
                "additionalProperties": false,
                "properties": {
                    "raw": { "type": ["string", "null"] },
                    "value": field_value_subschema(f),
                    "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
                }
            }),
        );
    }

    json!({
        "type": "object",
        "required": ["results"],
        "additionalProperties": false,
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["ref", "match", "score", "intent", "author_role", "summary", "reason", "fields"],
                    "additionalProperties": false,
                    "properties": {
                        "ref": { "type": "integer", "minimum": 0 },
                        "match": { "type": "boolean" },
                        "score": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                        "intent": { "type": "string", "enum": ["demand", "supply", "other"] },
                        "author_role": { "type": "string", "enum": ["end_user", "peer", "unknown"] },
                        "is_spam": { "type": "boolean" },
                        "summary": { "type": "string", "maxLength": 140 },
                        "reason": { "type": "string", "maxLength": 200 },
                        "fields": {
                            "type": "object",
                            "required": required_keys,
                            "additionalProperties": false,
                            "properties": Value::Object(field_props)
                        }
                    }
                }
            }
        }
    })
}

fn field_value_subschema(field: &FieldDef) -> Value {
    match field.r#type {
        FieldType::Text | FieldType::Phone | FieldType::Url => {
            json!({ "type": ["string", "null"] })
        }
        FieldType::Date => {
            json!({
                "anyOf": [
                    { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}" },
                    { "type": "null" }
                ]
            })
        }
        FieldType::Number => json!({ "type": ["number", "null"] }),
        FieldType::Boolean => json!({ "type": ["boolean", "null"] }),
        FieldType::Money => json!({
            "anyOf": [
                {
                    "type": "object",
                    "required": ["min", "max", "currency", "period"],
                    "additionalProperties": false,
                    "properties": {
                        "min": { "type": "number" },
                        "max": { "type": "number" },
                        "currency": { "type": "string", "minLength": 1 },
                        "period": { "type": ["string", "null"] }
                    }
                },
                { "type": "null" }
            ]
        }),
        FieldType::Location => json!({
            "anyOf": [
                {
                    "type": "object",
                    "required": ["raw", "province", "district", "ward"],
                    "additionalProperties": false,
                    "properties": {
                        "raw": { "type": "string" },
                        "province": { "type": ["string", "null"] },
                        "district": { "type": ["string", "null"] },
                        "ward": { "type": ["string", "null"] }
                    }
                },
                { "type": "null" }
            ]
        }),
        FieldType::Range => json!({
            "anyOf": [
                {
                    "type": "object",
                    "required": ["min", "max", "unit"],
                    "additionalProperties": false,
                    "properties": {
                        "min": { "type": "number" },
                        "max": { "type": "number" },
                        "unit": { "type": "string", "minLength": 1 }
                    }
                },
                { "type": "null" }
            ]
        }),
        FieldType::Enum => {
            if let Some(opts) = field.options.as_ref().filter(|o| !o.is_empty()) {
                json!({
                    "anyOf": [
                        { "type": "string", "enum": opts },
                        { "type": "null" }
                    ]
                })
            } else {
                json!({ "type": ["string", "null"] })
            }
        }
        FieldType::MultiEnum => {
            if let Some(opts) = field.options.as_ref().filter(|o| !o.is_empty()) {
                json!({
                    "anyOf": [
                        {
                            "type": "array",
                            "items": { "type": "string", "enum": opts }
                        },
                        { "type": "null" }
                    ]
                })
            } else {
                json!({
                    "anyOf": [
                        { "type": "array", "items": { "type": "string" } },
                        { "type": "null" }
                    ]
                })
            }
        }
    }
}

/// Output JSON Schema for `compile_rules` DSL v1 (`06-ai-bridge.md §5.3`, `05-pipeline-rules.md §6.2`).
pub fn compile_rules_schema() -> Value {
    json!({
        "type": "object",
        "required": ["dsl", "prefilter", "classify", "extract", "thresholds"],
        "additionalProperties": false,
        "properties": {
            "dsl": { "type": "integer", "const": 1 },
            "prefilter": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "any": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                    "none": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                    "min_len": { "type": "integer", "minimum": 0 }
                }
            },
            "classify": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "when", "verdict", "confidence"],
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "when": { "type": "object", "minProperties": 1 },
                        "verdict": { "type": "string", "enum": ["match", "no_match"] },
                        "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                        "set": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "intent": { "type": "string", "enum": ["demand", "supply", "other"] },
                                "author_role": { "type": "string", "enum": ["end_user", "peer", "unknown"] }
                            }
                        }
                    }
                }
            },
            "extract": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["field", "extractor"],
                    "properties": {
                        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,30}$" },
                        "extractor": {
                            "type": "string",
                            "enum": [
                                "vn_money", "vn_phone", "vn_area", "gazetteer",
                                "number", "date_vi", "enum_kw", "regex"
                            ]
                        },
                        "near": { "type": "array", "items": { "type": "string" } },
                        "window": { "type": "integer", "minimum": 1 },
                        "dict": { "type": "string" },
                        "scope": { "type": "string" },
                        "pattern": { "type": "string" },
                        "group": { "type": "integer", "minimum": 0 },
                        "cast": { "type": "string", "enum": ["int", "float", "string", "bool"] },
                        "unit": { "type": "string" },
                        "map": { "type": "object" }
                    }
                }
            },
            "thresholds": {
                "type": "object",
                "required": ["accept", "reject"],
                "additionalProperties": false,
                "properties": {
                    "accept": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                    "reject": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
                }
            }
        }
    })
}

/// Thread-safe cache of dynamically generated `judge_extract` schemas keyed by `radar_version_id`
/// (`06-ai-bridge.md §5.2`).
#[derive(Debug, Default)]
pub struct SchemaCache {
    by_version: RwLock<HashMap<String, Value>>,
}

impl SchemaCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_build(&self, radar_version_id: &str, fields: &[FieldDef]) -> Value {
        if let Ok(guard) = self.by_version.read() {
            if let Some(cached) = guard.get(radar_version_id) {
                return cached.clone();
            }
        }
        let built = build_judge_extract_schema(fields);
        if let Ok(mut guard) = self.by_version.write() {
            guard.insert(radar_version_id.to_string(), built.clone());
        }
        built
    }

    pub fn len(&self) -> usize {
        self.by_version.read().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ============================================================================
// Task-Specific Semantic Validators (`06-ai-bridge.md §4` step 3)
// ============================================================================

pub fn validate_suggest_fields_output(val: &Value) -> Result<SuggestFieldsOutput, AiError> {
    let parsed: SuggestFieldsOutput = serde_json::from_value(val.clone()).map_err(|e| {
        AiError::InvalidOutput(format!("suggest_fields deserialization error: {e}"))
    })?;

    let mut seen_keys = HashSet::new();
    for f in &parsed.fields {
        if !seen_keys.insert(f.key.as_str()) {
            return Err(AiError::InvalidOutput(format!(
                "duplicate suggested field key '{}'",
                f.key
            )));
        }
        if matches!(f.r#type, FieldType::Enum | FieldType::MultiEnum)
            && f.options.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(AiError::InvalidOutput(format!(
                "field '{}' of type '{}' must include non-empty options",
                f.key,
                f.r#type.as_str()
            )));
        }
    }

    Ok(parsed)
}

/// Validates that `judge_extract` returned exactly one item per sent `ref`, no unknown `ref`,
/// and only field keys defined in the radar (`06-ai-bridge.md §4` step 3).
pub fn validate_judge_extract_output(
    val: &Value,
    expected_refs: &[u32],
    radar_fields: &[FieldDef],
) -> Result<JudgeExtractOutput, AiError> {
    let parsed: JudgeExtractOutput = serde_json::from_value(val.clone())
        .map_err(|e| AiError::InvalidOutput(format!("judge_extract deserialization error: {e}")))?;

    if parsed.results.len() != expected_refs.len() {
        return Err(AiError::InvalidOutput(format!(
            "expected {} results for batch refs {:?}, got {}",
            expected_refs.len(),
            expected_refs,
            parsed.results.len()
        )));
    }

    let expected_set: HashSet<u32> = expected_refs.iter().copied().collect();
    let allowed_fields: HashSet<&str> = radar_fields.iter().map(|f| f.key.as_str()).collect();
    let mut seen_refs = HashSet::with_capacity(expected_refs.len());

    for item in &parsed.results {
        if !expected_set.contains(&item.r#ref) {
            return Err(AiError::InvalidOutput(format!(
                "unknown ref {} in judge_extract output (expected {:?})",
                item.r#ref, expected_refs
            )));
        }
        if !seen_refs.insert(item.r#ref) {
            return Err(AiError::InvalidOutput(format!(
                "duplicate ref {} in judge_extract output",
                item.r#ref
            )));
        }
        for key in item.fields.keys() {
            if !allowed_fields.contains(key.as_str()) {
                return Err(AiError::InvalidOutput(format!(
                    "unknown field key '{}' for ref {}",
                    key, item.r#ref
                )));
            }
        }
    }

    Ok(parsed)
}

/// Validates DSL v1 structure, condition keys, and linear-time safe regex patterns
/// without nested catastrophic quantifiers (`06-ai-bridge.md §5.3`, `03-risks-compliance.md §4`).
pub fn validate_compile_rules_output(
    val: &Value,
    radar_fields: &[FieldDef],
) -> Result<(), AiError> {
    let allowed_fields: HashSet<&str> = radar_fields.iter().map(|f| f.key.as_str()).collect();

    if let Some(pf) = val.get("prefilter").and_then(Value::as_object) {
        for arr_key in ["any", "none"] {
            if let Some(arr) = pf.get(arr_key).and_then(Value::as_array) {
                for entry in arr.iter().filter_map(Value::as_str) {
                    if let Some(pat) = entry.strip_prefix("re:") {
                        validate_safe_regex(pat, &format!("$.prefilter.{arr_key}"))?;
                    }
                }
            }
        }
    }

    if let Some(classify) = val.get("classify").and_then(Value::as_array) {
        for (idx, rule) in classify.iter().enumerate() {
            if let Some(when) = rule.get("when") {
                validate_condition_tree(when, &allowed_fields, &format!("$.classify[{idx}].when"))?;
            }
        }
    }

    if let Some(extract) = val.get("extract").and_then(Value::as_array) {
        for (idx, ext) in extract.iter().enumerate() {
            let field = ext.get("field").and_then(Value::as_str).unwrap_or_default();
            if !allowed_fields.is_empty() && !allowed_fields.contains(field) {
                return Err(AiError::InvalidOutput(format!(
                    "$.extract[{idx}]: field '{field}' is not in radar definition"
                )));
            }
            let extractor = ext
                .get("extractor")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if extractor == "regex" {
                let pat = ext.get("pattern").and_then(Value::as_str).ok_or_else(|| {
                    AiError::InvalidOutput(format!(
                        "$.extract[{idx}]: regex extractor requires 'pattern'"
                    ))
                })?;
                validate_safe_regex(pat, &format!("$.extract[{idx}].pattern"))?;
            }
        }
    }

    Ok(())
}

fn validate_condition_tree(
    cond: &Value,
    allowed_fields: &HashSet<&str>,
    path: &str,
) -> Result<(), AiError> {
    let Some(obj) = cond.as_object() else {
        return Err(AiError::InvalidOutput(format!(
            "{path}: condition must be an object"
        )));
    };
    if obj.is_empty() {
        return Err(AiError::InvalidOutput(format!(
            "{path}: condition object cannot be empty"
        )));
    }

    const ALLOWED_KEYS: &[&str] = &[
        "all",
        "any",
        "not",
        "kw_any",
        "kw_none",
        "re",
        "has_field",
        "len_lt",
        "len_gt",
        "lang_in",
        "field_cmp",
    ];
    for (k, v) in obj {
        if !ALLOWED_KEYS.contains(&k.as_str()) {
            return Err(AiError::InvalidOutput(format!(
                "{path}: unknown DSL condition predicate '{k}'"
            )));
        }
        match k.as_str() {
            "all" | "any" => {
                let arr = v.as_array().ok_or_else(|| {
                    AiError::InvalidOutput(format!("{path}.{k}: must be an array"))
                })?;
                for (i, sub) in arr.iter().enumerate() {
                    validate_condition_tree(sub, allowed_fields, &format!("{path}.{k}[{i}]"))?;
                }
            }
            "not" => {
                validate_condition_tree(v, allowed_fields, &format!("{path}.not"))?;
            }
            "re" => {
                let pat = v.as_str().ok_or_else(|| {
                    AiError::InvalidOutput(format!("{path}.re: must be a regex string"))
                })?;
                validate_safe_regex(pat, &format!("{path}.re"))?;
            }
            "has_field" => {
                let fname = v.as_str().ok_or_else(|| {
                    AiError::InvalidOutput(format!("{path}.has_field: must be a field key string"))
                })?;
                if !allowed_fields.is_empty() && !allowed_fields.contains(fname) {
                    return Err(AiError::InvalidOutput(format!(
                        "{path}.has_field: unknown field '{fname}'"
                    )));
                }
            }
            _ => {}
        }
    }

    Ok(())
}

/// Checks against nested quantifiers (`06-ai-bridge.md §5.3`) and compiles with bounded DFA size.
pub fn validate_safe_regex(pattern: &str, path: &str) -> Result<(), AiError> {
    if pattern.len() > 512 {
        return Err(AiError::InvalidOutput(format!(
            "{path}: regex exceeds max length of 512 bytes"
        )));
    }
    if has_nested_quantifier(pattern) {
        return Err(AiError::InvalidOutput(format!(
            "{path}: regex '{pattern}' contains nested quantifiers"
        )));
    }
    RegexBuilder::new(pattern)
        .size_limit(REGEX_DFA_SIZE_LIMIT)
        .build()
        .map_err(|e| AiError::InvalidOutput(format!("{path}: invalid regex '{pattern}': {e}")))?;
    Ok(())
}

fn has_nested_quantifier(pattern: &str) -> bool {
    // Track whether each open paren group contains an unescaped quantifier (+, *, {m,n})
    // and flag if the closing `)` is immediately followed by another quantifier.
    let chars: Vec<char> = pattern.chars().collect();
    let mut group_has_quantifier: Vec<bool> = Vec::new();
    let mut escaped = false;
    let mut in_char_class = false;

    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            i += 1;
            continue;
        }
        if in_char_class {
            if ch == ']' {
                in_char_class = false;
            }
            i += 1;
            continue;
        }
        match ch {
            '[' => in_char_class = true,
            '(' => group_has_quantifier.push(false),
            '+' | '*' => {
                if let Some(top) = group_has_quantifier.last_mut() {
                    *top = true;
                }
            }
            '{' => {
                if let Some(top) = group_has_quantifier.last_mut() {
                    *top = true;
                }
            }
            ')' => {
                let inner_quantified = group_has_quantifier.pop().unwrap_or(false);
                let next = chars.get(i + 1).copied();
                if inner_quantified && matches!(next, Some('+' | '*' | '{')) {
                    return true;
                }
                if inner_quantified {
                    if let Some(parent) = group_has_quantifier.last_mut() {
                        *parent = true;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }

    false
}
