import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialStorageState, type ExtensionStorageState } from "../src/background/storage";
import type { PopupScanResponse, PopupStatusSnapshot, RuntimeMessage } from "../src/messages";

const source = { platform: "facebook", kind: "group", external_id: "12345" } as const;
let state: ExtensionStorageState;
let request: (message: RuntimeMessage) => Promise<any>;
let alarm: (value: { name: string }) => void;
let sendToTab: ReturnType<typeof vi.fn>;
let createTab: ReturnType<typeof vi.fn>;
let clearAlarm: ReturnType<typeof vi.fn>;
let queryTabs: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  state = createInitialStorageState();
  state.connection = { connected: true, desktop_available: true };
  state.config.plan.entries = [{ source_ref: source, interval_s: 900, priority: 0, max_posts_per_visit: 30 }];
  // Manual scans must work outside active hours, even while the user is active.
  state.config.policy.active_hours = { from: "00:00", to: "00:01" };
  state.config.policy.only_when_idle = true;
  queryTabs = vi.fn(async () => [{ id: 42, url: "https://www.facebook.com/groups/12345/" }]);
  sendToTab = vi.fn(async () => ({ status: "empty", session: { state: "ok" }, posts: [], strategy: "dom" }));
  createTab = vi.fn();
  clearAlarm = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: (listener: any) => {
        request = (message) => new Promise((resolve) => listener(message, {}, resolve));
      } },
    },
    storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(state) }),
      set: async (value: Record<string, ExtensionStorageState>) => { state = structuredClone(Object.values(value)[0]!); },
    } },
    tabs: { query: queryTabs, sendMessage: sendToTab, create: createTab,
      get: vi.fn(async () => ({ id: 99, url: "https://www.facebook.com/groups/12345/", status: "complete" })),
      remove: vi.fn(),
    },
    idle: { queryState: async () => "active" },
    alarms: { create: vi.fn(), clear: clearAlarm, onAlarm: { addListener: (listener: typeof alarm) => { alarm = listener; } } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
  });
  await import("../src/background/index");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Sidebar manual scanning", () => {
  it("opens the native side panel from the toolbar and defaults to manual mode", async () => {
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    const snapshot = await request({ kind: "popup:get-status" }) as PopupStatusSnapshot;
    expect(snapshot.automaticScanning).toBe(false);
    expect(snapshot.nextCrawlAt).toBeNull();
    alarm({ name: "dealsonar:scheduler" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it("scans immediately without a schedule, reuses the user's tab without scrolling and persists a summary", async () => {
    const response = await request({ kind: "popup:scan-now", source }) as PopupScanResponse;
    expect(response.ok).toBe(true);
    expect(sendToTab).toHaveBeenCalledWith(42, expect.objectContaining({
      kind: "dealsonar:crawl-execute", maxPosts: 30, maxScrollSteps: 0, sourceRef: source,
    }));
    expect(createTab).not.toHaveBeenCalled();
    expect(response.status.activeCrawl).toBeNull();
    expect(response.status.lastScan).toMatchObject({ status: "empty", postsSeen: 0, postsNew: 0 });
    expect(state.last_scan).toMatchObject({ sourceExternalId: "12345" });
  });

  it.each(["disconnected", "paused", "checkpoint", "hourly-cap", "cooldown"])("keeps %s checks for manual scans", async (block) => {
    if (block === "disconnected") state.connection.connected = false;
    if (block === "paused") state.pause.paused = true;
    if (block === "checkpoint") { state.session.state = "checkpoint"; state.pause.requires_desktop_resume = true; }
    if (block === "hourly-cap" || block === "cooldown") {
      state.quick_scan_options.mode = "background";
      queryTabs.mockResolvedValue([]);
    }
    if (block === "hourly-cap") state.load_timestamps = Array(60).fill(Date.now());
    if (block === "cooldown") state.source_states["12345"] = { last_crawl_at: Date.now(), next_due_at: Date.now(), inaccessible: false };
    const response = await request({ kind: "popup:scan-now", source }) as PopupScanResponse;
    expect(response.ok).toBe(false);
    expect(response.error).toBeTruthy();
    expect(sendToTab).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("rejects a second request while a scan is running", async () => {
    let finish!: (value: unknown) => void;
    sendToTab.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = request({ kind: "popup:scan-now", source });
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(1));
    const second = await request({ kind: "popup:scan-now", source });
    expect(second.ok).toBe(false);
    finish({ status: "empty", session: { state: "ok" }, posts: [], strategy: "dom" });
    await first;
  });

  it("persists the automatic mode independently of safety pauses", async () => {
    state.pause.paused = true;
    const enabled = await request({ kind: "popup:set-automatic", enabled: true });
    expect(enabled.automaticScanning).toBe(true);
    expect(enabled.pause.paused).toBe(true);
    await request({ kind: "popup:set-automatic", enabled: false });
    expect(state.automatic_scanning).toBe(false);
    expect(clearAlarm).toHaveBeenCalledWith("dealsonar:scheduler");
  });
  it("saves and restores preferences after a service worker restart", async () => {
    const options = { mode: "background", maxPosts: 60, maxScrollSteps: 4 } as const;
    const saved = await request({ kind: "popup:set-scan-options", options });
    expect(saved.scanOptions).toEqual(options);
    vi.resetModules();
    await import("../src/background/index");
    const restored = await request({ kind: "popup:get-status" });
    expect(restored.scanOptions).toEqual(options);
    expect(state.quick_scan_options).toEqual(options);
  });

  it.each([
    { mode: "background", maxPosts: 0, maxScrollSteps: 3 },
    { mode: "background", maxPosts: 101, maxScrollSteps: 3 },
    { mode: "current_tab", maxPosts: 1.5, maxScrollSteps: 3 },
    { mode: "background", maxPosts: 30, maxScrollSteps: 6 },
    { mode: "background", maxPosts: 30, maxScrollSteps: -1 },
    { mode: "invalid", maxPosts: 30, maxScrollSteps: 3 },
  ])("rejects invalid settings without replacing the saved values: %j", async (options) => {
    const response = await request({ kind: "popup:set-scan-options", options } as RuntimeMessage);
    expect(response.ok).toBe(false);
    expect(state.quick_scan_options).toEqual({ mode: "current_tab", maxPosts: 30, maxScrollSteps: 3 });
  });

  it("current-tab mode uses the chosen post limit and never scrolls or opens a new tab", async () => {
    await request({ kind: "popup:set-scan-options", options: { mode: "current_tab", maxPosts: 12, maxScrollSteps: 5 } });
    const result = await request({ kind: "popup:scan-now", source });
    expect(result.ok).toBe(true);
    expect(queryTabs).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sendToTab).toHaveBeenCalledWith(42, expect.objectContaining({ maxPosts: 12, maxScrollSteps: 0 }));
    expect(createTab).not.toHaveBeenCalled();
  });

  it("rejects a mismatched current tab rather than silently using another tab", async () => {
    queryTabs.mockResolvedValue([{ id: 88, url: "https://example.com/" }]);
    const result = await request({ kind: "popup:scan-now", source });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tab hiện tại");
    expect(createTab).not.toHaveBeenCalled();
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it("accepts a numeric group ID on a matching vanity URL", async () => {
    queryTabs.mockResolvedValue([{ id: 42, url: "https://www.facebook.com/groups/vanity/" }]);
    sendToTab.mockImplementation(async (_tab, message) => message.kind === "dealsonar:get-page-context"
      ? { groupInfo: source }
      : { status: "empty", session: { state: "ok" }, posts: [], strategy: "dom" });
    expect((await request({ kind: "popup:scan-now", source })).ok).toBe(true);
    expect(sendToTab).toHaveBeenCalledWith(42, expect.objectContaining({ kind: "dealsonar:crawl-execute" }));
  });

  it.each([0, 5])("background mode always creates and closes its own tab with %i scroll steps", async (steps) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    createTab.mockResolvedValue({ id: 99 });
    await request({ kind: "popup:set-scan-options", options: { mode: "background", maxPosts: 80, maxScrollSteps: steps } });
    const result = await request({ kind: "popup:scan-now", source });
    expect(result.ok).toBe(true);
    expect(queryTabs).not.toHaveBeenCalled();
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(sendToTab).toHaveBeenCalledWith(99, expect.objectContaining({ maxPosts: 80, maxScrollSteps: steps }));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
    expect(state.load_timestamps).toHaveLength(1);
  }, 8000);

  it("restores safe defaults for old storage with no quick-scan options", async () => {
    delete (state as Partial<ExtensionStorageState>).quick_scan_options;
    const snapshot = await request({ kind: "popup:get-status" });
    expect(snapshot.scanOptions).toEqual({ mode: "current_tab", maxPosts: 30, maxScrollSteps: 3 });
  });

  it("uses the visible options snapshot if another panel changed the saved defaults", async () => {
    state.quick_scan_options = { mode: "background", maxPosts: 80, maxScrollSteps: 5 };
    const result = await request({ kind: "popup:scan-now", source,
      options: { mode: "current_tab", maxPosts: 15, maxScrollSteps: 3 },
    });
    expect(result.ok).toBe(true);
    expect(sendToTab).toHaveBeenCalledWith(42, expect.objectContaining({ maxPosts: 15, maxScrollSteps: 0 }));
    expect(createTab).not.toHaveBeenCalled();
  });

  it("rejects malformed scan options at execution time too", async () => {
    const result = await request({ kind: "popup:scan-now", source,
      options: { mode: "current_tab", maxPosts: 1000, maxScrollSteps: 99 },
    });
    expect(result.ok).toBe(false);
    expect(sendToTab).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

});
