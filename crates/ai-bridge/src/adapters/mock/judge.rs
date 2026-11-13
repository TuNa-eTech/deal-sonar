//! Heuristic judge/extract responses parsed from the judge prompt.

use super::*;

pub(super) struct ParsedPromptPost {
    pub(super) r#ref: u32,
    pub(super) text: String,
}

pub(super) fn parse_posts_from_judge_prompt(prompt: &str) -> Vec<ParsedPromptPost> {
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

pub(super) fn heuristic_judge_extract(prompt: &str, schema: &Value) -> Value {
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

pub(super) fn build_short_summary(text: &str, max_chars: usize) -> String {
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max_chars {
        return clean;
    }
    let prefix: String = clean.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{prefix}…")
}

pub(super) fn extract_field_for_schema(
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
