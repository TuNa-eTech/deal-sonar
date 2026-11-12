use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};

use crate::schema::validate_json_schema;
use crate::types::{
    AiError, AiProvider, AiRequest, AiResponse, ProbeResult, ProviderId, TaskKind, Usage,
};

type CustomHandler = Arc<dyn Fn(&AiRequest) -> Result<AiResponse, AiError> + Send + Sync>;

/// Deterministic offline `AiProvider` supporting both scripted test replay and a realistic
/// Vietnamese heuristic engine for `suggest_fields`, `judge_extract`, and `compile_rules`.
#[derive(Clone)]
pub struct MockAiProvider {
    queue: Arc<Mutex<VecDeque<Result<AiResponse, AiError>>>>,
    recorded: Arc<Mutex<Vec<AiRequest>>>,
    probe_override: Arc<Mutex<Option<ProbeResult>>>,
    handler: Option<CustomHandler>,
}

impl std::fmt::Debug for MockAiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockAiProvider")
            .field(
                "queued_len",
                &self.queue.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field(
                "recorded_len",
                &self.recorded.lock().map(|r| r.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl Default for MockAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockAiProvider {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            recorded: Arc::new(Mutex::new(Vec::new())),
            probe_override: Arc::new(Mutex::new(None)),
            handler: None,
        }
    }

    pub fn with_queued_responses(
        responses: impl IntoIterator<Item = Result<AiResponse, AiError>>,
    ) -> Self {
        let p = Self::new();
        {
            let mut q = p.queue.lock().expect("mock queue lock");
            q.extend(responses);
        }
        p
    }

    pub fn with_handler<F>(handler: F) -> Self
    where
        F: Fn(&AiRequest) -> Result<AiResponse, AiError> + Send + Sync + 'static,
    {
        let mut p = Self::new();
        p.handler = Some(Arc::new(handler));
        p
    }

    pub fn push_response(&self, resp: Result<AiResponse, AiError>) {
        self.queue.lock().expect("mock queue lock").push_back(resp);
    }

    pub fn push_json(&self, output: Value) {
        self.push_response(Ok(AiResponse {
            output,
            usage: Some(Usage {
                input_tokens: 120,
                output_tokens: 60,
                cost_usd: Some(0.0),
            }),
            model: Some("mock-v1".to_string()),
            duration: Duration::from_millis(5),
        }));
    }

    pub fn set_probe_result(&self, probe: ProbeResult) {
        *self.probe_override.lock().expect("probe lock") = Some(probe);
    }

    pub fn recorded_requests(&self) -> Vec<AiRequest> {
        self.recorded.lock().expect("recorded lock").clone()
    }

    pub fn call_count(&self) -> usize {
        self.recorded.lock().expect("recorded lock").len()
    }

    /// Runs the built-in deterministic heuristic engine for any `AiRequest`.
    pub fn heuristic_complete(req: &AiRequest) -> Result<AiResponse, AiError> {
        // Handle `probe()` smoke schema `{"ok": boolean}`
        if req
            .schema
            .get("properties")
            .and_then(|p| p.get("ok"))
            .is_some()
            && req
                .schema
                .get("properties")
                .and_then(Value::as_object)
                .map_or(false, |m| m.len() == 1)
        {
            let output = json!({ "ok": true });
            return Ok(AiResponse {
                output,
                usage: Some(Usage {
                    input_tokens: 24,
                    output_tokens: 6,
                    cost_usd: Some(0.0),
                }),
                model: Some("mock-fast-v1".to_string()),
                duration: Duration::from_millis(3),
            });
        }

        let output = match req.task {
            TaskKind::SuggestFields => heuristic_suggest_fields(&req.prompt),
            TaskKind::JudgeExtract => heuristic_judge_extract(&req.prompt, &req.schema),
            TaskKind::CompileRules => heuristic_compile_rules(&req.prompt),
        };

        validate_json_schema(&req.schema, &output).map_err(AiError::InvalidOutput)?;

        let in_tokens = ((req.system.len() + req.prompt.len()) / 4).max(16) as u64;
        let out_tokens = (output.to_string().len() / 4).max(12) as u64;

        Ok(AiResponse {
            output,
            usage: Some(Usage {
                input_tokens: in_tokens,
                output_tokens: out_tokens,
                cost_usd: Some(0.0),
            }),
            model: Some(match req.tier {
                crate::types::ModelTier::Fast => "mock-fast-v1".to_string(),
                crate::types::ModelTier::Smart => "mock-smart-v1".to_string(),
            }),
            duration: Duration::from_millis(4),
        })
    }
}

#[async_trait]
impl AiProvider for MockAiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    async fn probe(&self) -> ProbeResult {
        if let Some(custom) = self.probe_override.lock().expect("probe lock").clone() {
            return custom;
        }
        ProbeResult {
            installed: true,
            version: Some("dealsonar-mock 0.1.0".to_string()),
            authenticated: true,
            flags_supported: true,
            latency_ms: Some(1),
            error: None,
        }
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        self.recorded
            .lock()
            .expect("recorded lock")
            .push(req.clone());

        if let Some(queued) = self.queue.lock().expect("mock queue lock").pop_front() {
            return queued;
        }

        if let Some(ref handler) = self.handler {
            return handler(&req);
        }

        Self::heuristic_complete(&req)
    }
}

