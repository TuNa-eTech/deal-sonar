//! Validate manual corrections at the persistence boundary, including IPC callers.
use crate::{FieldDef, FieldType, StoreError};
use serde_json::Value;

pub fn validate_field_value(field: &FieldDef, value: &Value) -> Result<(), StoreError> {
    if value.is_null() {
        return Ok(());
    }
    let number = |v: &Value| v.as_f64().is_some_and(f64::is_finite);
    let option = |v: &Value| {
        v.as_str().is_some_and(|s| {
            field
                .options
                .as_ref()
                .map_or(true, |opts| opts.is_empty() || opts.iter().any(|o| o == s))
        })
    };
    let valid = match field.r#type {
        FieldType::Number => number(value),
        FieldType::Boolean => value.is_boolean(),
        FieldType::Enum => option(value),
        FieldType::MultiEnum => value.as_array().is_some_and(|xs| xs.iter().all(option)),
        FieldType::Money | FieldType::Range => {
            let bounds = value
                .get("min")
                .zip(value.get("max"))
                .is_some_and(|(a, b)| number(a) && number(b) && a.as_f64() <= b.as_f64());
            bounds
                && if field.r#type == FieldType::Money {
                    value["min"].as_f64().is_some_and(|n| n >= 0.0)
                        && value["currency"].as_str().is_some_and(|s| {
                            s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
                        })
                        && (value["period"].is_null()
                            || matches!(value["period"].as_str(), Some("month" | "year" | "day")))
                } else {
                    value["unit"].is_string()
                }
        }
        FieldType::Location => {
            value["raw"].is_string()
                && ["province", "district", "ward"]
                    .iter()
                    .all(|k| value[k].is_null() || value[k].is_string())
        }
        FieldType::Date => value.as_str().is_some_and(valid_date),
        FieldType::Url => value.as_str().is_some_and(|s| {
            (s.starts_with("https://") || s.starts_with("http://"))
                && !s.chars().any(char::is_whitespace)
                && s.split("://").nth(1).is_some_and(|h| !h.is_empty())
        }),
        FieldType::Text | FieldType::Phone => value.is_string(),
    };
    if valid {
        Ok(())
    } else {
        Err(StoreError::InvalidArgument(format!(
            "Giá trị không đúng kiểu dữ liệu của trường ‘{}’. Thay đổi chưa được lưu.",
            field.label
        )))
    }
}
fn valid_date(s: &str) -> bool {
    let parts: Vec<_> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        parts[0].parse::<u32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    ) else {
        return false;
    };
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    y > 0 && d > 0 && d <= days
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn money_rejects_untyped_or_reversed_corrections() {
        let field: FieldDef =
            serde_json::from_value(json!({"key":"price","label":"Giá","type":"money"})).unwrap();
        assert!(validate_field_value(&field, &json!(15)).is_err());
        assert!(validate_field_value(
            &field,
            &json!({"min":20,"max":10,"currency":"VND","period":null})
        )
        .is_err());
        assert!(validate_field_value(
            &field,
            &json!({"min":15000000,"max":15000000,"currency":"VND","period":"month"})
        )
        .is_ok());
    }
}
