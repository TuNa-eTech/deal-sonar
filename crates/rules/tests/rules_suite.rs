use std::collections::BTreeMap;

use dealsonar_rules::*;
use serde_json::json;

// Fixed reference timestamp: 2026-11-11T10:00:00+07:00 (Wednesday)
const REF_TS_2026_11_11: i64 = 1_794_366_000_000;

fn assert_valid_matches(text_norm: &str, matches: &[ExtractionMatch]) {
    assert!(
        !matches.is_empty(),
        "expected at least one match in: {text_norm}"
    );
    for m in matches {
        assert_eq!(
            &text_norm[m.start..m.end],
            m.raw,
            "byte span [{}..{}] must equal raw `{}` in `{}`",
            m.start,
            m.end,
            m.raw,
            text_norm
        );
        assert!(
            verify_evidence(text_norm, &m.raw),
            "verify_evidence must accept extractor raw `{}` in `{}`",
            m.raw,
            text_norm
        );
    }
}

// ============================================================================
// 1. SHARED DATA CONTRACTS (02-radar-spec.md §3.1–3.3)
// ============================================================================

#[test]
fn shared_contracts_serialize_identically_to_spec() {
    let all_types = [
        (FieldType::Text, "\"text\""),
        (FieldType::Number, "\"number\""),
        (FieldType::Money, "\"money\""),
        (FieldType::Phone, "\"phone\""),
        (FieldType::Location, "\"location\""),
        (FieldType::Enum, "\"enum\""),
        (FieldType::MultiEnum, "\"multi_enum\""),
        (FieldType::Boolean, "\"boolean\""),
        (FieldType::Date, "\"date\""),
        (FieldType::Range, "\"range\""),
        (FieldType::Url, "\"url\""),
    ];
    for (ft, expected_json) in all_types {
        let s = serde_json::to_string(&ft).unwrap();
        assert_eq!(s, expected_json);
        let back: FieldType = serde_json::from_str(&s).unwrap();
        assert_eq!(back, ft);
    }

    let def_json = r#"{
        "key": "price",
        "label": "Giá thuê",
        "type": "money",
        "description": "Ngân sách thuê mỗi tháng khách nêu trong bài",
        "required": false,
        "options": null,
        "show_in_alert": true,
        "order": 2
    }"#;
    let def: FieldDef = serde_json::from_str(def_json).unwrap();
    assert_eq!(def.key, "price");
    assert_eq!(def.r#type, FieldType::Money);
    assert!(!def.required);
    assert!(def.show_in_alert);
    assert_eq!(def.order, 2);

    let extracted_spec_json = r#"{
        "value": {"min": 12000000, "max": 15000000, "currency": "VND", "period": "month"},
        "raw": "tầm 12-15tr/th",
        "confidence": 0.92,
        "source": "ai"
    }"#;
    let ef: ExtractedField = serde_json::from_str(extracted_spec_json).unwrap();
    assert_eq!(ef.source, FieldSource::Ai);
    assert_eq!(ef.raw, "tầm 12-15tr/th");
    let mv: MoneyValue = serde_json::from_value(ef.value.clone()).unwrap();
    assert_eq!(mv.min, 12_000_000);
    assert_eq!(mv.max, 15_000_000);
    assert_eq!(mv.currency, "VND");
    assert_eq!(mv.period, Some(MoneyPeriod::Month));

    // Verify single money amount serializes `period: null`
    let single_mv = MoneyValue {
        min: 3_500_000,
        max: 3_500_000,
        currency: "VND".to_string(),
        period: None,
    };
    let single_val = serde_json::to_value(&single_mv).unwrap();
    assert_eq!(
        single_val,
        json!({"min": 3_500_000, "max": 3_500_000, "currency": "VND", "period": null})
    );

    assert_eq!(format_domestic_phone("+84912345678"), "0912 345 678");
    assert_eq!(format_domestic_phone("+842438251234"), "024 3825 1234");
    assert_eq!(format_domestic_phone("+842363821234"), "0236 382 1234");
}

// ============================================================================
// 2. T1 NORMALIZATION & T2 SIMHASH DEDUP (05-pipeline-rules.md §3–4)
// ============================================================================

#[test]
fn t1_vietnamese_diacritic_folding_covers_all_vowels_and_tones() {
    let all_vi = "a à á ả ã ạ ă ằ ắ ẳ ẵ ặ â ầ ấ ẩ ẫ ậ \
                  d đ Đ \
                  e è é ẻ ẽ ẹ ê ề ế ể ễ ệ \
                  i ì í ỉ ĩ ị \
                  o ò ó ỏ õ ọ ô ồ ổ ỗ ộ ố ơ ờ ớ ở ỡ ợ \
                  u ù ú ủ ũ ụ ư ừ ứ ử ữ ự \
                  y ỳ ý ỷ ỹ ỵ";
    let folded = fold_text(all_vi);
    assert_eq!(
        folded,
        "a a a a a a a a a a a a a a a a a a \
         d d d \
         e e e e e e e e e e e e \
         i i i i i i \
         o o o o o o o o o o o o o o o o o o \
         u u u u u u u u u u u u \
         y y y y y y"
    );

    // Decomposed NFD input produces the exact same NFC `text_norm` and `text_fold`
    let nfd_input =
        "Ca\u{0302}\u{0300}n thue\u{0302} nha\u{0300} \u{0110}a\u{0300} Na\u{0306}\u{0303}ng";
    let norm = normalize_text(nfd_input);
    assert_eq!(norm.text_norm, "Cần thuê nhà Đà Nẵng");
    assert_eq!(norm.text_fold, "can thue nha da nang");
}

#[test]
fn t1_math_bold_decorative_unicode_zero_width_and_emoji_spam() {
    // Mathematical bold + sans-serif bold + zero-width space + emojis + newlines
    let spam = "🔥💥 𝐂𝐀̂̀𝐍 𝐓𝐇𝐔𝐄̂\u{200B}   𝗰𝗮̆𝗻 𝗵𝗼̣̂ 2PN\n\tở 𝐂𝐚̂̀𝐮 𝐆𝐢𝐚̂́𝐲 🏠 giá 12–15tr/th ✅\u{FEFF}";
    let norm = normalize_text(spam);
    assert_eq!(
        norm.text_norm,
        "🔥💥 CẦN THUÊ căn hộ 2PN ở Cầu Giấy 🏠 giá 12–15tr/th ✅"
    );
    assert_eq!(
        norm.text_fold,
        "can thue can ho 2pn o cau giay gia 12-15tr/th"
    );
    assert_eq!(norm.lang, "vi");
}

#[test]
fn t1_lang_detection_and_content_hash_invariance_on_repost_price_phone_change() {
    let short = normalize_text("Cần thuê nhà");
    assert_eq!(short.lang, "und", "posts < 20 chars must be 'und'");

    let en = normalize_text("Looking to rent a two bedroom apartment near West Lake Hanoi");
    assert_eq!(en.lang, "en");

    // Reposter changes price (12tr -> 14.5tr), phone, punctuation, and emojis
    let p1 =
        normalize_text("Cần thuê căn hộ 2 phòng ngủ Cầu Giấy, giá 12tr/tháng. LH: 0912.345.678");
    let p2 = normalize_text(
        "🔥 Cần thuê căn hộ 3 phòng ngủ Cầu Giấy!! Giá 14.5tr/tháng - LH 0988 999 111",
    );
    assert_eq!(
        p1.content_hash, p2.content_hash,
        "content_hash strips digits, whitespace, and punctuation so price/phone reposts match"
    );
    assert_eq!(p1.content_hash.len(), 64);
}

