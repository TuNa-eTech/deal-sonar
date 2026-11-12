import tplBdsKhachThue from "../../../templates/bds.khach-thue.json";
import tplBdsChinhChu from "../../../templates/bds.chinh-chu.json";
import tplDichVuTimTho from "../../../templates/dich-vu.tim-tho.json";
import tplXeCuDuoiGia from "../../../templates/xe-cu.duoi-gia.json";
import tplTuyenDungTimViec from "../../../templates/tuyen-dung.tim-viec.json";
import tplVanTaiGhepHang from "../../../templates/van-tai.ghep-hang.json";
import tplOrderHoiMua from "../../../templates/order.hoi-mua.json";

import type {
  AiProviderId,
  AiUsageStats,
  BlocklistEntry,
  BlocklistKind,
  Channel,
  ChromeConnectResult,
  Contact,
  ContactDetail,
  CrawlRun,
  CreateRadarDraftInput,
  DynamicFieldFilter,
  ExtractedField,
  FieldDef,
  FunnelStats,
  HealthStatus,
  Lead,
  LeadDetail,
  LeadEvent,
  LeadExportInput,
  LeadExportResult,
  LeadFeedbackInput,
  LeadFeedbackResult,
  LeadFilterQuery,
  LeadListResponse,
  LeadStatus,
  LicenseStatus,
  PlanTier,
  Post,
  PreviewItem,
  PreviewRunState,
  PreviewStartInput,
  PreviewWarning,
  ProbeResult,
  Radar,
  RadarDetail,
  RadarStatus,
  RadarTemplate,
  RadarUpdateResult,
  RadarVersion,
  RejectedEvaluation,
  Ruleset,
  RulesetBody,
  Settings,
  Source,
  SuggestFieldsInput,
  SuggestFieldsResult,
  TauriEventMap,
  TelegramSetupStatus,
  UpdateRadarInput,
} from "../types/ipc";
import { escapeCsvCell } from "./security";
import { formatExtractedFieldValue, removeVietnameseDiacritics } from "./format";

const TEMPLATES: RadarTemplate[] = [
  tplBdsKhachThue as RadarTemplate,
  tplBdsChinhChu as RadarTemplate,
  tplDichVuTimTho as RadarTemplate,
  tplXeCuDuoiGia as RadarTemplate,
  tplTuyenDungTimViec as RadarTemplate,
  tplVanTaiGhepHang as RadarTemplate,
  tplOrderHoiMua as RadarTemplate,
];

let ulidSeq = 1000;
function nextId(prefix = "01JCF"): string {
  ulidSeq += 1;
  return `${prefix}${String(ulidSeq).padStart(21, "0")}`.slice(0, 26);
}

type EventListenerFn<K extends keyof TauriEventMap> = (payload: TauriEventMap[K]) => void;

const listeners = new Map<keyof TauriEventMap, Set<(payload: unknown) => void>>();

export function subscribeMockEvent<K extends keyof TauriEventMap>(
  event: K,
  cb: EventListenerFn<K>
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const wrapped = (payload: unknown) => cb(payload as TauriEventMap[K]);
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}

export function emitMockEvent<K extends keyof TauriEventMap>(
  event: K,
  payload: TauriEventMap[K]
): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    fn(payload);
  }
}

export interface MockCommandCall {
  cmd: string;
  args: Record<string, unknown>;
  ts: number;
}

