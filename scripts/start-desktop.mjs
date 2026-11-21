import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this entry point with pnpm desktop.");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const workspace = (...args) => run(process.execPath, [pnpm, ...args]);
workspace("ui:build");
workspace("ext:build");
if (!env.DEALSONAR_BACKEND_BUNDLE_DIR) {
  workspace("--filter", "@dealsonar/desktop-core", "build:backend");
  env.DEALSONAR_BACKEND_BUNDLE_DIR = fileURLToPath(new URL("../packages/desktop-core/dist/backend", import.meta.url));
}
if (!env.DEALSONAR_NATIVE_HOST_SRC) {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("Use Node.js 24 to build the native helper, or set DEALSONAR_NATIVE_HOST_SRC to a prebuilt helper.");
  }
  workspace("--filter", "@dealsonar/native-host", "build:sea");
  const target = `${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "dealsonar-native-host.exe" : "dealsonar-native-host";
  env.DEALSONAR_NATIVE_HOST_SRC = fileURLToPath(new URL(`../packages/native-host/dist-sea/${target}/${binary}`, import.meta.url));
}
workspace("electron:stage");
workspace("--filter", "@dealsonar/desktop-electron", "start");
