/**
 * Local IPC endpoint and data directory resolution (port of `crates/protocol/src/ipc.rs`).
 *
 * Defaults:
 * - macOS:   ~/Library/Application Support/DealSonar/ipc.sock
 * - Linux:   $XDG_RUNTIME_DIR/dealsonar/ipc.sock (fallback ~/.local/share/dealsonar/ipc.sock)
 * - Windows: \\.\pipe\dealsonar-<username>
 * - Override (all platforms): DEALSONAR_IPC_PATH
 */
import * as path from "node:path";
import {
  DEALSONAR_DATA_DIR_ENV,
  DEALSONAR_IPC_PATH_ENV,
} from "./constants.js";

export type IpcPlatform = "macos" | "linux" | "windows";
export type Env = Readonly<Record<string, string | undefined>>;

export function currentPlatform(platform: NodeJS.Platform = process.platform): IpcPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function pathFor(platform: IpcPlatform): path.PlatformPath {
  return platform === "windows" ? path.win32 : path.posix;
}

const nonEmpty = (v: string | undefined | null): v is string => v !== undefined && v !== null && v !== "";

export function sanitizePipeComponent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "default" : cleaned;
}

export interface ResolveIpcInputs {
  platform: IpcPlatform;
  ipcOverride?: string | null;
  homeDir?: string | null;
  xdgRuntimeDir?: string | null;
  windowsUser?: string | null;
}

/** Pure, deterministic endpoint resolver (port of `resolve_ipc_endpoint_with`). */
export function resolveIpcEndpointWith(inputs: ResolveIpcInputs): string {
  const { platform } = inputs;
  const p = pathFor(platform);
  if (nonEmpty(inputs.ipcOverride)) {
    if (platform === "windows") {
      if (inputs.ipcOverride.startsWith("\\\\.\\pipe\\")) return inputs.ipcOverride;
      return `\\\\.\\pipe\\dealsonar-${sanitizePipeComponent(inputs.ipcOverride)}`;
    }
    return inputs.ipcOverride;
  }
  switch (platform) {
    case "macos": {
      if (!nonEmpty(inputs.homeDir)) {
        throw new Error("HOME directory is required to resolve macOS IPC path");
      }
      return p.join(inputs.homeDir, "Library", "Application Support", "DealSonar", "ipc.sock");
    }
    case "linux": {
      if (nonEmpty(inputs.xdgRuntimeDir)) {
        return p.join(inputs.xdgRuntimeDir, "dealsonar", "ipc.sock");
      }
      if (!nonEmpty(inputs.homeDir)) {
        throw new Error("neither XDG_RUNTIME_DIR nor HOME is set to resolve Linux IPC path");
      }
      return p.join(inputs.homeDir, ".local", "share", "dealsonar", "ipc.sock");
    }
    case "windows": {
      const user =
        inputs.windowsUser && inputs.windowsUser.trim() !== ""
          ? sanitizePipeComponent(inputs.windowsUser)
          : "default";
      return `\\\\.\\pipe\\dealsonar-${user}`;
    }
  }
}

function homeFromEnv(env: Env): string | undefined {
  return env.HOME ?? env.USERPROFILE;
}

function windowsUserFromEnv(env: Env): string | undefined {
  return env.USERNAME ?? env.USER;
}

/** Active endpoint, honoring a set and non-empty `DEALSONAR_IPC_PATH`. */
export function resolveIpcEndpoint(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  return resolveIpcEndpointWith({
    platform,
    ipcOverride: env[DEALSONAR_IPC_PATH_ENV],
    homeDir: homeFromEnv(env),
    xdgRuntimeDir: env.XDG_RUNTIME_DIR,
    windowsUser: windowsUserFromEnv(env),
  });
}

