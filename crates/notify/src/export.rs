use std::collections::HashMap;

use chrono::{Local, SecondsFormat, TimeZone};
use rust_xlsxwriter::{Format, Url as XlsxUrl, Workbook};
use serde::{Deserialize, Serialize};

use crate::format::is_valid_facebook_https_url;
use crate::types::{ExtractedField, FieldDef, FieldType, NotifyError};

/// UTF-8 Byte Order Mark (`\xEF\xBB\xBF`) so Microsoft Excel opens Vietnamese CSVs cleanly.
pub const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Options controlling CSV and XLSX lead exports (`07-notifications-export.md §5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ExportOptions {
    pub include_post_text: bool,
}

/// Single lead row input for CSV and XLSX exporters (`07-notifications-export.md §5`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportLeadRow {
    pub post_created_at: Option<i64>,
    pub radar_name: String,
    pub status: String,
    pub score: f64,
    pub summary: String,
    pub group_name: String,
    pub author_name: String,
    pub permalink: String,
    pub post_text: Option<String>,
    #[serde(default)]
    pub fields: HashMap<String, ExtractedField>,
}

/// Protects spreadsheet string cells against formula injection (`07-notifications-export.md §5`).
///
/// Prefixes `'` whenever the first character — or first non-whitespace character — is one of
/// `=`, `+`, `-`, `@`, `\t`, or `\r`.
pub fn sanitize_spreadsheet_cell(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let first_raw = value.chars().next();
    let first_non_ws = value.chars().find(|c| !c.is_whitespace());
    let is_dangerous = matches!(first_raw, Some('=' | '+' | '-' | '@' | '\t' | '\r'))
        || matches!(first_non_ws, Some('=' | '+' | '-' | '@' | '\t' | '\r'));
    if is_dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

///Formats a Unix millisecond timestamp into local ISO 8601 (`YYYY-MM-DDTHH:MM:SS+HH:MM`).
pub fn format_local_iso8601(ts_ms: i64) -> String {
    match Local.timestamp_millis_opt(ts_ms).single() {
        Some(dt) => dt.to_rfc3339_opts(SecondsFormat::Secs, false),
        None => String::new(),
    }
}

#[derive(Debug, Clone)]
enum TypedCell {
    Empty,
    Text(String),
    Number(f64),
    Link(String),
}

fn sorted_fields(fields: &[FieldDef]) -> Vec<&FieldDef> {
    let mut sorted: Vec<&FieldDef> = fields.iter().collect();
    sorted.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));
    sorted
}

fn build_headers(options: &ExportOptions, sorted_defs: &[&FieldDef]) -> Vec<String> {
    let mut headers = vec![
        "Thời điểm đăng".to_string(),
        "Radar".to_string(),
        "Trạng thái".to_string(),
        "Điểm".to_string(),
        "Tóm tắt".to_string(),
        "Group".to_string(),
        "Tác giả".to_string(),
        "Liên kết".to_string(),
    ];
    if options.include_post_text {
        headers.push("Nội dung".to_string());
    }

    for def in sorted_defs {
        let label = &def.label;
        match def.r#type {
            FieldType::Money => {
                headers.push(format!("{label} (từ)"));
                headers.push(format!("{label} (đến)"));
                headers.push(format!("{label} (đơn vị)"));
            }
            FieldType::Location => {
                headers.push(format!("{label} (tỉnh)"));
                headers.push(format!("{label} (quận)"));
                headers.push(format!("{label} (phường)"));
            }
            FieldType::Range => {
                headers.push(format!("{label} (từ)"));
                headers.push(format!("{label} (đến)"));
            }
            _ => {
                headers.push(label.clone());
            }
        }
    }

    headers
}

fn text_or_empty(opt: Option<&str>) -> TypedCell {
    match opt.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => TypedCell::Text(s.to_string()),
        None => TypedCell::Empty,
    }
}

fn number_or_empty(opt: Option<f64>) -> TypedCell {
    match opt.filter(|n| n.is_finite()) {
        Some(n) => TypedCell::Number(n),
        None => TypedCell::Empty,
    }
}

