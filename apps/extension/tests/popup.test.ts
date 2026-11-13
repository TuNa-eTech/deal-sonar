import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PopupStatusSnapshot, RuntimeMessage } from "../src/messages";
import { disposePanel, initPopup } from "../src/popup/main";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const popupHtml = readFileSync(resolve(rootDir, "src/popup/index.html"), "utf-8");

describe("Popup UI (`03-ux-flows.md §4`)", () => {
  afterEach(() => {
    disposePanel();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders Vietnamese connection lamp, Facebook session badges, pause controls, and `Theo dõi group này` -> `Đang theo dõi ✓`", async () => {
    const parsed = new DOMParser().parseFromString(popupHtml, "text/html");
    document.body.innerHTML = parsed.body.innerHTML;

    const now = Date.now();
    let currentStatus: PopupStatusSnapshot = {
      connected: false,
      desktopAvailable: false,
      connectionError: "DealSonar Desktop chưa mở",
      session: { state: "ok", updatedAt: now },
      lastCrawlAt: now - 5 * 60_000,
      nextCrawlAt: now + 10 * 60_000,
      followedGroupsCount: 2,
      followedExternalIds: ["111", "222"],
      loadsLastHour: 8,
      maxLoadsPerHour: 60,
      pause: {
        paused: false,
        until: null,
        reason: null,
        requiresDesktopResume: false,
      },
      queuedPostsCount: 0,
    };

    const sentRuntimeMessages: RuntimeMessage[] = [];

    const chromeMock = {
      runtime: {
        getManifest: () => ({ version: "0.2.0" }),
        sendMessage: vi.fn(async (msg: RuntimeMessage) => {
          sentRuntimeMessages.push(msg);
          if (msg.kind === "popup:get-status") {
            return currentStatus;
          }
          if (msg.kind === "popup:reconnect") {
            currentStatus = {
              ...currentStatus,
              connected: true,
              desktopAvailable: true,
              desktopVersion: "0.2.0",
            };
            return currentStatus;
          }
          if (msg.kind === "popup:pause") {
            currentStatus = {
              ...currentStatus,
              pause: {
                paused: true,
                until: msg.durationMs ? now + msg.durationMs : null,
                reason: "user_popup",
                requiresDesktopResume: false,
              },
            };
            return currentStatus;
          }
          if (msg.kind === "popup:resume") {
            currentStatus = {
              ...currentStatus,
              pause: {
                paused: false,
                until: null,
                reason: null,
                requiresDesktopResume: false,
              },
            };
            return currentStatus;
          }
          if (msg.kind === "popup:follow-group") {
            currentStatus = {
              ...currentStatus,
              followedGroupsCount: currentStatus.followedGroupsCount + 1,
              followedExternalIds: [
                ...currentStatus.followedExternalIds,
                msg.group.external_id,
              ],
            };
            return { ok: true, status: currentStatus };
          }
          return currentStatus;
        }),
      },
      tabs: {
        query: vi.fn(async () => [
          {
            id: 42,
            url: "https://www.facebook.com/groups/thuechungcuhanoi/",
            title: "Thuê Chung Cư Hà Nội | Facebook",
          },
        ]),
        sendMessage: vi.fn(async () => ({
          url: "https://www.facebook.com/groups/thuechungcuhanoi/",
          session: { state: "ok" },
          groupInfo: {
            platform: "facebook",
            kind: "group",
            external_id: "thuechungcuhanoi",
            name: "Thuê Chung Cư Hà Nội",
            url: "https://www.facebook.com/groups/thuechungcuhanoi/",
            privacy: "private",
            member_count: 125400,
          },
        })),
        create: vi.fn(),
      },
    };

    vi.stubGlobal("chrome", chromeMock);

    await initPopup();

    // 1. Disconnected state initially visible with retry guidance
    expect(document.getElementById("desktop-status-text")?.textContent).toBe("Mất kết nối");
    expect(document.getElementById("desktop-help")?.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("fb-session-badge")?.textContent).toBe("Đang hoạt động");
    expect(document.getElementById("stat-groups-count")?.textContent).toBe("2 nhóm");
    expect(document.getElementById("stat-hourly-loads")?.textContent).toBe("8 / 60");

    // 2. Active tab is an unfollowed group -> "Theo dõi group này" visible
    const followBtn = document.getElementById("btn-follow-group") as HTMLButtonElement;
    const followedBadge = document.getElementById("badge-following-group")!;
    expect(followBtn.classList.contains("hidden")).toBe(false);
    expect(followedBadge.classList.contains("hidden")).toBe(true);

    // Click "Theo dõi group này" -> sends follow-group & transitions to "Đang theo dõi ✓"
    followBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sentRuntimeMessages.some((m) => m.kind === "popup:follow-group")).toBe(true);
    expect(followBtn.classList.contains("hidden")).toBe(true);
    expect(followedBadge.classList.contains("hidden")).toBe(false);
    expect(followedBadge.textContent?.trim()).toBe("Đang theo dõi ✓");
    expect(document.getElementById("stat-groups-count")?.textContent).toBe("3 nhóm");

    // 3. Reconnect button -> switches lamp to connected
    (document.getElementById("btn-reconnect") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById("desktop-status-text")?.textContent).toContain("Đã kết nối");
    expect(document.getElementById("desktop-help")?.classList.contains("hidden")).toBe(true);

    // 4. Pause 1h -> shows "Tiếp tục quét" -> clicking resumes
    (document.getElementById("btn-pause-1h") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(
      document.getElementById("pause-resumed-controls")?.classList.contains("hidden"),
    ).toBe(false);
    expect(document.getElementById("stat-next-crawl")?.textContent).toBe("Đang tạm dừng");

    (document.getElementById("btn-resume") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(
      document.getElementById("pause-active-controls")?.classList.contains("hidden"),
    ).toBe(false);
  });
  it("scans the selected group, prevents repeat clicks, shows results, and handles mode changes and errors", async () => {
    document.body.innerHTML = new DOMParser().parseFromString(popupHtml, "text/html").body.innerHTML;
    const status: PopupStatusSnapshot = {
      connected: true, desktopAvailable: true,
      session: { state: "ok", updatedAt: Date.now() },
      lastCrawlAt: null, nextCrawlAt: null, followedGroupsCount: 1,
      followedExternalIds: ["123"], loadsLastHour: 0, maxLoadsPerHour: 60,
      pause: { paused: false, until: null, reason: null, requiresDesktopResume: false },
      queuedPostsCount: 0, automaticScanning: false,
      scanOptions: { mode: "background", maxPosts: 30, maxScrollSteps: 3 },
      scanSources: [{ platform: "facebook", kind: "group", external_id: "123" }],
    };
    let finish!: (value: unknown) => void;
    const sendMessage = vi.fn(async (message) => {
      if (message.kind === "popup:scan-now") return new Promise((resolve) => { finish = resolve; });
      if (message.kind === "popup:set-automatic") return { ...status, automaticScanning: message.enabled };
      return status;
    });
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "0.2.0" }), sendMessage },
      tabs: { query: async () => [] },
    });
    await initPopup();
    const scan = document.getElementById("btn-scan-now") as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
    scan.click();
    await vi.waitFor(() => expect(scan.disabled).toBe(true));
    scan.click();
    expect(sendMessage.mock.calls.filter(([m]) => m.kind === "popup:scan-now")).toHaveLength(1);
    finish({ ok: true, status: { ...status, lastScan: { sourceExternalId: "123", status: "ok", postsSeen: 8, postsNew: 3, endedAt: Date.now() } } });
    await vi.waitFor(() => expect(scan.disabled).toBe(false));
    expect(document.getElementById("last-scan-result")?.textContent).toContain("3 bài mới");
    const toggle = document.getElementById("automatic-scanning") as HTMLInputElement;
    toggle.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ kind: "popup:set-automatic", enabled: true }));
    expect(toggle.checked).toBe(true);
    scan.click();
    await vi.waitFor(() => expect(scan.disabled).toBe(true));
    finish({ ok: false, error: "Đã đạt giới hạn tải trang", status });
    await vi.waitFor(() => expect(document.getElementById("panel-error")?.textContent).toContain("Đã đạt giới hạn"));
    expect(scan.disabled).toBe(false);
  });

  it("updates the current group when switching tabs and removes stale group context", async () => {
    document.body.innerHTML = new DOMParser().parseFromString(popupHtml, "text/html").body.innerHTML;
    let activeUrl = "https://www.facebook.com/groups/first/";
    let activate!: () => void;
    const status: PopupStatusSnapshot = {
      connected: true, desktopAvailable: true, session: { state: "ok", updatedAt: Date.now() },
      lastCrawlAt: null, nextCrawlAt: null, followedGroupsCount: 0, followedExternalIds: [],
      loadsLastHour: 0, maxLoadsPerHour: 60, queuedPostsCount: 0,
      pause: { paused: false, until: null, reason: null, requiresDesktopResume: false },
    };
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "0.2.0" }), sendMessage: async () => status },
      tabs: {
        query: async () => [{ id: 42, url: activeUrl }],
        sendMessage: async () => undefined,
        onActivated: { addListener: (listener: () => void) => { activate = listener; }, removeListener: vi.fn() },
      },
    });
    await initPopup();
    expect((document.getElementById("scan-source") as HTMLSelectElement).value).toBe("first");
    activeUrl = "https://www.facebook.com/groups/second/";
    activate();
    await vi.waitFor(() => expect((document.getElementById("scan-source") as HTMLSelectElement).value).toBe("second"));
    activeUrl = "https://example.com/";
    activate();
    await vi.waitFor(() => expect(document.getElementById("group-context-card")?.classList.contains("hidden")).toBe(true));
    expect((document.getElementById("btn-scan-now") as HTMLButtonElement).disabled).toBe(true);
  });

  it("auto-saves options, restores them on reopening and keeps scroll limits only for background mode", async () => {
    const mount = () => {
      document.body.innerHTML = new DOMParser().parseFromString(popupHtml, "text/html").body.innerHTML;
    };
    mount();
    const status: PopupStatusSnapshot = {
      connected: true, desktopAvailable: true, session: { state: "ok", updatedAt: Date.now() },
      lastCrawlAt: null, nextCrawlAt: null, followedGroupsCount: 1, followedExternalIds: ["123"],
      loadsLastHour: 0, maxLoadsPerHour: 60, queuedPostsCount: 0,
      pause: { paused: false, until: null, reason: null, requiresDesktopResume: false },
      scanOptions: { mode: "current_tab", maxPosts: 30, maxScrollSteps: 3 },
      scanSources: [{ platform: "facebook", kind: "group", external_id: "123" }],
    };
    const sendMessage = vi.fn(async (message) => {
      if (message.kind === "popup:set-scan-options") status.scanOptions = { ...message.options };
      return status;
    });
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "0.2.0" }), sendMessage },
      tabs: { query: async () => [{ id: 42, url: "https://www.facebook.com/groups/123/" }], sendMessage: async () => undefined },
    });
    await initPopup();
    expect((document.getElementById("scan-options") as HTMLDetailsElement).open).toBe(false);
    const mode = document.getElementById("scan-mode") as HTMLSelectElement;
    const posts = document.getElementById("scan-max-posts") as HTMLInputElement;
    const scrolls = document.getElementById("scan-max-scrolls") as HTMLInputElement;
    expect(scrolls.disabled).toBe(true);
    mode.value = "background";
    mode.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(scrolls.disabled).toBe(false));
    posts.value = "65";
    posts.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(status.scanOptions?.maxPosts).toBe(65));
    scrolls.value = "4";
    scrolls.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status.scanOptions?.maxScrollSteps).toBe(4));
    expect(document.getElementById("scan-options-summary")?.textContent).toBe("Tab nền, 65 bài, 4 cuộn");
    expect(document.getElementById("scan-options-feedback")?.textContent).toContain("Đã lưu");
    disposePanel();
    mount();
    await initPopup();
    expect((document.getElementById("scan-max-posts") as HTMLInputElement).value).toBe("65");
    expect((document.getElementById("scan-max-scrolls") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("scan-mode") as HTMLSelectElement).value).toBe("background");
    const restoredPosts = document.getElementById("scan-max-posts") as HTMLInputElement;
    const scan = document.getElementById("btn-scan-now") as HTMLButtonElement;
    restoredPosts.value = "101";
    restoredPosts.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(scan.disabled).toBe(true));
    expect(status.scanOptions?.maxPosts).toBe(65);
    expect(document.getElementById("scan-options-feedback")?.textContent).toContain("Chưa lưu");
  });

  it("keeps unsaved settings visible and disables scanning if saving fails", async () => {
    document.body.innerHTML = new DOMParser().parseFromString(popupHtml, "text/html").body.innerHTML;
    const status: PopupStatusSnapshot = {
      connected: true, desktopAvailable: true, session: { state: "ok", updatedAt: Date.now() },
      lastCrawlAt: null, nextCrawlAt: null, followedGroupsCount: 1, followedExternalIds: ["123"],
      loadsLastHour: 0, maxLoadsPerHour: 60, queuedPostsCount: 0,
      pause: { paused: false, until: null, reason: null, requiresDesktopResume: false },
      scanSources: [{ platform: "facebook", kind: "group", external_id: "123" }],
    };
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "0.2.0" }), sendMessage: async (message: RuntimeMessage) => {
        if (message.kind === "popup:set-scan-options") throw new Error("Storage unavailable");
        return status;
      } },
      tabs: { query: async () => [{ id: 42, url: "https://www.facebook.com/groups/123/" }], sendMessage: async () => undefined },
    });
    await initPopup();
    const posts = document.getElementById("scan-max-posts") as HTMLInputElement;
    posts.value = "50";
    posts.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.getElementById("scan-options-feedback")?.textContent).toContain("Chưa lưu được"));
    expect(posts.value).toBe("50");
    expect((document.getElementById("btn-scan-now") as HTMLButtonElement).disabled).toBe(true);
  });

});
