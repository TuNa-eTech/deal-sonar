#!/usr/bin/env node
// Bundles the Electron backend into `dist/backend/`:
//
//   main.cjs                      single-file CJS bundle (utilityProcess entry; esbuild, node22 target)
//   migrations/000N_*.sql         the retained SQL migrations, read at runtime (byte-identical copies)
//   node_modules/better-sqlite3   JS loader and the current target's native Node-API binding
//
// The shell stages this directory as `<resources>/backend` outside ASAR. Run the script on
// the package target (OS and architecture), after installing the pnpm workspace.

import { build } from "esbuild";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const outDir = path.resolve(pkgRoot, process.env.DEALSONAR_BACKEND_OUT ?? "dist/backend");
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

const sqliteSrc = path.dirname(require.resolve("better-sqlite3/package.json"));
const sqliteDest = path.join(outDir, "node_modules", "better-sqlite3");
const localBinding = path.join(sqliteSrc, "build", "Release", "better_sqlite3.node");
const binding = existsSync(localBinding)
  ? localBinding
  : require(path.join(sqliteSrc, "lib", "binding.js")).getPrebuildPath();
if (!binding || !existsSync(binding)) {
  throw new Error(`No SQLite native binding for ${process.platform}-${process.arch}; install dependencies on the package target first`);
}

mkdirSync(sqliteDest, { recursive: true });
for (const entry of ["lib", "package.json", "LICENSE"]) {
  cpSync(path.join(sqliteSrc, entry), path.join(sqliteDest, entry), { recursive: true });
}
const stagedBinding = path.join(sqliteDest, path.relative(sqliteSrc, binding));
mkdirSync(path.dirname(stagedBinding), { recursive: true });
cpSync(binding, stagedBinding);

// Test the staged loader and database engine, rather than resolving the workspace copy.
const Database = require(sqliteDest);
const probe = new Database(":memory:");
try {
  probe.exec("CREATE VIRTUAL TABLE stage_probe USING fts5(body)");
} finally {
  probe.close();
}
console.log(`staged better-sqlite3 binding (${statSync(stagedBinding).size} bytes)`);
console.log(`backend bundle: ${outDir} (${readdirSync(outDir).join(", ")})`);
