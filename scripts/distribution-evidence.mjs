// Validates the ledger of real install-and-pair runs and reports, per committed platform, whether
// there is evidence for an INTERNAL trial build and for a CUSTOMER download.
//
//   node scripts/distribution-evidence.mjs                      # validate + print status
//   node scripts/distribution-evidence.mjs --require-customer   # also fail if a committed platform has no customer evidence
//   node scripts/distribution-evidence.mjs add <entry.json>     # validate and append one entry
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CHANNELS = ["internal_trial", "customer_download"];
const EXTENSION_SOURCES = ["unpacked_zip", "chrome_web_store"];
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns problems for the whole ledger; empty means valid. */
export function validateLedger(ledger, distribution) {
  const problems = [];
  if (ledger.schema !== 1 || !Array.isArray(ledger.entries)) return ["ledger must be { schema: 1, entries: [] }"];
  const platforms = new Map(distribution.platforms.map((p) => [p.id, p]));
  const ids = new Set();
  ledger.entries.forEach((e, i) => {
    const at = `entries[${i}]${e.id ? ` (${e.id})` : ""}`;
    const bad = (msg) => problems.push(`${at}: ${msg}`);
    if (!e.id) bad("missing id");
    else if (ids.has(e.id)) bad("duplicate id");
    ids.add(e.id);
    if (!DATE.test(e.recorded_on ?? "")) bad("recorded_on must be YYYY-MM-DD");
    if (!platforms.has(e.platform_id)) bad(`unknown platform_id ${e.platform_id}`);
    if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(e.release_tag ?? "")) bad("release_tag must look like v1.2.3");
    if (!SHA256.test(e.artifact_sha256 ?? "")) bad("artifact_sha256 must be a lowercase 64-hex SHA-256 of the installer that was actually run");
    if (!CHANNELS.includes(e.channel)) bad(`channel must be one of ${CHANNELS.join(", ")}`);
    if (!e.os_version) bad("os_version is required");
    if (!e.browser?.name || !e.browser?.version) bad("browser.name and browser.version are required");
    if (!EXTENSION_SOURCES.includes(e.extension_source)) bad(`extension_source must be one of ${EXTENSION_SOURCES.join(", ")}`);
    if (!/^[a-p]{32}$/.test(e.extension_id ?? "")) bad("extension_id must be the 32-letter ID shown in chrome://extensions");
    if (typeof e.clean_machine !== "boolean") bad("clean_machine must be true or false");
    if (!["paired", "failed"].includes(e.pairing_result)) bad("pairing_result must be paired or failed");
    if (!e.tester_ref || /@|\s/.test(e.tester_ref)) bad("tester_ref must be an opaque id without spaces or email addresses");
    if (!e.evidence_ref) bad("evidence_ref (screenshot or log location) is required");
    if (typeof e.signature_observed?.signed !== "boolean") bad("signature_observed.signed must be recorded");
    if (e.channel === "customer_download") {
      if (!/^https:\/\//.test(e.download_url ?? "")) bad("customer_download needs the public https download_url that was used");
      if (e.release_tag?.includes("-")) bad("a prerelease tag cannot be a customer download");
    }
    if (e.extension_source === "chrome_web_store" && e.channel === "internal_trial" && !e.notes) bad("explain in notes why a Web Store install was an internal trial");
  });
  return problems;
}

const UPGRADE_UPDATE_PATHS = ["over_install_installer", "dmg_replace_app"];
const SKEW_SCENARIOS = ["chrome_newer_than_desktop", "desktop_newer_than_chrome"];
const UPGRADE_CHECKS = ["radar_kept", "old_leads_readable", "new_post_collected", "notification_received"];

