import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppFile } from "../src/main/app-files";
import {
  applyAutostart,
  autostartFilePath,
  createAutostartSync,
  launchAgentPlist,
  xdgAutostartEntry,
} from "../src/main/autostart";
import { ExitCoordinator } from "../src/main/lifecycle";
import { buildBackendEnv, identity, resolveDataDir, resolveResources, resolveUserDataDir } from "../src/main/paths";
import { formatTrayStatusLabel, isMinimizedStartup } from "../src/main/tray-label";

const tmp: string[] = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ds-shell-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("tray label (port of tray.rs test)", () => {
  const base = { crawl_paused: false, facebook_session: "ok", ai_state: "ok", extension_connected: true };
  it("follows the Rust precedence", () => {
    expect(formatTrayStatusLabel(base)).toBe("Trạng thái: Sẵn sàng");
    expect(formatTrayStatusLabel({ ...base, extension_connected: false })).toBe("Trạng thái: Chờ kết nối tiện ích Chrome");
    expect(formatTrayStatusLabel({ ...base, extension_connected: false, facebook_session: "checkpoint" })).toBe(
      "Trạng thái: Cần xác minh phiên Facebook"
    );
    expect(formatTrayStatusLabel({ ...base, facebook_session: "logged_out" })).toBe("Trạng thái: Facebook đã đăng xuất");
    expect(formatTrayStatusLabel({ ...base, facebook_session: "rate_limited" })).toBe("Trạng thái: Đang giãn nhịp Facebook");
    expect(formatTrayStatusLabel({ ...base, ai_state: "error" })).toBe("Trạng thái: Lỗi kết nối AI CLI");
    expect(formatTrayStatusLabel({ ...base, facebook_session: "checkpoint", crawl_paused: true })).toBe(
      "Trạng thái: Đang tạm dừng quét"
    );
    expect(formatTrayStatusLabel(null)).toBe("Trạng thái: Sẵn sàng");
  });
  it("detects minimized startup flags", () => {
    expect(isMinimizedStartup(["app"])).toBe(false);
    expect(isMinimizedStartup(["app", "--minimized"])).toBe(true);
    expect(isMinimizedStartup(["app", "--autostart"])).toBe(true);
  });
});