#[test]
fn t2_simhash_near_duplicate_bands_and_sqlite_i64_roundtrip() {
    let original = "Gia đình trẻ văn minh lịch sự làm việc văn phòng tại Hà Nội đang cần thuê gấp một căn hộ \
        chung cư hai phòng ngủ hai vệ sinh khu vực Dịch Vọng hoặc Trung Hoà hoặc Yên Hoà quận Cầu Giấy Hà Nội, \
        ngân sách tài chính khoảng 13 triệu một tháng thanh toán ba tháng cọc một tháng, ưu tiên nhà có ban công \
        thoáng mát nhiều ánh sáng tự nhiên có sẵn nội thất cơ bản điều hoà nóng lạnh tủ bếp giường tủ sạch sẽ, \
        mong muốn tìm được nhà chính chủ thiện chí hợp đồng lâu dài ổn định từ một đến hai năm, anh chị chủ nhà \
        nào có căn phù hợp vui lòng nhắn tin hoặc liên hệ ngay.";
    let slight_edit = "Gia đình trẻ văn minh lịch sự làm việc văn phòng tại Hà Nội đang cần thuê gấp một căn hộ \
        chung cư hai phòng ngủ hai vệ sinh khu vực Dịch Vọng hoặc Trung Hoà hoặc Yên Hoà quận Cầu Giấy Hà Nội, \
        ngân sách tài chính khoảng 13 triệu một tháng thanh toán ba tháng cọc một tháng, ưu tiên nhà có ban công \
        thoáng mát nhiều ánh sáng tự nhiên có sẵn nội thất cơ bản điều hoà nóng lạnh tủ bếp giường tủ sạch sẽ, \
        mong muốn tìm được nhà chính chủ thiện chí hợp đồng lâu dài ổn định từ một đến hai năm, anh chị chủ nhà \
        nào có căn phù hợp vui lòng nhắn tin hoặc liên hệ sớm.";
    let unrelated =
        "Chính chủ cần bán gấp chiếc xe ô tô Mazda 3 đời 2020 màu trắng chạy chuẩn 4 vạn km \
        biển số thành phố Hồ Chí Minh, cam kết không đâm đụng ngập nước, xem xe tại Quận 7.";

    let n1 = normalize_text(original);
    let n2 = normalize_text(slight_edit);
    let n3 = normalize_text(unrelated);

    assert_eq!(simhash_from_i64(n1.simhash), n1.simhash_u64());
    assert_eq!(simhash_to_i64(n1.simhash_u64()), n1.simhash);
    assert_eq!(simhash_bands_i64(n1.simhash), n1.simhash_bands);

    let dist_near = hamming_distance(n1.simhash_u64(), n2.simhash_u64());
    assert!(
        dist_near <= 3,
        "expected Hamming distance <= 3 for minor 1-word edit, got {dist_near}"
    );
    assert!(is_near_duplicate(
        n1.text_norm.chars().count(),
        n1.simhash_u64(),
        n2.text_norm.chars().count(),
        n2.simhash_u64()
    ));

    // Pigeonhole guarantee: at least one 16-bit band matches when Hamming distance <= 3
    let shares_band = n1
        .simhash_bands
        .iter()
        .zip(n2.simhash_bands.iter())
        .any(|(a, b)| a == b);
    assert!(shares_band, "at least one 16-bit LSH band must match");

    let dist_unrelated = hamming_distance(n1.simhash_u64(), n3.simhash_u64());
    assert!(
        dist_unrelated > 10,
        "unrelated posts must diverge, got {dist_unrelated}"
    );

    // Short posts (< 80 chars) never trigger near-duplicate even with distance 0
    let short = normalize_text("Cần thuê phòng Cầu Giấy 5tr");
    assert!(!is_near_duplicate(
        short.text_norm.chars().count(),
        short.simhash_u64(),
        short.text_norm.chars().count(),
        short.simhash_u64()
    ));
}

// ============================================================================
// 3. T3 BASIC PREFILTER (05-pipeline-rules.md §5)
// ============================================================================

#[test]
fn t3_basic_prefilter_short_url_and_blocklist() {
    assert!(is_too_short("", false));
    assert!(is_too_short("   ", true));
    assert!(is_too_short("Alo cần thuê", false)); // 12 chars < 15 without attachments
    assert!(!is_too_short("Alo cần thuê", true)); // allowed when attachment present
    assert!(!is_too_short("Cần thuê nhà Cầu Giấy", false));

    assert!(is_url_only(
        "https://www.facebook.com/groups/123456/posts/789/"
    ));
    assert!(is_url_only(
        "http://bit.ly/abc123 https://batdongsan.com.vn/nha-dat"
    ));
    assert!(!is_url_only("Xem chi tiết tại https://batdongsan.com.vn"));
    assert!(!is_url_only("0912.345.678"));
    assert!(!is_url_only("Giá 3.5tr"));

    // Word-boundary safety: blocked keyword "an" must NOT match "căn hộ" ("can ho")
    let norm = normalize_text("Cần thuê căn hộ Cầu Giấy, LH o912 345 678");
    assert!(!matches_blocklist_keyword(&norm.text_fold, "an"));
    assert!(matches_blocklist_keyword(&norm.text_fold, "Cầu Giấy"));

    // Phone blocklist catches letter-o obfuscated phone in post!
    let blocklist = vec![
        BlocklistEntry {
            kind: BlocklistKind::Author,
            value: "fb_spammer_99".to_string(),
        },
        BlocklistEntry {
            kind: BlocklistKind::Phone,
            value: "+84912345678".to_string(),
        },
        BlocklistEntry {
            kind: BlocklistKind::Keyword,
            value: "tuyển cộng tác viên".to_string(),
        },
    ];
    let reason = run_basic_prefilter(
        &BasicPrefilterInput {
            author_id: Some("normal_user"),
            text_norm: &norm.text_norm,
            text_fold: &norm.text_fold,
            has_attachments: false,
        },
        &blocklist,
    );
    assert_eq!(
        reason,
        Some(PrefilterRejectReason::Blocked(BlocklistKind::Phone))
    );
    assert_eq!(reason.unwrap().as_db_reject_reason(), "blocked");
}

// ============================================================================
// 4. ALL 8 BUILT-IN EXTRACTORS (05-pipeline-rules.md §6.3)
// ============================================================================