interface MockState {
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

function buildPlanLimits(plan: PlanTier): LicenseStatus["limits"] {
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

function createInitialState(): MockState {
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

let state: MockState = createInitialState();

export function resetMockBackend(overrides?: {
  onboarding?: boolean;
  emptyRadars?: boolean;
  emptyLeads?: boolean;
  plan?: PlanTier;
}): void {
  state = createInitialState();
  if (overrides?.onboarding) {
    state.settings.privacy_consent_accepted = false;
    state.settings.onboarding_completed = false;
  }
  if (overrides?.emptyRadars) {
    state.radars = [];
    state.radarVersions = [];
    state.leads = [];
  }
  if (overrides?.emptyLeads) {
    state.leads = [];
  }
  if (overrides?.plan) {
    state.license.plan = overrides.plan;
    state.license.limits = buildPlanLimits(overrides.plan);
  }
}

export function setMockHealth(patch: Partial<HealthStatus>): HealthStatus {
  state.health = { ...state.health, ...patch, checked_at: Date.now() };
  emitMockEvent("health:changed", structuredClone(state.health));
  return structuredClone(state.health);
}

export function injectMockLead(lead: Lead, postText: string): void {
  const post: Post = {
    id: lead.post_id,
    platform: "facebook",
    external_id: lead.post_id,
    source_id: lead.source_id,
    source_name: lead.source_name,
    author_id: lead.author_id,
    author_name: lead.author_name,
    permalink: lead.permalink,
    text: postText,
    text_truncated: false,
    lang: "vi",
    created_at: lead.post_created_at,
    captured_at: lead.created_at,
    strategy: "network",
    purged_at: null,
  };
  state.posts.unshift(post);
  state.leads.unshift(lead);
  state.leadEvents[lead.id] = [
    {
      id: nextId("01JCFE"),
      lead_id: lead.id,
      kind: "created",
      data: { decided_by: lead.decided_by, radar_version: lead.radar_version },
      created_at: lead.created_at,
    },
  ];
  emitMockEvent("lead:new", structuredClone(lead));
}

export function getMockCommandCalls(): MockCommandCall[] {
  return structuredClone(state.calls);
}

function getNumericComparable(extracted: ExtractedField | undefined, mode: "min" | "max" | "scalar"): number | null {
  if (!extracted || extracted.value === null || extracted.value === undefined) return null;
  const v = extracted.value;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (mode === "min" && typeof obj.min === "number") return obj.min;
    if (mode === "max" && typeof obj.max === "number") return obj.max;
    if (typeof obj.max === "number") return obj.max;
    if (typeof obj.min === "number") return obj.min;
  }
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringComparableValues(extracted: ExtractedField | undefined): string[] {
  if (!extracted || extracted.value === null || extracted.value === undefined) return [];
  const v = extracted.value;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return [obj.district, obj.province, obj.ward, obj.raw]
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return [String(v)];
}

function matchesDynamicFilter(lead: Lead, filter: DynamicFieldFilter): boolean {
  const extracted = lead.fields[filter.field];
  const isEmpty = !extracted || extracted.value === null || extracted.value === undefined || extracted.value === "";

  if (filter.op === "is_empty") {
    return filter.value === false ? !isEmpty : isEmpty;
  }
  if (isEmpty) return false;

  const strCandidates = getStringComparableValues(extracted).map((s) =>
    removeVietnameseDiacritics(s).toLowerCase()
  );
  const rawVal = extracted.value;

  switch (filter.op) {
    case "eq": {
      if (typeof rawVal === "boolean") {
        return rawVal === Boolean(filter.value);
      }
      if (typeof filter.value === "number") {
        const n = getNumericComparable(extracted, "scalar");
        return n === filter.value;
      }
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return strCandidates.some((c) => c === target || c.includes(target));
    }
    case "ne": {
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return !strCandidates.some((c) => c === target);
    }
    case "contains": {
      const target = removeVietnameseDiacritics(String(filter.value ?? "")).toLowerCase();
      return strCandidates.some((c) => c.includes(target));
    }
    case "in": {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      const normalizedList = list.map((item) =>
        removeVietnameseDiacritics(String(item ?? "")).toLowerCase()
      );
      return strCandidates.some((c) => normalizedList.some((t) => c === t || c.includes(t)));
    }
    case "lte": {
      const limit = Number(filter.value);
      const minNum = getNumericComparable(extracted, "min");
      return minNum !== null && minNum <= limit;
    }
    case "lt": {
      const limit = Number(filter.value);
      const minNum = getNumericComparable(extracted, "min");
      return minNum !== null && minNum < limit;
    }
    case "gte": {
      const limit = Number(filter.value);
      const maxNum = getNumericComparable(extracted, "max");
      return maxNum !== null && maxNum >= limit;
    }
    case "gt": {
      const limit = Number(filter.value);
      const maxNum = getNumericComparable(extracted, "max");
      return maxNum !== null && maxNum > limit;
    }
    case "between": {
      if (!Array.isArray(filter.value) || filter.value.length < 2) return true;
      const low = Number(filter.value[0]);
      const high = Number(filter.value[1]);
      const minNum = getNumericComparable(extracted, "min");
      const maxNum = getNumericComparable(extracted, "max");
      if (minNum === null || maxNum === null) return false;
      return maxNum >= low && minNum <= high;
    }
    default:
      return true;
  }
}

function buildPreviewWarnings(fields: FieldDef[], items: PreviewItem[]): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];
  if (items.length === 0) return warnings;

  const matched = items.filter((it) => it.verdict === "match");
  if (matched.length === 0) {
    warnings.push({
      code: "zero_matches",
      message:
        "Không có bài nào khớp trong tập xem thử. Gợi ý: nới rộng câu mô tả hoặc chọn thêm group nguồn phù hợp hơn.",
    });
    return warnings;
  }

  if (matched.length / items.length > 0.6) {
    warnings.push({
      code: "too_broad",
      message:
        "Trên 60% số bài đều được chấm khớp — mô tả đang quá rộng, sẽ gây dồn dập thông báo Telegram. Hãy thêm khu vực hoặc tầm giá cụ thể hơn.",
    });
  }

  for (const field of fields) {
    if (!field.required) continue;
    const missingCount = matched.filter((it) => {
      const ef = it.fields[field.key];
      return !ef || ef.value === null || ef.value === undefined || ef.value === "";
    }).length;
    if (missingCount / matched.length > 0.7) {
      warnings.push({
        code: "missing_required_field",
        field_key: field.key,
        field_label: field.label,
        message: `Trường bắt buộc «${field.label}» trống ở trên 70% bài khớp (${missingCount}/${matched.length} bài). Gợi ý: bỏ đánh dấu Bắt buộc để tránh hạ điểm oan.`,
      });
    }
  }

  return warnings;
}

function generatePreviewItemsForRadar(
  radarId: string,
  description: string,
  fields: FieldDef[]
): PreviewItem[] {
  const now = Date.now();
  const feedbackMap = state.previewFeedback[radarId] ?? {};
  const descFold = removeVietnameseDiacritics(description).toLowerCase();
  const isImpossible = descFold.includes(" sao hoa") || descFold.includes("khong khop gi");

  const samplePosts = [
    {
      id: "prev-post-1",
      verdict: isImpossible ? ("no_match" as const) : ("match" as const),
      score: isImpossible ? 0.12 : 0.94,
      intent: "demand" as const,
      author_role: "end_user" as const,
      summary: "Gia đình cần tìm căn hộ 2 phòng ngủ Cầu Giấy, ngân sách 12–14 triệu/tháng",
      reason: isImpossible
        ? "Không khớp điều kiện đặc thù trong mô tả."
        : "Khách trực tiếp tìm thuê đúng khu vực và ngân sách nêu trong mô tả.",
      decided_by: "rule" as const,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_name: "Nguyễn Minh Tuấn",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432101/",
      post_text:
        "Vợ chồng mình cần thuê căn hộ 2 phòng ngủ khu Dịch Vọng Hậu, Cầu Giấy diện tích 70m2, ngân sách tầm 12-14tr/th. LH chính chủ báo em số 0912.345.678.",
      rawByType: {
        money: {
          value: { min: 12_000_000, max: 14_000_000, currency: "VND", period: "month" },
          raw: "tầm 12-14tr/th",
        },
        location: {
          value: { raw: "Dịch Vọng Hậu, Cầu Giấy", province: "Hà Nội", district: "Cầu Giấy", ward: "Dịch Vọng Hậu" },
          raw: "Dịch Vọng Hậu, Cầu Giấy",
        },
        phone: { value: "+84912345678", raw: "0912.345.678" },
        range: { value: { min: 70, max: 70, unit: "m2" }, raw: "70m2" },
        number: { value: 2, raw: "2 phòng ngủ" },
        enum: { value: "thuê", raw: "cần thuê" },
        text: { value: "căn hộ 2 phòng ngủ", raw: "căn hộ 2 phòng ngủ" },
      },
    },
    {
      id: "prev-post-2",
      verdict: isImpossible ? ("no_match" as const) : ("match" as const),
      score: isImpossible ? 0.18 : 0.85,
      intent: "demand" as const,
      author_role: "end_user" as const,
      summary: "Tìm thuê chung cư 2PN khu Mỹ Đình – Cầu Giấy vào ở ngay, dưới 13 triệu",
      reason: isImpossible
        ? "Không khớp mô tả."
        : "Khách cá nhân nêu rõ nhu cầu, thời điểm dọn vào và khu vực lân cận.",
      decided_by: "ai" as const,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_name: "Trần Thu Hà",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432102/",
      post_text:
        "Em cần tìm thuê chung cư 2PN quanh khu Mỹ Đình hoặc Cầu Giấy tài chính dưới 13 triệu/tháng, dọn vào tuần tới. Bác nào có nhà nhắn em 0987 654 321.",
      rawByType: {
        money: {
          value: { min: 13_000_000, max: 13_000_000, currency: "VND", period: "month" },
          raw: "dưới 13 triệu/tháng",
        },
        location: {
          value: { raw: "Mỹ Đình hoặc Cầu Giấy", province: "Hà Nội", district: "Cầu Giấy", ward: null },
          raw: "Mỹ Đình hoặc Cầu Giấy",
        },
        phone: { value: "+84987654321", raw: "0987 654 321" },
        number: { value: 2, raw: "2PN" },
        enum: { value: "thuê", raw: "tìm thuê" },
        text: { value: "chung cư 2PN", raw: "chung cư 2PN" },
      },
    },
    {
      id: "prev-post-3",
      verdict: "no_match" as const,
      score: 0.11,
      intent: "supply" as const,
      author_role: "peer" as const,
      summary: "Môi giới đăng quỹ căn Vinhomes Skylake 2PN–3PN kết hợp hoa hồng",
      reason: "Loại do tác giả là người cùng nghề (môi giới chào quỹ căn, nhắc tới hoa hồng).",
      decided_by: "rule" as const,
      source_name: "Hội Thuê Nhà & Chung Cư Cầu Giấy - Mỹ Đình",
      author_name: "Sàn BĐS Thành Đạt",
      permalink: "https://www.facebook.com/groups/thuenhacaugiay/posts/98765432104/",
      post_text:
        "Bên em sẵn quỹ căn 2PN - 3PN Vinhomes Skylake giá từ 16tr/th, hoa hồng cao cho anh em kết hợp. IB em gửi ảnh!",
      rawByType: {},
    },
    {
      id: "prev-post-4",
      verdict: "no_match" as const,
      score: 0.28,
      intent: "supply" as const,
      author_role: "end_user" as const,
      summary: "Chính chủ cho thuê mặt bằng kinh doanh tầng 1 phố Trần Thái Tông 35 triệu",
      reason: "Bài cho thuê mặt bằng vượt ngân sách và ngược ý định cần tìm khách.",
      decided_by: "ai" as const,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_name: "Đỗ Văn Hùng",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432188/",
      post_text:
        "Chính chủ cho thuê mặt bằng tầng 1 phố Trần Thái Tông 80m2 giá 35tr/tháng phù hợp mở cafe, văn phòng.",
      rawByType: {},
    },
    {
      id: "prev-post-5",
      verdict: "no_match" as const,
      score: 0.19,
      intent: "demand" as const,
      author_role: "end_user" as const,
      summary: "Khách tìm thuê nhà nguyên căn tại Quận 7, TP.HCM",
      reason: "Khác địa bàn mục tiêu (Quận 7, TP.HCM).",
      decided_by: "rule" as const,
      source_name: "Nhà Đất Chính Chủ Hà Nội (Không Trung Gian)",
      author_name: "Võ Thanh Bình",
      permalink: "https://www.facebook.com/groups/chinhchuhanoi247/posts/98765432199/",
      post_text: "Mình cần tìm nhà nguyên căn khu Tân Phong Quận 7 giá 18 triệu/tháng cho gia đình ở.",
      rawByType: {},
    },
  ];

  return samplePosts.map((sp, idx) => {
    const evalId = `prev-eval-${radarId}-${idx + 1}`;
    const extractedFields: Record<string, ExtractedField> = {};
    if (sp.verdict === "match") {
      for (const f of fields) {
        const hit = (sp.rawByType as Record<string, { value: unknown; raw: string } | undefined>)[
          f.type
        ];
        if (hit) {
          extractedFields[f.key] = {
            value: f.type === "enum" && f.options?.length ? f.options[0] : hit.value,
            raw: hit.raw,
            confidence: 0.92,
            source: sp.decided_by === "rule" ? "rule" : "ai",
          };
        }
      }
    }
    const savedLabel = feedbackMap[evalId] ?? null;
    const adjustedVerdict =
      savedLabel === "irrelevant" || savedLabel === "peer" || savedLabel === "spam"
        ? "no_match"
        : savedLabel === "missed"
          ? "match"
          : sp.verdict;
    const adjustedScore =
      savedLabel === "irrelevant" || savedLabel === "peer" || savedLabel === "spam"
        ? 0.15
        : savedLabel === "missed"
          ? 0.88
          : sp.score;

    return {
      evaluation_id: evalId,
      post_id: sp.id,
      verdict: adjustedVerdict,
      score: adjustedScore,
      intent: sp.intent,
      author_role: sp.author_role,
      summary: sp.summary,
      reason: savedLabel
        ? `Đã áp dụng ví dụ phản hồi (${savedLabel}) của bạn. ${sp.reason}`
        : sp.reason,
      decided_by: sp.decided_by,
      fields: extractedFields,
      source_name: sp.source_name,
      author_name: sp.author_name,
      permalink: sp.permalink,
      post_text: sp.post_text,
      post_created_at: now - (idx + 1) * 14 * 60_000,
      feedback_label: savedLabel,
    };
  });
}

function getRadarDetail(id: string): RadarDetail {
  const radar = state.radars.find((r) => r.id === id);
  if (!radar) {
    throw new Error(`Không tìm thấy radar: ${id}`);
  }
  const versions = state.radarVersions
    .filter((v) => v.radar_id === id)
    .sort((a, b) => b.version - a.version);
  const current = versions.find((v) => v.version === radar.current_version) ?? versions[0];
  if (!current) {
    throw new Error(`Không tìm thấy phiên bản của radar: ${id}`);
  }
  return structuredClone({
    radar,
    current_version_data: current,
    pending_version_data: state.pendingVersions[id] ?? null,
    versions,
  });
}

export async function invokeMockCommand<T>(
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  state.calls.push({ cmd, args: structuredClone(args), ts: Date.now() });

  switch (cmd) {
    // --- Templates ---
    case "template_list":
      return structuredClone(TEMPLATES) as T;

    case "template_get": {
      const id = String(args.id ?? "");
      const tpl = TEMPLATES.find((t) => t.id === id);
      if (!tpl) throw new Error(`Không tìm thấy mẫu radar: ${id}`);
      return structuredClone(tpl) as T;
    }

    // --- Radars ---
    case "radar_list":
      return structuredClone(state.radars.filter((r) => r.status !== "archived")) as T;

    case "radar_get":
      return getRadarDetail(String(args.id ?? "")) as T;

    case "radar_create_draft": {
      const input = args.input as CreateRadarDraftInput;
      if (input.fields.length > state.license.limits.max_fields_per_radar) {
        throw new Error(
          `Gói hiện tại giới hạn tối đa ${state.license.limits.max_fields_per_radar} trường mỗi radar.`
        );
      }
      const now = Date.now();
      const radarId = nextId("01JCF3");
      const versionId = nextId("01JCF4");
      const defaultChannels = state.channels.filter((c) => c.state === "ok").map((c) => c.id);

      const radar: Radar = {
        id: radarId,
        name: input.name.trim() || "Radar mới",
        status: "draft",
        template_id: input.template_id ?? null,
        current_version: 1,
        source_ids: [...input.source_ids],
        notify: {
          channel_ids: input.notify?.channel_ids ?? defaultChannels,
          mode: input.notify?.mode ?? state.settings.default_notify_mode,
          min_score: input.notify?.min_score ?? 0.6,
          quiet_hours:
            input.notify?.quiet_hours ??
            (state.settings.quiet_hours_enabled ? state.settings.quiet_hours : null),
        },
        created_at: now,
        updated_at: now,
        leads_24h: 0,
        false_positive_rate: 0,
        evaluated_posts_total: 0,
        rule_handled_pct: input.template_id?.startsWith("bds.") ? 80 : 0,
      };

      const rv: RadarVersion = {
        id: versionId,
        radar_id: radarId,
        version: 1,
        description: input.description,
        language_hint: input.language_hint ?? "vi",
        user_profession: input.user_profession ?? null,
        fields: input.fields.map((f, idx) => ({ ...f, order: idx + 1 })),
        match_policy: input.match_policy,
        created_at: now,
      };

      state.radars.unshift(radar);
      state.radarVersions.push(rv);

      // Follow selected sources up to plan limit
      for (const sid of input.source_ids) {
        const s = state.sources.find((x) => x.id === sid);
        if (s) s.followed = true;
      }

      if (input.template_id?.startsWith("bds.")) {
        state.rulesets.push({
          id: nextId("01JCF5"),
          radar_version_id: versionId,
          revision: 1,
          state: "active",
          origin: "seed",
          body: structuredClone(state.rulesets[0]?.body ?? {
            dsl: 1,
            prefilter: { any: ["can thue", "can mua"], none: ["tuyen sale"], min_len: 20 },
            classify: [],
            extract: [],
            thresholds: { accept: 0.9, reject: 0.9 },
          }),
          metrics: {
            rule_handled_pct: 80,
            ai_handled_pct: 20,
            accept_precision: 0.95,
            false_negative_rate: 0.02,
            sample_size: 50,
          },
          created_at: now,
          activated_at: now,
        });
      }

      return getRadarDetail(radarId) as T;
    }

    case "radar_update": {
      const input = args.input as UpdateRadarInput;
      const radar = state.radars.find((r) => r.id === input.id);
      if (!radar) throw new Error(`Không tìm thấy radar: ${input.id}`);
      const detail = getRadarDetail(input.id);
      const cur = detail.current_version_data;
      const now = Date.now();

      if (input.name !== undefined) radar.name = input.name;
      if (input.source_ids !== undefined) radar.source_ids = [...input.source_ids];
      if (input.notify !== undefined) {
        radar.notify = { ...radar.notify, ...input.notify };
      }
      radar.updated_at = now;

      const definitionChanged =
        (input.description !== undefined && input.description !== cur.description) ||
        (input.user_profession !== undefined && input.user_profession !== cur.user_profession) ||
        (input.fields !== undefined && JSON.stringify(input.fields) !== JSON.stringify(cur.fields)) ||
        (input.match_policy !== undefined &&
          JSON.stringify(input.match_policy) !== JSON.stringify(cur.match_policy));

      if (!definitionChanged) {
        return {
          detail: getRadarDetail(radar.id),
          created_new_version: false,
          requires_confirmation: false,
        } as T;
      }

      const nextVerNum = cur.version + 1;
      const newVersion: RadarVersion = {
        id: nextId("01JCF4"),
        radar_id: radar.id,
        version: nextVerNum,
        description: input.description ?? cur.description,
        language_hint: cur.language_hint,
        user_profession:
          input.user_profession !== undefined ? input.user_profession : cur.user_profession,
        fields: (input.fields ?? cur.fields).map((f, i) => ({ ...f, order: i + 1 })),
        match_policy: input.match_policy ?? cur.match_policy,
        created_at: now,
      };

      // Per 02-radar-spec.md §4: if radar is active and user hasn't confirmed version upgrade yet,
      // keep running old version while staging pending version for preview!
      if (radar.status === "active" && !input.confirm_version_upgrade) {
        state.pendingVersions[radar.id] = newVersion;
        return {
          detail: getRadarDetail(radar.id),
          created_new_version: true,
          requires_confirmation: true,
        } as T;
      }

      delete state.pendingVersions[radar.id];
      state.radarVersions.push(newVersion);
      radar.current_version = nextVerNum;
      return {
        detail: getRadarDetail(radar.id),
        created_new_version: true,
        requires_confirmation: false,
      } as T;
    }

    case "radar_suggest_fields": {
      const input = args.input as SuggestFieldsInput;
      if (input.template_id) {
        const tpl = TEMPLATES.find((t) => t.id === input.template_id);
        if (tpl) {
          return structuredClone({
            suggested_name: tpl.name,
            want_intent: tpl.match_policy.want_intent,
            fields: tpl.fields,
            hard_filters: tpl.match_policy.hard_filters,
            clarifying_questions: [],
            prefilter_hint: null,
          } satisfies SuggestFieldsResult) as T;
        }
      }

      const folded = removeVietnameseDiacritics(input.description).toLowerCase();
      const isBds =
        folded.includes("can ho") ||
        folded.includes("chung cu") ||
        folded.includes("thue nha") ||
        folded.includes("phong ngu");

      const fields: FieldDef[] = isBds
        ? [
            {
              key: "deal_type",
              label: "Nhu cầu",
              type: "enum",
              description: "Khách cần thuê hay mua",
              required: true,
              options: ["thuê", "mua"],
              show_in_alert: true,
              order: 1,
            },
            {
              key: "location",
              label: "Khu vực",
              type: "location",
              description: "Quận, phường hoặc khu vực khách tìm",
              required: true,
              options: null,
              show_in_alert: true,
              order: 2,
            },
            {
              key: "price",
              label: "Ngân sách / Giá",
              type: "money",
              description: "Tầm giá nêu trong bài",
              required: false,
              options: null,
              show_in_alert: true,
              order: 3,
            },
            {
              key: "bedrooms",
              label: "Số phòng ngủ",
              type: "number",
              description: "Số phòng ngủ mong muốn",
              required: false,
              options: null,
              show_in_alert: true,
              order: 4,
            },
            {
              key: "phone",
              label: "Số điện thoại",
              type: "phone",
              description: "Số điện thoại liên hệ trong bài",
              required: false,
              options: null,
              show_in_alert: true,
              order: 5,
            },
          ]
        : [
            {
              key: "need_summary",
              label: "Nhu cầu chính",
              type: "text",
              description: "Hạng mục hoặc sản phẩm cụ thể trong bài",
              required: true,
              options: null,
              show_in_alert: true,
              order: 1,
            },
            {
              key: "location",
              label: "Khu vực",
              type: "location",
              description: "Địa điểm nêu trong bài",
              required: false,
              options: null,
              show_in_alert: true,
              order: 2,
            },
            {
              key: "budget",
              label: "Ngân sách / Giá",
              type: "money",
              description: "Mức giá đề cập trong bài",
              required: false,
              options: null,
              show_in_alert: true,
              order: 3,
            },
            {
              key: "phone",
              label: "Số điện thoại",
              type: "phone",
              description: "Số điện thoại liên hệ",
              required: false,
              options: null,
              show_in_alert: true,
              order: 4,
            },
          ];

      const clarifying: string[] = [];
      if (input.description.trim().length < 35) {
        clarifying.push("Bạn muốn giới hạn ở khu vực/quận nào cụ thể không?");
        clarifying.push("Có ngưỡng ngân sách tối đa hay tối thiểu nào cần lọc cứng không?");
      }

      const result: SuggestFieldsResult = {
        suggested_name: input.description.trim().slice(0, 48) || "Radar tuỳ chỉnh",
        want_intent: folded.includes("can ban") || folded.includes("cho thue") ? "supply" : "demand",
        fields,
        hard_filters: [],
        clarifying_questions: clarifying,
        prefilter_hint: {
          any: ["can", "tim"],
          none: ["tuyen cong tac vien"],
        },
      };
      return result as T;
    }

    case "radar_set_status": {
      const id = String(args.id ?? "");
      const status = args.status as RadarStatus;
      const radar = state.radars.find((r) => r.id === id);
      if (!radar) throw new Error(`Không tìm thấy radar: ${id}`);

      if (status === "active" && radar.status !== "active") {
        const maxActive = state.license.limits.max_active_radars;
        const activeCount = state.radars.filter((r) => r.status === "active").length;
        if (maxActive !== null && activeCount >= maxActive) {
          throw new Error(
            `Gói Cá nhân giới hạn tối đa ${maxActive} radar đang chạy cùng lúc. Hãy tạm dừng một radar khác hoặc nâng cấp gói Chuyên nghiệp.`
          );
        }
      }

      radar.status = status;
      radar.updated_at = Date.now();
      return structuredClone(radar) as T;
    }

    case "radar_preview_start": {
      const input = args.input as PreviewStartInput;
      const detail = getRadarDetail(input.radar_id);
      const effectiveFields =
        input.fields ??
        detail.pending_version_data?.fields ??
        detail.current_version_data.fields;
      const effectiveDesc =
        input.description ??
        detail.pending_version_data?.description ??
        detail.current_version_data.description;

      const allItems = generatePreviewItemsForRadar(
        input.radar_id,
        effectiveDesc,
        effectiveFields
      );
      const previewId = nextId("01JCFD");
      const firstBatch = allItems.slice(0, 2);
      const secondBatch = allItems.slice(2);

      const initialState: PreviewRunState = {
        preview_id: previewId,
        radar_id: input.radar_id,
        radar_version:
          detail.pending_version_data?.version ?? detail.current_version_data.version,
        status: secondBatch.length > 0 ? "evaluating" : "done",
        total_posts: allItems.length,
        evaluated_posts: firstBatch.length,
        items: firstBatch,
        warnings: secondBatch.length === 0 ? buildPreviewWarnings(effectiveFields, allItems) : [],
        error: null,
      };
      state.previews[input.radar_id] = initialState;

      if (secondBatch.length > 0) {
        setTimeout(() => {
          const warnings = buildPreviewWarnings(effectiveFields, allItems);
          const completed: PreviewRunState = {
            ...initialState,
            status: "done",
            evaluated_posts: allItems.length,
            items: allItems,
            warnings,
          };
          state.previews[input.radar_id] = completed;
          emitMockEvent("preview:progress", {
            preview_id: previewId,
            radar_id: input.radar_id,
            status: "done",
            evaluated_posts: allItems.length,
            total_posts: allItems.length,
            new_items: secondBatch,
            warnings,
          });
        }, 15);
      }

      return structuredClone(initialState) as T;
    }

    case "radar_preview_get": {
      const radarId = String(args.radar_id ?? "");
      const existing = state.previews[radarId];
      if (!existing) {
        throw new Error("Chưa có phiên xem thử nào cho radar này.");
      }
      return structuredClone(existing) as T;
    }

    case "radar_stats": {
      const stats: FunnelStats = {
        days: Number(args.days ?? 7),
        posts_captured: 2450,
        dedup_dropped: 420,
        prefilter_dropped: 1380,
        rule_decided: 533,
        rule_matched: 42,
        ai_decided: 117,
        ai_matched: 26,
        leads_created: 58,
        leads_notified: 49,
        leads_weak: 9,
        false_positives: 4,
      };
      return stats as T;
    }

    // --- Sources ---
    case "source_list":
      return structuredClone(state.sources) as T;

    case "source_follow": {
      const id = String(args.id ?? "");
      const src = state.sources.find((s) => s.id === id);
      if (!src) throw new Error(`Không tìm thấy group: ${id}`);
      if (!src.followed) {
        const followedCount = state.sources.filter((s) => s.followed).length;
        if (followedCount >= state.license.limits.max_followed_groups) {
          throw new Error(
            `Đã chạm giới hạn ${state.license.limits.max_followed_groups} group theo dõi của gói hiện tại.`
          );
        }
        src.followed = true;
      }
      return structuredClone(src) as T;
    }

    case "source_unfollow": {
      const id = String(args.id ?? "");
      const src = state.sources.find((s) => s.id === id);
      if (!src) throw new Error(`Không tìm thấy group: ${id}`);
      src.followed = false;
      src.priority = false;
      return structuredClone(src) as T;
    }

    case "source_set_priority": {
      const id = String(args.id ?? "");
      const priority = Boolean(args.priority);
      const src = state.sources.find((s) => s.id === id);
      if (!src) throw new Error(`Không tìm thấy group: ${id}`);
      if (priority && !src.priority) {
        const prioCount = state.sources.filter((s) => s.priority).length;
        if (prioCount >= 3) {
          throw new Error("Tối đa 3 group được đặt chế độ ưu tiên (quét mỗi 5 phút).");
        }
      }
      src.priority = priority;
      return structuredClone(src) as T;
    }

    case "source_crawl_now": {
      const id = String(args.id ?? "");
      const src = state.sources.find((s) => s.id === id);
      if (!src) throw new Error(`Không tìm thấy group: ${id}`);
      const now = Date.now();
      const run: CrawlRun = {
        id: nextId("01JCFC"),
        source_id: src.id,
        source_name: src.name,
        reason: (args.reason as "manual" | "preview") ?? "manual",
        status: "ok",
        started_at: now - 1500,
        ended_at: now,
        posts_seen: 18,
        posts_new: 4,
        page_loads: 1,
        strategy: "network",
        error: null,
      };
      src.last_crawl_at = now;
      src.stored_post_count += 4;
      state.crawlRuns.unshift(run);
      emitMockEvent("crawl:finished", structuredClone(run));
      return { queued: true, run_id: run.id } as T;
    }

    // --- Leads ---
    case "lead_list": {
      const query = (args.query ?? args) as LeadFilterQuery;
      let items = [...state.leads];

      if (query.radar_id) {
        // Validate dynamic filter keys against radar fields (mirroring 04-data-model.md §3)
        const rv = state.radarVersions
          .filter((v) => v.radar_id === query.radar_id)
          .sort((a, b) => b.version - a.version)[0];
        if (rv && query.filters?.length) {
          const allowed = new Set(rv.fields.map((f) => f.key));
          for (const f of query.filters) {
            if (!/^[a-z][a-z0-9_]{0,30}$/.test(f.field) || !allowed.has(f.field)) {
              throw new Error(`Khoá trường lọc không hợp lệ: ${f.field}`);
            }
          }
        }
        items = items.filter((l) => l.radar_id === query.radar_id);
      }

      if (!query.include_weak) {
        items = items.filter((l) => !l.is_weak_match);
      }

      if (query.status && query.status.length > 0) {
        const set = new Set(query.status);
        items = items.filter((l) => set.has(l.status));
      }

      if (query.since) {
        items = items.filter((l) => l.created_at >= query.since!);
      }

      if (query.search && query.search.trim().length > 0) {
        const q = removeVietnameseDiacritics(query.search.trim()).toLowerCase();
        items = items.filter((l) => {
          const post = state.posts.find((p) => p.id === l.post_id);
          const haystack = removeVietnameseDiacritics(
            `${l.summary} ${l.note ?? ""} ${l.author_name} ${post?.text ?? ""}`
          ).toLowerCase();
          return haystack.includes(q);
        });
      }

      if (query.filters && query.filters.length > 0) {
        for (const f of query.filters) {
          items = items.filter((l) => matchesDynamicFilter(l, f));
        }
      }

      const sortBy = query.sort?.by ?? "created_at";
      const dir = query.sort?.dir === "asc" ? 1 : -1;
      items.sort((a, b) => {
        if (sortBy === "created_at") return (a.created_at - b.created_at) * dir;
        if (sortBy === "score") return (a.score - b.score) * dir;
        const na = getNumericComparable(a.fields[sortBy], "min");
        const nb = getNumericComparable(b.fields[sortBy], "min");
        if (na !== null && nb !== null) return (na - nb) * dir;
        const sa = getStringComparableValues(a.fields[sortBy])[0] ?? "";
        const sb = getStringComparableValues(b.fields[sortBy])[0] ?? "";
        return sa.localeCompare(sb, "vi") * dir;
      });

      const limit = query.limit ?? 50;
      const startOffset = query.cursor ? Number(query.cursor) || 0 : 0;
      const paged = items.slice(startOffset, startOffset + limit);
      const nextCursor =
        startOffset + limit < items.length ? String(startOffset + limit) : null;

      const resp: LeadListResponse = {
        items: structuredClone(paged),
        total: items.length,
        next_cursor: nextCursor,
      };
      return resp as T;
    }

    case "lead_get": {
      const id = String(args.id ?? "");
      const lead = state.leads.find((l) => l.id === id);
      if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
      const post =
        state.posts.find((p) => p.id === lead.post_id) ?? {
          id: lead.post_id,
          platform: "facebook",
          external_id: lead.post_id,
          source_id: lead.source_id,
          source_name: lead.source_name,
          author_id: lead.author_id,
          author_name: lead.author_name,
          permalink: lead.permalink,
          text: lead.summary,
          text_truncated: false,
          lang: "vi",
          created_at: lead.post_created_at,
          captured_at: lead.created_at,
          strategy: "network" as const,
          purged_at: null,
        };
      const rv = state.radarVersions.find((v) => v.id === lead.radar_version_id);
      const detail: LeadDetail = {
        lead: structuredClone(lead),
        post: structuredClone(post),
        radar_fields: structuredClone(rv?.fields ?? []),
        events: structuredClone(state.leadEvents[lead.id] ?? []),
      };
      return detail as T;
    }

    case "lead_set_status": {
      const id = String(args.id ?? "");
      const lead = state.leads.find((l) => l.id === id);
      if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
      const now = Date.now();
      if (args.status !== undefined) {
        lead.status = args.status as LeadStatus;
      }
      if (args.note !== undefined) {
        lead.note = (args.note as string | null) || null;
      }
      if (args.tags !== undefined) {
        lead.tags = (args.tags as string[] | null) ?? [];
      }
      if (args.follow_up_at !== undefined) {
        lead.follow_up_at = (args.follow_up_at as number | null) ?? null;
      }
      lead.updated_at = now;
      state.leadEvents[lead.id] = [
        ...(state.leadEvents[lead.id] ?? []),
        {
          id: nextId("01JCFE"),
          lead_id: lead.id,
          kind: args.note !== undefined ? "noted" : "status_changed",
          data: { status: lead.status, note: lead.note },
          created_at: now,
        },
      ];
      emitMockEvent("lead:updated", structuredClone(lead));
      return invokeMockCommand<T>("lead_get", { id });
    }

    case "lead_update_field": {
      const id = String(args.id ?? "");
      const fieldKey = String(args.field_key ?? "");
      const lead = state.leads.find((l) => l.id === id);
      if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
      const now = Date.now();
      const prev = lead.fields[fieldKey];
      lead.fields[fieldKey] = {
        value: args.value,
        raw: (args.raw as string | null | undefined) ?? prev?.raw ?? null,
        confidence: 1.0,
        source: "user",
      };
      lead.updated_at = now;
      state.leadEvents[lead.id] = [
        ...(state.leadEvents[lead.id] ?? []),
        {
          id: nextId("01JCFE"),
          lead_id: lead.id,
          kind: "field_edited",
          data: { field_key: fieldKey, value: args.value },
          created_at: now,
        },
      ];
      emitMockEvent("lead:updated", structuredClone(lead));
      return invokeMockCommand<T>("lead_get", { id });
    }

    case "lead_feedback": {
      const input = args.input as LeadFeedbackInput;
      const feedbackId = nextId("01JCFF");
      let updatedLead: Lead | null = null;
      let blockedEntry: BlocklistEntry | null = null;

      if (input.origin === "preview") {
        // Store in previewFeedback so re-running preview uses this feedback immediately!
        for (const [rId, prevState] of Object.entries(state.previews)) {
          const item = prevState.items.find((it) => it.evaluation_id === input.evaluation_id);
          if (item) {
            item.feedback_label = input.label;
            state.previewFeedback[rId] = {
              ...(state.previewFeedback[rId] ?? {}),
              [input.evaluation_id]: input.label,
            };
          }
        }
      }

      if (input.label === "missed") {
        const rej = state.rejectedEvaluations.find(
          (e) => e.evaluation_id === input.evaluation_id
        );
        if (rej) {
          rej.marked_missed = true;
        }
      }

      if (input.lead_id) {
        const lead = state.leads.find((l) => l.id === input.lead_id);
        if (lead) {
          lead.feedback_label = input.label;
          if (
            input.label === "irrelevant" ||
            input.label === "peer" ||
            input.label === "spam" ||
            input.label === "duplicate"
          ) {
            lead.status = "ignored";
          }
          if (input.label === "wrong_fields" && input.corrected_fields) {
            for (const [k, v] of Object.entries(input.corrected_fields)) {
              lead.fields[k] = {
                value: v,
                raw: lead.fields[k]?.raw ?? null,
                confidence: 1.0,
                source: "user",
              };
            }
          }
          lead.updated_at = Date.now();
          updatedLead = structuredClone(lead);
          emitMockEvent("lead:updated", structuredClone(lead));

          if (input.block_author && (lead.author_id || lead.author_name)) {
            blockedEntry = {
              id: nextId("01JCFB"),
              kind: "author",
              value: lead.author_id ?? lead.author_name,
              display_label: lead.author_name,
              radar_id: null,
              reason: "Người cùng nghề (chặn từ phản hồi tin)",
              created_at: Date.now(),
            };
            state.blocklist.unshift(blockedEntry);
          }
        }
      }

      const res: LeadFeedbackResult = {
        feedback_id: feedbackId,
        updated_lead: updatedLead,
        blocked_entry: blockedEntry,
      };
      return res as T;
    }

    case "lead_export": {
      const input = args.input as LeadExportInput;
      const listRes = await invokeMockCommand<LeadListResponse>("lead_list", {
        query: { ...input.query, limit: 10_000, cursor: null },
      });
      const rv = input.query.radar_id
        ? state.radarVersions.find((v) => v.radar_id === input.query.radar_id)
        : undefined;
      const fields = rv?.fields ?? [];

      const headers = [
        "Thời điểm đăng",
        "Radar",
        "Trạng thái",
        "Điểm",
        "Tóm tắt",
        "Group",
        "Tác giả",
        "Liên kết",
        ...(input.include_post_text ? ["Nội dung"] : []),
        ...fields.map((f) => f.label),
      ];

      const rows = listRes.items.map((lead) => {
        const post = state.posts.find((p) => p.id === lead.post_id);
        const fixed = [
          lead.post_created_at ? new Date(lead.post_created_at).toISOString() : "",
          lead.radar_name,
          lead.status,
          lead.score.toFixed(2),
          lead.summary,
          lead.source_name,
          lead.author_name,
          lead.permalink,
          ...(input.include_post_text ? [post?.text ?? ""] : []),
        ];
        const dyn = fields.map((f) => formatExtractedFieldValue(f, lead.fields[f.key]));
        return [...fixed, ...dyn].map(escapeCsvCell).join(",");
      });

      const csvBody = "\uFEFF" + [headers.map(escapeCsvCell).join(","), ...rows].join("\r\n");
      const ext = input.format === "xlsx" ? "xlsx" : "csv";
      const outPath =
        input.dest_path ?? `~/Downloads/dealsonar-leads-${new Date().toISOString().slice(0, 10)}.${ext}`;

      const result: LeadExportResult = {
        path: outPath,
        format: input.format,
        row_count: listRes.items.length,
        content_preview: csvBody,
      };
      return result as T;
    }

    // --- Posts & Rejected Evaluations ---
    case "post_get": {
      const id = String(args.id ?? "");
      const post = state.posts.find((p) => p.id === id);
      if (!post) throw new Error(`Không tìm thấy bài viết: ${id}`);
      return structuredClone(post) as T;
    }

    case "post_search": {
      const q = removeVietnameseDiacritics(String(args.query ?? "").trim()).toLowerCase();
      const sourceId = args.source_id ? String(args.source_id) : null;
      const limit = Number(args.limit ?? 30);
      let matched = state.posts.filter((p) => p.text !== null);
      if (sourceId) {
        matched = matched.filter((p) => p.source_id === sourceId);
      }
      if (q) {
        matched = matched.filter((p) =>
          removeVietnameseDiacritics(`${p.text ?? ""} ${p.author_name}`).toLowerCase().includes(q)
        );
      }
      return structuredClone(matched.slice(0, limit)) as T;
    }

    case "evaluation_list_rejected": {
      const radarId = String(args.radar_id ?? "");
      const items = radarId
        ? state.rejectedEvaluations.filter((e) => e.radar_id === radarId)
        : state.rejectedEvaluations;
      return structuredClone(items) as T;
    }

    // --- Contacts & Blocklist ---
    case "contact_list": {
      const q = removeVietnameseDiacritics(String(args.search ?? "").trim()).toLowerCase();
      let items = [...state.contacts];
      if (q) {
        items = items.filter((c) =>
          removeVietnameseDiacritics(
            `${c.display_name} ${c.phones.join(" ")} ${c.note ?? ""}`
          )
            .toLowerCase()
            .includes(q)
        );
      }
      return structuredClone(items) as T;
    }

    case "contact_get": {
      const id = String(args.id ?? "");
      const contact = state.contacts.find((c) => c.id === id);
      if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
      const leads = state.leads.filter((l) => l.contact_id === id);
      return structuredClone({ contact, leads } satisfies ContactDetail) as T;
    }

    case "contact_block": {
      const id = String(args.id ?? "");
      const contact = state.contacts.find((c) => c.id === id);
      if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
      contact.is_blocked = true;
      const created: BlocklistEntry[] = [];
      for (const phone of contact.phones) {
        const entry: BlocklistEntry = {
          id: nextId("01JCFB"),
          kind: "phone",
          value: phone,
          display_label: `${contact.display_name} (${phone})`,
          radar_id: (args.radar_id as string | null) ?? null,
          reason: (args.reason as string | null) ?? "Chặn từ Danh bạ",
          created_at: Date.now(),
        };
        state.blocklist.unshift(entry);
        created.push(entry);
      }
      return { blocked_entries: structuredClone(created) } as T;
    }

    case "contact_note": {
      const id = String(args.id ?? "");
      const contact = state.contacts.find((c) => c.id === id);
      if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
      contact.note = String(args.note ?? "");
      contact.updated_at = Date.now();
      return structuredClone(contact) as T;
    }

    case "blocklist_list":
      return structuredClone(state.blocklist) as T;

    case "blocklist_add": {
      const entry: BlocklistEntry = {
        id: nextId("01JCFB"),
        kind: args.kind as BlocklistKind,
        value: String(args.value ?? "").trim(),
        display_label: String(args.value ?? "").trim(),
        radar_id: (args.radar_id as string | null) ?? null,
        reason: (args.reason as string | null) ?? null,
        created_at: Date.now(),
      };
      state.blocklist.unshift(entry);
      return structuredClone(entry) as T;
    }

    case "blocklist_remove": {
      const id = String(args.id ?? "");
      const before = state.blocklist.length;
      state.blocklist = state.blocklist.filter((b) => b.id !== id);
      return { removed: state.blocklist.length < before } as T;
    }

    // --- Rulesets ---
    case "ruleset_list": {
      const radarId = String(args.radar_id ?? "");
      const versionIds = new Set(
        state.radarVersions.filter((v) => v.radar_id === radarId).map((v) => v.id)
      );
      return structuredClone(
        state.rulesets
          .filter((rs) => versionIds.has(rs.radar_version_id))
          .sort((a, b) => b.revision - a.revision)
      ) as T;
    }

    case "ruleset_save_user": {
      const radarVersionId = String(args.radar_version_id ?? "");
      const body = args.body as RulesetBody;
      const existing = state.rulesets.filter((r) => r.radar_version_id === radarVersionId);
      const nextRev = existing.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
      for (const r of existing) {
        if (r.state === "active") r.state = "retired";
      }
      const now = Date.now();
      const created: Ruleset = {
        id: nextId("01JCF5"),
        radar_version_id: radarVersionId,
        revision: nextRev,
        state: "active",
        origin: "user",
        body: structuredClone(body),
        metrics: {
          rule_handled_pct: 84,
          ai_handled_pct: 16,
          accept_precision: 0.96,
          false_negative_rate: 0.014,
          sample_size: 200,
        },
        created_at: now,
        activated_at: now,
      };
      state.rulesets.unshift(created);
      return structuredClone(created) as T;
    }

    case "ruleset_compile_now": {
      const radarId = String(args.radar_id ?? "");
      const detail = getRadarDetail(radarId);
      const rvId = detail.current_version_data.id;
      const existing = state.rulesets.filter((r) => r.radar_version_id === rvId);
      const nextRev = existing.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
      const baseBody = existing[0]?.body ?? {
        dsl: 1 as const,
        prefilter: { any: ["can thue", "can mua"], none: ["tuyen sale"], min_len: 20 },
        classify: [],
        extract: [{ field: "phone", extractor: "vn_phone" }],
        thresholds: { accept: 0.9, reject: 0.9 },
      };
      const compiled: Ruleset = {
        id: nextId("01JCF5"),
        radar_version_id: rvId,
        revision: nextRev,
        state: "shadow",
        origin: "compiled",
        body: structuredClone(baseBody),
        metrics: {
          rule_handled_pct: 79,
          ai_handled_pct: 21,
          accept_precision: 0.97,
          false_negative_rate: 0.01,
          sample_size: 160,
        },
        created_at: Date.now(),
        activated_at: null,
      };
      state.rulesets.unshift(compiled);
      return { job_id: nextId("01JCFJ"), ruleset: structuredClone(compiled) } as T;
    }

    // --- Settings, AI, Telegram, Webhook, Chrome, License ---
    case "settings_get":
      return structuredClone(state.settings) as T;

    case "settings_set": {
      const patch = (args.patch ?? args) as Partial<Settings>;
      state.settings = {
        ...state.settings,
        ...patch,
        crawl_policy: patch.crawl_policy
          ? { ...state.settings.crawl_policy, ...patch.crawl_policy }
          : state.settings.crawl_policy,
        model_tiers: patch.model_tiers
          ? { ...state.settings.model_tiers, ...patch.model_tiers }
          : state.settings.model_tiers,
      };
      return structuredClone(state.settings) as T;
    }

    case "ai_probe":
      return structuredClone(state.probes) as T;

    case "ai_set_provider": {
      const provider = args.provider as AiProviderId;
      state.settings.ai_provider = provider;
      if (args.model_tiers) {
        state.settings.model_tiers[provider] = args.model_tiers as Settings["model_tiers"][AiProviderId];
      }
      state.health.ai_provider = provider;
      state.health.ai_state = state.probes[provider]?.authenticated ? "ok" : "error";
      return structuredClone(state.settings) as T;
    }

    case "telegram_set_token": {
      const token = String(args.token ?? "").trim();
      if (!/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(token)) {
        throw new Error("Định dạng Bot Token không hợp lệ (ví dụ: 123456789:AAHxyz...).");
      }
      const existingTg = state.channels.find((c) => c.kind === "telegram");
      if (!existingTg) {
        state.channels.push({
          id: nextId("01JCF9"),
          kind: "telegram",
          name: "Telegram Cá nhân (@dealsonar_alert_bot)",
          config: {
            chat_id: "581920311",
            bot_username: "dealsonar_alert_bot",
            chat_type: "private",
          },
          state: "ok",
          created_at: Date.now(),
        });
      }
      state.health.telegram_state = "ok";
      state.health.telegram_channel_count = state.channels.filter(
        (c) => c.kind === "telegram"
      ).length;
      const status: TelegramSetupStatus = {
        bot_username: "dealsonar_alert_bot",
        bot_link: "https://t.me/dealsonar_alert_bot",
        waiting_for_start: false,
        channels: structuredClone(state.channels.filter((c) => c.kind === "telegram")),
      };
      return status as T;
    }

    case "telegram_test":
      return {
        ok: true,
        message: "Đã gửi tin thử thành công tới Telegram!",
      } as T;

    case "channel_list":
      return structuredClone(state.channels) as T;

    case "channel_remove": {
      const id = String(args.id ?? "");
      state.channels = state.channels.filter((c) => c.id !== id);
      state.health.telegram_channel_count = state.channels.filter(
        (c) => c.kind === "telegram"
      ).length;
      return { removed: true } as T;
    }

    case "webhook_add": {
      const url = String(args.url ?? "").trim();
      const name = String(args.name ?? "Webhook CRM").trim();
      if (!url.startsWith("https://") && !url.startsWith("http://localhost")) {
        throw new Error("Webhook chỉ chấp nhận địa chỉ https:// (hoặc http://localhost khi thử nghiệm tại máy).");
      }
      const ch: Channel = {
        id: nextId("01JCF9"),
        kind: "webhook",
        name,
        config: { url },
        state: "ok",
        created_at: Date.now(),
      };
      state.channels.push(ch);
      return structuredClone(ch) as T;
    }

    case "chrome_connect": {
      if (args.resume_crawl && state.health.facebook_session === "ok") {
        state.health.crawl_paused = false;
        state.health.crawl_pause_reason = null;
      }
      state.health.extension_connected = true;
      const res: ChromeConnectResult = {
        native_host_installed: true,
        manifest_path:
          "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json",
        extension_connected: state.health.extension_connected,
        facebook_session: state.health.facebook_session,
        message: "Đã ghi file khai báo Native Host và kết nối thành công với Chrome Extension.",
      };
      return res as T;
    }

    case "license_get":
      return structuredClone(state.license) as T;

    case "license_set": {
      const key = String(args.license_key ?? "").trim();
      if (!key) {
        state.license = {
          plan: "personal",
          licensee: null,
          issued_at: null,
          expires_at: null,
          is_valid: true,
          key_preview: null,
          limits: buildPlanLimits("personal"),
        };
        return structuredClone(state.license) as T;
      }
      const isPro = key.toUpperCase().startsWith("DS-PRO-") || key.length >= 16;
      const plan: PlanTier = isPro ? "pro" : "personal";
      const now = Date.now();
      state.license = {
        plan,
        licensee: isPro ? " Gói Chuyên nghiệp (Đã xác thực Ed25519)" : null,
        issued_at: now,
        expires_at: now + 365 * 86_400_000,
        is_valid: isPro,
        key_preview: `${key.slice(0, 8)}…${key.slice(-4)}`,
        limits: buildPlanLimits(plan),
      };
      return structuredClone(state.license) as T;
    }

    // --- Health & Diagnostics ---
    case "health_get":
      return structuredClone(state.health) as T;

    case "crawl_run_list":
      return structuredClone(state.crawlRuns) as T;

    case "ai_usage_get": {
      const stats: AiUsageStats = {
        today_items: 142,
        daily_cap: state.settings.daily_ai_post_cap,
        total_calls: 58,
        total_items: 940,
        total_input_tokens: 412_800,
        total_output_tokens: 98_400,
        total_cost_usd: 0.84,
        avg_ai_escalation_pct: 18,
        daily: [
          {
            date: "2026-11-12",
            calls: 9,
            items: 142,
            input_tokens: 61_200,
            output_tokens: 14_800,
            cost_usd: 0.13,
            ai_escalation_pct: 17.5,
          },
          {
            date: "2026-11-11",
            calls: 14,
            items: 228,
            input_tokens: 98_400,
            output_tokens: 23_100,
            cost_usd: 0.21,
            ai_escalation_pct: 18.2,
          },
          {
            date: "2026-11-10",
            calls: 12,
            items: 196,
            input_tokens: 86_500,
            output_tokens: 20_400,
            cost_usd: 0.18,
            ai_escalation_pct: 19.0,
          },
          {
            date: "2026-11-09",
            calls: 11,
            items: 184,
            input_tokens: 81_200,
            output_tokens: 19_600,
            cost_usd: 0.16,
            ai_escalation_pct: 17.8,
          },
          {
            date: "2026-11-08",
            calls: 12,
            items: 190,
            input_tokens: 85_500,
            output_tokens: 20_500,
            cost_usd: 0.16,
            ai_escalation_pct: 18.4,
          },
        ],
      };
      return stats as T;
    }

    case "diagnostic_bundle_create":
      return {
        path: `~/Downloads/dealsonar-diagnostics-${Date.now()}.zip`,
        size_bytes: 184_320,
        created_at: Date.now(),
      } as T;

    // --- Data Lifecycle ---
    case "data_backup":
      return {
        path: `~/Library/Application Support/DealSonar/backups/dealsonar-manual-${Date.now()}.db`,
        created_at: Date.now(),
      } as T;

    case "data_purge":
      return {
        posts_purged: 38,
        evaluations_cleaned: 38,
      } as T;

    case "data_delete_all": {
      const phrase = String(args.confirm_phrase ?? "").trim();
      if (phrase !== "XOA TOAN BO") {
        throw new Error("Cụm từ xác nhận không khớp.");
      }
      const preservedCalls = state.calls;
      resetMockBackend({ onboarding: true, emptyRadars: true });
      state.calls = preservedCalls;
      return { deleted: true } as T;
    }

    default:
      throw new Error(`Lệnh Tauri chưa được hỗ trợ trong mockBackend: ${cmd}`);
  }
}
