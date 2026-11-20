#!/usr/bin/env node
/**
 * Build the standalone helper executable with a Node 24 Single Executable Application (SEA)
 * so Chrome and MCP clients can launch it with no Node installation.
 *
 *   node scripts/build-sea.mjs --target darwin-arm64 [--base-node /path/to/node24] [--out dist-sea]
 *
 * Targets: darwin-arm64, darwin-x64, win32-x64, linux-x64.
 *
 * - This script MUST run under Node 24 (the SEA blob format is tied to the Node version).
 * - `--base-node` is the Node 24 executable of the TARGET platform (defaults to the running
 *   node when the target equals the host). The blob is produced by the running Node 24 and
 *   injected into a copy of the base executable with postject.
 * - macOS: signature removed before injection and re-applied ad-hoc (`codesign --sign -`);
 *   no Developer ID signing. Windows/Linux: unsigned (publisher policy: unsigned).
 * - Output: <out>/<target>/dealsonar-native-host[.exe] + build-info.json
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { bundleHost } from "./build-bundle.mjs";

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    "base-node": { type: "string" },
    out: { type: "string", default: path.join(packageRoot, "dist-sea") },
  },
});

const hostTarget = `${process.platform}-${process.arch}`;
const target = values.target ?? hostTarget;
if (!TARGETS.has(target)) {
  console.error(`unsupported --target ${target}; expected one of ${[...TARGETS].join(", ")}`);
  process.exit(2);
}
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 24) {
  console.error(`build-sea requires Node 24 (running ${process.versions.node}).`);
  process.exit(2);
}
const baseNode = path.resolve(values["base-node"] ?? process.execPath);
if (!fs.existsSync(baseNode)) {
  console.error(`base node executable not found: ${baseNode}`);
  process.exit(2);
}
if (!values["base-node"] && target !== hostTarget) {
  console.error(`cross-target build needs --base-node pointing at the ${target} Node 24 executable`);
  process.exit(2);
}

let baseVersion = null;
if (target === hostTarget) {
  baseVersion = execFileSync(baseNode, ["--version"], { encoding: "utf8" }).trim();
  if (!baseVersion.startsWith("v24.")) {
    console.error(`base node must be v24.x, got ${baseVersion}`);
    process.exit(2);
  }
  if (baseVersion !== `v${process.versions.node}`) {
    console.error(`base node ${baseVersion} differs from the blob generator v${process.versions.node}; use the same release`);
    process.exit(2);
  }
}

const isWindows = target.startsWith("win32");
const isDarwin = target.startsWith("darwin");
const outDir = path.join(path.resolve(values.out), target);
const exeName = isWindows ? "dealsonar-native-host.exe" : "dealsonar-native-host";
const exePath = path.join(outDir, exeName);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-sea-"));
try {
  const bundle = await bundleHost(path.join(work, "host.cjs"));
  const blobPath = path.join(work, "sea-prep.blob");
  const seaConfigPath = path.join(work, "sea-config.json");
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify({
      main: bundle,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false, // code cache is not portable across targets
    }),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  fs.copyFileSync(baseNode, exePath);
  fs.chmodSync(exePath, 0o755);
  if (isDarwin && process.platform === "darwin") {
    execFileSync("codesign", ["--remove-signature", exePath], { stdio: "inherit" });
  }

  const { inject } = await import("postject");
  await inject(exePath, "NODE_SEA_BLOB", fs.readFileSync(blobPath), {
    sentinelFuse: SENTINEL_FUSE,
    ...(isDarwin ? { machoSegmentName: "NODE_SEA" } : {}),
  });

  if (isDarwin) {
    if (process.platform !== "darwin") {
      console.error("warning: macOS targets must be ad-hoc signed on macOS (codesign unavailable here)");
    } else {
      execFileSync("codesign", ["--sign", "-", exePath], { stdio: "inherit" });
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const bytes = fs.readFileSync(exePath);
const info = {
  target,
  file: exeName,
  nodeVersion: baseVersion ?? `v${process.versions.node}`,
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  signing: isDarwin ? "ad-hoc" : "unsigned",
};
fs.writeFileSync(path.join(outDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(`built ${exePath}`);
console.log(JSON.stringify(info));