/** OS default endpoint ignoring `DEALSONAR_IPC_PATH`. */
export function defaultIpcEndpoint(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  return resolveIpcEndpointWith({
    platform,
    ipcOverride: null,
    homeDir: homeFromEnv(env),
    xdgRuntimeDir: env.XDG_RUNTIME_DIR,
    windowsUser: windowsUserFromEnv(env),
  });
}

export interface ResolveDataDirInputs {
  platform: IpcPlatform;
  homeDir?: string | null;
  appdataDir?: string | null;
}

/** Pure data directory resolver (port of `default_data_dir_with`). */
export function defaultDataDirWith(inputs: ResolveDataDirInputs): string {
  const p = pathFor(inputs.platform);
  switch (inputs.platform) {
    case "macos": {
      if (!nonEmpty(inputs.homeDir)) throw new Error("HOME directory is not set");
      return p.join(inputs.homeDir, "Library", "Application Support", "DealSonar");
    }
    case "linux": {
      if (!nonEmpty(inputs.homeDir)) throw new Error("HOME directory is not set");
      return p.join(inputs.homeDir, ".local", "share", "dealsonar");
    }
    case "windows": {
      if (nonEmpty(inputs.appdataDir)) return p.join(inputs.appdataDir, "DealSonar");
      if (!nonEmpty(inputs.homeDir)) {
        throw new Error("APPDATA / USERPROFILE directory is not set");
      }
      return p.join(inputs.homeDir, "AppData", "Roaming", "DealSonar");
    }
  }
}

export function defaultDataDir(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  return defaultDataDirWith({
    platform,
    homeDir: homeFromEnv(env),
    appdataDir: env.APPDATA,
  });
}

/**
 * Data dir as the desktop shell resolves it: `DEALSONAR_DATA_DIR` (trimmed, non-empty)
 * else OS default, else `<tmp>/dealsonar`.
 */
export function resolveDesktopDataDir(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
  tmpDir: string = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
): string {
  const override = env[DEALSONAR_DATA_DIR_ENV]?.trim();
  if (override) return override;
  try {
    return defaultDataDir(env, platform);
  } catch {
    return pathFor(platform).join(tmpDir, "dealsonar");
  }
}

/**
 * Desktop IPC endpoint selection (`build_core_config`): explicit `DEALSONAR_IPC_PATH` wins;
 * on non-Windows a non-blank `DEALSONAR_DATA_DIR` places `ipc.sock` inside the data dir;
 * otherwise the OS default.
 */
export function resolveDesktopIpcEndpoint(
  dataDir: string,
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  const fallback = () => {
    try {
      return resolveIpcEndpoint(env, platform);
    } catch {
      return pathFor(platform).join(dataDir, "ipc.sock");
    }
  };
  if (env[DEALSONAR_IPC_PATH_ENV] !== undefined) return fallback();
  if (platform !== "windows" && (env[DEALSONAR_DATA_DIR_ENV] ?? "").trim() !== "") {
    return pathFor(platform).join(dataDir, "ipc.sock");
  }
  return fallback();
}

/** Data dir used by the MCP adapter to locate `agent-access`: non-empty `DEALSONAR_DATA_DIR` (untrimmed) else default. */
export function resolveMcpDataDir(
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): { dataDir: string; custom: boolean } {
  const custom = env[DEALSONAR_DATA_DIR_ENV];
  if (nonEmpty(custom)) return { dataDir: custom, custom: true };
  return { dataDir: defaultDataDir(env, platform), custom: false };
}

/** Endpoint used by the MCP adapter (mirrors `call_desktop`). */
export function resolveMcpEndpoint(
  dataDir: { dataDir: string; custom: boolean },
  env: Env = process.env,
  platform: IpcPlatform = currentPlatform(),
): string {
  if (platform !== "windows" && env[DEALSONAR_IPC_PATH_ENV] === undefined && dataDir.custom) {
    return pathFor(platform).join(dataDir.dataDir, "ipc.sock");
  }
  return resolveIpcEndpoint(env, platform);
}
