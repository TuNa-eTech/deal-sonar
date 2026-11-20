// Port of crates/ai-bridge/src/subprocess.rs.
//
// CLIs are executed directly (never through a shell), inside an empty working directory, with the
// prompt on stdin and a hard wall-clock timeout that kills the whole process group. On Windows,
// `.cmd`/`.bat` shims are launched through `cmd.exe` with the escaping rules of the Rust standard
// library (BatBadBut mitigation); arguments that cannot be escaped safely are rejected.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { AiError } from "./types";

/** Per-stream cap (bytes). Larger output kills the process and fails the call. */
export const MAX_CLI_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface SubprocessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ScopedTempDir {
  readonly path: string;
  dispose(): void;
}

/** Per-call temporary directory (`0700` on Unix) removed by `dispose()`. */
export function createScopedTempDir(prefix: string): ScopedTempDir {
  const base = os.tmpdir();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = path.join(base, `${prefix}${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return {
        path: candidate,
        dispose: () => {
          try {
            fs.rmSync(candidate, { recursive: true, force: true });
          } catch {
            // best effort, like the Rust `Drop`
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("exhausted attempts creating ScopedTempDir");
}

export async function withScopedTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = createScopedTempDir(prefix);
  try {
    return await fn(dir.path);
  } finally {
    dir.dispose();
  }
}

function detectHomeDir(): string | null {
  const home = process.env.HOME;
  if (home) return home;
  if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
  return null;
}

/**
 * Expanded `PATH` including common CLI install locations a GUI launch misses
 * (`06-ai-bridge.md §3.1`). Existing entries keep priority.
 */
export function expandedPathEnv(basePath?: string | null, homeOverride?: string | null): string {
  const home = homeOverride ?? detectHomeDir();
  const seen = new Set<string>();
  const dirs: string[] = [];
  const push = (p: string): void => {
    if (p !== "" && !seen.has(p)) {
      seen.add(p);
      dirs.push(p);
    }
  };

  if (basePath) for (const p of basePath.split(path.delimiter)) push(p);

  if (home) {
    for (const rel of [
      ".local/bin",
      ".cargo/bin",
      ".npm-global/bin",
      ".volta/bin",
      "Library/pnpm",
      ".local/share/pnpm",
      ".bun/bin",
      ".fnm/current/bin",
      ".local/share/fnm/aliases/default/bin",
      "Library/Application Support/fnm/aliases/default/bin",
    ]) {
      push(path.join(home, rel));
    }
    const nvmVersions = path.join(home, ".nvm", "versions", "node");
    try {
      const bins = fs
        .readdirSync(nvmVersions)
        .map((e) => path.join(nvmVersions, e, "bin"))
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .reverse();
      for (const b of bins) push(b);
    } catch {
      // no nvm
    }
    if (process.platform === "win32") {
      push(path.join(home, "AppData", "Roaming", "npm"));
      push(path.join(home, "AppData", "Local", "pnpm"));
    }
  }

  if (process.platform !== "win32") {
    for (const sys of [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]) {
      push(sys);
    }
  }
  return dirs.join(path.delimiter);
}

export function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Locate `binary` as an explicit path or inside `expandedPath`. */
export function resolveBinaryInPath(binary: string, expandedPath: string): string | null {
  if (path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    return isExecutableFile(binary) ? binary : null;
  }
  for (const dir of expandedPath.split(path.delimiter)) {
    if (dir === "") continue;
    if (process.platform === "win32") {
      // npm drops an extension-less POSIX shim next to `x.cmd`; only the Windows launchers can run.
      for (const ext of ["exe", "cmd", "bat"]) {
        const withExt = path.join(dir, `${binary}.${ext}`);
        if (isExecutableFile(withExt)) return withExt;
      }
      const lower = binary.toLowerCase();
      if (/\.(exe|cmd|bat)$/.test(lower)) {
        const exact = path.join(dir, binary);
        if (isExecutableFile(exact)) return exact;
      }
      continue;
    }
    const candidate = path.join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Ensure `workdir` exists and is empty so CLI agents never load project instruction files
 * (`CLAUDE.md`, `AGENTS.md`, `.claude`, `.codex`).
 */
export function ensureEmptyWorkdir(workdir: string): void {
  try {
    fs.mkdirSync(workdir, { recursive: true });
  } catch (err) {
    throw AiError.process(-1, `failed to create ai-workdir '${workdir}': ${(err as Error).message}`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workdir, { withFileTypes: true });
  } catch (err) {
    throw AiError.process(-1, `failed to inspect ai-workdir '${workdir}': ${(err as Error).message}`);
  }
  for (const entry of entries) {
    const target = path.join(workdir, entry.name);
    try {
      if (entry.isDirectory() && !entry.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
      else fs.rmSync(target, { force: true });
    } catch (err) {
      throw AiError.process(-1, `failed cleaning ai-workdir entry '${target}': ${(err as Error).message}`);
    }
  }
}

// ---- Windows batch-file launch ----------------------------------------------------------------

/** One argument encoded for a `cmd.exe /c` batch invocation (Rust std `append_bat_arg`). */
export function encodeBatArg(arg: string): string {
  if (arg.includes("\0")) throw AiError.process(-1, "argument contains a NUL byte");
  let quote = arg === "" || arg.endsWith("\\");
  for (const ch of arg) {
    if (ch === "\r" || ch === "\n") {
      throw AiError.process(-1, "argument contains a newline and cannot be passed to a .cmd/.bat launcher safely");
    }
    if (!/[A-Za-z0-9#$*+\-./:?@\\_]/.test(ch)) quote = true;
  }
  let out = quote ? '"' : "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
    } else {
      if (ch === '"') {
        out += "\\".repeat(backslashes);
        out += '"';
      } else if (ch === "%") {
        out += "%%cd:~,";
      }
      backslashes = 0;
    }
    out += ch;
  }
  if (quote) {
    out += "\\".repeat(backslashes);
    out += '"';
  }
  return out;
}

/** `cmd.exe` verbatim command line for running a `.cmd`/`.bat` with `args`. */
export function windowsBatchCommandLine(script: string, args: string[]): string {
  const parts = [`"${script.replace(/"/g, "")}"`, ...args.map(encodeBatArg)];
  return `"${parts.join(" ")}"`;
}

