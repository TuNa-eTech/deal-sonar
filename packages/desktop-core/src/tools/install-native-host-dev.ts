// Developer installer for the Chrome Native Messaging host (`com.dealsonar.host`).
//
// Port of scripts/install-native-host-dev.sh from the Cargo-built `dealsonar-native-host` to the
// Node 24 single-executable helper of `@dealsonar/native-host`:
//
//   1. builds the helper with `packages/native-host/scripts/build-sea.mjs` (needs Node 24), unless
//      `DEALSONAR_NATIVE_HOST_BIN` points at an already built helper;
//   2. registers it with the production provisioning code (`connectChrome`): the manifest
//      `com.dealsonar.host.json` and, on Windows, the HKCU registry key.
//
// Same UX as the shell script: `<chrome-extension-id> [--release]`, the id may be pasted as
// `chrome-extension://<id>/`, and `CHROME_NATIVE_HOSTS_DIR` redirects the manifest to another
// directory. The manifest points straight at the freshly built helper (no copy to the data dir).
//
// Isolation. Without `CHROME_NATIVE_HOSTS_DIR` the real Chrome registration is written, exactly like
// the Rust-era script. With it, nothing outside that directory is touched: other Chromium browsers
// are never registered, and on Windows the registry is skipped unless an isolated per-user key is
// given in `DEALSONAR_CHROME_REGISTRY_KEY` (the real Chrome key is refused in that case).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Env } from "../backend/config";
import type { HostPlatform } from "../backend/host";
import type { ChromeProvisionOutcome, ChromeProvisionRequest } from "../services/protocol-chrome";

export const HOSTS_DIR_ENV = "CHROME_NATIVE_HOSTS_DIR";
export const REGISTRY_KEY_ENV = "DEALSONAR_CHROME_REGISTRY_KEY";
export const PREBUILT_HELPER_ENV = "DEALSONAR_NATIVE_HOST_BIN";

/** Targets `build-sea.mjs` can build for the running host. */
const SEA_TARGETS: readonly string[] = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];

/** The parts of `@dealsonar/native-host` this tool uses. */
export interface DevProvisioning {
  connectChrome(request: ChromeProvisionRequest): Promise<ChromeProvisionOutcome & { manifest?: { allowed_origins: string[] } }>;
  chromeManifestPath(env: Env, platform: HostPlatform): string;
  helperFileName(platform: HostPlatform): string;
  NATIVE_HOST_MANIFEST_FILENAME: string;
  WINDOWS_CHROME_REGISTRY_KEY: string;
}

export interface InstallDevIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface InstallDevOptions {
  /** Repository root (the directory holding `packages/`). */
  repoRoot: string;
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  io?: Partial<InstallDevIo>;
  /** Loads the provisioning module. Default: `@dealsonar/native-host`. */
  loadProvisioning?: () => Promise<DevProvisioning>;
  /** Runs `build-sea.mjs`. Default: spawns it with the running Node. */
  buildHelper?: (request: { script: string; target: string; outDir: string; cwd: string }) => void;
  fileExists?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
}

export function installUsage(platform: NodeJS.Platform = process.platform): string {
  const script = platform === "win32" ? "./scripts/install-native-host-dev.ps1" : "./scripts/install-native-host-dev.sh";
  return `\
Usage: ${script} <chrome-extension-id> [--release]

Builds the \`dealsonar-native-host\` Node single-executable helper (Node 24 required) and
writes \`com.dealsonar.host.json\` to Chrome's user-level NativeMessagingHosts location
on macOS, Linux or Windows (on Windows also the HKCU registry key that points at it).

Arguments:
  <chrome-extension-id>  Extension ID from chrome://extensions (e.g. abcdefghijklmnopabcdefghijklmnop)
  --release              Accepted for compatibility. The helper is always one Node SEA build.

Environment:
  CHROME_NATIVE_HOSTS_DIR         Optional custom output directory override. Nothing outside it is
                                  written, and no other browser is registered.
  DEALSONAR_CHROME_REGISTRY_KEY   Windows only: per-user registry key (HKCU\\...) to write instead of
                                  the real Chrome key. Required to register while CHROME_NATIVE_HOSTS_DIR is set.
  DEALSONAR_NATIVE_HOST_BIN       Optional path of an already built helper; skips the build.
`;
}

