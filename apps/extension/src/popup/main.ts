// Popup status UI (`03-ux-flows.md §4` & `02-extension.md §1, §7`).
// Strictly uses `textContent` (never `innerHTML`) per `03-risks-compliance.md §4`.

import { DEFAULT_QUICK_SCAN_OPTIONS, isQuickScanOptions, type QuickScanOptions } from "../scan-options";
import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import type { PageContextResponse, PopupScanResponse, PopupStatusSnapshot } from "../messages";
import type { SessionState, SourceInfo, SourceRef } from "../protocol";

const SESSION_BADGE_MAP: Record<
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

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing popup element #${id}`);
  return el as T;
}

let currentGroupCandidate: SourceInfo | null = null;
let latestStatus: PopupStatusSnapshot | null = null;
let scanPending = false;
let optionsLoaded = false;
let optionsSaving = false;
let optionsUnsaved = false;
let selectedSources: SourceRef[] = [];
let cleanupPanel: (() => void) | null = null;

export function disposePanel(): void {
  cleanupPanel?.();
  cleanupPanel = null;
}

function showError(error: unknown): void {
  const el = byId("panel-error");
  el.textContent = error instanceof Error ? error.message : String(error);
  el.classList.remove("hidden");
}

function readScanOptions(): QuickScanOptions {
  return {
    mode: byId<HTMLSelectElement>("scan-mode").value as QuickScanOptions["mode"],
    maxPosts: byId<HTMLInputElement>("scan-max-posts").valueAsNumber,
    maxScrollSteps: byId<HTMLInputElement>("scan-max-scrolls").valueAsNumber,
  };
}

function renderScanControls(status: PopupStatusSnapshot): void {
  if (!optionsLoaded) {
    const saved = status.scanOptions ?? DEFAULT_QUICK_SCAN_OPTIONS;
    byId<HTMLSelectElement>("scan-mode").value = saved.mode;
    byId<HTMLInputElement>("scan-max-posts").value = String(saved.maxPosts);
    byId<HTMLInputElement>("scan-max-scrolls").value = String(saved.maxScrollSteps);
    optionsLoaded = true;
  }
  const preferences = readScanOptions();
  const validOptions = isQuickScanOptions(preferences);
  const background = preferences.mode === "background";
  const select = byId<HTMLSelectElement>("scan-source");
  const previous = select.value;
  selectedSources = [];
  const options: HTMLOptionElement[] = [];
  const addSource = (source: SourceRef, label: string) => {
    if (selectedSources.some((s) => s.external_id === source.external_id)) return;
    selectedSources.push(source);
    options.push(new Option(label, source.external_id));
  };
  if (currentGroupCandidate) addSource(currentGroupCandidate, `Đang xem · ${currentGroupCandidate.name}`);
  for (const source of status.scanSources ?? []) addSource(source, `Nhóm · ${source.external_id}`);
  if (!options.length) options.push(new Option("Chưa có nhóm để quét", ""));
  const unchanged = select.options.length === options.length && options.every((option, index) =>
    select.options[index]?.value === option.value && select.options[index]?.text === option.text);
  if (!unchanged) select.replaceChildren(...options);
  if (selectedSources.some((source) => source.external_id === previous)) select.value = previous;
  const running = scanPending || Boolean(status.activeCrawl);
  select.disabled = running || !selectedSources.length;
  byId<HTMLSelectElement>("scan-mode").disabled = running || optionsSaving;
  byId<HTMLInputElement>("scan-max-posts").disabled = running || optionsSaving;
  byId<HTMLInputElement>("scan-max-scrolls").disabled = running || optionsSaving || !background;
  byId("scan-mode-help").textContent = background
    ? "Mở tab riêng, tự cuộn trong giới hạn rồi đóng khi xong."
    : "Đọc bài đã tải ở tab hiện tại, không tự cuộn trang.";
  byId("scan-options-summary").textContent = validOptions
    ? `${background ? "Tab nền" : "Tab hiện tại"} · ${preferences.maxPosts} bài${background ? ` · ${preferences.maxScrollSteps} cuộn` : ""}`
    : "Kiểm tra giới hạn";
  const wrongTab = !background && (!currentGroupCandidate ||
    select.value.toLowerCase() !== currentGroupCandidate.external_id.toLowerCase());
  const button = byId<HTMLButtonElement>("btn-scan-now");
  button.disabled = running || optionsSaving || optionsUnsaved || !validOptions || wrongTab || !selectedSources.length || !status.connected || !status.desktopAvailable ||
    status.session.state !== "ok" || status.pause.paused || status.pause.requiresDesktopResume;
  button.textContent = running ? "Đang quét…" : "Quét ngay";
  button.setAttribute("aria-busy", String(running));
  byId("scan-scope").textContent = background
    ? `Tab nền · tối đa ${validOptions ? preferences.maxPosts : "—"} bài, ${preferences.maxScrollSteps} lần cuộn. Có thể dừng sớm.`
    : `Tab hiện tại · tối đa ${validOptions ? preferences.maxPosts : "—"} bài đã tải, không cuộn trang.`;
  byId("scan-feedback").textContent = running ? "Đang đọc bài viết. Bạn có thể tiếp tục duyệt web."
    : !status.connected || !status.desktopAvailable ? "Mở DealSonar Desktop để bắt đầu."
    : status.pause.paused || status.pause.requiresDesktopResume ? "Đang tạm dừng · xem mục Tạm dừng & khôi phục."
    : status.session.state !== "ok" ? "Kiểm tra phiên Facebook ở phần Kết nối."
    : !selectedSources.length ? "Mở một nhóm Facebook để bắt đầu."
    : !validOptions ? "Số bài từ 1–100, số lần cuộn từ 0–5."
    : optionsSaving ? "Đang lưu tùy chọn…"
    : optionsUnsaved ? "Tùy chọn chưa lưu · kiểm tra phần Tùy chọn quét."
    : wrongTab ? "Mở đúng nhóm đã chọn hoặc chuyển sang quét bằng tab nền."
    : "Sẵn sàng · không cần chờ lịch quét";
  byId<HTMLInputElement>("automatic-scanning").checked = status.automaticScanning ?? false;
  byId("stat-queued").textContent = `${status.queuedPostsCount} bài`;
  const result = byId("last-scan-result");
  result.classList.toggle("hidden", !status.lastScan);
  if (status.lastScan) {
    const scan = status.lastScan;
    const failed = scan.status === "error" || scan.status === "blocked";
    result.classList.toggle("err", failed);
    result.textContent = failed ? `Quét chưa thành công: ${scan.error || "Kiểm tra phiên Facebook và thử lại."}`
      : `Lượt gần nhất · ${scan.postsSeen} bài đã đọc · ${scan.postsNew} bài mới`;
  }
}

