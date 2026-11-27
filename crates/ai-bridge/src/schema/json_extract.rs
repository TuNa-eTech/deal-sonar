//! Extracting a JSON object from raw model output (fenced blocks, balanced braces).

use super::*;

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

pub(super) fn extract_fenced_blocks(text: &str) -> Vec<&str> {
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

pub(super) fn find_balanced_object_end(text: &str, start: usize) -> Option<usize> {
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
