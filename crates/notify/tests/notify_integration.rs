use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dealsonar_notify::{
    build_feedback_callback_data, escape_html, evaluate_notify_policy, export_csv, export_xlsx,
    format_digest_html, format_domestic_phone, format_lead_alert, format_system_alert_html,
    format_vietnamese_money, sanitize_spreadsheet_cell, sign_webhook_body, telegram_channel_key,
    validate_webhook_url, verify_webhook_signature, webhook_channel_key, ChatRateLimiter,
    DigestLeadItem, ExportLeadRow, ExportOptions, ExtractedField, FieldDef, FieldSource, FieldType,
    InMemorySecretStore, KeyringSecretStore, LeadAlertInput, NotifyDecision, NotifyError,
    NotifyPolicyCheck, NotifySkipReason, PollUpdatesOptions, QuietHours, SecretStore, SecretString,
    SystemIncidentKind, TelegramClient, TelegramClientConfig, TelegramDeliveryOutcome,
    TelegramIncomingEvent, WebhookClient, WebhookDeliveryOutcome, WebhookLeadCreatedPayload,
    MAX_OUTBOX_QUEUE_AGE_MS, MAX_TELEGRAM_HTML_LEN, TELEGRAM_BOT_TOKEN_KEY, UTF8_BOM,
    WEBHOOK_SIGNATURE_HEADER,
};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// Minimal deterministic local HTTP mock server built on `tokio::net::TcpListener`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RecordedHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug, Clone)]
struct MockHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl MockHttpResponse {
    fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: value.to_string(),
        }
    }
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Option<RecordedHttpRequest> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end - 4]);
    let mut lines = header_str.split("\r\n");
    let request_line = lines.next()?;
    let mut req_parts = request_line.split_whitespace();
    let method = req_parts.next()?.to_string();
    let path = req_parts.next()?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_len = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);

    while buf.len() < header_end + content_len {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let body = buf[header_end..(header_end + content_len).min(buf.len())].to_vec();
    Some(RecordedHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn spawn_mock_http_server<F>(handler: F) -> (String, Arc<Mutex<Vec<RecordedHttpRequest>>>)
where
    F: Fn(&RecordedHttpRequest) -> MockHttpResponse + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local mock listener");
    let addr = listener.local_addr().expect("local addr");
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded_clone = Arc::clone(&recorded);
    let handler = Arc::new(handler);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let rec = Arc::clone(&recorded_clone);
            let h = Arc::clone(&handler);
            tokio::spawn(async move {
                if let Some(req) = read_http_request(&mut stream).await {
                    let resp = h(&req);
                    rec.lock().unwrap().push(req);

                    let reason = match resp.status {
                        200 => "OK",
                        202 => "Accepted",
                        400 => "Bad Request",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        429 => "Too Many Requests",
                        500 => "Internal Server Error",
                        502 => "Bad Gateway",
                        _ => "Status",
                    };
                    let body_bytes = resp.body.as_bytes();
                    let mut raw_resp = format!(
                        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        resp.status,
                        reason,
                        body_bytes.len()
                    );
                    for (k, v) in &resp.headers {
                        raw_resp.push_str(&format!("{k}: {v}\r\n"));
                    }
                    raw_resp.push_str("\r\n");
                    let _ = stream.write_all(raw_resp.as_bytes()).await;
                    let _ = stream.write_all(body_bytes).await;
                    let _ = stream.shutdown().await;
                }
            });
        }
    });

    (format!("http://127.0.0.1:{}", addr.port()), recorded)
}

fn sample_radar_fields() -> Vec<FieldDef> {
    vec![
        FieldDef {
            key: "price".to_string(),
            label: "Giá".to_string(),
            r#type: FieldType::Money,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 1,
        },
        FieldDef {
            key: "area_loc".to_string(),
            label: "Khu vực".to_string(),
            r#type: FieldType::Location,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 2,
        },
        FieldDef {
            key: "bedrooms".to_string(),
            label: "Phòng ngủ".to_string(),
            r#type: FieldType::Number,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 3,
        },
        FieldDef {
            key: "phone".to_string(),
            label: "SĐT".to_string(),
            r#type: FieldType::Phone,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 4,
        },
        FieldDef {
            key: "size".to_string(),
            label: "Diện tích".to_string(),
            r#type: FieldType::Range,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 5,
        },
        FieldDef {
            key: "owner".to_string(),
            label: "Chính chủ".to_string(),
            r#type: FieldType::Boolean,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 6,
        },
        FieldDef {
            key: "amenities".to_string(),
            label: "Tiện ích".to_string(),
            r#type: FieldType::MultiEnum,
            description: String::new(),
            required: false,
            options: Some(vec!["điều hoà".to_string(), "máy giặt".to_string()]),
            show_in_alert: true,
            order: 7,
        },
        FieldDef {
            key: "hidden_note".to_string(),
            label: "Ghi chú ẩn".to_string(),
            r#type: FieldType::Text,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: false,
            order: 8,
        },
    ]
}

// ===========================================================================
// 1. Secret Storage & Zero-Leak Debug Redaction Tests
// ===========================================================================

#[test]
fn secret_store_crud_and_redacted_debug() {
    let store = InMemorySecretStore::new();
    let tg_key = telegram_channel_key("01JCF9CHANNEL1");
    let wh_key = webhook_channel_key("01JCF9WEBHOOK1");
    let super_secret_token = "99887766:AAH-SUPER-SECRET-BOT-TOKEN-XYZ";
    let super_secret_hmac = "whsec_top_secret_signing_key_999";

    assert_eq!(tg_key, "telegram:01JCF9CHANNEL1");
    assert_eq!(wh_key, "webhook:01JCF9WEBHOOK1");
    assert_eq!(TELEGRAM_BOT_TOKEN_KEY, "telegram:bot_token");

    assert_eq!(store.get_secret(&tg_key).unwrap(), None);
    store
        .set_secret(TELEGRAM_BOT_TOKEN_KEY, super_secret_token)
        .unwrap();
    store.set_secret(&tg_key, super_secret_token).unwrap();
    store.set_secret(&wh_key, super_secret_hmac).unwrap();

    assert_eq!(
        store.get_secret(&tg_key).unwrap().as_deref(),
        Some(super_secret_token)
    );
    assert_eq!(
        store.get_secret(&wh_key).unwrap().as_deref(),
        Some(super_secret_hmac)
    );

    // Ensure Debug output NEVER contains any secret value!
    let debug_store = format!("{store:?}");
    assert!(debug_store.contains("[REDACTED]"));
    assert!(!debug_store.contains(super_secret_token));
    assert!(!debug_store.contains(super_secret_hmac));

    let secret_str = SecretString::new(super_secret_token);
    assert_eq!(format!("{secret_str:?}"), "[REDACTED]");
    assert_eq!(format!("{secret_str}"), "[REDACTED]");
    assert_eq!(secret_str.expose_secret(), super_secret_token);

    let keyring_store = KeyringSecretStore::new();
    let debug_keyring = format!("{keyring_store:?}");
    assert!(debug_keyring.contains("DealSonar"));
    assert!(debug_keyring.contains("[REDACTED]"));

    store.delete_secret(&wh_key).unwrap();
    assert_eq!(store.get_secret(&wh_key).unwrap(), None);

    store.delete_all_known().unwrap();
    assert_eq!(store.get_secret(&tg_key).unwrap(), None);
    assert_eq!(store.get_secret(TELEGRAM_BOT_TOKEN_KEY).unwrap(), None);
    assert!(store.is_empty());
}

