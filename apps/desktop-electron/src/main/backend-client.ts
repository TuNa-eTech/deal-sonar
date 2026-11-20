import {
  BACKEND_CONTROL,
  BACKEND_PROTOCOL_VERSION,
  type BackendReadyPayload,
  type BackendReply,
  type BackendRequest,
  type WireError,
} from "../shared/contract";

/** The slice of Electron's `UtilityProcess` the client needs; tests pass a fake. */
export interface BackendChild {
  postMessage(message: unknown): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BackendError";
  }
  toWire(): WireError {
    return { code: this.code, message: this.message };
  }
}

export interface ExitInfo {
  /** true when we asked it to stop (shutdown handshake) */
  expected: boolean;
  code: number | null;
}

export type ClientState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface BackendClientOptions {
  spawn: () => BackendChild;
  readyTimeoutMs?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: BackendError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function toWireError(raw: unknown): WireError {
  if (isRecord(raw)) {
    return {
      code: typeof raw.code === "string" ? raw.code : "internal_error",
      message: typeof raw.message === "string" ? raw.message : "Lỗi nội bộ không xác định",
    };
  }
  return { code: "internal_error", message: typeof raw === "string" ? raw : "Lỗi nội bộ không xác định" };
}

/** One backend child process: handshake, request/reply correlation, push fan-out, shutdown. */
export class BackendClient {
  private child: BackendChild | null = null;
  private _state: ClientState = "idle";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly pushListeners = new Set<(event: string, payload: unknown) => void>();
  private readonly exitListeners = new Set<(info: ExitInfo) => void>();
  private readyWaiter: { resolve: (p: BackendReadyPayload) => void; reject: (e: BackendError) => void } | null = null;
  private exitWaiters: Array<(code: number | null) => void> = [];
  private exitCode: number | null | undefined;

  constructor(private readonly opts: BackendClientOptions) {}

  get state(): ClientState {
    return this._state;
  }

  onPush(listener: (event: string, payload: unknown) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onExit(listener: (info: ExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Spawns the child and resolves when it pushes `backend:ready`. */
  start(): Promise<BackendReadyPayload> {
    if (this._state !== "idle") {
      return Promise.reject(new BackendError("backend_state", `Dịch vụ nền đang ở trạng thái ${this._state}`));
    }
    this._state = "starting";
    const timeoutMs = this.opts.readyTimeoutMs ?? 30_000;
    return new Promise<BackendReadyPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failStart(new BackendError("backend_start_timeout", "Dịch vụ nền không khởi động kịp thời gian"));
      }, timeoutMs);
      this.readyWaiter = {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      try {
        const child = this.opts.spawn();
        this.child = child;
        child.onMessage((m) => this.handleMessage(m));
        child.onExit((code) => this.handleExit(code));
      } catch (err) {
        this.failStart(new BackendError("backend_spawn_failed", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  request<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this._state === "stopping" || this._state === "stopped") {
      return Promise.reject(new BackendError("shutting_down", "Ứng dụng đang thoát"));
    }
    if (this._state !== "ready" || !this.child) {
      return Promise.reject(new BackendError("backend_unavailable", "Dịch vụ nền chưa sẵn sàng"));
    }
    return this.send<T>(command, args, opts.timeoutMs);
  }

  /**
   * Shutdown handshake. Sends `backend:shutdown`, waits for the reply and the process exit,
   * and kills the child when it overstays `graceMs + 2s`.
   */
  async shutdown(graceMs = 10_000): Promise<{ clean: boolean; code: number | null }> {
    if (this._state === "idle" || this._state === "stopped" || this._state === "failed") {
      return { clean: true, code: this.exitCode ?? null };
    }
    const wasReady = this._state === "ready";
    this._state = "stopping";
    const killAfter = graceMs + 2_000;
    const exited = new Promise<number | null>((resolve) => {
      if (this.exitCode !== undefined) resolve(this.exitCode);
      else this.exitWaiters.push(resolve);
    });
    if (wasReady && this.child) {
      this.send(BACKEND_CONTROL.shutdown, { grace_ms: graceMs }, killAfter).catch((err: unknown) => {
        this.opts.log?.("warn", `backend:shutdown request failed: ${String(err)}`);
      });
    } else {
      this.child?.kill();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), killAfter);
    });
    const result = await Promise.race([exited, timedOut]);
    clearTimeout(timer);
    if (result === "timeout") {
      this.opts.log?.("error", "backend did not exit within grace period; killing");
      this.child?.kill();
      const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 2_000))]);
      return { clean: false, code };
    }
    return { clean: result === 0, code: result };
  }

  private send<T>(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    const message: BackendRequest = { id, command, args };
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
      };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BackendError("backend_timeout", `Lệnh ${command} quá thời gian chờ`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.child?.postMessage(message);
      } catch (err) {
        this.settle(id)?.reject(new BackendError("backend_unavailable", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  private handleMessage(raw: unknown): void {
    if (!isRecord(raw)) {
      this.opts.log?.("warn", "ignored non-object backend message");
      return;
    }
    if (typeof raw.id === "number" && typeof raw.ok === "boolean") {
      const reply = raw as unknown as BackendReply;
      const entry = this.settle(reply.id);
      if (!entry) return;
      if (reply.ok) entry.resolve(reply.value);
      else {
        const w = toWireError(reply.error);
        entry.reject(new BackendError(w.code, w.message));
      }
      return;
    }
    if (typeof raw.event === "string") {
      this.handlePush(raw.event, raw.payload);
      return;
    }
    this.opts.log?.("warn", "ignored unrecognised backend message");
  }

  private handlePush(event: string, payload: unknown): void {
    if (event === BACKEND_CONTROL.ready) {
      if (this._state !== "starting" || !this.readyWaiter) return;
      const p = isRecord(payload) ? payload : {};
      if (p.protocol !== BACKEND_PROTOCOL_VERSION) {
        this.failStart(
          new BackendError(
            "backend_protocol_mismatch",
            `Dịch vụ nền dùng giao thức ${String(p.protocol)}, cần ${BACKEND_PROTOCOL_VERSION}`
          )
        );
        return;
      }
      this._state = "ready";
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      waiter.resolve({ protocol: BACKEND_PROTOCOL_VERSION, version: typeof p.version === "string" ? p.version : undefined });
      return;
    }
    if (event === BACKEND_CONTROL.fatal) {
      const w = toWireError(payload);
      if (this._state === "starting") this.failStart(new BackendError(w.code, w.message));
      else this.opts.log?.("error", `backend fatal: ${w.code}: ${w.message}`);
      return;
    }
    for (const l of this.pushListeners) {
      try {
        l(event, payload);
      } catch (err) {
        this.opts.log?.("error", `push listener threw for ${event}: ${String(err)}`);
      }
    }
  }

  private failStart(err: BackendError): void {
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    if (this._state === "starting") this._state = "failed";
    this.child?.kill();
    waiter?.reject(err);
  }

  private handleExit(code: number | null): void {
    this.exitCode = code;
    const expected = this._state === "stopping";
    const startingErr = this.readyWaiter
      ? new BackendError("backend_exit", `Dịch vụ nền thoát sớm (mã ${String(code)})`)
      : null;
    this._state = expected ? "stopped" : "failed";
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        expected
          ? new BackendError("shutting_down", "Ứng dụng đang thoát")
          : new BackendError("backend_exited", `Dịch vụ nền đã dừng đột ngột (mã ${String(code)})`)
      );
    }
    if (startingErr && this.readyWaiter) {
      const w = this.readyWaiter;
      this.readyWaiter = null;
      w.reject(startingErr);
    }
    for (const w of this.exitWaiters.splice(0)) w(code);
    for (const l of this.exitListeners) l({ expected, code });
  }
}

