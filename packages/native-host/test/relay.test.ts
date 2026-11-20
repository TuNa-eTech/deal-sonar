import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import { FrameTooLargeError, FrameIoError, encodeFrame } from "../src/framing.js";
import { DesktopIpcServer, connectIpc, type ExtensionConnection } from "../src/ipc.js";
import { runRelay } from "../src/relay.js";
import { FrameCollector, cleanupTmpDirs, frameOf, isWindows, sleep, testEndpoint, tmpDir, waitFor } from "./helpers.js";

afterAll(cleanupTmpDirs);

const servers: DesktopIpcServer[] = [];
const relays: Array<{ stdin: PassThrough; done: Promise<void> }> = [];
afterEach(async () => {
  // Clean EOF for every relay, including after a failed/timed-out assertion, so no timers or
  // sockets outlive the test.
  for (const r of relays.splice(0)) {
    r.stdin.end();
    await Promise.race([r.done.catch(() => undefined), sleep(2_000)]);
  }
  for (const s of servers.splice(0)) await s.close();
});

/** Observable connector seam: counts relay connects that actually succeeded at the socket level. */
function observedConnector() {
  const state = { attempts: 0, connected: 0 };
  const connect = async (endpoint: string) => {
    state.attempts += 1;
    const socket = await connectIpc(endpoint);
    state.connected += 1;
    return socket;
  };
  return { state, connect };
}

interface FakeDesktop {
  server: DesktopIpcServer;
  received: Buffer[];
  connections: ExtensionConnection[];
}

async function startDesktop(endpoint: string): Promise<FakeDesktop> {
  const received: Buffer[] = [];
  const connections: ExtensionConnection[] = [];
  const server = await DesktopIpcServer.bind({
    endpoint,
    onExtensionConnection: (c) => {
      connections.push(c);
      c.onFrame((f) => received.push(f));
    },
  });
  servers.push(server);
  return { server, received, connections };
}

function startRelay(endpoint: string, reconnectIntervalMs = 40, connect?: (endpoint: string) => Promise<net.Socket>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = new FrameCollector(stdout, MAX_HOST_TO_EXT_BYTES);
  const done = runRelay(stdin, stdout, { endpoint, reconnectIntervalMs, connect });
  done.catch(() => undefined); // assertions below observe the outcome explicitly
  relays.push({ stdin, done });
  return { stdin, stdout, out, done };
}

const hello = { v: 2, id: "01A", ts: 1, reply_to: null, type: "hello", payload: { profile_id: "p", ext_version: "0", browser: "chrome/1", config_rev: 0 } };

