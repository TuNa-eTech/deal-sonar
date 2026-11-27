//! Heuristic field suggestion for the mock provider.

use super::*;

pub(super) fn heuristic_source_ids(prompt: &str) -> Vec<String> {
    let Some((description, groups)) = prompt.split_once("\nNhóm Facebook có sẵn (JSON):\n")
    else {
        return Vec::new();
    };
    let description = fold_vi(
        description
            .split("Nghề của người dùng:")
            .next()
            .unwrap_or(description),
    );
    let sources: Vec<crate::types::RadarSourceCandidate> =
        serde_json::from_str(groups).unwrap_or_default();
    let topics = [
        "can ho",
        "chung cu",
        "thue nha",
        "bat dong san",
        "tim tho",
        "dien nuoc",
        "sua",
        "oto",
        "xe cu",
        "tuyen dung",
    ];
    let description_tokens: Vec<String> = description
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.chars().count() >= 5 && !GENERIC_TOKENS.contains(token))
        .map(str::to_owned)
        .collect();
    sources
        .into_iter()
        .filter(|source| {
            let name = fold_vi(&source.name);
            topics
                .iter()
                .any(|topic| description.contains(topic) && name.contains(topic))
                || description_tokens
                    .iter()
                    .any(|token| name.contains(token.as_str()))
        })
        .take(3)
        .map(|source| source.id)
        .collect()
}

/// Words too common in Vietnamese group names to prove a topic match.
const GENERIC_TOKENS: &[&str] = &[
    "khach", "nguoi", "nhom", "group", "cong", "dong", "viet", "chinh", "mua", "ban", "thue",
];

pub(super) fn heuristic_suggest_fields(prompt: &str) -> Value {
    let desc_section = prompt
        .split("Nghề của người dùng:")
        .next()
        .unwrap_or(prompt);
    let folded = fold_vi(desc_section);

    let demand_cue = [
        "can thue",
        "can mua",
        "can tim",
        "tim thue",
        "tim mua",
        "khach thue",
        "khach can",
        "nguoi can",
        "can xe",
        "can tho",
        "can nguoi",
    ]
    .iter()
    .any(|cue| folded.contains(cue));
    let supply_cue = [
        "chinh chu",
        "cho thue",
        "tin ban",
        "can ban",
        "nhuong",
        "nguoi tim viec",
        "co xe trong",
    ]
    .iter()
    .any(|cue| folded.contains(cue));
    // A brief such as "tim xe" or "tim hang" does not say who the post author is.
    let transport_pair = folded.contains("ghep hang")
        || folded.contains("can xe / co xe")
        || ((folded.contains(" xe") || folded.contains("hang")) && !demand_cue && !supply_cue);
    let side_ambiguous = transport_pair || (demand_cue && supply_cue);
    let want_intent = if side_ambiguous {
        "any"
    } else if supply_cue {
        "supply"
    } else {
        "demand"
    };
    let wants_peers = ["doi tac", "cung nghe", "hop tac", "ket noi"]
        .iter()
        .any(|cue| folded.contains(cue));
    let exclude_peers = if side_ambiguous || wants_peers {
        json!(false)
    } else {
        Value::Null
    };
    let mut assumptions = Vec::new();
    if wants_peers {
        assumptions.push("Giữ cả bài của người cùng nghề vì bạn muốn kết nối hoặc hợp tác với họ.");
    }
    let mut clarifying = Vec::new();
    if side_ambiguous {
        clarifying.push(
            "Bạn muốn tìm bài của người đang cần hay người đang cung cấp (ví dụ tìm xe hay tìm hàng)?",
        );
    }
    let mut output = heuristic_suggest_fields_base(desc_section, &folded, want_intent);
    output["side_ambiguous"] = json!(side_ambiguous);
    output["assumptions"] = json!(assumptions);
    if !exclude_peers.is_null() {
        output["exclude_peers"] = exclude_peers;
    }
    if !clarifying.is_empty() {
        let mut questions = clarifying.into_iter().map(Value::from).collect::<Vec<_>>();
        if let Some(existing) = output["clarifying_questions"].as_array() {
            questions.extend(existing.iter().cloned());
        }
        questions.truncate(2);
        output["clarifying_questions"] = Value::Array(questions);
    }
    output
}

