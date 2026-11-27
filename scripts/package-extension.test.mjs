import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageExtension } from "./package-extension.mjs";

function fakeDist(manifest) {
  const dist = mkdtempSync(join(tmpdir(), "ext-dist-"));
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "background.js"), "//");
  return dist;
}

test("internal build keeps the key and the Web Store build drops only the key", () => {
  const dist = fakeDist({ manifest_version: 3, name: "DealSonar", version: "1.2.3", key: "QUJD" });
  const out = stageExtension(dist, mkdtempSync(join(tmpdir(), "ext-stage-")));
  const internal = JSON.parse(readFileSync(join(out.internal, "manifest.json"), "utf8"));
  const store = JSON.parse(readFileSync(join(out.store, "manifest.json"), "utf8"));
  assert.equal(internal.key, "QUJD");
  assert.equal("key" in store, false);
  assert.deepEqual({ ...internal, key: undefined }, { ...store, key: undefined });
  assert.ok(existsSync(join(out.store, "background.js")));
});

test("refuses a build without a key", () => {
  const dist = fakeDist({ manifest_version: 3, name: "DealSonar", version: "1.2.3" });
  assert.throws(() => stageExtension(dist, mkdtempSync(join(tmpdir(), "ext-stage-"))), /no key/);
});
