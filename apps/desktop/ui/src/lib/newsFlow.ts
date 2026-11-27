// Why has no lead reached the user yet? Four separate situations, each with the last time it
// worked and the next thing to do. Plus the first-run journey, with install time kept apart
// from Radar creation time.

import type { FirstNewsStatus, HealthStatus } from "../types/ipc";
import { formatRelativeTime } from "./format";

export type FlowStageId = "not_collected" | "no_match" | "waiting_ai" | "delivery_failed";

export interface FlowAction {
  label: string;
  /** Workspace hash route, e.g. `sources`, `settings/notifications`. */
  hash: string;
}

export interface FlowStage {
  id: FlowStageId;
  title: string;
  active: boolean;
  summary: string;
  /** When this stage last worked (crawl, evaluation or delivery), if ever. */
  lastSuccessAt: number | null;
  lastSuccess: string;
  next: FlowAction | null;
}

export interface NewsFlowReport {
  headline: string;
  tone: "ok" | "info" | "warning" | "danger";
  /** The stage to fix first, or why nothing needs fixing. */
  primary: FlowStageId | "no_radar" | "has_leads" | "processing";
  stages: FlowStage[];
}

const PRIORITY: FlowStageId[] = ["not_collected", "waiting_ai", "delivery_failed", "no_match"];

function lastSuccess(at: number | null, never: string, now: number): string {
  return at ? formatRelativeTime(at, now) : never;
}

function collectionProblem(
  status: FirstNewsStatus,
  health: HealthStatus | null,
): { summary: string; next: FlowAction } {
  if (!health?.extension_connected) {
    return { summary: "Chrome chưa kết nối với DealSonar nên chưa thu được bài.", next: { label: "Kiểm tra kết nối Chrome", hash: "health" } };
  }
  if (health.facebook_session !== "ok") {
    return { summary: "Facebook cần đăng nhập hoặc xác minh nên việc thu bài đang dừng.", next: { label: "Xử lý phiên Facebook", hash: "health" } };
  }
  if (health.crawl_paused) {
    return { summary: "Thu thập đang tạm dừng nên chưa có bài mới.", next: { label: "Xem lý do tạm dừng", hash: "health" } };
  }
  if (status.active_sources === 0) {
    return { summary: "Radar đang bật chưa theo dõi nhóm nào.", next: { label: "Chọn nhóm cho Radar", hash: "radars" } };
  }
  if (health.automatic_scanning === false) {
    return { summary: "Quét tự động đang tắt: DealSonar chỉ đọc bài khi bạn bấm Quét ngay.", next: { label: "Quét ngay trong Nguồn", hash: "sources" } };
  }
  if (health.automatic_scanning == null) {
    return { summary: "Chưa xác nhận được chế độ quét từ tiện ích Chrome.", next: { label: "Kiểm tra tiện ích Chrome", hash: "health" } };
  }
  return { summary: "Đã kết nối nhưng chưa có bài nào từ các nhóm đang theo dõi.", next: { label: "Quét ngay trong Nguồn", hash: "sources" } };
}

