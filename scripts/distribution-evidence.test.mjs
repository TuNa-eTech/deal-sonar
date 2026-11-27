import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { platformReadiness, validateLedger } from "./distribution-evidence.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const distribution = read("docs/delivery/distribution.json");
const checkedIn = read("docs/delivery/distribution-evidence.json");

const entry = (over = {}) => ({
  id: "ev-1", recorded_on: "2026-12-01", platform_id: "windows-x64", release_tag: "v1.0.0",
  artifact_sha256: "a".repeat(64), channel: "customer_download", download_url: "https://example.com/dl/DealSonar.exe",
  os_version: "Windows 11 23H2 (clean VM)", browser: { name: "Chrome", version: "131.0" },
  extension_source: "chrome_web_store", extension_id: "b".repeat(32), clean_machine: true,
  pairing_result: "paired", tester_ref: "tester-007", evidence_ref: "evidence/win-run-1.png",
  signature_observed: { signed: true }, ...over,
});

test("the checked-in ledger is valid and claims no evidence it does not have", () => {
  assert.deepEqual(validateLedger(checkedIn, distribution), []);
  assert.equal(checkedIn.entries.length, 0);
  assert.ok(platformReadiness(checkedIn, distribution).every((s) => !s.customer_ready));
});

test("a clean-machine, signed, public Web Store download that paired makes a platform customer-ready", () => {
  const ledger = { schema: 1, entries: [entry()] };
  assert.deepEqual(validateLedger(ledger, distribution), []);
  const win = platformReadiness(ledger, distribution).find((s) => s.id === "windows-x64");
  assert.equal(win.customer_ready, true);
  assert.equal(platformReadiness(ledger, distribution).find((s) => s.id === "macos-arm64").customer_ready, false);
});

test("internal trials and unsigned or non-clean runs never count as customer evidence", () => {
  for (const over of [
    { channel: "internal_trial", extension_source: "unpacked_zip", download_url: undefined },
    { signature_observed: { signed: false } },
    { clean_machine: false },
    { pairing_result: "failed" },
    { extension_source: "unpacked_zip" },
  ]) {
    const status = platformReadiness({ schema: 1, entries: [entry(over)] }, distribution).find((s) => s.id === "windows-x64");
    assert.equal(status.customer_ready, false, JSON.stringify(over));
  }
});

test("the validator rejects invented or incomplete evidence", () => {
  const problems = validateLedger({ schema: 1, entries: [
    entry({ id: "x", artifact_sha256: "short", tester_ref: "jane@example.com", download_url: "http://insecure", release_tag: "v1.0.0-rc.1" }),
    entry({ id: "x", platform_id: "beos" }),
  ] }, distribution);
  const text = problems.join("\n");
  assert.match(text, /artifact_sha256/);
  assert.match(text, /tester_ref/);
  assert.match(text, /https download_url/);
  assert.match(text, /prerelease tag cannot be a customer download/);
  assert.match(text, /duplicate id/);
  assert.match(text, /unknown platform_id beos/);
});
