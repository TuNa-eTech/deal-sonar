// Run in the release checkout. Generated files are intentionally not committed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const tag = process.env.GITHUB_REF_NAME ?? "";
const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/.exec(tag);
if (!match) {
  throw new Error("Release tag must be vMAJOR.MINOR.PATCH, optionally with a SemVer prerelease (e.g. v0.3.0-rc.1)");
}
const parts = match.slice(1, 4).map(Number);
if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) {
  throw new Error("Chrome extension version components must be <= 65535 and not all zero");
}
const version = tag.slice(1);
const manifestPath = resolve(root, "apps/extension/public/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = parts.join(".");
manifest.version_name = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared DealSonar ${version}`);
