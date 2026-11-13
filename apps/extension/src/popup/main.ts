// Popup status UI (`03-ux-flows.md §4` & `02-extension.md §1, §7`).
// Strictly uses `textContent` (never `innerHTML`) per `03-risks-compliance.md §4`.

import type { PopupStatusSnapshot, PopupScanResponse } from "../messages";
import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import { isQuickScanOptions } from "../scan-options";
import { detectActiveTabGroup, renderGroupContext } from "./group-context";
import { readScanOptions, renderScanControls } from "./scan-controls";
import { byId, popupState, showError } from "./state";
import { renderStatus } from "./status";

export function disposePanel(): void {
  popupState.cleanupPanel?.();
  popupState.cleanupPanel = null;
}

export async function initPopup(): Promise<void> {
  disposePanel();
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  popupState.currentGroupCandidate = null;
  popupState.latestStatus = null;
  popupState.scanPending = false;
  popupState.optionsLoaded = false;
  popupState.optionsSaving = false;
  popupState.optionsUnsaved = false;
  let disposed = false;
  let refreshing = false;
  const removers: (() => void)[] = [];
  const bind = (id: string, event: string, action: () => void | Promise<void>) => {
    const element = byId(id);
    const handler = () => {
      byId("panel-error").classList.add("hidden");
      void Promise.resolve().then(action).catch(showError);
    };
    element.addEventListener(event, handler);
    removers.push(() => element.removeEventListener(event, handler));
  };
  const renderResponse = (response: PopupStatusSnapshot & { error?: string }) => {
    if (response.error) throw new Error(response.error);
    renderStatus(response);
    renderGroupContext(popupState.currentGroupCandidate, popupState.currentGroupCandidate ? extractGroupSlugOrIdFromUrl(popupState.currentGroupCandidate.url) : null, response);
  };
  const refresh = async () => {
    if (refreshing || disposed) return;
    refreshing = true;
    try {
      const [context, status] = await Promise.all([
        detectActiveTabGroup(),
        chrome.runtime.sendMessage({ kind: "popup:get-status" }) as Promise<PopupStatusSnapshot>,
      ]);
      if (disposed) return;
      popupState.currentGroupCandidate = context.group;
      renderResponse(status);
    } finally { refreshing = false; }
  };
  try {
    byId("ext-version").textContent = `v${chrome.runtime.getManifest().version}`;
    await refresh();
  } catch (error) { showError(error); }

  const reconnect = async () => {
    const status = await chrome.runtime.sendMessage({ kind: "popup:reconnect" });
    renderResponse(status);
  };
  bind("btn-reconnect", "click", reconnect);
  bind("btn-open-desktop", "click", reconnect);
  bind("btn-open-fb", "click", async () => { await chrome.tabs.create({ url: "https://www.facebook.com/" }); });
  bind("btn-pause-1h", "click", async () => {
    renderResponse(await chrome.runtime.sendMessage({ kind: "popup:pause", durationMs: 60 * 60 * 1000 }));
  });
  bind("btn-pause-indef", "click", async () => {
    renderResponse(await chrome.runtime.sendMessage({ kind: "popup:pause", durationMs: null }));
  });
  bind("btn-resume", "click", async () => {
    renderResponse(await chrome.runtime.sendMessage({ kind: "popup:resume" }));
  });
  bind("btn-follow-group", "click", async () => {
    if (!popupState.currentGroupCandidate) return;
    const button = byId<HTMLButtonElement>("btn-follow-group");
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ kind: "popup:follow-group", group: popupState.currentGroupCandidate });
      if (!response?.ok) throw new Error(response?.error || "Chưa thể theo dõi nhóm. Hãy thử lại.");
      renderResponse(response.status);
    } finally { button.disabled = false; }
  });
  let saveOptionsTimer: ReturnType<typeof setTimeout> | undefined;
  const saveScanOptions = async () => {
    clearTimeout(saveOptionsTimer);
    if (!popupState.optionsUnsaved || popupState.optionsSaving) return;
    const options = readScanOptions();
    if (!isQuickScanOptions(options)) {
      byId("scan-options-feedback").textContent = "Chưa lưu: số bài từ 1 đến 100, số lần cuộn từ 0 đến 5, dùng số nguyên.";
      if (popupState.latestStatus) renderScanControls(popupState.latestStatus);
      return;
    }
    popupState.optionsSaving = true;
    byId("scan-options-feedback").textContent = "Đang lưu…";
    if (popupState.latestStatus) renderScanControls(popupState.latestStatus);
    try {
      const status = await chrome.runtime.sendMessage({ kind: "popup:set-scan-options", options });
      if (disposed) return;
      renderResponse(status);
      popupState.optionsUnsaved = false;
      byId("scan-options-feedback").textContent = "Đã lưu, áp dụng cho những lần quét sau.";
    } catch (error) {
      if (disposed) return;
      byId("scan-options-feedback").textContent = "Chưa lưu được. Hãy thay đổi tùy chọn để thử lại.";
      throw error;
    } finally {
      popupState.optionsSaving = false;
      if (!disposed && popupState.latestStatus) renderScanControls(popupState.latestStatus);
    }
  };
  for (const id of ["scan-mode", "scan-max-posts", "scan-max-scrolls"]) {
    bind(id, "input", () => {
      popupState.optionsUnsaved = true;
      byId("scan-options-feedback").textContent = "Đang chỉnh… tự lưu sau khi nhập.";
      if (popupState.latestStatus) renderScanControls(popupState.latestStatus);
      clearTimeout(saveOptionsTimer);
      saveOptionsTimer = setTimeout(() => { void saveScanOptions().catch(showError); }, 400);
    });
    bind(id, "change", async () => {
      popupState.optionsUnsaved = true;
      await saveScanOptions();
    });
  }
  bind("scan-source", "change", () => { if (popupState.latestStatus) renderScanControls(popupState.latestStatus); });
  bind("automatic-scanning", "change", async () => {
    const toggle = byId<HTMLInputElement>("automatic-scanning");
    toggle.disabled = true;
    try {
      renderResponse(await chrome.runtime.sendMessage({ kind: "popup:set-automatic", enabled: toggle.checked }));
    } catch (error) {
      toggle.checked = popupState.latestStatus?.automaticScanning ?? false;
      throw error;
    } finally { toggle.disabled = false; }
  });
  bind("btn-scan-now", "click", async () => {
    const source = popupState.selectedSources.find((s) => s.external_id === byId<HTMLSelectElement>("scan-source").value);
    if (!source || popupState.scanPending || popupState.optionsSaving || popupState.optionsUnsaved || !isQuickScanOptions(readScanOptions())) return;
    popupState.scanPending = true;
    if (popupState.latestStatus) renderScanControls(popupState.latestStatus);
    try {
      const response = await chrome.runtime.sendMessage({ kind: "popup:scan-now", source, options: readScanOptions() }) as PopupScanResponse;
      if (response.status) renderResponse(response.status);
      if (!response.ok) throw new Error(response.error || "Chưa thể quét. Vui lòng thử lại.");
    } finally {
      popupState.scanPending = false;
      if (popupState.latestStatus) renderScanControls(popupState.latestStatus);
    }
  });
  const onTabChanged = () => { void refresh().catch(showError); };
  chrome.tabs.onActivated?.addListener(onTabChanged);
  chrome.tabs.onUpdated?.addListener(onTabChanged);
  const timer = setInterval(onTabChanged, 2500);
  popupState.cleanupPanel = () => {
    // Flush valid edits if the panel closes before the debounce fires.
    if (popupState.optionsUnsaved && !popupState.optionsSaving) {
      const options = readScanOptions();
      if (isQuickScanOptions(options)) {
        void chrome.runtime.sendMessage({ kind: "popup:set-scan-options", options }).catch(() => {});
      }
    }
    disposed = true;
    clearInterval(timer);
    clearTimeout(saveOptionsTimer);
    chrome.tabs.onActivated?.removeListener(onTabChanged);
    chrome.tabs.onUpdated?.removeListener(onTabChanged);
    for (const remove of removers) remove();
    window.removeEventListener("pagehide", disposePanel);
  };
  window.addEventListener("pagehide", disposePanel, { once: true });
}

if (typeof document !== "undefined" && document.getElementById("desktop-lamp")) {
  void initPopup().catch(showError);
}

export { formatRelativeVietnameseTime } from "./format";