#[test]
fn extractor_vn_money_shorthand_ranges_periods_and_near_window() {
    let cases: &[(&str, i64, i64, Option<MoneyPeriod>)] = &[
        ("Phòng trọ giá 3tr5 khép kín", 3_500_000, 3_500_000, None),
        ("Ngân sách 3,5 triệu", 3_500_000, 3_500_000, None),
        (
            "Bán nhà ngõ nông 2 tỷ 3 có thương lượng",
            2_300_000_000,
            2_300_000_000,
            None,
        ),
        ("Sang nhượng gấp 15 củ", 15_000_000, 15_000_000, None),
        ("Phí dịch vụ 500k", 500_000, 500_000, None),
        (
            "Cần thuê chung cư 12-15tr/th",
            12_000_000,
            15_000_000,
            Some(MoneyPeriod::Month),
        ),
        (
            "Tài chính tầm 12 - 15 triệu/tháng khu Cầu Giấy",
            12_000_000,
            15_000_000,
            Some(MoneyPeriod::Month),
        ),
        ("Tìm mua ô tô cũ dưới 400 triệu", 0, 400_000_000, None),
        ("Đất nền sổ đỏ 1.2 tỉ", 1_200_000_000, 1_200_000_000, None),
        (
            "Thuê mặt bằng 25tr/năm",
            25_000_000,
            25_000_000,
            Some(MoneyPeriod::Year),
        ),
        (
            "Homestay 800k/ngày",
            800_000,
            800_000,
            Some(MoneyPeriod::Day),
        ),
        (
            "Giá thuê 15.000.000đ/tháng",
            15_000_000,
            15_000_000,
            Some(MoneyPeriod::Month),
        ),
        (
            "Tài chính từ 900 triệu đến 1.1 tỷ",
            900_000_000,
            1_100_000_000,
            None,
        ),
    ];

    for &(post, exp_min, exp_max, exp_period) in cases {
        let norm = normalize_text(post);
        let matches = extract_vn_money(&norm.text_norm, None, None);
        assert_valid_matches(&norm.text_norm, &matches);
        let mv: MoneyValue = serde_json::from_value(matches[0].value.clone()).unwrap();
        assert_eq!(mv.min, exp_min, "min mismatch on `{post}`");
        assert_eq!(mv.max, exp_max, "max mismatch on `{post}`");
        assert_eq!(mv.currency, "VND");
        assert_eq!(mv.period, exp_period, "period mismatch on `{post}`");
    }

    // Critical guard: "3 tỷ 2 phòng ngủ" must NOT parse "2" as 200M -> 3.2 tỷ!
    let bedroom_trap = normalize_text("Cần mua chung cư 3 tỷ 2 phòng ngủ ở Thanh Xuân");
    let m_trap = extract_vn_money(&bedroom_trap.text_norm, None, None);
    assert_valid_matches(&bedroom_trap.text_norm, &m_trap);
    let mv_trap: MoneyValue = serde_json::from_value(m_trap[0].value.clone()).unwrap();
    assert_eq!(mv_trap.min, 3_000_000_000);
    assert_eq!(mv_trap.max, 3_000_000_000);

    // `near` + `window` selects rent budget over earlier unrelated fee!
    let multi_money = normalize_text(
        "Gửi phí cafe 300k cho ai giới thiệu giúp, gia đình mình đang cần tìm căn hộ khu vực Mỹ Đình, ngân sách thuê tầm 11 - 13 triệu/tháng",
    );
    let near = vec!["ngân sách".to_string(), "tài chính".to_string()];
    let near_matches = extract_vn_money(&multi_money.text_norm, Some(&near), Some(35));
    assert_valid_matches(&multi_money.text_norm, &near_matches);
    let mv_near: MoneyValue = serde_json::from_value(near_matches[0].value.clone()).unwrap();
    assert_eq!(mv_near.min, 11_000_000);
    assert_eq!(mv_near.max, 13_000_000);
    assert_eq!(mv_near.period, Some(MoneyPeriod::Month));
}

#[test]
fn extractor_vn_phone_mobile_landline_obfuscation_and_url_safety() {
    let cases = [
        ("Liên hệ chính chủ 0912.345.678 để xem nhà", "+84912345678"),
        ("Zalo/SĐT: 09 1234 5678", "+84912345678"),
        ("Gọi ngay o912 345 678 nhé", "+84912345678"),
        ("SĐT O988.12o.456 (miễn TG)", "+84988120456"),
        ("Hotline +84912345678", "+84912345678"),
        ("Tel: 84934567890", "+84934567890"),
        ("Máy bàn văn phòng 024.3825.1234", "+842438251234"),
        ("Chi nhánh HCM: 028 3812 3456", "+842838123456"),
    ];
    for (post, expected_e164) in cases {
        let norm = normalize_text(post);
        let matches = extract_vn_phone(&norm.text_norm);
        assert_valid_matches(&norm.text_norm, &matches);
        assert_eq!(matches[0].value, json!(expected_e164), "failed on `{post}`");
    }

    // Must NOT extract fake phones out of Facebook permalink IDs or VND numbers
    let no_phone = normalize_text(
        "Xem link https://www.facebook.com/groups/0912345678/posts/0987654321 giá 15.000.000 đồng",
    );
    assert!(extract_vn_phone(&no_phone.text_norm).is_empty());
}

#[test]
fn extractor_vn_area_units_dimensions_and_ranges() {
    let cases: &[(&str, f64, f64)] = &[
        ("Căn hộ 50m2 full đồ", 50.0, 50.0),
        ("Diện tích thông thuỷ 50 m²", 50.0, 50.0),
        ("Đất phân lô 5x20 vuông vắn", 100.0, 100.0),
        ("Nhà phố ngang 4.5m x 16m sổ hồng riêng", 72.0, 72.0),
        ("Mặt bằng 4m5 x 20m vỉa hè rộng", 90.0, 90.0),
        ("Cần thuê văn phòng 50-70m2", 50.0, 70.0),
        ("Nhà rộng 70 mét vuông", 70.0, 70.0),
    ];
    for &(post, exp_min, exp_max) in cases {
        let norm = normalize_text(post);
        let matches = extract_vn_area(&norm.text_norm);
        assert_valid_matches(&norm.text_norm, &matches);
        let rv: RangeValue = serde_json::from_value(matches[0].value.clone()).unwrap();
        assert!((rv.min - exp_min).abs() < 1e-6, "min mismatch on `{post}`");
        assert!((rv.max - exp_max).abs() < 1e-6, "max mismatch on `{post}`");
        assert_eq!(rv.unit, "m2");
    }
}

