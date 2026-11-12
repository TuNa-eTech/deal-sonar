import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PopupStatusSnapshot, RuntimeMessage } from "../src/messages";
import { initPopup } from "../src/popup/main";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const popupHtml = readFileSync(resolve(rootDir, "src/popup/index.html"), "utf-8");

describe("Popup UI (`03-ux-flows.md §4`)", () => {
  afterEach(() => {
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
});
