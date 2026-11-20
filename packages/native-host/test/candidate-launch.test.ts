/**
 * Candidate (isolated) helper, launched exactly like Chrome launches it: the provisioned helper
 * from `<dataDir>/bin/`, argv `[chrome-extension://<id>/]` (plus `--parent-window=` on Windows),
 * piped stdio and an environment that carries NO DEALSONAR_* variable. The only thing that can
 * route it to the candidate profile is the route file provisioned beside it.
 *
 * Like `binary.test.ts`, the executable is `$DEALSONAR_NATIVE_HOST_TEST_BIN` (the real SEA binary,
 * run with an empty PATH) or, as a development fallback, a fresh bundle run with the current node.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundleHost } from "../scripts/build-bundle.mjs";
import { issueAgentToken } from "../src/agent-protocol.js";
import { DEFAULT_CHROME_EXTENSION_ID, MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import { installHelper, stableHelperPath } from "../src/install-helper.js";
import { DesktopIpcServer, type ExtensionConnection } from "../src/ipc.js";
import { clearHelperRoute, helperRoutePath, writeCandidateRoute } from "../src/route.js";
import { FrameCollector, cleanupTmpDirs, frameOf, isWindows, testEndpoint, tmpDir, waitFor } from "./helpers.js";

const seaBin = process.env.DEALSONAR_NATIVE_HOST_TEST_BIN;
let bundlePath = "";

beforeAll(async () => {
  if (seaBin) {
    if (!fs.existsSync(seaBin)) throw new Error(`DEALSONAR_NATIVE_HOST_TEST_BIN not found: ${seaBin}`);
  } else {
    bundlePath = await bundleHost(path.join(tmpDir("dsbundle"), "host.cjs"));
  }
});

const servers: DesktopIpcServer[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const s of servers.splice(0)) await s.close();
});
afterAll(cleanupTmpDirs);

const CHROME_ORIGIN = `chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`;
const chromeArgs = isWindows ? [CHROME_ORIGIN, "--parent-window=0"] : [CHROME_ORIGIN];

interface Profile {
  root: string;
  dataDir: string;
  endpoint: string;
  /** What to spawn: the provisioned helper (SEA) or node + the bundle placed in `<dataDir>/bin`. */
  command: string;
  args: string[];
}

/** Environment Chrome gives the helper: a normal user session, no DealSonar variables. */
function chromeEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_RUNTIME_DIR: home,
    USERNAME: "tester",
    USER: "tester",
    PATH: seaBin ? "" : (process.env.PATH ?? ""),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

