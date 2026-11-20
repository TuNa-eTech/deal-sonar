import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CHROME_EXTENSION_ID } from "../src/constants.js";
import {
  buildManifest,
  chromeManifestPathWith,
  computeAllowedOrigins,
  computeChromeUnpackedExtensionId,
  formatAllowedOrigin,
  manifestToJson,
  readManifestFile,
  secondaryChromiumManifestPaths,
  verifyOrWriteManifest,
  type NativeHostManifest,
} from "../src/manifest.js";
import { cleanupTmpDirs, tmpDir } from "./helpers.js";

afterAll(cleanupTmpDirs);

const ORIGIN = (id: string) => `chrome-extension://${id}/`;

describe("allowed origins", () => {
  it("accepts ids and full origins, rejects non-alphanumeric", () => {
    expect(formatAllowedOrigin("abcdef")).toBe("chrome-extension://abcdef/");
    expect(formatAllowedOrigin(" chrome-extension://abcdef/ ")).toBe("chrome-extension://abcdef/");
    expect(() => formatAllowedOrigin("")).toThrow(/invalid Chrome extension ID/);
    expect(() => formatAllowedOrigin("ab cd")).toThrow(/invalid Chrome extension ID/);
    expect(() => formatAllowedOrigin("a*")).toThrow(/invalid Chrome extension ID/);
  });

  it("builds a stdio manifest with deduplicated origins", () => {
    const m = buildManifest(["aaa", ORIGIN("aaa"), "bbb"], "/opt/dealsonar-native-host");
    expect(m).toEqual({
      name: "com.dealsonar.host",
      description: "DealSonar native host",
      path: "/opt/dealsonar-native-host",
      type: "stdio",
      allowed_origins: [ORIGIN("aaa"), ORIGIN("bbb")],
    });
  });

  it("requires an absolute helper path (POSIX or Windows forms)", () => {
    expect(() => buildManifest(["aaa"], "relative/host")).toThrow(/must be absolute/);
    expect(() => buildManifest(["aaa"], "C:\\Program Files\\h.exe")).not.toThrow();
    expect(() => buildManifest(["aaa"], "\\\\server\\share\\h.exe")).not.toThrow();
  });

  it("serializes like serde pretty JSON with trailing newline", () => {
    const json = manifestToJson(buildManifest([DEFAULT_CHROME_EXTENSION_ID], "/x/host"));
    expect(json.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(json))).toEqual(["name", "description", "path", "type", "allowed_origins"]);
    expect(json).toContain('\n  "allowed_origins": [\n    "chrome-extension://hkmjpcenjjebhpjicnbpmogidfcbmbjn/"\n  ]\n');
  });
});

describe("computeAllowedOrigins (chrome_connect behavior)", () => {
  const existing = (origins: string[]): NativeHostManifest => ({
    name: "com.dealsonar.host",
    description: "DealSonar native host",
    path: "/old/host",
    type: "stdio",
    allowed_origins: origins,
  });

  it("defaults to the pinned extension id", () => {
    expect(computeAllowedOrigins({})).toEqual([DEFAULT_CHROME_EXTENSION_ID]);
  });

  it("explicit custom id is primary and the pinned id is always kept", () => {
    expect(computeAllowedOrigins({ explicitExtensionId: " customid " })).toEqual(["customid", DEFAULT_CHROME_EXTENSION_ID]);
  });

  it("blank explicit id falls back to stored, then existing manifest", () => {
    expect(computeAllowedOrigins({ explicitExtensionId: "  ", storedExtensionId: "storedid" })).toEqual([
      "storedid",
      DEFAULT_CHROME_EXTENSION_ID,
    ]);
    expect(
      computeAllowedOrigins({ existingManifest: existing([ORIGIN("fromfile")]) }),
    ).toEqual([ORIGIN("fromfile"), DEFAULT_CHROME_EXTENSION_ID, ORIGIN("fromfile")]);
  });

  it("drops the legacy placeholder id from stored value and existing origins", () => {
    const legacy = "dealsonarchromeextensionid000001";
    expect(
      computeAllowedOrigins({
        storedExtensionId: legacy,
        existingManifest: existing([ORIGIN(legacy), ORIGIN("keepme")]),
      }),
    ).toEqual([ORIGIN("keepme"), DEFAULT_CHROME_EXTENSION_ID, ORIGIN("keepme")]);
  });

  it("appends discovered dev ids; final manifest is deduplicated", () => {
    const origins = computeAllowedOrigins({ storedExtensionId: "primary", discoveredDevIds: ["devid1"] });
    expect(origins).toEqual(["primary", DEFAULT_CHROME_EXTENSION_ID, "devid1"]);
    const manifest = buildManifest(
      computeAllowedOrigins({ existingManifest: existing([ORIGIN("a"), ORIGIN("a")]) }),
      "/h",
    );
    expect(manifest.allowed_origins).toEqual([ORIGIN("a"), ORIGIN(DEFAULT_CHROME_EXTENSION_ID)]);
  });
});