describe("relay with desktop available", () => {
  it("forwards frames verbatim in both directions", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const { stdin, out, done } = startRelay(endpoint);

    stdin.write(frameOf(hello));
    await waitFor(() => desktop.received.length === 1);
    expect(JSON.parse(desktop.received[0]!.toString())).toEqual(hello);

    await desktop.connections[0]!.sendEnvelope({ v: 2, id: "01B", ts: 2, reply_to: "01A", type: "hello.ok", payload: { desktop_version: "1", config_rev: 0 } });
    expect((await out.json(0)).reply_to).toBe("01A");

    // Raw bytes are not re-serialized: odd-but-valid JSON survives byte-for-byte.
    const odd = Buffer.from('{ "v":2,  "id":"01C", "type":"ping" , "payload":{} }');
    stdin.write(encodeFrame(odd, MAX_EXT_TO_HOST_BYTES));
    await waitFor(() => desktop.received.length === 2);
    expect(desktop.received[1]!.equals(odd)).toBe(true);

    stdin.end();
    await done;
  });

  it("handles frames split across arbitrary stdin chunks and many frames in one chunk", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const { stdin, done } = startRelay(endpoint);
    const wire = Buffer.concat([1, 2, 3].map((n) => frameOf({ v: 2, id: `I${n}`, type: "ping", payload: {} })));
    for (let i = 0; i < wire.length; i += 7) stdin.write(wire.subarray(i, i + 7));
    await waitFor(() => desktop.received.length === 3);
    expect(desktop.received.map((f) => JSON.parse(f.toString()).id)).toEqual(["I1", "I2", "I3"]);
    stdin.end();
    await done;
  });

  it("clean stdin EOF closes the IPC connection and resolves", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const { stdin, done } = startRelay(endpoint);
    stdin.write(frameOf(hello));
    await waitFor(() => desktop.received.length === 1);
    let closed = false;
    desktop.connections[0]!.onClose(() => {
      closed = true;
    });
    stdin.end();
    await done;
    await waitFor(() => closed);
  });

  it("holds early stdin frames until the initial connection attempt settles", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = new FrameCollector(stdout);
    stdin.write(frameOf(hello)); // already queued before relay starts
    const done = runRelay(stdin, stdout, { endpoint, reconnectIntervalMs: 40 });
    await waitFor(() => desktop.received.length === 1);
    expect(out.frames.length).toBe(0); // no spurious desktop_unavailable
    stdin.end();
    await done;
  });

  it("an oversized desktop->extension frame is treated as a disconnect and the relay reconnects", async () => {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    if (!isWindows) fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    let accepted = 0;
    const raw = net.createServer((s) => {
      accepted += 1;
      s.on("error", () => undefined);
      if (accepted === 1) {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(MAX_HOST_TO_EXT_BYTES + 1, 0); // 1 MiB + 1 > host->extension limit
        s.write(header);
      }
    });
    await new Promise<void>((resolve) => raw.listen(endpoint, resolve));
    try {
      const { stdin, out, done } = startRelay(endpoint, 30);
      await waitFor(() => accepted >= 2, 3_000);
      expect(out.frames).toEqual([]);
      stdin.end();
      await done;
    } finally {
      raw.close();
    }
  });
});

describe("relay with desktop unavailable", () => {
  it("replies desktop_unavailable to each frame, then reconnects on the interval", async () => {
    const endpoint = testEndpoint(tmpDir());
    const connector = observedConnector();
    const { stdin, out, done } = startRelay(endpoint, 60, connector.connect);

    stdin.write(frameOf({ v: 2, id: "REQ1", type: "ping", payload: {} }));
    stdin.write(frameOf({ v: 2, id: "REQ2", type: "ping", payload: {} }));
    const e1 = await out.json(0);
    const e2 = await out.json(1);
    for (const [env, id] of [[e1, "REQ1"], [e2, "REQ2"]] as const) {
      expect(env.v).toBe(2);
      expect(env.type).toBe("error");
      expect(env.reply_to).toBe(id);
      expect(env.payload.code).toBe("desktop_unavailable");
      expect(env.payload.retryable).toBe(true);
    }
    expect(connector.state.connected).toBe(0);

    // Reconnect timing: keeps retrying on the interval while the desktop is down.
    const attemptsBefore = connector.state.attempts;
    await waitFor(() => connector.state.attempts >= attemptsBefore + 2, 3_000);

    // The desktop only classifies a stream after its first frame, so wait for the relay's
    // actual socket connect (observable via the connector seam), not for onExtensionConnection.
    const desktop = await startDesktop(endpoint);
    await waitFor(() => connector.state.connected === 1, 3_000);
    stdin.write(frameOf({ v: 2, id: "REQ3", type: "ping", payload: {} }));
    await waitFor(() => desktop.received.length === 1);
    expect(JSON.parse(desktop.received[0]!.toString()).id).toBe("REQ3");
    expect(desktop.connections).toHaveLength(1);
    expect(out.frames.length).toBe(2);
    stdin.end();
    await done;
  });

  it("answers with reply_to null when the frame has no usable id", async () => {
    const { stdin, out, done } = startRelay(testEndpoint(tmpDir()), 1_000);
    stdin.write(frameOf("definitely not json"));
    expect((await out.json(0)).reply_to).toBeNull();
    stdin.end();
    await done;
  });

  it("recovers after the desktop drops mid-stream", async () => {
    const endpoint = testEndpoint(tmpDir());
    const first = await startDesktop(endpoint);
    const connector = observedConnector();
    const { stdin, out, done } = startRelay(endpoint, 50, connector.connect);
    stdin.write(frameOf(hello));
    await waitFor(() => first.received.length === 1);
    expect(connector.state.connected).toBe(1);

    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    await sleep(80); // let the relay observe the close

    stdin.write(frameOf({ v: 2, id: "DURING", type: "ping", payload: {} }));
    const err = await out.json(0);
    expect(err.payload.code).toBe("desktop_unavailable");
    expect(err.reply_to).toBe("DURING");

    // Wait for the relay's real reconnect (second successful connect), then send the first frame.
    const second = await startDesktop(endpoint);
    await waitFor(() => connector.state.connected === 2, 3_000);
    stdin.write(frameOf({ v: 2, id: "RECOVERED", type: "ping", payload: {} }));
    await waitFor(() => second.received.length === 1);
    expect(JSON.parse(second.received[0]!.toString()).id).toBe("RECOVERED");
    expect(second.connections).toHaveLength(1);
    stdin.end();
    await done;
  });

  it("clean EOF while disconnected resolves without output", async () => {
    const { stdin, out, done } = startRelay(testEndpoint(tmpDir()), 1_000);
    stdin.end();
    await done;
    expect(out.frames).toEqual([]);
  });
});

