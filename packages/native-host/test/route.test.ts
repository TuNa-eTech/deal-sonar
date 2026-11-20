import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { HELPER_ROUTE_FILENAME } from "../src/constants.js";
import { stableHelperPath } from "../src/install-helper.js";
import {
  HelperRouteError,
  buildCandidateRoute,
  clearHelperRoute,
  helperRoutePath,
  parseHelperRoute,
  resolveHelperRoute,
  writeCandidateRoute,
} from "../src/route.js";
import { cleanupTmpDirs, isWindows, testEndpoint, tmpDir } from "./helpers.js";

afterAll(cleanupTmpDirs);

/** A production-like environment on this host, so the default data dir/endpoint are deterministic. */
function hostEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), XDG_RUNTIME_DIR: home, USERNAME: "tester", USER: "tester" };
}

/** Sets up `<root>/data/bin/<helper>` with a route and returns the paths. */
function candidateInstall() {
  const root = tmpDir("dsroute");
  const dataDir = path.join(root, "candidate-data");
  const endpoint = testEndpoint(root);
  const env = hostEnv(path.join(root, "home"));
  writeCandidateRoute({ dataDir, ipcEndpoint: endpoint, env });
  const helper = stableHelperPath(dataDir);
  fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
  return { root, dataDir, endpoint, env, helper };
}

describe("buildCandidateRoute / parseHelperRoute", () => {
  it("builds the Windows candidate pipe route and refuses the production pipe and data dir", () => {
    const env = { APPDATA: "C:\\Users\\An\\AppData\\Roaming", USERNAME: "An" };
    const candidatePipe = "\\\\.\\pipe\\dealsonar-candidate-An";
    const candidateDir = "C:\\Users\\An\\AppData\\Roaming\\DealSonar Candidate";
    expect(buildCandidateRoute({ dataDir: candidateDir, ipcEndpoint: candidatePipe, env, platform: "windows" })).toEqual({
      version: 1,
      channel: "candidate",
      dataDir: candidateDir,
      ipcEndpoint: candidatePipe,
    });
    expect(() => buildCandidateRoute({ dataDir: candidateDir, ipcEndpoint: "\\\\.\\pipe\\dealsonar-An", env, platform: "windows" })).toThrow(/production IPC endpoint/);
    expect(() => buildCandidateRoute({ dataDir: candidateDir, ipcEndpoint: "\\\\.\\PIPE\\DealSonar-AN", env, platform: "windows" })).toThrow(/production IPC endpoint/);
    expect(() => buildCandidateRoute({ dataDir: "c:\\users\\an\\appdata\\roaming\\dealsonar", ipcEndpoint: candidatePipe, env, platform: "windows" })).toThrow(/production data dir/);
    expect(() => buildCandidateRoute({ dataDir: candidateDir, ipcEndpoint: "C:\\tmp\\ipc.sock", env, platform: "windows" })).toThrow(/named pipe/);
  });

  it("refuses the production data dir and socket on macOS and Linux", () => {
    const mac = { HOME: "/Users/an" };
    const macDefault = "/Users/an/Library/Application Support/DealSonar";
    expect(() => buildCandidateRoute({ dataDir: macDefault, ipcEndpoint: "/tmp/c.sock", env: mac, platform: "macos" })).toThrow(/production data dir/);
    expect(() => buildCandidateRoute({ dataDir: "/tmp/c", ipcEndpoint: `${macDefault}/ipc.sock`, env: mac, platform: "macos" })).toThrow(/production IPC endpoint/);
    expect(buildCandidateRoute({ dataDir: "/tmp/c", ipcEndpoint: "/tmp/c/ipc.sock", env: mac, platform: "macos" }).dataDir).toBe("/tmp/c");
    expect(() => buildCandidateRoute({ dataDir: "/home/an/.local/share/dealsonar", ipcEndpoint: "/tmp/c.sock", env: { HOME: "/home/an" }, platform: "linux" })).toThrow(HelperRouteError);
  });

  it("rejects relative data dirs and empty endpoints", () => {
    expect(() => buildCandidateRoute({ dataDir: "relative/dir", ipcEndpoint: "/tmp/c.sock", env: {}, platform: "linux" })).toThrow(/absolute/);
    expect(() => buildCandidateRoute({ dataDir: "/tmp/c", ipcEndpoint: "", env: {}, platform: "linux" })).toThrow(/ipcEndpoint/);
  });

  it("parses only the exact candidate route shape", () => {
    const good = { version: 1, channel: "candidate", dataDir: "/tmp/c", ipcEndpoint: "/tmp/c/ipc.sock" };
    expect(parseHelperRoute(JSON.stringify(good), "linux")).toEqual(good);
    expect(() => parseHelperRoute("not json", "linux")).toThrow(/not valid JSON/);
    expect(() => parseHelperRoute("[]", "linux")).toThrow(/JSON object/);
    expect(() => parseHelperRoute(JSON.stringify({ ...good, version: 2 }), "linux")).toThrow(/version/);
    expect(() => parseHelperRoute(JSON.stringify({ ...good, channel: "production" }), "linux")).toThrow(/channel/);
    expect(() => parseHelperRoute(JSON.stringify({ ...good, dataDir: 5 }), "linux")).toThrow(/dataDir/);
    expect(() => parseHelperRoute(JSON.stringify({ ...good, ipcEndpoint: "/x" }), "windows")).toThrow(/dataDir|named pipe/);
  });
});

