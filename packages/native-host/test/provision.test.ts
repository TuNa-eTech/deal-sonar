import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CHROME_EXTENSION_ID, WINDOWS_CHROME_REGISTRY_KEY } from "../src/constants.js";
import {
  installHelper,
  isEphemeralHelperLocation,
  mcpClientConfig,
  stableHelperPath,
} from "../src/install-helper.js";
import { readManifestFile } from "../src/manifest.js";
import { NotPairedError, connectChrome, refreshChromeIfPaired } from "../src/provision.js";
import {
  ensureNativeHostRegistration,
  parseRegDefaultValue,
  readNativeHostRegistration,
  removeNativeHostRegistration,
  type RegistryRunner,
} from "../src/registry.js";
import { cleanupTmpDirs, isWindows, tmpDir } from "./helpers.js";

afterAll(cleanupTmpDirs);

function fakeHelper(dir: string, name = "src-host", content = "#!/bin/sh\necho hi\n"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("stable helper installation", () => {
  it("uses <dataDir>/bin/dealsonar-native-host[.exe]", () => {
    expect(stableHelperPath("/d", "linux")).toBe("/d/bin/dealsonar-native-host");
    expect(stableHelperPath("C:\\d", "windows")).toBe("C:\\d\\bin\\dealsonar-native-host.exe");
  });

  it("copies atomically, is idempotent, and replaces changed binaries", () => {
    const dir = tmpDir();
    const src = fakeHelper(dir);
    const dest = path.join(dir, "data", "bin", "dealsonar-native-host");
    expect(installHelper({ sourcePath: src, destPath: dest })).toEqual({ path: dest, changed: true });
    expect(fs.readFileSync(dest, "utf8")).toContain("echo hi");
    if (!isWindows) expect(fs.statSync(dest).mode & 0o111).not.toBe(0);
    expect(installHelper({ sourcePath: src, destPath: dest }).changed).toBe(false);
    fs.writeFileSync(src, "#!/bin/sh\necho v2\n");
    expect(installHelper({ sourcePath: src, destPath: dest }).changed).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("v2");
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["dealsonar-native-host"]);
  });

  it("refuses ASAR / AppImage mount destinations and missing sources", () => {
    expect(isEphemeralHelperLocation("/Applications/X.app/Contents/Resources/app.asar/bin/h")).toBe(true);
    expect(isEphemeralHelperLocation("/tmp/.mount_DealSoXyz/usr/bin/h")).toBe(true);
    expect(isEphemeralHelperLocation("/home/a/.local/share/dealsonar/bin/h")).toBe(false);
    const dir = tmpDir();
    expect(() => installHelper({ sourcePath: fakeHelper(dir), destPath: "/x/app.asar/h" })).toThrow(/ephemeral/);
    expect(() => installHelper({ sourcePath: path.join(dir, "nope"), destPath: path.join(dir, "o") })).toThrow(
      /not readable/,
    );
  });

  it("produces the MCP client command", () => {
    expect(mcpClientConfig("/d/bin/h")).toEqual({ command: "/d/bin/h", args: ["--mcp"] });
  });
});

describe("connectChrome / refreshChromeIfPaired (isolated manifest path)", () => {
  it("writes the manifest with pinned id and reports the id to store", async () => {
    const dir = tmpDir();
    const manifestPath = path.join(dir, "NativeMessagingHosts", "com.dealsonar.host.json");
    const helper = path.join(dir, "bin", "dealsonar-native-host");
    const result = await connectChrome({ helperPath: helper, manifestPath, platform: "linux", env: { HOME: dir } });
    expect(result.nativeHostInstalled).toBe(true);
    expect(result.manifestChanged).toBe(true);
    expect(result.extensionIdToStore).toBe(DEFAULT_CHROME_EXTENSION_ID);
    expect(result.secondaryManifestPaths).toEqual([]);
    expect(readManifestFile(manifestPath)).toMatchObject({
      name: "com.dealsonar.host",
      type: "stdio",
      path: helper,
      allowed_origins: [`chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`],
    });
    const again = await connectChrome({ helperPath: helper, manifestPath, platform: "linux", env: { HOME: dir } });
    expect(again.manifestChanged).toBe(false);
  });

  it("explicit extension id keeps the pinned id allowed and persists the custom id", async () => {
    const dir = tmpDir();
    const manifestPath = path.join(dir, "m.json");
    const result = await connectChrome({
      helperPath: path.join(dir, "h"),
      manifestPath,
      explicitExtensionId: "customextensionid",
      platform: "linux",
      env: { HOME: dir },
    });
    expect(result.extensionIdToStore).toBe("customextensionid");
    expect(readManifestFile(manifestPath)?.allowed_origins).toEqual([
      "chrome-extension://customextensionid/",
      `chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`,
    ]);
  });

  it("reports nativeHostInstalled=false instead of throwing when the manifest cannot be written", async () => {
    const dir = tmpDir();
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const result = await connectChrome({
      helperPath: path.join(dir, "h"),
      manifestPath: path.join(blocker, "sub", "m.json"),
      platform: "linux",
      env: { HOME: dir },
    });
    expect(result.nativeHostInstalled).toBe(false);
  });

  it("rejects an invalid explicit id", async () => {
    const dir = tmpDir();
    await expect(
      connectChrome({ helperPath: path.join(dir, "h"), manifestPath: path.join(dir, "m"), explicitExtensionId: "bad id!", platform: "linux", env: {} }),
    ).rejects.toThrow(/invalid Chrome extension ID/);
  });

  it("refresh: not paired -> NotPairedError; paired + moved helper -> rewritten with origins kept", async () => {
    const dir = tmpDir();
    const manifestPath = path.join(dir, "m.json");
    const base = { manifestPath, platform: "linux" as const, env: { HOME: dir } };
    await expect(refreshChromeIfPaired({ ...base, helperPath: path.join(dir, "old") })).rejects.toBeInstanceOf(NotPairedError);

    await connectChrome({ ...base, helperPath: path.join(dir, "old"), explicitExtensionId: "pairedid" });
    const refreshed = await refreshChromeIfPaired({ ...base, helperPath: path.join(dir, "new"), storedExtensionId: "pairedid" });
    expect(refreshed.manifestChanged).toBe(true);
    expect(readManifestFile(manifestPath)).toMatchObject({
      path: path.join(dir, "new"),
      allowed_origins: ["chrome-extension://pairedid/", `chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`],
    });
    const noop = await refreshChromeIfPaired({ ...base, helperPath: path.join(dir, "new"), storedExtensionId: "pairedid" });
    expect(noop.manifestChanged).toBe(false);
  });
});

