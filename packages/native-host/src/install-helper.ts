/**
 * Stable per-user installation of the standalone helper executable.
 *
 * Chrome (and MCP clients) launch the helper by absolute path from the manifest / client
 * config, so it must live at a path that survives app updates and is never inside an ASAR
 * archive or a transient AppImage mount. The shell ships the helper as an app resource; this
 * module copies it to `<dataDir>/bin/dealsonar-native-host[.exe]` atomically.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { HELPER_BASENAME } from "./constants.js";
import { currentPlatform, type IpcPlatform } from "./endpoint.js";

export function helperFileName(platform: IpcPlatform = currentPlatform()): string {
  return platform === "windows" ? `${HELPER_BASENAME}.exe` : HELPER_BASENAME;
}

/** `<dataDir>/bin/dealsonar-native-host[.exe]` */
export function stableHelperPath(dataDir: string, platform: IpcPlatform = currentPlatform()): string {
  const p = platform === "windows" ? path.win32 : path.posix;
  return p.join(dataDir, "bin", helperFileName(platform));
}

/** True for locations that disappear or cannot be exec'd by Chrome. */
export function isEphemeralHelperLocation(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  return /\.asar(\/|$)/i.test(normalized) || /^\/tmp\/\.mount_/.test(normalized);
}

function sha256File(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export interface InstallHelperOptions {
  /** Packaged helper (SEA binary shipped as an app resource, outside ASAR). */
  sourcePath: string;
  /** Destination, normally `stableHelperPath(dataDir)`. */
  destPath: string;
}

export interface InstallHelperResult {
  path: string;
  /** True when bytes were (re)written; false when the installed copy was already identical. */
  changed: boolean;
}

export function installHelper(options: InstallHelperOptions): InstallHelperResult {
  const { sourcePath, destPath } = options;
  if (isEphemeralHelperLocation(destPath)) {
    throw new Error(`refusing to install helper into an ephemeral location: ${destPath}`);
  }
  if (!path.isAbsolute(destPath)) throw new Error(`helper destination must be absolute: ${destPath}`);
  const srcHash = sha256File(sourcePath);
  if (srcHash === null) throw new Error(`helper source is not readable: ${sourcePath}`);

  fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
  const destHash = sha256File(destPath);
  if (destHash === srcHash) {
    if (process.platform !== "win32") fs.chmodSync(destPath, 0o755);
    return { path: destPath, changed: false };
  }

  const tmp = `${destPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.copyFileSync(sourcePath, tmp);
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
    try {
      fs.renameSync(tmp, destPath);
    } catch (error) {
      // Windows cannot replace a running executable, but it can rename it out of the way.
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EBUSY" || code === "EACCES") || !fs.existsSync(destPath)) {
        throw error;
      }
      fs.renameSync(destPath, `${destPath}.old-${Date.now()}`);
      fs.renameSync(tmp, destPath);
    }
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  pruneOldHelpers(destPath);
  return { path: destPath, changed: true };
}

function pruneOldHelpers(destPath: string): void {
  const dir = path.dirname(destPath);
  const prefix = `${path.basename(destPath)}.old-`;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          /* still running; retry on the next install */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/** Snippet users/desktop put into Codex / Claude Code MCP configuration. */
export function mcpClientConfig(helperPath: string): { command: string; args: string[] } {
  return { command: helperPath, args: ["--mcp"] };
}
