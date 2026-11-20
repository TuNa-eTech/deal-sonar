import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started (ENOENT, EACCES). */
  spawnError?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

export interface RunOptions {
  /** Written to the child's stdin. Secrets only ever travel this way, never via argv or env. */
  input?: string;
  timeoutMs: number;
}

export type CommandRunner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Spawns without a shell. A keychain prompt may wait on the user, hence the caller-chosen timeout. */
export const defaultRunner: CommandRunner = (command, args, { input, timeoutMs }) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => finish({ code: null, stdout, stderr, spawnError: err as NodeJS.ErrnoException }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
