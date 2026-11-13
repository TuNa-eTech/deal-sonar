// Connection, session, and scan status rendering.

import type { PopupStatusSnapshot } from "../messages";
import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import { formatRelativeVietnameseTime, SESSION_BADGE_MAP } from "./format";
import { renderGroupContext } from "./group-context";
import { renderScanControls } from "./scan-controls";
import { byId, popupState } from "./state";

export function renderStatus(status: PopupStatusSnapshot): void {
  popupState.latestStatus = status;
  const now = Date.now();

  renderScanControls(status);

  // 1. Desktop connection lamp & status
  const lamp = byId("desktop-lamp");
  const statusText = byId("desktop-status-text");
  const desktopHelp = byId("desktop-help");
  const desktopHelpMsg = byId("desktop-help-msg");

  const isHealthyDesktop = status.connected && status.desktopAvailable;
  lamp.className = `lamp ${isHealthyDesktop ? "ok" : "err"}`;

  if (isHealthyDesktop) {
    statusText.textContent = status.desktopVersion
      ? `Đã kết nối (v${status.desktopVersion})`
      : "Đã kết nối";
    desktopHelp.classList.add("hidden");
  } else {
    statusText.textContent = "Mất kết nối";
    desktopHelp.classList.remove("hidden");
    const errLower = (status.connectionError ?? "").toLowerCase();
    const extIdSuffix = status.extensionId ? ` (ID tiện ích: ${status.extensionId})` : "";
    if (status.connectionError && status.connectionError.includes("không khớp")) {
      desktopHelpMsg.textContent = status.connectionError;
    } else if (errLower.includes("forbidden")) {
      desktopHelpMsg.textContent =
        `ID tiện ích chưa được ghép nối với ứng dụng Desktop${extIdSuffix}. Hãy mở DealSonar, bấm «Kiểm tra lại» (hoặc dán ID trên vào mục Kết nối Chrome), rồi bấm «Thử lại».`;
    } else if (errLower.includes("not found")) {
      desktopHelpMsg.textContent =
        `Chưa tìm thấy cầu nối Native Host${extIdSuffix}. Hãy mở ứng dụng DealSonar trên máy tính trước, rồi bấm «Thử lại».`;
    } else {
      desktopHelpMsg.textContent =
        `Ứng dụng DealSonar trên máy tính đang tắt hoặc chưa kết nối${extIdSuffix}. Hãy mở DealSonar rồi bấm Thử lại.`;
    }
  }

  // 2. Facebook session badge
  const fbMeta = SESSION_BADGE_MAP[status.session.state] ?? SESSION_BADGE_MAP.unknown;
  const fbBadge = byId("fb-session-badge");
  fbBadge.textContent = fbMeta.label;
  fbBadge.className = `badge ${fbMeta.cssClass}`;

  const fbHelp = byId("fb-session-help");
  const fbActions = byId("fb-session-actions");
  if (fbMeta.help) {
    fbHelp.classList.remove("hidden");
    byId("fb-session-msg").textContent = fbMeta.help;
    if (fbMeta.showOpenFb) {
      fbActions.classList.remove("hidden");
    } else {
      fbActions.classList.add("hidden");
    }
  } else {
    fbHelp.classList.add("hidden");
  }

  // 3. Crawl stats
  byId("stat-last-crawl").textContent = formatRelativeVietnameseTime(
    status.lastCrawlAt,
    now,
    "past",
  );
  byId("stat-next-crawl").textContent = status.pause.paused
    ? "Đang tạm dừng"
    : status.automaticScanning ? formatRelativeVietnameseTime(status.nextCrawlAt, now, "future")
    : "Đã tắt, chỉ quét khi bạn yêu cầu";
  byId("stat-groups-count").textContent = `${status.followedGroupsCount} nhóm`;
  byId("stat-hourly-loads").textContent = `${status.loadsLastHour} / ${status.maxLoadsPerHour}`;

  // 4. Pause / Resume controls
  const pauseLabel = byId("pause-status-label");
  const activeCtrls = byId("pause-active-controls");
  const resumedCtrls = byId("pause-resumed-controls");
  const resumeBtn = byId<HTMLButtonElement>("btn-resume");

  if (status.pause.paused) {
    activeCtrls.classList.add("hidden");
    resumedCtrls.classList.remove("hidden");

    if (status.pause.requiresDesktopResume) {
      pauseLabel.textContent =
        "Đã khoá an toàn do cần xác minh. Hãy bấm Tiếp tục trong app DealSonar.";
      resumeBtn.disabled = true;
    } else if (status.pause.until !== null) {
      const untilTime = new Date(status.pause.until).toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      pauseLabel.textContent = `Đang tạm dừng quét tới ${untilTime}`;
      resumeBtn.disabled = false;
    } else {
      pauseLabel.textContent = "Đang tạm dừng quét cho tới khi bật lại";
      resumeBtn.disabled = false;
    }
  } else {
    pauseLabel.textContent = "Tạm dừng quét";
    activeCtrls.classList.remove("hidden");
    resumedCtrls.classList.add("hidden");
  }

  // 5. Re-render active group action if applicable
  if (popupState.currentGroupCandidate) {
    const slug = extractGroupSlugOrIdFromUrl(popupState.currentGroupCandidate.url);
    renderGroupContext(popupState.currentGroupCandidate, slug, status);
  }
}
