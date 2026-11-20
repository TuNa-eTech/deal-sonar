/**
 * Local IPC transport (Unix domain socket / Windows named pipe) with 4-byte LE framing.
 * Client side is used by the relay and MCP adapter; the server side
 * (`DesktopIpcServer`) is a port of `IpcListener` + the transport half of
 * `crates/core/src/ipc_server.rs` and hands protocol/agent work to backend callbacks.
 *
 * Same-user safeguards (Unix): socket directory is created/forced to 0700 and must be owned
 * by the current user, sockets are chmod 0600, clients refuse sockets not owned by the
 * current user, and a live-listener probe prevents hijacking an active socket.
 * Windows: `net` creates the first pipe instance exclusively (libuv uses
 * FILE_FLAG_FIRST_PIPE_INSTANCE for the bound handle) and rejects remote clients; the pipe
 * name embeds the user name. Business-level auth for agent requests is the agent token.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  AGENT_FRAME_PREFIX,
  AGENT_MAX_FRAME_BYTES,
  MAX_EXT_TO_HOST_BYTES,
  MAX_HOST_TO_EXT_BYTES,
} from "./constants.js";
import { buildErrorEnvelope } from "./envelope.js";
import {
  FrameDecoder,
  FrameIoError,
  FrameTooLargeError,
  encodeFrame,
} from "./framing.js";
import { handleAgentFrame, type AgentBackend } from "./agent-protocol.js";

const isWindows = process.platform === "win32";

// ── Client ───────────────────────────────────────────────────────────────

/** Refuse Unix sockets that are not sockets or are owned by a different user. */
export function assertSocketOwnedByCurrentUser(endpoint: string): void {
  if (isWindows || typeof process.getuid !== "function") return;
  const st = fs.lstatSync(endpoint);
  if (!st.isSocket()) throw new Error("IPC endpoint is not a socket");
  if (st.uid !== process.getuid()) {
    throw new Error("IPC socket is not owned by the current user");
  }
}

/** Connect to the desktop IPC endpoint; rejects when unavailable or not same-user. */
export function connectIpc(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    try {
      assertSocketOwnedByCurrentUser(endpoint);
    } catch (error) {
      reject(error);
      return;
    }
    const socket = net.connect({ path: endpoint });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/** Read exactly one frame (<= maxBytes) from `socket`; null on clean EOF before any byte. */
export function readOneFrame(socket: net.Socket, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder(maxBytes);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onEnd);
      fn();
    };
    const onData = (chunk: Buffer) => {
      try {
        decoder.push(chunk, (frame) => {
          if (!done) finish(() => resolve(frame));
        });
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onEnd = () => {
      finish(() => {
        try {
          decoder.finish();
          resolve(null);
        } catch (error) {
          reject(error);
        }
      });
    };
    const onError = (error: Error) => finish(() => reject(new FrameIoError(error.message)));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
}

/** Write one frame and resolve when flushed to the kernel. */
export function writeFrame(socket: net.Socket, payload: Uint8Array, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf: Buffer;
    try {
      buf = encodeFrame(payload, maxBytes);
    } catch (error) {
      reject(error);
      return;
    }
    socket.write(buf, (error) => (error ? reject(new FrameIoError(error.message)) : resolve()));
  });
}

// ── Server ───────────────────────────────────────────────────────────────

/** One Chrome-profile relay connection as seen by the backend. */
export interface ExtensionConnection {
  readonly id: number;
  /** Register the (single) handler for extension -> desktop frames (<= 64 MiB each). */
  onFrame(handler: (frame: Buffer) => void): void;
  onClose(handler: () => void): void;
  /** Send one desktop -> extension frame (<= 1 MiB). Resolves when written to the socket. */
  sendFrame(frame: Uint8Array): Promise<void>;
  /** Serialize + send a JSON envelope (<= 1 MiB). */
  sendEnvelope(envelope: unknown): Promise<void>;
  /** Stop/resume delivering frames (read backpressure). */
  pause(): void;
  resume(): void;
  /** Bytes queued for the relay but not yet flushed. */
  readonly bufferedBytes: number;
  close(): void;
}

class ExtensionConnectionImpl implements ExtensionConnection {
  private frameHandler: ((frame: Buffer) => void) | null = null;
  private readonly closeHandlers: Array<() => void> = [];
  private readonly backlog: Buffer[] = [];
  private closed = false;

  constructor(
    readonly id: number,
    private readonly socket: net.Socket,
  ) {}

  onFrame(handler: (frame: Buffer) => void): void {
    this.frameHandler = handler;
    while (this.backlog.length > 0 && this.frameHandler) {
      this.frameHandler(this.backlog.shift()!);
    }
  }

