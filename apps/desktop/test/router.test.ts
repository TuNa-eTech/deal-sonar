import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../src/main/backend-client";
import { routeInvoke, type RouterDeps } from "../src/main/router";

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ ok: 1 }));
  return {
    backend: { request },
    pickBackupFile: vi.fn(async () => "/tmp/backup.sqlite3"),
    openExternal: vi.fn(async () => {}),
    request,
    ...overrides,
  } as RouterDeps & { request: ReturnType<typeof vi.fn> };
}

describe("routeInvoke", () => {
  it("forwards backend commands with their args object unchanged", async () => {
    const d = deps();
    const out = await routeInvoke(d, "radar_get", { id: "r1" });
    expect(out).toEqual({ ok: true, value: { ok: 1 } });
    expect(d.request).toHaveBeenCalledWith("radar_get", { id: "r1" });
  });

  it("treats missing args as an empty object", async () => {
    const d = deps();
    await routeInvoke(d, "radar_list", undefined);
    expect(d.request).toHaveBeenCalledWith("radar_list", {});
  });

  it.each([["unknown"], ["backend:shutdown"], ["backend:toggle_crawl_paused"], ["os:notification"], ["__proto__"], [""]])(
    "rejects %j as unknown_command and never reaches the backend",
    async (cmd) => {
      const d = deps();
      const out = await routeInvoke(d, cmd, {});
      expect(out).toMatchObject({ ok: false, error: { code: "unknown_command" } });
      expect(d.request).not.toHaveBeenCalled();
    }
  );

  it("rejects non-string commands", async () => {
    const d = deps();
    expect(await routeInvoke(d, { toString: () => "radar_list" }, {})).toMatchObject({ ok: false, error: { code: "unknown_command" } });
  });

  it.each([[[1, 2]], ["str"], [42], [true]])("rejects non-object args %j", async (args) => {
    const d = deps();
    expect(await routeInvoke(d, "radar_list", args)).toEqual({
      ok: false,
      error: { code: "validation_error", message: "tham số lệnh IPC phải là đối tượng JSON" },
    });
    expect(d.request).not.toHaveBeenCalled();
  });

  it("maps backend errors to {code,message}", async () => {
    const d = deps();
    d.request.mockRejectedValueOnce(new BackendError("not_found", "Không tìm thấy radar"));
    expect(await routeInvoke(d, "radar_get", { id: "x" })).toEqual({
      ok: false,
      error: { code: "not_found", message: "Không tìm thấy radar" },
    });
  });

  it("maps unexpected throws to internal_error", async () => {
    const d = deps();
    d.request.mockRejectedValueOnce(new Error("boom"));
    expect(await routeInvoke(d, "radar_list", {})).toEqual({ ok: false, error: { code: "internal_error", message: "boom" } });
  });

  it("reports settings to the autostart hook and survives hook errors", async () => {
    const onSettings = vi.fn(() => {
      throw new Error("hook failed");
    });
    const d = deps({ onSettings });
    d.request.mockResolvedValueOnce({ launch_at_login: true });
    const out = await routeInvoke(d, "settings_set", { patch: { launch_at_login: true } });
    expect(out).toEqual({ ok: true, value: { launch_at_login: true } });
    expect(onSettings).toHaveBeenCalledWith({ launch_at_login: true });
  });

  describe("open_external_url", () => {
    it("opens a valid facebook permalink", async () => {
      const d = deps();
      const out = await routeInvoke(d, "open_external_url", { url: "https://www.facebook.com/groups/1/posts/2/" });
      expect(out).toEqual({ ok: true, value: { opened: true } });
      expect(d.openExternal).toHaveBeenCalledTimes(1);
    });

    it("blocks everything else with blocked_external_url", async () => {
      const d = deps();
      const out = await routeInvoke(d, "open_external_url", { url: "https://evil.example/" });
      expect(out).toMatchObject({ ok: false, error: { code: "blocked_external_url" } });
      expect(d.openExternal).not.toHaveBeenCalled();
    });

    it("validates the url argument", async () => {
      const d = deps();
      expect(await routeInvoke(d, "open_external_url", {})).toEqual({
        ok: false,
        error: { code: "validation_error", message: "thiếu tham số 'url'" },
      });
      expect(await routeInvoke(d, "open_external_url", { url: 5 })).toMatchObject({ ok: false, error: { code: "validation_error" } });
    });

    it("reports browser_open_failed", async () => {
      const d = deps({ openExternal: vi.fn(async () => Promise.reject(new Error("no browser"))) });
      expect(await routeInvoke(d, "open_external_url", { url: "https://t.me/DealSonarBot" })).toEqual({
        ok: false,
        error: { code: "browser_open_failed", message: "no browser" },
      });
    });
  });

  describe("backup_pick_file", () => {
    it("returns the picked path or null", async () => {
      const d = deps();
      expect(await routeInvoke(d, "backup_pick_file", {})).toEqual({ ok: true, value: "/tmp/backup.sqlite3" });
      const cancelled = deps({ pickBackupFile: vi.fn(async () => null) });
      expect(await routeInvoke(cancelled, "backup_pick_file", {})).toEqual({ ok: true, value: null });
      expect(d.request).not.toHaveBeenCalled();
    });

    it("maps dialog failure to file_picker_failed", async () => {
      const d = deps({ pickBackupFile: vi.fn(async () => Promise.reject(new Error("dialog died"))) });
      expect(await routeInvoke(d, "backup_pick_file", {})).toEqual({
        ok: false,
        error: { code: "file_picker_failed", message: "dialog died" },
      });
    });
  });
});
