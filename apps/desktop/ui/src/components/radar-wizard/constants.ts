import type { WantIntent } from "../../types/ipc";

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
