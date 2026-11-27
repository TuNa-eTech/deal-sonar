import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideChannel, renderNotes } from "./release-manifest.mjs";

const base = JSON.parse(readFileSync(new URL("../docs/delivery/distribution.json", import.meta.url), "utf8"));
const confirmed = (extra = {}) => ({
  ...base,
  decision: { status: "confirmed", decided_by: "owner", decided_on: "2026-12-01" },
  extension: { ...base.extension, web_store: { status: "published", visibility: "unlisted", item_id: "a".repeat(32), listing_url: "https://chromewebstore.google.com/detail/x", published_version: "1.2.3" } },
  ...extra,
});
const prov = (target, file, over = {}) => ({
  file, target, sha256: "00", os: target.includes("windows") ? "windows" : "macos", arch: "x64",
  signed: true, notarized: !target.includes("windows"), signer: "Example Co", runner: {}, ...over,
});
const allSigned = [
  prov("x86_64-pc-windows-msvc", "DealSonar-v1.2.3-x86_64-pc-windows-msvc.exe"),
  prov("aarch64-apple-darwin", "DealSonar-v1.2.3-aarch64-apple-darwin.dmg"),
  prov("x86_64-apple-darwin", "DealSonar-v1.2.3-x86_64-apple-darwin.dmg"),
];

test("the checked-in decision is still proposed, so every build is internal", () => {
  const out = decideChannel({ tag: "v1.2.3", distribution: base, provenance: allSigned });
  assert.equal(out.channel, "internal");
  assert.ok(out.blockers.some((b) => b.includes("not confirmed by the project owner")));
  assert.ok(out.blockers.some((b) => b.includes("Chrome Web Store")));
});

test("unsigned or un-notarized installers keep the release internal and name the platform", () => {
  const out = decideChannel({
    tag: "v1.2.3", distribution: confirmed(),
    provenance: [
      prov("x86_64-pc-windows-msvc", "DealSonar-v1.2.3-x86_64-pc-windows-msvc.exe", { signed: false }),
      prov("aarch64-apple-darwin", "DealSonar-v1.2.3-aarch64-apple-darwin.dmg", { notarized: false }),
    ],
  });
  assert.equal(out.channel, "internal");
  assert.ok(out.blockers.some((b) => b.startsWith("windows-x64:") && b.includes("Authenticode")));
  assert.ok(out.blockers.some((b) => b.startsWith("macos-arm64:") && b.includes("notarized")));
  assert.ok(out.blockers.some((b) => b.startsWith("macos-x64:") && b.includes("not built")));
});

test("a clean, confirmed, fully signed, published release is a customer release", () => {
  const out = decideChannel({ tag: "v1.2.3", distribution: confirmed(), provenance: allSigned });
  assert.deepEqual(out.blockers, []);
  assert.equal(out.channel, "customer");
});

test("uncommitted Linux packages never block or promote a release", () => {
  const out = decideChannel({ tag: "v1.2.3", distribution: confirmed(), provenance: allSigned });
  const linux = out.platforms.find((p) => p.id === "linux-x64-deb");
  assert.equal(linux.committed, false);
  assert.equal(linux.present, false);
});

test("prerelease tags and a store version mismatch are blockers even when everything is signed", () => {
  assert.equal(decideChannel({ tag: "v1.2.3-rc.1", distribution: confirmed(), provenance: allSigned }).channel, "internal");
  const store = confirmed();
  store.extension.web_store.published_version = "1.1.0";
  assert.ok(decideChannel({ tag: "v1.2.3", distribution: store, provenance: allSigned }).blockers.some((b) => b.includes("1.1.0")));
  assert.throws(() => decideChannel({ tag: "1.2.3", distribution: base, provenance: [] }), /Invalid release tag/);
});

test("notes of an internal release say so prominently and list the blockers", () => {
  const decision = decideChannel({ tag: "v1.2.3", distribution: base, provenance: allSigned });
  const notes = renderNotes({ tag: "v1.2.3", decision, distribution: base });
  assert.match(notes, /BẢN THỬ NỘI BỘ, KHÔNG DÀNH CHO KHÁCH HÀNG/);
  assert.match(notes, /Chrome Web Store/);
  const customer = decideChannel({ tag: "v1.2.3", distribution: confirmed(), provenance: allSigned });
  assert.doesNotMatch(renderNotes({ tag: "v1.2.3", decision: customer, distribution: confirmed() }), /KHÔNG DÀNH CHO KHÁCH HÀNG/);
});
