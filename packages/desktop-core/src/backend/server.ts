// utilityProcess request/reply server. Implements the shell contract documented in
// apps/desktop/README.md ("Backend handshake"):
//
//   shell -> backend   { id, command, args }
//   backend -> shell   { id, ok: true, value } | { id, ok: false, error: { code, message } }
//   backend -> shell   { event, payload }
//
//   startup   runtime.start() succeeds -> push `backend:ready` {protocol, version};
//             fails -> push `backend:fatal` {code, message} and exit non-zero.
//   shutdown  request `backend:shutdown` {grace_ms}: stop accepting work, drain in-flight requests
//             up to grace_ms, close the runtime, reply ok, exit 0. Later requests -> `shutting_down`.
//   tray      request `backend:toggle_crawl_paused` -> HealthStatus.

import {
  BACKEND_CONTROL,
  BACKEND_PROTOCOL_VERSION,
  type BackendPush,
  type BackendReply,
  type BackendRequest,
  CoreError,
  CommandError,
  isBackendCommand,
  toWireError,
} from "./wire";

/** Shape of Electron's `process.parentPort` (messages arrive as `{ data }`). */
export interface ParentPortLike {
  on(event: "message", listener: (message: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export type Emit = (event: string, payload: unknown) => void;

export interface BackendRuntime {
  /** Open storage, bind IPC, start workers. `emit` pushes events to the shell. */
  start(emit: Emit): Promise<void>;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  toggleCrawlPaused(): Promise<unknown>;
  /** Stop accepting work, close IPC/SQLite, flush logs. In-flight requests were already drained. */
  shutdown(): Promise<void>;
  readonly version?: string;
}

export interface BackendServerOptions {
  port: ParentPortLike;
  runtime: BackendRuntime;
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

const DEFAULT_GRACE_MS = 10_000;

export class BackendServer {
  private ready: Promise<void> | null = null;
  private shuttingDown = false;
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];
  private readonly exit: (code: number) => void;

  constructor(private readonly options: BackendServerOptions) {
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  /** Begin listening and start the runtime. Resolves once `backend:ready` was pushed. */
  async start(): Promise<void> {
    this.options.port.on("message", (message) => this.onMessage(message.data));
    this.ready = this.options.runtime.start((event, payload) => this.push(event, payload));
    try {
      await this.ready;
    } catch (err) {
      const wire = toWireError(err);
      this.options.log?.(`backend startup failed: ${wire.code}`);
      this.push(BACKEND_CONTROL.fatal, wire);
      // Give the pipe a tick to flush before dying.
      setTimeout(() => this.exit(1), 25);
      throw err;
    }
    this.push(BACKEND_CONTROL.ready, {
      protocol: BACKEND_PROTOCOL_VERSION,
      version: this.options.runtime.version,
    });
  }

  private push(event: string, payload: unknown): void {
    const message: BackendPush = { event, payload };
    try {
      this.options.port.postMessage(message);
    } catch (err) {
      this.options.log?.(`failed to push ${event}: ${(err as Error).message}`);
    }
  }

  private reply(message: BackendReply): void {
    try {
      this.options.port.postMessage(message);
    } catch (err) {
      this.options.log?.(`failed to reply to ${message.id}: ${(err as Error).message}`);
    }
  }

  private onMessage(data: unknown): void {
    const request = parseRequest(data);
    if (!request) return; // not ours; ignore silently
    void this.handle(request);
  }

  private async handle(request: BackendRequest): Promise<void> {
    const { id, command } = request;
    if (command === BACKEND_CONTROL.shutdown) {
      await this.handleShutdown(request);
      return;
    }
    if (this.shuttingDown) {
      this.reply({ id, ok: false, error: toWireError(CoreError.shuttingDown()) });
      return;
    }
    this.inflight += 1;
    try {
      const value = await this.dispatch(request);
      this.reply({ id, ok: true, value: value === undefined ? null : value });
    } catch (err) {
      this.reply({ id, ok: false, error: toWireError(err) });
    } finally {
      this.inflight -= 1;
      if (this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private async dispatch(request: BackendRequest): Promise<unknown> {
    const { command } = request;
    // Requests that race startup wait for it; a failed start rejects them with the same error.
    if (this.ready) await this.ready;

    if (command === BACKEND_CONTROL.toggleCrawlPaused) {
      return this.options.runtime.toggleCrawlPaused();
    }
    // `args` must be a JSON object (or null) like the Rust dispatcher.
    const args = request.args;
    if (args !== null && args !== undefined && (typeof args !== "object" || Array.isArray(args))) {
      throw new CommandError("validation_error", "tham số lệnh IPC phải là đối tượng JSON");
    }
    if (!isBackendCommand(command)) {
      throw new CommandError("unknown_command", `lệnh IPC không tồn tại: ${command}`);
    }
    return this.options.runtime.invoke(command, (args ?? {}) as Record<string, unknown>);
  }

  private async handleShutdown(request: BackendRequest): Promise<void> {
    if (this.shuttingDown) {
      this.reply({ id: request.id, ok: true, value: null });
      return;
    }
    this.shuttingDown = true;
    const grace = graceFrom(request.args);
    try {
      await this.drain(grace);
      await this.options.runtime.shutdown();
      this.reply({ id: request.id, ok: true, value: null });
      setTimeout(() => this.exit(0), 10);
    } catch (err) {
      this.reply({ id: request.id, ok: false, error: toWireError(err) });
      setTimeout(() => this.exit(1), 10);
    }
  }

  /** Wait until no request is in flight, at most `graceMs`. */
  private drain(graceMs: number): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function parseRequest(data: unknown): BackendRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "number" || typeof d.command !== "string") return null;
  return { id: d.id, command: d.command, args: (d.args ?? null) as BackendRequest["args"] };
}

function graceFrom(args: BackendRequest["args"]): number {
  const g = args && typeof args === "object" ? (args as Record<string, unknown>).grace_ms : undefined;
  return typeof g === "number" && Number.isFinite(g) && g >= 0 ? g : DEFAULT_GRACE_MS;
}
