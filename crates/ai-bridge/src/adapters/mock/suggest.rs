//! Heuristic field suggestion for the mock provider.

use super::*;

pub(super) fn heuristic_suggest_fields(prompt: &str) -> Value {
    let desc_section = prompt
        .split("Nghề của người dùng:")
        .next()
        .unwrap_or(prompt);
    let folded = fold_vi(desc_section);

    let want_intent = if folded.contains("ghep hang") || folded.contains("can xe / co xe") {
        "any"
    } else if folded.contains("chinh chu")
        || folded.contains("cho thue")
        || folded.contains("tin ban")
        || folded.contains("nguoi tim viec")
    {
        "supply"
    } else {
        "demand"
    };

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
                        "op": "lte",
                        "value": max_v,
                        "when_missing": "pass"
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
