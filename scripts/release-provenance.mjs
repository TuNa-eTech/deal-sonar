// Records what a built installer really is: checksum, version, platform and whether the operating
// system's own tools consider it signed (and, on macOS, notarized). Runs on the build runner,
// next to the installer, and writes <installer>.provenance.json. Nothing here is self-declared:
// "signed" comes from codesign/spctl on macOS and Get-AuthenticodeSignature on Windows.
//
//   node scripts/release-provenance.mjs --target <triple> --file <installer> --tag <vX.Y.Z> [--require-signing]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** `codesign -dvv` prints to stderr. Ad-hoc signatures are NOT a publisher identity. */
export function parseCodesign(text) {
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const adhoc = /^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]+\(adhoc/.test(text);
  const teamId = /^TeamIdentifier=(\S+)$/m.exec(text)?.[1] ?? null;
  const developerId = authorities.some((a) => a.startsWith("Developer ID Application"));
  return {
    signed: developerId && !adhoc,
    adhoc,
    signer: authorities[0] ?? null,
    team_id: teamId && teamId !== "not set" ? teamId : null,
  };
}

/** `spctl -a -t exec -vv` reports "source=Notarized Developer ID" for a notarized app. */
export function parseSpctl(text) {
  return { accepted: /: accepted/.test(text), notarized: /source=Notarized Developer ID/.test(text) };
}

/** JSON from `Get-AuthenticodeSignature | ConvertTo-Json` with Status, Subject, Thumbprint. */
export function parseAuthenticode(jsonText) {
  const data = JSON.parse(jsonText);
  const status = String(data.Status);
  // PowerShell may serialise the enum as its number: 0 === Valid.
  const valid = status === "Valid" || status === "0";
  return { signed: valid, signer: valid ? (data.Subject ?? null) : null, thumbprint: valid ? (data.Thumbprint ?? null) : null };
}

export function platformOf(target) {
  if (target.includes("windows")) return { os: "windows", arch: "x64" };
  if (target === "aarch64-apple-darwin") return { os: "macos", arch: "arm64" };
  if (target === "x86_64-apple-darwin") return { os: "macos", arch: "x64" };
  if (target.includes("linux")) return { os: "linux", arch: "x64" };
  throw new Error(`Unsupported target ${target}`);
}

function run(cmd, args) {
  try {
    return { ok: true, text: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, text: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function inspectMacos(dmg) {
  const mount = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  try {
    const app = run("/bin/sh", ["-c", `ls -d "${mount}"/*.app | head -n 1`]).text.trim();
    if (!app) return { signed: false, notarized: false, signer: null, note: "no .app found inside dmg" };
    const info = parseCodesign(run("codesign", ["-dvv", app]).text);
    const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
    const spctl = parseSpctl(run("spctl", ["-a", "-t", "exec", "-vv", app]).text);
    return { ...info, signed: info.signed && verify.ok, notarized: info.signed && verify.ok && spctl.notarized, note: null };
  } finally {
    run("hdiutil", ["detach", mount, "-force"]);
  }
}

function inspectWindows(exe) {
  const script = `Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}' | ` +
    "Select-Object Status, @{n='Subject';e={$_.SignerCertificate.Subject}}, @{n='Thumbprint';e={$_.SignerCertificate.Thumbprint}} | ConvertTo-Json";
  const out = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!out.ok) return { signed: false, notarized: false, signer: null, note: "Get-AuthenticodeSignature failed" };
  const parsed = parseAuthenticode(out.text);
  return { signed: parsed.signed, notarized: false, signer: parsed.signer, note: null };
}

export function inspectArtifact(target, file) {
  const { os } = platformOf(target);
  if (os === "macos") return inspectMacos(file);
  if (os === "windows") return inspectWindows(file);
  return { signed: false, notarized: false, signer: null, note: "Linux packages are not signed" };
}

export function buildProvenance({ file, target, tag, inspection, env = process.env }) {
  const { os, arch } = platformOf(target);
  const size = statSync(file).size;
  return {
    schema: 1,
    file: basename(file),
    sha256: sha256File(file),
    size,
    tag,
    version: tag.replace(/^v/, ""),
    target,
    os,
    arch,
    runner: { image: env.ImageOS ?? null, image_version: env.ImageVersion ?? null, runner_os: env.RUNNER_OS ?? null },
    signed: inspection.signed,
    notarized: inspection.notarized,
    signer: inspection.signer,
    note: inspection.note ?? null,
    commit: env.GITHUB_SHA ?? null,
    run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    recorded_at: new Date().toISOString(),
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const target = get("--target"), file = get("--file"), tag = get("--tag");
  if (!target || !file || !tag) {
    console.error("Usage: node scripts/release-provenance.mjs --target <triple> --file <installer> --tag <vX.Y.Z> [--require-signing]");
    process.exit(2);
  }
  const record = buildProvenance({ file, target, tag, inspection: inspectArtifact(target, file) });
  writeFileSync(`${file}.provenance.json`, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${record.file}: signed=${record.signed} notarized=${record.notarized} signer=${record.signer ?? "none"} sha256=${record.sha256}`);
  if (args.includes("--require-signing") && (!record.signed || (record.os === "macos" && !record.notarized))) {
    console.error("Signing was required for this build but the installer is not publisher-signed" + (record.os === "macos" ? " and notarized." : "."));
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