describe("ExitCoordinator", () => {
  it("runs shutdown once for concurrent quit signals, then exits", async () => {
    let release!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((r) => (release = r)));
    const exit = vi.fn();
    const c = new ExitCoordinator(shutdown, exit, 1_000);
    expect(c.shuttingDown).toBe(false);
    const a = c.requestQuit();
    const b = c.requestQuit();
    expect(a).toBe(b);
    expect(c.shuttingDown).toBe(true);
    expect(c.allowExit).toBe(false);
    release();
    await a;
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(c.allowExit).toBe(true);
  });

  it("exits even if shutdown hangs or throws", async () => {
    const hang = new ExitCoordinator(() => new Promise<void>(() => {}), vi.fn(), 20);
    await hang.requestQuit(3);
    const exit = vi.fn();
    const boom = new ExitCoordinator(async () => Promise.reject(new Error("x")), exit, 1_000);
    await boom.requestQuit();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("passes the exit code through", async () => {
    const exit = vi.fn();
    await new ExitCoordinator(async () => {}, exit).requestQuit(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("paths and identity", () => {
  it("never defaults to the production profile name", () => {
    expect(identity.channel).toBe("candidate");
    expect(identity.appId).not.toBe("com.dealsonar.desktop");
    expect(resolveDataDir({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Application Support/DealSonar Candidate");
    expect(resolveDataDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toContain("DealSonar Candidate");
    expect(resolveDataDir({}, "linux", "/home/u")).toBe("/home/u/.local/share/dealsonar-candidate");
    expect(resolveDataDir({ XDG_DATA_HOME: "/x" }, "linux", "/home/u")).toBe("/x/dealsonar-candidate");
  });
  it("honours DEALSONAR_DATA_DIR and user data override", () => {
    expect(resolveDataDir({ DEALSONAR_DATA_DIR: " /tmp/d " }, "linux", "/h")).toBe("/tmp/d");
    expect(resolveUserDataDir("/appdata", {})).toBe(join("/appdata", identity.appId));
    expect(resolveUserDataDir("/appdata", { DEALSONAR_SHELL_USER_DATA_DIR: "/u" })).toBe("/u");
  });
  it("packaged resources ignore env overrides; dev honours them", () => {
    const env = { DEALSONAR_BACKEND_ENTRY: "/evil/main.cjs", DEALSONAR_NATIVE_HOST_BIN: "/evil/host" };
    const packaged = resolveResources({ isPackaged: true, resourcesPath: "/R", projectDir: "/P", env, platform: "linux" });
    expect(packaged.backendEntry).toBe(join("/R", "backend", "main.cjs"));
    expect(packaged.nativeHostBinary).toBe(join("/R", "native-host", "dealsonar-native-host"));
    expect(packaged.backendEntry).not.toContain("app.asar");
    const dev = resolveResources({ isPackaged: false, resourcesPath: "/R", projectDir: "/P", env, platform: "linux" });
    expect(dev.backendEntry).toBe("/evil/main.cjs");
    expect(dev.nativeHostBinary).toBe("/evil/host");
    expect(
      resolveResources({ isPackaged: true, resourcesPath: "/R", projectDir: "/P", platform: "win32", env: {} }).nativeHostBinary
    ).toBe(join("/R", "native-host", "dealsonar-native-host.exe"));
  });
  it("backend env keeps the Rust variable names", () => {
    const env = buildBackendEnv({ PATH: "/bin", UNDEF: undefined }, { dataDir: "/d", nativeHostBinary: "/h", appVersion: "1", electronVersion: "33" });
    expect(env).toMatchObject({ PATH: "/bin", DEALSONAR_DATA_DIR: "/d", DEALSONAR_NATIVE_HOST_BIN: "/h", DEALSONAR_SHELL: "electron" });
    expect("UNDEF" in env).toBe(false);
  });
});

describe("autostart", () => {
  const t = (home: string, platform: NodeJS.Platform) => ({
    platform,
    home,
    exePath: "/Apps/DealSonar Candidate & Co",
    appId: identity.appId,
    appName: identity.productName,
  });
  it("writes and removes a macOS LaunchAgent with --autostart", () => {
    const home = mk();
    applyAutostart(true, t(home, "darwin"));
    const file = autostartFilePath(t(home, "darwin"))!;
    const text = readFileSync(file, "utf8");
    expect(text).toContain("<string>--autostart</string>");
    expect(text).toContain("DealSonar Candidate &amp; Co");
    expect(text).toContain("<key>RunAtLoad</key>");
    applyAutostart(false, t(home, "darwin"));
    expect(existsSync(file)).toBe(false);
  });
  it("writes an XDG entry on linux", () => {
    const home = mk();
    applyAutostart(true, t(home, "linux"));
    const text = readFileSync(autostartFilePath(t(home, "linux"))!, "utf8");
    expect(text).toContain('Exec="/Apps/DealSonar Candidate & Co" --autostart');
    expect(xdgAutostartEntry({ appName: "A", exePath: "/a" })).toContain("Name=A");
    expect(launchAgentPlist({ appId: "x", exePath: "/y" })).toContain("<string>x</string>");
  });
  it("delegates to the login item on windows", () => {
    const set = vi.fn();
    applyAutostart(true, { ...t("/h", "win32"), setWindowsLoginItem: set });
    expect(set).toHaveBeenCalledWith(true);
  });
  it("dedupes, can be disabled, and swallows errors", () => {
    const home = mk();
    const log = vi.fn();
    const sync = createAutostartSync(t(home, "linux"), log);
    sync(true);
    sync(true);
    expect(log).toHaveBeenCalledTimes(1);
    const off = createAutostartSync(t(home, "linux"), log, true);
    off(false);
    expect(log).toHaveBeenCalledTimes(1);
    const blocker = join(home, "file");
    writeFileSync(blocker, "x");
    const failing = createAutostartSync({ ...t(blocker, "linux") }, log);
    expect(() => failing(true)).not.toThrow();
    expect(log).toHaveBeenLastCalledWith("warn", expect.stringContaining("autostart sync failed"));
  });
});

describe("resolveAppFile", () => {
  it("serves files, falls back to index.html, blocks traversal and foreign hosts", () => {
    const ui = mk();
    mkdirSync(join(ui, "assets"));
    writeFileSync(join(ui, "index.html"), "<html>");
    writeFileSync(join(ui, "assets", "a.js"), "1");
    expect(resolveAppFile(ui, "dealsonar-app://app/")).toBe(join(ui, "index.html"));
    expect(resolveAppFile(ui, "dealsonar-app://app/assets/a.js")).toBe(join(ui, "assets", "a.js"));
    expect(resolveAppFile(ui, "dealsonar-app://app/inbox")).toBe(join(ui, "index.html"));
    expect(resolveAppFile(ui, "dealsonar-app://app/assets/missing.js")).toBeNull();
    // Traversal can never leave the UI root: it is clamped to the root and falls back to index.html.
    for (const evil of ["dealsonar-app://app/%2e%2e/%2e%2e/etc/passwd", "dealsonar-app://app/..%2f..%2fetc%2fpasswd", "dealsonar-app://app/..%5c..%5cwindows%5cwin.ini"]) {
      expect([null, join(ui, "index.html")]).toContain(resolveAppFile(ui, evil));
    }
    expect(resolveAppFile(ui, "dealsonar-app://evil/index.html")).toBeNull();
    expect(resolveAppFile(ui, "https://app/index.html")).toBeNull();
    expect(resolveAppFile(ui, "dealsonar-app://app/a%00b.js")).toBeNull();
  });
});
