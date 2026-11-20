// Golden tests for the rules engine port. Every expectation below is lifted from the Rust oracle
// (`crates/rules/tests/rules_suite.rs`), including the reference timestamp
// 2026-11-11T10:00:00+07:00.

import { describe, expect, it } from "vitest";

import {
  compileSafeRegex,
  describeRuleset,
  evaluateGate,
  evaluateHardFilters,
  extractDateVi,
  extractEnumKw,
  extractGazetteer,
  extractNumber,
  extractRegex,
  extractVnArea,
  extractVnMoney,
  extractVnPhone,
  foldText,
  formatDomesticPhone,
  hammingDistanceU64,
  isNearDuplicate,
  isTooShort,
  isUrlOnly,
  matchesBlocklistKeyword,
  normalizeText,
  parseRulesetBody,
  postprocessFields,
  renormalizeField,
  applyConfidence,
  runBasicPrefilter,
  seedRuleset,
  simhashBandsOf,
  simhashFromI64,
  validateRuleset,
  verifyEvidence,
  type ExtractionMatch,
  type FieldDef,
  type RulesetBody,
} from "../src/rules";

const REF_TS = 1_794_366_000_000;

function assertValidMatches(textNorm: string, matches: ExtractionMatch[]): void {
  expect(matches.length, `expected a match in: ${textNorm}`).toBeGreaterThan(0);
  for (const m of matches) {
    expect(textNorm.slice(m.start, m.end)).toBe(m.raw);
    expect(verifyEvidence(textNorm, m.raw), `verify_evidence(${m.raw})`).toBe(true);
  }
}

const fd = (key: string, type: FieldDef["type"], required = false): FieldDef => ({
  key,
  label: key,
  type,
  description: "",
  required,
  options: null,
  show_in_alert: true,
  order: 0,
});

