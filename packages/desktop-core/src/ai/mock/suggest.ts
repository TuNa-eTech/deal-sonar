// Heuristic `suggest_fields` responses (port of crates/ai-bridge/src/adapters/mock/suggest.rs).

import { PostText, extractMoneyField } from "./extract";
import { foldVi, isJsonObject } from "./text";

const PROFESSION_MARKER = "Nghề của người dùng:";
const SOURCES_MARKER = "\nNhóm Facebook có sẵn (JSON):\n";

const SOURCE_TOPICS = [
  "can ho", "chung cu", "thue nha", "bat dong san", "tim tho", "dien nuoc", "sua", "oto", "xe cu", "tuyen dung",
];

/** Up to 3 candidate group ids whose name shares a topic with the radar description. */
export function heuristicSourceIds(prompt: string): string[] {
  const at = prompt.indexOf(SOURCES_MARKER);
  if (at < 0) return [];
  const description = foldVi(prompt.slice(0, at).split(PROFESSION_MARKER)[0]);
  let sources: unknown;
  try {
    sources = JSON.parse(prompt.slice(at + SOURCES_MARKER.length));
  } catch {
    return [];
  }
  if (!Array.isArray(sources)) return [];
  const ids: string[] = [];
  for (const source of sources) {
    if (!isJsonObject(source) || typeof source.id !== "string" || typeof source.name !== "string") continue;
    const name = foldVi(source.name);
    if (SOURCE_TOPICS.some((topic) => description.includes(topic) && name.includes(topic))) ids.push(source.id);
    if (ids.length === 3) break;
  }
  return ids;
}

const field = (key: string, label: string, type: string, description: string, required: boolean) => ({
  key,
  label,
  type,
  description,
  required,
  options: null,
});

export function heuristicSuggestFields(prompt: string): Record<string, unknown> {
  const descSection = prompt.split(PROFESSION_MARKER)[0];
  const folded = foldVi(descSection);

  const wantIntent =
    folded.includes("ghep hang") || folded.includes("can xe / co xe")
      ? "any"
      : folded.includes("chinh chu") ||
          folded.includes("cho thue") ||
          folded.includes("tin ban") ||
          folded.includes("nguoi tim viec")
        ? "supply"
        : "demand";

  const isBds = ["can ho", "chung cu", "thue nha", "can thue", "phong ngu", "bat dong san"].some((k) => folded.includes(k));
  const isRepair = folded.includes("tim tho") || folded.includes("sua ") || folded.includes("dien nuoc");

  if (isRepair) {
    return {
      suggested_name: "Khách tìm thợ sửa chữa nhà cửa",
      want_intent: wantIntent,
      fields: [
        field("service_type", "Loại công việc", "text", "Hạng mục sửa chữa hoặc lắp đặt khách đang cần", true),
        field("location", "Khu vực", "location", "Quận/huyện hoặc địa chỉ khách cần thợ tới", false),
        field("urgent", "Cần gấp", "boolean", "Khách có cần xử lý ngay trong ngày không", false),
        field("phone", "Số điện thoại", "phone", "Số điện thoại liên hệ của khách", false),
      ],
      hard_filters: [],
      clarifying_questions: [],
      prefilter_hint: {
        any: ["tim tho", "can tho", "ai biet tho", "sua chua"],
        none: ["nhan sua chua", "doi tho chuyen"],
      },
    };
  }

  if (isBds) {
    const hardFilters: Array<Record<string, unknown>> = [];
    const maxBudget = (extractMoneyField(new PostText(descSection)).value as { max?: unknown } | null)?.max;
    if (typeof maxBudget === "number" && (folded.includes("duoi ") || folded.includes("toi da"))) {
      hardFilters.push({
        field: "price",
        op: folded.includes("duoi ") ? "lt" : "lte",
        value: maxBudget,
        when_missing: "fail",
      });
    }
    return {
      suggested_name: "Khách cần thuê căn hộ theo khu vực",
      want_intent: wantIntent,
      fields: [
        field("location", "Khu vực", "location", "Quận, phường hoặc khu vực khách muốn thuê", true),
        field("price", "Ngân sách", "money", "Mức giá thuê khách mong muốn", false),
        field("bedrooms", "Số phòng ngủ", "number", "Số phòng ngủ yêu cầu", false),
        field("area", "Diện tích", "range", "Khoảng diện tích (m2)", false),
        field("phone", "Số điện thoại", "phone", "Số điện thoại liên hệ trong bài", false),
      ],
      hard_filters: hardFilters,
      clarifying_questions: ["Bạn có muốn nhận cả các bài khách chưa ghi rõ mức ngân sách không?"],
      prefilter_hint: {
        any: ["can thue", "tim thue", "tim can ho", "tim phong"],
        none: ["chinh chu cho thue", "tuyen nhan vien kinh doanh"],
      },
    };
  }

  return {
    suggested_name: "Radar theo dõi tin khách hàng",
    want_intent: wantIntent,
    fields: [
      field("topic", "Nhu cầu chính", "text", "Sản phẩm hoặc dịch vụ được nhắc tới trong bài", true),
      field("price", "Ngân sách / Giá", "money", "Số tiền nêu trong bài", false),
      field("location", "Khu vực", "location", "Địa điểm giao dịch", false),
      field("phone", "Số điện thoại", "phone", "Số điện thoại liên hệ", false),
    ],
    hard_filters: [],
    clarifying_questions: ["Bạn muốn lọc theo khu vực tỉnh/thành cụ thể nào không?"],
    prefilter_hint: { any: [], none: ["tuyen ctv", "viec lam tai nha"] },
  };
}
