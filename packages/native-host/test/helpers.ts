import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { FrameDecoder, encodeFrame } from "../src/framing.js";

export const isWindows = process.platform === "win32";

const created: string[] = [];

/** Short, private temp dir (Unix socket paths are length-limited). */
export function tmpDir(prefix = "dsnh"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  created.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Unique IPC endpoint: socket inside `dir/s/` on Unix, unique pipe name on Windows. */
export function testEndpoint(dir: string): string {
  if (isWindows) return `\\\\.\\pipe\\dealsonar-test-${randomBytes(6).toString("hex")}`;
  return path.join(dir, "s", "i.sock");
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function frameOf(value: unknown, max = 64 * 1024 * 1024): Buffer {
  return encodeFrame(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), max);
}

/** Collects decoded frames from a stream and lets tests await the next one. */
export class FrameCollector {
  readonly frames: Buffer[] = [];
  ended = false;
  private waiters: Array<() => void> = [];
  private readonly decoder: FrameDecoder;

  constructor(stream: Readable, maxBytes = 64 * 1024 * 1024) {
    this.decoder = new FrameDecoder(maxBytes);
    stream.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk, (f) => {
        this.frames.push(f);
        this.wake();
      });
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("close", () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async waitForCount(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (this.ended) throw new Error(`stream ended with ${this.frames.length}/${count} frames`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${count} frames (have ${this.frames.length})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Resolve with JSON of frame `index` (default: the next not-yet-consumed one). */
  async json(index: number, timeoutMs = 5_000): Promise<any> {
    await this.waitForCount(index + 1, timeoutMs);
    return JSON.parse(this.frames[index]!.toString("utf8"));
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}
