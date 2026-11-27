//! Task-specific semantic validators (`06-ai-bridge.md §4` step 3).

use super::*;

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

pub(super) fn validate_condition_tree(
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

pub(super) fn has_nested_quantifier(pattern: &str) -> bool {
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
