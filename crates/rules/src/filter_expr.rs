//! Boolean filter expressions over extracted fields: `all` / `any` / `not` groups of hard filters.
//!
//! JSON shape (a leaf is exactly the legacy [`HardFilter`] object, so old radars keep their meaning):
//!
//! ```json
//! { "all": [
//!     { "field": "price", "op": "lte", "value": 5000000, "when_missing": "fail" },
//!     { "any": [ { "field": "area", "op": "eq", "value": "Cầu Giấy", "when_missing": "fail" },
//!                { "field": "area", "op": "eq", "value": "Đống Đa",  "when_missing": "fail" } ] },
//!     { "not": { "field": "role", "op": "eq", "value": "môi giới", "when_missing": "fail" } }
//! ] }
//! ```
//!
//! Missing-field policy: each leaf decides its own boolean result when the field is absent
//! (`when_missing: "pass"` → leaf is `true`, `"fail"` → leaf is `false`) *before* any enclosing `not`
//! is applied. An exception such as "loại bài của môi giới" is therefore written as
//! `not(role eq "môi giới")` with `when_missing: "fail"`, so a post with no `role` is kept.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::postfilter::{is_iso_date_str, value_as_f64};
use crate::types::{FieldDef, FilterOp, HardFilter};

/// Maximum nesting depth of `all`/`any`/`not` groups (root expression has depth 1).
pub const MAX_FILTER_EXPR_DEPTH: usize = 8;
/// Maximum total number of nodes (groups + leaves) in one expression.
pub const MAX_FILTER_EXPR_NODES: usize = 64;

/// A boolean expression of hard filters.
#[derive(Debug, Clone, PartialEq)]
pub enum FilterExpr {
    /// Single condition (legacy hard filter object).
    Filter(HardFilter),
    /// Every child must hold.
    All(Vec<FilterExpr>),
    /// At least one child must hold.
    Any(Vec<FilterExpr>),
    /// Negation (exception).
    Not(Box<FilterExpr>),
}

/// Specific, path-addressed reason why a filter expression or hard filter is invalid.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FilterExprError {
    #[error("Điều kiện không hợp lệ tại `{path}`: {message}")]
    Malformed { path: String, message: String },
    #[error("Nhóm `{kind}` tại `{path}` không có điều kiện nào.")]
    EmptyGroup { path: String, kind: &'static str },
    #[error("Biểu thức điều kiện lồng quá sâu tại `{path}` (tối đa {MAX_FILTER_EXPR_DEPTH} cấp).")]
    TooDeep { path: String },
    #[error("Biểu thức điều kiện có quá nhiều nút (tối đa {MAX_FILTER_EXPR_NODES}).")]
    TooManyNodes,
    #[error("Điều kiện tại `{path}` tham chiếu trường `{field}` không có trong danh sách trường của Radar.")]
    UnknownField { path: String, field: String },
    #[error(
        "Điều kiện tại `{path}` (trường `{field}`, phép `{op}`) có giá trị không hợp lệ: {reason}"
    )]
    InvalidValue {
        path: String,
        field: String,
        op: &'static str,
        reason: &'static str,
    },
}

fn op_name(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "eq",
        FilterOp::Ne => "ne",
        FilterOp::In => "in",
        FilterOp::Lt => "lt",
        FilterOp::Lte => "lte",
        FilterOp::Gt => "gt",
        FilterOp::Gte => "gte",
        FilterOp::Between => "between",
        FilterOp::Contains => "contains",
        FilterOp::IsEmpty => "is_empty",
    }
}

const LEAF_KEYS: [&str; 4] = ["field", "op", "value", "when_missing"];

impl FilterExpr {
    /// Parse a JSON value, reporting the path of the first malformed node.
    pub fn from_value(value: &Value, path: &str) -> Result<Self, FilterExprError> {
        Self::parse(value, path, 1)
    }

    fn parse(value: &Value, path: &str, depth: usize) -> Result<Self, FilterExprError> {
        let malformed = |message: String| FilterExprError::Malformed {
            path: path.to_string(),
            message,
        };
        if depth > MAX_FILTER_EXPR_DEPTH {
            return Err(FilterExprError::TooDeep {
                path: path.to_string(),
            });
        }
        let obj = value
            .as_object()
            .ok_or_else(|| malformed("phải là một object".into()))?;
        let group_keys: Vec<&str> = ["all", "any", "not"]
            .into_iter()
            .filter(|k| obj.contains_key(*k))
            .collect();
        match group_keys.as_slice() {
            [] => Self::parse_leaf(value, obj, path),
            [key] => {
                if obj.len() > 1 {
                    return Err(malformed(format!(
                        "nhóm `{key}` không được kèm khóa khác trong cùng object"
                    )));
                }
                let child = &obj[*key];
                if *key == "not" {
                    let inner = Self::parse(child, &format!("{path}.not"), depth + 1)?;
                    return Ok(Self::Not(Box::new(inner)));
                }
                let items = child
                    .as_array()
                    .ok_or_else(|| malformed(format!("`{key}` phải là một mảng điều kiện")))?;
                let parsed = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| Self::parse(item, &format!("{path}.{key}[{i}]"), depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(if *key == "all" {
                    Self::All(parsed)
                } else {
                    Self::Any(parsed)
                })
            }
            _ => Err(malformed(
                "chỉ được dùng một trong `all`, `any`, `not` trong cùng object".into(),
            )),
        }
    }

    fn parse_leaf(
        value: &Value,
        obj: &Map<String, Value>,
        path: &str,
    ) -> Result<Self, FilterExprError> {
        if let Some(unknown) = obj.keys().find(|k| !LEAF_KEYS.contains(&k.as_str())) {
            return Err(FilterExprError::Malformed {
                path: path.to_string(),
                message: format!(
                    "khóa `{unknown}` không được hỗ trợ (dùng field, op, value, when_missing hoặc all/any/not)"
                ),
            });
        }
        serde_json::from_value::<HardFilter>(value.clone())
            .map(Self::Filter)
            .map_err(|e| FilterExprError::Malformed {
                path: path.to_string(),
                message: e.to_string(),
            })
    }

    /// Serialize to the JSON shape documented at module level.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Filter(f) => serde_json::to_value(f).unwrap_or(Value::Null),
            Self::All(items) => {
                serde_json::json!({ "all": items.iter().map(Self::to_value).collect::<Vec<_>>() })
            }
            Self::Any(items) => {
                serde_json::json!({ "any": items.iter().map(Self::to_value).collect::<Vec<_>>() })
            }
            Self::Not(inner) => serde_json::json!({ "not": inner.to_value() }),
        }
    }

    fn node_count(&self) -> usize {
        match self {
            Self::Filter(_) => 1,
            Self::All(items) | Self::Any(items) => {
                1 + items.iter().map(Self::node_count).sum::<usize>()
            }
            Self::Not(inner) => 1 + inner.node_count(),
        }
    }
}

