//! Heuristic ruleset compilation for the mock provider.

use super::*;

pub(super) fn heuristic_compile_rules(prompt: &str) -> Value {
    let mut extracts = Vec::new();
    for line in prompt.lines() {
        if line.starts_with("- ") && line.contains("(money,") {
            if let Some(key) = line
                .strip_prefix("- ")
                .and_then(|s| s.split_whitespace().next())
            {
                extracts.push(json!({
                    "field": key,
                    "extractor": "vn_money",
                    "near": ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"],
                    "window": 40
                }));
            }
        } else if line.starts_with("- ") && line.contains("(location,") {
            if let Some(key) = line
                .strip_prefix("- ")
                .and_then(|s| s.split_whitespace().next())
            {
                extracts.push(json!({
                    "field": key,
                    "extractor": "gazetteer",
                    "dict": "vn_admin"
                }));
            }
        } else if line.starts_with("- ") && line.contains("(phone,") {
            if let Some(key) = line
                .strip_prefix("- ")
                .and_then(|s| s.split_whitespace().next())
            {
                extracts.push(json!({
                    "field": key,
                    "extractor": "vn_phone"
                }));
            }
        } else if line.starts_with("- ") && line.contains("(range,") {
            if let Some(key) = line
                .strip_prefix("- ")
                .and_then(|s| s.split_whitespace().next())
            {
                extracts.push(json!({
                    "field": key,
                    "extractor": "vn_area"
                }));
            }
        }
    }

    json!({
        "dsl": 1,
        "prefilter": {
            "any": ["can thue", "tim phong", "tim nha", "tim can ho", "muon thue"],
            "none": ["tuyen nhan vien kinh doanh", "game bai"],
            "min_len": 20
        },
        "classify": [
            {
                "id": "r_peer_reject",
                "when": {
                    "kw_any": ["ben em co", "quy can", "hoa hong", "nhan ky gui"]
                },
                "verdict": "no_match",
                "confidence": 0.93,
                "set": { "author_role": "peer" }
            },
            {
                "id": "r_demand_match",
                "when": {
                    "all": [
                        { "kw_any": ["can thue", "tim thue", "muon thue"] },
                        { "kw_none": ["cho thue", "ben em co", "hoa hong"] }
                    ]
                },
                "verdict": "match",
                "confidence": 0.91,
                "set": { "intent": "demand" }
            }
        ],
        "extract": extracts,
        "thresholds": {
            "accept": 0.9,
            "reject": 0.9
        }
    })
}
