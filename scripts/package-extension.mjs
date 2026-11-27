// Stage the built extension (apps/extension/dist) for the two distribution channels:
//
//   internal  - dist as built, WITH manifest "key", so the extension ID is the stable
//               key-derived ID and pairs with the Desktop app on a clean machine ("Load unpacked").
//   web-store - same files with the manifest "key" removed. The Chrome Web Store assigns and owns
//               the item ID and rejects uploads that carry a key.
//
//   node scripts/package-extension.mjs <dist-dir> <staging-dir>
//     -> <staging-dir>/internal-unpacked/  and  <staging-dir>/web-store/
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export function stripKey(manifest) {
  const { key: _key, ...rest } = manifest;
  return rest;
}

export function stageExtension(distDir, stagingDir) {
  const manifestPath = join(distDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw new Error("dist manifest has no key; the internal build would get a random extension ID");
  }
  const internal = join(stagingDir, "internal-unpacked");
  const store = join(stagingDir, "web-store");
  for (const dir of [internal, store]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(distDir, dir, { recursive: true });
  }
  writeFileSync(join(store, "manifest.json"), `${JSON.stringify(stripKey(manifest), null, 2)}\n`);
  return { internal, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dist, staging] = process.argv.slice(2);
  if (!dist || !staging) {
    console.error("Usage: node scripts/package-extension.mjs <dist-dir> <staging-dir>");
    process.exit(2);
  }
  const out = stageExtension(resolve(dist), resolve(staging));
  console.log(`Staged ${out.internal} and ${out.store}`);
}