describe("T1 normalization / T2 SimHash", () => {
  it("folds every Vietnamese vowel and tone", () => {
    const allVi =
      "a à á ả ã ạ ă ằ ắ ẳ ẵ ặ â ầ ấ ẩ ẫ ậ d đ Đ e è é ẻ ẽ ẹ ê ề ế ể ễ ệ i ì í ỉ ĩ ị " +
      "o ò ó ỏ õ ọ ô ồ ổ ỗ ộ ố ơ ờ ớ ở ỡ ợ u ù ú ủ ũ ụ ư ừ ứ ử ữ ự y ỳ ý ỷ ỹ ỵ";
    expect(foldText(allVi)).toBe(
      "a a a a a a a a a a a a a a a a a a d d d e e e e e e e e e e e e i i i i i i " +
        "o o o o o o o o o o o o o o o o o o u u u u u u u u u u u u y y y y y y",
    );
    const nfd = "Ca\u0302\u0300n thue\u0302 nha\u0300 \u0110a\u0300 Na\u0306\u0303ng";
    const norm = normalizeText(nfd);
    expect(norm.text_norm).toBe("Cần thuê nhà Đà Nẵng");
    expect(norm.text_fold).toBe("can thue nha da nang");
  });

  it("normalizes math-bold, zero-width, emoji spam and detects the language", () => {
    const spam =
      "🔥💥 𝐂𝐀̂̀𝐍 𝐓𝐇𝐔𝐄̂\u200B   𝗰𝗮̆𝗻 𝗵𝗼̣̂ 2PN\n\tở 𝐂𝐚̂̀𝐮 𝐆𝐢𝐚̂́𝐲 🏠 giá 12–15tr/th ✅\uFEFF";
    const norm = normalizeText(spam);
    expect(norm.text_norm).toBe("🔥💥 CẦN THUÊ căn hộ 2PN ở Cầu Giấy 🏠 giá 12–15tr/th ✅");
    expect(norm.text_fold).toBe("can thue can ho 2pn o cau giay gia 12-15tr/th");
    expect(norm.lang).toBe("vi");
    expect(normalizeText("Cần thuê nhà").lang).toBe("und");
    expect(normalizeText("Looking to rent a two bedroom apartment near West Lake Hanoi").lang).toBe("en");
  });

  it("content_hash ignores price/phone/punctuation changes in reposts", () => {
    const p1 = normalizeText("Cần thuê căn hộ 2 phòng ngủ Cầu Giấy, giá 12tr/tháng. LH: 0912.345.678");
    const p2 = normalizeText("🔥 Cần thuê căn hộ 3 phòng ngủ Cầu Giấy!! Giá 14.5tr/tháng - LH 0988 999 111");
    expect(p1.content_hash).toBe(p2.content_hash);
    expect(p1.content_hash).toHaveLength(64);
  });

  it("SimHash: near duplicates share a band, unrelated posts diverge, i64 round-trips", () => {
    const base =
      "Gia đình trẻ văn minh lịch sự làm việc văn phòng tại Hà Nội đang cần thuê gấp một căn hộ " +
      "chung cư hai phòng ngủ hai vệ sinh khu vực Dịch Vọng hoặc Trung Hoà hoặc Yên Hoà quận Cầu Giấy Hà Nội, " +
      "ngân sách tài chính khoảng 13 triệu một tháng thanh toán ba tháng cọc một tháng, ưu tiên nhà có ban công " +
      "thoáng mát nhiều ánh sáng tự nhiên có sẵn nội thất cơ bản điều hoà nóng lạnh tủ bếp giường tủ sạch sẽ, " +
      "mong muốn tìm được nhà chính chủ thiện chí hợp đồng lâu dài ổn định từ một đến hai năm, anh chị chủ nhà " +
      "nào có căn phù hợp vui lòng nhắn tin hoặc liên hệ";
    const n1 = normalizeText(`${base} ngay.`);
    const n2 = normalizeText(`${base} sớm.`);
    const n3 = normalizeText(
      "Chính chủ cần bán gấp chiếc xe ô tô Mazda 3 đời 2020 màu trắng chạy chuẩn 4 vạn km " +
        "biển số thành phố Hồ Chí Minh, cam kết không đâm đụng ngập nước, xem xe tại Quận 7.",
    );
    expect(simhashBandsOf(simhashFromI64(n1.simhash))).toEqual(n1.simhash_bands);
    const u1 = simhashFromI64(n1.simhash);
    const u2 = simhashFromI64(n2.simhash);
    expect(hammingDistanceU64(u1, u2)).toBeLessThanOrEqual(3);
    expect(isNearDuplicate(Array.from(n1.text_norm).length, u1, Array.from(n2.text_norm).length, u2)).toBe(true);
    expect(n1.simhash_bands.some((b, i) => b === n2.simhash_bands[i])).toBe(true);
    expect(hammingDistanceU64(u1, simhashFromI64(n3.simhash))).toBeGreaterThan(10);
    const short = normalizeText("Cần thuê phòng Cầu Giấy 5tr");
    const us = simhashFromI64(short.simhash);
    expect(isNearDuplicate(Array.from(short.text_norm).length, us, Array.from(short.text_norm).length, us)).toBe(false);
  });
});

