import React from "react";
import type { HealthStatus } from "../types/ipc";
import { formatExactTime } from "../lib/format";
import { openSafeSetupUrl } from "../lib/security";

interface GlobalHealthBannerProps {
  health: HealthStatus | null;
  onRetryConnect: () => void;
  onResumeCrawl: () => void;
  onOpenRadars: () => void;
}

export const GlobalHealthBanner: React.FC<GlobalHealthBannerProps> = ({
  health,
  onRetryConnect,
  onResumeCrawl,
  onOpenRadars,
}) => {
  if (!health) return null;

  const banners: React.ReactNode[] = [];

  // 1. Extension disconnected (`03-ux-flows.md §5`)
  if (!health.extension_connected) {
    banners.push(
      <div key="ext-down" className="health-banner danger" role="alert">
        <div>
          <strong>Mất kết nối Chrome Extension:</strong> Radar đang tạm ngừng đọc bài mới. Hãy mở
          Google Chrome có cài DealSonar Extension.
        </div>
        <button type="button" className="btn btn-sm" onClick={onRetryConnect}>
          Kiểm tra lại kết nối
        </button>
      </div>
    );
  }

  // 2. Facebook session issue or checkpoint awaiting resume (`03-ux-flows.md §5`:
  //    "nút 'Tiếp tục' chỉ bật sau khi phiên ổn")
  const hasFbIssue =
    health.facebook_session !== "ok" ||
    health.crawl_pause_reason === "checkpoint_awaiting_resume";

  if (hasFbIssue) {
    const canResume = health.facebook_session === "ok";
    const detailText =
      health.facebook_session === "logged_out"
        ? "Facebook đã đăng xuất. Toàn bộ lịch quét đã dừng — vui lòng đăng nhập lại Facebook trong Chrome."
        : health.facebook_session === "checkpoint"
          ? "Facebook yêu cầu xác minh danh tính (checkpoint). DealSonar đã dừng toàn bộ quét và không tự thử lại để bảo vệ tài khoản."
          : health.facebook_session === "rate_limited"
            ? "Facebook thông báo hạn chế tạm thời. Đã tự động tạm dừng 24 giờ và giảm một nửa tần suất quét trong 7 ngày."
            : "Phiên Facebook đã ổn định trở lại sau sự cố xác minh. Bấm «Tiếp tục» để cho phép quét lại.";

    banners.push(
      <div key="fb-session" className="health-banner danger" role="alert">
        <div>
          <strong>Tạm dừng quét Facebook:</strong> {detailText}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => openSafeSetupUrl("https://www.facebook.com")}
          >
            Mở facebook.com
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!canResume}
            title={
              canResume
                ? "Phiên Facebook đã ổn, bấm để tiếp tục quét"
                : "Chỉ bật sau khi phiên Facebook trở lại trạng thái ổn định"
            }
            onClick={onResumeCrawl}
          >
            Tiếp tục
          </button>
        </div>
      </div>
    );
  }

  // 3. AI unavailable / rate limited / daily cap (`03-ux-flows.md §5`)
  if (
    health.ai_state === "error" ||
    health.ai_state === "rate_limited" ||
    health.ai_state === "daily_cap_reached"
  ) {
    const etaText = health.ai_rate_limit_reset_at
      ? ` · Dự kiến hồi phục lúc ${formatExactTime(health.ai_rate_limit_reset_at)}`
      : "";
    const reasonText =
      health.ai_state === "rate_limited"
        ? "Hết hạn mức gói AI tạm thời"
        : health.ai_state === "daily_cap_reached"
          ? "Đã chạm trần số bài gửi AI trong ngày"
          : `Không gọi được CLI AI (${health.ai_error ?? "lỗi tiến trình"})`;

    banners.push(
      <div key="ai-down" className="health-banner warning" role="status">
        <div>
          <strong>{reasonText}:</strong> Hiện có{" "}
          <strong>{health.pending_ai_posts.toLocaleString("vi-VN")} bài</strong> đang xếp hàng chờ
          và sẽ tự động xử lý khi AI sẵn sàng trở lại{etaText}.
        </div>
        <button type="button" className="btn btn-sm" onClick={onRetryConnect}>
          Kiểm tra AI
        </button>
      </div>
    );
  }

  // 4. Radar flood auto-digest (> 30 leads/hour, `03-ux-flows.md §5`, `07-notifications-export.md §3`)
  if (health.flood_radars.length > 0) {
    const names = health.flood_radars
      .map((r) => `«${r.radar_name}» (${r.leads_last_hour} tin/giờ)`)
      .join(", ");
    banners.push(
      <div key="flood-digest" className="health-banner info" role="status">
        <div>
          <strong>Tự chuyển sang gửi gộp (Digest):</strong> Radar {names} vượt 30 tin/giờ. Hãy xem
          lại mô tả để tránh quá rộng.
        </div>
        <button type="button" className="btn btn-sm" onClick={onOpenRadars}>
          Xem radar
        </button>
      </div>
    );
  }

  if (banners.length === 0) return null;

  return <div className="health-banner-stack">{banners}</div>;
};
