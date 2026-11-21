// Backend configuration from the environment the shell passes to `utilityProcess.fork`
// (apps/desktop README: DEALSONAR_DATA_DIR, DEALSONAR_NATIVE_HOST_BIN, DEALSONAR_SHELL,
// DEALSONAR_APP_VERSION, DEALSONAR_ELECTRON_VERSION, DEALSONAR_CHANNEL) plus the Rust-era flags
// DEALSONAR_IN_MEMORY_SECRETS, DEALSONAR_MOCK_AI and DEALSONAR_IPC_PATH.

import * as path from "node:path";

import type { HostBindings, HostPlatform } from "./host";

export type Env = Readonly<Record<string, string | undefined>>;

export interface BackendConfig {
  /** `candidate` isolates identity from the Tauri build; anything else is production. */
  channel: "candidate" | "production";
  dataDir: string;
  dbPath: string;
  backupDir: string;
  logsDir: string;
  aiWorkdir: string;
  ipcEndpoint: string;
  nativeHostBinaryPath: string | null;
  appVersion: string | null;
  electronVersion: string | null;
  inMemorySecrets: boolean;
  mockAi: boolean;
  platform: NodeJS.Platform;
}

export const hostPlatform = (platform: NodeJS.Platform): HostPlatform =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

export function envFlagEnabled(env: Env, name: string): boolean {
  const v = env[name]?.trim();
  return v === "1" || v === "true" || v === "TRUE" || v === "yes" || v === "YES";
}

const sanitizePipeComponent = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "default" : cleaned;
};

/**
 * Windows named pipe for the candidate build. The Tauri build uses `\\.\pipe\dealsonar-<user>`
 * and the Windows endpoint ignores `DEALSONAR_DATA_DIR`, so the candidate needs its own explicit
 * name or the two apps (and the production native host) would collide on one pipe.
 */
export function candidateWindowsPipe(user: string | undefined): string {
  const name = user && user.trim() !== "" ? sanitizePipeComponent(user) : "default";
  return `\\\\.\\pipe\\dealsonar-candidate-${name}`;
}

export function loadBackendConfig(
  env: Env,
  host: Pick<HostBindings, "resolveDesktopDataDir" | "resolveDesktopIpcEndpoint">,
  platform: NodeJS.Platform = process.platform,
): BackendConfig {
  const hp = hostPlatform(platform);
  const channel = env.DEALSONAR_CHANNEL === "candidate" ? "candidate" : "production";
  const dataDir = host.resolveDesktopDataDir(env, hp);

  // An explicit DEALSONAR_IPC_PATH always wins. Otherwise a candidate on Windows gets its own pipe.
  let ipcEnv: Env = env;
  if (channel === "candidate" && platform === "win32" && env.DEALSONAR_IPC_PATH === undefined) {
    ipcEnv = { ...env, DEALSONAR_IPC_PATH: candidateWindowsPipe(env.USERNAME ?? env.USER) };
  }
  const ipcEndpoint = host.resolveDesktopIpcEndpoint(dataDir, ipcEnv, hp);

  const nativeHost = env.DEALSONAR_NATIVE_HOST_BIN?.trim();
  return {
    channel,
    dataDir,
    dbPath: path.join(dataDir, "dealsonar.db"),
    backupDir: path.join(dataDir, "backups"),
    logsDir: path.join(dataDir, "logs"),
    aiWorkdir: path.join(dataDir, "ai-workdir"),
    ipcEndpoint,
    nativeHostBinaryPath: nativeHost ? nativeHost : null,
    appVersion: env.DEALSONAR_APP_VERSION ?? null,
    electronVersion: env.DEALSONAR_ELECTRON_VERSION ?? null,
    inMemorySecrets: envFlagEnabled(env, "DEALSONAR_IN_MEMORY_SECRETS"),
    mockAi: envFlagEnabled(env, "DEALSONAR_MOCK_AI"),
    platform,
  };
}