  onClose(handler: () => void): void {
    if (this.closed) handler();
    else this.closeHandlers.push(handler);
  }

  /** @internal */
  deliver(frame: Buffer): void {
    if (this.frameHandler) this.frameHandler(frame);
    else this.backlog.push(frame);
  }

  /** @internal */
  notifyClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers.splice(0)) h();
  }

  sendFrame(frame: Uint8Array): Promise<void> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new FrameIoError("connection closed"));
    }
    return writeFrame(this.socket, frame, MAX_HOST_TO_EXT_BYTES);
  }

  sendEnvelope(envelope: unknown): Promise<void> {
    return this.sendFrame(Buffer.from(JSON.stringify(envelope), "utf8"));
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  get bufferedBytes(): number {
    return this.socket.writableLength;
  }

  close(): void {
    this.socket.end();
  }
}

export interface DesktopIpcServerOptions {
  /** Unix socket path or Windows pipe path (`\\.\pipe\...`). */
  endpoint: string;
  /** Expected 32-byte agent token (from `issueAgentToken`); null disables agent requests. */
  agentToken?: Buffer | null;
  /** Backend implementation of the four agent methods. */
  agentBackend?: AgentBackend | null;
  /** Lazy authorization for a listener acquired before its database is opened. */
  agentAccess?: () => { token: Buffer; backend: AgentBackend } | null;
  /** Called once per relay connection after its first frame was classified as protocol traffic. */
  onExtensionConnection: (connection: ExtensionConnection) => void;
  logger?: (message: string) => void;
}

const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;
/** Electron's own stream lock; distinct from the legacy Tauri `<endpoint>.lock` Unix datagram. */
export const ELECTRON_LOCK_SUFFIX = ".e";

/** Throws EADDRINUSE/EEXIST when `endpoint` is a live listener or a non-socket; touches nothing. */
async function assertEndpointNotActive(endpoint: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(endpoint);
  } catch {
    return;
  }
  if (!st.isSocket()) {
    throw Object.assign(new Error(`refusing to overwrite non-socket file at ${endpoint}`), { code: "EEXIST" });
  }
  if (await probeAlive(endpoint)) {
    throw Object.assign(new Error(`an active IPC socket is already listening at ${endpoint}`), {
      code: "EADDRINUSE",
    });
  }
}

