import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_DESKTOP_VERSION, compatGuidance, desktopOutdatedKind, isOlderThan, parseVersion } from "../src/compat";
import type { PopupStatusSnapshot } from "../src/messages";
import { renderStatus } from "../src/popup/status";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const popupHtml = readFileSync(resolve(rootDir, "src/popup/index.html"), "utf-8");

describe("version compatibility helpers", () => {
  it("compares numerically and never flags versions it cannot parse", () => {
    expect(parseVersion("v0.3.0-rc.1")).toEqual([0, 3, 0]);
    expect(isOlderThan("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderThan("0.10.0", "0.9.0")).toBe(false);
    expect(isOlderThan("1.0.0", "1.0.0")).toBe(false);
    expect(isOlderThan("dev", "1.0.0")).toBe(false);
    expect(desktopOutdatedKind(undefined)).toBeUndefined();
    expect(desktopOutdatedKind("0.0.1")).toBe("desktop_outdated");
    expect(desktopOutdatedKind(MIN_DESKTOP_VERSION)).toBeUndefined();
  });

  it("explains in Vietnamese which side to update and that data is kept", () => {
    const outdated = compatGuidance("desktop_outdated", "0.0.1");
    expect(outdated.message).toContain("v0.0.1");
    expect(outdated.action).toContain("cài đè");
    expect(outdated.action).toContain("được giữ nguyên");
    const mismatch = compatGuidance("protocol_mismatch");
    expect(mismatch.action).toContain("chrome://extensions");
    expect(mismatch.action).toContain("không cần ghép nối lại từ đầu");
  });
});

describe("popup guidance when Chrome and Desktop are out of step", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const base = (over: Partial<PopupStatusSnapshot>): PopupStatusSnapshot => ({
    connected: false,
    desktopAvailable: false,
    session: { state: "ok", updatedAt: Date.now() },
    lastCrawlAt: null,
    nextCrawlAt: null,
    followedGroupsCount: 0,
    followedExternalIds: [],
    loadsLastHour: 0,
    maxLoadsPerHour: 60,
    pause: { paused: false, until: null, reason: null, requiresDesktopResume: false },
    queuedPostsCount: 0,
    ...over,
  });
  const mount = () => {
    document.body.innerHTML = new DOMParser().parseFromString(popupHtml, "text/html").body.innerHTML;
  };
  const help = () => document.getElementById("desktop-help-msg")?.textContent ?? "";
  const helpHidden = () => document.getElementById("desktop-help")?.classList.contains("hidden");

  it("a protocol mismatch shows the update instructions instead of a bare error", () => {
    mount();
    renderStatus(base({ compat: compatGuidance("protocol_mismatch"), connectionError: "unsupported protocol version 3" }));
    expect(document.getElementById("desktop-status-text")?.textContent).toBe("Mất kết nối");
    expect(helpHidden()).toBe(false);
    expect(help()).toContain("không khớp phiên bản giao thức");
    expect(help()).toContain("được giữ nguyên");
  });

  it("an outdated Desktop that is still connected shows a warning but stays connected", () => {
    mount();
    renderStatus(base({ connected: true, desktopAvailable: true, desktopVersion: "0.0.1", compat: compatGuidance("desktop_outdated", "0.0.1") }));
    expect(document.getElementById("desktop-status-text")?.textContent).toContain("Đã kết nối");
    expect(helpHidden()).toBe(false);
    expect(help()).toContain("cài đè");
  });

  it("a healthy, current pair shows no warning", () => {
    mount();
    renderStatus(base({ connected: true, desktopAvailable: true, desktopVersion: MIN_DESKTOP_VERSION }));
    expect(helpHidden()).toBe(true);
  });
});
