// Run in the release checkout. Generated files are intentionally not committed.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const target = process.argv[2];
if (target) {
  const supported = new Set([
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
  ]);
  if (!supported.has(target)) throw new Error(`Unsupported release target: ${target}`);
  const extension = target.includes("windows") ? ".exe" : "";
  const desktop = resolve(root, "apps/desktop");
  mkdirSync(resolve(desktop, "binaries"), { recursive: true });
  copyFileSync(
    resolve(root, `target/${target}/release/dealsonar-native-host${extension}`),
    resolve(desktop, `binaries/dealsonar-native-host-${target}${extension}`),
  );
  const config = {
    version,
    bundle: {
      externalBin: ["binaries/dealsonar-native-host"],
      createUpdaterArtifacts: false,
      macOS: { signingIdentity: "-" },
      windows: { certificateThumbprint: null, signCommand: null },
    },
  };
  writeFileSync(resolve(desktop, "release.conf.json"), `${JSON.stringify(config, null, 2)}\n`);
}
console.log(`Prepared DealSonar ${version}${target ? ` for ${target}` : ""}`);
