import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import { APP_PREFIX } from "./app-files";
import type { ResourceLayout } from "./paths";

/**
 * Self-test used by the packaging smoke matrix (`scripts/smoke/run-smoke.mjs`). Inert unless
 * `DEALSONAR_SMOKE_REPORT` (or `--smoke-report=<file>`) is set. It exercises the real renderer
 * bridge, the security guards, the resource layout and the shutdown handshake, then writes a JSON
 * report. Exit code is 0 only when every required check passed.
 */
export function smokeReportPath(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const arg = argv.find((a) => a.startsWith("--smoke-report="));
  const fromArg = arg ? arg.slice("--smoke-report=".length) : "";
  const value = (fromArg || env.DEALSONAR_SMOKE_REPORT || "").trim();
  return value || null;
}

export interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail?: string;
}

export interface ShutdownInfo {
  ms: number;
  clean: boolean;
  code: number | null;
}

export interface SmokeContext {
  reportPath: string;
  layout: ResourceLayout;
  identity: { appId: string; channel: string };
  runtime: {
    isPackaged: boolean;
    appVersion: string;
    electron: string;
    node: string;
    execPath: string;
    dataDir: string;
    userDataDir: string;
  };
  tray: { created: boolean; error?: string };
  secondInstanceCount: () => number;
  externalOpenAttempts: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SmokeRecorder {
  private readonly checks: Check[] = [];
  private readonly startedAt = new Date().toISOString();
  private win: BrowserWindow | null = null;
  private backendVersion: string | undefined;

  constructor(private readonly ctx: SmokeContext) {}

  attach(win: BrowserWindow, backendVersion?: string): void {
    this.win = win;
    this.backendVersion = backendVersion;
  }

  private add(name: string, ok: boolean, detail?: string, required = true): void {
    this.checks.push({ name, ok, required, ...(detail ? { detail } : {}) });
  }

  private async guard(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>, required = true): Promise<void> {
    try {
      const r = await fn();
      this.add(name, r.ok, r.detail, required);
    } catch (err) {
      this.add(name, false, describeError(err), required);
    }
  }

  private js<T>(code: string): Promise<T> {
    if (!this.win) throw new Error("no window attached");
    return this.win.webContents.executeJavaScript(code, true) as Promise<T>;
  }

  checkResources(): void {
    const { layout } = this.ctx;
    const isWin = process.platform === "win32";
    for (const [label, path] of [
      ["backend_entry", layout.backendEntry],
      ["native_host", layout.nativeHostBinary],
    ] as const) {
      let ok = existsSync(path);
      let detail = path;
      if (ok && this.ctx.runtime.isPackaged && /app\.asar([\\/]|$)/.test(path)) {
        ok = false;
        detail = `inside ASAR: ${path}`;
      }
      if (ok && label === "native_host" && !isWin) {
        try {
          accessSync(path, constants.X_OK);
        } catch {
          ok = false;
          detail = `not executable: ${path}`;
        }
      }
      this.add(`resource_${label}`, ok, detail);
    }
  }

  async runChecks(): Promise<void> {
    process.env.DEALSONAR_DISABLE_BROWSER_SPAWN = "1";
    const win = this.win;
    if (!win) throw new Error("no window attached");
    this.checkResources();
    this.add("backend_handshake", true, this.backendVersion ? `version ${this.backendVersion}` : "ready");

    await this.guard("renderer_loaded", async () => {
      const url = win.webContents.getURL();
      const hasRoot = await this.js<boolean>(`document.getElementById("root") !== null`);
      return { ok: (url.startsWith(APP_PREFIX) || /^https?:\/\/localhost/.test(url)) && hasRoot, detail: url };
    });

    await this.guard("renderer_isolated", async () => {
      const r = await this.js<string>(
        `JSON.stringify({require: typeof require, process: typeof process, buffer: typeof Buffer, bridge: typeof window.dealsonarDesktop?.invoke, ipc: typeof window.electron})`
      );
      const v = JSON.parse(r) as Record<string, string>;
      return {
        ok: v.require === "undefined" && v.process === "undefined" && v.buffer === "undefined" && v.bridge === "function" && v.ipc === "undefined",
        detail: r,
      };
    });

    await this.guard("invoke_roundtrip", async () => {
      const env = await this.js<{ ok: boolean; error?: { code: string } }>(
        `window.dealsonarDesktop.invoke("health_get", {})`
      );
      return { ok: env.ok === true, detail: env.ok ? "health_get ok" : JSON.stringify(env.error) };
    });

    await this.guard("unknown_command_rejected", async () => {
      const env = await this.js<{ ok: boolean; error?: { code: string } }>(
        `window.dealsonarDesktop.invoke("definitely_not_a_command", {})`
      );
      return { ok: !env.ok && env.error?.code === "unknown_command", detail: JSON.stringify(env.error) };
    });

    await this.guard("external_url_blocked", async () => {
      const before = this.ctx.externalOpenAttempts();
      const env = await this.js<{ ok: boolean; error?: { code: string } }>(
        `window.dealsonarDesktop.invoke("open_external_url", {url: "https://evil.example/phish"})`
      );
      return {
        ok: !env.ok && env.error?.code === "blocked_external_url" && this.ctx.externalOpenAttempts() === before,
        detail: JSON.stringify(env.error),
      };
    });

    await this.guard("external_url_allowed_routed", async () => {
      const before = this.ctx.externalOpenAttempts();
      const env = await this.js<{ ok: boolean }>(
        `window.dealsonarDesktop.invoke("open_external_url", {url: "https://www.facebook.com/groups/1/posts/2/"})`
      );
      return { ok: env.ok === true && this.ctx.externalOpenAttempts() === before + 1 };
    });

    await this.guard("window_open_guarded", async () => {
      const windowsBefore = BrowserWindow.getAllWindows().length;
      const opensBefore = this.ctx.externalOpenAttempts();
      await this.js<boolean>(`(window.open("https://evil.example/x", "_blank"), true)`);
      await this.js<boolean>(`(window.open("https://www.facebook.com/groups/9/", "_blank"), true)`);
      await sleep(300);
      return {
        ok: BrowserWindow.getAllWindows().length === windowsBefore && this.ctx.externalOpenAttempts() === opensBefore + 1,
        detail: `windows=${BrowserWindow.getAllWindows().length}`,
      };
    });

    await this.guard("navigation_guarded", async () => {
      await this.js<boolean>(`(setTimeout(() => { location.href = "https://evil.example/nav"; }, 0), true)`);
      await sleep(700);
      const url = win.webContents.getURL();
      return { ok: url.startsWith(APP_PREFIX) || /^https?:\/\/localhost/.test(url), detail: url };
    });

    // Linux CI runs headless: there may be no StatusNotifier host, so the tray is reported but optional there.
    this.add("tray", this.ctx.tray.created, this.ctx.tray.error ?? "created", process.platform !== "linux");
  }

  /** Tells the runner the checks are done and the app is idling (it then launches the second instance). */
  markReady(): void {
    writeFileSync(`${this.ctx.reportPath}.ready`, "1");
  }

  /** Called after the backend shutdown handshake; writes the report and returns the exit code. */
  finish(shutdown: ShutdownInfo): number {
    this.add("graceful_shutdown", shutdown.clean, `${shutdown.ms}ms, backend exit ${String(shutdown.code)}`);
    this.add("single_instance_second_launch_seen", this.ctx.secondInstanceCount() > 0, `events=${this.ctx.secondInstanceCount()}`, false);
    const ok = this.checks.every((c) => c.ok || !c.required);
    this.writeReport(ok, shutdown);
    return ok ? 0 : 1;
  }

  /** Failure before the checks could run (backend failed to start, resources missing). */
  fail(reason: string): number {
    this.add("startup", false, reason);
    this.writeReport(false, null);
    return 1;
  }

  private writeReport(ok: boolean, shutdown: ShutdownInfo | null): void {
    const { runtime, identity, layout } = this.ctx;
    const stubMarker = existsSync(join(dirname(layout.backendEntry), "STUB"));
    const report = {
      schema: 1,
      ok,
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      packaged: runtime.isPackaged,
      app_id: identity.appId,
      channel: identity.channel,
      app_version: runtime.appVersion,
      electron: runtime.electron,
      node: runtime.node,
      exec_path: runtime.execPath,
      data_dir: runtime.dataDir,
      user_data_dir: runtime.userDataDir,
      backend_kind: stubMarker ? "stub" : "bundled",
      backend_version: this.backendVersion ?? null,
      shutdown,
      checks: this.checks,
    };
    const tmp = `${this.ctx.reportPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, this.ctx.reportPath);
  }
}

/** Reads a previously written report (used by tests and the runner). */
export function readReport(path: string): { ok: boolean; checks: Check[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; checks: Check[] };
}