#[test]
fn extractor_gazetteer_hanoi_hcmc_provinces_abbreviations_and_scope() {
    type GazetteerCase<'a> = (
        &'a str,
        Option<&'a str>,
        &'a str,
        Option<&'a str>,
        Option<&'a str>,
    );
    let cases: &[GazetteerCase<'_>] = &[
        (
            "Cần thuê căn hộ 2pn khu Dịch Vọng, Cầu Giấy, Hà Nội",
            None,
            "Hà Nội",
            Some("Cầu Giấy"),
            Some("Dịch Vọng"),
        ),
        (
            "Tìm phòng trọ kv cg gần trường",
            Some("Hà Nội"),
            "Hà Nội",
            Some("Cầu Giấy"),
            None,
        ),
        (
            "Cần thuê nhà ntl hoặc btl",
            Some("Hà Nội"),
            "Hà Nội",
            Some("Nam Từ Liêm"),
            None,
        ),
        (
            "Tìm chung cư ở hbt tài chính 10tr",
            Some("Hà Nội"),
            "Hà Nội",
            Some("Hai Bà Trưng"),
            None,
        ),
        (
            "Cần thuê căn hộ q7 gần Phú Mỹ Hưng",
            None,
            "TP. Hồ Chí Minh",
            Some("Quận 7"),
            None,
        ),
        (
            "Tìm mặt bằng tp thủ đức mặt tiền rộng",
            None,
            "TP. Hồ Chí Minh",
            Some("Thủ Đức"),
            None,
        ),
        (
            "Cần thuê phòng binh thanh hoặc phu nhuan",
            None,
            "TP. Hồ Chí Minh",
            Some("Bình Thạnh"),
            None,
        ),
        (
            "Bán đất nền Sơn Trà, Đà Nẵng",
            None,
            "Đà Nẵng",
            Some("Sơn Trà"),
            None,
        ),
        (
            "Cần thuê kho Dĩ An, Bình Dương",
            None,
            "Bình Dương",
            Some("Dĩ An"),
            None,
        ),
        (
            "Tìm homestay Hồ Tràm cuối tuần",
            None,
            "Bà Rịa - Vũng Tàu",
            Some("Xuyên Mộc"),
            None,
        ),
        (
            "Cần thuê biệt thự Ecopark",
            None,
            "Hưng Yên",
            Some("Văn Giang"),
            None,
        ),
    ];

    for &(post, scope, exp_prov, exp_dist, exp_ward) in cases {
        let norm = normalize_text(post);
        let matches = extract_gazetteer(&norm.text_norm, scope);
        assert_valid_matches(&norm.text_norm, &matches);
        let loc: LocationValue = serde_json::from_value(matches[0].value.clone()).unwrap();
        assert_eq!(
            loc.province.as_deref(),
            Some(exp_prov),
            "province on `{post}`"
        );
        assert_eq!(loc.district.as_deref(), exp_dist, "district on `{post}`");
        assert_eq!(loc.ward.as_deref(), exp_ward, "ward on `{post}`");
    }

    // Scope filtering: HCMC post must return empty when scoped to "Hà Nội"
    let hcm_post = normalize_text("Cần thuê căn hộ 2pn ở Quận 7, TP.HCM giá 12tr");
    assert!(extract_gazetteer(&hcm_post.text_norm, Some("Hà Nội")).is_empty());
    assert!(!extract_gazetteer(&hcm_post.text_norm, Some("TP.HCM")).is_empty());

    // "2pn" must never falsely trigger "Phú Nhuận"
    let pn_post = normalize_text("Cần thuê chung cư 2pn full nội thất giá 10tr");
    assert!(extract_gazetteer(&pn_post.text_norm, None).is_empty());
}

#[test]
fn extractor_number_date_vi_enum_kw_and_safe_regex() {
    // `number`
    let n1 = extract_number(
        "Cần thuê xe tải 3 tấn chở hàng",
        &NumberExtractorConfig::default(),
    );
    assert_eq!(n1[0].value, json!(3));
    let n2 = extract_number(
        "Bán Vios đời 2019 chính chủ",
        &NumberExtractorConfig::default(),
    );
    assert_eq!(n2[0].value, json!(2019));
    let n3 = extract_number(
        "Xe chạy chuẩn 5 vạn km zin",
        &NumberExtractorConfig::default(),
    );
    assert_eq!(n3[0].value, json!(50_000));
    let n4 = extract_number("Căn hộ 2pn thoáng mát", &NumberExtractorConfig::default());
    assert_eq!(n4[0].value, json!(2));

    // `date_vi` anchored at Wednesday 2026-11-11 (+07:00)
    let date_cases = [
        ("Dọn vào hôm nay luôn ạ", "2026-11-11"),
        ("Chuyển nhà vào ngày mai", "2026-11-12"),
        ("Cần xe ghép sáng mai đi Hải Phòng", "2026-11-12"),
        ("Xem nhà cuối tuần này", "2026-11-14"),
        ("Nhận phòng cuối tháng này", "2026-11-30"),
        ("Bắt đầu thuê từ đầu tháng sau", "2026-12-01"),
        ("Cần chuyển đồ ngày 15/11", "2026-11-15"),
        ("Hợp đồng từ 15/11/2026", "2026-11-15"),
        ("Ngày khởi hành 2026-12-25", "2026-12-25"),
    ];
    for (post, expected_iso) in date_cases {
        let norm = normalize_text(post);
        let matches = extract_date_vi(&norm.text_norm, REF_TS_2026_11_11);
        assert_valid_matches(&norm.text_norm, &matches);
        assert_eq!(
            matches[0].value,
            json!(expected_iso),
            "date mismatch on `{post}`"
        );
    }

    // `date_vi` false-positive guards (alleys, streets, 24/7, Hoàng Mai / Mai Dịch / khuyến mãi)
    let non_date = normalize_text(
        "Cho thuê nhà ngõ 15/11 đường 3/2 phường Mai Dịch và Hoàng Mai, mở cửa 24/7 nhiều khuyến mãi",
    );
    assert!(
        extract_date_vi(&non_date.text_norm, REF_TS_2026_11_11).is_empty(),
        "alley numbers, 24/7, district names, and 'khuyến mãi' must not parse as dates"
    );

    // `enum_kw`
    let mut amenity_map = BTreeMap::new();
    amenity_map.insert(
        "ac".to_string(),
        vec!["dieu hoa".to_string(), "may lanh".to_string()],
    );
    amenity_map.insert("washer".to_string(), vec!["may giat".to_string()]);
    amenity_map.insert("balcony".to_string(), vec!["ban cong".to_string()]);
    let am_post = normalize_text("Căn hộ có ban công rộng, sẵn điều hoà và máy giặt");
    let multi_matches = extract_enum_kw(&am_post.text_norm, &amenity_map, true);
    assert_valid_matches(&am_post.text_norm, &multi_matches);
    assert_eq!(multi_matches[0].value, json!(["balcony", "ac", "washer"]));

    // `regex`: folded pattern matches accented Vietnamese `text_norm` and preserves accented `raw`!
    let bed_post = normalize_text("Cần thuê căn hộ 3 phòng ngủ ở Cầu Giấy");
    let re_matches = extract_regex(
        &bed_post.text_norm,
        r"(\d)\s*(pn|phong ngu|ngu)\b",
        1,
        RegexCast::Int,
    )
    .unwrap();
    assert_valid_matches(&bed_post.text_norm, &re_matches);
    assert_eq!(re_matches[0].raw, "3 phòng ngủ");
    assert_eq!(re_matches[0].value, json!(3));

    // Reject catastrophic / nested-quantifier / oversized regexes
    assert!(compile_safe_regex(r"(a+)+").is_err());
    assert!(compile_safe_regex(r"(.*)+").is_err());
    assert!(compile_safe_regex(r"\w{500}").is_err());
    assert!(compile_safe_regex(&"a".repeat(600)).is_err());
    assert!(extract_regex("2pn", r"\d+pn", 1, RegexCast::Int).is_err());
}

// ============================================================================
// 5. DECLARATIVE RULESET DSL v1, SEED RULESET & GATE (05-pipeline-rules.md §6.2, §6.4)
// ============================================================================