fn append_dynamic_cells(
    out: &mut Vec<TypedCell>,
    def: &FieldDef,
    extracted: Option<&ExtractedField>,
) {
    let Some(ext) = extracted else {
        let width = match def.r#type {
            FieldType::Money | FieldType::Location => 3,
            FieldType::Range => 2,
            _ => 1,
        };
        for _ in 0..width {
            out.push(TypedCell::Empty);
        }
        return;
    };

    let val = &ext.value;
    match def.r#type {
        FieldType::Money => {
            if let Some(obj) = val.as_object() {
                let min_v = obj
                    .get("min")
                    .and_then(|v| v.as_f64())
                    .or_else(|| obj.get("amount").and_then(|v| v.as_f64()));
                let max_v = obj
                    .get("max")
                    .and_then(|v| v.as_f64())
                    .or_else(|| obj.get("amount").and_then(|v| v.as_f64()));
                let currency = obj
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let period = obj
                    .get("period")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());

                let unit = match (currency, period) {
                    (Some(c), Some(p)) => Some(format!("{c}/{p}")),
                    (Some(c), None) => Some(c.to_string()),
                    (None, Some(p)) => Some(format!("VND/{p}")),
                    (None, None) => {
                        if min_v.is_some() || max_v.is_some() {
                            Some("VND".to_string())
                        } else {
                            None
                        }
                    }
                };

                out.push(number_or_empty(min_v));
                out.push(number_or_empty(max_v));
                out.push(match unit {
                    Some(u) => TypedCell::Text(u),
                    None => TypedCell::Empty,
                });
            } else if let Some(n) = val.as_f64() {
                out.push(number_or_empty(Some(n)));
                out.push(number_or_empty(Some(n)));
                out.push(TypedCell::Text("VND".to_string()));
            } else {
                out.extend([TypedCell::Empty, TypedCell::Empty, TypedCell::Empty]);
            }
        }
        FieldType::Location => {
            if let Some(obj) = val.as_object() {
                out.push(text_or_empty(obj.get("province").and_then(|v| v.as_str())));
                out.push(text_or_empty(obj.get("district").and_then(|v| v.as_str())));
                out.push(text_or_empty(obj.get("ward").and_then(|v| v.as_str())));
            } else {
                out.extend([TypedCell::Empty, TypedCell::Empty, TypedCell::Empty]);
            }
        }
        FieldType::Range => {
            if let Some(obj) = val.as_object() {
                out.push(number_or_empty(obj.get("min").and_then(|v| v.as_f64())));
                out.push(number_or_empty(obj.get("max").and_then(|v| v.as_f64())));
            } else {
                out.extend([TypedCell::Empty, TypedCell::Empty]);
            }
        }
        FieldType::Number => {
            if let Some(n) = val.as_f64() {
                out.push(number_or_empty(Some(n)));
            } else if let Some(s) = val.as_str().and_then(|s| s.trim().parse::<f64>().ok()) {
                out.push(number_or_empty(Some(s)));
            } else {
                out.push(text_or_empty(val.as_str()));
            }
        }
        FieldType::Boolean => {
            if let Some(b) = val.as_bool() {
                out.push(TypedCell::Text(if b { "Có" } else { "Không" }.to_string()));
            } else {
                out.push(TypedCell::Empty);
            }
        }
        FieldType::MultiEnum => {
            if let Some(arr) = val.as_array() {
                let items: Vec<&str> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(str::trim))
                    .filter(|s| !s.is_empty())
                    .collect();
                if items.is_empty() {
                    out.push(TypedCell::Empty);
                } else {
                    out.push(TypedCell::Text(items.join(", ")));
                }
            } else {
                out.push(text_or_empty(val.as_str()));
            }
        }
        FieldType::Text | FieldType::Phone | FieldType::Enum | FieldType::Date | FieldType::Url => {
            if let Some(s) = val.as_str() {
                if s.is_empty() {
                    out.push(TypedCell::Empty);
                } else {
                    out.push(TypedCell::Text(s.to_string()));
                }
            } else if let Some(n) = val.as_f64() {
                out.push(number_or_empty(Some(n)));
            } else {
                out.push(TypedCell::Empty);
            }
        }
    }
}

fn build_row_cells(
    options: &ExportOptions,
    sorted_defs: &[&FieldDef],
    row: &ExportLeadRow,
) -> Vec<TypedCell> {
    let mut cells = Vec::with_capacity(9 + sorted_defs.len() * 3);

    match row.post_created_at {
        Some(ts) => {
            let iso = format_local_iso8601(ts);
            if iso.is_empty() {
                cells.push(TypedCell::Empty);
            } else {
                cells.push(TypedCell::Text(iso));
            }
        }
        None => cells.push(TypedCell::Empty),
    }

    cells.push(TypedCell::Text(row.radar_name.clone()));
    cells.push(TypedCell::Text(row.status.clone()));
    cells.push(number_or_empty(Some(row.score)));
    cells.push(TypedCell::Text(row.summary.clone()));
    cells.push(TypedCell::Text(row.group_name.clone()));
    cells.push(TypedCell::Text(row.author_name.clone()));
    cells.push(TypedCell::Link(row.permalink.clone()));

    if options.include_post_text {
        match row.post_text.as_deref() {
            Some(t) if !t.is_empty() => cells.push(TypedCell::Text(t.to_string())),
            _ => cells.push(TypedCell::Empty),
        }
    }

    for def in sorted_defs {
        append_dynamic_cells(&mut cells, def, row.fields.get(&def.key));
    }

    cells
}

