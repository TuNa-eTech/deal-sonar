// Popup status UI (`03-ux-flows.md §4` & `02-extension.md §1, §7`).
// Strictly uses `textContent` (never `innerHTML`) per `03-risks-compliance.md §4`.

import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import type { PageContextResponse, PopupStatusSnapshot } from "../messages";
import type { SessionState, SourceInfo } from "../protocol";

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
    desktopHelpMsg.textContent =
      status.connectionError &&
      status.connectionError.includes("không khớp")
        ? status.connectionError
        : "Ứng dụng DealSonar trên máy tính đang tắt hoặc chưa kết nối. Hãy mở DealSonar rồi bấm Thử lại.";
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
    : formatRelativeVietnameseTime(status.nextCrawlAt, now, "future");
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
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  try {
    const ver = chrome.runtime.getManifest().version;
    if (ver) byId("ext-version").textContent = `v${ver}`;
  } catch {
    // Ignore
  }

  const [{ group, slug }, status] = await Promise.all([
    detectActiveTabGroup(),
    chrome.runtime.sendMessage({ kind: "popup:get-status" }) as Promise<PopupStatusSnapshot>,
  ]);

  currentGroupCandidate = group;
  if (status) {
    renderStatus(status);
    renderGroupContext(group, slug, status);
  }

  byId("btn-reconnect").addEventListener("click", async () => {
    const btn = byId<HTMLButtonElement>("btn-reconnect");
    btn.disabled = true;
    try {
      const next = (await chrome.runtime.sendMessage({
        kind: "popup:reconnect",
      })) as PopupStatusSnapshot;
      renderStatus(next);
    } finally {
      btn.disabled = false;
    }
  });

  byId("btn-open-desktop").addEventListener("click", async () => {
    const btn = byId<HTMLButtonElement>("btn-open-desktop");
    btn.disabled = true;
    try {
      const next = (await chrome.runtime.sendMessage({
        kind: "popup:reconnect",
      })) as PopupStatusSnapshot;
      renderStatus(next);
    } finally {
      btn.disabled = false;
    }
  });

  byId("btn-open-fb").addEventListener("click", () => {
    void chrome.tabs.create({ url: "https://www.facebook.com/" });
  });

  byId("btn-pause-1h").addEventListener("click", async () => {
    const next = (await chrome.runtime.sendMessage({
      kind: "popup:pause",
      durationMs: 60 * 60 * 1000,
    })) as PopupStatusSnapshot;
    renderStatus(next);
  });

  byId("btn-pause-indef").addEventListener("click", async () => {
    const next = (await chrome.runtime.sendMessage({
      kind: "popup:pause",
      durationMs: null,
    })) as PopupStatusSnapshot;
    renderStatus(next);
  });

  byId("btn-resume").addEventListener("click", async () => {
    const next = (await chrome.runtime.sendMessage({
      kind: "popup:resume",
    })) as PopupStatusSnapshot;
    renderStatus(next);
  });

  byId("btn-follow-group").addEventListener("click", async () => {
    if (!currentGroupCandidate) return;
    const btn = byId<HTMLButtonElement>("btn-follow-group");
    btn.disabled = true;
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: "popup:follow-group",
        group: currentGroupCandidate,
      })) as { ok: boolean; status: PopupStatusSnapshot };
      if (res?.status) {
        renderStatus(res.status);
      } else if (latestStatus) {
        renderStatus(latestStatus);
      }
    } finally {
      btn.disabled = false;
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("desktop-lamp")) {
  void initPopup();
}
