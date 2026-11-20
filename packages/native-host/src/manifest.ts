/**
 * Chrome Native Messaging host manifest generation, path resolution and allowed-origin
 * merging (port of `crates/protocol/src/native_manifest.rs` and the origin logic in
 * `crates/core/src/service/chrome.rs`).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CHROME_EXTENSION_ID,
  LEGACY_PLACEHOLDER_EXTENSION_ID,
  NATIVE_HOST_DESCRIPTION,
  NATIVE_HOST_MANIFEST_FILENAME,
  NATIVE_HOST_NAME,
} from "./constants.js";
import {
  currentPlatform,
  defaultDataDirWith,
  type Env,
  type IpcPlatform,
} from "./endpoint.js";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: string;
  allowed_origins: string[];
}

/** Normalize `<id>` or `chrome-extension://<id>/` into the canonical origin. */
export function formatAllowedOrigin(extensionIdOrOrigin: string): string {
  const trimmed = extensionIdOrOrigin.trim();
  const noScheme = trimmed.startsWith("chrome-extension://")
    ? trimmed.slice("chrome-extension://".length)
    : trimmed;
  const id = noScheme.endsWith("/") ? noScheme.slice(0, -1) : noScheme;
  if (id === "" || !/^[A-Za-z0-9]+$/.test(id)) {
    throw new ManifestError(
      `invalid Chrome extension ID '${extensionIdOrOrigin}': expected non-empty ASCII alphanumeric ID`,
    );
  }
  return `chrome-extension://${id}/`;
}

export function stripOriginWrapper(idOrOrigin: string): string {
  const trimmed = idOrOrigin.trim();
  const noScheme = trimmed.startsWith("chrome-extension://")
    ? trimmed.slice("chrome-extension://".length)
    : trimmed;
  return noScheme.endsWith("/") ? noScheme.slice(0, -1) : noScheme;
}

export function isLegacyPlaceholderExtensionId(idOrOrigin: string): boolean {
  return stripOriginWrapper(idOrOrigin).toLowerCase() === LEGACY_PLACEHOLDER_EXTENSION_ID;
}

/** Absolute for POSIX or Windows (`C:\…`, `C:/…`, `\\…`) regardless of the running OS. */
export function isAbsoluteForAnyOs(p: string): boolean {
  return path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Validated stdio manifest allowing every (deduplicated) extension origin. */
export function buildManifest(
  extensionIdsOrOrigins: readonly string[],
  binaryPath: string,
): NativeHostManifest {
  if (!isAbsoluteForAnyOs(binaryPath)) {
    throw new ManifestError(`native host binary path must be absolute, got '${binaryPath}'`);
  }
  const allowed: string[] = [];
  for (const item of extensionIdsOrOrigins) {
    const origin = formatAllowedOrigin(item);
    if (!allowed.includes(origin)) allowed.push(origin);
  }
  if (allowed.length === 0) {
    throw new ManifestError("invalid Chrome extension ID '': expected non-empty ASCII alphanumeric ID");
  }
  return {
    name: NATIVE_HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: binaryPath,
    type: "stdio",
    allowed_origins: allowed,
  };
}

/** Pretty JSON (2-space) with trailing newline, same field order as the Rust serializer. */
export function manifestToJson(manifest: NativeHostManifest): string {
  return `${JSON.stringify(
    {
      name: manifest.name,
      description: manifest.description,
      path: manifest.path,
      type: manifest.type,
      allowed_origins: manifest.allowed_origins,
    },
    null,
    2,
  )}\n`;
}

export interface ManifestPathInputs {
  platform: IpcPlatform;
  homeDir?: string | null;
  xdgConfigHome?: string | null;
  appdataDir?: string | null;
}

const nonEmpty = (v: string | null | undefined): v is string => v !== undefined && v !== null && v !== "";

/**
 * Chrome manifest target:
 * - macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<file>
 * - Linux: ${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts/<file>
 * - Windows: %APPDATA%\DealSonar\<file> (pointed to by the HKCU registry key)
 */
export function chromeManifestPathWith(inputs: ManifestPathInputs): string {
  const p = inputs.platform === "windows" ? path.win32 : path.posix;
  switch (inputs.platform) {
    case "macos": {
      if (!nonEmpty(inputs.homeDir)) throw new ManifestError("failed to resolve home/config directory: HOME");
      return p.join(
        inputs.homeDir,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        NATIVE_HOST_MANIFEST_FILENAME,
      );
    }
    case "linux": {
      let base: string;
      if (nonEmpty(inputs.xdgConfigHome)) {
        base = inputs.xdgConfigHome;
      } else {
        if (!nonEmpty(inputs.homeDir)) throw new ManifestError("failed to resolve home/config directory: HOME");
        base = p.join(inputs.homeDir, ".config");
      }
      return p.join(base, "google-chrome", "NativeMessagingHosts", NATIVE_HOST_MANIFEST_FILENAME);
    }
    case "windows": {
      let dataDir: string;
      try {
        dataDir = defaultDataDirWith({
          platform: "windows",
          homeDir: inputs.homeDir,
          appdataDir: inputs.appdataDir,
        });
      } catch {
        throw new ManifestError("failed to resolve home/config directory: APPDATA");
      }
      return p.join(dataDir, NATIVE_HOST_MANIFEST_FILENAME);
    }
  }
}

export function chromeManifestPath(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  return chromeManifestPathWith({
    platform,
    homeDir: env.HOME ?? env.USERPROFILE,
    xdgConfigHome: env.XDG_CONFIG_HOME,
    appdataDir: env.APPDATA,
  });
}

/**
 * Manifest targets for other Chromium-based browsers ALREADY present on the account
 * (macOS/Linux only). `isDir` is injectable for tests.
 */
export function secondaryChromiumManifestPaths(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
  isDir: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
): string[] {
  const home = env.HOME;
  if (home === undefined) return [];
  const out: string[] = [];
  if (platform === "macos") {
    const appSupport = path.posix.join(home, "Library", "Application Support");
    const roots: string[][] = [
      ["Google", "Chrome Beta"],
      ["Google", "Chrome Canary"],
      ["Google", "Chrome Dev"],
      ["Google", "Chrome for Testing"],
      ["Google", "ChromeForTesting"],
      ["Chromium"],
      ["Arc", "User Data"],
      ["BraveSoftware", "Brave-Browser"],
      ["Microsoft Edge"],
      ["Vivaldi"],
      ["CocCoc", "Browser"],
      ["com.operasoftware.Opera"],
    ];
    for (const parts of roots) {
      const base = path.posix.join(appSupport, ...parts);
      if (isDir(base)) out.push(path.posix.join(base, "NativeMessagingHosts", NATIVE_HOST_MANIFEST_FILENAME));
    }
  } else if (platform === "linux") {
    const configBase = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config");
    for (const dir of [
      "google-chrome-beta",
      "google-chrome-unstable",
      "chromium",
      "BraveSoftware/Brave-Browser",
      "microsoft-edge",
      "vivaldi",
      "opera",
    ]) {
      const base = path.posix.join(configBase, dir);
      if (isDir(base)) out.push(path.posix.join(base, "NativeMessagingHosts", NATIVE_HOST_MANIFEST_FILENAME));
    }
  }
  return out;
}

/** Atomically write the manifest (parents created, file mode 0644). */
export function writeManifestFile(manifestPath: string, manifest: NativeHostManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, manifestToJson(manifest), { mode: 0o644, flag: "wx" });
    fs.renameSync(tmp, manifestPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function readManifestFile(manifestPath: string): NativeHostManifest | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const m = raw as Record<string, unknown>;
    if (
      typeof m.name !== "string" ||
      typeof m.description !== "string" ||
      typeof m.path !== "string" ||
      typeof m.type !== "string" ||
      !Array.isArray(m.allowed_origins) ||
      !m.allowed_origins.every((o) => typeof o === "string")
    ) {
      return null;
    }
    return {
      name: m.name,
      description: m.description,
      path: m.path,
      type: m.type,
      allowed_origins: m.allowed_origins as string[],
    };
  } catch {
    return null;
  }
}

