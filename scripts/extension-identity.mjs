// Keeps the extension's stable identity consistent across the manifest key, the Desktop app
// (Native Messaging allowed origins) and docs/delivery/distribution.json.
//
//   node scripts/extension-identity.mjs            # verify, exit 1 on drift
//   node scripts/extension-identity.mjs --print    # print the key-derived ID
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ID_PATTERN = /^[a-p]{32}$/;

/** Chrome extension ID: SHA-256 of the DER public key, first 16 bytes, hex digits mapped 0-f -> a-p. */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, "base64");
  if (der.length === 0) throw new Error("manifest key is empty or not base64");
  const digest = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

/** Extract `DEFAULT_CHROME_EXTENSION_ID` and the `KNOWN_CHROME_EXTENSION_IDS` list from Rust source. */
export function parseRustExtensionIds(source) {
  const def = /pub const DEFAULT_CHROME_EXTENSION_ID: &str = "([^"]*)";/.exec(source)?.[1] ?? null;
  const listBody = /pub const KNOWN_CHROME_EXTENSION_IDS: &\[&str\] = &\[([^\]]*)\];/.exec(source)?.[1];
  const literals = listBody ? [...listBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const usesDefault = listBody ? /\bDEFAULT_CHROME_EXTENSION_ID\b/.test(listBody) : false;
  const known = [...(usesDefault && def ? [def] : []), ...literals];
  return { defaultId: def, known: listBody ? known : null };
}

/** Returns a list of human-readable problems; empty means consistent. */
export function checkIdentity({ manifest, rustSource, distribution }) {
  const problems = [];
  let derived = null;
  try {
    derived = extensionIdFromKey(manifest.key ?? "");
  } catch (error) {
    problems.push(`apps/extension/public/manifest.json: ${error.message}`);
  }
  const rust = parseRustExtensionIds(rustSource);
  if (!rust.defaultId) problems.push("crates/core/src/service/mod.rs: DEFAULT_CHROME_EXTENSION_ID not found");
  if (!rust.known) problems.push("crates/core/src/service/mod.rs: KNOWN_CHROME_EXTENSION_IDS not found");
  if (derived && rust.defaultId && derived !== rust.defaultId) {
    problems.push(`DEFAULT_CHROME_EXTENSION_ID ${rust.defaultId} does not match the manifest key (${derived}); the Desktop app would reject the extension`);
  }
  const ext = distribution.extension ?? {};
  if (derived && ext.key_derived_id !== derived) {
    problems.push(`docs/delivery/distribution.json extension.key_derived_id (${ext.key_derived_id}) does not match the manifest key (${derived})`);
  }
  const store = ext.web_store ?? {};
  if (store.item_id != null) {
    if (!ID_PATTERN.test(store.item_id)) problems.push(`web_store.item_id "${store.item_id}" is not a 32-letter a-p extension ID`);
    else if (rust.known && !rust.known.includes(store.item_id)) {
      problems.push(`web_store.item_id ${store.item_id} is missing from KNOWN_CHROME_EXTENSION_IDS; Web Store installs would not pair`);
    }
  }
  if (store.status === "published") {
    if (!store.item_id) problems.push("web_store.status is \"published\" but item_id is empty");
    if (!store.listing_url) problems.push("web_store.status is \"published\" but listing_url is empty");
    if (!store.published_version) problems.push("web_store.status is \"published\" but published_version is empty");
  }
  if (!["not_published", "in_review", "published"].includes(store.status)) {
    problems.push(`web_store.status must be not_published, in_review or published (got ${store.status})`);
  }
  return problems;
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const read = (p) => readFileSync(resolve(root, p), "utf8");
  const manifest = JSON.parse(read("apps/extension/public/manifest.json"));
  if (process.argv.includes("--print")) {
    console.log(extensionIdFromKey(manifest.key));
    return;
  }
  const problems = checkIdentity({
    manifest,
    rustSource: read("crates/core/src/service/mod.rs"),
    distribution: JSON.parse(read("docs/delivery/distribution.json")),
  });
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`Extension identity consistent: ${extensionIdFromKey(manifest.key)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