#[test]
fn dsl_spec_ruleset_parses_validates_under_1ms_and_evaluates_all_outcomes() {
    let spec_ruleset_json = r#"{
      "dsl": 1,
      "prefilter": {
        "any":  ["can thue", "tim phong", "tim nha", "can tim", "re:\\bthue\\b"],
        "none": ["cho thue", "chinh chu cho thue", "tuyen dung"],
        "min_len": 20
      },
      "classify": [
        {
          "id": "r1",
          "when": {
            "all": [
              {"kw_any": ["can thue", "tim thue", "muon thue"]},
              {"kw_none": ["cho thue", "ben em co", "hoa hong", "ib em"]},
              {"has_field": "location"}
            ]
          },
          "verdict": "match",
          "confidence": 0.92,
          "set": {"intent": "demand"}
        },
        {
          "id": "r2",
          "when": {"kw_any": ["ben em co", "quy can", "hoa hong", "ky gui"]},
          "verdict": "no_match",
          "confidence": 0.9,
          "set": {"author_role": "peer"}
        }
      ],
      "extract": [
        {"field": "price", "extractor": "vn_money",
         "near": ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"], "window": 40},
        {"field": "location", "extractor": "gazetteer", "dict": "vn_admin", "scope": "Hà Nội"},
        {"field": "phone", "extractor": "vn_phone"},
        {"field": "bedrooms", "extractor": "regex",
         "pattern": "(\\d)\\s*(pn|phong ngu|ngu)\\b", "group": 1, "cast": "int"},
        {"field": "deal_type", "extractor": "enum_kw",
         "map": {"rent": ["thue"], "buy": ["mua"]}}
      ],
      "thresholds": {"accept": 0.9, "reject": 0.9}
    }"#;

    let ruleset: RulesetBody = serde_json::from_str(spec_ruleset_json).unwrap();
    let compiled = validate_ruleset(&ruleset).expect("spec ruleset must validate and run < 1ms");

    let summary = describe_ruleset(&ruleset);
    assert!(summary.accept_keywords.contains(&"can thue".to_string()));
    assert!(summary.reject_keywords.contains(&"cho thue".to_string()));
    assert_eq!(
        summary.extracted_fields,
        vec!["price", "location", "phone", "bedrooms", "deal_type"]
    );

    let field_defs = vec![FieldDef {
        key: "price".to_string(),
        label: "Giá".to_string(),
        r#type: FieldType::Money,
        description: String::new(),
        required: true,
        options: None,
        show_in_alert: true,
        order: 1,
    }];

    // 1. PrefilterReject ("cho thuê")
    let supply = normalize_text("Chính chủ cho thuê căn hộ 2PN Cầu Giấy giá 12tr/th LH 0912345678");
    assert_eq!(
        compiled.evaluate(&supply, &field_defs, REF_TS_2026_11_11),
        RulesetOutcome::PrefilterReject
    );

    // 2. DefiniteMatch (matches r1, confidence 0.92 >= 0.9, required `price` extracted!)
    let tenant = normalize_text(
        "Vợ chồng trẻ cần thuê căn hộ 2 phòng ngủ khu Cầu Giấy, tài chính tầm 12-15tr/th, LH 0912.345.678",
    );
    match compiled.evaluate(&tenant, &field_defs, REF_TS_2026_11_11) {
        RulesetOutcome::DefiniteMatch {
            rule_id,
            fields,
            set,
            ..
        } => {
            assert_eq!(rule_id, "r1");
            assert_eq!(set.get("intent"), Some(&json!("demand")));
            assert_eq!(fields["bedrooms"].value, json!(2));
            assert_eq!(fields["phone"].value, json!("+84912345678"));
            assert_eq!(fields["deal_type"].value, json!("rent"));
        }
        other => panic!("expected DefiniteMatch, got {other:?}"),
    }

    // 3. Uncertain when r1 matches BUT required `price` field is missing!
    let tenant_no_price =
        normalize_text("Mình cần thuê gấp căn hộ 2 phòng ngủ ở Cầu Giấy vào ở luôn tuần này");
    match compiled.evaluate(&tenant_no_price, &field_defs, REF_TS_2026_11_11) {
        RulesetOutcome::Uncertain {
            hint_fields,
            matched_rule_id,
            ..
        } => {
            assert_eq!(matched_rule_id.as_deref(), Some("r1"));
            assert!(hint_fields.contains_key("location"));
            assert!(!hint_fields.contains_key("price"));
        }
        other => panic!("expected Uncertain when required field missing, got {other:?}"),
    }

    // 4. DefiniteNoMatch (broker disguised post passing prefilter via "khách thuê", caught by r2 "quỹ căn")
    let broker = normalize_text(
        "Hỗ trợ khách thuê tìm nhà Cầu Giấy: bên em có quỹ căn 2PN giá cực tốt, hoa hồng 50%",
    );
    match compiled.evaluate(&broker, &field_defs, REF_TS_2026_11_11) {
        RulesetOutcome::DefiniteNoMatch { rule_id, set, .. } => {
            assert_eq!(rule_id, "r2");
            assert_eq!(set.get("author_role"), Some(&json!("peer")));
        }
        other => panic!("expected DefiniteNoMatch, got {other:?}"),
    }
}

#[test]
fn seed_ruleset_bds_vi_v1_is_valid_and_functional() {
    assert!(seed_ruleset("unknown-seed").is_none());
    let bds = seed_ruleset("bds-vi-v1").expect("bds-vi-v1 seed must exist");
    let compiled = validate_ruleset(&bds).expect("bds-vi-v1 must pass <1ms validation");

    // Non-diacritic abbreviated Vietnamese post!
    let no_diacritics = normalize_text(
        "vc tre can thue chung cu 2pn kv cau giay tai chinh tam 12tr/th lh o912 345 678",
    );
    match compiled.evaluate(&no_diacritics, &[], REF_TS_2026_11_11) {
        RulesetOutcome::DefiniteMatch { fields, .. } => {
            assert_eq!(fields["deal_type"].value, json!("rent"));
            assert_eq!(fields["property_type"].value, json!("apartment"));
            assert_eq!(fields["bedrooms"].value, json!(2));
            assert_eq!(fields["phone"].value, json!("+84912345678"));
            let loc: LocationValue =
                serde_json::from_value(fields["location"].value.clone()).unwrap();
            assert_eq!(loc.district.as_deref(), Some("Cầu Giấy"));
        }
        other => panic!("expected DefiniteMatch on no-diacritics post, got {other:?}"),
    }
}