function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Execute a CLI binary directly, inside an empty `workdir`, feeding `stdin` and enforcing a hard
 * process-group timeout (`06-ai-bridge.md §3.1, §6`).
 */
export async function runCliSubprocess(
  binary: string,
  args: string[],
  stdin: string | Buffer | null,
  workdir: string,
  expandedPath: string,
  extraEnv: ReadonlyArray<readonly [string, string]>,
  timeoutMs: number,
): Promise<SubprocessOutput> {
  const resolved = resolveBinaryInPath(binary, expandedPath);
  if (!resolved) throw AiError.notInstalled();
  ensureEmptyWorkdir(workdir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.Path = expandedPath;
  } else {
    env.PATH = expandedPath;
  }
  for (const [k, v] of extraEnv) env[k] = v;

  let command = resolved;
  let spawnArgs = args;
  let verbatim = false;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    command = process.env.ComSpec ?? "cmd.exe";
    spawnArgs = ["/d", "/s", "/c", windowsBatchCommandLine(resolved, args)];
    verbatim = true;
  }

  const started = Date.now();
  return new Promise<SubprocessOutput>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = spawn(command, spawnArgs, {
      cwd: workdir,
      env,
      shell: false,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const overflow = (): void => {
      killProcessTree(child.pid);
      finish(() => reject(AiError.process(-1, "I/O error communicating with CLI: output exceeded size limit")));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLI_OUTPUT_BYTES) return overflow();
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CLI_OUTPUT_BYTES) return overflow();
      stderrChunks.push(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      killProcessTree(child.pid);
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? AiError.notInstalled()
            : AiError.process(-1, `failed to spawn '${resolved}': ${err.message}`),
        ),
      );
    });

    child.on("close", (code) => {
      // Kill any grandchild that outlived the CLI, then report.
      killProcessTree(child.pid);
      finish(() =>
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          durationMs: Date.now() - started,
        }),
      );
    });

    timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish(() => reject(AiError.timeout()));
    }, Math.max(1, timeoutMs));

    if (stdin !== null && child.stdin) {
      // The child may exit before reading (bad flag, immediate auth error): ignore EPIPE so the
      // exit status and stderr are still collected.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}
