// Mock backend state shape and initial seed data.

import type {
  Settings,
  LicenseStatus,
  HealthStatus,
  AiProviderId,
  ProbeResult,
  Channel,
  Source,
  Radar,
  RadarVersion,
  Ruleset,
  Post,
  Lead,
  LeadEvent,
  RejectedEvaluation,
  Contact,
  BlocklistEntry,
  CrawlRun,
  PreviewRunState,
  PreviewItem,
  PlanTier,
  FieldDef,
} from "../../types/ipc";
import tplBdsKhachThue from "../../../../templates/bds.khach-thue.json";

export interface MockCommandCall {
  cmd: string;
  args: Record<string, unknown>;
  ts: number;
}

export interface MockState {
  settings: Settings;
  license: LicenseStatus;
  health: HealthStatus;
  probes: Record<AiProviderId, ProbeResult>;
  channels: Channel[];
  sources: Source[];
  radars: Radar[];
  radarVersions: RadarVersion[];
  pendingVersions: Record<string, RadarVersion>;
  rulesets: Ruleset[];
  posts: Post[];
  leads: Lead[];
  leadEvents: Record<string, LeadEvent[]>;
  rejectedEvaluations: RejectedEvaluation[];
  contacts: Contact[];
  blocklist: BlocklistEntry[];
  crawlRuns: CrawlRun[];
  previews: Record<string, PreviewRunState>;
  previewFeedback: Record<string, Record<string, PreviewItem["feedback_label"]>>;
  calls: MockCommandCall[];
}

export function buildPlanLimits(plan: PlanTier): LicenseStatus["limits"] {
  if (plan === "pro") {
    return {
      max_active_radars: null,
      max_followed_groups: 50,
      max_fields_per_radar: 20,
      allow_xlsx_export: true,
      allow_webhooks: true,
      allow_auto_rulesets: true,
    };
  }
  return {
    max_active_radars: 2,
    max_followed_groups: 10,
    max_fields_per_radar: 12,
    allow_xlsx_export: false,
    allow_webhooks: false,
    allow_auto_rulesets: true,
  };
}

