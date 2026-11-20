#!/usr/bin/env node
/**
 * Bundle `src/main.ts` into one dependency-free CommonJS file (`dist/host.cjs`). It is the
 * script embedded into the Node SEA executable and is also runnable with plain `node` for
 * development and for the synthetic binary tests.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleHost(outfile = path.join(packageRoot, "dist", "host.cjs")) {
  await build({
    entryPoints: [path.join(packageRoot, "src", "main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await bundleHost(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`bundled ${out}`);
}