#[test]
fn lifecycle_gate_prunes_low_accuracy_extractors_and_enforces_fn_and_precision() {
    let mut ruleset = seed_ruleset("bds-vi-v1").unwrap();
    // Keep 2 extractors: `phone` (accurate >= 90%) and a deliberately broken `floor` regex (< 90%)
    ruleset.extract = vec![
        ExtractRule {
            field: "location".to_string(),
            config: ExtractorConfig::Gazetteer {
                dict: "vn_admin".to_string(),
                scope: None,
            },
        },
        ExtractRule {
            field: "phone".to_string(),
            config: ExtractorConfig::VnPhone,
        },
        ExtractRule {
            field: "bad_floor".to_string(),
            config: ExtractorConfig::Regex {
                pattern: r"tang\s*(\d+)".to_string(),
                group: 1,
                cast: RegexCast::Int,
            },
        },
    ];

    let samples = vec![
        LabeledSample {
            post_text: "Cần thuê căn hộ khu Cầu Giấy giá 12tr LH 0912345678".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: true,
            expected_fields: BTreeMap::from([
                (
                    "location".to_string(),
                    json!({"province": "Hà Nội", "district": "Cầu Giấy", "ward": null}),
                ),
                ("phone".to_string(), json!("+84912345678")),
                ("bad_floor".to_string(), json!(99)), // Deliberate mismatch so `bad_floor` < 90%
            ]),
        },
        LabeledSample {
            post_text: "Gia đình muốn thuê nhà riêng ở Thanh Xuân LH 0987654321".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: true,
            expected_fields: BTreeMap::from([
                (
                    "location".to_string(),
                    json!({"province": "Hà Nội", "district": "Thanh Xuân", "ward": null}),
                ),
                ("phone".to_string(), json!("+84987654321")),
                ("bad_floor".to_string(), json!(5)),
            ]),
        },
        LabeledSample {
            post_text: "Bên em có quỹ căn giá tốt khu Cầu Giấy nhận ký gửi".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: false,
            expected_fields: BTreeMap::new(),
        },
        LabeledSample {
            post_text: "Tuyển dụng nhân viên kinh doanh lương cứng 15 triệu".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: false,
            expected_fields: BTreeMap::new(),
        },
    ];

    let report = evaluate_gate(&ruleset, &samples);
    assert!(
        report.passed,
        "gate should pass after pruning `bad_floor`: {report:?}"
    );
    assert_eq!(report.false_negative_rate, 0.0);
    assert_eq!(report.accept_precision, 1.0);
    assert_eq!(report.dropped_fields, vec!["bad_floor".to_string()]);
    assert!(
        report
            .pruned_ruleset
            .extract
            .iter()
            .all(|e| e.field != "bad_floor"),
        "pruned_ruleset must drop fields with < 90% accuracy"
    );
    assert_eq!(report.pruned_ruleset.extract.len(), 2);

    // Now inject a false negative (a positive sample rejected by `prefilter.none`) -> FN rate = 1/3 = 33% > 2%!
    let mut bad_samples = samples.clone();
    bad_samples.push(LabeledSample {
        post_text: "Tuyển dụng nhân viên cần thuê gấp nhà Cầu Giấy".to_string(),
        ref_ts_ms: REF_TS_2026_11_11,
        is_match: true,
        expected_fields: BTreeMap::new(),
    });
    let bad_report = evaluate_gate(&ruleset, &bad_samples);
    assert!(!bad_report.passed, "gate must fail when FN rate > 0.02");
    assert!(bad_report.false_negative_rate > 0.02);
}

// ============================================================================
// 6. T6 POSTFILTER HELPERS (05-pipeline-rules.md §8)
// ============================================================================

#[test]
fn t6_verify_evidence_renormalize_and_hard_filters() {
    let post = normalize_text(
        "Cần thuê chung cư 2PN khu Cầu Giấy, ngân sách tầm 3tr5 – 4tr5/tháng, dọn vào cuối tháng này. LH 0912.345.678",
    );

    // Evidence verification: case-, whitespace-, and dash-insensitive, rejects hallucinations & empty raw
    assert!(verify_evidence(&post.text_norm, "tầm 3tr5 - 4tr5/tháng"));
    assert!(verify_evidence(&post.text_norm, "khu   cầu\ngiấy"));
    assert!(!verify_evidence(&post.text_norm, ""));
    assert!(!verify_evidence(&post.text_norm, "   "));
    assert!(!verify_evidence(&post.text_norm, "Quận Ba Đình")); // hallucinated location!
    assert!(!verify_evidence(&post.text_norm, "0988.999.000")); // hallucinated phone!

    // Renormalization: built-in extractor overrides AI math/format mistakes and lowers confidence
    let price_def = FieldDef {
        key: "price".to_string(),
        label: "Giá".to_string(),
        r#type: FieldType::Money,
        description: String::new(),
        required: true,
        options: None,
        show_in_alert: true,
        order: 1,
    };
    let phone_def = FieldDef {
        key: "phone".to_string(),
        label: "SĐT".to_string(),
        r#type: FieldType::Phone,
        description: String::new(),
        required: true,
        options: None,
        show_in_alert: true,
        order: 2,
    };
    let date_def = FieldDef {
        key: "move_in".to_string(),
        label: "Ngày vào".to_string(),
        r#type: FieldType::Date,
        description: String::new(),
        required: false,
        options: None,
        show_in_alert: true,
        order: 3,
    };

    // AI hallucinated 350,000 instead of 3,500,000 on `raw = "3tr5"`
    let renorm_money = renormalize_field(
        &price_def,
        "3tr5",
        &json!({"min": 350_000, "max": 350_000, "currency": "VND", "period": null}),
        REF_TS_2026_11_11,
    );
    assert!(renorm_money.overridden);
    assert_eq!(
        renorm_money.value,
        json!({"min": 3_500_000, "max": 3_500_000, "currency": "VND", "period": null})
    );
    assert!(renorm_money.apply_confidence(0.92) < 0.92);

    // Full `postprocess_fields`: drops hallucinated required `phone`, penalizes score by 0.2,
    // and renormalizes `move_in` ("cuối tháng này" -> "2026-11-30")!
    let ai_candidates = ExtractedFields::from([
        (
            "price".to_string(),
            ExtractedField {
                value: json!({"min": 3_500_000, "max": 4_500_000, "currency": "VND", "period": "month"}),
                raw: "tầm 3tr5 – 4tr5/tháng".to_string(),
                confidence: 0.95,
                source: FieldSource::Ai,
            },
        ),
        (
            "phone".to_string(),
            ExtractedField {
                value: json!("+84999999999"),
                raw: "0999.999.999".to_string(), // NOT in post!
                confidence: 0.90,
                source: FieldSource::Ai,
            },
        ),
        (
            "move_in".to_string(),
            ExtractedField {
                value: json!("2026-11-28"), // AI miscounted days in Nov!
                raw: "cuối tháng này".to_string(),
                confidence: 0.88,
                source: FieldSource::Ai,
            },
        ),
    ]);

    let postprocessed = postprocess_fields(
        &post.text_norm,
        &[price_def, phone_def, date_def],
        &ai_candidates,
        REF_TS_2026_11_11,
    );
    assert_eq!(postprocessed.dropped_keys, vec!["phone".to_string()]);
    assert_eq!(postprocessed.dropped_required_count, 1);
    assert!((postprocessed.score_penalty - 0.2).abs() < 1e-9);
    assert_eq!(postprocessed.fields["price"].confidence, 0.95); // agreed -> unchanged
    assert_eq!(postprocessed.fields["move_in"].value, json!("2026-11-30")); // overridden by date_vi!
    assert!(postprocessed.fields["move_in"].confidence < 0.88);

    // Hard filters: all 10 operators + `when_missing` ("pass" vs "fail")
    let extracted = ExtractedFields::from([
        (
            "price".to_string(),
            ExtractedField {
                value: json!({"min": 12_000_000, "max": 15_000_000, "currency": "VND", "period": "month"}),
                raw: "12-15tr/th".to_string(),
                confidence: 0.95,
                source: FieldSource::Rule,
            },
        ),
        (
            "location".to_string(),
            ExtractedField {
                value: json!({"raw": "Dịch Vọng, Cầu Giấy", "province": "Hà Nội", "district": "Cầu Giấy", "ward": "Dịch Vọng"}),
                raw: "Dịch Vọng, Cầu Giấy".to_string(),
                confidence: 0.96,
                source: FieldSource::Rule,
            },
        ),
        (
            "bedrooms".to_string(),
            ExtractedField {
                value: json!(2),
                raw: "2PN".to_string(),
                confidence: 0.92,
                source: FieldSource::Rule,
            },
        ),
        (
            "amenities".to_string(),
            ExtractedField {
                value: json!(["ban công", "điều hoà"]),
                raw: "ban công, điều hoà".to_string(),
                confidence: 0.90,
                source: FieldSource::Ai,
            },
        ),
        (
            "notes".to_string(),
            ExtractedField {
                value: json!("Nhà mặt ngõ ô tô đỗ cửa"),
                raw: "mặt ngõ ô tô đỗ cửa".to_string(),
                confidence: 0.85,
                source: FieldSource::Ai,
            },
        ),
    ]);

    let passing_filters = vec![
        HardFilter {
            field: "price".to_string(),
            op: FilterOp::Lte,
            value: json!(15_000_000),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "price".to_string(),
            op: FilterOp::Gte,
            value: json!(10_000_000),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "price".to_string(),
            op: FilterOp::Between,
            value: json!([10_000_000, 16_000_000]),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "location".to_string(),
            op: FilterOp::In,
            value: json!(["Cầu Giấy", "Nam Từ Liêm"]),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "bedrooms".to_string(),
            op: FilterOp::Eq,
            value: json!(2),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "bedrooms".to_string(),
            op: FilterOp::Ne,
            value: json!(4),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "bedrooms".to_string(),
            op: FilterOp::Gt,
            value: json!(1),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "bedrooms".to_string(),
            op: FilterOp::Lt,
            value: json!(3),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "notes".to_string(),
            op: FilterOp::Contains,
            value: json!("o to do cua"),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "amenities".to_string(),
            op: FilterOp::In,
            value: json!(["ban công"]),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "missing_optional".to_string(),
            op: FilterOp::IsEmpty,
            value: json!(true),
            when_missing: WhenMissing::Fail,
        },
        HardFilter {
            field: "missing_optional".to_string(),
            op: FilterOp::Eq,
            value: json!("anything"),
            when_missing: WhenMissing::Pass,
        },
    ];
    assert!(evaluate_hard_filters(&passing_filters, &extracted));

    let failing_when_missing = vec![HardFilter {
        field: "missing_required".to_string(),
        op: FilterOp::Eq,
        value: json!("anything"),
        when_missing: WhenMissing::Fail,
    }];
    assert!(!evaluate_hard_filters(&failing_when_missing, &extracted));

    // Peer behavioral signal override & score thresholds
    assert!(should_override_peer(&PeerSignals {
        author_posts_7d: 6,
        cluster_source_count: 4,
        phone_distinct_authors: 1,
    }));
    assert!(!should_override_peer(&PeerSignals {
        author_posts_7d: 5,
        cluster_source_count: 1,
        phone_distinct_authors: 1,
    }));
    assert_eq!(
        classify_lead_tier(0.75, 0.6),
        LeadDisposition::CreateAndNotify
    );
    assert_eq!(
        classify_lead_tier(0.50, 0.6),
        LeadDisposition::CreateWeakOnly
    );
    assert_eq!(classify_lead_tier(0.35, 0.6), LeadDisposition::Discard);
}