function fakeRegistry(initial: string | null = null) {
  const calls: string[][] = [];
  let value = initial;
  const runner: RegistryRunner = async (args) => {
    calls.push(args);
    if (args[0] === "query") {
      return value === null
        ? { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." }
        : { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\X\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`, stderr: "" };
    }
    if (args[0] === "add") {
      value = args[args.indexOf("/d") + 1] ?? null;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "delete") {
      value = null;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { runner, calls, get value() { return value; } };
}

describe("Windows registry provisioning (fake reg.exe)", () => {
  const TEST_KEY = "HKCU\\Software\\DealSonarTest\\unit\\com.dealsonar.host";

  it("parses reg query output including spaces in paths", () => {
    expect(parseRegDefaultValue("    (Default)    REG_SZ    C:\\Users\\A B\\m.json\r\n")).toBe("C:\\Users\\A B\\m.json");
    expect(parseRegDefaultValue("ERROR")).toBeNull();
  });

  it("adds the key only when the value differs, using execFile-style argv", async () => {
    const reg = fakeRegistry();
    expect(await ensureNativeHostRegistration("C:\\A\\DealSonar\\m.json", { keyPath: TEST_KEY, runner: reg.runner })).toBe(true);
    expect(reg.calls.at(-1)).toEqual(["add", TEST_KEY, "/ve", "/t", "REG_SZ", "/d", "C:\\A\\DealSonar\\m.json", "/f"]);
    expect(await ensureNativeHostRegistration("C:\\A\\DealSonar\\m.json", { keyPath: TEST_KEY, runner: reg.runner })).toBe(false);
    expect(await readNativeHostRegistration({ keyPath: TEST_KEY, runner: reg.runner })).toBe("C:\\A\\DealSonar\\m.json");
  });

  it("refuses non-HKCU keys and deleting the real Chrome key", async () => {
    const reg = fakeRegistry();
    await expect(ensureNativeHostRegistration("C:\\m.json", { keyPath: "HKLM\\Software\\X", runner: reg.runner })).rejects.toThrow(/outside HKCU/);
    await expect(removeNativeHostRegistration({ keyPath: WINDOWS_CHROME_REGISTRY_KEY, runner: reg.runner })).rejects.toThrow(/real Chrome/);
    expect(reg.calls).toEqual([]);
  });

  it("Windows provisioning writes manifest then registry; skip with registry:null", async () => {
    const dir = tmpDir();
    const manifestPath = path.join(dir, "m.json");
    const reg = fakeRegistry();
    const res = await connectChrome({
      helperPath: "C:\\Users\\a\\AppData\\Roaming\\DealSonar\\bin\\dealsonar-native-host.exe",
      manifestPath,
      platform: "windows",
      env: {},
      registry: { keyPath: TEST_KEY, runner: reg.runner },
    });
    expect(res.registryUpdated).toBe(true);
    expect(reg.value).toBe(manifestPath);

    const reg2 = fakeRegistry();
    const skipped = await connectChrome({ helperPath: "C:\\h.exe", manifestPath, platform: "windows", env: {}, registry: null });
    expect(skipped.registryUpdated).toBe(false);
    expect(reg2.calls).toEqual([]);
  });

  it("reports nativeHostInstalled=false when reg add fails during connect", async () => {
    const dir = tmpDir();
    const failing: RegistryRunner = async (args) => (args[0] === "query" ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "denied" });
    const res = await connectChrome({
      helperPath: "C:\\h.exe",
      manifestPath: path.join(dir, "m.json"),
      platform: "windows",
      env: {},
      registry: { keyPath: TEST_KEY, runner: failing },
    });
    expect(res.nativeHostInstalled).toBe(false);
  });
});

// Real reg.exe against an isolated HKCU test subtree; runs only on Windows CI.
describe.skipIf(!isWindows)("Windows registry provisioning (real reg.exe, isolated key)", () => {
  it("round-trips a value under HKCU\\Software\\DealSonarTest and cleans up", async () => {
    const keyPath = `HKCU\\Software\\DealSonarTest\\${process.pid}-${Date.now()}\\com.dealsonar.host`;
    const manifest = path.join(tmpDir(), "m.json");
    try {
      expect(await ensureNativeHostRegistration(manifest, { keyPath })).toBe(true);
      expect(await readNativeHostRegistration({ keyPath })).toBe(manifest);
      expect(await ensureNativeHostRegistration(manifest, { keyPath })).toBe(false);
    } finally {
      await removeNativeHostRegistration({ keyPath });
    }
    expect(await readNativeHostRegistration({ keyPath })).toBeNull();
  });
});