describe("writeCandidateRoute / clearHelperRoute", () => {
  it("writes a private route into <dataDir>/bin, rewrites only on change, and clears it", () => {
    const root = tmpDir("dsroute");
    const dataDir = path.join(root, "data");
    const endpoint = testEndpoint(root);
    const env = hostEnv(path.join(root, "home"));

    const first = writeCandidateRoute({ dataDir, ipcEndpoint: endpoint, env });
    expect(first).toEqual({ path: helperRoutePath(dataDir), changed: true });
    expect(first.path).toBe(path.join(dataDir, "bin", HELPER_ROUTE_FILENAME));
    expect(JSON.parse(fs.readFileSync(first.path, "utf8"))).toEqual({ version: 1, channel: "candidate", dataDir, ipcEndpoint: endpoint });
    if (!isWindows) expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(dataDir, "bin"))).toEqual([HELPER_ROUTE_FILENAME]);

    expect(writeCandidateRoute({ dataDir, ipcEndpoint: endpoint, env }).changed).toBe(false);
    expect(writeCandidateRoute({ dataDir, ipcEndpoint: `${endpoint}2`, env }).changed).toBe(true);

    expect(clearHelperRoute(dataDir)).toBe(true);
    expect(clearHelperRoute(dataDir)).toBe(false);
    expect(fs.existsSync(first.path)).toBe(false);
  });

  it("writes nothing when the target is the production data dir", () => {
    const root = tmpDir("dsroute");
    const home = path.join(root, "home");
    const env = hostEnv(home);
    const productionDir = isWindows ? path.join(env.APPDATA!, "DealSonar") : process.platform === "darwin" ? path.join(home, "Library", "Application Support", "DealSonar") : path.join(home, ".local", "share", "dealsonar");
    expect(() => writeCandidateRoute({ dataDir: productionDir, ipcEndpoint: testEndpoint(root), env })).toThrow(/production data dir/);
    expect(fs.existsSync(productionDir)).toBe(false);
  });
});

describe("resolveHelperRoute", () => {
  it("leaves the environment untouched when no route sits next to the helper", () => {
    const root = tmpDir("dsroute");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const env = { HOME: "/h" };
    expect(resolveHelperRoute({ helperLocation: path.join(root, "bin", "dealsonar-native-host"), env })).toBe(env);
    expect(resolveHelperRoute({ helperLocation: null, env })).toBe(env);
    expect(resolveHelperRoute({ helperLocation: undefined, env })).toBe(env);
  });

  it("supplies the candidate data dir and endpoint when the caller gave neither", () => {
    const { dataDir, endpoint, helper } = candidateInstall();
    const env = { HOME: "/h", KEEP: "1", DEALSONAR_DATA_DIR: "", DEALSONAR_IPC_PATH: "  " };
    expect(resolveHelperRoute({ helperLocation: helper, env })).toEqual({
      HOME: "/h",
      KEEP: "1",
      DEALSONAR_DATA_DIR: dataDir,
      DEALSONAR_IPC_PATH: endpoint,
    });
  });

  it("matches the helper directory through symlinks", () => {
    const { dataDir, helper } = candidateInstall();
    const resolved = resolveHelperRoute({ helperLocation: fs.realpathSync(helper), env: {} });
    expect(resolved.DEALSONAR_DATA_DIR).toBe(dataDir);
  });

  it("lets an explicit caller override win without mixing it with the route", () => {
    const { helper } = candidateInstall();
    const ipcOnly = { DEALSONAR_IPC_PATH: "/custom/ipc.sock" };
    expect(resolveHelperRoute({ helperLocation: helper, env: ipcOnly })).toBe(ipcOnly);
    const dirOnly = { DEALSONAR_DATA_DIR: "/custom/data" };
    expect(resolveHelperRoute({ helperLocation: helper, env: dirOnly })).toBe(dirOnly);
    // The route is not even read, so an override also works next to a broken route.
    fs.writeFileSync(path.join(path.dirname(helper), HELPER_ROUTE_FILENAME), "garbage");
    expect(resolveHelperRoute({ helperLocation: helper, env: ipcOnly })).toBe(ipcOnly);
  });

  it("fails closed on a malformed or copied route", () => {
    const a = candidateInstall();
    const b = candidateInstall();
    const route = path.join(path.dirname(a.helper), HELPER_ROUTE_FILENAME);

    fs.writeFileSync(route, "{ not json");
    expect(() => resolveHelperRoute({ helperLocation: a.helper, env: {} })).toThrow(HelperRouteError);

    fs.copyFileSync(helperRoutePath(b.dataDir), route); // b's route copied next to a's helper
    expect(() => resolveHelperRoute({ helperLocation: a.helper, env: {} })).toThrow(/does not belong/);

    fs.writeFileSync(route, "x".repeat(70 * 1024));
    expect(() => resolveHelperRoute({ helperLocation: a.helper, env: {} })).toThrow(/too large/);
  });
});

describe("runCli with a candidate route", () => {
  function io(helperLocation: string | null, env: Record<string, string>) {
    let stderr = "";
    const err = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });
    return { io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: err, env, helperLocation }, stderr: () => stderr };
  }

  it("exits 1 with a diagnostic instead of falling back to the production endpoint", async () => {
    const { helper } = candidateInstall();
    fs.writeFileSync(path.join(path.dirname(helper), HELPER_ROUTE_FILENAME), "{}");
    const run = io(helper, {});
    expect(await runCli(["chrome-extension://hkmjpcenjjebhpjicnbpmogidfcbmbjn/"], run.io)).toBe(1);
    expect(run.stderr()).toMatch(/^dealsonar-native-host: invalid helper route: /);
    const mcp = io(helper, {});
    expect(await runCli(["--mcp"], mcp.io)).toBe(1);
    expect(mcp.stderr()).toMatch(/invalid helper route/);
  });
});