export type InstallArgsResult =
  | { kind: "help" }
  | { kind: "usage-error"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ok"; extensionId: string };

/** Mirrors the argument loop of the shell script. `--release` has no effect on the Node build. */
export function parseInstallArgs(args: readonly string[]): InstallArgsResult {
  if (args.length < 1) return { kind: "usage-error", message: "" };
  let extId = "";
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "-h" || lower === "--help" || lower === "-help") return { kind: "help" };
    if (lower === "--release" || lower === "-release") continue;
    if (arg.startsWith("-")) return { kind: "usage-error", message: `Error: unknown flag '${arg}'` };
    if (extId !== "") return { kind: "usage-error", message: `Error: unexpected positional argument '${arg}'` };
    extId = arg;
  }
  // Strip an optional chrome-extension:// prefix and trailing slash if pasted directly.
  if (extId.startsWith("chrome-extension://")) extId = extId.slice("chrome-extension://".length);
  if (extId.endsWith("/")) extId = extId.slice(0, -1);
  if (extId === "" || !/^[a-zA-Z0-9]+$/.test(extId)) {
    return { kind: "error", message: `Error: invalid Chrome extension ID '${extId}' (expected alphanumeric ID).` };
  }
  return { kind: "ok", extensionId: extId };
}

const hostPlatformOf = (platform: NodeJS.Platform): HostPlatform | null =>
  platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;

const canonicalRegistryKey = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .replace(/^hkey_current_user(?=\\)/, "hkcu")
    .replace(/\\+$/, "");

const nonEmpty = (v: string | undefined): string | null => (v !== undefined && v.trim() !== "" ? v : null);

function defaultBuildHelper(request: { script: string; target: string; outDir: string; cwd: string }): void {
  execFileSync(process.execPath, [request.script, "--target", request.target, "--out", request.outDir], {
    cwd: request.cwd,
    stdio: "inherit",
  });
}

function defaultIsExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultLoadProvisioning(): Promise<DevProvisioning> {
  return (await import("@dealsonar/native-host")) as unknown as DevProvisioning;
}