describe("T3 prefilter", () => {
  it("short / url-only / blocklist with word boundaries", () => {
    expect(isTooShort("", false)).toBe(true);
    expect(isTooShort("   ", true)).toBe(true);
    expect(isTooShort("Alo cần thuê", false)).toBe(true);
    expect(isTooShort("Alo cần thuê", true)).toBe(false);
    expect(isTooShort("Cần thuê nhà Cầu Giấy", false)).toBe(false);

    expect(isUrlOnly("https://www.facebook.com/groups/123456/posts/789/")).toBe(true);
    expect(isUrlOnly("http://bit.ly/abc123 https://batdongsan.com.vn/nha-dat")).toBe(true);
    expect(isUrlOnly("Xem chi tiết tại https://batdongsan.com.vn")).toBe(false);
    expect(isUrlOnly("0912.345.678")).toBe(false);
    expect(isUrlOnly("Giá 3.5tr")).toBe(false);

    const norm = normalizeText("Cần thuê căn hộ Cầu Giấy, LH o912 345 678");
    expect(matchesBlocklistKeyword(norm.text_fold, "an")).toBe(false);
    expect(matchesBlocklistKeyword(norm.text_fold, "Cầu Giấy")).toBe(true);
    const reason = runBasicPrefilter(
      { author_id: "normal_user", text_norm: norm.text_norm, text_fold: norm.text_fold, has_attachments: false },
      [
        { kind: "author", value: "fb_spammer_99" },
        { kind: "phone", value: "+84912345678" },
        { kind: "keyword", value: "tuyển cộng tác viên" },
      ],
    );
    expect(reason).toEqual({ kind: "blocked", blocklist: "phone" });
  });
});

