import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { candidateWindowsPipe, loadBackendConfig } from "../src/backend/config";
import { CommandError, CoreError } from "../src/backend/wire";
import {
  CHROME_BOUNDARY_ENV,
  type ChromeBoundary,
  type ChromeConnectDeps,
  type ChromeProvisionOutcome,
  type ChromeProvisionRequest,
  type ChromeProvisioning,
  MESSAGE_CANDIDATE_ISOLATED,
  MESSAGE_CONNECTED,
  MESSAGE_INSTALLED,
  MESSAGE_NO_HELPER,
  chromeBoundaryFromEnv,
  chromeConnect,
  chromeProvisioningFrom,
  createChromeHandlers,
  helperEnvFor,
  refreshNativeHostManifestIfPaired,
  setCrawlPaused,
  toggleCrawlPaused,
} from "../src/services/protocol-chrome";
import { ProtocolService } from "../src/services/protocol-server";
import { CHROME_EXTENSION_ID_SETTING_KEY } from "../src/services/protocol-types";
import { Store } from "../src/store/store";
import { FakeConnection, type TestCtx, helloMsg, makeConfig, makeCtx, makeHooks } from "./protocol-support";

const REAL_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dealsonar.host";
const REAL_MANIFEST = "/home/u/.config/google-chrome/NativeMessagingHosts/com.dealsonar.host.json";

class NotPaired extends Error {}

/** Records calls; behaves like the native-host provisioning contract without touching disk. */
function fakeProvisioning() {
  const calls = {
    connect: [] as ChromeProvisionRequest[],
    refresh: [] as ChromeProvisionRequest[],
    install: [] as Array<{ sourcePath: string; destPath: string }>,
    route: [] as Array<{ dataDir: string; ipcEndpoint: string; env: Record<string, string | undefined>; platform: string }>,
    clear: [] as Array<{ dataDir: string; platform: string }>,
    order: [] as string[],
  };
  const state = { installFails: false, pairedOnRefresh: true, nativeHostInstalled: true, outcomeId: "hkmjpcenjjebhpjicnbpmogidfcbmbjn", defaultThrows: false, routeError: null as Error | null };
  const outcome = (req: ChromeProvisionRequest): ChromeProvisionOutcome => ({
    nativeHostInstalled: state.nativeHostInstalled,
    manifestPath: req.manifestPath ?? REAL_MANIFEST,
    manifestChanged: true,
    extensionIdToStore: state.outcomeId,
    registryUpdated: false,
    secondaryManifestPaths: [],
  });
  const provisioning: ChromeProvisioning = {
    async connectChrome(req) {
      calls.order.push("connect");
      calls.connect.push(req);
      return outcome(req);
    },
    async refreshChromeIfPaired(req) {
      calls.order.push("refresh");
      calls.refresh.push(req);
      if (!state.pairedOnRefresh) throw new NotPaired();
      return outcome(req);
    },
    defaultManifestPath() {
      if (state.defaultThrows) throw new Error("failed to resolve home/config directory: HOME");
      return REAL_MANIFEST;
    },
    stableHelperPath: (dataDir) => `${dataDir}/bin/dealsonar-native-host`,
    installHelper(options) {
      calls.order.push("install");
      calls.install.push(options);
      if (state.installFails) throw new Error("EACCES");
      return { path: options.destPath, changed: true };
    },
    NotPairedError: NotPaired,
    writeCandidateRoute(options) {
      calls.order.push("route");
      calls.route.push(options);
      if (state.routeError) throw state.routeError;
      return { path: `${options.dataDir}/bin/dealsonar-native-host.route.json`, changed: true };
    },
    clearHelperRoute(dataDir, platform) {
      calls.order.push("clear");
      calls.clear.push({ dataDir, platform });
      return false;
    },
  };
  return { provisioning, calls, state };
}

let ctx: TestCtx;
let service: ProtocolService;
let fake: ReturnType<typeof fakeProvisioning>;

function chromeCtx(over: Parameters<typeof makeConfig>[0] = {}) {
  return { config: makeConfig({ nativeHostBinaryPath: "/Applications/DealSonar.app/Resources/dealsonar-native-host", ...over }), store: ctx.store, isShuttingDown: () => ctx.shuttingDown };
}

function deps(boundary?: ChromeBoundary): ChromeConnectDeps {
  return { protocol: service, provisioning: fake.provisioning, env: { HOME: "/home/u" }, boundary };
}

