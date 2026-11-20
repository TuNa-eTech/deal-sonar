import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDesktopCaller, DesktopCallError, MSG_UNAVAILABLE } from "../src/agent-client.js";
import { issueAgentToken, AgentError, type AgentBackend } from "../src/agent-protocol.js";
import { MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import {
  DesktopIpcServer,
  ELECTRON_LOCK_SUFFIX,
  connectIpc,
  writeFrame,
  type ExtensionConnection,
} from "../src/ipc.js";
import { FrameCollector, cleanupTmpDirs, isWindows, sleep, testEndpoint, tmpDir, waitFor } from "./helpers.js";

afterAll(cleanupTmpDirs);

const servers: DesktopIpcServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function bind(opts: Partial<Parameters<typeof DesktopIpcServer.bind>[0]> & { endpoint: string }) {
  const server = await DesktopIpcServer.bind({ onExtensionConnection: () => undefined, ...opts });
  servers.push(server);
  return server;
}

describe("DesktopIpcServer: extension connections", () => {
  it("hands relay connections to the backend and supports full-duplex frames", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    const received: Buffer[] = [];
    let conn = null as ExtensionConnection | null;
    await bind({
      endpoint,
      onExtensionConnection: (c) => {
        conn = c;
        c.onFrame((f) => received.push(f));
      },
    });

    const client = await connectIpc(endpoint);
    const fromServer = new FrameCollector(client, MAX_HOST_TO_EXT_BYTES);
    await writeFrame(client, Buffer.from('{"v":2,"id":"1","type":"hello"}'), MAX_EXT_TO_HOST_BYTES);
    await writeFrame(client, Buffer.from('{"v":2,"id":"2","type":"ping"}'), MAX_EXT_TO_HOST_BYTES);
    await waitFor(() => received.length === 2);
    expect(received.map(String)).toEqual(['{"v":2,"id":"1","type":"hello"}', '{"v":2,"id":"2","type":"ping"}']);

    await conn!.sendEnvelope({ v: 2, id: "S1", reply_to: "1", type: "hello.ok" });
    expect((await fromServer.json(0)).type).toBe("hello.ok");
    client.destroy();
  });

  it("answers an oversized declared frame with invalid_payload and closes", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    await bind({ endpoint });
    const client = await connectIpc(endpoint);
    const frames = new FrameCollector(client, MAX_HOST_TO_EXT_BYTES);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_EXT_TO_HOST_BYTES + 1, 0);
    client.write(header);
    const env = await frames.json(0);
    expect(env.type).toBe("error");
    expect(env.payload.code).toBe("invalid_payload");
    expect(env.payload.retryable).toBe(false);
    expect(env.payload.message).toMatch(/exceeds max/);
    await waitFor(() => frames.ended);
  });

  it("close() drops relays (EOF) and removes the socket files", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    const server = await bind({ endpoint, onExtensionConnection: () => undefined });
    const client = await connectIpc(endpoint);
    const frames = new FrameCollector(client);
    client.write(Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from("{}")]));
    await sleep(30);
    await server.close();
    await waitFor(() => frames.ended);
    if (!isWindows) {
      expect(fs.existsSync(endpoint)).toBe(false);
      expect(fs.existsSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`)).toBe(false);
    }
  });
});

describe.skipIf(isWindows)("DesktopIpcServer: Unix same-user safeguards", () => {
  it("creates the socket dir 0700 and the socket 0600", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    await bind({ endpoint });
    expect(fs.statSync(path.dirname(endpoint)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(endpoint).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`).mode & 0o777).toBe(0o600);
  });

  it("refuses to bind over a live listener or a non-socket file", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    await bind({ endpoint });
    await expect(DesktopIpcServer.bind({ endpoint, onExtensionConnection: () => undefined })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    // The live server must be unaffected.
    const client = await connectIpc(endpoint);
    client.destroy();

    const other = path.join(tmpDir(), "s", "x.sock");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "not a socket");
    await expect(DesktopIpcServer.bind({ endpoint: other, onExtensionConnection: () => undefined })).rejects.toThrow(
      /non-socket/,
    );
    expect(fs.readFileSync(other, "utf8")).toBe("not a socket");
  });

  it("reclaims a stale socket file left by a dead listener", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    // Create a socket inode with no listener behind it: bind, then keep the file past close.
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(endpoint, r));
    const backup = `${endpoint}.bak`;
    fs.renameSync(endpoint, backup); // dodge libuv's unlink-on-close
    await new Promise<void>((r) => tmp.close(() => r()));
    fs.renameSync(backup, endpoint);
    expect(fs.lstatSync(endpoint).isSocket()).toBe(true);
    await bind({ endpoint });
    const client = await connectIpc(endpoint);
    client.destroy();
  });

  it("clients refuse an endpoint that is not a socket", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "plain");
    fs.writeFileSync(file, "x");
    await expect(connectIpc(file)).rejects.toThrow(/not a socket/);
  });

  it("rejects over-long socket paths with a clear error", async () => {
    const long = path.join(tmpDir(), "s".repeat(120), "i.sock");
    await expect(DesktopIpcServer.bind({ endpoint: long, onExtensionConnection: () => undefined })).rejects.toThrow(/too long/);
  });
});

