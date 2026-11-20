// `chrome_connect`, startup manifest refresh and crawl pause control: a port of
// `crates/core/src/service/chrome.rs` on top of the native-host package's provisioning.
//
// Differences from the Rust service that are deliberate:
//  * The helper is installed to a stable per-user path (`<dataDir>/bin/dealsonar-native-host`)
//    and the manifest always points there, never at the app bundle (which moves on update and may
//    sit inside an ASAR archive or an AppImage mount).
//  * The `candidate` channel never registers against the live Chrome profile. Without an
//    explicit isolated manifest path (`DEALSONAR_CHROME_MANIFEST_PATH`) it writes nothing; with
//    one, it refuses the real default manifest location and the real Windows registry key.
//  * The environment is passed in explicitly. Nothing here reads `process.env`.
//
// `@dealsonar/native-host` is reached through the structural `ChromeProvisioning` view (build it
// with `chromeProvisioningFrom`), like `HostBindings`, so this module typechecks without it.

import * as fs from "node:fs";

import { type BackendConfig, type Env, hostPlatform } from "../backend/config";
import type { HostPlatform } from "../backend/host";
import type { CommandHandler, HandlerTable, RuntimeContext } from "../backend/runtime";
import { type Args, CommandError, CoreError, optArg } from "../backend/wire";
import type { ProtocolService } from "./protocol-server";
import { CHROME_EXTENSION_ID_SETTING_KEY, type FacebookSessionState } from "./protocol-types";

/** Real Chrome registry key; `candidate` must never write it (`WINDOWS_CHROME_REGISTRY_KEY`). */
const REAL_CHROME_REGISTRY_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dealsonar.host";

export interface ChromeProvisionRequest {
  /** Absolute path of the stable installed helper. */
  helperPath: string;
  /** Override manifest location. Disables secondary Chromium browsers. */
  manifestPath?: string | null;
  explicitExtensionId?: string | null;
  storedExtensionId?: string | null;
  discoveredDevIds?: readonly string[];
  env: Env;
  platform: HostPlatform;
  /** Windows registry options; `null` skips registry writes, `undefined` uses the real key. */
  registry?: { keyPath?: string } | null;
}

export interface ChromeProvisionOutcome {
  nativeHostInstalled: boolean;
  manifestPath: string;
  manifestChanged: boolean;
  /** Clean extension id to persist as `chrome.extension_id`. */
  extensionIdToStore: string | null;
  registryUpdated: boolean;
  secondaryManifestPaths: string[];
}

/** Structural view of the parts of `@dealsonar/native-host` this module uses. */
export interface ChromeProvisioning {
  connectChrome(request: ChromeProvisionRequest): Promise<ChromeProvisionOutcome>;
  refreshChromeIfPaired(request: ChromeProvisionRequest): Promise<ChromeProvisionOutcome>;
  /** `chromeManifestPath(env, platform)`: the real default location. Throws when unresolvable. */
  defaultManifestPath(env: Env, platform: HostPlatform): string;
  /** `stableHelperPath(dataDir, platform)`. */
  stableHelperPath(dataDir: string, platform: HostPlatform): string;
  /** `installHelper({ sourcePath, destPath })`. */
  installHelper(options: { sourcePath: string; destPath: string }): { path: string; changed: boolean };
  /** `NotPairedError` thrown by `refreshChromeIfPaired`. */
  NotPairedError: new () => Error;
}

/** Builds `ChromeProvisioning` from the real package export surface. */
export function chromeProvisioningFrom(mod: {
  connectChrome: ChromeProvisioning["connectChrome"];
  refreshChromeIfPaired: ChromeProvisioning["refreshChromeIfPaired"];
  chromeManifestPath: (env: Env, platform: HostPlatform) => string;
  stableHelperPath: ChromeProvisioning["stableHelperPath"];
  installHelper: ChromeProvisioning["installHelper"];
  NotPairedError: ChromeProvisioning["NotPairedError"];
}): ChromeProvisioning {
  return {
    connectChrome: mod.connectChrome,
    refreshChromeIfPaired: mod.refreshChromeIfPaired,
    defaultManifestPath: mod.chromeManifestPath,
    stableHelperPath: mod.stableHelperPath,
    installHelper: mod.installHelper,
    NotPairedError: mod.NotPairedError,
  };
}