beforeEach(() => {
  ctx = makeCtx(Store.openInMemory());
  service = new ProtocolService({ hooks: makeHooks(), desktopVersion: "1" });
  fake = fakeProvisioning();
});

describe("chrome_connect (production channel)", () => {
  it("installs the helper to the stable per-user path and points the manifest at it", async () => {
    const result = await chromeConnect(chromeCtx(), deps());
    expect(fake.calls.install).toEqual([
      { sourcePath: "/Applications/DealSonar.app/Resources/dealsonar-native-host", destPath: "/tmp/dealsonar-test/bin/dealsonar-native-host" },
    ]);
    expect(fake.calls.connect[0]).toMatchObject({
      helperPath: "/tmp/dealsonar-test/bin/dealsonar-native-host",
      manifestPath: null,
      platform: "macos",
      registry: undefined,
    });
    expect(result).toEqual({
      native_host_installed: true,
      manifest_path: REAL_MANIFEST,
      extension_connected: false,
      facebook_session: "ok",
      message: MESSAGE_INSTALLED,
    });
  });

  it("persists the clean extension id and feeds it back as the stored id next time", async () => {
    fake.state.outcomeId = "abcdefghijklmnopabcdefghijklmnop";
    await chromeConnect(chromeCtx(), deps(), { extension_id: "  chrome-extension://abcdefghijklmnopabcdefghijklmnop/ " });
    expect(fake.calls.connect[0]!.explicitExtensionId).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop/");
    expect(ctx.store.settings.get(CHROME_EXTENSION_ID_SETTING_KEY)).toBe("abcdefghijklmnopabcdefghijklmnop");

    await chromeConnect(chromeCtx(), deps());
    expect(fake.calls.connect[1]).toMatchObject({ explicitExtensionId: null, storedExtensionId: "abcdefghijklmnopabcdefghijklmnop" });
  });

  it("reports the connected message when an extension is online", async () => {
    const conn = new FakeConnection();
    const session = service.handleConnection(ctx, conn);
    conn.push(helloMsg("p1", 1));
    await session.idle();
    const result = await chromeConnect(chromeCtx(), deps());
    expect([result.extension_connected, result.message]).toEqual([true, MESSAGE_CONNECTED]);
  });

  it("resume_crawl clears a pause, resets the session and tells the extension", async () => {
    const conn = new FakeConnection();
    const session = service.handleConnection(ctx, conn);
    conn.push(helloMsg("p1", 1));
    await session.idle();
    service.hub.crawlPaused = true;
    service.hub.crawlPauseReason = "checkpoint_awaiting_resume";
    service.hub.facebookSession = "checkpoint";

    const result = await chromeConnect(chromeCtx(), deps(), { resume_crawl: true });
    expect(result.facebook_session).toBe("ok");
    expect([service.hub.crawlPaused, service.hub.crawlPauseReason]).toEqual([false, null]);
    expect(conn.ofType("crawl.resume")).toHaveLength(1);

    // Nothing paused: no second resume.
    await chromeConnect(chromeCtx(), deps(), { resume_crawl: true });
    expect(conn.ofType("crawl.resume")).toHaveLength(1);
  });

  it("falls back to an installed helper when the packaged one cannot be copied", async () => {
    fake.state.installFails = true;
    const ok = await chromeConnect(chromeCtx(), { ...deps(), fileExists: () => true });
    expect(ok.native_host_installed).toBe(true);
    expect(fake.calls.connect[0]!.helperPath).toBe("/tmp/dealsonar-test/bin/dealsonar-native-host");

    fake.calls.connect.length = 0;
    const none = await chromeConnect(chromeCtx(), { ...deps(), fileExists: () => false });
    expect(none).toMatchObject({ native_host_installed: false, manifest_path: REAL_MANIFEST, message: MESSAGE_NO_HELPER });
    expect(fake.calls.connect).toHaveLength(0);
  });

  it("without a packaged helper uses only an already installed copy and still stores an explicit id", async () => {
    const result = await chromeConnect(chromeCtx({ nativeHostBinaryPath: null }), { ...deps(), fileExists: () => false }, { extension_id: "abc123" });
    expect(result.native_host_installed).toBe(false);
    expect(fake.calls.install).toHaveLength(0);
    expect(ctx.store.settings.get(CHROME_EXTENSION_ID_SETTING_KEY)).toBe("abc123");
  });

  it("surfaces write failures as native_host_installed=false and manifest errors as validation errors", async () => {
    fake.state.nativeHostInstalled = false;
    expect((await chromeConnect(chromeCtx(), deps())).native_host_installed).toBe(false);

    fake.provisioning.connectChrome = async () => {
      throw Object.assign(new Error("invalid Chrome extension ID 'x y'"), { name: "ManifestError" });
    };
    await expect(chromeConnect(chromeCtx(), deps(), { extension_id: "x y" })).rejects.toMatchObject({
      kind: "validation",
      message: "dữ liệu đầu vào không hợp lệ: invalid Chrome extension ID 'x y'",
    });
  });

  it("maps an unresolvable Chrome location to an internal error and honours shutdown", async () => {
    fake.state.defaultThrows = true;
    await expect(chromeConnect(chromeCtx(), deps())).rejects.toMatchObject({ kind: "internal" });
    ctx.shuttingDown = true;
    await expect(chromeConnect(chromeCtx(), deps())).rejects.toMatchObject({ kind: "shutting_down" });
  });

  it("uses an explicit manifest/registry boundary in production and passes dev ids", async () => {
    const boundary: ChromeBoundary = { manifestPath: "/iso/manifest.json", registryKeyPath: "HKCU\\Software\\X", devExtensionIds: ["devid"] };
    await chromeConnect(chromeCtx(), deps(boundary));
    expect(fake.calls.connect[0]).toMatchObject({ manifestPath: "/iso/manifest.json", registry: { keyPath: "HKCU\\Software\\X" }, discoveredDevIds: ["devid"] });
  });
});