function isGroupAlreadyFollowed(
  group: SourceInfo,
  slugFromUrl: string | null,
  followedIds: readonly string[],
): boolean {
  const lowerSet = new Set(followedIds.map((id) => id.toLowerCase()));
  if (lowerSet.has(group.external_id.toLowerCase())) return true;
  if (slugFromUrl && lowerSet.has(slugFromUrl.toLowerCase())) return true;
  return false;
}

function renderGroupContext(
  group: SourceInfo | null,
  slugFromUrl: string | null,
  status: PopupStatusSnapshot,
): void {
  const card = byId("group-context-card");
  if (!group) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  byId("group-context-name").textContent = group.name;

  const metaParts: string[] = [];
  if (group.privacy === "public") metaParts.push("Nhóm công khai");
  if (group.privacy === "private") metaParts.push("Nhóm riêng tư");
  if (group.member_count !== undefined) {
    metaParts.push(`${group.member_count.toLocaleString("vi-VN")} thành viên`);
  }
  if (metaParts.length === 0) {
    metaParts.push(`ID: ${group.external_id}`);
  }
  byId("group-context-meta").textContent = metaParts.join(" · ");

  const alreadyFollowed = isGroupAlreadyFollowed(
    group,
    slugFromUrl,
    status.followedExternalIds,
  );
  const followBtn = byId<HTMLButtonElement>("btn-follow-group");
  const followedBadge = byId("badge-following-group");

  if (alreadyFollowed) {
    followBtn.classList.add("hidden");
    followedBadge.classList.remove("hidden");
  } else {
    followBtn.classList.remove("hidden");
    followedBadge.classList.add("hidden");
  }
}

function renderStatus(status: PopupStatusSnapshot): void {
  latestStatus = status;
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
        `ID tiện ích chưa được ghép nối với ứng dụng Desktop${extIdSuffix}. Hãy mở DealSonar → bấm «Kiểm tra lại» (hoặc dán ID trên vào mục Kết nối Chrome), rồi bấm «Thử lại».`;
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
    : "Đã tắt · chỉ quét khi bạn yêu cầu";
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
        "Đã khoá an toàn do cần xác minh — hãy bấm Tiếp tục trong app DealSonar.";
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
  if (currentGroupCandidate) {
    const slug = extractGroupSlugOrIdFromUrl(currentGroupCandidate.url);
    renderGroupContext(currentGroupCandidate, slug, status);
  }
}

async function detectActiveTabGroup(): Promise<{
  group: SourceInfo | null;
  slug: string | null;
}> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return { group: null, slug: null };
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab?.url) return { group: null, slug: null };

    const slug = extractGroupSlugOrIdFromUrl(activeTab.url);
    if (!slug) return { group: null, slug: null };

    if (activeTab.id !== undefined) {
      try {
        const ctx = (await chrome.tabs.sendMessage(activeTab.id, {
          kind: "dealsonar:get-page-context",
        })) as PageContextResponse | undefined;
        if (ctx?.groupInfo) {
          return { group: ctx.groupInfo, slug };
        }
      } catch {
        // Content script not yet injected on pre-existing tab; fall back to tab metadata
      }
    }

    const cleanedTitle = (activeTab.title ?? "")
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*[|–-]\s*Facebook\s*$/i, "")
      .trim();

    return {
      slug,
      group: {
        platform: "facebook",
        kind: "group",
        external_id: slug,
        name: cleanedTitle || `Nhóm ${slug}`,
        url: `https://www.facebook.com/groups/${encodeURIComponent(slug)}/`,
      },
    };
  } catch {
    return { group: null, slug: null };
  }
}