describe("relay stdio failures", () => {
  it("rejects with FrameTooLargeError for a stdin frame over 64 MiB", async () => {
    const { stdin, done } = startRelay(testEndpoint(tmpDir()), 1_000);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_EXT_TO_HOST_BYTES + 1, 0);
    stdin.write(header);
    await expect(done).rejects.toBeInstanceOf(FrameTooLargeError);
  });

  it("rejects when stdin ends mid-frame", async () => {
    const { stdin, done } = startRelay(testEndpoint(tmpDir()), 1_000);
    stdin.write(Buffer.from([10, 0, 0, 0, 0x7b]));
    stdin.end();
    await expect(done).rejects.toBeInstanceOf(FrameIoError);
  });

  it("rejects when stdout fails", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runRelay(stdin, stdout, { endpoint: testEndpoint(tmpDir()), reconnectIntervalMs: 1_000 });
    const failed = expect(done).rejects.toThrow();
    stdin.write(frameOf({ v: 2, id: "X", type: "ping", payload: {} }));
    await sleep(30);
    stdout.destroy(new Error("EPIPE"));
    await failed;
  });
});

describe("relay backpressure", () => {
  it("delivers every frame in order when stdout is slow to drain", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const stdin = new PassThrough();
    const stdout = new PassThrough({ highWaterMark: 16 * 1024 });
    const done = runRelay(stdin, stdout, { endpoint, reconnectIntervalMs: 50 });
    stdin.write(frameOf(hello));
    await waitFor(() => desktop.connections.length === 1);
    const conn = desktop.connections[0]!;

    const total = 60;
    const payload = "p".repeat(40 * 1024);
    const sent = (async () => {
      for (let i = 0; i < total; i += 1) await conn.sendEnvelope({ seq: i, payload });
    })();
    // Let data accumulate against a stalled consumer before reading.
    await sleep(150);
    const out = new FrameCollector(stdout, MAX_HOST_TO_EXT_BYTES);
    await sent;
    await out.waitForCount(total, 10_000);
    expect(out.frames.map((f) => JSON.parse(f.toString()).seq)).toEqual([...Array(total).keys()]);
    stdin.end();
    await done;
  });

  it("pauses stdin while the desktop is not reading, then drains everything", async () => {
    const endpoint = testEndpoint(tmpDir());
    const desktop = await startDesktop(endpoint);
    const { stdin, done } = startRelay(endpoint);
    stdin.write(frameOf(hello));
    await waitFor(() => desktop.connections.length === 1);
    desktop.connections[0]!.pause();

    const count = 40;
    const body = "q".repeat(256 * 1024);
    for (let i = 0; i < count; i += 1) stdin.write(frameOf({ v: 2, id: `B${i}`, type: "posts.push", payload: { body } }));
    await sleep(150);
    expect(desktop.received.length).toBeLessThan(count); // flow control engaged
    desktop.connections[0]!.resume();
    await waitFor(() => desktop.received.length === count + 1, 15_000);
    expect(JSON.parse(desktop.received[count]!.toString()).id).toBe(`B${count - 1}`);
    stdin.end();
    await done;
  });
});