describe("chrome_connect (candidate channel never touches the live profile)", () => {
  it("writes nothing and registers nothing without an explicit isolated manifest path", async () => {
    const result = await chromeConnect(chromeCtx({ channel: "candidate" }), deps());
    expect(result).toMatchObject({ native_host_installed: false, manifest_path: "", message: MESSAGE_CANDIDATE_ISOLATED });
    expect([fake.calls.install, fake.calls.connect]).toEqual([[], []]);
    expect(ctx.store.settings.get(CHROME_EXTENSION_ID_SETTING_KEY)).toBeNull();
    // Even when asked explicitly.
    await chromeConnect(chromeCtx({ channel: "candidate" }), deps(), { extension_id: "abc" });
    expect(fake.calls.connect).toHaveLength(0);
  });

  it("provisions only the isolated manifest and skips the registry unless an isolated key is given", async () => {
    await chromeConnect(chromeCtx({ channel: "candidate", platform: "win32" }), deps({ manifestPath: "C:\\iso\\m.json", registryKeyPath: null, devExtensionIds: [] }));
    expect(fake.calls.connect[0]).toMatchObject({ manifestPath: "C:\\iso\\m.json", registry: null, platform: "windows" });

    await chromeConnect(
      chromeCtx({ channel: "candidate", platform: "win32" }),
      deps({ manifestPath: "C:\\iso\\m.json", registryKeyPath: "HKCU\\Software\\DealSonarTest\\run1", devExtensionIds: [] }),
    );
    expect(fake.calls.connect[1]!.registry).toEqual({ keyPath: "HKCU\\Software\\DealSonarTest\\run1" });
  });

  it("refuses the real Chrome manifest location and the real registry key", async () => {
    await expect(
      chromeConnect(chromeCtx({ channel: "candidate", platform: "linux" }), deps({ manifestPath: REAL_MANIFEST, registryKeyPath: null, devExtensionIds: [] })),
    ).rejects.toBeInstanceOf(CoreError);
    await expect(
      chromeConnect(chromeCtx({ channel: "candidate" }), deps({ manifestPath: "/iso/m.json", registryKeyPath: REAL_KEY.toLowerCase(), devExtensionIds: [] })),
    ).rejects.toMatchObject({ kind: "validation" });
    await expect(chromeConnect(
      chromeCtx({ channel: "candidate", platform: "linux" }),
      deps({ manifestPath: path.posix.dirname(REAL_MANIFEST) + "/unused/../" + path.posix.basename(REAL_MANIFEST), registryKeyPath: null, devExtensionIds: [] }),
    )).rejects.toMatchObject({ kind: "validation" });
    await expect(chromeConnect(
      chromeCtx({ channel: "candidate", platform: "win32" }),
      deps({ manifestPath: "C:\\iso\\m.json", registryKeyPath: REAL_KEY.replace("HKCU", "HKEY_CURRENT_USER"), devExtensionIds: [] }),
    )).rejects.toMatchObject({ kind: "validation" });
    expect(fake.calls.connect).toHaveLength(0);
  });

  it("never refreshes without an isolated boundary", async () => {
    expect(await refreshNativeHostManifestIfPaired(chromeCtx({ channel: "candidate" }), deps())).toBe(false);
    expect(fake.calls.refresh).toHaveLength(0);
    expect(fake.calls.route).toHaveLength(0);
  });

  it("writes nothing, not even a route, without an isolated boundary", async () => {
    await chromeConnect(chromeCtx({ channel: "candidate" }), deps());
    expect([fake.calls.route, fake.calls.clear, fake.calls.order]).toEqual([[], [], []]);
  });
});