describe("built-in extractors", () => {
  it("vn_money: shorthand, ranges, periods, traps and near window", () => {
    const cases: Array<[string, number, number, string | null]> = [
      ["Phòng trọ giá 3tr5 khép kín", 3_500_000, 3_500_000, null],
      ["Ngân sách 3,5 triệu", 3_500_000, 3_500_000, null],
      ["Bán nhà ngõ nông 2 tỷ 3 có thương lượng", 2_300_000_000, 2_300_000_000, null],
      ["Sang nhượng gấp 15 củ", 15_000_000, 15_000_000, null],
      ["Phí dịch vụ 500k", 500_000, 500_000, null],
      ["Cần thuê chung cư 12-15tr/th", 12_000_000, 15_000_000, "month"],
      ["Tài chính tầm 12 - 15 triệu/tháng khu Cầu Giấy", 12_000_000, 15_000_000, "month"],
      ["Tìm mua ô tô cũ dưới 400 triệu", 0, 400_000_000, null],
      ["Đất nền sổ đỏ 1.2 tỉ", 1_200_000_000, 1_200_000_000, null],
      ["Thuê mặt bằng 25tr/năm", 25_000_000, 25_000_000, "year"],
      ["Homestay 800k/ngày", 800_000, 800_000, "day"],
      ["Giá thuê 15.000.000đ/tháng", 15_000_000, 15_000_000, "month"],
      ["Tài chính từ 900 triệu đến 1.1 tỷ", 900_000_000, 1_100_000_000, null],
    ];
    for (const [post, min, max, period] of cases) {
      const norm = normalizeText(post);
      const matches = extractVnMoney(norm.text_norm);
      assertValidMatches(norm.text_norm, matches);
      expect(matches[0].value, post).toEqual({ min, max, currency: "VND", period });
    }
    const trap = normalizeText("Cần mua chung cư 3 tỷ 2 phòng ngủ ở Thanh Xuân");
    const mt = extractVnMoney(trap.text_norm);
    assertValidMatches(trap.text_norm, mt);
    expect(mt[0].value).toMatchObject({ min: 3_000_000_000, max: 3_000_000_000 });

    const multi = normalizeText(
      "Gửi phí cafe 300k cho ai giới thiệu giúp, gia đình mình đang cần tìm căn hộ khu vực Mỹ Đình, ngân sách thuê tầm 11 - 13 triệu/tháng",
    );
    const near = extractVnMoney(multi.text_norm, ["ngân sách", "tài chính"], 35);
    assertValidMatches(multi.text_norm, near);
    expect(near[0].value).toEqual({ min: 11_000_000, max: 13_000_000, currency: "VND", period: "month" });
  });

  it("vn_phone: mobile, landline, obfuscation and URL safety", () => {
    const cases: Array<[string, string]> = [
      ["Liên hệ chính chủ 0912.345.678 để xem nhà", "+84912345678"],
      ["Zalo/SĐT: 09 1234 5678", "+84912345678"],
      ["Gọi ngay o912 345 678 nhé", "+84912345678"],
      ["SĐT O988.12o.456 (miễn TG)", "+84988120456"],
      ["Hotline +84912345678", "+84912345678"],
      ["Tel: 84934567890", "+84934567890"],
      ["Máy bàn văn phòng 024.3825.1234", "+842438251234"],
      ["Chi nhánh HCM: 028 3812 3456", "+842838123456"],
    ];
    for (const [post, e164] of cases) {
      const norm = normalizeText(post);
      const matches = extractVnPhone(norm.text_norm);
      assertValidMatches(norm.text_norm, matches);
      expect(matches[0].value, post).toBe(e164);
    }
    const noPhone = normalizeText(
      "Xem link https://www.facebook.com/groups/0912345678/posts/0987654321 giá 15.000.000 đồng",
    );
    expect(extractVnPhone(noPhone.text_norm)).toEqual([]);
    expect(formatDomesticPhone("+84912345678")).toBe("0912 345 678");
    expect(formatDomesticPhone("+842438251234")).toBe("024 3825 1234");
    expect(formatDomesticPhone("+842363821234")).toBe("0236 382 1234");
  });

  it("vn_area: units, dimensions and ranges", () => {
    const cases: Array<[string, number, number]> = [
      ["Căn hộ 50m2 full đồ", 50, 50],
      ["Diện tích thông thuỷ 50 m²", 50, 50],
      ["Đất phân lô 5x20 vuông vắn", 100, 100],
      ["Nhà phố ngang 4.5m x 16m sổ hồng riêng", 72, 72],
      ["Mặt bằng 4m5 x 20m vỉa hè rộng", 90, 90],
      ["Cần thuê văn phòng 50-70m2", 50, 70],
      ["Nhà rộng 70 mét vuông", 70, 70],
    ];
    for (const [post, min, max] of cases) {
      const norm = normalizeText(post);
      const matches = extractVnArea(norm.text_norm);
      assertValidMatches(norm.text_norm, matches);
      const v = matches[0].value as { min: number; max: number; unit: string };
      expect(v.min, post).toBeCloseTo(min, 6);
      expect(v.max, post).toBeCloseTo(max, 6);
      expect(v.unit).toBe("m2");
    }
  });

  it("gazetteer: hierarchy, abbreviations and scope", () => {
    const cases: Array<[string, string | null, string, string | null, string | null]> = [
      ["Cần thuê căn hộ 2pn khu Dịch Vọng, Cầu Giấy, Hà Nội", null, "Hà Nội", "Cầu Giấy", "Dịch Vọng"],
      ["Tìm phòng trọ kv cg gần trường", "Hà Nội", "Hà Nội", "Cầu Giấy", null],
      ["Cần thuê nhà ntl hoặc btl", "Hà Nội", "Hà Nội", "Nam Từ Liêm", null],
      ["Tìm chung cư ở hbt tài chính 10tr", "Hà Nội", "Hà Nội", "Hai Bà Trưng", null],
      ["Cần thuê căn hộ q7 gần Phú Mỹ Hưng", null, "TP. Hồ Chí Minh", "Quận 7", null],
      ["Tìm mặt bằng tp thủ đức mặt tiền rộng", null, "TP. Hồ Chí Minh", "Thủ Đức", null],
      ["Cần thuê phòng binh thanh hoặc phu nhuan", null, "TP. Hồ Chí Minh", "Bình Thạnh", null],
      ["Bán đất nền Sơn Trà, Đà Nẵng", null, "Đà Nẵng", "Sơn Trà", null],
      ["Cần thuê kho Dĩ An, Bình Dương", null, "Bình Dương", "Dĩ An", null],
      ["Tìm homestay Hồ Tràm cuối tuần", null, "Bà Rịa - Vũng Tàu", "Xuyên Mộc", null],
      ["Cần thuê biệt thự Ecopark", null, "Hưng Yên", "Văn Giang", null],
    ];
    for (const [post, scope, province, district, ward] of cases) {
      const norm = normalizeText(post);
      const matches = extractGazetteer(norm.text_norm, scope);
      assertValidMatches(norm.text_norm, matches);
      expect(matches[0].value, post).toMatchObject({ province, district, ward });
    }
    const hcm = normalizeText("Cần thuê căn hộ 2pn ở Quận 7, TP.HCM giá 12tr");
    expect(extractGazetteer(hcm.text_norm, "Hà Nội")).toEqual([]);
    expect(extractGazetteer(hcm.text_norm, "TP.HCM").length).toBeGreaterThan(0);
    const pn = normalizeText("Cần thuê chung cư 2pn full nội thất giá 10tr");
    expect(extractGazetteer(pn.text_norm, null)).toEqual([]);
  });

  it("number, date_vi, enum_kw and safe regex", () => {
    const num = (t: string) => extractNumber(t, { units: [], prefixes: [], multipliers: {} })[0].value;
    expect(num("Cần thuê xe tải 3 tấn chở hàng")).toBe(3);
    expect(num("Bán Vios đời 2019 chính chủ")).toBe(2019);
    expect(num("Xe chạy chuẩn 5 vạn km zin")).toBe(50_000);
    expect(num("Căn hộ 2pn thoáng mát")).toBe(2);

    const dates: Array<[string, string]> = [
      ["Dọn vào hôm nay luôn ạ", "2026-11-11"],
      ["Chuyển nhà vào ngày mai", "2026-11-12"],
      ["Cần xe ghép sáng mai đi Hải Phòng", "2026-11-12"],
      ["Xem nhà cuối tuần này", "2026-11-14"],
      ["Nhận phòng cuối tháng này", "2026-11-30"],
      ["Bắt đầu thuê từ đầu tháng sau", "2026-12-01"],
      ["Cần chuyển đồ ngày 15/11", "2026-11-15"],
      ["Hợp đồng từ 15/11/2026", "2026-11-15"],
      ["Ngày khởi hành 2026-12-25", "2026-12-25"],
    ];
    for (const [post, iso] of dates) {
      const norm = normalizeText(post);
      const matches = extractDateVi(norm.text_norm, REF_TS);
      assertValidMatches(norm.text_norm, matches);
      expect(matches[0].value, post).toBe(iso);
    }
    const nonDate = normalizeText(
      "Cho thuê nhà ngõ 15/11 đường 3/2 phường Mai Dịch và Hoàng Mai, mở cửa 24/7 nhiều khuyến mãi",
    );
    expect(extractDateVi(nonDate.text_norm, REF_TS)).toEqual([]);

    const am = normalizeText("Căn hộ có ban công rộng, sẵn điều hoà và máy giặt");
    const multi = extractEnumKw(am.text_norm, { ac: ["dieu hoa", "may lanh"], washer: ["may giat"], balcony: ["ban cong"] }, true);
    assertValidMatches(am.text_norm, multi);
    expect(multi[0].value).toEqual(["balcony", "ac", "washer"]);

    const bed = normalizeText("Cần thuê căn hộ 3 phòng ngủ ở Cầu Giấy");
    const re = extractRegex(bed.text_norm, String.raw`(\d)\s*(pn|phong ngu|ngu)\b`, 1, "int");
    assertValidMatches(bed.text_norm, re);
    expect(re[0].raw).toBe("3 phòng ngủ");
    expect(re[0].value).toBe(3);

    expect(() => compileSafeRegex("(a+)+")).toThrow();
    expect(() => compileSafeRegex("(.*)+")).toThrow();
    expect(() => compileSafeRegex(String.raw`\w{500}`)).toThrow();
    expect(() => compileSafeRegex("a".repeat(600))).toThrow();
    expect(() => extractRegex("2pn", String.raw`\d+pn`, 1, "int")).toThrow();
  });
});