// ===========================================================================
// 2. HTML Escaping, Field Formatting, Truncation & Policy Tests
// ===========================================================================

#[test]
fn currency_and_domestic_phone_formatting() {
    assert_eq!(
        format_vietnamese_money(
            &json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"})
        )
        .as_deref(),
        Some("12–15 triệu/tháng")
    );
    assert_eq!(
        format_vietnamese_money(
            &json!({"min": 2_300_000_000_i64, "max": 2_300_000_000_i64, "currency": "VND"})
        )
        .as_deref(),
        Some("2,3 tỷ")
    );
    assert_eq!(
        format_vietnamese_money(&json!({"min": 500_000, "max": 500_000, "currency": "VND"}))
            .as_deref(),
        Some("500 nghìn")
    );
    assert_eq!(format_domestic_phone("+84912345678"), "0912 345 678");
    assert_eq!(format_domestic_phone("84987654321"), "0987 654 321");
}

#[test]
fn lead_alert_exact_layout_and_xss_html_escaping() {
    let mut extracted = HashMap::new();
    extracted.insert(
        "price".to_string(),
        ExtractedField {
            value: json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"}),
            raw: "12-15tr".to_string(),
            confidence: 0.95,
            source: FieldSource::Ai,
        },
    );
    extracted.insert(
        "area_loc".to_string(),
        ExtractedField {
            value: json!({"raw": "khu cầu giấy", "province": "Hà Nội", "district": "Cầu Giấy"}),
            raw: "khu cầu giấy".to_string(),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );
    extracted.insert(
        "bedrooms".to_string(),
        ExtractedField {
            value: json!(2),
            raw: "2PN".to_string(),
            confidence: 0.99,
            source: FieldSource::Rule,
        },
    );
    extracted.insert(
        "phone".to_string(),
        ExtractedField {
            value: json!("+84912345678"),
            raw: "0912.345.678".to_string(),
            confidence: 1.0,
            source: FieldSource::Rule,
        },
    );
    extracted.insert(
        "size".to_string(),
        ExtractedField {
            value: json!({"min": 50, "max": 70, "unit": "m2"}),
            raw: "50-70m2".to_string(),
            confidence: 0.9,
            source: FieldSource::Ai,
        },
    );
    extracted.insert(
        "owner".to_string(),
        ExtractedField {
            value: json!(true),
            raw: "chính chủ".to_string(),
            confidence: 0.85,
            source: FieldSource::Ai,
        },
    );
    extracted.insert(
        "amenities".to_string(),
        ExtractedField {
            value: json!(["điều hoà", "máy giặt"]),
            raw: "điều hoà, máy giặt".to_string(),
            confidence: 0.88,
            source: FieldSource::Ai,
        },
    );
    extracted.insert(
        "hidden_note".to_string(),
        ExtractedField {
            value: json!("MUST NOT SHOW"),
            raw: "secret".to_string(),
            confidence: 1.0,
            source: FieldSource::Ai,
        },
    );

    let now_ms = 1_794_384_300_000_i64;
    let five_min_ago = now_ms - 5 * 60 * 1000;
    let lead_id = "01JCF3ABCDEFGHJKMNPQRSTVWX";
    let permalink = "https://www.facebook.com/groups/123456789/posts/987654321/";

    let alert = format_lead_alert(&LeadAlertInput {
        lead_id: lead_id.to_string(),
        radar_name: "Khách thuê <script>&căn hộ</script>".to_string(),
        summary: "Cần thuê <b>2PN</b> & ở ngay <img src=x onerror=alert(1)>".to_string(),
        field_defs: sample_radar_fields(),
        extracted_fields: extracted,
        group_name: "Hội thuê nhà <Cầu Giấy> & HN".to_string(),
        author_name: Some("Nguyễn <Văn> & A".to_string()),
        post_created_at_ms: Some(five_min_ago),
        now_ms,
        other_group_count: 2,
        permalink: permalink.to_string(),
    })
    .expect("format lead alert");

    assert!(alert
        .html
        .starts_with("🎯 <b>Khách thuê &lt;script&gt;&amp;căn hộ&lt;/script&gt;</b>\n\n"));
    assert!(alert.html.contains(
        "Cần thuê &lt;b&gt;2PN&lt;/b&gt; &amp; ở ngay &lt;img src=x onerror=alert(1)&gt;"
    ));
    assert!(alert.html.contains("• Giá: 12–15 triệu/tháng"));
    assert!(alert.html.contains("• Khu vực: Cầu Giấy, Hà Nội"));
    assert!(alert.html.contains("• Phòng ngủ: 2"));
    assert!(alert.html.contains("• SĐT: 0912 345 678"));
    assert!(alert.html.contains("• Diện tích: 50–70 m2"));
    assert!(alert.html.contains("• Chính chủ: Có"));
    assert!(alert.html.contains("• Tiện ích: điều hoà, máy giặt"));
    assert!(!alert.html.contains("MUST NOT SHOW"));
    assert!(alert.html.contains(
        "👥 Hội thuê nhà &lt;Cầu Giấy&gt; &amp; HN · Nguyễn &lt;Văn&gt; &amp; A · 5 phút trước"
    ));
    assert!(alert.html.contains("🔁 Cũng xuất hiện ở 2 group khác"));
    assert!(!alert.html.contains("<script>"));
    assert!(!alert.html.contains("<img"));

    // Verify inline keyboard & < 64 byte callback_data invariant
    assert_eq!(alert.reply_markup.inline_keyboard.len(), 1);
    let row = &alert.reply_markup.inline_keyboard[0];
    assert_eq!(row.len(), 3);
    assert_eq!(row[0].text, "Mở bài viết");
    assert_eq!(row[0].url.as_deref(), Some(permalink));
    assert_eq!(row[1].text, "✅ Đúng");
    assert_eq!(
        row[1].callback_data.as_deref(),
        Some("fb:01JCF3ABCDEFGHJKMNPQRSTVWX:correct")
    );
    assert_eq!(row[2].text, "❌ Sai");
    assert_eq!(
        row[2].callback_data.as_deref(),
        Some("fb:01JCF3ABCDEFGHJKMNPQRSTVWX:wrong")
    );
    for btn in row {
        if let Some(cb) = &btn.callback_data {
            assert!(cb.len() < 64, "callback_data exceeded <64 bytes: {cb}");
        }
    }
}

#[test]
fn smart_4096_truncation_keeps_valid_html_and_intact_permalink() {
    let permalink = "https://www.facebook.com/groups/999999999/posts/888888888888888/?ref=share";
    let adversarial_chunk = "<script>alert('xss')&</script> Cần thuê mặt bằng gấp! ";
    let huge_summary = adversarial_chunk.repeat(120); // > 6000 raw chars, > 10000 escaped chars!
    let huge_text_field = adversarial_chunk.repeat(100);

    let fields = vec![FieldDef {
        key: "detail".to_string(),
        label: "Chi tiết <khách>".to_string(),
        r#type: FieldType::Text,
        description: String::new(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 1,
    }];
    let mut extracted = HashMap::new();
    extracted.insert(
        "detail".to_string(),
        ExtractedField {
            value: json!(huge_text_field),
            raw: "raw".to_string(),
            confidence: 0.9,
            source: FieldSource::Ai,
        },
    );

    let alert = format_lead_alert(&LeadAlertInput {
        lead_id: "01JCF3ABCDEFGHJKMNPQRSTVWX".to_string(),
        radar_name: "Radar Mặt Bằng & Kho".to_string(),
        summary: huge_summary,
        field_defs: fields,
        extracted_fields: extracted,
        group_name: "Group BĐS".to_string(),
        author_name: None,
        post_created_at_ms: None,
        now_ms: 1_794_384_300_000,
        other_group_count: 0,
        permalink: permalink.to_string(),
    })
    .expect("truncate cleanly");

    assert!(alert.html.chars().count() <= MAX_TELEGRAM_HTML_LEN);
    assert!(alert.html.encode_utf16().count() <= MAX_TELEGRAM_HTML_LEN);
    assert!(alert.html.contains("vừa thấy"));
    assert!(!alert.html.contains("Cũng xuất hiện ở"));

    // Permalink MUST NEVER be truncated!
    assert_eq!(
        alert.reply_markup.inline_keyboard[0][0].url.as_deref(),
        Some(permalink)
    );

    // Verify HTML tags and entities are completely intact (only one `<b>` and `</b>` pair,
    // zero stray `<` or `>` outside `<b>`/`</b>`, and every `&` starts `&amp;`, `&lt;`, or `&gt;`).
    let stripped_bold = alert.html.replacen("<b>", "", 1).replacen("</b>", "", 1);
    assert!(
        !stripped_bold.contains('<') && !stripped_bold.contains('>'),
        "found unescaped < or > after truncation"
    );
    let mut rest = stripped_bold.as_str();
    while let Some(idx) = rest.find('&') {
        let tail = &rest[idx..];
        assert!(
            tail.starts_with("&amp;") || tail.starts_with("&lt;") || tail.starts_with("&gt;"),
            "broken HTML entity after truncation near: {}",
            &tail[..tail.len().min(12)]
        );
        rest = &tail[1..];
    }
}

#[test]
fn rejects_oversized_callback_data_and_non_https_permalink() {
    let long_id = "X".repeat(55);
    assert!(matches!(
        build_feedback_callback_data(&long_id, "irrelevant"),
        Err(NotifyError::InvalidCallbackData { .. })
    ));

    let res = format_lead_alert(&LeadAlertInput {
        lead_id: "01JCF3ABCDEFGHJKMNPQRSTVWX".to_string(),
        radar_name: "Test".to_string(),
        summary: "Summary".to_string(),
        field_defs: vec![],
        extracted_fields: HashMap::new(),
        group_name: "Group".to_string(),
        author_name: None,
        post_created_at_ms: None,
        now_ms: 0,
        other_group_count: 0,
        permalink: "http://www.facebook.com/groups/1/posts/2".to_string(),
    });
    assert!(matches!(res, Err(NotifyError::InvalidPermalink(_))));
}

#[test]
fn digest_system_alerts_rate_limiter_and_notify_policy() {
    let leads: Vec<DigestLeadItem> = (1..=12)
        .map(|i| DigestLeadItem {
            lead_id: format!("01JCF3LEAD{i:016}"),
            summary: format!("Tin số {i} <script>&test"),
            score: 0.9,
            source_name: Some("Hội <A>".to_string()),
            permalink: Some(format!("https://www.facebook.com/groups/1/posts/{i}")),
        })
        .collect();
    let digest = format_digest_html("Radar <BĐS>", &leads, 3);
    assert!(digest.contains("📋 <b>Gộp tin: Radar &lt;BĐS&gt;</b>"));
    assert!(digest.contains("10. Tin số 10 &lt;script&gt;&amp;test"));
    assert!(!digest.contains("11. Tin số 11"));
    assert!(digest.contains("… và 5 tin khác")); // 2 overflow from 12 + 3 remaining

    // All 4 system incidents + flood auto-digest notice
    assert!(
        format_system_alert_html(&SystemIncidentKind::FacebookSessionIssue, false)
            .contains("DealSonar đã dừng quét vì Facebook yêu cầu đăng nhập lại / xác minh")
    );
    assert!(
        format_system_alert_html(&SystemIncidentKind::ExtensionDisconnected, false)
            .contains("Không thấy Chrome. Radar đang tạm ngừng")
    );
    assert!(format_system_alert_html(
        &SystemIncidentKind::AiUnavailable { pending_posts: 14 },
        false
    )
    .contains("Không gọi được AI. 14 bài đang chờ"));
    assert!(
        format_system_alert_html(&SystemIncidentKind::ExtractorBroken, false)
            .contains("Facebook có thay đổi, cần cập nhật DealSonar")
    );
    let flood_msg = format_system_alert_html(
        &SystemIncidentKind::RadarFloodAutoDigest {
            radar_name: "Radar <Rộng>".to_string(),
            leads_last_hour: 35,
        },
        false,
    );
    assert!(flood_msg.contains("Radar &lt;Rộng&gt;"));
    assert!(flood_msg.contains("35 tin"));
    assert!(
        format_system_alert_html(&SystemIncidentKind::ExtractorBroken, true)
            .contains("Đã khôi phục")
    );

    // Rate limiter: 1 msg/sec per chat + 20 msg/min for group chat_id < 0
    let limiter = ChatRateLimiter::new();
    let t0 = Instant::now();
    assert_eq!(limiter.check_and_record(1001, t0), Ok(()));
    assert!(limiter
        .check_and_record(1001, t0 + Duration::from_millis(400))
        .is_err());
    assert_eq!(limiter.check_and_record(2002, t0), Ok(())); // separate chat unaffected
    assert_eq!(
        limiter.check_and_record(1001, t0 + Duration::from_secs(1)),
        Ok(())
    );

    let group_id = -100999888_i64;
    for i in 0..20 {
        assert_eq!(
            limiter.check_and_record(group_id, t0 + Duration::from_secs(i * 2)),
            Ok(())
        );
    }
    // 21st message at t = 40s must wait 20s until the 60s window frees slot 0!
    assert_eq!(
        limiter.check_and_record(group_id, t0 + Duration::from_secs(40)),
        Err(Duration::from_secs(20))
    );
    assert_eq!(
        limiter.check_and_record(group_id, t0 + Duration::from_secs(60)),
        Ok(())
    );

    // Delivery policy rules (§3)
    let quiet = QuietHours {
        from: "22:30".to_string(),
        to: "06:30".to_string(),
    };
    let mut check = NotifyPolicyCheck {
        radar_active: true,
        has_channels: true,
        digest_mode: false,
        score: 0.85,
        min_score: 0.6,
        is_cluster_head: true,
        repost_after_72h: false,
        captured_at_ms: 1_000_000,
        decided_at_ms: 1_005_000,
        quiet_hours: Some(&quiet),
        local_hour: 10,
        local_minute: 15,
        is_preview_or_backfill: false,
        leads_in_last_hour: 5,
    };
    assert_eq!(
        evaluate_notify_policy(&check),
        NotifyDecision::SendInstant {
            trigger_flood_auto_digest: false
        }
    );
    check.local_hour = 23;
    assert_eq!(
        evaluate_notify_policy(&check),
        NotifyDecision::QueueDigest {
            trigger_flood_auto_digest: false
        }
    );
    check.local_hour = 11;
    check.leads_in_last_hour = 31;
    assert_eq!(
        evaluate_notify_policy(&check),
        NotifyDecision::QueueDigest {
            trigger_flood_auto_digest: true
        }
    );
    check.is_preview_or_backfill = true;
    assert_eq!(
        evaluate_notify_policy(&check),
        NotifyDecision::Skip(NotifySkipReason::PreviewOrBackfill)
    );
}

// ===========================================================================
// 3. Telegram Mock HTTP Server End-to-End Tests (`sendMessage`, 429, 401/403, `getUpdates`)
// ===========================================================================

#[tokio::test]
async fn telegram_mock_server_send_429_auth_revoked_and_get_updates_flow() {
    let token = "123456:MOCK-SECRET-TOKEN";
    let lead_id = "01JCF3ABCDEFGHJKMNPQRSTVWX";
    let step = Arc::new(Mutex::new(0usize));
    let step_clone = Arc::clone(&step);

    let (base_url, requests) = spawn_mock_http_server(move |req| {
        if req.path.ends_with("/getMe") {
            return MockHttpResponse::json(
                200,
                json!({
                    "ok": true,
                    "result": {
                        "id": 777000,
                        "username": "dealsonar_test_bot",
                        "first_name": "DealSonar Bot"
                    }
                }),
            );
        }

        if req.path.ends_with("/sendMessage") {
            let mut idx = step_clone.lock().unwrap();
            let current = *idx;
            *idx += 1;
            return match current {
                0 => MockHttpResponse::json(200, json!({"ok": true, "result": {"message_id": 901}})),
                1 => MockHttpResponse::json(
                    429,
                    json!({
                        "ok": false,
                        "error_code": 429,
                        "description": "Too Many Requests: retry after 23",
                        "parameters": { "retry_after": 23 }
                    }),
                ),
                2 => MockHttpResponse::json(
                    401,
                    json!({ "ok": false, "error_code": 401, "description": "Unauthorized" }),
                ),
                3 => MockHttpResponse::json(
                    403,
                    json!({ "ok": false, "error_code": 403, "description": "Forbidden: bot was blocked by the user" }),
                ),
                _ => MockHttpResponse::json(
                    502,
                    json!({ "ok": false, "error_code": 502, "description": "Bad Gateway" }),
                ),
            };
        }

        if req.path.ends_with("/editMessageReplyMarkup") || req.path.ends_with("/answerCallbackQuery") {
            return MockHttpResponse::json(200, json!({ "ok": true, "result": true }));
        }

        if req.path.ends_with("/getUpdates") {
            let body_json: serde_json::Value =
                serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            let offset = body_json.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);
            if offset == 0 {
                // Batch 1: /start, /start@dealsonar_test_bot in group, fb:<id>:wrong from registered chat,
                // plus malicious fb:<id>:correct and /pause from UNREGISTERED chat 999999!
                return MockHttpResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "result": [
                            {
                                "update_id": 100,
                                "message": {
                                    "message_id": 1,
                                    "chat": { "id": 55501, "type": "private", "first_name": "Minh", "last_name": "Anh" },
                                    "text": "/start"
                                }
                            },
                            {
                                "update_id": 101,
                                "message": {
                                    "message_id": 2,
                                    "chat": { "id": -100222333, "type": "supergroup", "title": "Team Sale Cầu Giấy" },
                                    "text": "/start@dealsonar_test_bot"
                                }
                            },
                            {
                                "update_id": 102,
                                "callback_query": {
                                    "id": "cb_wrong_1",
                                    "data": format!("fb:{lead_id}:wrong"),
                                    "message": {
                                        "message_id": 901,
                                        "chat": { "id": 55501, "type": "private" },
                                        "reply_markup": {
                                            "inline_keyboard": [[
                                                { "text": "Mở bài viết", "url": "https://www.facebook.com/groups/1/posts/2" },
                                                { "text": "✅ Đúng", "callback_data": format!("fb:{lead_id}:correct") },
                                                { "text": "❌ Sai", "callback_data": format!("fb:{lead_id}:wrong") }
                                            ]]
                                        }
                                    }
                                }
                            },
                            {
                                "update_id": 103,
                                "callback_query": {
                                    "id": "cb_unauth_1",
                                    "data": format!("fb:{lead_id}:correct"),
                                    "message": {
                                        "message_id": 999,
                                        "chat": { "id": 999999, "type": "private" }
                                    }
                                }
                            },
                            {
                                "update_id": 104,
                                "message": {
                                    "message_id": 3,
                                    "chat": { "id": 999999, "type": "private" },
                                    "text": "/pause"
                                }
                            }
                        ]
                    }),
                );
            } else {
                // Batch 2: user clicks reason button `fb:<id>:peer` on the updated keyboard, plus `/status`
                return MockHttpResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "result": [
                            {
                                "update_id": 105,
                                "callback_query": {
                                    "id": "cb_reason_peer",
                                    "data": format!("fb:{lead_id}:peer"),
                                    "message": {
                                        "message_id": 901,
                                        "chat": { "id": 55501, "type": "private" },
                                        "reply_markup": {
                                            "inline_keyboard": [
                                                [{ "text": "Mở bài viết", "url": "https://www.facebook.com/groups/1/posts/2" }],
                                                [
                                                    { "text": "Không liên quan", "callback_data": format!("fb:{lead_id}:irrelevant") },
                                                    { "text": "Cùng nghề", "callback_data": format!("fb:{lead_id}:peer") }
                                                ],
                                                [
                                                    { "text": "Trùng", "callback_data": format!("fb:{lead_id}:duplicate") },
                                                    { "text": "Rác", "callback_data": format!("fb:{lead_id}:spam") }
                                                ]
                                            ]
                                        }
                                    }
                                }
                            },
                            {
                                "update_id": 106,
                                "message": {
                                    "message_id": 4,
                                    "chat": { "id": 55501, "type": "private" },
                                    "text": "/status"
                                }
                            }
                        ]
                    }),
                );
            }
        }

        MockHttpResponse::json(404, json!({"ok": false, "error_code": 404}))
    })
    .await;

    let client = TelegramClient::with_config(TelegramClientConfig {
        api_base_url: base_url,
        request_timeout: Duration::from_secs(5),
        enforce_rate_limits: false,
    })
    .unwrap();

    // 1) getMe
    let bot = client.get_me(token).await.expect("getMe ok");
    assert_eq!(bot.id, 777000);
    assert_eq!(bot.username, "dealsonar_test_bot");
    assert_eq!(bot.first_name, "DealSonar Bot");

    // 2) sendMessage outcomes: Sent -> RateLimited(23) -> AuthRevoked(401) -> AuthRevoked(403) -> RetryableNetwork -> Dropped(>2h)
    let alert = format_lead_alert(&LeadAlertInput {
        lead_id: lead_id.to_string(),
        radar_name: "Radar Test".to_string(),
        summary: "Khách cần mua".to_string(),
        field_defs: vec![],
        extracted_fields: HashMap::new(),
        group_name: "Group 1".to_string(),
        author_name: Some("An".to_string()),
        post_created_at_ms: None,
        now_ms: 1_700_000_000_000,
        other_group_count: 0,
        permalink: "https://www.facebook.com/groups/1/posts/2".to_string(),
    })
    .unwrap();

    let req = dealsonar_notify::SendMessageRequest::html(
        55501,
        alert.html.clone(),
        Some(alert.reply_markup.clone()),
    );

    assert_eq!(
        client.deliver_outbox_message(token, &req, 0, 0).await,
        TelegramDeliveryOutcome::Sent { message_id: 901 }
    );
    assert_eq!(
        client.deliver_outbox_message(token, &req, 0, 0).await,
        TelegramDeliveryOutcome::RateLimited { retry_after_s: 23 }
    );
    assert_eq!(
        client.deliver_outbox_message(token, &req, 0, 0).await,
        TelegramDeliveryOutcome::AuthRevoked
    );
    assert_eq!(
        client.deliver_outbox_message(token, &req, 0, 0).await,
        TelegramDeliveryOutcome::AuthRevoked
    );
    assert_eq!(
        client.deliver_outbox_message(token, &req, 0, 0).await,
        TelegramDeliveryOutcome::RetryableNetwork { next_delay_s: 10 }
    );
    assert_eq!(
        client.deliver_outbox_message(token, &req, 4, 0).await,
        TelegramDeliveryOutcome::RetryableNetwork { next_delay_s: 600 }
    );
    assert!(matches!(
        client.deliver_outbox_message(token, &req, 5, 0).await,
        TelegramDeliveryOutcome::Dropped { .. }
    ));
    assert!(matches!(
        client
            .deliver_outbox_message(token, &req, 0, MAX_OUTBOX_QUEUE_AGE_MS + 1)
            .await,
        TelegramDeliveryOutcome::Dropped { .. }
    ));

    // 3) getUpdates Batch 1 (`/start`, `/start@bot`, `fb:<id>:wrong` -> reason keyboard, unregistered chat rejected!)
    let mut registered = HashSet::new();
    registered.insert(55501_i64);

    let batch1 = client
        .poll_updates(
            token,
            &PollUpdatesOptions {
                offset: None,
                timeout_s: 1,
                bot_username: Some("dealsonar_test_bot".to_string()),
                registered_chat_ids: registered.clone(),
            },
        )
        .await
        .expect("poll batch 1");

    assert_eq!(batch1.next_offset, Some(105));
    assert_eq!(batch1.rejected_unregistered_count, 2); // chat 999999 callback + /pause rejected!
    assert_eq!(
        batch1.events,
        vec![
            TelegramIncomingEvent::StartCommand {
                chat_id: 55501,
                chat_title: "Minh Anh".to_string(),
                is_group: false,
            },
            TelegramIncomingEvent::StartCommand {
                chat_id: -100222333,
                chat_title: "Team Sale Cầu Giấy".to_string(),
                is_group: true,
            },
        ]
    );

    // Verify `editMessageReplyMarkup` sent the 4 reason buttons for `fb:<id>:wrong` (and NONE for chat 999999)
    {
        let recorded = requests.lock().unwrap();
        let edits: Vec<&RecordedHttpRequest> = recorded
            .iter()
            .filter(|r| r.path.ends_with("/editMessageReplyMarkup"))
            .collect();
        assert_eq!(edits.len(), 1);
        let edit_json: serde_json::Value = serde_json::from_slice(&edits[0].body).unwrap();
        assert_eq!(edit_json["chat_id"], 55501);
        let edit_str = edit_json.to_string();
        assert!(edit_str.contains("Không liên quan"));
        assert!(edit_str.contains(&format!("fb:{lead_id}:irrelevant")));
        assert!(edit_str.contains("Cùng nghề"));
        assert!(edit_str.contains(&format!("fb:{lead_id}:peer")));
        assert!(edit_str.contains("Trùng"));
        assert!(edit_str.contains(&format!("fb:{lead_id}:duplicate")));
        assert!(edit_str.contains("Rác"));
        assert!(edit_str.contains(&format!("fb:{lead_id}:spam")));
    }

    // 4) getUpdates Batch 2 (`fb:<id>:peer` -> `📝 Đã ghi nhận` + `LeadFeedback { label: "peer" }` + `/status`)
    let batch2 = client
        .poll_updates(
            token,
            &PollUpdatesOptions {
                offset: batch1.next_offset,
                timeout_s: 1,
                bot_username: Some("dealsonar_test_bot".to_string()),
                registered_chat_ids: registered,
            },
        )
        .await
        .expect("poll batch 2");

    assert_eq!(batch2.next_offset, Some(107));
    assert_eq!(batch2.rejected_unregistered_count, 0);
    assert_eq!(
        batch2.events,
        vec![
            TelegramIncomingEvent::LeadFeedback {
                chat_id: 55501,
                lead_id: lead_id.to_string(),
                label: "peer".to_string(),
            },
            TelegramIncomingEvent::StatusCommand { chat_id: 55501 },
        ]
    );

    // Verify second `editMessageReplyMarkup` changed button to `📝 Đã ghi nhận`
    {
        let recorded = requests.lock().unwrap();
        let edits: Vec<&RecordedHttpRequest> = recorded
            .iter()
            .filter(|r| r.path.ends_with("/editMessageReplyMarkup"))
            .collect();
        assert_eq!(edits.len(), 2);
        let second_edit_str = String::from_utf8_lossy(&edits[1].body);
        assert!(second_edit_str.contains("📝 Đã ghi nhận"));
    }
}