describe("manifest paths", () => {
  it("resolves Chrome manifest location per OS", () => {
    expect(chromeManifestPathWith({ platform: "macos", homeDir: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json",
    );
    expect(chromeManifestPathWith({ platform: "linux", homeDir: "/home/a" })).toBe(
      "/home/a/.config/google-chrome/NativeMessagingHosts/com.dealsonar.host.json",
    );
    expect(chromeManifestPathWith({ platform: "linux", homeDir: "/home/a", xdgConfigHome: "/xdg" })).toBe(
      "/xdg/google-chrome/NativeMessagingHosts/com.dealsonar.host.json",
    );
    expect(chromeManifestPathWith({ platform: "windows", appdataDir: "C:\\A" })).toBe(
      "C:\\A\\DealSonar\\com.dealsonar.host.json",
    );
    expect(() => chromeManifestPathWith({ platform: "macos" })).toThrow(/HOME/);
  });

  it("only returns secondary Chromium browsers that already exist", () => {
    const present = new Set(["/Users/a/Library/Application Support/Chromium", "/Users/a/Library/Application Support/Arc/User Data"]);
    const found = secondaryChromiumManifestPaths({ HOME: "/Users/a" }, "macos", (p) => present.has(p));
    expect(found).toEqual([
      "/Users/a/Library/Application Support/Chromium/NativeMessagingHosts/com.dealsonar.host.json",
      "/Users/a/Library/Application Support/Arc/User Data/NativeMessagingHosts/com.dealsonar.host.json",
    ]);
    expect(secondaryChromiumManifestPaths({ HOME: "/h" }, "windows", () => true)).toEqual([]);
    expect(
      secondaryChromiumManifestPaths({ HOME: "/h" }, "linux", (p) => p === "/h/.config/chromium"),
    ).toEqual(["/h/.config/chromium/NativeMessagingHosts/com.dealsonar.host.json"]);
  });
});

describe("manifest file IO", () => {
  it("writes when missing, skips when identical, rewrites when stale", () => {
    const file = path.join(tmpDir(), "nm", "com.dealsonar.host.json");
    const a = buildManifest([DEFAULT_CHROME_EXTENSION_ID], "/opt/a/host");
    expect(verifyOrWriteManifest(file, a)).toBe(true);
    expect(readManifestFile(file)).toEqual(a);
    expect(verifyOrWriteManifest(file, a)).toBe(false);
    const b = buildManifest([DEFAULT_CHROME_EXTENSION_ID], "/opt/b/host");
    expect(verifyOrWriteManifest(file, b)).toBe(true);
    expect(readManifestFile(file)?.path).toBe("/opt/b/host");
    // No temp files left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["com.dealsonar.host.json"]);
  });

  it("rewrites a corrupt manifest", () => {
    const dir = tmpDir();
    const file = path.join(dir, "m.json");
    fs.writeFileSync(file, "{not json");
    expect(verifyOrWriteManifest(file, buildManifest(["abc"], "/h"))).toBe(true);
    expect(readManifestFile(file)?.allowed_origins).toEqual([ORIGIN("abc")]);
  });
});

describe("unpacked extension id", () => {
  it("is deterministic, 32 chars in a..p, and differs per path", () => {
    const a = tmpDir();
    const b = tmpDir();
    const idA = computeChromeUnpackedExtensionId(a)!;
    expect(idA).toMatch(/^[a-p]{32}$/);
    expect(computeChromeUnpackedExtensionId(a)).toBe(idA);
    expect(computeChromeUnpackedExtensionId(b)).not.toBe(idA);
    expect(computeChromeUnpackedExtensionId(path.join(a, "missing"))).toBeNull();
  });
});