export interface SupervisorOptions {
  createClient: () => BackendClient;
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffMs?: number;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/** Keeps one `BackendClient` alive; restarts after unexpected exits, gives up after a crash loop. */
export class BackendSupervisor {
  private client: BackendClient | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private readonly pushListeners = new Set<(event: string, payload: unknown) => void>();
  private readonly giveUpListeners = new Set<(err: BackendError) => void>();
  private readonly readyListeners = new Set<() => void>();

  constructor(private readonly opts: SupervisorOptions) {}

  onPush(l: (event: string, payload: unknown) => void): void {
    this.pushListeners.add(l);
  }
  onGiveUp(l: (err: BackendError) => void): void {
    this.giveUpListeners.add(l);
  }
  onReady(l: () => void): void {
    this.readyListeners.add(l);
  }

  get state(): ClientState {
    return this.client?.state ?? "idle";
  }

  async start(): Promise<BackendReadyPayload> {
    const ready = await this.spawnClient();
    return ready;
  }

  request<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) return Promise.reject(new BackendError("backend_unavailable", "Dịch vụ nền chưa sẵn sàng"));
    return this.client.request<T>(command, args);
  }

  async shutdown(graceMs?: number): Promise<{ clean: boolean; code: number | null }> {
    this.stopping = true;
    if (!this.client) return { clean: true, code: null };
    return this.client.shutdown(graceMs);
  }

  private async spawnClient(): Promise<BackendReadyPayload> {
    const client = this.opts.createClient();
    this.client = client;
    client.onPush((e, p) => {
      for (const l of this.pushListeners) l(e, p);
    });
    let wasReady = false;
    client.onExit((info) => {
      // Exits before `backend:ready` surface as a rejected `start()`; the caller handles those.
      if (!wasReady || info.expected || this.stopping || this.client !== client) return;
      void this.handleCrash(info);
    });
    const ready = await client.start();
    wasReady = true;
    for (const l of this.readyListeners) l();
    return ready;
  }

  private async handleCrash(info: ExitInfo): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    this.crashTimes = this.crashTimes.filter((t) => now - t < windowMs);
    this.crashTimes.push(now);
    const max = this.opts.maxRestarts ?? 3;
    if (this.crashTimes.length > max) {
      this.opts.log?.("error", `backend crash loop (${this.crashTimes.length} exits in ${windowMs}ms); giving up`);
      for (const l of this.giveUpListeners) {
        l(new BackendError("backend_crash_loop", `Dịch vụ nền liên tục dừng đột ngột (mã ${String(info.code)})`));
      }
      return;
    }
    this.opts.log?.("warn", `backend exited unexpectedly (code ${String(info.code)}); restarting`);
    await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 500) * this.crashTimes.length));
    if (this.stopping) return;
    try {
      await this.spawnClient();
    } catch (err) {
      if (this.stopping) return;
      const be = err instanceof BackendError ? err : new BackendError("backend_spawn_failed", String(err));
      this.opts.log?.("error", `backend restart failed: ${be.code}: ${be.message}`);
      // A failed restart counts as a crash and is retried until the loop limit trips.
      await this.handleCrash({ expected: false, code: null });
    }
  }
}