describe("candidate per-install helper routing", () => {
  const isolated: ChromeBoundary = { manifestPath: "/iso/manifest.json", registryKeyPath: null, devExtensionIds: [] };

  it("routes the helper to the profile's data dir and endpoint before installing it or writing a manifest", async () => {
    await chromeConnect(chromeCtx({ channel: "candidate", dataDir: "/cand/data", ipcEndpoint: "/cand/data/ipc.sock" }), deps(isolated));
    expect(fake.calls.route).toEqual([{ dataDir: "/cand/data", ipcEndpoint: "/cand/data/ipc.sock", env: { HOME: "/home/u" }, platform: "macos" }]);
    expect(fake.calls.order).toEqual(["route", "install", "connect"]);
    expect(fake.calls.clear).toEqual([]);
  });

  it("carries the Windows candidate pipe and an explicit endpoint override into the route", async () => {
    const host = {
      resolveDesktopDataDir: () => "C:\\cand",
      resolveDesktopIpcEndpoint: (_dir: string, env: Readonly<Record<string, string | undefined>>) => env.DEALSONAR_IPC_PATH ?? "\\\\.\\pipe\\dealsonar-someone",
    };
    const candidate = loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", USERNAME: "An Tu" }, host, "win32");
    await chromeConnect(chromeCtx({ ...candidate }), deps({ ...isolated, manifestPath: "C:\\iso\\m.json" }));
    expect(fake.calls.route.at(-1)).toMatchObject({ dataDir: "C:\\cand", ipcEndpoint: "\\\\.\\pipe\\dealsonar-candidate-An_Tu", platform: "windows" });

    const explicit = loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", DEALSONAR_IPC_PATH: "\\\\.\\pipe\\custom" }, host, "win32");
    await chromeConnect(chromeCtx({ ...explicit }), deps({ ...isolated, manifestPath: "C:\\iso\\m.json" }));
    expect(fake.calls.route.at(-1)).toMatchObject({ ipcEndpoint: "\\\\.\\pipe\\custom" });
  });

  it("touches nothing when the route would collide with production", async () => {
    fake.state.routeError = Object.assign(new Error("refusing to route a helper to the production data dir"), { name: "HelperRouteError" });
    await expect(chromeConnect(chromeCtx({ channel: "candidate" }), deps(isolated), { extension_id: "abc" })).rejects.toMatchObject({ kind: "validation" });
    expect(fake.calls.order).toEqual(["route"]);
    expect(ctx.store.settings.get(CHROME_EXTENSION_ID_SETTING_KEY)).toBeNull();

    fake.calls.order.length = 0;
    await expect(refreshNativeHostManifestIfPaired(chromeCtx({ channel: "candidate" }), deps(isolated))).rejects.toMatchObject({ kind: "validation" });
    expect(fake.calls.order).toEqual(["route"]);
  });

  it("refuses to provision a candidate whose provisioning cannot route it", async () => {
    delete fake.provisioning.writeCandidateRoute;
    await expect(chromeConnect(chromeCtx({ channel: "candidate" }), deps(isolated))).rejects.toMatchObject({ kind: "internal" });
    expect(fake.calls.order).toEqual([]);
  });

  it("refreshes the route with the manifest at startup", async () => {
    ctx.store.settings.set(CHROME_EXTENSION_ID_SETTING_KEY, "abcdefghijklmnopabcdefghijklmnop");
    expect(await refreshNativeHostManifestIfPaired(chromeCtx({ channel: "candidate", dataDir: "/cand/data", ipcEndpoint: "/cand/data/ipc.sock" }), deps(isolated))).toBe(true);
    expect(fake.calls.order).toEqual(["route", "install", "refresh"]);
  });

  it("production never writes a route and clears a leftover one before installing", async () => {
    await chromeConnect(chromeCtx(), deps());
    expect(fake.calls.route).toEqual([]);
    expect(fake.calls.clear).toEqual([{ dataDir: "/tmp/dealsonar-test", platform: "macos" }]);
    expect(fake.calls.order).toEqual(["clear", "install", "connect"]);

    // Provisioning without route support behaves exactly as before for production.
    delete fake.provisioning.clearHelperRoute;
    fake.calls.order.length = 0;
    expect((await chromeConnect(chromeCtx(), deps())).native_host_installed).toBe(true);
    expect(fake.calls.order).toEqual(["install", "connect"]);
  });
});