impl Serialize for FilterExpr {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for FilterExpr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value, "condition").map_err(serde::de::Error::custom)
    }
}

/// Validate one leaf: field exists in `fields` and `value` has the shape `op` needs.
pub fn validate_hard_filter(
    filter: &HardFilter,
    fields: &[FieldDef],
    path: &str,
) -> Result<(), FilterExprError> {
    if !fields.iter().any(|f| f.key == filter.field) {
        return Err(FilterExprError::UnknownField {
            path: path.to_string(),
            field: filter.field.clone(),
        });
    }
    let invalid = |reason: &'static str| FilterExprError::InvalidValue {
        path: path.to_string(),
        field: filter.field.clone(),
        op: op_name(filter.op),
        reason,
    };
    let is_bound = |v: &Value| value_as_f64(v).is_some() || v.as_str().is_some_and(is_iso_date_str);
    match filter.op {
        FilterOp::Eq | FilterOp::Ne => {
            if filter.value.is_null() {
                return Err(invalid("cần một giá trị để so sánh"));
            }
        }
        FilterOp::In => match filter.value.as_array() {
            Some(items) if !items.is_empty() => {}
            _ => return Err(invalid("cần một mảng không rỗng")),
        },
        FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
            if !is_bound(&filter.value) {
                return Err(invalid("cần một số hoặc ngày YYYY-MM-DD"));
            }
        }
        FilterOp::Between => {
            let ok = match &filter.value {
                Value::Array(a) => a.len() == 2 && a.iter().all(is_bound),
                Value::Object(o) => ["min", "max"]
                    .iter()
                    .all(|k| o.get(*k).is_some_and(is_bound)),
                _ => false,
            };
            if !ok {
                return Err(invalid("cần [min, max] hoặc {min, max} là số hoặc ngày"));
            }
        }
        FilterOp::Contains => {
            if filter.value.as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err(invalid("cần một chuỗi không rỗng"));
            }
        }
        FilterOp::IsEmpty => {
            if !matches!(filter.value, Value::Null | Value::Bool(_)) {
                return Err(invalid("chỉ nhận true/false hoặc để trống"));
            }
        }
    }
    Ok(())
}

/// Validate the legacy AND list (`hard_filters`); `path` entries look like `hard_filters[2]`.
pub fn validate_hard_filters(
    filters: &[HardFilter],
    fields: &[FieldDef],
) -> Result<(), FilterExprError> {
    filters
        .iter()
        .enumerate()
        .try_for_each(|(i, f)| validate_hard_filter(f, fields, &format!("hard_filters[{i}]")))
}

/// Validate a whole expression: depth, size, non-empty groups, and every leaf.
pub fn validate_filter_expr(
    expr: &FilterExpr,
    fields: &[FieldDef],
    path: &str,
) -> Result<(), FilterExprError> {
    if expr.node_count() > MAX_FILTER_EXPR_NODES {
        return Err(FilterExprError::TooManyNodes);
    }
    validate_node(expr, fields, path, 1)
}

fn validate_node(
    expr: &FilterExpr,
    fields: &[FieldDef],
    path: &str,
    depth: usize,
) -> Result<(), FilterExprError> {
    if depth > MAX_FILTER_EXPR_DEPTH {
        return Err(FilterExprError::TooDeep {
            path: path.to_string(),
        });
    }
    match expr {
        FilterExpr::Filter(f) => validate_hard_filter(f, fields, path),
        FilterExpr::All(items) | FilterExpr::Any(items) => {
            let kind = if matches!(expr, FilterExpr::All(_)) {
                "all"
            } else {
                "any"
            };
            if items.is_empty() {
                return Err(FilterExprError::EmptyGroup {
                    path: path.to_string(),
                    kind,
                });
            }
            items.iter().enumerate().try_for_each(|(i, item)| {
                validate_node(item, fields, &format!("{path}.{kind}[{i}]"), depth + 1)
            })
        }
        FilterExpr::Not(inner) => validate_node(inner, fields, &format!("{path}.not"), depth + 1),
    }
}