fn format_csv_number(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if (n - n.round()).abs() < 1e-9 && n.abs() < 1e16 {
        format!("{}", n.round() as i64)
    } else {
        let s = format!("{n:.6}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn encode_rfc4180_field(raw_cell: &str) -> String {
    let needs_quotes = raw_cell
        .chars()
        .any(|c| matches!(c, ',' | '"' | '\r' | '\n'));
    if !needs_quotes {
        return raw_cell.to_string();
    }
    let mut out = String::with_capacity(raw_cell.len() + 4);
    out.push('"');
    for ch in raw_cell.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

fn write_csv_record(buf: &mut String, fields: impl IntoIterator<Item = String>) {
    let mut first = true;
    for field in fields {
        if !first {
            buf.push(',');
        }
        first = false;
        buf.push_str(&encode_rfc4180_field(&field));
    }
    buf.push_str("\r\n");
}

/// Exports filtered leads to UTF-8 CSV with BOM, CRLF line endings, flattened composite columns,
/// and spreadsheet formula-injection protection (`07-notifications-export.md §5`).
pub fn export_csv(
    options: &ExportOptions,
    fields: &[FieldDef],
    rows: &[ExportLeadRow],
) -> Result<Vec<u8>, NotifyError> {
    let sorted_defs = sorted_fields(fields);
    let headers = build_headers(options, &sorted_defs);

    let mut csv_text = String::with_capacity((rows.len() + 1) * 128);
    write_csv_record(
        &mut csv_text,
        headers.iter().map(|h| sanitize_spreadsheet_cell(h)),
    );

    for row in rows {
        let cells = build_row_cells(options, &sorted_defs, row);
        write_csv_record(
            &mut csv_text,
            cells.into_iter().map(|cell| match cell {
                TypedCell::Empty => String::new(),
                TypedCell::Number(n) => format_csv_number(n),
                TypedCell::Text(s) | TypedCell::Link(s) => sanitize_spreadsheet_cell(&s),
            }),
        );
    }

    let mut bytes = Vec::with_capacity(UTF8_BOM.len() + csv_text.len());
    bytes.extend_from_slice(&UTF8_BOM);
    bytes.extend_from_slice(csv_text.as_bytes());
    Ok(bytes)
}

/// Exports filtered leads to an `.xlsx` workbook with frozen bold headers, typed numbers,
/// clickable Facebook URLs, and safe plain-text cells (`07-notifications-export.md §5`).
pub fn export_xlsx(
    options: &ExportOptions,
    fields: &[FieldDef],
    rows: &[ExportLeadRow],
) -> Result<Vec<u8>, NotifyError> {
    let sorted_defs = sorted_fields(fields);
    let headers = build_headers(options, &sorted_defs);

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name("Bảng tin")
        .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
    worksheet
        .set_freeze_panes(1, 0)
        .map_err(|e| NotifyError::Xlsx(e.to_string()))?;

    let header_fmt = Format::new().set_bold();
    for (col_idx, header) in headers.iter().enumerate() {
        let col = u16::try_from(col_idx).map_err(|e| NotifyError::Xlsx(e.to_string()))?;
        worksheet
            .write_string_with_format(0, col, header, &header_fmt)
            .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
    }

    for (row_offset, row) in rows.iter().enumerate() {
        let excel_row =
            u32::try_from(row_offset + 1).map_err(|e| NotifyError::Xlsx(e.to_string()))?;
        let cells = build_row_cells(options, &sorted_defs, row);

        for (col_idx, cell) in cells.into_iter().enumerate() {
            let col = u16::try_from(col_idx).map_err(|e| NotifyError::Xlsx(e.to_string()))?;
            match cell {
                TypedCell::Empty => {}
                TypedCell::Number(n) => {
                    worksheet
                        .write_number(excel_row, col, n)
                        .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
                }
                TypedCell::Link(url) => {
                    if is_valid_facebook_https_url(&url) {
                        worksheet
                            .write_url_with_text(excel_row, col, XlsxUrl::new(&url), &url)
                            .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
                    } else if !url.is_empty() {
                        worksheet
                            .write_string(excel_row, col, &url)
                            .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
                    }
                }
                TypedCell::Text(s) => {
                    if !s.is_empty() {
                        worksheet
                            .write_string(excel_row, col, &s)
                            .map_err(|e| NotifyError::Xlsx(e.to_string()))?;
                    }
                }
            }
        }
    }

    workbook
        .save_to_buffer()
        .map_err(|e| NotifyError::Xlsx(e.to_string()))
}
