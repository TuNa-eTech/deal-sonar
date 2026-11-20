// Port of crates/core/src/diagnostics.rs: the redacted diagnostic ZIP.
//
// Privacy invariant: no Telegram bot token, webhook secret, license token or raw Facebook
// post/lead/contact content is ever written to the bundle. Only row counts, settings, health and
// scrubbed log tails are included.

import * as fs from "node:fs";
import * as path from "node:path";

import type { Store } from "../store/store";
import { createZip } from "../notify/zip";
import type { HealthStatus, Settings } from "./integrations-state";

export const DIAGNOSTIC_PROTOCOL_VERSION = 2;
const MAX_LOG_TAIL_BYTES = 512 * 1024;
const MAX_LOG_FILES = 5;

/** Scrub secret-shaped substrings from log text before bundling. */
export function scrubLogText(raw: string, extraSecrets: readonly string[]): string {
  let scrubbed = raw;
  for (const secret of extraSecrets) {
    const trimmed = secret.trim();
    if (trimmed !== "") scrubbed = scrubbed.split(trimmed).join("[REDACTED]");
  }
  scrubbed = scrubbed.replace(/(?:bot)?\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_TELEGRAM_TOKEN]");
  scrubbed = scrubbed.replace(/\bDS1\.[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+/g, "[REDACTED_LICENSE_KEY]");
  scrubbed = scrubbed.replace(/(bearer\s+|whsec_|sk-[A-Za-z0-9_-]{12,})[^\s"']*/gi, "[REDACTED_SECRET]");
  return scrubbed;
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

function osName(): string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}
function archName(): string {
  return process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
}

/** Tail of a log file (at most 512 KiB, starting on a UTF-8 boundary); `null` if not valid UTF-8. */
function readLogTail(file: string): string | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length > MAX_LOG_TAIL_BYTES) {
    let idx = buf.length - MAX_LOG_TAIL_BYTES;
    while (idx < buf.length && (buf[idx] & 0xc0) === 0x80) idx += 1;
    buf = buf.subarray(idx);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export interface DiagnosticBundleResult {
  path: string;
  size_bytes: number;
  created_at: number;
}

export interface DiagnosticBundleInput {
  store: Store;
  health: HealthStatus;
  settings: Settings;
  logsDir: string | null;
  destPath: string;
  extraSecretsToScrub: readonly string[];
  nowMs: number;
  appVersion: string | null;
}

/** Write the redacted `.zip` to `destPath` (parent directories are created). */
export function createDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundleResult {
  const { store, health, settings, logsDir, destPath, extraSecretsToScrub, nowMs } = input;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const safeHealth: HealthStatus = { ...health };
  if (safeHealth.ai_error !== null) safeHealth.ai_error = scrubLogText(safeHealth.ai_error, extraSecretsToScrub);

  const entries: Array<{ name: string; data: string }> = [
    {
      name: "version.json",
      // `json!` objects are key-sorted in the Rust bundle.
      data: pretty({
        app_name: "DealSonar",
        app_version: input.appVersion ?? "unknown",
        arch: archName(),
        created_at: nowMs,
        os: osName(),
        protocol_version: DIAGNOSTIC_PROTOCOL_VERSION,
      }),
    },
    { name: "health.json", data: pretty(safeHealth) },
    { name: "settings_redacted.json", data: pretty(settings) },
    // Row counts only: never post or lead rows.
    { name: "table_counts.json", data: pretty(store.tableRowCounts()) },
    { name: "schema_migrations.json", data: pretty(store.listSchemaMigrations()) },
  ];

  if (logsDir !== null) {
    let names: string[] = [];
    try {
      if (fs.statSync(logsDir).isDirectory()) {
        names = fs
          .readdirSync(logsDir)
          .filter((n) => {
            const ext = path.extname(n).toLowerCase();
            return (ext === ".log" || ext === ".txt") && !n.includes("\\") && fs.statSync(path.join(logsDir, n)).isFile();
          })
          .sort();
      }
    } catch {
      names = [];
    }
    for (const name of names.reverse().slice(0, MAX_LOG_FILES)) {
      const tail = readLogTail(path.join(logsDir, name));
      if (tail !== null) entries.push({ name: `logs/${name}`, data: scrubLogText(tail, extraSecretsToScrub) });
    }
  }

  const zip = createZip(entries, { unixMode: 0o600, mtime: new Date(nowMs) });
  const fd = fs.openSync(destPath, "w", 0o600);
  try {
    fs.writeSync(fd, zip);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { path: destPath, size_bytes: fs.statSync(destPath).size, created_at: nowMs };
}
