// Bundles Electron main and preload to CommonJS. The sandboxed preload cannot require local
// modules, so it must be a single file. `electron` stays external.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20", // Electron 33 ships Node 20.18
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
  absWorkingDir: root,
};

await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs" });
