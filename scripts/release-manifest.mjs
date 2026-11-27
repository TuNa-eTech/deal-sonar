// Decides whether a tagged build is an INTERNAL trial or a CUSTOMER release and records exactly
// what was built, from the provenance files written by release-provenance.mjs.
//
//   node scripts/release-manifest.mjs --tag v1.2.3 --dir release-assets [--distribution docs/delivery/distribution.json]
//   -> release-assets/release-manifest.json, release-notes.md; prints channel=<internal|customer>
//
// A release is "customer" only when ALL hold: the tag has no prerelease suffix, the owner has
// confirmed the distribution decision, every committed platform has an installer that satisfies
// its signing requirements, and the extension is published on the Chrome Web Store. Otherwise it
// is "internal" and is published as a prerelease with the blockers listed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function platformStatus(platform, provenance) {
  const record = provenance.find((p) => p.target === platform.target && p.file.endsWith(platform.artifact_suffix));
  if (!record) return { id: platform.id, committed: platform.committed, present: false, satisfied: false, problems: ["installer was not built"] };
  const problems = [];
  const needs = new Set(platform.requires);
  if ((needs.has("authenticode_signature") || needs.has("developer_id_signature")) && !record.signed) {
    problems.push(record.os === "windows" ? "installer has no valid Authenticode signature" : "app is not signed with a Developer ID certificate");
  }
  if (needs.has("notarization") && !record.notarized) problems.push("app is not notarized by Apple");
  return {
    id: platform.id, committed: platform.committed, present: true, file: record.file, sha256: record.sha256,
    signed: record.signed, notarized: record.notarized, signer: record.signer, os: record.os, arch: record.arch,
    runner: record.runner, satisfied: problems.length === 0, problems,
  };
}

export function decideChannel({ tag, distribution, provenance }) {
  if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid release tag ${tag}`);
  const blockers = [];
  if (tag.includes("-")) blockers.push(`tag ${tag} is a prerelease`);
  if (distribution.decision?.status !== "confirmed") blockers.push("platforms and channels are not confirmed by the project owner (docs/delivery/distribution.json decision.status)");
  const platforms = distribution.platforms.map((p) => platformStatus(p, provenance));
  for (const s of platforms.filter((p) => p.committed && !p.satisfied)) {
    blockers.push(`${s.id}: ${s.problems.join("; ")}`);
  }
  const store = distribution.extension?.web_store ?? {};
  if (store.status !== "published") blockers.push(`extension is not published on the Chrome Web Store (status: ${store.status ?? "unknown"})`);
  else if (store.published_version && !tag.startsWith(`v${store.published_version}`)) {
    blockers.push(`Chrome Web Store has version ${store.published_version}, this release is ${tag}`);
  }
  return { channel: blockers.length === 0 ? "customer" : "internal", blockers, platforms };
}

export function renderNotes({ tag, decision, distribution }) {
  const store = distribution.extension?.web_store ?? {};
  const lines = [];
  if (decision.channel === "internal") {
    lines.push(
      `# DealSonar ${tag} — BẢN THỬ NỘI BỘ, KHÔNG DÀNH CHO KHÁCH HÀNG`,
      "",
      "Bản này chưa đủ điều kiện phát hành cho khách hàng. Lý do:",
      ...decision.blockers.map((b) => `- ${b}`),
      "",
      "Hệ điều hành có thể cảnh báo khi mở bộ cài chưa ký. Extension trong gói này nạp bằng *Load unpacked* và chỉ dùng để thử.",
    );
  } else {
    lines.push(
      `# DealSonar ${tag}`,
      "",
      "Bộ cài đã được ký và kiểm tra trên trình chạy phát hành. Cài extension từ Chrome Web Store:",
      store.listing_url ? `- ${store.listing_url}` : "",
      "",
      "Hướng dẫn cài đặt: docs/delivery/customer-install-guide.md",
    );
  }
  lines.push("", "| Tệp | Hệ điều hành | Đã ký | Đã notarize |", "|---|---|---|---|");
  for (const s of decision.platforms.filter((p) => p.present)) {
    lines.push(`| ${s.file} | ${s.os} ${s.arch} | ${s.signed ? `có (${s.signer})` : "không"} | ${s.os === "macos" ? (s.notarized ? "có" : "không") : "—"} |`);
  }
  lines.push("", "Kiểm tra tải về bằng `SHA256SUMS.txt`; chi tiết nguồn gốc từng tệp trong `release-manifest.json`.");
  return `${lines.join("\n")}\n`;
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const tag = get("--tag"), dir = resolve(get("--dir", "release-assets"));
  const distribution = JSON.parse(readFileSync(resolve(get("--distribution", "docs/delivery/distribution.json")), "utf8"));
  if (!tag) { console.error("Usage: node scripts/release-manifest.mjs --tag <vX.Y.Z> --dir <assets> [--distribution <file>]"); process.exit(2); }

  const names = readdirSync(dir);
  const provenance = names.filter((n) => n.endsWith(".provenance.json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  const decision = decideChannel({ tag, distribution, provenance });
  const extensionFiles = names.filter((n) => /^DealSonar-extension-.*\.zip$/.test(n)).map((n) => ({
    file: n, sha256: sha256(join(dir, n)),
    kind: n.includes("webstore") ? "extension-web-store-upload" : "extension-internal-unpacked",
  }));
  const manifest = {
    schema: 1, tag, version: tag.slice(1), channel: decision.channel, blockers: decision.blockers,
    commit: process.env.GITHUB_SHA ?? null,
    run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    generated_at: new Date().toISOString(),
    platforms: decision.platforms, extension: { web_store: distribution.extension.web_store, files: extensionFiles },
    note: "Build-time facts only. Clean-machine install and pairing evidence is recorded separately in docs/delivery/distribution-evidence.json.",
  };
  writeFileSync(join(dir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "release-notes.md"), renderNotes({ tag, decision, distribution }));
  console.log(`channel=${decision.channel}`);
  for (const b of decision.blockers) console.log(`blocker: ${b}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
