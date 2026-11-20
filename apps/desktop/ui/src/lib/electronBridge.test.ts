import { afterEach, describe, expect, it, vi } from "vitest";
import { api, isDesktopRuntime, isTauriRuntime, onDesktopEvent } from "./api";
import { DesktopCommandError, type DesktopBridge, type DesktopInvokeEnvelope } from "./electronBridge";

function installBridge(reply: (cmd: string, args?: Record<string, unknown>) => DesktopInvokeEnvelope) {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const bridge: DesktopBridge = {
    shell: "electron",
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => reply(cmd, args)),
    onEvent: vi.fn((event: string, handler: (p: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    }),
  };
  window.dealsonarDesktop = bridge;
  return { bridge, emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload)) };
}

afterEach(() => {
  delete window.dealsonarDesktop;
});

describe("Electron transport", () => {
  it("is not selected without the preload bridge (mock backend stays the browser default)", async () => {
    expect(isDesktopRuntime()).toBe(false);
    expect(isTauriRuntime()).toBe(false);
    const radars = await api.radarList();
    expect(Array.isArray(radars)).toBe(true);
  });

  it("sends the exact snake_case command id and payload through the bridge", async () => {
    const { bridge } = installBridge(() => ({ ok: true, value: [] }));
    expect(isDesktopRuntime()).toBe(true);
    expect(isTauriRuntime()).toBe(false);
    await api.radarStats("r1", 14);
    await api.leadSetStatus("l1", "contacted", { note: "n" });
    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "radar_stats", { radar_id: "r1", days: 14 });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "lead_set_status", { id: "l1", status: "contacted", note: "n" });
  });

  it("resolves with the command value", async () => {
    installBridge(() => ({ ok: true, value: { launch_at_login: true } }));
    await expect(api.settingsGet()).resolves.toEqual({ launch_at_login: true });
  });

  it("rejects like Tauri did: String(err) is the plain message, code is preserved", async () => {
    installBridge(() => ({ ok: false, error: { code: "not_found", message: "Không tìm thấy radar" } }));
    const err = await api.radarGet("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopCommandError);
    expect(String(err)).toBe("Không tìm thấy radar");
    expect((err as Error).message).toBe("Không tìm thấy radar");
    expect((err as DesktopCommandError).code).toBe("not_found");
  });

  it("subscribes to push events and unsubscribes", async () => {
    const { bridge, emit } = installBridge(() => ({ ok: true, value: null }));
    const handler = vi.fn();
    const off = await onDesktopEvent("health:changed", handler);
    expect(bridge.onEvent).toHaveBeenCalledWith("health:changed", expect.any(Function));
    emit("health:changed", { crawl_paused: true });
    expect(handler).toHaveBeenCalledWith({ crawl_paused: true });
    off();
    emit("health:changed", { crawl_paused: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores a foreign object that is not the electron bridge", () => {
    (window as unknown as { dealsonarDesktop: unknown }).dealsonarDesktop = { shell: "other", invoke: () => null };
    expect(isDesktopRuntime()).toBe(false);
  });
});
