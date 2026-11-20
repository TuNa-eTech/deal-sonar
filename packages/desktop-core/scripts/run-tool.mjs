// Runs a TypeScript developer tool of this package without a build step: bundles the entry with
// esbuild into a private temporary CommonJS file (same target as `build-backend.mjs`), calls its
// exported `main(args, options)` and removes the bundle again.
//
// Used by `eval.mjs` and `install-native-host-dev.mjs`. The package's dependencies must be
// installed (`pnpm install`), the same prerequisite as the tests and the backend build.

import { build } from "esbuild";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");

/**
 * @param {string} entry TypeScript entry relative to the package root (exports `main`).
 * @param {string[]} args User arguments.
 * @param {Record<string, unknown>} [options] Passed as the second argument of `main`.
 * @returns {Promise<number>} The exit code returned by `main`.
 */
export async function runTool(entry, args, options = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-tool-"));
  try {
    const outfile = path.join(work, "tool.cjs");
    await build({
      entryPoints: [path.join(packageRoot, entry)],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      // Never reached by the tools; keep the native/Electron modules out of the bundle.
      external: ["electron", "better-sqlite3"],
      define: { "import.meta.url": "undefined" },
      absWorkingDir: packageRoot,
      logLevel: "error",
    });
    const mod = createRequire(import.meta.url)(outfile);
    if (typeof mod.main !== "function") throw new Error(`${entry} does not export main()`);
    const code = await mod.main(args, options);
    return typeof code === "number" ? code : 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
