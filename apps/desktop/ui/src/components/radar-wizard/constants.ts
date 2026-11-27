import type { WantIntent } from "../../types/ipc";

export const INTENT_LABELS: Record<WantIntent, string> = {
  demand: "Người đang cần mua / thuê / tìm",
  supply: "Người đang bán / cho thuê / cung cấp",
  any: "Cả hai chiều (trung tính)",
};

/** Start of the core's note that the trade side was left neutral; removed once the user chooses. */
export const SIDE_NEUTRAL_PREFIX = "Chưa rõ bạn muốn tìm bài của người cần";

/** Trim, drop empty and duplicate lines, keep at most five assumptions. */
export function cleanAssumptions(items: readonly string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))].slice(0, 5);
}

export const BLANK_EXAMPLES = [
  {
    title: "BĐS — Khách thuê chung cư",
    description:
      "Người đang cần thuê căn hộ 2 phòng ngủ ở Cầu Giấy hoặc Mỹ Đình, ngân sách dưới 15 triệu/tháng",
    profession: "môi giới bất động sản",
    intent: "demand" as WantIntent,
  },
  {
    title: "Dịch vụ — Tìm thợ điện lạnh",
    description:
      "Chủ nhà hỏi tìm thợ sửa điều hoà, vệ sinh máy giặt hoặc sửa điện nước gấp tại nội thành Hà Nội",
    profession: "thợ sửa chữa điện nước điều hoà",
    intent: "demand" as WantIntent,
  },
  {
    title: "Xe & đồ cũ — Người dùng bán gấp",
    description:
      "Cá nhân chính chủ cần bán gấp xe ô tô Toyota Vios hoặc Hyundai Accent đời từ 2019 trở lên tại miền Bắc",
    profession: "người thu mua ô tô cũ",
    intent: "supply" as WantIntent,
  },
];