// ===========================================================================
// 4. CSV & XLSX Exporters + Spreadsheet Formula-Injection Protection Tests
// ===========================================================================

#[test]
fn csv_bom_crlf_composite_flattening_and_formula_injection_protection() {
    assert_eq!(
        sanitize_spreadsheet_cell("=CMD|' /C calc'!A0"),
        "'=CMD|' /C calc'!A0"
    );
    assert_eq!(sanitize_spreadsheet_cell("+84912345678"), "'+84912345678");
    assert_eq!(sanitize_spreadsheet_cell("-50% sale"), "'-50% sale");
    assert_eq!(sanitize_spreadsheet_cell("@evil_macro"), "'@evil_macro");
    assert_eq!(sanitize_spreadsheet_cell("\t=1+1"), "'\t=1+1");
    assert_eq!(sanitize_spreadsheet_cell("\r=1+1"), "'\r=1+1");
    assert_eq!(
        sanitize_spreadsheet_cell("   =SUM(A1:A5)"),
        "'   =SUM(A1:A5)"
    );
    assert_eq!(
        sanitize_spreadsheet_cell("Cần thuê chung cư Cầu Giấy"),
        "Cần thuê chung cư Cầu Giấy"
    );

    let fields = vec![
        FieldDef {
            key: "price".to_string(),
            label: "Giá thuê".to_string(),
            r#type: FieldType::Money,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 1,
        },
        FieldDef {
            key: "loc".to_string(),
            label: "Khu vực".to_string(),
            r#type: FieldType::Location,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 2,
        },
        FieldDef {
            key: "area".to_string(),
            label: "Diện tích".to_string(),
            r#type: FieldType::Range,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 3,
        },
        FieldDef {
            key: "phone".to_string(),
            label: "SĐT".to_string(),
            r#type: FieldType::Phone,
            description: String::new(),
            required: false,
            options: None,
            show_in_alert: true,
            order: 4,
        },
    ];

    let mut row_fields = HashMap::new();
    row_fields.insert(
        "price".to_string(),
        ExtractedField {
            value: json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"}),
            raw: "12-15tr".to_string(),
            confidence: 0.9,
            source: FieldSource::Ai,
        },
    );
    row_fields.insert(
        "loc".to_string(),
        ExtractedField {
            value: json!({"province": "Hà Nội", "district": "Cầu Giấy", "ward": "Dịch Vọng"}),
            raw: "Dịch Vọng Cầu Giấy".to_string(),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );
    row_fields.insert(
        "area".to_string(),
        ExtractedField {
            value: json!({"min": 50, "max": 70, "unit": "m2"}),
            raw: "50-70m2".to_string(),
            confidence: 0.9,
            source: FieldSource::Rule,
        },
    );
    row_fields.insert(
        "phone".to_string(),
        ExtractedField {
            value: json!("+84912345678"),
            raw: "+84912345678".to_string(),
            confidence: 1.0,
            source: FieldSource::Rule,
        },
    );

    let rows = vec![ExportLeadRow {
        post_created_at: Some(1_794_384_000_000),
        radar_name: "Khách thuê căn hộ".to_string(),
        status: "new".to_string(),
        score: 0.91,
        summary: "=CMD|' /C calc'!A0".to_string(),
        group_name: "Hội thuê nhà, Cầu Giấy".to_string(),
        author_name: "  @attacker".to_string(),
        permalink: "https://www.facebook.com/groups/123/posts/456/".to_string(),
        post_text: Some("+Bài viết có dấu phẩy, và \"ngoặc kép\"".to_string()),
        fields: row_fields,
    }];

    let csv_bytes = export_csv(
        &ExportOptions {
            include_post_text: true,
        },
        &fields,
        &rows,
    )
    .expect("export csv");

    // 1) UTF-8 BOM check
    assert_eq!(&csv_bytes[..3], &UTF8_BOM);
    let csv_str = std::str::from_utf8(&csv_bytes[3..]).expect("valid utf8 after BOM");

    // 2) CRLF line endings check
    let lines: Vec<&str> = csv_str.split("\r\n").collect();
    assert_eq!(lines.len(), 3); // header + 1 row + trailing empty after final \r\n
    assert_eq!(lines[2], "");

    // 3) Exact fixed + flattened composite column headers
    assert_eq!(
        lines[0],
        "Thời điểm đăng,Radar,Trạng thái,Điểm,Tóm tắt,Group,Tác giả,Liên kết,Nội dung,Giá thuê (từ),Giá thuê (đến),Giá thuê (đơn vị),Khu vực (tỉnh),Khu vực (quận),Khu vực (phường),Diện tích (từ),Diện tích (đến),SĐT"
    );

    // 4) Formula injection protection + composite values + RFC-4180 quoting
    let data_line = lines[1];
    assert!(data_line.contains(",'=CMD|' /C calc'!A0,"));
    assert!(data_line.contains(",\"Hội thuê nhà, Cầu Giấy\","));
    assert!(data_line.contains(",'  @attacker,"));
    assert!(data_line.contains(",\"'+Bài viết có dấu phẩy, và \"\"ngoặc kép\"\"\","));
    assert!(data_line
        .contains(",12000000,15000000,VND/month,Hà Nội,Cầu Giấy,Dịch Vọng,50,70,'+84912345678"));

    // 5) XLSX valid binary generation (`PK\x03\x04` header & non-empty worksheet)
    let xlsx_bytes = export_xlsx(
        &ExportOptions {
            include_post_text: false,
        },
        &fields,
        &rows,
    )
    .expect("export xlsx");
    assert!(xlsx_bytes.len() > 2000);
    assert_eq!(&xlsx_bytes[..4], b"PK\x03\x04");
}

// ===========================================================================
// 5. Webhook HMAC-SHA256 Signing, URL Validation & Retry Tests
// ===========================================================================

#[tokio::test]
async fn webhook_url_validation_hmac_verification_and_retries() {
    // URL scheme security checks
    assert!(validate_webhook_url("https://crm.example.com/webhooks/dealsonar").is_ok());
    assert!(validate_webhook_url("http://localhost:8080/hook").is_ok());
    assert!(validate_webhook_url("http://127.0.0.1:9090/hook").is_ok());

    assert!(matches!(
        validate_webhook_url("http://evil.com/hook"),
        Err(NotifyError::InsecureWebhookUrl(_))
    ));
    assert!(matches!(
        validate_webhook_url("http://localhost.evil.com/hook"),
        Err(NotifyError::InsecureWebhookUrl(_))
    ));
    assert!(matches!(
        validate_webhook_url("http://localhost@evil.com/hook"),
        Err(NotifyError::InsecureWebhookUrl(_))
    ));
    assert!(matches!(
        validate_webhook_url("ftp://localhost/hook"),
        Err(NotifyError::InsecureWebhookUrl(_))
    ));

    let secret = "whsec_dealsonar_integration_key";
    let attempts_counter = Arc::new(Mutex::new(0u32));
    let counter_clone = Arc::clone(&attempts_counter);

    let (base_url, recorded) = spawn_mock_http_server(move |req| {
        let mut c = counter_clone.lock().unwrap();
        *c += 1;
        if *c < 3 {
            MockHttpResponse::json(500, json!({"error": "temporary outage"}))
        } else {
            let sig = req
                .headers
                .get(&WEBHOOK_SIGNATURE_HEADER.to_ascii_lowercase())
                .cloned()
                .unwrap_or_default();
            assert!(
                verify_webhook_signature(secret, &req.body, &sig),
                "server-side HMAC signature verification failed"
            );
            MockHttpResponse::json(202, json!({"received": true}))
        }
    })
    .await;

    let mut extracted = HashMap::new();
    extracted.insert(
        "price".to_string(),
        ExtractedField {
            value: json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"}),
            raw: "tầm 12-15tr".to_string(),
            confidence: 0.91,
            source: FieldSource::Ai,
        },
    );

    let payload = WebhookLeadCreatedPayload::new_lead_created(
        1_794_384_905_000,
        "01JCF3RADAR1",
        "Khách thuê căn hộ Cầu Giấy",
        "01JCGLEAD1",
        0.91,
        "Cần thuê chung cư 2PN khu Cầu Giấy, 12–15 triệu, vào ở ngay",
        &extracted,
        "https://www.facebook.com/groups/123456789/posts/987654321/",
        Some(1_794_384_600_000),
        "Hội thuê nhà Cầu Giấy",
        "Nguyễn Văn A",
        Some("Nội dung gốc".to_string()),
    );

    let client = WebhookClient::with_timeout(Duration::from_secs(5)).unwrap();

    // Evil HTTP URL rejected before making any network request
    let evil_res = client
        .send_once("http://evil.com/steal", secret, &payload, 0)
        .await;
    assert!(matches!(evil_res, Err(NotifyError::InsecureWebhookUrl(_))));

    // Localhost HTTP URL succeeds on 3rd attempt (after 2 x HTTP 500 retries)
    let target_url = format!("{base_url}/webhook");
    let delays = [Duration::from_millis(5); 5];
    let outcome = client
        .send_with_retries(&target_url, secret, &payload, &delays)
        .await
        .expect("webhook send");
    assert_eq!(outcome, WebhookDeliveryOutcome::Sent { status_code: 202 });

    let reqs = recorded.lock().unwrap();
    assert_eq!(reqs.len(), 3);
    let last_req = &reqs[2];
    assert_eq!(last_req.method, "POST");
    assert_eq!(last_req.path, "/webhook");

    let sig_header = last_req
        .headers
        .get(&WEBHOOK_SIGNATURE_HEADER.to_ascii_lowercase())
        .expect("X-DealSonar-Signature header present");
    assert!(sig_header.starts_with("sha256="));
    assert_eq!(sig_header, &sign_webhook_body(secret, &last_req.body));
    assert!(verify_webhook_signature(secret, &last_req.body, sig_header));
    assert!(!verify_webhook_signature(
        "wrong_secret",
        &last_req.body,
        sig_header
    ));
    let mut tampered = last_req.body.clone();
    tampered.push(b' ');
    assert!(!verify_webhook_signature(secret, &tampered, sig_header));

    let body_json: serde_json::Value = serde_json::from_slice(&last_req.body).unwrap();
    assert_eq!(body_json["event"], "lead.created");
    assert_eq!(body_json["radar"]["id"], "01JCF3RADAR1");
    assert_eq!(body_json["lead"]["id"], "01JCGLEAD1");
    assert_eq!(body_json["lead"]["fields"]["price"]["raw"], "tầm 12-15tr");
    let _ = escape_html("ok");
}

#[tokio::test]
async fn telegram_correct_feedback_pause_resume_and_error_token_redaction() {
    let token = "999111222:SUPER-SENSITIVE-TOKEN-DO-NOT-LEAK";
    let lead_id = "01JCF3ABCDEFGHJKMNPQRSTVWX";

    let (base_url, requests) = spawn_mock_http_server(move |req| {
        if req.path.ends_with("/editMessageReplyMarkup")
            || req.path.ends_with("/answerCallbackQuery")
        {
            return MockHttpResponse::json(200, json!({ "ok": true, "result": true }));
        }
        if req.path.ends_with("/getUpdates") {
            return MockHttpResponse::json(
                200,
                json!({
                    "ok": true,
                    "result": [
                        {
                            "update_id": 200,
                            "callback_query": {
                                "id": "cb_correct_1",
                                "data": format!("fb:{lead_id}:correct"),
                                "message": {
                                    "message_id": 500,
                                    "chat": { "id": 777, "type": "private" },
                                    "reply_markup": {
                                        "inline_keyboard": [[
                                            { "text": "Mở bài viết", "url": "https://www.facebook.com/groups/1/posts/9" },
                                            { "text": "✅ Đúng", "callback_data": format!("fb:{lead_id}:correct") },
                                            { "text": "❌ Sai", "callback_data": format!("fb:{lead_id}:wrong") }
                                        ]]
                                    }
                                }
                            }
                        },
                        {
                            "update_id": 201,
                            "message": {
                                "message_id": 501,
                                "chat": { "id": 777, "type": "private" },
                                "text": "/pause"
                            }
                        },
                        {
                            "update_id": 202,
                            "message": {
                                "message_id": 502,
                                "chat": { "id": 777, "type": "private" },
                                "text": "/resume"
                            }
                        }
                    ]
                }),
            );
        }
        MockHttpResponse::json(404, json!({"ok": false}))
    })
    .await;

    let client = TelegramClient::with_base_url(base_url).unwrap();
    let mut registered = HashSet::new();
    registered.insert(777_i64);

    let batch = client
        .poll_updates(
            token,
            &PollUpdatesOptions {
                offset: None,
                timeout_s: 1,
                bot_username: None,
                registered_chat_ids: registered,
            },
        )
        .await
        .unwrap();

    assert_eq!(
        batch.events,
        vec![
            TelegramIncomingEvent::LeadFeedback {
                chat_id: 777,
                lead_id: lead_id.to_string(),
                label: "correct".to_string(),
            },
            TelegramIncomingEvent::PauseCommand { chat_id: 777 },
            TelegramIncomingEvent::ResumeCommand { chat_id: 777 },
        ]
    );

    {
        let recorded = requests.lock().unwrap();
        let edit_req = recorded
            .iter()
            .find(|r| r.path.ends_with("/editMessageReplyMarkup"))
            .expect("editMessageReplyMarkup called");
        let edit_body = String::from_utf8_lossy(&edit_req.body);
        assert!(edit_body.contains("✅ Đã ghi nhận"));
        assert!(edit_body.contains("https://www.facebook.com/groups/1/posts/9"));
    }

    // Verify closed/unreachable port error NEVER leaks `token` in Debug or Display!
    let dead_client = TelegramClient::with_config(TelegramClientConfig {
        api_base_url: "http://127.0.0.1:9".to_string(),
        request_timeout: Duration::from_millis(200),
        enforce_rate_limits: false,
    })
    .unwrap();
    let err = dead_client.get_me(token).await.unwrap_err();
    assert!(!format!("{err}").contains(token));
    assert!(!format!("{err:?}").contains(token));
}

#[test]
fn shared_field_type_and_extracted_field_serde_contract_and_xlsx_xml_inspection() {
    use std::io::{Cursor, Read};

    // Verify all 11 FieldType variants serialize/deserialize identically to `02-radar-spec.md §3.2`
    let expected = [
        (FieldType::Text, "text"),
        (FieldType::Number, "number"),
        (FieldType::Money, "money"),
        (FieldType::Phone, "phone"),
        (FieldType::Location, "location"),
        (FieldType::Enum, "enum"),
        (FieldType::MultiEnum, "multi_enum"),
        (FieldType::Boolean, "boolean"),
        (FieldType::Date, "date"),
        (FieldType::Range, "range"),
        (FieldType::Url, "url"),
    ];
    for (variant, wire) in expected {
        let s = serde_json::to_string(&variant).unwrap();
        assert_eq!(s, format!("\"{wire}\""));
        let back: FieldType = serde_json::from_str(&s).unwrap();
        assert_eq!(back, variant);
    }

    let extracted_json = json!({
        "value": {"min": 12000000, "max": 15000000, "currency": "VND", "period": "month"},
        "raw": "tầm 12-15tr/th",
        "confidence": 0.92,
        "source": "ai"
    });
    let parsed: ExtractedField = serde_json::from_value(extracted_json.clone()).unwrap();
    assert_eq!(parsed.source, FieldSource::Ai);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), extracted_json);

    // Inspect generated XLSX ZIP archive: frozen pane, typed numbers, valid FB link clickable,
    // malicious non-FB link rendered as safe plain text without hyperlink!
    let rows = vec![
        ExportLeadRow {
            post_created_at: Some(1_794_384_000_000),
            radar_name: "Radar 1".to_string(),
            status: "new".to_string(),
            score: 0.95,
            summary: "=1+1".to_string(),
            group_name: "Group A".to_string(),
            author_name: "Author A".to_string(),
            permalink: "https://www.facebook.com/groups/10/posts/20/".to_string(),
            post_text: None,
            fields: HashMap::new(),
        },
        ExportLeadRow {
            post_created_at: None,
            radar_name: "Radar 1".to_string(),
            status: "viewed".to_string(),
            score: 0.70,
            summary: "Safe".to_string(),
            group_name: "Group B".to_string(),
            author_name: "Author B".to_string(),
            permalink: "http://evil.com/phishing".to_string(),
            post_text: None,
            fields: HashMap::new(),
        },
    ];

    let xlsx = export_xlsx(
        &ExportOptions {
            include_post_text: false,
        },
        &[],
        &rows,
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(xlsx)).expect("valid zip archive");

    let mut sheet_xml = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml exists")
        .read_to_string(&mut sheet_xml)
        .unwrap();

    // Frozen row 1 header pane
    assert!(sheet_xml.contains("state=\"frozen\""));
    assert!(sheet_xml.contains("ySplit=\"1\""));
    // Zero formula `<f>` tags even though summary was `"=1+1"`!
    assert!(!sheet_xml.contains("<f>"));
    // Exactly 1 hyperlink (for row 1's valid https://www.facebook.com/... URL; row 2's http://evil.com has none!)
    assert_eq!(sheet_xml.matches("<hyperlink ").count(), 1);
}
