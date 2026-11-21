import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type Level = "info" | "warn" | "error";

export interface Logger {
  log(level: Level, message: string): void;
  dir: string;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_PREFIX = "electron-shell-";

/**
 * Minimal daily log file under `<data_dir>/logs/` (the Rust shell kept 7 days). The shell logs
 * lifecycle only: no command arguments, payloads or settings values, so no credentials can land here.
 */
export function createLogger(logsDir: string, now: () => Date = () => new Date()): Logger {
  try {
    mkdirSync(logsDir, { recursive: true });
    pruneOldLogs(logsDir, now().getTime());
  } catch {
    // Logging must never block startup.
  }
  return {
    dir: logsDir,
    log(level, message) {
      const d = now();
      const line = `${d.toISOString()} ${level.toUpperCase()} ${message.replace(/\r?\n/g, "\\n")}\n`;
      try {
        appendFileSync(join(logsDir, `${FILE_PREFIX}${d.toISOString().slice(0, 10)}.log`), line);
      } catch {
        // ignore
      }
      if (level !== "info") process.stderr.write(line);
    },
  };
}

export function pruneOldLogs(logsDir: string, nowMs: number): void {
  for (const name of readdirSync(logsDir)) {
    if (!name.startsWith(FILE_PREFIX)) continue;
    const full = join(logsDir, name);
    try {
      if (nowMs - statSync(full).mtimeMs > RETENTION_MS) unlinkSync(full);
    } catch {
      // ignore
    }
  }
}