/** Runs the installer. Resolves to the process exit code. */
export async function runInstallNativeHostDev(args: readonly string[], options: InstallDevOptions): Promise<number> {
  const env = options.env ?? process.env;
  const nodePlatform = options.platform ?? process.platform;
  const io: InstallDevIo = {
    stdout: options.io?.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: options.io?.stderr ?? ((text) => void process.stderr.write(text)),
  };
  const usage = installUsage(nodePlatform);
  const fail = (message: string): number => {
    io.stderr(`${message}\n`);
    return 1;
  };

  const parsed = parseInstallArgs(args);
  switch (parsed.kind) {
    case "help":
      io.stdout(usage);
      return 0;
    case "usage-error":
      if (parsed.message !== "") io.stderr(`${parsed.message}\n`);
      io.stderr(usage);
      return 1;
    case "error":
      return fail(parsed.message);
    case "ok":
      break;
  }
  const extensionId = parsed.extensionId;

  const platform = hostPlatformOf(nodePlatform);
  if (platform === null) {
    return fail(`Error: unsupported OS '${nodePlatform}'. This script supports macOS, Linux and Windows.`);
  }

  const hostsDirOverride = nonEmpty(env[HOSTS_DIR_ENV]);
  const registryKey = nonEmpty(env[REGISTRY_KEY_ENV])?.trim() ?? null;
  const exists = options.fileExists ?? fs.existsSync;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const paths = platform === "windows" ? path.win32 : path.posix;

  if (platform === "windows" && registryKey !== null && !/^HKCU\\[^\0]+$/i.test(registryKey)) {
    return fail(`Error: ${REGISTRY_KEY_ENV} must be a per-user key under HKCU\\ (got '${registryKey}').`);
  }

  let provisioning: DevProvisioning;
  try {
    provisioning = await (options.loadProvisioning ?? defaultLoadProvisioning)();
  } catch (e) {
    return fail(`Error: cannot load @dealsonar/native-host: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (
    platform === "windows" &&
    hostsDirOverride !== null &&
    registryKey !== null &&
    canonicalRegistryKey(registryKey) === canonicalRegistryKey(provisioning.WINDOWS_CHROME_REGISTRY_KEY)
  ) {
    return fail(
      `Error: ${REGISTRY_KEY_ENV} is the real Chrome key; refusing to point it at an isolated ${HOSTS_DIR_ENV}. ` +
        "Use a key such as HKCU\\Software\\DealSonarTest\\dev.",
    );
  }

  // 1. The helper.
  const prebuilt = nonEmpty(env[PREBUILT_HELPER_ENV])?.trim() ?? null;
  let helperPath: string;
  if (prebuilt !== null) {
    helperPath = path.resolve(prebuilt);
    io.stdout(`Using prebuilt dealsonar-native-host from ${PREBUILT_HELPER_ENV}: ${helperPath}\n`);
  } else {
    const target = `${nodePlatform}-${options.arch ?? process.arch}`;
    if (!SEA_TARGETS.includes(target)) {
      return fail(
        `Error: no Node SEA build target for '${target}' (supported: ${SEA_TARGETS.join(", ")}). ` +
          `Build a helper yourself and set ${PREBUILT_HELPER_ENV}.`,
      );
    }
    const nodeMajor = Number((options.nodeVersion ?? process.versions.node).split(".")[0]);
    if (nodeMajor !== 24) {
      return fail(
        `Error: building the native host helper requires Node 24 (running ${options.nodeVersion ?? process.versions.node}). ` +
          `Switch to Node 24 (for example \`nvm use 24\`) or set ${PREBUILT_HELPER_ENV} to a built helper.`,
      );
    }
    const nativeHostRoot = path.join(options.repoRoot, "packages", "native-host");
    const outDir = path.join(nativeHostRoot, "dist-sea");
    io.stdout(`Building dealsonar-native-host (Node SEA, ${target})...\n`);
    try {
      (options.buildHelper ?? defaultBuildHelper)({
        script: path.join(nativeHostRoot, "scripts", "build-sea.mjs"),
        target,
        outDir,
        cwd: options.repoRoot,
      });
    } catch (e) {
      return fail(`Error: building the native host helper failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    helperPath = path.join(outDir, target, provisioning.helperFileName(platform));
  }

  if (!exists(helperPath) || !isExecutable(helperPath)) {
    return fail(`Error: expected executable not found at '${helperPath}'`);
  }

  // 2. Registration. The manifest path is always explicit, which also limits provisioning to
  //    Chrome itself (no secondary Chromium browsers), as the shell script did.
  let manifestPath: string;
  if (hostsDirOverride !== null) {
    manifestPath = paths.join(paths.resolve(hostsDirOverride), provisioning.NATIVE_HOST_MANIFEST_FILENAME);
  } else {
    try {
      manifestPath = provisioning.chromeManifestPath(env, platform);
    } catch (e) {
      return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Windows registry: the real key for a default install, nothing for an isolated directory
  // unless an isolated per-user key was given. Other platforms have no registry.
  let registry: ChromeProvisionRequest["registry"];
  if (platform !== "windows") registry = null;
  else if (registryKey !== null) registry = { keyPath: registryKey };
  else registry = hostsDirOverride !== null ? null : undefined;

  let outcome: Awaited<ReturnType<DevProvisioning["connectChrome"]>>;
  try {
    outcome = await provisioning.connectChrome({
      helperPath,
      manifestPath,
      explicitExtensionId: extensionId,
      storedExtensionId: null,
      discoveredDevIds: [],
      env,
      platform,
      registry,
    });
  } catch (e) {
    return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!outcome.nativeHostInstalled) {
    return fail(
      `Error: could not write the Native Messaging manifest at '${outcome.manifestPath}'` +
        (platform === "windows" ? " or its registry key" : "") +
        "; check permissions.",
    );
  }

  const origins = outcome.manifest?.allowed_origins ?? [`chrome-extension://${extensionId}/`];
  let report = "Installed Native Messaging manifest:\n";
  report += `  Manifest: ${outcome.manifestPath}\n`;
  report += `  Binary:   ${helperPath}\n`;
  for (const origin of origins) report += `  Origin:   ${origin}\n`;
  if (platform === "windows") {
    if (registry === null) {
      report += `  Registry: skipped (isolated ${HOSTS_DIR_ENV}; set ${REGISTRY_KEY_ENV} to an HKCU test key to register)\n`;
    } else {
      report += `  Registry: ${registry?.keyPath ?? provisioning.WINDOWS_CHROME_REGISTRY_KEY}${outcome.registryUpdated ? "" : " (already current)"}\n`;
    }
  }
  io.stdout(report);
  return 0;
}

/** Entry used by `scripts/install-native-host-dev.mjs`. */
export function main(args: readonly string[], options: { repoRoot: string }): Promise<number> {
  return runInstallNativeHostDev(args, { repoRoot: options.repoRoot });
}