#[test]
fn dsl_recursive_conditions_and_schema_validation_errors() {
    let ruleset = RulesetBody {
        dsl: 1,
        prefilter: None,
        classify: vec![ClassifyRule {
            id: "complex_cond".to_string(),
            when: Condition::All(vec![
                Condition::LangIn(vec!["vi".to_string()]),
                Condition::LenGt(25),
                Condition::LenLt(500),
                Condition::Any(vec![
                    Condition::Re(r"\bchinh\s+chu\b".to_string()),
                    Condition::KwAny(vec!["can mua".to_string()]),
                ]),
                Condition::Not(Box::new(Condition::KwAny(vec!["moi gioi".to_string()]))),
                Condition::FieldCmp(FieldCmp {
                    field: "price".to_string(),
                    op: FilterOp::Lte,
                    value: json!(5_000_000_000_i64),
                }),
            ]),
            verdict: RuleVerdict::Match,
            confidence: 0.95,
            set: BTreeMap::from([("intent".to_string(), json!("demand"))]),
        }],
        extract: vec![ExtractRule {
            field: "price".to_string(),
            config: ExtractorConfig::VnMoney {
                near: Vec::new(),
                window: DEFAULT_MONEY_WINDOW,
            },
        }],
        thresholds: Thresholds::default(),
    };

    let post_ok = normalize_text(
        "Gia đình trẻ cần mua nhà riêng khu vực Hoàng Mai tài chính dưới 4 tỷ, làm việc chính chủ",
    );
    let outcome = evaluate_ruleset(&ruleset, &post_ok, &[], REF_TS_2026_11_11).unwrap();
    assert!(matches!(outcome, RulesetOutcome::DefiniteMatch { .. }));

    // Fails `Not(KwAny(["moi gioi"]))` -> falls through to `Uncertain`
    let post_broker = normalize_text(
        "Gia đình trẻ cần mua nhà riêng khu vực Hoàng Mai tài chính dưới 4 tỷ, chấp nhận môi giới",
    );
    let outcome_broker = evaluate_ruleset(&ruleset, &post_broker, &[], REF_TS_2026_11_11).unwrap();
    assert!(matches!(outcome_broker, RulesetOutcome::Uncertain { .. }));

    // Validation error checks
    let mut bad_ver = ruleset.clone();
    bad_ver.dsl = 2;
    assert!(matches!(
        validate_ruleset(&bad_ver),
        Err(RulesetValidationError::UnsupportedDslVersion(2))
    ));

    let mut bad_thresh = ruleset.clone();
    bad_thresh.thresholds.accept = 1.5;
    assert!(matches!(
        validate_ruleset(&bad_thresh),
        Err(RulesetValidationError::InvalidThresholds { .. })
    ));

    let mut dup_id = ruleset.clone();
    dup_id.classify.push(ruleset.classify[0].clone());
    assert!(matches!(
        validate_ruleset(&dup_id),
        Err(RulesetValidationError::DuplicateRuleId(_))
    ));

    let mut bad_field = ruleset.clone();
    bad_field.extract[0].field = "DROP TABLE leads".to_string();
    assert!(matches!(
        validate_ruleset(&bad_field),
        Err(RulesetValidationError::InvalidFieldKey(_))
    ));

    let mut bad_dict = ruleset.clone();
    bad_dict.extract[0].config = ExtractorConfig::Gazetteer {
        dict: "us_states".to_string(),
        scope: None,
    };
    assert!(matches!(
        validate_ruleset(&bad_dict),
        Err(RulesetValidationError::UnsupportedGazetteerDict(_))
    ));

    let mut nested_re = ruleset;
    nested_re.classify[0].when = Condition::Re(r"(a+)+".to_string());
    assert!(matches!(
        validate_ruleset(&nested_re),
        Err(RulesetValidationError::Regex { .. })
    ));
}