/** Explicit isolation settings, normally read once from the environment. */
export interface ChromeBoundary {
  /** `chrome_manifest_path` override. Required for the candidate channel to provision at all. */
  manifestPath: string | null;
  /** Isolated `HKCU\...` key (Windows). `null` = the real Chrome key for production, none for candidate. */
  registryKeyPath: string | null;
  /** Ids of unpacked developer builds to also allow. */
  devExtensionIds: readonly string[];
}

export const CHROME_BOUNDARY_ENV = {
  manifestPath: "DEALSONAR_CHROME_MANIFEST_PATH",
  registryKey: "DEALSONAR_CHROME_REGISTRY_KEY",
  devExtensionIds: "DEALSONAR_DEV_EXTENSION_IDS",
} as const;

export function chromeBoundaryFromEnv(env: Env): ChromeBoundary {
  const nonEmpty = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);
  return {
    manifestPath: nonEmpty(env[CHROME_BOUNDARY_ENV.manifestPath]),
    registryKeyPath: nonEmpty(env[CHROME_BOUNDARY_ENV.registryKey]),
    devExtensionIds: (env[CHROME_BOUNDARY_ENV.devExtensionIds] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  };
}

/**
 * Environment for a helper process (relay or MCP) that must reach the SAME endpoint this backend
 * bound. Chrome-launched helpers cannot receive env, so synthetic tests pass this explicitly; it
 * keeps the Windows candidate pipe (`\\.\pipe\dealsonar-candidate-<user>`) consistent.
 */
export function helperEnvFor(config: Pick<BackendConfig, "dataDir" | "ipcEndpoint">): Record<string, string> {
  return { DEALSONAR_DATA_DIR: config.dataDir, DEALSONAR_IPC_PATH: config.ipcEndpoint };
}

export interface ChromeConnectDeps {
  protocol: ProtocolService;
  provisioning: ChromeProvisioning;
  /** Environment used for home/config directory resolution. Pass it explicitly. */
  env: Env;
  boundary?: ChromeBoundary;
  fileExists?: (path: string) => boolean;
  logger?: (message: string) => void;
}

export interface ChromeConnectOptions {
  extension_id?: string | null;
  resume_crawl?: boolean;
}

export interface ChromeConnectResult {
  native_host_installed: boolean;
  manifest_path: string;
  extension_connected: boolean;
  facebook_session: FacebookSessionState;
  message: string;
}

export const MESSAGE_CONNECTED = "Đã kết nối thành công với DealSonar Chrome Extension";
export const MESSAGE_INSTALLED =
  "Đã cài đặt cấu hình Native Messaging cho Chrome; vui lòng mở tiện ích DealSonar trên trình duyệt";
export const MESSAGE_CANDIDATE_ISOLATED =
  "Bản thử nghiệm (candidate) không đăng ký Native Messaging với hồ sơ Chrome thật. Đặt DEALSONAR_CHROME_MANIFEST_PATH tới một thư mục cô lập để thử.";
export const MESSAGE_NO_HELPER = "Chưa có tệp native host để cài đặt; không thể đăng ký Native Messaging cho Chrome";

type ChromeContext = Pick<RuntimeContext, "config" | "store" | "isShuttingDown">;

interface Target {
  /** Manifest override to pass to provisioning (null = default location + secondary browsers). */
  override: string | null;
  /** Where the manifest lives, for the result. */
  displayPath: string;
  registry: { keyPath?: string } | null | undefined;
}

type TargetResolution = { kind: "target"; target: Target } | { kind: "isolated" };

const samePath = (a: string, b: string, platform: HostPlatform): boolean =>
  platform === "windows" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Decide where the manifest goes, enforcing the candidate boundary.
 * Throws `CoreError.internal` when the real default location cannot be resolved (as Rust does).
 */
