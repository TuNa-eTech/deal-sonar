/** Port of `tray.rs::format_tray_status_label`. Same Vietnamese strings, same precedence. */
export interface HealthLike {
  crawl_paused?: boolean;
  facebook_session?: string;
  ai_state?: string;
  extension_connected?: boolean;
}

export function formatTrayStatusLabel(health: HealthLike | null | undefined): string {
  if (!health) return "Trạng thái: Sẵn sàng";
  if (health.crawl_paused) return "Trạng thái: Đang tạm dừng quét";
  switch (health.facebook_session) {
    case "checkpoint":
      return "Trạng thái: Cần xác minh phiên Facebook";
    case "logged_out":
      return "Trạng thái: Facebook đã đăng xuất";
    case "rate_limited":
      return "Trạng thái: Đang giãn nhịp Facebook";
    default:
      break;
  }
  if (health.ai_state === "error") return "Trạng thái: Lỗi kết nối AI CLI";
  if (!health.extension_connected) return "Trạng thái: Chờ kết nối tiện ích Chrome";
  return "Trạng thái: Sẵn sàng";
}

/** Port of `state.rs::is_minimized_startup`. */
export function isMinimizedStartup(argv: readonly string[]): boolean {
  return argv.some((a) => a === "--minimized" || a === "--autostart");
}
