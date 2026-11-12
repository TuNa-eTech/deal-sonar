import type {
  ExtractedField,
  FieldDef,
  FieldType,
  LeadStatus,
  LocationValue,
  MoneyValue,
  RadarStatus,
  RadarTemplate,
  RangeValue,
  RejectReason,
} from "../types/ipc";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Văn bản",
  number: "Con số",
  money: "Tiền tệ (VNĐ)",
  phone: "Số điện thoại",
  location: "Địa điểm / Khu vực",
  enum: "Một lựa chọn",
  multi_enum: "Nhiều lựa chọn",
  boolean: "Đúng / Sai",
  date: "Ngày tháng",
  range: "Khoảng (từ – đến)",
  url: "Đường dẫn (URL)",
};

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Mới",
  viewed: "Đã xem",
  contacted: "Đã liên hệ",
  negotiating: "Đang thương lượng",
  won: "Chốt thành công",
  lost: "Không thành",
  ignored: "Bỏ qua",
};

export const RADAR_STATUS_LABELS: Record<RadarStatus, string> = {
  draft: "Bản nháp",
  active: "Đang chạy",
  paused: "Tạm dừng",
  archived: "Đã lưu trữ",
};

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  duplicate: "Trùng lặp giữa các group",
  prefilter: "Lọc sơ bộ loại (ngắn / từ khoá loại)",
  irrelevant: "Không liên quan mô tả",
  peer: "Người cùng nghề đăng bài",
  spam: "Bài rác / quảng cáo",
  blocked: "Nằm trong danh sách chặn",
  hard_filter: "Không thoả điều kiện cứng",
};

export function formatDomesticPhone(phone: string): string {
  const trimmed = phone.trim();
  const normalized = trimmed.startsWith("+84")
    ? "0" + trimmed.slice(3)
    : trimmed.startsWith("84") && trimmed.length >= 11
      ? "0" + trimmed.slice(2)
      : trimmed;
  const digits = normalized.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 11) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return trimmed;
}

function formatVndShort(amount: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) {
    const ty = amount / 1_000_000_000;
    return `${Number(ty.toFixed(2)).toLocaleString("vi-VN")} tỷ`;
  }
  if (abs >= 1_000_000) {
    const tr = amount / 1_000_000;
    return `${Number(tr.toFixed(1)).toLocaleString("vi-VN")} triệu`;
  }
  if (abs >= 1_000) {
    const k = amount / 1_000;
    return `${Number(k.toFixed(0)).toLocaleString("vi-VN")} nghìn`;
  }
  return amount.toLocaleString("vi-VN");
}

const PERIOD_LABELS: Record<string, string> = {
  month: "/tháng",
  year: "/năm",
  day: "/ngày",
};

export function formatMoneyValue(val: MoneyValue): string {
  const periodSuffix = val.period ? (PERIOD_LABELS[val.period] ?? "") : "";
  if (val.currency && val.currency !== "VND") {
    if (val.min === val.max) {
      return `${val.min.toLocaleString("vi-VN")} ${val.currency}${periodSuffix}`;
    }
    return `${val.min.toLocaleString("vi-VN")}–${val.max.toLocaleString("vi-VN")} ${val.currency}${periodSuffix}`;
  }
  if (val.min === val.max) {
    return `${formatVndShort(val.min)}${periodSuffix}`;
  }
  // If both in millions, format compactly like "12–15 triệu/tháng"
  if (
    val.min >= 1_000_000 &&
    val.max < 1_000_000_000 &&
    val.min < 1_000_000_000
  ) {
    const minTr = Number((val.min / 1_000_000).toFixed(1)).toLocaleString("vi-VN");
    const maxTr = Number((val.max / 1_000_000).toFixed(1)).toLocaleString("vi-VN");
    return `${minTr}–${maxTr} triệu${periodSuffix}`;
  }
  return `${formatVndShort(val.min)} – ${formatVndShort(val.max)}${periodSuffix}`;
}

export function formatLocationValue(val: LocationValue): string {
  const parts = [val.ward, val.district, val.province].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(", ");
  }
  return val.raw || "—";
}

export function formatRangeValue(val: RangeValue): string {
  const unit = val.unit === "m2" ? "m²" : val.unit || "";
  if (val.min === val.max) {
    return `${val.min.toLocaleString("vi-VN")}${unit ? ` ${unit}` : ""}`;
  }
  return `${val.min.toLocaleString("vi-VN")}–${val.max.toLocaleString("vi-VN")}${unit ? ` ${unit}` : ""}`;
}

export function formatExtractedFieldValue(
  fieldDef: Pick<FieldDef, "type"> | undefined,
  extracted: ExtractedField | undefined
): string {
  if (!extracted || extracted.value === null || extracted.value === undefined) {
    return "—";
  }
  const v = extracted.value;
  const type = fieldDef?.type;

  if (type === "phone" && typeof v === "string") {
    return formatDomesticPhone(v);
  }
  if (type === "boolean" || typeof v === "boolean") {
    return v ? "Có" : "Không";
  }
  if (Array.isArray(v)) {
    return v.length > 0 ? v.map(String).join(", ") : "—";
  }
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    if ("currency" in obj && typeof obj.min === "number" && typeof obj.max === "number") {
      return formatMoneyValue(obj as unknown as MoneyValue);
    }
    if ("province" in obj || "district" in obj || "ward" in obj) {
      return formatLocationValue(obj as unknown as LocationValue);
    }
    if ("unit" in obj && typeof obj.min === "number" && typeof obj.max === "number") {
      return formatRangeValue(obj as unknown as RangeValue);
    }
    return JSON.stringify(v);
  }
  if (typeof v === "number") {
    return v.toLocaleString("vi-VN");
  }
  return String(v);
}

export function formatRelativeTime(tsMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (!tsMs) return "vừa thấy";
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (diffSec < 60) return "vừa xong";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} giờ trước`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} ngày trước`;
  return formatExactTime(tsMs);
}

export function formatExactTime(tsMs: number | null | undefined): string {
  if (!tsMs) return "Không rõ giờ đăng";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(tsMs));
  } catch {
    return new Date(tsMs).toISOString();
  }
}

export function composeTemplateDescription(
  template: RadarTemplate,
  values: Record<string, string>
): string {
  let result = template.description_template;
  for (const ph of template.placeholders) {
    const val = values[ph.key]?.trim();
    const replacement = val && val.length > 0 ? val : ph.hint.replace(/…$/, "");
    result = result.replace(`{${ph.key}}`, replacement);
  }
  return result;
}

export function slugifyFieldKey(label: string, fallbackIndex: number): string {
  const folded = removeVietnameseDiacritics(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const clean = folded.startsWith("_") || !/^[a-z]/.test(folded) ? `f_${folded}` : folded;
  const sliced = clean.slice(0, 30);
  return /^[a-z][a-z0-9_]{1,30}$/.test(sliced) ? sliced : `field_${fallbackIndex}`;
}

export function removeVietnameseDiacritics(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}