export function explainNoNews(
  status: FirstNewsStatus,
  health: HealthStatus | null,
  now: number = Date.now(),
): NewsFlowReport {
  const hasRadar = status.active_radars > 0;
  const collection = collectionProblem(status, health);
  const waiting = Math.max(status.waiting_ai, health?.pending_ai_posts ?? 0);
  const aiBroken = Boolean(health && health.ai_state !== "ok");
  const lastCrawl = health?.last_crawl_at ?? status.last_post_captured_at;

  const stages: FlowStage[] = [
    {
      id: "not_collected",
      title: "Chưa thu bài",
      active: hasRadar && status.posts_captured === 0,
      summary: hasRadar && status.posts_captured === 0 ? collection.summary : `Đã thu ${status.posts_captured.toLocaleString("vi-VN")} bài từ ${status.active_sources} nhóm.`,
      lastSuccessAt: lastCrawl ?? null,
      lastSuccess: lastSuccess(lastCrawl ?? null, "Chưa có lần thu bài thành công", now),
      next: hasRadar && status.posts_captured === 0 ? collection.next : null,
    },
    {
      id: "no_match",
      title: "Đã thu nhưng chưa khớp",
      active: hasRadar && status.evaluated_no_match > 0 && status.leads_total === 0,
      summary: status.evaluated_no_match > 0
        ? `Đã đọc ${status.evaluated_no_match.toLocaleString("vi-VN")} bài, ${status.leads_total ? `${status.leads_total} bài khớp.` : "chưa bài nào khớp."}`
        : "Chưa có bài nào được chấm xong.",
      lastSuccessAt: status.last_evaluated_at,
      lastSuccess: lastSuccess(status.last_evaluated_at, "Chưa chấm xong bài nào", now),
      next: hasRadar && status.evaluated_no_match > 0 && status.leads_total === 0
        ? { label: "Xem bài bị loại gần nhất", hash: "inbox" }
        : null,
    },
    {
      id: "waiting_ai",
      title: "Chờ AI",
      active: hasRadar && waiting > 0,
      summary: waiting > 0
        ? `${waiting.toLocaleString("vi-VN")} bài đang chờ AI${aiBroken ? `; AI đang ở trạng thái ${health!.ai_state}` : ""}.`
        : "Không có bài nào đang chờ AI.",
      lastSuccessAt: status.last_evaluated_at,
      lastSuccess: lastSuccess(status.last_evaluated_at, "Chưa có bài nào được AI hoặc bộ luật chấm xong", now),
      next: hasRadar && waiting > 0
        ? aiBroken ? { label: "Mở cấu hình AI", hash: "settings" } : { label: "Xem tiến độ xử lý", hash: "health" }
        : null,
    },
    {
      id: "delivery_failed",
      title: "Đã khớp nhưng gửi lỗi",
      active: status.delivery_failed > 0,
      summary: status.delivery_failed > 0
        ? `${status.delivery_failed} tin đã khớp chưa gửi được tới kênh nhận${status.last_delivery_error ? `: ${status.last_delivery_error}` : ""}. Tin vẫn xem được trong Cơ hội.`
        : "Không có tin nào gửi lỗi.",
      lastSuccessAt: status.last_delivery_at,
      lastSuccess: lastSuccess(status.last_delivery_at, "Chưa gửi được tin nào ra kênh nhận", now),
      next: status.delivery_failed > 0 ? { label: "Kiểm tra kênh nhận", hash: "settings/notifications" } : null,
    },
  ];

  const first = PRIORITY.map((id) => stages.find((stage) => stage.id === id)!).find((stage) => stage.active);
  if (!hasRadar && !first) {
    return { headline: "Chưa có Radar nào đang bật nên chưa thu bài.", tone: "info", primary: "no_radar", stages };
  }
  if (first) {
    const tone = first.id === "no_match" ? "info" : first.id === "waiting_ai" ? "warning" : "danger";
    return { headline: `${first.title}: ${first.summary}`, tone, primary: first.id, stages };
  }
  if (status.leads_total > 0) {
    return { headline: `Đã có ${status.leads_total} tin, gần nhất ${lastSuccess(status.last_lead_at, "", now)}.`, tone: "ok", primary: "has_leads", stages };
  }
  return { headline: "Đã thu bài, đang xử lý.", tone: "info", primary: "processing", stages };
}

export interface JourneyStep {
  id: "installed" | "source" | "radar_created" | "radar_active" | "first_post" | "first_lead" | "first_delivery";
  label: string;
  at: number | null;
  /** Milliseconds after install; `null` until reached. */
  sinceInstallMs: number | null;
  /** Milliseconds after the first Radar was created (only for steps that follow it). */
  sinceRadarCreatedMs: number | null;
}

/** Install time and Radar creation time are separate: each later step reports both gaps. */
export function journeySteps(status: FirstNewsStatus): JourneyStep[] {
  const created = status.first_radar_created_at;
  const step = (id: JourneyStep["id"], label: string, at: number | null, afterRadar: boolean): JourneyStep => ({
    id,
    label,
    at,
    sinceInstallMs: at == null ? null : Math.max(0, at - status.installed_at),
    sinceRadarCreatedMs: at == null || !afterRadar || created == null ? null : Math.max(0, at - created),
  });
  return [
    step("installed", status.installed_at_estimated ? "Cài đặt (ước tính từ dữ liệu cũ)" : "Mở DealSonar lần đầu", status.installed_at, false),
    step("source", "Kết nối nguồn đầu tiên", status.first_followed_source_at, false),
    step("radar_created", "Tạo Radar đầu tiên", created, false),
    step("radar_active", "Bật Radar đầu tiên", status.first_radar_activated_at, true),
    step("first_post", "Thu bài đầu tiên", status.first_post_captured_at, true),
    step("first_lead", "Nhận tin thật đầu tiên", status.first_lead_at, true),
    step("first_delivery", "Tin đầu tiên gửi tới kênh nhận", status.first_delivery_at, true),
  ];
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "dưới 1 phút";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ ${minutes % 60} phút`.replace(/ 0 phút$/, "");
  const days = Math.floor(hours / 24);
  return `${days} ngày ${hours % 24} giờ`.replace(/ 0 giờ$/, "");
}