describe("startup refresh", () => {
  it("rewrites a paired manifest after an app move", async () => {
    ctx.store.settings.set(CHROME_EXTENSION_ID_SETTING_KEY, "abcdefghijklmnopabcdefghijklmnop");
    expect(await refreshNativeHostManifestIfPaired(chromeCtx(), deps())).toBe(true);
    expect(fake.calls.refresh[0]).toMatchObject({
      helperPath: "/tmp/dealsonar-test/bin/dealsonar-native-host",
      storedExtensionId: "abcdefghijklmnopabcdefghijklmnop",
    });
  });

  it("is a no-op when Chrome was never paired, or no helper exists, or the Chrome location is unknown", async () => {
    fake.state.pairedOnRefresh = false;
    expect(await refreshNativeHostManifestIfPaired(chromeCtx(), deps())).toBe(false);

    fake.state.pairedOnRefresh = true;
    expect(await refreshNativeHostManifestIfPaired(chromeCtx({ nativeHostBinaryPath: null }), { ...deps(), fileExists: () => false })).toBe(false);

    fake.state.defaultThrows = true;
    expect(await refreshNativeHostManifestIfPaired(chromeCtx(), deps())).toBe(false);
  });

  it("propagates other provisioning failures", async () => {
    fake.provisioning.refreshChromeIfPaired = async () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(refreshNativeHostManifestIfPaired(chromeCtx(), deps())).rejects.toMatchObject({ kind: "internal" });
  });
});

describe("handlers and pause control", () => {
  it("chrome_connect validates optional args like parse_opt_arg", async () => {
    const handlers = createChromeHandlers(deps());
    const run = (args: Record<string, unknown>) => handlers.chrome_connect!(chromeCtx() as never, args);
    await expect(run({ extension_id: 5 })).rejects.toBeInstanceOf(CommandError);
    await expect(run({ resume_crawl: "yes" })).rejects.toMatchObject({ code: "validation_error", message: expect.stringMatching(/^tham số 'resume_crawl' không hợp lệ/) });
    const ok = (await run({ extension_id: null, resume_crawl: null })) as { native_host_installed: boolean };
    expect(ok.native_host_installed).toBe(true);
    await run({ extension_id: "abc" });
    expect(fake.calls.connect.at(-1)!.explicitExtensionId).toBe("abc");
  });

  it("toggle pauses then resumes and returns the health snapshot", () => {
    const first = toggleCrawlPaused(ctx, service);
    expect(service.hub.crawlPaused).toBe(true);
    expect(first).toEqual({});
    toggleCrawlPaused(ctx, service);
    expect(service.hub.crawlPaused).toBe(false);
  });

  it("refuses to resume during a session problem and during shutdown", () => {
    service.setCrawlPaused(true);
    service.hub.facebookSession = "logged_out";
    expect(() => setCrawlPaused(ctx, service, false)).toThrow(CoreError);
    ctx.shuttingDown = true;
    expect(() => toggleCrawlPaused(ctx, service)).toThrow(/hệ thống đang tắt/);
    expect(createChromeHandlers(deps())["backend:toggle_crawl_paused"]).toBeTypeOf("function");
  });
});

