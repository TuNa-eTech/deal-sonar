import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKEND_COMMANDS,
  BACKEND_CONTROL,
  BackendServer,
  CommandError,
  CoreError,
  DesktopRuntime,
  Store,
  candidateWindowsPipe,
  loadBackendConfig,
  startBackend,
  toWireError,
  unportedCommands,
  type BackendRuntime,
  type HostBindings,
  type HostExtensionConnection,
  type HostIpcServerOptions,
  type ParentPortLike,
} from "../src";

const RUST_DISPATCH = path.resolve(__dirname, "../../../apps/desktop/src/commands/dispatch.rs");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-backend-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

class FakePort implements ParentPortLike {
  sent: any[] = [];
  private listener: ((m: { data: unknown }) => void) | null = null;
  on(_event: "message", listener: (m: { data: unknown }) => void): void {
    this.listener = listener;
  }
  postMessage(message: unknown): void {
    this.sent.push(message);
    for (const w of this.waiters.splice(0)) w();
  }
  private waiters: Array<() => void> = [];
  send(message: unknown): void {
    this.listener?.({ data: message });
  }
  async reply(id: number): Promise<any> {
    for (;;) {
      const found = this.sent.find((m) => m.id === id);
      if (found) return found;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  async event(name: string): Promise<any> {
    for (;;) {
      const found = this.sent.find((m) => m.event === name);
      if (found) return found;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

function fakeRuntime(overrides: Partial<BackendRuntime> = {}): BackendRuntime & { emit?: (e: string, p: unknown) => void } {
  const rt: any = {
    version: "9.9.9",
    start: async (emit: (e: string, p: unknown) => void) => {
      rt.emit = emit;
    },
    invoke: async (command: string, args: Record<string, unknown>) => ({ echoed: command, args }),
    toggleCrawlPaused: async () => ({ crawl_paused: true }),
    shutdown: async () => undefined,
    ...overrides,
  };
  return rt;
}

describe("command surface", () => {
  it("matches the arms of the Rust dispatcher (minus the shell-owned open_external_url)", () => {
    const src = fs.readFileSync(RUST_DISPATCH, "utf8");
    const arms = [...src.matchAll(/^ {8}"([a-z_]+)" =>/gm)].map((m) => m[1]).filter((c) => c !== "open_external_url");
    expect([...BACKEND_COMMANDS].sort()).toEqual([...new Set(arms)].sort());
    expect(BACKEND_COMMANDS).toHaveLength(58);
  });

  it("reports every command as unported until its handler lands", () => {
    expect(unportedCommands()).toHaveLength(58);
  });
});

describe("error mapping", () => {
  it("uses the CommandError codes and Vietnamese Display strings of the Rust core", () => {
    expect(toWireError(CoreError.validation("x"))).toEqual({ code: "validation_error", message: "dữ liệu đầu vào không hợp lệ: x" });
    expect(toWireError(CoreError.notFound("radar", "R1"))).toEqual({ code: "not_found", message: "không tìm thấy radar: R1" });
    expect(toWireError(CoreError.shuttingDown())).toEqual({ code: "shutting_down", message: "hệ thống đang tắt" });
    expect(toWireError(new CommandError("unknown_command", "m"))).toEqual({ code: "unknown_command", message: "m" });
    expect(toWireError(CoreError.notImplemented("lead_list")).code).toBe("not_implemented");
    expect(toWireError(new Error("boom"))).toEqual({ code: "internal_error", message: "lỗi nội bộ hệ thống: boom" });
  });

  it("maps store failures to store_error without stack traces", () => {
    const store = Store.openInMemory();
    let wire = { code: "", message: "" };
    try {
      store.db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'not json')").run();
    } catch (err) {
      wire = toWireError(err);
    }
    expect(wire.code).toBe("store_error");
    expect(wire.message).toMatch(/^lỗi cơ sở dữ liệu: SQLite error: /);
    expect(toWireError(Object.assign(new Error("x"), { name: "DomainShapeError" }))).toEqual({
      code: "store_error",
      message: "lỗi cơ sở dữ liệu: JSON serialization error: x",
    });
    store.close();
  });
});

describe("BackendServer handshake", () => {
  it("pushes backend:ready after the runtime started, then serves requests", async () => {
    const port = new FakePort();
    const runtime = fakeRuntime();
    const server = new BackendServer({ port, runtime, exit: () => undefined });
    await server.start();
    expect(port.sent[0]).toEqual({ event: "backend:ready", payload: { protocol: 1, version: "9.9.9" } });

    port.send({ id: 1, command: "lead_list", args: { query: { limit: 1 } } });
    expect(await port.reply(1)).toEqual({ id: 1, ok: true, value: { echoed: "lead_list", args: { query: { limit: 1 } } } });
    port.send({ id: 2, command: "health_get", args: null });
    expect((await port.reply(2)).value).toEqual({ echoed: "health_get", args: {} });
  });

  it("rejects unknown commands and non-object args with the Rust error codes", async () => {
    const port = new FakePort();
    await new BackendServer({ port, runtime: fakeRuntime(), exit: () => undefined }).start();
    port.send({ id: 1, command: "open_external_url", args: {} });
    expect(await port.reply(1)).toEqual({
      id: 1,
      ok: false,
      error: { code: "unknown_command", message: "lệnh IPC không tồn tại: open_external_url" },
    });
    port.send({ id: 2, command: "lead_list", args: [1] });
    expect((await port.reply(2)).error).toEqual({ code: "validation_error", message: "tham số lệnh IPC phải là đối tượng JSON" });
    port.send({ garbage: true });
    port.send("nope");
    expect(port.sent.filter((m) => m.id !== undefined)).toHaveLength(2);
  });

  it("answers backend:toggle_crawl_paused and forwards os:notification pushes", async () => {
    const port = new FakePort();
    const runtime = fakeRuntime();
    await new BackendServer({ port, runtime, exit: () => undefined }).start();
    port.send({ id: 3, command: BACKEND_CONTROL.toggleCrawlPaused, args: null });
    expect(await port.reply(3)).toEqual({ id: 3, ok: true, value: { crawl_paused: true } });
    (runtime as any).emit(BACKEND_CONTROL.osNotification, { lead_id: "L1", radar_name: "R", summary: "S" });
    expect(await port.event("os:notification")).toEqual({ event: "os:notification", payload: { lead_id: "L1", radar_name: "R", summary: "S" } });
  });

  it("maps handler failures to {code,message} replies", async () => {
    const port = new FakePort();
    const runtime = fakeRuntime({ invoke: async () => { throw CoreError.notFound("lead", "L9"); } });
    await new BackendServer({ port, runtime, exit: () => undefined }).start();
    port.send({ id: 1, command: "lead_get", args: { id: "L9" } });
    expect((await port.reply(1)).error).toEqual({ code: "not_found", message: "không tìm thấy lead: L9" });
  });

  it("pushes backend:fatal and exits non-zero when startup fails", async () => {
    const port = new FakePort();
    const codes: number[] = [];
    const exited = new Promise<void>((resolve) => {
      const runtime = fakeRuntime({ start: async () => { throw CoreError.internal("db locked"); } });
      void new BackendServer({ port, runtime, exit: (c) => { codes.push(c); resolve(); } }).start().catch(() => undefined);
    });
    await exited;
    expect(port.sent[0]).toEqual({ event: "backend:fatal", payload: { code: "internal_error", message: "lỗi nội bộ hệ thống: db locked" } });
    expect(codes).toEqual([1]);
  });
});

describe("BackendServer shutdown", () => {
  it("drains in-flight work within grace, replies ok, then exits 0; later requests are shutting_down", async () => {
    const port = new FakePort();
    let release!: () => void;
    const order: string[] = [];
    const runtime = fakeRuntime({
      invoke: () => new Promise((resolve) => { release = () => { order.push("handler-done"); resolve("late"); }; }),
      shutdown: async () => { order.push("runtime-shutdown"); },
    });
    const exited = new Promise<number>((resolve) => {
      void new BackendServer({ port, runtime, exit: resolve }).start();
    });
    await port.event("backend:ready");

    port.send({ id: 1, command: "ai_probe", args: {} });
    await new Promise((r) => setTimeout(r, 5));
    port.send({ id: 2, command: BACKEND_CONTROL.shutdown, args: { grace_ms: 2000 } });
    await new Promise((r) => setTimeout(r, 5));
    port.send({ id: 3, command: "lead_list", args: {} });
    expect((await port.reply(3)).error.code).toBe("shutting_down");
    expect(order).toEqual([]); // still draining

    release();
    expect(await port.reply(1)).toEqual({ id: 1, ok: true, value: "late" });
    expect(await port.reply(2)).toEqual({ id: 2, ok: true, value: null });
    expect(order).toEqual(["handler-done", "runtime-shutdown"]);
    expect(await exited).toBe(0);
  });

  it("stops waiting after grace_ms", async () => {
    const port = new FakePort();
    const runtime = fakeRuntime({ invoke: () => new Promise(() => undefined) });
    const exited = new Promise<number>((resolve) => { void new BackendServer({ port, runtime, exit: resolve }).start(); });
    await port.event("backend:ready");
    port.send({ id: 1, command: "ai_probe", args: {} });
    port.send({ id: 2, command: BACKEND_CONTROL.shutdown, args: { grace_ms: 30 } });
    expect(await port.reply(2)).toEqual({ id: 2, ok: true, value: null });
    expect(await exited).toBe(0);
  });
});

// ---- runtime integration with a fake Host package -------------------------------------------------

function fakeHost() {
  const bound: HostIpcServerOptions[] = [];
  let closed = false;
  class AgentError extends Error {}
  const host: HostBindings = {
    resolveDesktopDataDir: (env) => env.DEALSONAR_DATA_DIR ?? path.join(tmp, "default"),
    resolveDesktopIpcEndpoint: (dataDir, env, platform) =>
      env.DEALSONAR_IPC_PATH ?? (platform === "windows" ? "\\\\.\\pipe\\dealsonar-user" : `${dataDir}${path.sep}ipc.sock`),
    issueAgentToken: (dataDir) => {
      fs.writeFileSync(path.join(dataDir, "agent-access"), Buffer.alloc(32, 7), { mode: 0o600 });
      return Buffer.alloc(32, 7);
    },
    bindIpcServer: async (options) => {
      bound.push(options);
      return { endpoint: options.endpoint, close: async () => { closed = true; } };
    },
    AgentError,
  };
  return { host, bound, isClosed: () => closed, AgentError };
}

const candidateEnv = (dataDir: string) => ({
  DEALSONAR_DATA_DIR: dataDir,
  DEALSONAR_CHANNEL: "candidate",
  DEALSONAR_IN_MEMORY_SECRETS: "1",
  DEALSONAR_APP_VERSION: "1.2.3",
  DEALSONAR_NATIVE_HOST_BIN: "/opt/dealsonar/native-host",
});

describe("startBackend / DesktopRuntime", () => {
  it("opens the retained database layout, issues the agent token, binds IPC, then pushes ready", async () => {
    const dataDir = path.join(tmp, "DealSonar Candidate");
    const fh = fakeHost();
    const port = new FakePort();
    const started = await startBackend({ port, env: candidateEnv(dataDir), loadHost: async () => fh.host, platform: "linux", exit: () => undefined });
    expect(started).not.toBeNull();
    expect(port.sent[0]).toEqual({ event: "backend:ready", payload: { protocol: 1, version: "1.2.3" } });

    for (const sub of ["backups", "ai-workdir", "logs"]) expect(fs.statSync(path.join(dataDir, sub)).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(dataDir, "agent-access"))).toBe(true);
    expect(fh.bound[0].endpoint).toBe(path.join(dataDir, "ipc.sock"));
    expect(fh.bound[0].agentToken?.length).toBe(32);

    const raw = started!.runtime.context.store.listSchemaMigrations();
    expect(raw.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(started!.runtime.context.store.journalMode()).toBe("wal");

    // extension connections and agent calls are refused until their ports exist
    let closedConn = false;
    fh.bound[0].onExtensionConnection({ close: () => { closedConn = true; } } as unknown as HostExtensionConnection);
    expect(closedConn).toBe(true);
    await expect(fh.bound[0].agentBackend!.handle("prepare_radar", {})).rejects.toBeInstanceOf(fh.AgentError);

    // unported commands are explicit about it
    port.send({ id: 1, command: "lead_list", args: {} });
    expect((await port.reply(1)).error.code).toBe("not_implemented");

    port.send({ id: 2, command: BACKEND_CONTROL.shutdown, args: { grace_ms: 100 } });
    expect(await port.reply(2)).toEqual({ id: 2, ok: true, value: null });
    expect(fh.isClosed()).toBe(true);
    expect(started!.runtime.context.store.db.open).toBe(false);
  });

  it("applies a staged restore before opening the database", async () => {
    const dataDir = path.join(tmp, "data");
    const src = Store.open(path.join(tmp, "src.db"), path.join(tmp, "srcbk"));
    src.settings.set("restored", true);
    src.close();
    fs.mkdirSync(dataDir, { recursive: true });
    Store.stageRestore(path.join(tmp, "src.db"), dataDir);

    const port = new FakePort();
    const started = await startBackend({ port, env: candidateEnv(dataDir), loadHost: async () => fakeHost().host, platform: "linux", exit: () => undefined });
    expect(started!.runtime.context.store.settings.get("restored")).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "restore-pending.sqlite3"))).toBe(false);
    await started!.runtime.shutdown();
  });

  it("pushes backend:fatal when the Host module cannot be loaded", async () => {
    const port = new FakePort();
    const codes: number[] = [];
    const exited = new Promise<void>((resolve) => {
      void startBackend({ port, env: candidateEnv(path.join(tmp, "x")), loadHost: async () => { throw new Error("Cannot find module '@dealsonar/native-host'"); }, exit: (c) => { codes.push(c); resolve(); } });
    });
    await exited;
    expect(port.sent[0].event).toBe("backend:fatal");
    expect(port.sent[0].payload.code).toBe("internal_error");
    expect(codes).toEqual([1]);
  });

  it("pushes backend:fatal and releases the database when IPC binding fails", async () => {
    const fh = fakeHost();
    fh.host.bindIpcServer = async () => { throw new Error("EADDRINUSE"); };
    const port = new FakePort();
    const exited = new Promise<void>((resolve) => {
      void startBackend({ port, env: candidateEnv(path.join(tmp, "y")), loadHost: async () => fh.host, platform: "linux", exit: () => resolve() });
    });
    await exited;
    expect(port.sent[0]).toEqual({ event: "backend:fatal", payload: { code: "internal_error", message: "lỗi nội bộ hệ thống: EADDRINUSE" } });
    // the db is closed again, so the file can be removed/reopened by a restart
    Store.open(path.join(tmp, "y", "dealsonar.db"), path.join(tmp, "y", "backups")).close();
  });

  it("delivers OS notifications through the shell push channel", async () => {
    const port = new FakePort();
    const started = await startBackend({ port, env: candidateEnv(path.join(tmp, "z")), loadHost: async () => fakeHost().host, platform: "linux", exit: () => undefined });
    started!.runtime.context.notifyOs({ lead_id: "L1", radar_name: "Nhà", summary: "Căn hộ" });
    expect(port.sent.at(-1)).toEqual({ event: "os:notification", payload: { lead_id: "L1", radar_name: "Nhà", summary: "Căn hộ" } });
    await started!.runtime.shutdown();
  });
});

describe("candidate IPC isolation", () => {
  const winHost = fakeHost().host;

  it("gives the Windows candidate its own pipe, distinct from Tauri's dealsonar-<user>", () => {
    const prod = loadBackendConfig({ DEALSONAR_DATA_DIR: "C:\\d", USERNAME: "An Tu" }, winHost, "win32");
    expect(prod.ipcEndpoint).toBe("\\\\.\\pipe\\dealsonar-user"); // the host default (Tauri-compatible), untouched
    const cand = loadBackendConfig({ DEALSONAR_DATA_DIR: "C:\\d", DEALSONAR_CHANNEL: "candidate", USERNAME: "An Tu" }, winHost, "win32");
    expect(cand.ipcEndpoint).toBe("\\\\.\\pipe\\dealsonar-candidate-An_Tu");
    expect(cand.ipcEndpoint).not.toBe(prod.ipcEndpoint);
    expect(candidateWindowsPipe(undefined)).toBe("\\\\.\\pipe\\dealsonar-candidate-default");
  });

  it("honours an explicit DEALSONAR_IPC_PATH and keeps unix candidates inside their data dir", () => {
    const explicit = loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", DEALSONAR_IPC_PATH: "\\\\.\\pipe\\custom", DEALSONAR_DATA_DIR: "C:\\d" }, winHost, "win32");
    expect(explicit.ipcEndpoint).toBe("\\\\.\\pipe\\custom");
    const mac = loadBackendConfig({ DEALSONAR_CHANNEL: "candidate", DEALSONAR_DATA_DIR: "/tmp/Cand" }, winHost, "darwin");
    expect(mac.ipcEndpoint).toBe(`/tmp/Cand${path.sep}ipc.sock`);
    expect(mac.dbPath).toBe(path.join("/tmp/Cand", "dealsonar.db"));
    expect(mac.channel).toBe("candidate");
  });
});
