import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkIdentity, extensionIdFromKey, parseRustExtensionIds } from "./extension-identity.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("apps/extension/public/manifest.json"));
const distribution = JSON.parse(read("docs/delivery/distribution.json"));
const rustSource = read("crates/core/src/service/mod.rs");

test("the repository's identity is consistent", () => {
  assert.deepEqual(checkIdentity({ manifest, rustSource, distribution }), []);
});

test("derives the documented ID from the manifest key", () => {
  assert.equal(extensionIdFromKey(manifest.key), "hkmjpcenjjebhpjicnbpmogidfcbmbjn");
});

test("parses the Rust constants including the default reference", () => {
  const parsed = parseRustExtensionIds(rustSource);
  assert.equal(parsed.defaultId, "hkmjpcenjjebhpjicnbpmogidfcbmbjn");
  assert.ok(parsed.known.includes(parsed.defaultId));
});

test("detects a changed manifest key, an unknown Web Store ID and an unpublished 'published' status", () => {
  const otherKey = Buffer.from("another public key").toString("base64");
  const drift = checkIdentity({ manifest: { ...manifest, key: otherKey }, rustSource, distribution });
  assert.ok(drift.some((p) => p.includes("does not match the manifest key")));

  const store = "a".repeat(32);
  const unknown = checkIdentity({
    manifest, rustSource,
    distribution: { ...distribution, extension: { ...distribution.extension, web_store: { status: "in_review", item_id: store } } },
  });
  assert.ok(unknown.some((p) => p.includes("missing from KNOWN_CHROME_EXTENSION_IDS")));

  const incomplete = checkIdentity({
    manifest, rustSource,
    distribution: { ...distribution, extension: { ...distribution.extension, web_store: { status: "published", item_id: null } } },
  });
  assert.ok(incomplete.some((p) => p.includes("item_id is empty")));
  assert.ok(incomplete.some((p) => p.includes("listing_url is empty")));
});