export async function initPopup(): Promise<void> {
  disposePanel();
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  currentGroupCandidate = null;
  latestStatus = null;
  scanPending = false;
  optionsLoaded = false;
  optionsSaving = false;
  optionsUnsaved = false;
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
    renderGroupContext(currentGroupCandidate, currentGroupCandidate ? extractGroupSlugOrIdFromUrl(currentGroupCandidate.url) : null, response);
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
      currentGroupCandidate = context.group;
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
    if (!currentGroupCandidate) return;
    const button = byId<HTMLButtonElement>("btn-follow-group");
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ kind: "popup:follow-group", group: currentGroupCandidate });
      if (!response?.ok) throw new Error(response?.error || "Chưa thể theo dõi nhóm. Hãy thử lại.");
      renderResponse(response.status);
    } finally { button.disabled = false; }
  });
  let saveOptionsTimer: ReturnType<typeof setTimeout> | undefined;
  const saveScanOptions = async () => {
    clearTimeout(saveOptionsTimer);
    if (!optionsUnsaved || optionsSaving) return;
    const options = readScanOptions();
    if (!isQuickScanOptions(options)) {
      byId("scan-options-feedback").textContent = "Chưa lưu · số bài 1–100, số lần cuộn 0–5, dùng số nguyên.";
      if (latestStatus) renderScanControls(latestStatus);
      return;
    }
    optionsSaving = true;
    byId("scan-options-feedback").textContent = "Đang lưu…";
    if (latestStatus) renderScanControls(latestStatus);
    try {
      const status = await chrome.runtime.sendMessage({ kind: "popup:set-scan-options", options });
      if (disposed) return;
      renderResponse(status);
      optionsUnsaved = false;
      byId("scan-options-feedback").textContent = "Đã lưu · áp dụng cho những lần quét sau.";
    } catch (error) {
      if (disposed) return;
      byId("scan-options-feedback").textContent = "Chưa lưu được. Hãy thay đổi tùy chọn để thử lại.";
      throw error;
    } finally {
      optionsSaving = false;
      if (!disposed && latestStatus) renderScanControls(latestStatus);
    }
  };
  for (const id of ["scan-mode", "scan-max-posts", "scan-max-scrolls"]) {
    bind(id, "input", () => {
      optionsUnsaved = true;
      byId("scan-options-feedback").textContent = "Đang chỉnh… tự lưu sau khi nhập.";
      if (latestStatus) renderScanControls(latestStatus);
      clearTimeout(saveOptionsTimer);
      saveOptionsTimer = setTimeout(() => { void saveScanOptions().catch(showError); }, 400);
    });
    bind(id, "change", async () => {
      optionsUnsaved = true;
      await saveScanOptions();
    });
  }
  bind("scan-source", "change", () => { if (latestStatus) renderScanControls(latestStatus); });
  bind("automatic-scanning", "change", async () => {
    const toggle = byId<HTMLInputElement>("automatic-scanning");
    toggle.disabled = true;
    try {
      renderResponse(await chrome.runtime.sendMessage({ kind: "popup:set-automatic", enabled: toggle.checked }));
    } catch (error) {
      toggle.checked = latestStatus?.automaticScanning ?? false;
      throw error;
    } finally { toggle.disabled = false; }
  });
  bind("btn-scan-now", "click", async () => {
    const source = selectedSources.find((s) => s.external_id === byId<HTMLSelectElement>("scan-source").value);
    if (!source || scanPending || optionsSaving || optionsUnsaved || !isQuickScanOptions(readScanOptions())) return;
    scanPending = true;
    if (latestStatus) renderScanControls(latestStatus);
    try {
      const response = await chrome.runtime.sendMessage({ kind: "popup:scan-now", source, options: readScanOptions() }) as PopupScanResponse;
      if (response.status) renderResponse(response.status);
      if (!response.ok) throw new Error(response.error || "Chưa thể quét. Vui lòng thử lại.");
    } finally {
      scanPending = false;
      if (latestStatus) renderScanControls(latestStatus);
    }
  });
  const onTabChanged = () => { void refresh().catch(showError); };
  chrome.tabs.onActivated?.addListener(onTabChanged);
  chrome.tabs.onUpdated?.addListener(onTabChanged);
  const timer = setInterval(onTabChanged, 2500);
  cleanupPanel = () => {
    // Flush valid edits if the panel closes before the debounce fires.
    if (optionsUnsaved && !optionsSaving) {
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