/** Provision a helper into `<dataDir>/bin` the way the backend does: route first, then the helper. */
function provision(options: { route: boolean }): Profile {
  const root = tmpDir("dscand");
  const dataDir = path.join(root, "candidate-data");
  const endpoint = testEndpoint(root);
  if (options.route) writeCandidateRoute({ dataDir, ipcEndpoint: endpoint, env: chromeEnv(root) });
  const dest = stableHelperPath(dataDir);
  if (seaBin) {
    installHelper({ sourcePath: seaBin, destPath: dest });
    return { root, dataDir, endpoint, command: dest, args: [] };
  }
  const script = path.join(path.dirname(dest), "host.cjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(bundlePath, script);
  return { root, dataDir, endpoint, command: process.execPath, args: [script] };
}

function launch(profile: Profile, extraArgs: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(profile.command, [...profile.args, ...extraArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  child.stdin.on("error", () => undefined); // the helper may exit before the write lands
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, stderr: () => stderr };
}

async function desktopAt(endpoint: string, agentDataDir: string | null = null) {
  const received: Buffer[] = [];
  const server = await DesktopIpcServer.bind({
    endpoint,
    agentToken: agentDataDir ? issueAgentToken(agentDataDir) : null,
    agentBackend: agentDataDir
      ? { handle: async (method) => ({ method, draft_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", sources: [] }) }
      : null,
    onExtensionConnection: (c: ExtensionConnection) => {
      c.onFrame((f) => received.push(f));
    },
  });
  servers.push(server);
  return { received };
}

const hello = { v: 2, id: "01A", ts: 1794384000000, reply_to: null, type: "hello", payload: { profile_id: "p_7f3a", ext_version: "0.2.0", browser: "chrome/142", config_rev: 11 } };

describe("provisioned candidate helper launched like Chrome", () => {
  it("reaches the candidate endpoint with no backend env and exits 0 on EOF", async () => {
    const profile = provision({ route: true });
    const desktop = await desktopAt(profile.endpoint);
    const host = launch(profile, chromeArgs, chromeEnv(profile.root));
    const out = new FrameCollector(host.child.stdout, MAX_HOST_TO_EXT_BYTES);

    host.child.stdin.write(frameOf(hello));
    await waitFor(() => desktop.received.length === 1, 10_000);
    expect(JSON.parse(desktop.received[0]!.toString())).toEqual(hello);

    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(host.stderr()).toBe("");
    expect(out.frames).toHaveLength(0);
  });

  it("without a route it keeps production resolution and does not find the candidate desktop", async () => {
    const profile = provision({ route: false });
    const desktop = await desktopAt(profile.endpoint);
    const host = launch(profile, chromeArgs, chromeEnv(profile.root));
    const out = new FrameCollector(host.child.stdout, MAX_HOST_TO_EXT_BYTES);

    host.child.stdin.write(frameOf({ v: 2, id: "R1", ts: 1, reply_to: null, type: "ping", payload: {} }));
    expect(await out.json(0, 10_000)).toMatchObject({ type: "error", reply_to: "R1", payload: { code: "desktop_unavailable" } });
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(desktop.received).toHaveLength(0);
  });

  it("stops routing once production provisioning clears the route", async () => {
    const profile = provision({ route: true });
    const desktop = await desktopAt(profile.endpoint);
    expect(clearHelperRoute(profile.dataDir)).toBe(true);
    const host = launch(profile, chromeArgs, chromeEnv(profile.root));
    const out = new FrameCollector(host.child.stdout, MAX_HOST_TO_EXT_BYTES);
    host.child.stdin.write(frameOf({ v: 2, id: "R2", ts: 1, reply_to: null, type: "ping", payload: {} }));
    expect(await out.json(0, 10_000)).toMatchObject({ payload: { code: "desktop_unavailable" } });
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(desktop.received).toHaveLength(0);
  });

  it("honours an explicit caller endpoint over the route", async () => {
    const profile = provision({ route: true });
    const routed = await desktopAt(profile.endpoint);
    const overrideEndpoint = testEndpoint(tmpDir("dsover"));
    const override = await desktopAt(overrideEndpoint);

    const host = launch(profile, chromeArgs, { ...chromeEnv(profile.root), DEALSONAR_IPC_PATH: overrideEndpoint });
    host.child.stdin.write(frameOf(hello));
    await waitFor(() => override.received.length === 1, 10_000);
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
    expect(routed.received).toHaveLength(0);
  });

  it("serves direct MCP from the candidate profile's agent token and endpoint", async () => {
    const profile = provision({ route: true });
    await desktopAt(profile.endpoint, profile.dataDir);
    const host = launch(profile, ["--mcp"], chromeEnv(profile.root));
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
    host.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_radar_sources", arguments: {} } })}\n`);
    await waitFor(() => lines.length >= 1, 15_000);
    expect(lines[0].result.isError).toBeUndefined();
    expect(JSON.parse(lines[0].result.content[0].text).method).toBe("list_radar_sources");
    host.child.stdin.end();
    expect(await host.exit).toBe(0);
  });

  it("fails closed when a route is copied next to another helper", async () => {
    const a = provision({ route: true });
    const b = provision({ route: false });
    const desktop = await desktopAt(a.endpoint);
    fs.copyFileSync(helperRoutePath(a.dataDir), helperRoutePath(b.dataDir));

    const host = launch(b, chromeArgs, chromeEnv(b.root));
    host.child.stdin.write(frameOf(hello));
    expect(await host.exit).toBe(1);
    expect(host.stderr()).toMatch(/invalid helper route: route file does not belong/);
    expect(desktop.received).toHaveLength(0);
  });
});
