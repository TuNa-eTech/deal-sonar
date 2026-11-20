/**
 * Windows registry provisioning for the Chrome Native Messaging host: the default value of
 * `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host` must be the manifest
 * path. Uses `reg.exe` through `execFile` (no shell, no native modules).
 *
 * Safety: only keys under `HKCU\` are accepted (per-user, never HKLM). Tests and dev tooling
 * pass an isolated key under `HKCU\Software\DealSonarTest\<run>\...`; development must never
 * point this at the real Chrome key of a live profile.
 */
import { execFile } from "node:child_process";
import { WINDOWS_CHROME_REGISTRY_KEY } from "./constants.js";

export interface RegResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RegistryRunner = (args: string[]) => Promise<RegResult>;

export const defaultRegistryRunner: RegistryRunner = (args) =>
  new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function assertPerUserKey(keyPath: string): void {
  if (!/^HKCU\\[^\0]+$/i.test(keyPath) || keyPath.includes("..")) {
    throw new Error(`refusing registry key outside HKCU: ${keyPath}`);
  }
}

/** Parse the default value from `reg query <key> /ve` output. */
export function parseRegDefaultValue(stdout: string): string | null {
  const match = /REG_SZ\s+(.+?)\s*$/m.exec(stdout);
  return match ? match[1]! : null;
}

export interface RegistryOptions {
  /** Defaults to the real Chrome key; override with an isolated HKCU test key. */
  keyPath?: string;
  runner?: RegistryRunner;
}

/** Read the registered manifest path (null when the key or value is absent). */
export async function readNativeHostRegistration(options: RegistryOptions = {}): Promise<string | null> {
  const keyPath = options.keyPath ?? WINDOWS_CHROME_REGISTRY_KEY;
  assertPerUserKey(keyPath);
  const run = options.runner ?? defaultRegistryRunner;
  const result = await run(["query", keyPath, "/ve"]);
  return result.code === 0 ? parseRegDefaultValue(result.stdout) : null;
}

/**
 * Ensure the key's default value equals `manifestPath`. Returns true when it was written,
 * false when already current. Throws when `reg add` fails.
 */
export async function ensureNativeHostRegistration(
  manifestPath: string,
  options: RegistryOptions = {},
): Promise<boolean> {
  const keyPath = options.keyPath ?? WINDOWS_CHROME_REGISTRY_KEY;
  assertPerUserKey(keyPath);
  const run = options.runner ?? defaultRegistryRunner;
  const current = await readNativeHostRegistration({ keyPath, runner: run });
  if (current === manifestPath) return false;
  const added = await run(["add", keyPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  if (added.code !== 0) {
    throw new Error(`reg add failed (${added.code}): ${added.stderr.trim()}`);
  }
  return true;
}

/** Remove a registration. Requires an explicit key and refuses the real Chrome key (test cleanup only). */
export async function removeNativeHostRegistration(options: Required<Pick<RegistryOptions, "keyPath">> & RegistryOptions): Promise<void> {
  const { keyPath } = options;
  assertPerUserKey(keyPath);
  if (keyPath.toLowerCase() === WINDOWS_CHROME_REGISTRY_KEY.toLowerCase()) {
    throw new Error("refusing to delete the real Chrome native host registration");
  }
  const run = options.runner ?? defaultRegistryRunner;
  await run(["delete", keyPath, "/f"]);
}