describe.skipIf(isWindows)("legacy Tauri lock compatibility (upgrade path)", () => {
  const PY = `
import os, socket, sys, threading, time
ep, mode = sys.argv[1], sys.argv[2]
lock = ep + ".lock"
d = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
d.bind(lock); os.chmod(lock, 0o600)
if mode == "live":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(ep); os.chmod(ep, 0o600); s.listen(8)
    def acc():
        while True:
            c, _ = s.accept(); c.close()
    threading.Thread(target=acc, daemon=True).start()
print("ready", flush=True)
time.sleep(600)
`;
  const havePython = spawnSync("python3", ["--version"]).status === 0;
  const legacyChildren: ChildProcess[] = [];
  afterEach(() => {
    for (const c of legacyChildren.splice(0)) c.kill("SIGKILL");
  });

  /** Holds a Unix DATAGRAM lock (as the Rust IpcListener does) and optionally a live stream endpoint. */
  async function startLegacy(endpoint: string, mode: "live" | "lock-only"): Promise<void> {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    const child = spawn("python3", ["-c", PY, endpoint, mode], { stdio: ["ignore", "pipe", "inherit"] });
    legacyChildren.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
      child.once("exit", () => reject(new Error("legacy fixture exited early")));
    });
  }

  const inode = (p: string) => fs.lstatSync(p).ino;

  it.skipIf(!havePython)("refuses to bind over a live legacy listener and leaves its endpoint and datagram lock untouched", async () => {
    const endpoint = testEndpoint(tmpDir());
    await startLegacy(endpoint, "live");
    const before = { ep: inode(endpoint), lock: inode(`${endpoint}.lock`) };

    await expect(DesktopIpcServer.bind({ endpoint, onExtensionConnection: () => undefined })).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(inode(endpoint)).toBe(before.ep);
    expect(inode(`${endpoint}.lock`)).toBe(before.lock);
    expect(fs.existsSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`)).toBe(false);
    (await connectIpc(endpoint)).destroy(); // legacy listener still functional
  });

  it.skipIf(!havePython)("never unlinks a legacy datagram .lock, even when the legacy process left only the lock", async () => {
    const endpoint = testEndpoint(tmpDir());
    await startLegacy(endpoint, "lock-only");
    const lockBefore = inode(`${endpoint}.lock`);

    const server = await bind({ endpoint });
    expect(inode(`${endpoint}.lock`)).toBe(lockBefore);
    expect(fs.existsSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`)).toBe(true);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(inode(`${endpoint}.lock`)).toBe(lockBefore);
    expect(fs.existsSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`)).toBe(false);
  });

  it("stream-only stand-in: a live endpoint plus a live .lock are untouched by a refused bind", async () => {
    const endpoint = testEndpoint(tmpDir());
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    const legacyEndpoint = net.createServer((s) => s.destroy());
    const legacyLock = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => legacyEndpoint.listen(endpoint, r));
    await new Promise<void>((r) => legacyLock.listen(`${endpoint}.lock`, r));
    const before = { ep: inode(endpoint), lock: inode(`${endpoint}.lock`) };
    try {
      await expect(DesktopIpcServer.bind({ endpoint, onExtensionConnection: () => undefined })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(inode(endpoint)).toBe(before.ep);
      expect(inode(`${endpoint}.lock`)).toBe(before.lock);
      expect(fs.existsSync(`${endpoint}${ELECTRON_LOCK_SUFFIX}`)).toBe(false);
      (await connectIpc(endpoint)).destroy();
    } finally {
      legacyEndpoint.close();
      legacyLock.close();
    }
  });

  it("a second Electron instance is refused without disturbing the first one's lock inode", async () => {
    const endpoint = testEndpoint(tmpDir());
    await bind({ endpoint });
    const lock = `${endpoint}${ELECTRON_LOCK_SUFFIX}`;
    const before = { ep: inode(endpoint), lock: inode(lock) };
    await expect(DesktopIpcServer.bind({ endpoint, onExtensionConnection: () => undefined })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(inode(endpoint)).toBe(before.ep);
    expect(inode(lock)).toBe(before.lock);
  });

  it("guards the lock path length as well as the endpoint length", async () => {
    const dir = tmpDir();
    const limit = process.platform === "darwin" ? 103 : 107;
    const base = path.join(dir, "s", "i");
    const endpoint = base + "x".repeat(limit - base.length - 1); // endpoint fits; endpoint + ".e" does not
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(endpoint + ELECTRON_LOCK_SUFFIX)).toBeGreaterThan(limit);
    await expect(DesktopIpcServer.bind({ endpoint, onExtensionConnection: () => undefined })).rejects.toThrow(/too long/);
    expect(fs.existsSync(path.dirname(endpoint))).toBe(false); // nothing was created
  });
});

describe("agent requests over the real transport", () => {
  async function setup(backend: AgentBackend | null, issue = true) {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    const token = issue ? issueAgentToken(dir) : null;
    await bind({ endpoint, agentToken: token, agentBackend: backend });
    const env = { DEALSONAR_DATA_DIR: dir, DEALSONAR_IPC_PATH: endpoint, HOME: dir, USERPROFILE: dir, APPDATA: dir };
    return { dir, endpoint, env };
  }

  it("round-trips Ok results and AgentError messages", async () => {
    const { env } = await setup({
      handle: async (method, args) => {
        if (method === "retry_radar_preview") throw new AgentError("Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.");
        return { method, args };
      },
    });
    const call = createDesktopCaller({ env });
    expect(await call("list_radar_sources", {})).toEqual({ method: "list_radar_sources", args: {} });
    await expect(call("retry_radar_preview", { radar_id: "r" })).rejects.toThrow("Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.");
  });

  it("rejects a forged token even when the token file is readable by the caller", async () => {
    const { dir, env } = await setup({ handle: async () => ({ leaked: true }) });
    fs.writeFileSync(path.join(dir, "agent-access"), Buffer.alloc(32, 1), { mode: 0o600 });
    await expect(createDesktopCaller({ env })("list_radar_sources", {})).rejects.toThrow(/từ chối kết nối agent/);
  });

  it("reports unavailable when the desktop is down, the token is missing, or the reply never comes", async () => {
    const dir = tmpDir();
    const env = { DEALSONAR_DATA_DIR: dir, DEALSONAR_IPC_PATH: testEndpoint(dir), HOME: dir, APPDATA: dir };
    await expect(createDesktopCaller({ env })("list_radar_sources", {})).rejects.toBeInstanceOf(DesktopCallError);
    await expect(createDesktopCaller({ env })("list_radar_sources", {})).rejects.toThrow(MSG_UNAVAILABLE);

    const noToken = await setup(null, false);
    await expect(createDesktopCaller({ env: noToken.env })("list_radar_sources", {})).rejects.toThrow(MSG_UNAVAILABLE);

    const hung = await setup({ handle: () => new Promise(() => undefined) });
    await expect(createDesktopCaller({ env: hung.env, timeoutMs: 150 })("list_radar_sources", {})).rejects.toThrow(
      /không phản hồi trong 15 giây/,
    );
  });

  it("a connection that never sends a frame does not block other clients", async () => {
    const { endpoint, env } = await setup({ handle: async () => "fine" });
    const idle = await connectIpc(endpoint);
    expect(await createDesktopCaller({ env })("list_radar_sources", {})).toBe("fine");
    idle.destroy();
  });
});
