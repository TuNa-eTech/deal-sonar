#!/usr/bin/env node
// Bundles the Electron backend into `dist/backend/`:
//
//   main.cjs                      single-file CJS bundle (utilityProcess entry; esbuild, node22 target)
//   migrations/000N_*.sql         the retained SQL migrations, read at runtime (byte-identical copies)
//   node_modules/better-sqlite3   native module + its two runtime deps, copied (not bundled)
//   node_modules/bindings
//   node_modules/file-uri-to-path
//
// The shell stages this directory as `<resources>/backend` (DEALSONAR_BACKEND_BUNDLE_DIR) outside ASAR.
//
// better-sqlite3 must be built for Electron's ABI, not the system Node's. Run
//   pnpm exec electron-rebuild -f -w better-sqlite3 -v <electron version>   (in packages/desktop-core)
// before this script, or pass --allow-node-abi for host-Node tests (never ship that).

import { build } from "esbuild";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const outDir = path.resolve(pkgRoot, process.env.DEALSONAR_BACKEND_OUT ?? "dist/backend");
const allowNodeAbi = process.argv.includes("--allow-node-abi");
const require = createRequire(path.join(pkgRoot, "package.json"));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(pkgRoot, "src/backend/main.ts")],
  outfile: path.join(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["better-sqlite3", "electron"],
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
  // `import.meta.url` does not exist in CJS; store.ts falls back to `__dirname/migrations`.
  define: { "import.meta.url": "undefined" },
  banner: { js: "/* DealSonar backend (utilityProcess entry). Generated; do not edit. */" },
});

cpSync(path.join(pkgRoot, "migrations"), path.join(outDir, "migrations"), { recursive: true });

function packageDir(name, from = require) {
  const entry = from.resolve(`${name}/package.json`);
  return path.dirname(entry);
}

function copyPackage(name, filter, from = require) {
  const src = packageDir(name, from);
  const dest = path.join(outDir, "node_modules", name);
  cpSync(src, dest, { recursive: true, filter: (file) => filter(path.relative(src, file)) });
  return dest;
}

// better-sqlite3: lib, package.json and the compiled binding only. Skip sources, deps/ (SQLite
// amalgamation) and build intermediates to keep the bundle small.
const sqliteDest = copyPackage("better-sqlite3", (rel) => {
  if (rel === "") return true;
  const top = rel.split(path.sep)[0];
  if (top === "lib" || rel === "package.json") return true;
  if (top === "build") {
    return rel === "build" || rel === path.join("build", "Release") || rel.endsWith(".node");
  }
  return false;
});
// pnpm's strict layout only exposes better-sqlite3's own deps from its directory.
const fromSqlite = createRequire(path.join(packageDir("better-sqlite3"), "package.json"));
copyPackage("bindings", () => true, fromSqlite);
copyPackage("file-uri-to-path", () => true, fromSqlite);

const binding = path.join(sqliteDest, "build", "Release", "better_sqlite3.node");
if (!existsSync(binding)) {
  console.error(`better_sqlite3.node missing at ${binding}; run electron-rebuild first`);
  process.exit(1);
}

const abi = process.versions.modules;
console.log(`staged better-sqlite3 binding (${statSync(binding).size} bytes)`);
if (!allowNodeAbi) {
  console.log(`NOTE: verify it was rebuilt for Electron's ABI (this Node is ABI ${abi}); the shell smoke test loads it inside utilityProcess.`);
}
console.log(`backend bundle: ${outDir} (${readdirSync(outDir).join(", ")})`);