/** Problems in the upgrade-run ledger (`upgrade_runs`, optional). */
export function validateUpgradeRuns(ledger, distribution) {
  const problems = [];
  const runs = ledger.upgrade_runs ?? [];
  if (!Array.isArray(runs)) return ["upgrade_runs must be an array"];
  const platforms = new Map(distribution.platforms.map((p) => [p.id, p]));
  const ids = new Set();
  runs.forEach((r, i) => {
    const at = `upgrade_runs[${i}]${r.id ? ` (${r.id})` : ""}`;
    const bad = (msg) => problems.push(`${at}: ${msg}`);
    if (!r.id) bad("missing id");
    else if (ids.has(r.id)) bad("duplicate id");
    ids.add(r.id);
    if (!DATE.test(r.recorded_on ?? "")) bad("recorded_on must be YYYY-MM-DD");
    if (!platforms.has(r.platform_id)) bad(`unknown platform_id ${r.platform_id}`);
    for (const key of ["from_tag", "to_tag"]) {
      if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(r[key] ?? "")) bad(`${key} must look like v1.2.3`);
    }
    if (r.from_tag && r.from_tag === r.to_tag) bad("from_tag and to_tag must differ");
    for (const key of ["from_artifact_sha256", "to_artifact_sha256"]) {
      if (!SHA256.test(r[key] ?? "")) bad(`${key} must be the lowercase SHA-256 of the installer actually run`);
    }
    if (!UPGRADE_UPDATE_PATHS.includes(r.update_path)) bad(`update_path must be one of ${UPGRADE_UPDATE_PATHS.join(", ")}`);
    if (!CHANNELS.includes(r.channel)) bad(`channel must be one of ${CHANNELS.join(", ")}`);
    if (!r.os_version) bad("os_version is required");
    if (!r.tester_ref || /@|\s/.test(r.tester_ref)) bad("tester_ref must be an opaque id without spaces or email addresses");
    if (!r.evidence_ref) bad("evidence_ref is required");
    for (const check of UPGRADE_CHECKS) {
      if (typeof r.checks?.[check] !== "boolean") bad(`checks.${check} must be true or false`);
    }
    for (const scenario of r.skew_scenarios ?? []) {
      if (!SKEW_SCENARIOS.includes(scenario.name)) bad(`skew scenario ${scenario.name} is unknown`);
      if (typeof scenario.guidance_shown !== "boolean" || typeof scenario.data_kept !== "boolean" || typeof scenario.recovered !== "boolean") {
        bad(`skew scenario ${scenario.name} needs guidance_shown, data_kept and recovered`);
      }
    }
    if (r.channel === "customer_download" && r.to_tag?.includes("-")) bad("a prerelease tag cannot be a customer download");
  });
  return problems;
}

/** A platform is upgrade-verified when a customer-channel run passed every check and both skew scenarios. */
export function upgradeReadiness(ledger, distribution) {
  return distribution.platforms.map((p) => {
    const runs = (ledger.upgrade_runs ?? []).filter((r) => r.platform_id === p.id);
    const verified = runs.filter((r) =>
      r.channel === "customer_download" &&
      UPGRADE_CHECKS.every((c) => r.checks?.[c] === true) &&
      SKEW_SCENARIOS.every((name) => (r.skew_scenarios ?? []).some((s) => s.name === name && s.guidance_shown && s.data_kept && s.recovered)));
    return { id: p.id, committed: p.committed, upgrade_verified: verified.length > 0, upgrade_runs: runs.length };
  });
}

/** Evidence status per platform. `customer_ready` demands a clean-machine, signed, public download that paired. */
export function platformReadiness(ledger, distribution) {
  return distribution.platforms.map((p) => {
    const mine = ledger.entries.filter((e) => e.platform_id === p.id);
    const needsSignature = p.requires.length > 0;
    const customer = mine.filter((e) =>
      e.channel === "customer_download" && e.clean_machine && e.pairing_result === "paired" &&
      e.extension_source === "chrome_web_store" && (!needsSignature || e.signature_observed?.signed));
    const internal = mine.filter((e) => e.channel === "internal_trial" && e.pairing_result === "paired");
    return {
      id: p.id, committed: p.committed,
      customer_ready: customer.length > 0,
      customer_evidence: customer.map((e) => ({ id: e.id, release_tag: e.release_tag, recorded_on: e.recorded_on })),
      internal_trials_paired: internal.length,
      entries: mine.length,
    };
  });
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const ledgerPath = resolve(root, "docs/delivery/distribution-evidence.json");
  const distribution = JSON.parse(readFileSync(resolve(root, "docs/delivery/distribution.json"), "utf8"));
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const args = process.argv.slice(2);

  if (args[0] === "add") {
    const entry = JSON.parse(readFileSync(resolve(args[1]), "utf8"));
    const next = { ...ledger, entries: [...ledger.entries, entry] };
    const problems = validateLedger(next, distribution);
    if (problems.length) { problems.forEach((p) => console.error(`✗ ${p}`)); process.exit(1); }
    writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Recorded ${entry.id}`);
    return;
  }

  const problems = [...validateLedger(ledger, distribution), ...validateUpgradeRuns(ledger, distribution)];
  if (problems.length) { problems.forEach((p) => console.error(`✗ ${p}`)); process.exit(1); }
  const status = platformReadiness(ledger, distribution);
  const upgrades = new Map(upgradeReadiness(ledger, distribution).map((u) => [u.id, u]));
  for (const s of status) {
    const u = upgrades.get(s.id);
    console.log(`${s.committed ? "committed  " : "not-committed"} ${s.id.padEnd(20)} customer_ready=${s.customer_ready} internal_trials_paired=${s.internal_trials_paired} entries=${s.entries} upgrade_verified=${u.upgrade_verified} upgrade_runs=${u.upgrade_runs}`);
  }
  if (args.includes("--require-customer")) {
    const missing = status.filter((s) => s.committed && !s.customer_ready).map((s) => s.id);
    if (missing.length) { console.error(`✗ No customer-download evidence for: ${missing.join(", ")}`); process.exit(1); }
    const noUpgrade = [...upgrades.values()].filter((u) => u.committed && !u.upgrade_verified).map((u) => u.id);
    if (noUpgrade.length) { console.error(`✗ No verified upgrade run for: ${noUpgrade.join(", ")}`); process.exit(1); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