fn heuristic_suggest_fields_base(desc_section: &str, folded: &str, want_intent: &str) -> Value {
    let is_bds = folded.contains("can ho")
        || folded.contains("chung cu")
        || folded.contains("thue nha")
        || folded.contains("can thue")
        || folded.contains("phong ngu")
        || folded.contains("bat dong san");
    let is_repair =
        folded.contains("tim tho") || folded.contains("sua ") || folded.contains("dien nuoc");

    if is_repair {
        json!({
            "suggested_name": "Khách tìm thợ sửa chữa nhà cửa",
            "want_intent": want_intent,
            "fields": [
                {
                    "key": "service_type",
                    "label": "Loại công việc",
                    "type": "text",
                    "description": "Hạng mục sửa chữa hoặc lắp đặt khách đang cần",
                    "required": true,
                    "options": null
                },
                {
                    "key": "location",
                    "label": "Khu vực",
                    "type": "location",
                    "description": "Quận/huyện hoặc địa chỉ khách cần thợ tới",
                    "required": false,
                    "options": null
                },
                {
                    "key": "urgent",
                    "label": "Cần gấp",
                    "type": "boolean",
                    "description": "Khách có cần xử lý ngay trong ngày không",
                    "required": false,
                    "options": null
                },
                {
                    "key": "phone",
                    "label": "Số điện thoại",
                    "type": "phone",
                    "description": "Số điện thoại liên hệ của khách",
                    "required": false,
                    "options": null
                }
            ],
            "hard_filters": [],
            "clarifying_questions": [],
            "prefilter_hint": {
                "any": ["tim tho", "can tho", "ai biet tho", "sua chua"],
                "none": ["nhan sua chua", "doi tho chuyen"]
            }
        })
    } else if is_bds {
        let mut hard_filters = Vec::new();
        if let Some((_, money_val)) = extract_vn_money(desc_section) {
            if folded.contains("duoi ") || folded.contains("toi da") {
                if let Some(max_v) = money_val.get("max").and_then(Value::as_f64) {
                    hard_filters.push(json!({
                        "field": "price",
                        "op": if folded.contains("duoi ") { "lt" } else { "lte" },
                        "value": max_v,
                        "when_missing": "fail"
                    }));
                }
            }
        }

        json!({
            "suggested_name": "Khách cần thuê căn hộ theo khu vực",
            "want_intent": want_intent,
            "fields": [
                {
                    "key": "location",
                    "label": "Khu vực",
                    "type": "location",
                    "description": "Quận, phường hoặc khu vực khách muốn thuê",
                    "required": true,
                    "options": null
                },
                {
                    "key": "price",
                    "label": "Ngân sách",
                    "type": "money",
                    "description": "Mức giá thuê khách mong muốn",
                    "required": false,
                    "options": null
                },
                {
                    "key": "bedrooms",
                    "label": "Số phòng ngủ",
                    "type": "number",
                    "description": "Số phòng ngủ yêu cầu",
                    "required": false,
                    "options": null
                },
                {
                    "key": "area",
                    "label": "Diện tích",
                    "type": "range",
                    "description": "Khoảng diện tích (m2)",
                    "required": false,
                    "options": null
                },
                {
                    "key": "phone",
                    "label": "Số điện thoại",
                    "type": "phone",
                    "description": "Số điện thoại liên hệ trong bài",
                    "required": false,
                    "options": null
                }
            ],
            "hard_filters": hard_filters,
            "clarifying_questions": [
                "Bạn có muốn nhận cả các bài khách chưa ghi rõ mức ngân sách không?"
            ],
            "prefilter_hint": {
                "any": ["can thue", "tim thue", "tim can ho", "tim phong"],
                "none": ["chinh chu cho thue", "tuyen nhan vien kinh doanh"]
            }
        })
    } else {
        json!({
            "suggested_name": "Radar theo dõi tin khách hàng",
            "want_intent": want_intent,
            "fields": [
                {
                    "key": "topic",
                    "label": "Nhu cầu chính",
                    "type": "text",
                    "description": "Sản phẩm hoặc dịch vụ được nhắc tới trong bài",
                    "required": true,
                    "options": null
                },
                {
                    "key": "price",
                    "label": "Ngân sách / Giá",
                    "type": "money",
                    "description": "Số tiền nêu trong bài",
                    "required": false,
                    "options": null
                },
                {
                    "key": "location",
                    "label": "Khu vực",
                    "type": "location",
                    "description": "Địa điểm giao dịch",
                    "required": false,
                    "options": null
                },
                {
                    "key": "phone",
                    "label": "Số điện thoại",
                    "type": "phone",
                    "description": "Số điện thoại liên hệ",
                    "required": false,
                    "options": null
                }
            ],
            "hard_filters": [],
            "clarifying_questions": [
                "Bạn muốn lọc theo khu vực tỉnh/thành cụ thể nào không?"
            ],
            "prefilter_hint": {
                "any": [],
                "none": ["tuyen ctv", "viec lam tai nha"]
            }
        })
    }
}
