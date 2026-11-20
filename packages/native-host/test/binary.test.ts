/**
 * Full-binary tests: launch the helper exactly like Chrome / an MCP client would, as a separate
 * process with isolated HOME / data dir / IPC endpoint, against an in-process synthetic desktop.
 *
 * The executable under test is, in order of preference:
 *   1. $DEALSONAR_NATIVE_HOST_TEST_BIN  (the real Node SEA binary; run with an EMPTY PATH so no
 *      Node installation can be used), or
 *   2. a fresh esbuild bundle run with the current node (development fallback).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundleHost } from "../scripts/build-bundle.mjs";
import { issueAgentToken } from "../src/agent-protocol.js";
import { DEFAULT_CHROME_EXTENSION_ID, MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import { DesktopIpcServer, type ExtensionConnection } from "../src/ipc.js";
import { FrameCollector, cleanupTmpDirs, frameOf, testEndpoint, tmpDir, waitFor } from "./helpers.js";

const seaBin = process.env.DEALSONAR_NATIVE_HOST_TEST_BIN;
let command = "";
let baseArgs: string[] = [];

beforeAll(async () => {
  if (seaBin) {
    if (!fs.existsSync(seaBin)) throw new Error(`DEALSONAR_NATIVE_HOST_TEST_BIN not found: ${seaBin}`);
    command = seaBin;
    baseArgs = [];
  } else {
    const bundle = await bundleHost(path.join(tmpDir("dsbundle"), "host.cjs"));
    command = process.execPath;
    baseArgs = [bundle];
  }
});

const servers: DesktopIpcServer[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const s of servers.splice(0)) await s.close();
});
afterAll(cleanupTmpDirs);

interface Sandbox {
  dir: string;
  endpoint: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(): Sandbox {
  const dir = tmpDir();
  const endpoint = testEndpoint(dir);
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: dir,
    XDG_RUNTIME_DIR: dir,
    DEALSONAR_DATA_DIR: dir,
    DEALSONAR_IPC_PATH: endpoint,
    // With a real SEA binary prove that no Node on PATH is needed.
    PATH: seaBin ? "" : (process.env.PATH ?? ""),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  return { dir, endpoint, env };
}

function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, [...baseArgs, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, stderr: () => stderr };
}

async function fakeDesktop(sb: Sandbox, withAgent = false) {
  const received: Buffer[] = [];
  const connections: ExtensionConnection[] = [];
  const token = withAgent ? issueAgentToken(sb.dir) : null;
  const server = await DesktopIpcServer.bind({
    endpoint: sb.endpoint,
    agentToken: token,
    agentBackend: withAgent
      ? {
          handle: async (method, args) =>
            method === "list_radar_sources"
              ? { draft_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", sources: [], max_fields: 5, max_groups: 3 }
              : { method, args, status: "crawling" },
        }
      : null,
    onExtensionConnection: (c) => {
      connections.push(c);
      c.onFrame((f) => received.push(f));
    },
  });
  servers.push(server);
  return { received, connections };
}

const CHROME_ORIGIN = `chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`;

describe("native messaging relay binary", () => {
  it("relays Protocol v2 frames between Chrome stdio and the desktop and exits 0 on EOF", async () => {
    const sb = sandbox();
    const desktop = await fakeDesktop(sb);
    const host = launch([CHROME_ORIGIN], sb.env);
    const out = new FrameCollector(host.child.stdout, MAX_HOST_TO_EXT_BYTES);

    const hello = { v: 2, id: "01A", ts: 1794384000000, reply_to: null, type: "hello", payload: { profile_id: "p_7f3a", ext_version: "0.2.0", browser: "chrome/142", config_rev: 11 } };
    host.child.stdin.write(frameOf(hello));
    await waitFor(() => desktop.received.length === 1, 10_000);
    expect(JSON.parse(desktop.received[0]!.toString())).toEqual(hello);

    await desktop.connections[0]!.sendEnvelope({ v: 2, id: "01B", ts: 1794384000050, reply_to: "01A", type: "hello.ok", payload: { desktop_version: "0.2.0", config_rev: 12 } });
    expect(await out.json(0)).toMatchObject({ type: "hello.ok", reply_to: "01A" });

    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(host.stderr()).toBe("");
    expect(out.frames).toHaveLength(1); // nothing but protocol frames on stdout
  });

  it("starts without a desktop, answers desktop_unavailable, and exits 0 on EOF", async () => {
    const sb = sandbox();
    const host = launch([CHROME_ORIGIN], sb.env);
    const out = new FrameCollector(host.child.stdout, MAX_HOST_TO_EXT_BYTES);
    host.child.stdin.write(frameOf({ v: 2, id: "R1", ts: 1, reply_to: null, type: "ping", payload: {} }));
    const err = await out.json(0, 10_000);
    expect(err).toMatchObject({ v: 2, type: "error", reply_to: "R1", payload: { code: "desktop_unavailable", retryable: true } });
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
  });

  it("exits 1 with a diagnostic on stderr when Chrome sends an over-limit frame", async () => {
    const sb = sandbox();
    const host = launch([CHROME_ORIGIN], sb.env);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_EXT_TO_HOST_BYTES + 1, 0);
    host.child.stdin.write(header);
    expect(await host.exit).toBe(1);
    expect(host.stderr()).toMatch(/relay terminated with error: frame size \d+ bytes exceeds maximum allowed/);
  });

  it("exits 1 when stdin closes in the middle of a frame", async () => {
    const sb = sandbox();
    const host = launch([CHROME_ORIGIN], sb.env);
    host.child.stdin.write(Buffer.from([9, 0, 0, 0, 0x7b]));
    host.child.stdin.end();
    expect(await host.exit).toBe(1);
  });
});

describe("MCP stdio binary", () => {
  function rpcSession(host: ReturnType<typeof launch>) {
    const lines: any[] = [];
    let buffer = "";
    host.child.stdout.on("data", (c: Buffer) => {
      buffer += c.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    return {
      lines,
      send: (obj: unknown) => host.child.stdin.write(`${JSON.stringify(obj)}\n`),
      waitFor: (n: number) => waitFor(() => lines.length >= n, 15_000),
      trailing: () => buffer,
    };
  }

  it("serves initialize, tools/list and an authenticated tools/call without Node on PATH", async () => {
    const sb = sandbox();
    await fakeDesktop(sb, true);
    const host = launch(["--mcp"], sb.env);
    const rpc = rpcSession(host);

    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_radar_sources", arguments: {} } });
    await rpc.waitFor(3);

    expect(rpc.lines[0].result.protocolVersion).toBe("2025-06-18");
    expect(rpc.lines[1].result.tools.map((t: any) => t.name)).toEqual([
      "list_radar_sources",
      "prepare_radar",
      "check_radar_preview",
      "retry_radar_preview",
    ]);
    const content = JSON.parse(rpc.lines[2].result.content[0].text);
    expect(content.draft_id).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(rpc.lines[2].result.isError).toBeUndefined();

    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(rpc.trailing()).toBe("");
    expect(host.stderr()).toBe("");
  });

  it("reports a tool error (not a crash) when the desktop is not running", async () => {
    const sb = sandbox();
    issueAgentToken(sb.dir);
    const host = launch(["--mcp"], sb.env);
    const rpc = rpcSession(host);
    rpc.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_radar_sources" } });
    await rpc.waitFor(1);
    expect(rpc.lines[0].result.isError).toBe(true);
    expect(rpc.lines[0].result.content[0].text).toContain("Không kết nối được với DealSonar");
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
  });

  it("refuses to talk to a desktop that does not hold the issued token", async () => {
    const sb = sandbox();
    await fakeDesktop(sb, true); // desktop token A is in sb.dir/agent-access ...
    fs.writeFileSync(path.join(sb.dir, "agent-access"), Buffer.alloc(32, 0x42), { mode: 0o600 }); // ... replaced by forged token
    const host = launch(["--mcp"], sb.env);
    const rpc = rpcSession(host);
    rpc.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_radar_sources" } });
    await rpc.waitFor(1);
    expect(rpc.lines[0].result.isError).toBe(true);
    expect(rpc.lines[0].result.content[0].text).toContain("từ chối kết nối agent");
    host.child.stdin.end();
    await host.exit;
  });
});
