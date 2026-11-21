import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import candidateIdentity from "../../config/identity.json";
import productionIdentity from "../../config/production-identity.json";

const identity = process.env.DEALSONAR_DESKTOP_CHANNEL === "production" ? productionIdentity : candidateIdentity;

export { identity };

export type Platform = NodeJS.Platform;

export interface EnvLike {
  [key: string]: string | undefined;
}

/**
 * Data directory the backend opens (`state.rs::resolve_data_dir`, with a candidate-specific name):
 * `DEALSONAR_DATA_DIR` wins; otherwise a per-platform dir named after the candidate identity so a
 * candidate never opens the production DealSonar profile.
 */
export function resolveDataDir(
  env: EnvLike = process.env,
  platform: Platform = process.platform,
  home: string = homedir()
): string {
  const override = env.DEALSONAR_DATA_DIR?.trim();
  if (override) return override;
  if (platform === "darwin") return join(home, "Library", "Application Support", identity.dataDirName);
  if (platform === "win32") return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), identity.dataDirName);
  const xdg = identity.channel === "candidate" ? env.XDG_DATA_HOME?.trim() : undefined;
  return join(xdg || join(home, ".local", "share"), identity.linuxDataDirName);
}

/** Chromium profile (cache, localStorage) lives apart from the SQLite data dir. */
export function resolveUserDataDir(appDataDir: string, env: EnvLike = process.env): string {
  const override = env.DEALSONAR_SHELL_USER_DATA_DIR?.trim();
  if (override) return override;
  return join(appDataDir, identity.appId);
}

export interface ResourceLayout {
  /** Directory holding `backend/`, `native-host/`, `ui/`, `icons/`. */
  resourcesDir: string;
  backendEntry: string;
  nativeHostBinary: string;
  uiDir: string;
  trayIcon: string;
}

export const NATIVE_HOST_NAME = (platform: Platform = process.platform): string =>
  platform === "win32" ? "dealsonar-native-host.exe" : "dealsonar-native-host";

/** Backend entry name inside `resources/backend/`. Contract with the Backend task. */
export const BACKEND_ENTRY_FILE = "main.cjs";

export interface ResolveResourcesInput {
  isPackaged: boolean;
  resourcesPath: string;
  /** `apps/desktop-electron` when running unpackaged. */
  projectDir: string;
  env?: EnvLike;
  platform?: Platform;
}

/**
 * Packaged: everything under `process.resourcesPath` (outside ASAR, so the native helper is a
 * real executable and backend native modules load without unpacking).
 * Unpackaged: the staging dir written by `scripts/stage.mjs`, with env overrides for the entry
 * and helper. Overrides are ignored in packaged builds so the environment cannot swap code.
 */
export function resolveResources(input: ResolveResourcesInput): ResourceLayout {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const resourcesDir = input.isPackaged ? input.resourcesPath : join(input.projectDir, "stage");
  let backendEntry = join(resourcesDir, "backend", BACKEND_ENTRY_FILE);
  let nativeHostBinary = join(resourcesDir, "native-host", NATIVE_HOST_NAME(platform));
  let uiDir = join(resourcesDir, "ui");
  if (!input.isPackaged) {
    if (env.DEALSONAR_BACKEND_ENTRY?.trim()) backendEntry = resolve(env.DEALSONAR_BACKEND_ENTRY.trim());
    if (env.DEALSONAR_NATIVE_HOST_BIN?.trim()) nativeHostBinary = resolve(env.DEALSONAR_NATIVE_HOST_BIN.trim());
    const devUi = join(input.projectDir, "..", "desktop", "ui", "dist");
    if (!existsSync(uiDir) && existsSync(devUi)) uiDir = devUi;
  }
  const trayIcon = input.isPackaged
    ? join(resourcesDir, "icons", "tray.png")
    : join(input.projectDir, "..", "desktop", "icons", "32x32.png");
  return { resourcesDir, backendEntry, nativeHostBinary, uiDir, trayIcon };
}

/**
 * Environment handed to the backend utilityProcess. Existing names are kept from the Rust shell
 * (`DEALSONAR_DATA_DIR`, `DEALSONAR_NATIVE_HOST_BIN`).
 */
export function buildBackendEnv(
  base: EnvLike,
  opts: { dataDir: string; nativeHostBinary: string; appVersion: string; electronVersion: string }
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") env[k] = v;
  }
  if (identity.channel === "candidate" || base.DEALSONAR_DATA_DIR?.trim()) {
    env.DEALSONAR_DATA_DIR = opts.dataDir;
  } else {
    delete env.DEALSONAR_DATA_DIR;
  }
  env.DEALSONAR_NATIVE_HOST_BIN = opts.nativeHostBinary;
  env.DEALSONAR_SHELL = "electron";
  env.DEALSONAR_APP_VERSION = opts.appVersion;
  env.DEALSONAR_ELECTRON_VERSION = opts.electronVersion;
  env.DEALSONAR_CHANNEL = identity.channel;
  return env;
}