function listenAsync(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeAsync(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Resolves true when something is accepting connections at `endpoint`. */
export function probeAlive(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: endpoint });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/** Create `dir` (0700) or require it be owned by us, then force mode 0700. */
export function ensureSecureSocketDir(dir: string): void {
  if (isWindows) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error(`socket directory is not a directory: ${dir}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`refusing socket directory not owned by the current user: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
}

async function reclaimStaleUnixPath(file: string, what: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isSocket()) {
    throw Object.assign(new Error(`refusing to overwrite non-socket ${what} at ${file}`), {
      code: "EEXIST",
    });
  }
  if (await probeAlive(file)) {
    throw Object.assign(
      new Error(`an active DealSonar IPC server is already listening at ${file}`),
      { code: "EADDRINUSE" },
    );
  }
  fs.unlinkSync(file);
}

/**
 * Desktop-side IPC listener. Accepts relay connections (one per Chrome profile) and agent
 * (MCP) requests. First frame decides: `DealSonarAgent/1\n`-prefixed => one-shot agent
 * request/response; anything else => long-lived extension connection handed to the backend.
 */
export class DesktopIpcServer {
  readonly endpoint: string;
  private readonly sockets = new Set<net.Socket>();
  private nextConnId = 1;
  private closed = false;
  private boundInode: number | null = null;

  private constructor(
    private readonly options: DesktopIpcServerOptions,
    private readonly server: net.Server,
    private readonly lockServer: net.Server | null,
    private readonly lockPath: string | null,
    private readonly lockInode: number | null,
  ) {
    this.endpoint = options.endpoint;
  }

  static async bind(options: DesktopIpcServerOptions): Promise<DesktopIpcServer> {
    const { endpoint } = options;
    let lockServer: net.Server | null = null;
    let lockPath: string | null = null;
    let lockInode: number | null = null;
    if (!isWindows) {
      // Guard BOTH OS path limits (endpoint and our lock path) before touching anything.
      lockPath = `${endpoint}${ELECTRON_LOCK_SUFFIX}`;
      for (const p of [endpoint, lockPath]) {
        if (Buffer.byteLength(p) > SOCKET_PATH_LIMIT) {
          throw new Error(`IPC socket path is too long (${Buffer.byteLength(p)} bytes): ${p}`);
        }
      }
      const parent = path.dirname(endpoint);
      if (parent !== "") ensureSecureSocketDir(parent);

      // 1. Reject an active (possibly legacy Tauri) endpoint before creating or removing any file.
      //    A legacy `<endpoint>.lock` Unix datagram socket is NEVER probed, unlinked or replaced:
      //    Node cannot speak datagram, and probing it as a stream could misclassify a live lock
      //    as stale.
      await assertEndpointNotActive(endpoint);

      // 2. Our own stream lock lives at `<endpoint>.e`; only that path may be reclaimed.
      await reclaimStaleUnixPath(lockPath, "lock file");
      lockServer = net.createServer((s) => s.destroy());
      await listenAsync(lockServer, lockPath);
      fs.chmodSync(lockPath, 0o600);
      lockInode = fs.lstatSync(lockPath).ino;

      // 3. Re-check under our lock, then clear a genuinely stale endpoint socket.
      try {
        await reclaimStaleUnixPath(endpoint, "file");
      } catch (error) {
        await closeAsync(lockServer);
        throw error;
      }
    }

    const server = net.createServer();
    const instance = new DesktopIpcServer(options, server, lockServer, lockPath, lockInode);
    server.on("connection", (socket) => instance.accept(socket));
    try {
      await listenAsync(server, endpoint);
    } catch (error) {
      if (lockServer) await closeAsync(lockServer);
      throw error;
    }
    if (!isWindows) {
      fs.chmodSync(endpoint, 0o600);
      instance.boundInode = fs.lstatSync(endpoint).ino;
    }
    return instance;
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }

  private accept(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", (error) => this.log(`ipc connection error: ${error.message}`));

    const decoder = new FrameDecoder(MAX_EXT_TO_HOST_BYTES);
    let mode: "pending" | "agent" | "extension" = "pending";
    let connection: ExtensionConnectionImpl | null = null;

    socket.on("close", () => connection?.notifyClosed());
    socket.on("data", (chunk: Buffer) => {
      if (mode === "agent") return;
      try {
        decoder.push(chunk, (frame) => {
          if (mode === "agent") return;
          if (mode === "pending") {
            if (
              frame.length >= AGENT_FRAME_PREFIX.length &&
              frame.subarray(0, AGENT_FRAME_PREFIX.length).equals(AGENT_FRAME_PREFIX)
            ) {
              mode = "agent";
              void this.serveAgent(socket, frame.subarray(AGENT_FRAME_PREFIX.length));
              return;
            }
            mode = "extension";
            connection = new ExtensionConnectionImpl(this.nextConnId++, socket);
            this.options.onExtensionConnection(connection);
          }
          connection!.deliver(frame);
        });
      } catch (error) {
        if (error instanceof FrameTooLargeError) {
          // Rust: reply `invalid_payload` (non-retryable) and drop the connection.
          const env = buildErrorEnvelope(
            null,
            "invalid_payload",
            `frame length ${error.size} exceeds max ${error.max}`,
            false,
          );
          try {
            socket.end(encodeFrame(Buffer.from(JSON.stringify(env), "utf8"), MAX_HOST_TO_EXT_BYTES));
          } catch {
            socket.destroy();
          }
        } else {
          socket.destroy();
        }
      }
    });
  }

  private async serveAgent(socket: net.Socket, payload: Buffer): Promise<void> {
    const options = this.options;
    const access = options.agentAccess
      ? options.agentAccess()
      : { token: options.agentToken, backend: options.agentBackend };
    const response = await handleAgentFrame(payload, access?.token ?? null, access?.backend ?? null);
    try {
      const frame = encodeFrame(Buffer.from(JSON.stringify(response), "utf8"), AGENT_MAX_FRAME_BYTES);
      socket.end(frame);
    } catch {
      socket.destroy();
    }
  }

  /** Stop accepting, drop every connection (relays observe EOF) and remove socket files we own. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await closeAsync(this.server);
    if (this.lockServer) await closeAsync(this.lockServer);
    if (!isWindows) {
      // Remove only the inodes this instance created. A legacy `<endpoint>.lock` is never ours.
      const owned: Array<[string | null, number | null]> = [
        [this.endpoint, this.boundInode],
        [this.lockPath, this.lockInode],
      ];
      for (const [file, inode] of owned) {
        if (!file || inode === null) continue;
        try {
          const st = fs.lstatSync(file);
          if (st.isSocket() && st.ino === inode) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      }
    }
  }
}
