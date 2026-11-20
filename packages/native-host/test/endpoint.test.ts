import { describe, expect, it } from "vitest";
import {
  defaultDataDirWith,
  resolveDesktopIpcEndpoint,
  resolveIpcEndpoint,
  resolveIpcEndpointWith,
  resolveMcpDataDir,
  resolveMcpEndpoint,
  sanitizePipeComponent,
} from "../src/endpoint.js";

describe("IPC endpoint resolution (parity with crates/protocol ipc.rs)", () => {
  it("macOS default", () => {
    expect(resolveIpcEndpointWith({ platform: "macos", homeDir: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/DealSonar/ipc.sock",
    );
  });

  it("Linux prefers XDG_RUNTIME_DIR then ~/.local/share", () => {
    expect(resolveIpcEndpointWith({ platform: "linux", xdgRuntimeDir: "/run/user/1000", homeDir: "/home/a" })).toBe(
      "/run/user/1000/dealsonar/ipc.sock",
    );
    expect(resolveIpcEndpointWith({ platform: "linux", xdgRuntimeDir: "", homeDir: "/home/a" })).toBe(
      "/home/a/.local/share/dealsonar/ipc.sock",
    );
  });

  it("Windows per-user pipe with sanitized username", () => {
    expect(resolveIpcEndpointWith({ platform: "windows", windowsUser: "Anh Tu" })).toBe(
      "\\\\.\\pipe\\dealsonar-Anh_Tu",
    );
    expect(resolveIpcEndpointWith({ platform: "windows", windowsUser: "  " })).toBe("\\\\.\\pipe\\dealsonar-default");
  });

  it("override: passthrough on Unix, pipe-ified on Windows, empty ignored", () => {
    expect(resolveIpcEndpointWith({ platform: "linux", ipcOverride: "/tmp/x.sock", homeDir: "/h" })).toBe("/tmp/x.sock");
    expect(resolveIpcEndpointWith({ platform: "windows", ipcOverride: "\\\\.\\pipe\\custom" })).toBe("\\\\.\\pipe\\custom");
    expect(resolveIpcEndpointWith({ platform: "windows", ipcOverride: "my test/1" })).toBe(
      "\\\\.\\pipe\\dealsonar-my_test_1",
    );
    expect(resolveIpcEndpointWith({ platform: "macos", ipcOverride: "", homeDir: "/Users/a" })).toContain("DealSonar/ipc.sock");
  });

  it("errors without a home directory", () => {
    expect(() => resolveIpcEndpointWith({ platform: "macos" })).toThrow(/HOME/);
    expect(() => resolveIpcEndpointWith({ platform: "linux" })).toThrow(/XDG_RUNTIME_DIR nor HOME/);
  });

  it("reads DEALSONAR_IPC_PATH from env", () => {
    expect(resolveIpcEndpoint({ DEALSONAR_IPC_PATH: "/tmp/o.sock", HOME: "/h" }, "linux")).toBe("/tmp/o.sock");
  });

  it("sanitizes pipe components", () => {
    expect(sanitizePipeComponent("a.b-c_d")).toBe("a_b-c_d");
    expect(sanitizePipeComponent("")).toBe("default");
  });
});

describe("data dir and desktop/MCP endpoint selection", () => {
  it("default data dirs", () => {
    expect(defaultDataDirWith({ platform: "macos", homeDir: "/Users/a" })).toBe("/Users/a/Library/Application Support/DealSonar");
    expect(defaultDataDirWith({ platform: "linux", homeDir: "/home/a" })).toBe("/home/a/.local/share/dealsonar");
    expect(defaultDataDirWith({ platform: "windows", appdataDir: "C:\\Users\\a\\AppData\\Roaming" })).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\DealSonar",
    );
    expect(defaultDataDirWith({ platform: "windows", homeDir: "C:\\Users\\a" })).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\DealSonar",
    );
  });

  it("MCP: a custom data dir without IPC override uses <dataDir>/ipc.sock on Unix", () => {
    const env = { DEALSONAR_DATA_DIR: "/tmp/dd", HOME: "/h" };
    const dir = resolveMcpDataDir(env, "linux");
    expect(dir).toEqual({ dataDir: "/tmp/dd", custom: true });
    expect(resolveMcpEndpoint(dir, env, "linux")).toBe("/tmp/dd/ipc.sock");
  });

  it("MCP: IPC override wins; Windows ignores data dir for the pipe", () => {
    const env = { DEALSONAR_DATA_DIR: "/tmp/dd", DEALSONAR_IPC_PATH: "/tmp/o.sock", HOME: "/h" };
    expect(resolveMcpEndpoint(resolveMcpDataDir(env, "linux"), env, "linux")).toBe("/tmp/o.sock");
    const win = { DEALSONAR_DATA_DIR: "C:\\dd", USERNAME: "bob", APPDATA: "C:\\A" };
    expect(resolveMcpEndpoint(resolveMcpDataDir(win, "windows"), win, "windows")).toBe("\\\\.\\pipe\\dealsonar-bob");
  });

  it("desktop: blank DEALSONAR_DATA_DIR is ignored, set one maps to ipc.sock", () => {
    expect(resolveDesktopIpcEndpoint("/d", { DEALSONAR_DATA_DIR: "  ", HOME: "/h" }, "macos")).toBe(
      "/h/Library/Application Support/DealSonar/ipc.sock",
    );
    expect(resolveDesktopIpcEndpoint("/d", { DEALSONAR_DATA_DIR: "/d", HOME: "/h" }, "macos")).toBe("/d/ipc.sock");
  });
});