export function createInitialState(): MockState {
  const now = 1794470400000; // 2026-11-12T08:00:00Z
  const src1Id = "01JCF100000000000000000001";
  const src2Id = "01JCF100000000000000000002";
  const src3Id = "01JCF100000000000000000003";
  const src4Id = "01JCF100000000000000000004";

  const radar1Id = "01JCF300000000000000000001";
  const rv1Id = "01JCF400000000000000000001";
  const chan1Id = "01JCF900000000000000000001";

  const bdsFields: FieldDef[] = structuredClone(tplBdsKhachThue.fields as FieldDef[]);

  const sources: Source[] = [
    {
      id: src1Id,
      platform: "facebook",
      kind: "group",
      external_id: "thuenhacaugiay",
      name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      url: "https://www.facebook.com/groups/thuenhacaugiay/",
      privacy: "private",
      member_count: 84200,
      profile_id: "chrome-default",
      followed: true,
      priority: true,
      state: "ok",
      last_crawl_at: now - 4 * 60_000,
      avg_new_posts: 11.4,
      posts_per_day: 142,
      stored_post_count: 318,
      last_error: null,
      created_at: now - 14 * 86_400_000,
    },
    {
      id: src2Id,
      platform: "facebook",
      kind: "group",
      external_id: "chinhchuhanoi247",
      name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      url: "https://www.facebook.com/groups/chinhchuhanoi247/",
      privacy: "public",
      member_count: 129500,
      profile_id: "chrome-default",
      followed: true,
      priority: false,
      state: "ok",
      last_crawl_at: now - 12 * 60_000,
      avg_new_posts: 8.2,
      posts_per_day: 96,
      stored_post_count: 245,
      last_error: null,
      created_at: now - 14 * 86_400_000,
    },
    {
      id: src3Id,
      platform: "facebook",
      kind: "group",
      external_id: "thodiennuochanoi",
      name: "Tìm Thợ Sửa Điện Nước - Điều Hoà Hà Nội",
      url: "https://www.facebook.com/groups/thodiennuochanoi/",
      privacy: "public",
      member_count: 46100,
      profile_id: "chrome-default",
      followed: false,
      priority: false,
      state: "ok",
      last_crawl_at: null,
      avg_new_posts: 5.0,
      posts_per_day: 54,
      stored_post_count: 42,
      last_error: null,
      created_at: now - 10 * 86_400_000,
    },
    {
      id: src4Id,
      platform: "facebook",
      kind: "group",
      external_id: "otocumienbac",
      name: "Hội Mua Bán Ô Tô Cũ Chính Chủ Miền Bắc",
      url: "https://www.facebook.com/groups/otocumienbac/",
      privacy: "private",
      member_count: 93800,
      profile_id: "chrome-default",
      followed: false,
      priority: false,
      state: "ok",
      last_crawl_at: null,
      avg_new_posts: 7.5,
      posts_per_day: 88,
      stored_post_count: 64,
      last_error: null,
      created_at: now - 7 * 86_400_000,
    },
  ];

  const radars: Radar[] = [
    {
      id: radar1Id,
      name: "Khách thuê căn hộ Cầu Giấy",
      status: "active",
      template_id: "bds.khach-thue",
      current_version: 1,
      source_ids: [src1Id, src2Id],
      notify: {
        channel_ids: [chan1Id],
        mode: "instant",
        min_score: 0.6,
        quiet_hours: null,
      },
      created_at: now - 7 * 86_400_000,
      updated_at: now - 3_600_000,
      leads_24h: 14,
      false_positive_rate: 0.07,
      evaluated_posts_total: 428,
      rule_handled_pct: 82,
      auto_digest_flood: false,
    },
  ];

  const radarVersions: RadarVersion[] = [
    {
      id: rv1Id,
      radar_id: radar1Id,
      version: 1,
      description:
        "Người đang cần thuê căn hộ 2 phòng ngủ ở Cầu Giấy hoặc Mỹ Đình, ngân sách dưới 15 triệu/tháng",
      language_hint: "vi",
      user_profession: "môi giới bất động sản",
      fields: bdsFields,
      match_policy: {
        want_intent: "demand",
        exclude_roles: ["peer"],
        hard_filters: [
          { field: "price", op: "lte", value: 15_000_000, when_missing: "pass" },
        ],
      },
      created_at: now - 7 * 86_400_000,
    },
  ];

  const rulesets: Ruleset[] = [
    {
      id: "01JCF500000000000000000001",
      radar_version_id: rv1Id,
      revision: 1,
      state: "active",
      origin: "seed",
      body: {
        dsl: 1,
        prefilter: {
          any: ["can thue", "tim thue", "tim can ho", "tim chung cu", "muon thue"],
          none: ["chinh chu cho thue", "quy can", "hoa hong", "tuyen sale"],
          min_len: 20,
        },
        classify: [
          {
            id: "r1",
            description: "Khách trực tiếp cần thuê nhà tại khu vực mục tiêu",
            kw_any: ["can thue", "tim thue", "muon thue"],
            kw_none: ["cho thue", "ben em co", "quy can", "hoa hong", "ib em"],
            has_field: "location",
            verdict: "match",
            confidence: 0.92,
            set: { intent: "demand" },
          },
          {
            id: "r2",
            description: "Môi giới chào quỹ căn hoặc tuyển cộng tác viên",
            kw_any: ["ben em co", "quy can", "hoa hong", "ky gui"],
            verdict: "no_match",
            confidence: 0.91,
            set: { author_role: "peer" },
          },
        ],
        extract: [
          {
            field: "price",
            extractor: "vn_money",
            near: ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"],
            window: 40,
          },
          { field: "location", extractor: "gazetteer", scope: "Hà Nội" },
          { field: "phone", extractor: "vn_phone" },
          { field: "area", extractor: "vn_area" },
          { field: "bedrooms", extractor: "regex", pattern: "(\\d)\\s*(pn|phong ngu)\\b" },
          { field: "deal_type", extractor: "enum_kw", map: { thuê: ["thue"], mua: ["mua"] } },
        ],
        thresholds: { accept: 0.9, reject: 0.9 },
      },
      metrics: {
        rule_handled_pct: 82,
        ai_handled_pct: 18,
        accept_precision: 0.96,
        false_negative_rate: 0.015,
        sample_size: 428,
      },
      created_at: now - 7 * 86_400_000,
      activated_at: now - 6 * 86_400_000,
    },
  ];

  const post1Id = "01JCF600000000000000000001";
  const post2Id = "01JCF600000000000000000002";
  const post3Id = "01JCF600000000000000000003";
  const postRej1Id = "01JCF600000000000000000004";
  const postRej2Id = "01JCF600000000000000000005";

  const posts: Post[] = [
    {
      id: post1Id,
      platform: "facebook",
      external_id: "98765432101",
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_id: "author-1",
      author_name: "Nguyễn Minh Tuấn",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432101/",
      text: "Vợ chồng mình cần thuê căn hộ 2 phòng ngủ khu Dịch Vọng Hậu, Cầu Giấy diện tích khoảng 65-75m2, tài chính tầm 12-14tr/th, vào ở đầu tháng sau. Bác nào chính chủ báo giúp em qua số 0912.345.678 nhé. Xem thêm tại https://example-tracker.test/ref",
      text_truncated: false,
      lang: "vi",
      created_at: now - 8 * 60_000,
      captured_at: now - 6 * 60_000,
      strategy: "network",
      purged_at: null,
    },
    {
      id: post2Id,
      platform: "facebook",
      external_id: "98765432102",
      source_id: src2Id,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_id: "author-2",
      author_name: "Trần Thu Hà",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432102/",
      text: "Em đang tìm thuê chung cư mini hoặc căn hộ 1-2PN khu Mỹ Đình, Nam Từ Liêm cho 2 chị em đi làm, ngân sách dưới 10 triệu/tháng, ưu tiên đủ đồ cơ bản. LH em Hà 0987 654 321.",
      text_truncated: false,
      lang: "vi",
      created_at: now - 35 * 60_000,
      captured_at: now - 31 * 60_000,
      strategy: "network",
      purged_at: null,
    },
    {
      id: post3Id,
      platform: "facebook",
      external_id: "98765432103",
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_id: "author-3",
      author_name: "Lê Hoàng Nam",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432103/",
      text: "Cần tìm phòng hoặc căn studio quanh Xuân Thuỷ Cầu Giấy tầm 6 triệu/tháng cho 1 người ở lâu dài.",
      text_truncated: false,
      lang: "vi",
      created_at: now - 95 * 60_000,
      captured_at: now - 90 * 60_000,
      strategy: "embedded",
      purged_at: null,
    },
    {
      id: postRej1Id,
      platform: "facebook",
      external_id: "98765432104",
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_id: "author-peer-1",
      author_name: "Sàn BĐS Thành Đạt",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432104/",
      text: "Bên em có quỹ căn 2PN - 3PN Vinhomes Skylake, Cầu Giấy giá tốt nhất thị trường từ 16tr/th, hoa hồng cao cho anh em kết hợp. IB em ngay!",
      text_truncated: false,
      lang: "vi",
      created_at: now - 25 * 60_000,
      captured_at: now - 20 * 60_000,
      strategy: "network",
      purged_at: null,
    },
    {
      id: postRej2Id,
      platform: "facebook",
      external_id: "98765432105",
      source_id: src2Id,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_id: "author-5",
      author_name: "Phạm Quốc Khánh",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432105/",
      text: "Gia đình chuyển công tác cần nhượng lại hợp đồng thuê căn 2PN Trung Hoà Nhân Chính 13tr/tháng, đồ đẹp y hình.",
      text_truncated: false,
      lang: "vi",
      created_at: now - 50 * 60_000,
      captured_at: now - 45 * 60_000,
      strategy: "network",
      purged_at: null,
    },
  ];

  const lead1Id = "01JCF700000000000000000001";
  const lead2Id = "01JCF700000000000000000002";
  const lead3Id = "01JCF700000000000000000003";

  const leads: Lead[] = [
    {
      id: lead1Id,
      radar_id: radar1Id,
      radar_name: "Khách thuê căn hộ Cầu Giấy",
      radar_version_id: rv1Id,
      radar_version: 1,
      post_id: post1Id,
      evaluation_id: "01JCF800000000000000000001",
      contact_id: "01JCFA00000000000000000001",
      status: "new",
      score: 0.94,
      is_weak_match: false,
      summary: "Vợ chồng cần thuê căn hộ 2PN Dịch Vọng Hậu, Cầu Giấy, 12–14 triệu/tháng",
      reason: "Khách gia đình nêu rõ nhu cầu thuê căn hộ 2PN tại Cầu Giấy, ngân sách dưới 15 triệu và để lại SĐT.",
      decided_by: "rule",
      fields: {
        deal_type: { value: "thuê", raw: "cần thuê", confidence: 0.96, source: "rule" },
        property_type: { value: "căn hộ", raw: "căn hộ", confidence: 0.95, source: "rule" },
        location: {
          value: {
            raw: "Dịch Vọng Hậu, Cầu Giấy",
            province: "Hà Nội",
            district: "Cầu Giấy",
            ward: "Dịch Vọng Hậu",
          },
          raw: "Dịch Vọng Hậu, Cầu Giấy",
          confidence: 0.95,
          source: "rule",
        },
        price: {
          value: { min: 12_000_000, max: 14_000_000, currency: "VND", period: "month" },
          raw: "tầm 12-14tr/th",
          confidence: 0.93,
          source: "rule",
        },
        area: {
          value: { min: 65, max: 75, unit: "m2" },
          raw: "65-75m2",
          confidence: 0.91,
          source: "rule",
        },
        bedrooms: { value: 2, raw: "2 phòng ngủ", confidence: 0.97, source: "rule" },
        phone: { value: "+84912345678", raw: "0912.345.678", confidence: 0.99, source: "rule" },
      },
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_id: "author-1",
      author_name: "Nguyễn Minh Tuấn",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432101/",
      post_created_at: now - 8 * 60_000,
      also_seen_in: [
        {
          source_id: src2Id,
          source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
          permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765439999/",
          captured_at: now - 5 * 60_000,
        },
      ],
      notified_at: now - 5 * 60_000,
      follow_up_at: null,
      note: null,
      tags: ["khách nét", "ở ngay"],
      feedback_label: null,
      created_at: now - 6 * 60_000,
      updated_at: now - 6 * 60_000,
    },
    {
      id: lead2Id,
      radar_id: radar1Id,
      radar_name: "Khách thuê căn hộ Cầu Giấy",
      radar_version_id: rv1Id,
      radar_version: 1,
      post_id: post2Id,
      evaluation_id: "01JCF800000000000000000002",
      contact_id: "01JCFA00000000000000000002",
      status: "viewed",
      score: 0.86,
      is_weak_match: false,
      summary: "Tìm thuê căn hộ 1–2PN khu Mỹ Đình, Nam Từ Liêm, dưới 10 triệu/tháng",
      reason: "Khách thực tìm căn hộ 1-2PN khu Mỹ Đình dưới 10tr/tháng, có SĐT trực tiếp.",
      decided_by: "ai",
      fields: {
        deal_type: { value: "thuê", raw: "tìm thuê", confidence: 0.95, source: "ai" },
        property_type: { value: "căn hộ", raw: "căn hộ", confidence: 0.9, source: "ai" },
        location: {
          value: {
            raw: "khu Mỹ Đình, Nam Từ Liêm",
            province: "Hà Nội",
            district: "Nam Từ Liêm",
            ward: "Mỹ Đình",
          },
          raw: "khu Mỹ Đình, Nam Từ Liêm",
          confidence: 0.92,
          source: "ai",
        },
        price: {
          value: { min: 10_000_000, max: 10_000_000, currency: "VND", period: "month" },
          raw: "dưới 10 triệu/tháng",
          confidence: 0.89,
          source: "ai",
        },
        bedrooms: { value: 2, raw: "1-2PN", confidence: 0.84, source: "ai" },
        phone: { value: "+84987654321", raw: "0987 654 321", confidence: 0.99, source: "ai" },
      },
      source_id: src2Id,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_id: "author-2",
      author_name: "Trần Thu Hà",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432102/",
      post_created_at: now - 35 * 60_000,
      also_seen_in: [],
      notified_at: now - 30 * 60_000,
      follow_up_at: now + 3_600_000,
      note: "Đã kết bạn Zalo, hẹn chiều gửi ảnh căn Mỹ Đình Pearl.",
      tags: ["hẹn xem nhà"],
      feedback_label: "correct",
      created_at: now - 31 * 60_000,
      updated_at: now - 20 * 60_000,
    },
    {
      id: lead3Id,
      radar_id: radar1Id,
      radar_name: "Khách thuê căn hộ Cầu Giấy",
      radar_version_id: rv1Id,
      radar_version: 1,
      post_id: post3Id,
      evaluation_id: "01JCF800000000000000000003",
      contact_id: null,
      status: "new",
      score: 0.52,
      is_weak_match: true,
      summary: "Tìm phòng hoặc studio Xuân Thuỷ, Cầu Giấy tầm 6 triệu/tháng (khớp yếu: không phải 2PN)",
      reason: "Đúng khu vực Cầu Giấy và nhu cầu thuê nhưng khách tìm phòng đơn/studio 1 người thay vì căn hộ 2PN.",
      decided_by: "ai",
      fields: {
        deal_type: { value: "thuê", raw: "Cần tìm phòng", confidence: 0.85, source: "ai" },
        property_type: { value: "phòng trọ", raw: "phòng hoặc căn studio", confidence: 0.82, source: "ai" },
        location: {
          value: {
            raw: "Xuân Thuỷ Cầu Giấy",
            province: "Hà Nội",
            district: "Cầu Giấy",
            ward: "Dịch Vọng Hậu",
          },
          raw: "Xuân Thuỷ Cầu Giấy",
          confidence: 0.91,
          source: "ai",
        },
        price: {
          value: { min: 6_000_000, max: 6_000_000, currency: "VND", period: "month" },
          raw: "tầm 6 triệu/tháng",
          confidence: 0.9,
          source: "ai",
        },
      },
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_id: "author-3",
      author_name: "Lê Hoàng Nam",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432103/",
      post_created_at: now - 95 * 60_000,
      also_seen_in: [],
      notified_at: null,
      follow_up_at: null,
      note: null,
      tags: [],
      feedback_label: null,
      created_at: now - 90 * 60_000,
      updated_at: now - 90 * 60_000,
    },
  ];

  const rejectedEvaluations: RejectedEvaluation[] = [
    {
      evaluation_id: "01JCF800000000000000000091",
      post_id: postRej1Id,
      radar_id: radar1Id,
      radar_version_id: rv1Id,
      decided_by: "rule",
      reject_reason: "peer",
      score: 0.08,
      reason: "Phát hiện cụm từ môi giới ('bên em có quỹ căn', 'hoa hồng').",
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_name: "Sàn BĐS Thành Đạt",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432104/",
      post_text: posts[3]!.text!,
      captured_at: now - 20 * 60_000,
    },
    {
      evaluation_id: "01JCF800000000000000000092",
      post_id: postRej2Id,
      radar_id: radar1Id,
      radar_version_id: rv1Id,
      decided_by: "ai",
      reject_reason: "irrelevant",
      score: 0.31,
      reason: "Bài nhượng hợp đồng cho thuê (ý định supply), không phải khách đi tìm thuê.",
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_name: "Phạm Quốc Khánh",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432105/",
      post_text: posts[4]!.text!,
      captured_at: now - 45 * 60_000,
    },
  ];

  const contacts: Contact[] = [
    {
      id: "01JCFA00000000000000000001",
      display_name: "Nguyễn Minh Tuấn",
      phones: ["+84912345678"],
      author_ids: ["author-1"],
      note: "Khách gia đình thiện chí khu Cầu Giấy",
      lead_count: 1,
      is_blocked: false,
      created_at: now - 6 * 60_000,
      updated_at: now - 6 * 60_000,
    },
    {
      id: "01JCFA00000000000000000002",
      display_name: "Trần Thu Hà",
      phones: ["+84987654321"],
      author_ids: ["author-2"],
      note: "Tìm căn 1-2PN Mỹ Đình cho 2 chị em",
      lead_count: 1,
      is_blocked: false,
      created_at: now - 31 * 60_000,
      updated_at: now - 20 * 60_000,
    },
  ];

  const blocklist: BlocklistEntry[] = [
    {
      id: "01JCFB00000000000000000001",
      kind: "author",
      value: "author-spam-99",
      display_label: "Kho Tổng Chung Cư Mini HN",
      radar_id: null,
      reason: "Môi giới đăng lặp ở 9 group",
      created_at: now - 2 * 86_400_000,
    },
    {
      id: "01JCFB00000000000000000002",
      kind: "keyword",
      value: "tuyen cong tac vien bds",
      display_label: "tuyen cong tac vien bds",
      radar_id: null,
      reason: "Tin tuyển sale rác",
      created_at: now - 3 * 86_400_000,
    },
  ];

  const crawlRuns: CrawlRun[] = [
    {
      id: "01JCFC00000000000000000001",
      source_id: src1Id,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      reason: "scheduled",
      status: "ok",
      started_at: now - 4 * 60_000 - 18_000,
      ended_at: now - 4 * 60_000,
      posts_seen: 24,
      posts_new: 11,
      page_loads: 1,
      strategy: "network",
      error: null,
    },
    {
      id: "01JCFC00000000000000000002",
      source_id: src2Id,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      reason: "scheduled",
      status: "ok",
      started_at: now - 12 * 60_000 - 22_000,
      ended_at: now - 12 * 60_000,
      posts_seen: 20,
      posts_new: 8,
      page_loads: 1,
      strategy: "network",
      error: null,
    },
  ];

  const channels: Channel[] = [
    {
      id: chan1Id,
      kind: "telegram",
      name: "Telegram Cá nhân (@dealsonar_user_bot)",
      config: {
        chat_id: "581920311",
        bot_username: "dealsonar_user_bot",
        chat_type: "private",
      },
      state: "ok",
      last_error: null,
      created_at: now - 7 * 86_400_000,
    },
  ];

  const probes: Record<AiProviderId, ProbeResult> = {
    claude_cli: {
      provider: "claude_cli",
      binary_name: "claude",
      installed: true,
      version: "2.1.319",
      authenticated: true,
      flags_supported: true,
      latency_ms: 840,
      error: null,
      install_hint: "npm install -g @anthropic-ai/claude-code",
      login_command: "claude login",
      available_models: [
        {
          id: "haiku",
          label: "haiku — Bí danh tự động (claude-haiku-5-5)",
          recommended_tier: "fast",
          source: "local_cli",
        },
        {
          id: "sonnet",
          label: "sonnet — Bí danh tự động (claude-sonnet-5-5)",
          recommended_tier: "smart",
          source: "local_cli",
        },
        {
          id: "opus",
          label: "opus — Bí danh tự động (claude-opus-5-5)",
          recommended_tier: "smart",
          source: "local_cli",
        },
        {
          id: "claude-haiku-4-5",
          label: "Claude Haiku 4.5 (claude-haiku-4-5)",
          recommended_tier: "fast",
          source: "local_cli",
        },
        {
          id: "claude-sonnet-4-5",
          label: "Claude Sonnet 4.5 (claude-sonnet-4-5)",
          recommended_tier: "smart",
          source: "local_cli",
        },
      ],
      recommended_fast_model: "haiku",
      recommended_smart_model: "sonnet",
    },
    codex_cli: {
      provider: "codex_cli",
      binary_name: "codex",
      installed: true,
      version: "0.150.1",
      authenticated: false,
      flags_supported: true,
      latency_ms: null,
      error: "Chưa đăng nhập tài khoản OpenAI trên Codex CLI",
      install_hint: "npm install -g @openai/codex",
      login_command: "codex login",
      available_models: [
        {
          id: "gpt-6-luna",
          label: "GPT-6-Luna (gpt-6-luna) — Fast and affordable model",
          recommended_tier: "fast",
          source: "local_cli",
        },
        {
          id: "gpt-6.1-sol",
          label: "GPT-6.1-Sol (gpt-6.1-sol) — Latest workhorse model",
          recommended_tier: "smart",
          source: "local_cli",
        },
        {
          id: "codex-mini-latest",
          label: "Codex Mini Latest (codex-mini-latest)",
          recommended_tier: "fast",
          source: "builtin",
        },
        {
          id: "gpt-5-codex",
          label: "GPT-5 Codex (gpt-5-codex)",
          recommended_tier: "smart",
          source: "builtin",
        },
      ],
      recommended_fast_model: "gpt-6-luna",
      recommended_smart_model: "gpt-6.1-sol",
    },
    agy_cli: {
      provider: "agy_cli",
      binary_name: "agy",
      installed: false,
      version: null,
      authenticated: false,
      flags_supported: false,
      latency_ms: null,
      error: "Không tìm thấy tệp chạy `agy` trong PATH",
      install_hint: "Cài đặt Google Antigravity CLI (agy >= 1.5.4)",
      login_command: "agy auth login",
      available_models: [
        {
          id: "gemini-3.8-flash-medium",
          label: "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)",
          recommended_tier: "fast",
          source: "builtin",
        },
        {
          id: "gemini-4-carbon-medium",
          label: "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)",
          recommended_tier: "smart",
          source: "builtin",
        },
        {
          id: "gemini-2.5-flash",
          label: "Gemini 2.5 Flash (gemini-2.5-flash)",
          recommended_tier: "fast",
          source: "builtin",
        },
        {
          id: "gemini-2.5-pro",
          label: "Gemini 2.5 Pro (gemini-2.5-pro)",
          recommended_tier: "smart",
          source: "builtin",
        },
      ],
      recommended_fast_model: "gemini-3.8-flash-medium",
      recommended_smart_model: "gemini-4-carbon-medium",
    },
  };

  return {
    settings: {
      privacy_consent_accepted: true,
      onboarding_completed: true,
      launch_at_login: true,
      ai_provider: "claude_cli",
      model_tiers: {
        claude_cli: { fast: "claude-haiku-4-5", smart: "claude-sonnet-4-5" },
        codex_cli: { fast: "gpt-5-mini", smart: "gpt-5" },
        agy_cli: { fast: "gemini-2.5-flash", smart: "gemini-2.5-pro" },
      },
      daily_ai_post_cap: 2000,
      default_notify_mode: "instant",
      digest_interval_minutes: 30,
      quiet_hours_enabled: false,
      quiet_hours: { from: "22:30", to: "06:30" },
      os_notifications_enabled: true,
      crawl_policy: {
        group_interval_minutes: 15,
        priority_interval_minutes: 5,
        hourly_page_load_budget: 60,
        daily_page_load_budget: 600,
        active_hours: { from: "07:00", to: "23:00" },
        max_scroll_steps: 3,
        max_posts_per_visit: 30,
        only_when_idle: false,
      },
      unmatched_retention_days: 30,
      debug_keep_ai_io: false,
    },
    license: {
      plan: "personal",
      licensee: null,
      issued_at: null,
      expires_at: null,
      is_valid: true,
      key_preview: null,
      limits: buildPlanLimits("personal"),
    },
    health: {
      automatic_scanning: true, next_crawl_at: now + 300000, last_crawl_at: now - 60000, runtime_checked_at: now,
      extension_connected: true,
      extension_version: "0.1.0",
      facebook_session: "ok",
      crawl_paused: false,
      crawl_pause_reason: null,
      page_loads_last_hour: 12,
      page_loads_today: 118,
      ai_state: "ok",
      ai_provider: "claude_cli",
      ai_error: null,
      ai_rate_limit_reset_at: null,
      pending_ai_posts: 0,
      telegram_state: "ok",
      telegram_channel_count: 1,
      outbox_pending: 0,
      outbox_failed: 0,
      flood_radars: [],
      checked_at: now,
    },
    probes,
    channels,
    sources,
    radars,
    radarVersions,
    pendingVersions: {},
    rulesets,
    posts,
    leads,
    leadEvents: {
      [lead1Id]: [
        {
          id: "ev-1",
          lead_id: lead1Id,
          kind: "created",
          data: { decided_by: "rule", radar_version: 1 },
          created_at: now - 6 * 60_000,
        },
        {
          id: "ev-2",
          lead_id: lead1Id,
          kind: "notified",
          data: { channel: "Telegram Cá nhân" },
          created_at: now - 5 * 60_000,
        },
      ],
      [lead2Id]: [
        {
          id: "ev-3",
          lead_id: lead2Id,
          kind: "created",
          data: { decided_by: "ai", radar_version: 1 },
          created_at: now - 31 * 60_000,
        },
      ],
    },
    rejectedEvaluations,
    contacts,
    blocklist,
    crawlRuns,
    previews: {},
    previewFeedback: {},
    calls: [],
  };
}
