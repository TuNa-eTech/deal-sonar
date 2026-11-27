// First-run connection checks. Each connection is judged on its own, so a fix in one place
// never hides a problem in another, and the guide can point at the next thing to repair.

import type { HealthStatus, ProbeResult } from "../types/ipc";

export type SetupCheckId = "chrome" | "facebook" | "ai" | "scanning" | "channel";
export type SetupCheckState = "ok" | "problem" | "unknown";

export interface SetupCheck {
  id: SetupCheckId;
  label: string;
  /** Required connections must be `ok` before the first Radar can run unattended. */
  required: boolean;
  state: SetupCheckState;
  detail: string;
  /** What to do when the state is not `ok`. */
  fix: string;
}

export interface SetupInputs {
  health: HealthStatus | null;
  /** Chrome extension reachable, from the latest check. */
  extension: boolean;
  facebookOk: boolean;
  probe: ProbeResult | null;
  probed: boolean;
}

export function evaluateSetup({ health, extension, facebookOk, probe, probed }: SetupInputs): SetupCheck[] {
  const scanning = health?.automatic_scanning;
  const aiReady = Boolean(probe?.installed && probe?.authenticated);
  const channelOk = (health?.telegram_channel_count ?? 0) > 0 || health?.telegram_state === "ok";
  return [
    {
      id: "chrome",
      label: "Chrome",
      required: true,
      state: extension ? "ok" : "problem",
      detail: extension ? "Đã kết nối" : "Cần cài hoặc mở tiện ích DealSonar",
      fix: "Cài hoặc mở tiện ích DealSonar trong Chrome, giữ Chrome mở rồi kiểm tra lại.",
    },
    {
      id: "facebook",
      label: "Facebook",
      required: true,
      state: !extension ? "unknown" : facebookOk ? "ok" : "problem",
      detail: !extension ? "Chờ kết nối Chrome" : facebookOk ? "Phiên sẵn sàng" : "Cần đăng nhập hoặc xác minh",
      fix: "Mở facebook.com trong Chrome, đăng nhập hoặc hoàn thành xác minh rồi kiểm tra lại.",
    },
    {
      id: "ai",
      label: "AI",
      required: true,
      state: !probed ? "unknown" : aiReady ? "ok" : "problem",
      detail: !probed
        ? "Chưa kiểm tra"
        : aiReady
          ? "Sẵn sàng"
          : probe?.installed ? "Chưa đăng nhập CLI AI" : "Chưa cài CLI AI",
      fix: probe
        ? (probe.installed ? (probe.login_command ?? "") : `${probe.install_hint ?? ""}\n${probe.login_command ?? ""}`).trim()
        || "Cài và đăng nhập một CLI AI (claude, codex hoặc agy), rồi kiểm tra lại."
        : "Cài và đăng nhập một CLI AI (claude, codex hoặc agy), rồi kiểm tra lại.",
    },
    {
      id: "scanning",
      label: "Quét tự động",
      required: true,
      state: !extension ? "unknown" : scanning === true ? "ok" : scanning === false ? "problem" : "unknown",
      detail: !extension
        ? "Chờ kết nối Chrome"
        : scanning === true ? "Đã bật" : scanning === false ? "Đang tắt: chỉ quét khi bạn bấm Quét ngay" : "Chưa xác nhận từ tiện ích",
      fix: "Mở tiện ích DealSonar trong Chrome và bật Quét tự động, rồi kiểm tra lại.",
    },
    {
      id: "channel",
      label: "Kênh nhận tin",
      required: false,
      state: channelOk ? "ok" : "unknown",
      detail: channelOk ? "Đã có kênh nhận" : "Chưa có (tuỳ chọn): tin vẫn hiện trong ứng dụng",
      fix: "Mở Cài đặt → Thông báo để kết nối Telegram hoặc webhook.",
    },
  ];
}

/** The first required connection that still needs work, in setup order. */
export function nextSetupCheck(checks: SetupCheck[]): SetupCheck | null {
  return checks.find((check) => check.required && check.state !== "ok") ?? null;
}
