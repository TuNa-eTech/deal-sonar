import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialStorageState, type ExtensionStorageState } from "../src/background/storage";
import type { DesktopEnvelope } from "../src/protocol";

let state: ExtensionStorageState;

beforeEach(() => {
  vi.resetModules();
  state = createInitialStorageState();
  vi.stubGlobal("chrome", {
    runtime: { id: "hkmjpcenjjebhpjicnbpmogidfcbmbjn", onMessage: { addListener: vi.fn() } },
    storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(state) }),
      set: async (value: Record<string, ExtensionStorageState>) => { state = structuredClone(Object.values(value)[0]!); },
    } },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    tabs: { query: vi.fn(async () => []) },
    idle: { queryState: async () => "active" },
  });
});
// Handlers fire follow-up work (`void runSchedulerTick()`); let it settle before removing the chrome stub.
afterEach(async () => { await new Promise((r) => setTimeout(r, 50)); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const envelope = (type: string, payload: unknown): DesktopEnvelope =>
  ({ v: 2, id: "01JCF7Z3K8AAAAAAAAAAAAAAAA", type, ts: Date.now(), reply_to: null, payload }) as DesktopEnvelope;

describe("Chrome updated before or after the Desktop app", () => {
  it("flags a Desktop older than the supported minimum, but keeps the connection", async () => {
    const { handleDesktopEnvelope } = await import("../src/background/desktop-envelope");
    await handleDesktopEnvelope(envelope("hello.ok", { desktop_version: "0.0.1", config_rev: 1 }));
    expect(state.connection).toMatchObject({ connected: true, desktop_available: true, compat: "desktop_outdated" });
  });

  it("remembers a protocol mismatch reported by the Desktop and clears it after a matching hello", async () => {
    const { handleDesktopEnvelope } = await import("../src/background/desktop-envelope");
    await handleDesktopEnvelope(envelope("error", { code: "protocol_mismatch", message: "unsupported protocol version 3", retryable: false }));
    expect(state.connection.desktop_available).toBe(false);
    expect(state.connection.compat).toBe("protocol_mismatch");
    expect(state.connection.last_error).toContain("không khớp");

    // Desktop was updated: the next handshake succeeds and the warning goes away. Local data
    // (seen posts, plan, queue) lives outside `connection` and is untouched.
    state.seen_post_ids = { g1: ["p1"] };
    await handleDesktopEnvelope(envelope("hello.ok", { desktop_version: "0.3.0", config_rev: 1 }));
    expect(state.connection).toMatchObject({ connected: true, desktop_available: true });
    expect(state.connection.compat).toBeUndefined();
    expect(state.connection.last_error).toBeUndefined();
    expect(state.seen_post_ids).toEqual({ g1: ["p1"] });
  });
});
