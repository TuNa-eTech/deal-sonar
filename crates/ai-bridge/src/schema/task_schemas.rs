//! Task JSON schemas and the dynamic schema cache (`06-ai-bridge.md §3.5, §5`).

use super::*;

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
                    "required": ["ref", "match", "score", "intent", "author_role", "is_spam", "summary", "reason", "fields"],
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

pub(super) fn field_value_subschema(field: &FieldDef) -> Value {
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

/// Thread-safe cache of dynamically generated `judge_extract` schemas keyed by version and field definitions
/// (`06-ai-bridge.md §5.2`).
#[derive(Debug, Default)]
pub struct SchemaCache {
    pub(super) by_version: RwLock<HashMap<(String, String), Value>>,
}

impl SchemaCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_build(&self, radar_version_id: &str, fields: &[FieldDef]) -> Value {
        let key = (
            radar_version_id.to_string(),
            serde_json::to_string(fields).expect("field definitions serialize"),
        );
        if let Ok(guard) = self.by_version.read() {
            if let Some(cached) = guard.get(&key) {
                return cached.clone();
            }
        }
        let built = build_judge_extract_schema(fields);
        if let Ok(mut guard) = self.by_version.write() {
            guard.insert(key, built.clone());
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
