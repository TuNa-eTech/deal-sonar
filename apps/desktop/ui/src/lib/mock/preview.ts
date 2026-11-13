// Radar preview simulation (warnings and preview items).

import type { FieldDef, PreviewItem, PreviewWarning, ExtractedField } from "../../types/ipc";
import { removeVietnameseDiacritics } from "../format";
import { state } from "./store";

export function buildPreviewWarnings(fields: FieldDef[], items: PreviewItem[]): PreviewWarning[] {
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

export function generatePreviewItemsForRadar(
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