// ============================================================================
// Heuristic Vietnamese Engines
// ============================================================================

fn fold_vi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        for lc in ch.to_lowercase() {
            let mapped = match lc {
                'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ'
                | 'ấ' | 'ẩ' | 'ẫ' | 'ậ' => 'a',
                'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' => {
                    'e'
                }
                'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' => 'i',
                'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ'
                | 'ớ' | 'ở' | 'ỡ' | 'ợ' => 'o',
                'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' => {
                    'u'
                }
                'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' => 'y',
                'đ' => 'd',
                other => other,
            };
            out.push(mapped);
        }
    }
    out
}

fn heuristic_suggest_fields(prompt: &str) -> Value {
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

struct ParsedPromptPost {
    r#ref: u32,
    text: String,
}

fn parse_posts_from_judge_prompt(prompt: &str) -> Vec<ParsedPromptPost> {
    let mut posts = Vec::new();
    let marker = "--- Post ref=";
    let mut rest = prompt;

    while let Some(pos) = rest.find(marker) {
        let after = &rest[pos + marker.len()..];
        let Some(end_ref) = after.find(" ---") else {
            break;
        };
        let ref_str = after[..end_ref].trim();
        let Ok(ref_num) = ref_str.parse::<u32>() else {
            rest = &after[end_ref..];
            continue;
        };

        let block_body = &after[end_ref + 4..];
        // Find closing boundary tag `<<</DEALSONAR_UNTRUSTED_POST_`
        let (post_section, next_rest) =
            if let Some(close_idx) = block_body.find("<<</DEALSONAR_UNTRUSTED_POST_") {
                (&block_body[..close_idx], &block_body[close_idx + 29..])
            } else if let Some(next_m) = block_body.find(marker) {
                (&block_body[..next_m], &block_body[next_m..])
            } else {
                (block_body, "")
            };

        let text = if let Some(c_idx) = post_section.find("\ncontent:\n") {
            post_section[c_idx + "\ncontent:\n".len()..]
                .trim_end_matches('\n')
                .to_string()
        } else {
            post_section.trim().to_string()
        };

        posts.push(ParsedPromptPost {
            r#ref: ref_num,
            text,
        });
        rest = next_rest;
    }

    posts
}

fn heuristic_judge_extract(prompt: &str, schema: &Value) -> Value {
    let header_part = prompt
        .split("[4] CÁC BÀI CẦN CHẤM")
        .next()
        .unwrap_or(prompt);
    let header_fold = fold_vi(header_part);

    let want_intent = if header_fold.contains("want_intent): supply") {
        "supply"
    } else if header_fold.contains("want_intent): any") {
        "any"
    } else {
        "demand"
    };
    let exclude_peer = header_fold.contains("exclude_roles): peer")
        || header_fold.contains("nghe cua nguoi dung:");

    // Detect target district/budget hints from radar description line
    let radar_desc_line = header_part
        .lines()
        .find(|l| l.starts_with("- Mô tả:"))
        .unwrap_or("");
    let radar_desc_fold = fold_vi(radar_desc_line);

    let target_district = detect_location_in_text(radar_desc_line)
        .and_then(|(_, loc)| loc.get("district").and_then(Value::as_str).map(fold_vi));
    let target_max_budget = if radar_desc_fold.contains("duoi ")
        || radar_desc_fold.contains("toi da")
    {
        extract_vn_money(radar_desc_line).and_then(|(_, v)| v.get("max").and_then(Value::as_f64))
    } else {
        None
    };

    let field_props = schema
        .pointer("/properties/results/items/properties/fields/properties")
        .and_then(Value::as_object);

    let posts = parse_posts_from_judge_prompt(prompt);
    let mut results = Vec::with_capacity(posts.len());

    for post in posts {
        let post_fold = fold_vi(&post.text);

        // 1. Detect spam / off-topic
        let is_spam = post_fold.contains("vay von nhanh")
            || post_fold.contains("kiem tien online")
            || post_fold.contains("game bai")
            || post_fold.contains("tang tuong tac");

        // 2. Detect peer/broker signals (`06-ai-bridge.md §5.2`)
        let peer_signals = [
            "hoa hong",
            "hh 1 thang",
            "hh nua thang",
            "ben em co",
            "ben minh co",
            "quy can",
            "gio hang",
            "nhan ky gui",
            "ky gui",
            "ib em tu van",
            "inbox em gui anh",
            "lien he em xem nha",
            "tuyen ctv",
            "salon cam ket",
            "doi tho chuyen",
            "nhan sua chua tai nha",
            "khach net",
            "co khach net",
            "ket hop a e",
            "anh em mg",
            "ace mg co can",
        ];
        let is_peer = peer_signals.iter().any(|sig| post_fold.contains(sig));

        // 3. Detect demand vs supply intent
        let demand_signals = [
            "can thue",
            "tim thue",
            "muon thue",
            "tim can ho",
            "tim phong",
            "tim nha",
            "can mua",
            "tim mua",
            "hoi mua",
            "ai biet tho",
            "can tim tho",
            "gia dinh minh can",
            "vo chong minh can",
            "em can thue",
            "minh can thue",
        ];
        let supply_signals = [
            "cho thue",
            "can ban",
            "chinh chu cho thue",
            "chinh chu ban",
            "nhuong lai",
            "pass lai",
            "sang nhuong",
            "thanh ly",
            "con trong phong",
        ];

        let has_demand = demand_signals.iter().any(|s| post_fold.contains(s));
        let has_supply = supply_signals.iter().any(|s| post_fold.contains(s));

        let intent = if is_spam {
            "other"
        } else if has_demand && !has_supply {
            "demand"
        } else if has_supply && !has_demand {
            "supply"
        } else if has_demand
            && post_fold.find("can thue").unwrap_or(usize::MAX)
                < post_fold.find("cho thue").unwrap_or(usize::MAX)
        {
            "demand"
        } else if has_supply {
            "supply"
        } else {
            "other"
        };

        let author_role = if is_peer {
            "peer"
        } else if intent == "demand" || post_fold.contains("chinh chu") {
            "end_user"
        } else {
            "unknown"
        };

        // 4. Extract dynamic fields strictly using verbatim substrings of `post.text`
        let mut extracted_map = serde_json::Map::new();
        let mut extracted_loc_district_fold: Option<String> = None;
        let mut extracted_price_min: Option<f64> = None;

        if let Some(props) = field_props {
            for (field_key, field_schema) in props {
                let value_schema = field_schema.get("properties").and_then(|p| p.get("value"));
                let (raw_opt, val_json, conf) =
                    extract_field_for_schema(field_key, value_schema, &post.text);

                if field_key.contains("location") || field_key.contains("district") {
                    if let Some(d) = val_json.get("district").and_then(Value::as_str) {
                        extracted_loc_district_fold = Some(fold_vi(d));
                    }
                }
                if field_key.contains("price") || field_key.contains("budget") {
                    if let Some(mn) = val_json.get("min").and_then(Value::as_f64) {
                        extracted_price_min = Some(mn);
                    }
                }

                extracted_map.insert(
                    field_key.clone(),
                    json!({
                        "raw": raw_opt,
                        "value": val_json,
                        "confidence": conf
                    }),
                );
            }
        }

        // 5. Decide match & score
        let intent_ok = want_intent == "any" || intent == want_intent;
        let role_ok = !(exclude_peer && author_role == "peer");
        let district_ok = match (&target_district, &extracted_loc_district_fold) {
            (Some(target_d), Some(found_d)) => target_d == found_d,
            (Some(target_d), None) => post_fold.contains(target_d.as_str()),
            (None, _) => true,
        };
        let budget_ok = match (target_max_budget, extracted_price_min) {
            (Some(limit), Some(found_min)) => found_min <= limit * 1.05,
            _ => true,
        };

        let is_match = !is_spam && intent_ok && role_ok && district_ok && budget_ok;
        let score = if is_match {
            0.88
        } else if !is_spam && intent_ok && !role_ok {
            0.22
        } else if !is_spam && intent_ok && (!district_ok || !budget_ok) {
            0.35
        } else {
            0.08
        };

        let summary = build_short_summary(&post.text, 130);
        let reason = if is_spam {
            "Bài quảng cáo/rác không liên quan nhu cầu radar.".to_string()
        } else if !role_ok {
            "Dấu hiệu môi giới/người cùng nghề đăng bài tìm nguồn hoặc câu khách.".to_string()
        } else if !intent_ok {
            format!("Ý định bài là '{intent}', không khớp yêu cầu '{want_intent}'.")
        } else if !district_ok {
            "Khu vực trong bài không thuộc địa bàn radar theo dõi.".to_string()
        } else if !budget_ok {
            "Mức giá/ngân sách vượt ngưỡng mô tả của radar.".to_string()
        } else {
            "Khách thực có nhu cầu, khu vực và thông tin phù hợp mô tả radar.".to_string()
        };

        results.push(json!({
            "ref": post.r#ref,
            "match": is_match,
            "score": score,
            "intent": intent,
            "author_role": author_role,
            "is_spam": is_spam,
            "summary": summary,
            "reason": reason,
            "fields": Value::Object(extracted_map)
        }));
    }

    json!({ "results": results })
}

fn build_short_summary(text: &str, max_chars: usize) -> String {
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max_chars {
        return clean;
    }
    let prefix: String = clean.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{prefix}…")
}

fn extract_field_for_schema(
    field_key: &str,
    value_schema: Option<&Value>,
    text: &str,
) -> (Option<String>, Value, f64) {
    let schema_str = value_schema.map(Value::to_string).unwrap_or_default();

    // 1. Money shape (`currency`, `period`)
    if schema_str.contains("\"currency\"") {
        if let Some((raw, val)) = extract_vn_money(text) {
            return (Some(raw), val, 0.93);
        }
        return (None, Value::Null, 0.0);
    }

    // 2. Location shape (`province`, `district`, `ward`)
    if schema_str.contains("\"province\"") {
        if let Some((raw, val)) = detect_location_in_text(text) {
            return (Some(raw), val, 0.91);
        }
        return (None, Value::Null, 0.0);
    }

    // 3. Range shape (`min`, `max`, `unit`)
    if schema_str.contains("\"unit\"") {
        if let Some((raw, val)) = extract_vn_area(text) {
            return (Some(raw), val, 0.90);
        }
        return (None, Value::Null, 0.0);
    }

    // 4. Enum / MultiEnum
    if let Some(vs) = value_schema {
        if let Some(any_of) = vs.get("anyOf").and_then(Value::as_array) {
            for branch in any_of {
                if let Some(opts) = branch.get("enum").and_then(Value::as_array) {
                    if let Some((raw, chosen)) = match_enum_option(opts, text) {
                        return (Some(raw), Value::String(chosen), 0.88);
                    }
                    return (None, Value::Null, 0.0);
                }
                if branch.get("type").and_then(Value::as_str) == Some("array") {
                    if let Some(opts) = branch
                        .get("items")
                        .and_then(|i| i.get("enum"))
                        .and_then(Value::as_array)
                    {
                        let mut matched_vals = Vec::new();
                        let mut first_raw = None;
                        for opt in opts.iter().filter_map(Value::as_str) {
                            if let Some(r) = find_case_fold_span(text, &fold_vi(opt)) {
                                if first_raw.is_none() {
                                    first_raw = Some(r);
                                }
                                matched_vals.push(Value::String(opt.to_string()));
                            }
                        }
                        if let Some(raw) = first_raw {
                            return (Some(raw), Value::Array(matched_vals), 0.86);
                        }
                    }
                    return (None, Value::Null, 0.0);
                }
            }
        }
    }

    // 5. Boolean
    if schema_str.contains("\"boolean\"") {
        let key_lc = field_key.to_ascii_lowercase();
        let keywords: &[&str] = if key_lc.contains("owner") || key_lc.contains("chinh_chu") {
            &["chinh chu"]
        } else {
            &["can gap", "gap"]
        };
        for kw in keywords {
            if let Some(raw) = find_case_fold_span(text, kw) {
                return (Some(raw), Value::Bool(true), 0.90);
            }
        }
        return (None, Value::Null, 0.0);
    }

    // 6. Number (bedrooms, year, quantity, etc.)
    if schema_str.contains("\"number\"") {
        if let Some((raw, num)) = extract_number_by_key(field_key, text) {
            return (Some(raw), json!(num), 0.92);
        }
        return (None, Value::Null, 0.0);
    }

    // 7. Date (`pattern: ^\d{4}-\d{2}-\d{2}`)
    if schema_str.contains("\\d{4}-\\d{2}-\\d{2}") {
        let iso_re = Regex::new(r"\b(\d{4}-\d{2}-\d{2})\b").expect("iso date re");
        if let Some(m) = iso_re.find(text) {
            let s = m.as_str().to_string();
            return (Some(s.clone()), Value::String(s), 0.95);
        }
        return (None, Value::Null, 0.0);
    }

    // 8. String fields (`phone`, `url`, `text`)
    let key_lc = field_key.to_ascii_lowercase();
    if key_lc.contains("phone") || key_lc.contains("sdt") || key_lc.contains("tel") {
        if let Some((raw, e164)) = extract_vn_phone(text) {
            return (Some(raw), Value::String(e164), 0.96);
        }
        return (None, Value::Null, 0.0);
    }

    if key_lc.contains("url") || key_lc.contains("link") {
        let url_re = Regex::new(r"https?://[^\s)\]>]+").expect("url re");
        if let Some(m) = url_re.find(text) {
            let u = m.as_str().to_string();
            return (Some(u.clone()), Value::String(u), 0.95);
        }
        return (None, Value::Null, 0.0);
    }

    (None, Value::Null, 0.0)
}

fn extract_vn_money(text: &str) -> Option<(String, Value)> {
    // Range first: e.g. `12-15tr/th`, `12 - 15 triệu/tháng`, `tầm 10-12 củ`
    let range_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*[-–~]\s*(\d+(?:[.,]\d+)?)\s*(tỷ|ty|tỉ|ti|triệu|trieu|tr|củ|cu|k|nghìn|nghin)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?",
    )
    .expect("money range re");
    if let Some(caps) = range_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let min_num = parse_decimal(&caps[1])?;
        let max_num = parse_decimal(&caps[2])?;
        let mult = unit_multiplier(&caps[3]);
        let period = caps.get(4).and_then(|m| normalize_period(m.as_str()));
        let min_vnd = (min_num * mult).round();
        let max_vnd = (max_num * mult).round();
        return Some((
            full,
            json!({
                "min": min_vnd,
                "max": max_vnd,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    // Shorthand compound: `3tr5`, `13tr5/tháng`, `2 tỷ 3`
    let compound_re = Regex::new(
        r"(?i)(\d+)\s*(tỷ|ty|tỉ|ti|tr|triệu|trieu)\s*(\d)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?\b",
    )
    .expect("compound money re");
    if let Some(caps) = compound_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let major: f64 = caps[1].parse().ok()?;
        let minor: f64 = caps[3].parse().ok()?;
        let mult = unit_multiplier(&caps[2]);
        let amount = ((major + minor * 0.1) * mult).round();
        let period = caps.get(4).and_then(|m| normalize_period(m.as_str()));
        return Some((
            full,
            json!({
                "min": amount,
                "max": amount,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    // Single value: `15 triệu/tháng`, `dưới 15tr`, `450 triệu`, `15 củ`, `500k`
    let single_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*(tỷ|ty|tỉ|ti|triệu|trieu|tr|củ|cu|k|nghìn|nghin)(?:\s*/\s*(tháng|thang|th|năm|nam|ngày|ngay))?\b",
    )
    .expect("single money re");
    if let Some(caps) = single_re.captures(text) {
        let full = caps.get(0)?.as_str().to_string();
        let val = parse_decimal(&caps[1])?;
        let mult = unit_multiplier(&caps[2]);
        let amount = (val * mult).round();
        let period = caps.get(3).and_then(|m| normalize_period(m.as_str()));
        return Some((
            full,
            json!({
                "min": amount,
                "max": amount,
                "currency": "VND",
                "period": period
            }),
        ));
    }

    None
}

fn parse_decimal(s: &str) -> Option<f64> {
    s.replace(',', ".").parse::<f64>().ok()
}

fn unit_multiplier(unit: &str) -> f64 {
    match fold_vi(unit).as_str() {
        "ty" | "ti" => 1_000_000_000.0,
        "trieu" | "tr" | "cu" => 1_000_000.0,
        "k" | "nghin" => 1_000.0,
        _ => 1.0,
    }
}

fn normalize_period(raw_period: &str) -> Option<&'static str> {
    match fold_vi(raw_period).as_str() {
        "thang" | "th" => Some("month"),
        "nam" => Some("year"),
        "ngay" => Some("day"),
        _ => None,
    }
}

fn extract_vn_phone(text: &str) -> Option<(String, String)> {
    let phone_re = Regex::new(r"(?i)(?:\+84|0|[oO])(?:[\s.\-]*\d){8,10}").expect("phone re");
    for m in phone_re.find_iter(text) {
        let raw = m.as_str().trim().to_string();
        let mut digits = String::new();
        for (i, ch) in raw.chars().enumerate() {
            if i == 0 && (ch == 'o' || ch == 'O') {
                digits.push('0');
            } else if ch.is_ascii_digit() {
                digits.push(ch);
            }
        }
        let e164 = if raw.starts_with("+84") && (digits.len() == 11 || digits.len() == 12) {
            format!("+{digits}")
        } else if digits.starts_with('0') && (digits.len() == 10 || digits.len() == 11) {
            format!("+84{}", &digits[1..])
        } else {
            continue;
        };
        return Some((raw, e164));
    }
    None
}

fn extract_vn_area(text: &str) -> Option<(String, Value)> {
    let range_re = Regex::new(
        r"(?i)(\d+(?:[.,]\d+)?)\s*[-–~]\s*(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mét vuông|met vuong)",
    )
    .expect("area range re");
    if let Some(caps) = range_re.captures(text) {
        let raw = caps.get(0)?.as_str().to_string();
        let min_v = parse_decimal(&caps[1])?;
        let max_v = parse_decimal(&caps[2])?;
        return Some((raw, json!({ "min": min_v, "max": max_v, "unit": "m2" })));
    }

    let single_re = Regex::new(r"(?i)(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mét vuông|met vuong)")
        .expect("area single re");
    if let Some(caps) = single_re.captures(text) {
        let raw = caps.get(0)?.as_str().to_string();
        let v = parse_decimal(&caps[1])?;
        return Some((raw, json!({ "min": v, "max": v, "unit": "m2" })));
    }
    None
}

fn extract_number_by_key(field_key: &str, text: &str) -> Option<(String, f64)> {
    let key_lc = field_key.to_ascii_lowercase();
    if key_lc.contains("bed") || key_lc.contains("phong_ngu") || key_lc.contains("pn") {
        let re = Regex::new(r"(?i)\b(\d+)\s*(?:pn|phòng ngủ|phong ngu|ngủ|ngu)\b").expect("bed re");
        if let Some(caps) = re.captures(text) {
            let raw = caps.get(0)?.as_str().to_string();
            let n: f64 = caps[1].parse().ok()?;
            return Some((raw, n));
        }
    }
    let generic_re = Regex::new(r"\b(\d+(?:\.\d+)?)\b").expect("num re");
    let caps = generic_re.captures(text)?;
    let raw = caps.get(0)?.as_str().to_string();
    let n: f64 = caps[1].parse().ok()?;
    Some((raw, n))
}

fn match_enum_option(opts: &[Value], text: &str) -> Option<(String, String)> {
    for opt in opts.iter().filter_map(Value::as_str) {
        let opt_fold = fold_vi(opt);
        if let Some(raw) = find_case_fold_span(text, &opt_fold) {
            return Some((raw, opt.to_string()));
        }
        // Common Vietnamese synonyms for standard template enums
        let synonyms: &[&str] = match opt {
            "rent" => &["can thue", "cho thue", "thue"],
            "buy" => &["can mua", "mua"],
            "apartment" => &["can ho", "chung cu"],
            "house" => &["nha nguyen can", "nha rieng"],
            _ => &[],
        };
        for syn in synonyms {
            if let Some(raw) = find_case_fold_span(text, syn) {
                return Some((raw, opt.to_string()));
            }
        }
    }
    None
}

fn detect_location_in_text(text: &str) -> Option<(String, Value)> {
    const PLACES: &[(&[&str], &str, Option<&str>)] = &[
        (
            &["cau giay", "dich vong", "trung hoa", "nghia tan"],
            "Hà Nội",
            Some("Cầu Giấy"),
        ),
        (
            &["nam tu liem", "my dinh", "me tri"],
            "Hà Nội",
            Some("Nam Từ Liêm"),
        ),
        (&["bac tu liem"], "Hà Nội", Some("Bắc Từ Liêm")),
        (&["thanh xuan", "nhan chinh"], "Hà Nội", Some("Thanh Xuân")),
        (
            &["dong da", "lang ha", "chua lang"],
            "Hà Nội",
            Some("Đống Đa"),
        ),
        (&["ba dinh", "lieu giai"], "Hà Nội", Some("Ba Đình")),
        (&["tay ho", "ho tay"], "Hà Nội", Some("Tây Hồ")),
        (
            &["hai ba trung", "minh khai", "times city"],
            "Hà Nội",
            Some("Hai Bà Trưng"),
        ),
        (&["hoang mai", "linh dam"], "Hà Nội", Some("Hoàng Mai")),
        (&["long bien"], "Hà Nội", Some("Long Biên")),
        (&["ha dong"], "Hà Nội", Some("Hà Đông")),
        (&["hoan kiem"], "Hà Nội", Some("Hoàn Kiếm")),
        (
            &["tp thu duc", "thu duc", "thao dien"],
            "TP. Hồ Chí Minh",
            Some("Thủ Đức"),
        ),
        (
            &["quan 7", "q7", "phu my hung"],
            "TP. Hồ Chí Minh",
            Some("Quận 7"),
        ),
        (&["quan 1", "q1"], "TP. Hồ Chí Minh", Some("Quận 1")),
        (&["quan 3", "q3"], "TP. Hồ Chí Minh", Some("Quận 3")),
        (&["binh thanh"], "TP. Hồ Chí Minh", Some("Bình Thạnh")),
        (&["go vap"], "TP. Hồ Chí Minh", Some("Gò Vấp")),
        (&["tan binh"], "TP. Hồ Chí Minh", Some("Tân Bình")),
        (&["phu nhuan"], "TP. Hồ Chí Minh", Some("Phú Nhuận")),
        (&["hai chau"], "Đà Nẵng", Some("Hải Châu")),
        (&["son tra"], "Đà Nẵng", Some("Sơn Trà")),
        (&["ha noi"], "Hà Nội", None),
        (&["tp.hcm", "tphcm", "sai gon"], "TP. Hồ Chí Minh", None),
        (&["da nang"], "Đà Nẵng", None),
    ];

    for (aliases, province, district) in PLACES {
        for alias in *aliases {
            if let Some(raw) = find_case_fold_span(text, alias) {
                return Some((
                    raw.clone(),
                    json!({
                        "raw": raw,
                        "province": province,
                        "district": district,
                        "ward": Value::Null
                    }),
                ));
            }
        }
    }

    None
}

/// Finds an exact verbatim character slice of `original` whose diacritic-folded text matches
/// `needle_folded` on word boundaries, guaranteeing `raw` is always an exact substring of `original`!
fn find_case_fold_span(original: &str, needle_folded: &str) -> Option<String> {
    if needle_folded.is_empty() {
        return None;
    }

    // Map each character index in `folded` back to `(orig_byte_start, orig_byte_end)` in `original`.
    let mut folded = String::with_capacity(original.len());
    let mut byte_ranges: Vec<(usize, usize)> = Vec::with_capacity(original.len());

    for (byte_idx, ch) in original.char_indices() {
        let ch_end = byte_idx + ch.len_utf8();
        let piece = fold_vi(&ch.to_string());
        for fc in piece.chars() {
            folded.push(fc);
            byte_ranges.push((byte_idx, ch_end));
        }
    }

    // Since `folded` here contains only ASCII/BMP single-byte chars for ASCII `needle_folded`,
    // work with char indices safely.
    let folded_chars: Vec<char> = folded.chars().collect();
    let needle_chars: Vec<char> = needle_folded.chars().collect();
    if needle_chars.len() > folded_chars.len() {
        return None;
    }

    for start in 0..=(folded_chars.len() - needle_chars.len()) {
        if folded_chars[start..start + needle_chars.len()] == needle_chars[..] {
            let before_ok = start == 0 || !folded_chars[start - 1].is_alphanumeric();
            let end = start + needle_chars.len();
            let after_ok = end == folded_chars.len() || !folded_chars[end].is_alphanumeric();
            if before_ok && after_ok {
                let orig_start = byte_ranges[start].0;
                let orig_end = byte_ranges[end - 1].1;
                return Some(original[orig_start..orig_end].to_string());
            }
        }
    }

    None
}

fn heuristic_compile_rules(prompt: &str) -> Value {
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