describe("ruleset DSL v1, seed and gate", () => {
  const SPEC = JSON.parse(`{
    "dsl": 1,
    "prefilter": {
      "any": ["can thue", "tim phong", "tim nha", "can tim", "re:\\\\bthue\\\\b"],
      "none": ["cho thue", "chinh chu cho thue", "tuyen dung"],
      "min_len": 20
    },
    "classify": [
      {"id": "r1", "when": {"all": [
        {"kw_any": ["can thue", "tim thue", "muon thue"]},
        {"kw_none": ["cho thue", "ben em co", "hoa hong", "ib em"]},
        {"has_field": "location"}]},
       "verdict": "match", "confidence": 0.92, "set": {"intent": "demand"}},
      {"id": "r2", "when": {"kw_any": ["ben em co", "quy can", "hoa hong", "ky gui"]},
       "verdict": "no_match", "confidence": 0.9, "set": {"author_role": "peer"}}
    ],
    "extract": [
      {"field": "price", "extractor": "vn_money", "near": ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"], "window": 40},
      {"field": "location", "extractor": "gazetteer", "dict": "vn_admin", "scope": "Hà Nội"},
      {"field": "phone", "extractor": "vn_phone"},
      {"field": "bedrooms", "extractor": "regex", "pattern": "(\\\\d)\\\\s*(pn|phong ngu|ngu)\\\\b", "group": 1, "cast": "int"},
      {"field": "deal_type", "extractor": "enum_kw", "map": {"rent": ["thue"], "buy": ["mua"]}}
    ],
    "thresholds": {"accept": 0.9, "reject": 0.9}
  }`);

  it("parses, validates, describes and evaluates every outcome kind", () => {
    const body = parseRulesetBody(SPEC);
    const compiled = validateRuleset(body, { maxMedianMs: 250 });
    const summary = describeRuleset(body);
    expect(summary.accept_keywords).toContain("can thue");
    expect(summary.reject_keywords).toContain("cho thue");
    expect(summary.extracted_fields).toEqual(["price", "location", "phone", "bedrooms", "deal_type"]);

    const defs = [fd("price", "money", true)];
    const supply = normalizeText("Chính chủ cho thuê căn hộ 2PN Cầu Giấy giá 12tr/th LH 0912345678");
    expect(compiled.evaluate(supply, defs, REF_TS)).toEqual({ kind: "prefilter_reject" });

    const tenant = normalizeText(
      "Vợ chồng trẻ cần thuê căn hộ 2 phòng ngủ khu Cầu Giấy, tài chính tầm 12-15tr/th, LH 0912.345.678",
    );
    const m = compiled.evaluate(tenant, defs, REF_TS);
    if (m.kind !== "definite_match") throw new Error(`expected definite_match, got ${JSON.stringify(m)}`);
    expect(m.rule_id).toBe("r1");
    expect(m.set.intent).toBe("demand");
    expect(m.fields.bedrooms.value).toBe(2);
    expect(m.fields.phone.value).toBe("+84912345678");
    expect(m.fields.deal_type.value).toBe("rent");

    const noPrice = normalizeText("Mình cần thuê gấp căn hộ 2 phòng ngủ ở Cầu Giấy vào ở luôn tuần này");
    const u = compiled.evaluate(noPrice, defs, REF_TS);
    if (u.kind !== "uncertain") throw new Error(`expected uncertain, got ${JSON.stringify(u)}`);
    expect(u.matched_rule_id).toBe("r1");
    expect(Object.keys(u.hint_fields)).toContain("location");
    expect(Object.keys(u.hint_fields)).not.toContain("price");

    const broker = normalizeText("Hỗ trợ khách thuê tìm nhà Cầu Giấy: bên em có quỹ căn 2PN giá cực tốt, hoa hồng 50%");
    const nm = compiled.evaluate(broker, defs, REF_TS);
    if (nm.kind !== "definite_no_match") throw new Error(`expected definite_no_match, got ${JSON.stringify(nm)}`);
    expect(nm.rule_id).toBe("r2");
    expect(nm.set.author_role).toBe("peer");
  });

  it("seed bds-vi-v1 validates and handles a no-diacritics post", () => {
    expect(seedRuleset("unknown-seed")).toBeNull();
    const bds = seedRuleset("bds-vi-v1");
    if (!bds) throw new Error("seed missing");
    const compiled = validateRuleset(bds, { maxMedianMs: 250 });
    const post = normalizeText("vc tre can thue chung cu 2pn kv cau giay tai chinh tam 12tr/th lh o912 345 678");
    const out = compiled.evaluate(post, [], REF_TS);
    if (out.kind !== "definite_match") throw new Error(`expected definite_match, got ${JSON.stringify(out)}`);
    expect(out.fields.deal_type.value).toBe("rent");
    expect(out.fields.property_type.value).toBe("apartment");
    expect(out.fields.bedrooms.value).toBe(2);
    expect(out.fields.phone.value).toBe("+84912345678");
    expect((out.fields.location.value as { district: string }).district).toBe("Cầu Giấy");
  });

  it("lifecycle gate prunes low-accuracy extractors and enforces FN rate", () => {
    const ruleset: RulesetBody = seedRuleset("bds-vi-v1") as RulesetBody;
    ruleset.extract = [
      { field: "location", extractor: "gazetteer", dict: "vn_admin", scope: null },
      { field: "phone", extractor: "vn_phone" },
      { field: "bad_floor", extractor: "regex", pattern: String.raw`tang\s*(\d+)`, group: 1, cast: "int" },
    ];
    const samples = [
      {
        post_text: "Cần thuê căn hộ khu Cầu Giấy giá 12tr LH 0912345678",
        ref_ts_ms: REF_TS,
        is_match: true,
        expected_fields: {
          location: { province: "Hà Nội", district: "Cầu Giấy", ward: null },
          phone: "+84912345678",
          bad_floor: 99,
        },
      },
      {
        post_text: "Gia đình muốn thuê nhà riêng ở Thanh Xuân LH 0987654321",
        ref_ts_ms: REF_TS,
        is_match: true,
        expected_fields: {
          location: { province: "Hà Nội", district: "Thanh Xuân", ward: null },
          phone: "+84987654321",
          bad_floor: 5,
        },
      },
      { post_text: "Bên em có quỹ căn giá tốt khu Cầu Giấy nhận ký gửi", ref_ts_ms: REF_TS, is_match: false, expected_fields: {} },
      { post_text: "Tuyển dụng nhân viên kinh doanh lương cứng 15 triệu", ref_ts_ms: REF_TS, is_match: false, expected_fields: {} },
    ];
    const report = evaluateGate(ruleset, samples, { maxMedianMs: 250 });
    expect(report.passed, JSON.stringify(report)).toBe(true);
    expect(report.false_negative_rate).toBe(0);
    expect(report.accept_precision).toBe(1);
    expect(report.dropped_fields).toEqual(["bad_floor"]);
    expect(report.pruned_ruleset.extract).toHaveLength(2);

    const bad = evaluateGate(
      ruleset,
      [...samples, { post_text: "Tuyển dụng nhân viên cần thuê gấp nhà Cầu Giấy", ref_ts_ms: REF_TS, is_match: true, expected_fields: {} }],
      { maxMedianMs: 250 },
    );
    expect(bad.passed).toBe(false);
    expect(bad.false_negative_rate).toBeGreaterThan(0.02);
  });
});

