// Session badge labels and relative time formatting for the popup.

import type { SessionState } from "../protocol";

export const SESSION_BADGE_MAP: Record<
  SessionState,
  { label: string; cssClass: "ok" | "warn" | "err"; help?: string; showOpenFb?: boolean }
> = {
  ok: { label: "Đang hoạt động", cssClass: "ok" },
  logged_out: {
    label: "Đã đăng xuất",
    cssClass: "err",
    help: "Đã tạm dừng quét. Hãy đăng nhập lại Facebook trên trình duyệt Chrome này.",
    showOpenFb: true,
  },
  checkpoint: {
    label: "Cần xác minh",
    cssClass: "err",
    help: "Facebook yêu cầu xác minh danh tính. Hãy hoàn tất trên Facebook rồi bấm \"Tiếp tục\" trong ứng dụng DealSonar.",
    showOpenFb: true,
  },
  rate_limited: {
    label: "Tạm giới hạn",
    cssClass: "warn",
    help: "Phát hiện giới hạn tạm thời. Đã tự động tạm dừng 24 giờ và giãn đôi chu kỳ trong 7 ngày kế tiếp.",
  },
  unknown: {
    label: "Chưa rõ",
    cssClass: "warn",
  },
};

export function formatRelativeVietnameseTime(
  targetMs: number | null,
  nowMs: number = Date.now(),
  mode: "past" | "future" = "past",
): string {
  if (targetMs === null || !Number.isFinite(targetMs)) {
    return mode === "past" ? "Chưa quét" : "Đang chờ lịch";
  }

  const timeStr = new Date(targetMs).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (mode === "past") {
    const diffMin = Math.max(0, Math.round((nowMs - targetMs) / 60_000));
    if (diffMin < 1) return `Vừa xong (${timeStr})`;
    if (diffMin < 60) return `${diffMin} phút trước`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} giờ trước (${timeStr})`;
    return new Date(targetMs).toLocaleDateString("vi-VN");
  }

  const aheadMin = Math.round((targetMs - nowMs) / 60_000);
  if (aheadMin <= 0) return "Sắp quét ngay";
  if (aheadMin < 60) return `Sau ${aheadMin} phút (${timeStr})`;
  const aheadHr = Math.floor(aheadMin / 60);
  return `${timeStr} (~${aheadHr} giờ nữa)`;
}