function resolveTarget(ctx: ChromeContext, deps: ChromeConnectDeps): TargetResolution {
  const { config } = ctx;
  const boundary = deps.boundary ?? { manifestPath: null, registryKeyPath: null, devExtensionIds: [] };
  const platform = hostPlatform(config.platform);

  if (config.channel === "candidate") {
    if (boundary.manifestPath === null) return { kind: "isolated" };
    let real: string | null = null;
    try {
      real = deps.provisioning.defaultManifestPath(deps.env, platform);
    } catch {
      /* cannot resolve the real location: nothing to collide with */
    }
    if (real !== null && samePath(real, boundary.manifestPath, platform)) {
      throw CoreError.validation("candidate không được ghi vào vị trí Native Messaging của Chrome thật");
    }
    if (boundary.registryKeyPath !== null && boundary.registryKeyPath.toLowerCase() === REAL_CHROME_REGISTRY_KEY.toLowerCase()) {
      throw CoreError.validation("candidate không được ghi vào khoá registry Native Messaging của Chrome thật");
    }
    return {
      kind: "target",
      target: {
        override: boundary.manifestPath,
        displayPath: boundary.manifestPath,
        // No registry unless an explicit isolated key was supplied.
        registry: boundary.registryKeyPath === null ? null : { keyPath: boundary.registryKeyPath },
      },
    };
  }

  let displayPath: string;
  if (boundary.manifestPath !== null) displayPath = boundary.manifestPath;
  else {
    try {
      displayPath = deps.provisioning.defaultManifestPath(deps.env, platform);
    } catch (err) {
      throw CoreError.internal(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    kind: "target",
    target: {
      override: boundary.manifestPath,
      displayPath,
      registry: boundary.registryKeyPath === null ? undefined : { keyPath: boundary.registryKeyPath },
    },
  };
}

/**
 * Ensure the stable per-user helper exists and return its path, or null when there is neither a
 * packaged helper to install nor an already-installed copy.
 */
function ensureStableHelper(ctx: ChromeContext, deps: ChromeConnectDeps, platform: HostPlatform): string | null {
  const { config } = ctx;
  const exists = deps.fileExists ?? fs.existsSync;
  const dest = deps.provisioning.stableHelperPath(config.dataDir, platform);
  const source = config.nativeHostBinaryPath;
  if (source !== null) {
    try {
      return deps.provisioning.installHelper({ sourcePath: source, destPath: dest }).path;
    } catch (err) {
      deps.logger?.(`helper install failed: ${err instanceof Error ? err.message : String(err)}`);
      return exists(dest) ? dest : null;
    }
  }
  return exists(dest) ? dest : null;
}

const hostPlatformOf = hostPlatform;

function toCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // `NativeHostManifest::new_with_origins` failures (invalid extension id) are validation errors.
  if (err instanceof Error && err.name === "ManifestError") return CoreError.validation(message);
  return CoreError.internal(message);
}

function persistExtensionId(ctx: ChromeContext, id: string | null): void {
  if (id === null) return;
  try {
    ctx.store.settings.set(CHROME_EXTENSION_ID_SETTING_KEY, id);
  } catch {
    /* `let _ =` in Rust */
  }
}

/** `CoreService::chrome_connect`. User-initiated only: callers must be the `chrome_connect` command. */
export async function chromeConnect(
  ctx: ChromeContext,
  deps: ChromeConnectDeps,
  options: ChromeConnectOptions | null = null,
): Promise<ChromeConnectResult> {
  if (ctx.isShuttingDown()) throw CoreError.shuttingDown();
  const opts = options ?? {};
  const { protocol } = deps;
  const platform = hostPlatformOf(ctx.config.platform);
  const now = protocol.now();

  if (opts.resume_crawl === true) protocol.resumeCrawlAfterReconnect();

  const resolution = resolveTarget(ctx, deps);
  const finish = (installed: boolean, manifestPath: string, message?: string): ChromeConnectResult => {
    protocol.hooks.emitHealthIfChanged(now);
    const snap = protocol.hub.healthSnapshot(now);
    return {
      native_host_installed: installed,
      manifest_path: manifestPath,
      extension_connected: snap.extension_connected,
      facebook_session: snap.facebook_session,
      message: message ?? (snap.extension_connected ? MESSAGE_CONNECTED : MESSAGE_INSTALLED),
    };
  };

  if (resolution.kind === "isolated") return finish(false, "", MESSAGE_CANDIDATE_ISOLATED);

  const { target } = resolution;
  const explicit = opts.extension_id?.trim() ? opts.extension_id.trim() : null;
  const helperPath = ensureStableHelper(ctx, deps, platform);
  if (helperPath === null) {
    persistExtensionId(ctx, explicit);
    return finish(false, target.displayPath, MESSAGE_NO_HELPER);
  }

  let outcome: ChromeProvisionOutcome;
  try {
    outcome = await deps.provisioning.connectChrome({
      helperPath,
      manifestPath: target.override,
      explicitExtensionId: explicit,
      storedExtensionId: ctx.store.settings.get<string>(CHROME_EXTENSION_ID_SETTING_KEY),
      discoveredDevIds: deps.boundary?.devExtensionIds ?? [],
      env: deps.env,
      platform,
      registry: target.registry,
    });
  } catch (err) {
    throw toCoreError(err);
  }
  persistExtensionId(ctx, outcome.extensionIdToStore);
  return finish(outcome.nativeHostInstalled, outcome.manifestPath);
}

/**
 * Startup check (`03-desktop.md §2`): when Chrome was paired before (saved id or an existing
 * manifest), rewrite the manifest after an app update/move. Resolves true when it was written,
 * false when unchanged, not paired, or provisioning is isolated/unavailable.
 */
export async function refreshNativeHostManifestIfPaired(ctx: ChromeContext, deps: ChromeConnectDeps): Promise<boolean> {
  const platform = hostPlatformOf(ctx.config.platform);
  let resolution: TargetResolution;
  try {
    resolution = resolveTarget(ctx, deps);
  } catch {
    return false;
  }
  if (resolution.kind === "isolated") return false;
  const helperPath = ensureStableHelper(ctx, deps, platform);
  if (helperPath === null) return false;

  let outcome: ChromeProvisionOutcome;
  try {
    outcome = await deps.provisioning.refreshChromeIfPaired({
      helperPath,
      manifestPath: resolution.target.override,
      storedExtensionId: ctx.store.settings.get<string>(CHROME_EXTENSION_ID_SETTING_KEY),
      discoveredDevIds: deps.boundary?.devExtensionIds ?? [],
      env: deps.env,
      platform,
      registry: resolution.target.registry,
    });
  } catch (err) {
    if (err instanceof deps.provisioning.NotPairedError) return false;
    throw toCoreError(err);
  }
  persistExtensionId(ctx, outcome.extensionIdToStore);
  return outcome.manifestChanged;
}

/** `set_crawl_paused` (tray). Returns the refreshed health snapshot. */
export function setCrawlPaused(ctx: Pick<RuntimeContext, "isShuttingDown">, protocol: ProtocolService, paused: boolean): unknown {
  if (ctx.isShuttingDown()) throw CoreError.shuttingDown();
  protocol.setCrawlPaused(paused);
  return protocol.hooks.emitHealthIfChanged(protocol.now());
}

/** `toggle_crawl_paused`. */
export function toggleCrawlPaused(ctx: Pick<RuntimeContext, "isShuttingDown">, protocol: ProtocolService): unknown {
  return setCrawlPaused(ctx, protocol, !protocol.hub.crawlPaused);
}

function parseOptional<T>(args: Args, key: string, check: (v: unknown) => v is T, expected: string): T | null {
  const v = optArg<unknown>(args, key);
  if (v === null) return null;
  if (!check(v)) {
    throw new CommandError("validation_error", `tham số '${key}' không hợp lệ: invalid type, expected ${expected}`);
  }
  return v;
}

/** Command handlers ready to merge into the handler registry. */
export function createChromeHandlers(deps: ChromeConnectDeps): HandlerTable {
  const chromeConnectHandler: CommandHandler = async (ctx, args) => {
    const extensionId = parseOptional(args, "extension_id", (v): v is string => typeof v === "string", "a string");
    const resume = parseOptional(args, "resume_crawl", (v): v is boolean => typeof v === "boolean", "a boolean");
    return chromeConnect(ctx, deps, { extension_id: extensionId, resume_crawl: resume ?? false });
  };
  return {
    chrome_connect: chromeConnectHandler,
    "backend:toggle_crawl_paused": (ctx) => toggleCrawlPaused(ctx, deps.protocol),
  };
}