describe("T6 postfilter", () => {
  it("verifies evidence, renormalizes and drops hallucinated required fields", () => {
    const post = normalizeText(
      "Cần thuê chung cư 2PN khu Cầu Giấy, ngân sách tầm 3tr5 – 4tr5/tháng, dọn vào cuối tháng này. LH 0912.345.678",
    );
    expect(verifyEvidence(post.text_norm, "tầm 3tr5 - 4tr5/tháng")).toBe(true);
    expect(verifyEvidence(post.text_norm, "khu   cầu\ngiấy")).toBe(true);
    expect(verifyEvidence(post.text_norm, "")).toBe(false);
    expect(verifyEvidence(post.text_norm, "   ")).toBe(false);
    expect(verifyEvidence(post.text_norm, "Quận Ba Đình")).toBe(false);
    expect(verifyEvidence(post.text_norm, "0988.999.000")).toBe(false);

    const price = fd("price", "money", true);
    const phone = fd("phone", "phone", true);
    const moveIn = fd("move_in", "date");
    const renorm = renormalizeField(price, "3tr5", { min: 350_000, max: 350_000, currency: "VND", period: null }, REF_TS);
    expect(renorm.overridden).toBe(true);
    expect(renorm.value).toEqual({ min: 3_500_000, max: 3_500_000, currency: "VND", period: null });
    expect(applyConfidence(renorm, 0.92)).toBeLessThan(0.92);

    const out = postprocessFields(post.text_norm, [price, phone, moveIn], {
      price: {
        value: { min: 3_500_000, max: 4_500_000, currency: "VND", period: "month" },
        raw: "tầm 3tr5 – 4tr5/tháng",
        confidence: 0.95,
        source: "ai",
      },
      phone: { value: "+84999999999", raw: "0999.999.999", confidence: 0.9, source: "ai" },
      move_in: { value: "2026-11-28", raw: "cuối tháng này", confidence: 0.88, source: "ai" },
    }, REF_TS);
    expect(out.dropped_keys).toEqual(["phone"]);
    expect(out.dropped_required_count).toBe(1);
    expect(out.score_penalty).toBeCloseTo(0.2, 9);
    expect(out.fields.price.confidence).toBe(0.95);
    expect(out.fields.move_in.value).toBe("2026-11-30");
    expect(out.fields.move_in.confidence).toBeLessThan(0.88);
  });

  it("hard filters honor when_missing and numeric/location operators", () => {
    const fields = {
      price: { value: { min: 12_000_000, max: 15_000_000, currency: "VND", period: "month" }, raw: "12-15tr/th", confidence: 0.95, source: "rule" as const },
      location: {
        value: { raw: "Dịch Vọng, Cầu Giấy", province: "Hà Nội", district: "Cầu Giấy", ward: "Dịch Vọng" },
        raw: "Dịch Vọng, Cầu Giấy",
        confidence: 0.96,
        source: "rule" as const,
      },
    };
    const f = (field: string, op: Parameters<typeof evaluateHardFilters>[0][number]["op"], value: unknown, when_missing = "pass") => ({
      field,
      op,
      value,
      when_missing,
    });
    expect(evaluateHardFilters([f("price", "lte", 15_000_000)], fields)).toBe(true);
    expect(evaluateHardFilters([f("price", "lt", 15_000_000)], fields)).toBe(false);
    expect(evaluateHardFilters([f("price", "gte", 12_000_000)], fields)).toBe(true);
    expect(evaluateHardFilters([f("price", "between", [10_000_000, 20_000_000])], fields)).toBe(true);
    expect(evaluateHardFilters([f("location", "eq", "cau giay")], fields)).toBe(true);
    expect(evaluateHardFilters([f("location", "contains", "dich vong")], fields)).toBe(true);
    expect(evaluateHardFilters([f("bedrooms", "gte", 2, "pass")], fields)).toBe(true);
    expect(evaluateHardFilters([f("bedrooms", "gte", 2, "fail")], fields)).toBe(false);
    expect(evaluateHardFilters([f("bedrooms", "is_empty", true)], fields)).toBe(true);
  });
});
