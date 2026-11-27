import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { platformReadiness, upgradeReadiness, validateLedger, validateUpgradeRuns } from "./distribution-evidence.mjs";

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

const run = (over = {}) => ({
  id: "up-1", recorded_on: "2026-12-10", platform_id: "macos-arm64", from_tag: "v1.0.0", to_tag: "v1.1.0",
  from_artifact_sha256: "a".repeat(64), to_artifact_sha256: "b".repeat(64), update_path: "dmg_replace_app",
  channel: "customer_download", os_version: "macOS 14.5", tester_ref: "tester-012", evidence_ref: "evidence/mac-upgrade-1.mov",
  checks: { radar_kept: true, old_leads_readable: true, new_post_collected: true, notification_received: true },
  skew_scenarios: [
    { name: "chrome_newer_than_desktop", guidance_shown: true, data_kept: true, recovered: true },
    { name: "desktop_newer_than_chrome", guidance_shown: true, data_kept: true, recovered: true },
  ], ...over,
});

test("the checked-in ledger has no upgrade runs, so no platform is upgrade-verified", () => {
  assert.deepEqual(validateUpgradeRuns(checkedIn, distribution), []);
  assert.deepEqual(checkedIn.upgrade_runs, []);
  assert.ok(upgradeReadiness(checkedIn, distribution).every((u) => !u.upgrade_verified));
});

test("a customer-channel upgrade that kept data, notified and recovered from both skews verifies the platform", () => {
  const ledger = { schema: 1, entries: [], upgrade_runs: [run()] };
  assert.deepEqual(validateUpgradeRuns(ledger, distribution), []);
  const status = upgradeReadiness(ledger, distribution);
  assert.equal(status.find((u) => u.id === "macos-arm64").upgrade_verified, true);
  assert.equal(status.find((u) => u.id === "windows-x64").upgrade_verified, false);
});

test("a failed check, a missing skew scenario or an internal trial never verifies an upgrade", () => {
  for (const over of [
    { checks: { radar_kept: true, old_leads_readable: true, new_post_collected: true, notification_received: false } },
    { skew_scenarios: [{ name: "chrome_newer_than_desktop", guidance_shown: true, data_kept: true, recovered: true }] },
    { skew_scenarios: [
      { name: "chrome_newer_than_desktop", guidance_shown: true, data_kept: true, recovered: true },
      { name: "desktop_newer_than_chrome", guidance_shown: false, data_kept: true, recovered: true },
    ] },
    { channel: "internal_trial" },
  ]) {
    const ledger = { schema: 1, entries: [], upgrade_runs: [run(over)] };
    assert.equal(upgradeReadiness(ledger, distribution).find((u) => u.id === "macos-arm64").upgrade_verified, false, JSON.stringify(over));
  }
});

test("the validator rejects an upgrade run without real identifiers", () => {
  const text = validateUpgradeRuns({ schema: 1, entries: [], upgrade_runs: [
    run({ from_artifact_sha256: "x", to_tag: "v1.0.0", tester_ref: "a@b.c", update_path: "magic", checks: { radar_kept: true } }),
  ] }, distribution).join("\n");
  assert.match(text, /from_artifact_sha256/);
  assert.match(text, /must differ/);
  assert.match(text, /tester_ref/);
  assert.match(text, /update_path/);
  assert.match(text, /checks\.old_leads_readable/);
});