export function manifestsEqual(a: NativeHostManifest, b: NativeHostManifest): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.path === b.path &&
    a.type === b.type &&
    a.allowed_origins.length === b.allowed_origins.length &&
    a.allowed_origins.every((o, i) => o === b.allowed_origins[i])
  );
}

/** Rewrite the manifest only when missing/stale. Returns true when the file was written. */
export function verifyOrWriteManifest(manifestPath: string, expected: NativeHostManifest): boolean {
  const existing = readManifestFile(manifestPath);
  if (existing && manifestsEqual(existing, expected)) return false;
  writeManifestFile(manifestPath, expected);
  return true;
}

export interface OriginInputs {
  /** Explicit id passed to `chrome_connect` (trimmed; empty = none). */
  explicitExtensionId?: string | null;
  /** Value of the `chrome.extension_id` setting. */
  storedExtensionId?: string | null;
  existingManifest?: NativeHostManifest | null;
  /** IDs of workspace unpacked extension builds (developer checkouts only). */
  discoveredDevIds?: readonly string[];
}

/** Ordered, un-normalized origin list (port of `origins_to_allow` in `chrome_connect`). */
export function computeAllowedOrigins(inputs: OriginInputs): string[] {
  const explicit = inputs.explicitExtensionId?.trim() || null;
  const existing = inputs.existingManifest ?? null;

  let storedOrExisting: string | null = null;
  if (explicit === null) {
    const stored = inputs.storedExtensionId;
    if (stored && stored.trim() !== "" && !isLegacyPlaceholderExtensionId(stored)) {
      storedOrExisting = stored;
    } else if (existing) {
      storedOrExisting = existing.allowed_origins.find((o) => !isLegacyPlaceholderExtensionId(o)) ?? null;
    }
  }

  const primary = explicit ?? storedOrExisting ?? DEFAULT_CHROME_EXTENSION_ID;
  const origins: string[] = [primary];
  if (stripOriginWrapper(primary) !== DEFAULT_CHROME_EXTENSION_ID) origins.push(DEFAULT_CHROME_EXTENSION_ID);
  if (existing) {
    for (const origin of existing.allowed_origins) {
      if (!isLegacyPlaceholderExtensionId(origin)) origins.push(origin);
    }
  }
  for (const id of inputs.discoveredDevIds ?? []) origins.push(id);
  return origins;
}

/**
 * Chrome's deterministic path-based unpacked extension ID (`GenerateIdForPath`): SHA-256 of
 * the canonical path (UTF-16LE code units on Windows), first 16 bytes mapped to 'a'..'p'.
 */
export function computeChromeUnpackedExtensionId(dir: string): string | null {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(dir);
  } catch {
    return null;
  }
  const hash = crypto.createHash("sha256");
  if (process.platform === "win32") {
    const cleaned = canonical.startsWith("\\\\?\\") ? canonical.slice(4) : canonical;
    hash.update(Buffer.from(cleaned, "utf16le"));
  } else {
    hash.update(Buffer.from(canonical, "utf8"));
  }
  const digest = hash.digest();
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i]!;
    out += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}