#[test]
fn lifecycle_gate_rejects_low_accept_precision_and_invalid_ruleset() {
    let over_eager = RulesetBody {
        dsl: 1,
        prefilter: None,
        classify: vec![ClassifyRule {
            id: "match_everything_thue".to_string(),
            when: Condition::KwAny(vec!["thue".to_string()]),
            verdict: RuleVerdict::Match,
            confidence: 0.95,
            set: BTreeMap::new(),
        }],
        extract: Vec::new(),
        thresholds: Thresholds::default(),
    };

    let samples = vec![
        LabeledSample {
            post_text: "Cần thuê phòng trọ Cầu Giấy giá 4tr".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: true,
            expected_fields: BTreeMap::new(),
        },
        LabeledSample {
            post_text: "Cho thuê phòng trọ khép kín Cầu Giấy giá 4tr".to_string(),
            ref_ts_ms: REF_TS_2026_11_11,
            is_match: false,
            expected_fields: BTreeMap::new(),
        },
    ];

    let report = evaluate_gate(&over_eager, &samples);
    assert!(!report.passed, "precision 0.50 < 0.95 must fail gate");
    assert!((report.accept_precision - 0.5).abs() < 1e-9);

    let mut invalid = over_eager;
    invalid.dsl = 99;
    let invalid_report = evaluate_gate(&invalid, &samples);
    assert!(!invalid_report.passed);
    assert!(invalid_report.validation_error.is_some());
}

#[test]
fn t1_fullwidth_enclosed_unicode_simhash_short_fallback_and_ai_truncation() {
    // Fullwidth digits/letters & enclosed negative squared letters
    let raw = "🅒🅰🅽 Ｃầｎ ｔｈｕê 2PN LH ０９１２３４５６７８";
    let norm = normalize_text(raw);
    assert!(norm.text_norm.contains("CAN Cần thuê"));
    let phones = extract_vn_phone(&norm.text_norm);
    assert_eq!(phones.len(), 1);
    assert_eq!(phones[0].value, json!("+84912345678"));

    // SimHash < 3 words fallback (1-word and 2-word posts) + i64 helpers
    let one_word = normalize_text("aloha");
    let two_words = normalize_text("cần thuê");
    assert_ne!(one_word.simhash_u64(), 0);
    assert_ne!(two_words.simhash_u64(), 0);
    assert_eq!(
        simhash_bands_i64(two_words.simhash),
        two_words.simhash_bands
    );
    assert_eq!(
        hamming_distance_i64(two_words.simhash, two_words.simhash),
        0
    );

    // T5 AI truncation (`05-pipeline-rules.md §7`: > 2500 chars keeps 1800 head + 500 tail)
    let short = "Bài ngắn dưới 2500 ký tự giữ nguyên.";
    assert_eq!(truncate_for_ai(short), (short.to_string(), false));

    let long_body = format!(
        "{} LIÊN HỆ CUỐI BÀI: 0988.777.666",
        "Căn hộ đẹp thoáng mát tại quận Cầu Giấy. ".repeat(80)
    );
    assert!(long_body.chars().count() > 2_500);
    let (truncated, was_truncated) = truncate_for_ai(&long_body);
    assert!(was_truncated);
    assert!(truncated.chars().count() < 2_400);
    assert!(
        truncated.ends_with("LIÊN HỆ CUỐI BÀI: 0988.777.666"),
        "tail contact info must be preserved after truncation"
    );
}

#[test]
fn extractor_date_vi_year_rollover_and_false_positive_guards() {
    // Reference date in December: 2026-12-20T10:00:00+07:00
    let dec_20_2026_ms: i64 = 1_797_735_600_000;
    let rollover_post = normalize_text("Nhận phòng từ ngày 05/01 hoặc đầu tháng sau");
    let dates = extract_date_vi(&rollover_post.text_norm, dec_20_2026_ms);
    assert_valid_matches(&rollover_post.text_norm, &dates);
    assert_eq!(dates[0].value, json!("2027-01-05"));
    assert_eq!(dates[1].value, json!("2027-01-01"));

    // False-positive guards on Vietnamese addresses, 24/7, district names & "khuyến mãi"
    let non_date = normalize_text(
        "Nhà ngõ 15/11 đường Hoàng Mai gần Mai Dịch, siêu thị mở cửa 24/7 đang khuyến mãi lớn",
    );
    let false_dates = extract_date_vi(&non_date.text_norm, REF_TS_2026_11_11);
    assert!(
        false_dates.is_empty(),
        "addresses, 24/7, Hoàng Mai, Mai Dịch, khuyến mãi must not match as dates: {false_dates:?}"
    );

    // "3 tỷ 2 phòng ngủ" must parse as 3.0 tỷ (NOT 3.2 tỷ), and "2pn" must not match Phú Nhuận
    let bds_post = normalize_text("Bán căn hộ 2pn giá 3 tỷ 2 phòng ngủ rộng thoáng");
    let money = extract_vn_money(&bds_post.text_norm, None, None);
    assert_eq!(money[0].value["min"], json!(3_000_000_000_i64));
    assert_eq!(money[0].value["max"], json!(3_000_000_000_i64));
    assert!(extract_gazetteer(&bds_post.text_norm, None).is_empty());
}

#[test]
fn worst_case_5000_char_no_match_post_runs_under_1ms() {
    let bds = seed_ruleset("bds-vi-v1").unwrap();
    let compiled = validate_ruleset(&bds).unwrap();

    // Passes prefilter ("cần thuê" at start), followed by ~5,000 chars of Vietnamese prose
    // with numbers that are NOT money/area/phone/locations so every extractor scans all 5,000 chars.
    let filler = "Gia đình có 4 thành viên gồm 2 người lớn và 2 trẻ nhỏ học lớp 3 và lớp 5, \
        mong muốn không gian yên tĩnh sạch sẽ an ninh đảm bảo hàng xóm thân thiện văn minh lịch sự. ";
    let mut text = String::from("Gia đình cần thuê chỗ ở lâu dài ổn định. ");
    while text.chars().count() < 5_000 {
        text.push_str(filler);
    }
    let long_post = normalize_text(&text.chars().take(5_000).collect::<String>());

    // Warmup + measure single 5-run median in unoptimized test profile
    let _ = compiled.evaluate(&long_post, &[], REF_TS_2026_11_11);
    let mut times = [std::time::Duration::ZERO; 5];
    for slot in &mut times {
        let t0 = std::time::Instant::now();
        let outcome = std::hint::black_box(compiled.evaluate(&long_post, &[], REF_TS_2026_11_11));
        assert!(matches!(outcome, RulesetOutcome::Uncertain { .. }));
        *slot = t0.elapsed();
    }
    times.sort_unstable();
    let median = times[2];
    assert!(
        median < std::time::Duration::from_millis(1),
        "5,000-char full-scan evaluation took {:?} (expected < 1ms)",
        median
    );
}
