// Quick scan option controls.

import {
  type QuickScanOptions,
  DEFAULT_QUICK_SCAN_OPTIONS,
  isQuickScanOptions,
} from "../scan-options";
import type { PopupStatusSnapshot } from "../messages";
import type { SourceRef } from "../protocol";
import { byId, popupState } from "./state";

export function readScanOptions(): QuickScanOptions {
  return {
    mode: byId<HTMLSelectElement>("scan-mode").value as QuickScanOptions["mode"],
    maxPosts: byId<HTMLInputElement>("scan-max-posts").valueAsNumber,
    maxScrollSteps: byId<HTMLInputElement>("scan-max-scrolls").valueAsNumber,
  };
}

export function renderScanControls(status: PopupStatusSnapshot): void {
  if (!popupState.optionsLoaded) {
    const saved = status.scanOptions ?? DEFAULT_QUICK_SCAN_OPTIONS;
    byId<HTMLSelectElement>("scan-mode").value = saved.mode;
    byId<HTMLInputElement>("scan-max-posts").value = String(saved.maxPosts);
    byId<HTMLInputElement>("scan-max-scrolls").value = String(saved.maxScrollSteps);
    popupState.optionsLoaded = true;
  }
  const preferences = readScanOptions();
  const validOptions = isQuickScanOptions(preferences);
  const background = preferences.mode === "background";
  const select = byId<HTMLSelectElement>("scan-source");
  const previous = select.value;
  popupState.selectedSources = [];
  const options: HTMLOptionElement[] = [];
  const addSource = (source: SourceRef, label: string) => {
    if (popupState.selectedSources.some((s) => s.external_id === source.external_id)) return;
    popupState.selectedSources.push(source);
    options.push(new Option(label, source.external_id));
  };
  if (popupState.currentGroupCandidate) addSource(popupState.currentGroupCandidate, `Đang xem: ${popupState.currentGroupCandidate.name}`);
  for (const source of status.scanSources ?? []) addSource(source, `Nhóm: ${source.external_id}`);
  if (!options.length) options.push(new Option("Chưa có nhóm để quét", ""));
  const unchanged = select.options.length === options.length && options.every((option, index) =>
    select.options[index]?.value === option.value && select.options[index]?.text === option.text);
  if (!unchanged) select.replaceChildren(...options);
  if (popupState.selectedSources.some((source) => source.external_id === previous)) select.value = previous;
  const running = popupState.scanPending || Boolean(status.activeCrawl);
  select.disabled = running || !popupState.selectedSources.length;
  byId<HTMLSelectElement>("scan-mode").disabled = running || popupState.optionsSaving;
  byId<HTMLInputElement>("scan-max-posts").disabled = running || popupState.optionsSaving;
  byId<HTMLInputElement>("scan-max-scrolls").disabled = running || popupState.optionsSaving || !background;
  byId("scan-mode-help").textContent = background
    ? "Mở tab riêng, tự cuộn trong giới hạn rồi đóng khi xong."
    : "Đọc bài đã tải ở tab hiện tại, không tự cuộn trang.";
  byId("scan-options-summary").textContent = validOptions
    ? `${background ? "Tab nền" : "Tab hiện tại"}, ${preferences.maxPosts} bài${background ? `, ${preferences.maxScrollSteps} cuộn` : ""}`
    : "Kiểm tra giới hạn";
  const wrongTab = !background && (!popupState.currentGroupCandidate ||
    select.value.toLowerCase() !== popupState.currentGroupCandidate.external_id.toLowerCase());
  const button = byId<HTMLButtonElement>("btn-scan-now");
  button.disabled = running || popupState.optionsSaving || popupState.optionsUnsaved || !validOptions || wrongTab || !popupState.selectedSources.length || !status.connected || !status.desktopAvailable ||
    status.session.state !== "ok" || status.pause.paused || status.pause.requiresDesktopResume;
  button.textContent = running ? "Đang quét…" : "Quét ngay";
  button.setAttribute("aria-busy", String(running));
  byId("scan-scope").textContent = background
    ? `Tab nền, tối đa ${validOptions ? preferences.maxPosts : "—"} bài, ${preferences.maxScrollSteps} lần cuộn. Có thể dừng sớm.`
    : `Tab hiện tại, tối đa ${validOptions ? preferences.maxPosts : "—"} bài đã tải, không cuộn trang.`;
  byId("scan-feedback").textContent = running ? "Đang đọc bài viết. Bạn có thể tiếp tục duyệt web."
    : !status.connected || !status.desktopAvailable ? "Mở DealSonar Desktop để bắt đầu."
    : status.pause.paused || status.pause.requiresDesktopResume ? "Đang tạm dừng. Xem mục Tạm dừng & khôi phục."
    : status.session.state !== "ok" ? "Kiểm tra phiên Facebook ở phần Kết nối."
    : !popupState.selectedSources.length ? "Mở một nhóm Facebook để bắt đầu."
    : !validOptions ? "Số bài từ 1–100, số lần cuộn từ 0–5."
    : popupState.optionsSaving ? "Đang lưu tùy chọn…"
    : popupState.optionsUnsaved ? "Tùy chọn chưa lưu. Kiểm tra phần Tùy chọn quét."
    : wrongTab ? "Mở đúng nhóm đã chọn hoặc chuyển sang quét bằng tab nền."
    : "Sẵn sàng, không cần chờ lịch quét";
  byId<HTMLInputElement>("automatic-scanning").checked = status.automaticScanning ?? false;
  byId("stat-queued").textContent = `${status.queuedPostsCount} bài`;
  const result = byId("last-scan-result");
  result.classList.toggle("hidden", !status.lastScan);
  if (status.lastScan) {
    const scan = status.lastScan;
    const failed = scan.status === "error" || scan.status === "blocked";
    result.classList.toggle("err", failed);
    result.textContent = failed ? `Quét chưa thành công: ${scan.error || "Kiểm tra phiên Facebook và thử lại."}`
      : `Lượt gần nhất: ${scan.postsSeen} bài đã đọc, ${scan.postsNew} bài mới`;
  }
}