describe("explicit env boundary", () => {
  it("reads isolation settings only from the given env", () => {
    expect(chromeBoundaryFromEnv({})).toEqual({ manifestPath: null, registryKeyPath: null, devExtensionIds: [] });
    expect(
      chromeBoundaryFromEnv({
        [CHROME_BOUNDARY_ENV.manifestPath]: " /iso/m.json ",
        [CHROME_BOUNDARY_ENV.registryKey]: "HKCU\\Software\\DealSonarTest\\r",
        [CHROME_BOUNDARY_ENV.devExtensionIds]: "a, b ,,c",
      }),
    ).toEqual({ manifestPath: "/iso/m.json", registryKeyPath: "HKCU\\Software\\DealSonarTest\\r", devExtensionIds: ["a", "b", "c"] });
  });

  it("keeps the Windows candidate pipe identical for the backend and a synthetic helper", () => {
    const host = {
      resolveDesktopDataDir: (env: Readonly<Record<string, string | undefined>>) => env.DEALSONAR_DATA_DIR ?? "C:\\data",
      // Windows ignores the data dir; only an explicit pipe path counts (same as the Rust endpoint).
      resolveDesktopIpcEndpoint: (_dir: string, env: Readonly<Record<string, string | undefined>>) => env.DEALSONAR_IPC_PATH ?? "\\\\.\\pipe\\dealsonar-someone",
    };
    const candidate = loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", USERNAME: "An Tu" }, host, "win32");
    expect(candidate.ipcEndpoint).toBe(candidateWindowsPipe("An Tu"));
    expect(candidate.ipcEndpoint).toBe("\\\\.\\pipe\\dealsonar-candidate-An_Tu");
    expect(helperEnvFor(candidate)).toEqual({ DEALSONAR_DATA_DIR: candidate.dataDir, DEALSONAR_IPC_PATH: "\\\\.\\pipe\\dealsonar-candidate-An_Tu" });

    // An explicit pipe wins, and production keeps its own pipe.
    expect(loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", DEALSONAR_IPC_PATH: "\\\\.\\pipe\\custom" }, host, "win32").ipcEndpoint).toBe("\\\\.\\pipe\\custom");
    expect(loadBackendConfig({ USERNAME: "x" }, host, "win32").ipcEndpoint).not.toContain("candidate");
  });
});

// ── real native-host provisioning on a throwaway directory (skipped when the package is unavailable) ──

type NativeHostModule = {
  connectChrome: ChromeProvisioning["connectChrome"];
  refreshChromeIfPaired: ChromeProvisioning["refreshChromeIfPaired"];
  chromeManifestPath: (env: Record<string, string | undefined>, platform: "macos" | "linux" | "windows") => string;
  stableHelperPath: ChromeProvisioning["stableHelperPath"];
  installHelper: ChromeProvisioning["installHelper"];
  NotPairedError: ChromeProvisioning["NotPairedError"];
  writeCandidateRoute: NonNullable<ChromeProvisioning["writeCandidateRoute"]>;
  clearHelperRoute: NonNullable<ChromeProvisioning["clearHelperRoute"]>;
};

let nativeHost: NativeHostModule | null = null;
try {
  // A variable specifier keeps `tsc` from pulling the whole native-host package into this project.
  const specifier = "../../native-host/src/index";
  nativeHost = (await import(/* @vite-ignore */ specifier)) as unknown as NativeHostModule;
} catch {
  nativeHost = null;
}

describe.skipIf(nativeHost === null)("with the real native-host provisioning", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-chrome-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves existing allowed origins, drops the legacy placeholder and refreshes the helper path", async () => {
    const provisioning = chromeProvisioningFrom(nativeHost!);
    const dataDir = path.join(tmp, "data");
    const packaged = path.join(tmp, "Resources", "dealsonar-native-host");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manifestPath = path.join(tmp, "iso", "com.dealsonar.host.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "com.dealsonar.host",
        description: "DealSonar native host",
        path: "/old/app/dealsonar-native-host",
        type: "stdio",
        allowed_origins: ["chrome-extension://dealsonarchromeextensionid000001/", "chrome-extension://customextidcustomextidcustomext/"],
      }),
    );

    const config = makeConfig({ channel: "candidate", dataDir, nativeHostBinaryPath: packaged, platform: "linux" });
    const d: ChromeConnectDeps = {
      protocol: service,
      provisioning,
      env: { HOME: path.join(tmp, "home") },
      boundary: { manifestPath, registryKeyPath: null, devExtensionIds: [] },
    };
    const context = { config, store: ctx.store, isShuttingDown: () => false };

    const result = await chromeConnect(context, d);
    expect(result).toMatchObject({ native_host_installed: true, manifest_path: manifestPath });

    const stable = path.join(dataDir, "bin", "dealsonar-native-host");
    expect(fs.existsSync(stable)).toBe(true);
    const written = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { path: string; allowed_origins: string[] };
    expect(written.path).toBe(stable);
    expect(written.allowed_origins).toContain("chrome-extension://customextidcustomextidcustomext/");
    expect(written.allowed_origins).toContain("chrome-extension://hkmjpcenjjebhpjicnbpmogidfcbmbjn/");
    expect(written.allowed_origins.some((o) => o.includes("dealsonarchromeextensionid000001"))).toBe(false);
    expect(ctx.store.settings.get(CHROME_EXTENSION_ID_SETTING_KEY)).toBe("customextidcustomextidcustomext");

    // Moving the app: the next startup refresh keeps every origin and rewrites only the path.
    const moved = path.join(tmp, "NewResources", "dealsonar-native-host");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.writeFileSync(moved, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const changed = await refreshNativeHostManifestIfPaired({ ...context, config: { ...config, nativeHostBinaryPath: moved } }, d);
    expect(changed).toBe(false); // helper bytes changed, but the manifest already points at the stable path
    expect(fs.readFileSync(stable, "utf8")).toContain("exit 1");
    const again = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { path: string; allowed_origins: string[] };
    expect(again.allowed_origins).toEqual(written.allowed_origins);
  });

  it("never writes outside the isolated location when the candidate has no boundary", async () => {
    const home = path.join(tmp, "home");
    const result = await chromeConnect(
      { config: makeConfig({ channel: "candidate", dataDir: path.join(tmp, "data"), platform: "linux" }), store: ctx.store, isShuttingDown: () => false },
      { protocol: service, provisioning: chromeProvisioningFrom(nativeHost!), env: { HOME: home } },
    );
    expect(result.native_host_installed).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("routes the candidate helper to its profile, and production provisioning removes the route", async () => {
    const provisioning = chromeProvisioningFrom(nativeHost!);
    const dataDir = path.join(tmp, "data");
    const ipcEndpoint = path.join(dataDir, "ipc.sock");
    const packaged = path.join(tmp, "Resources", "dealsonar-native-host");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manifestPath = path.join(tmp, "iso", "com.dealsonar.host.json");
    const d: ChromeConnectDeps = {
      protocol: service,
      provisioning,
      env: { HOME: path.join(tmp, "home") },
      boundary: { manifestPath, registryKeyPath: null, devExtensionIds: [] },
    };
    const base = { dataDir, ipcEndpoint, nativeHostBinaryPath: packaged, platform: "linux" as const };
    const routeFile = path.join(dataDir, "bin", "dealsonar-native-host.route.json");

    await chromeConnect({ config: makeConfig({ ...base, channel: "candidate" }), store: ctx.store, isShuttingDown: () => false }, d);
    expect(JSON.parse(fs.readFileSync(routeFile, "utf8"))).toEqual({ version: 1, channel: "candidate", dataDir, ipcEndpoint });
    expect(fs.existsSync(path.join(dataDir, "bin", "dealsonar-native-host"))).toBe(true);

    await chromeConnect({ config: makeConfig({ ...base, channel: "production" }), store: ctx.store, isShuttingDown: () => false }, d);
    expect(fs.existsSync(routeFile)).toBe(false);
  });

  it("refuses to install or route a candidate into the production data dir", async () => {
    const home = path.join(tmp, "home");
    const productionDir = path.join(home, ".local", "share", "dealsonar");
    const manifestPath = path.join(tmp, "iso", "com.dealsonar.host.json");
    const packaged = path.join(tmp, "dealsonar-native-host");
    fs.writeFileSync(packaged, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(
      chromeConnect(
        { config: makeConfig({ channel: "candidate", dataDir: productionDir, nativeHostBinaryPath: packaged, platform: "linux" }), store: ctx.store, isShuttingDown: () => false },
        { protocol: service, provisioning: chromeProvisioningFrom(nativeHost!), env: { HOME: home }, boundary: { manifestPath, registryKeyPath: null, devExtensionIds: [] } },
      ),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(fs.existsSync(productionDir)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });
});
