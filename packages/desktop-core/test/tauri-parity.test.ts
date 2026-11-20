// Differential tests against fixtures written by the REAL Rust store (tools/gen-tauri-fixture).
// Generate them once (needs cargo):
//   cargo run --manifest-path packages/desktop-core/tools/gen-tauri-fixture/Cargo.toml -- \
//       packages/desktop-core/test/fixtures/tauri
// When the fixtures are absent the suite is skipped (and says so) rather than silently passing.

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../src";

const FIXTURES = path.resolve(__dirname, "fixtures/tauri");
const have = fs.existsSync(path.join(FIXTURES, "golden.json")) && fs.existsSync(path.join(FIXTURES, "tauri-v3.sqlite3"));
const suite = have ? describe : describe.skip;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-parity-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const dest = path.join(tmp, name);
  fs.copyFileSync(path.join(FIXTURES, name), dest);
  return dest;
}

/** serde emits floats like `3.0`; JS cannot tell `3` and `3.0` apart, so compare numerically. */
const normalize = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

suite("Tauri SQLite fixtures (schema v3)", () => {
  const golden = have ? JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden.json"), "utf8")) : {};

  function open(): Store {
    return Store.open(copyFixture("tauri-v3.sqlite3"), path.join(tmp, "bk"));
  }

  it("opens a Rust-written v3 database without migrating or backing it up", () => {
    const store = open();
    expect(store.listSchemaMigrations().map((m) => m.version)).toEqual([1, 2, 3]);
    expect(fs.existsSync(path.join(tmp, "bk"))).toBe(false);
    expect(normalize(store.tableRowCounts())).toEqual(golden.table_row_counts);
    store.verifyFtsIntegrity();
    store.close();
  });

  it("lead_list matches the Rust store (filters, sort, search, pagination)", () => {
    const store = open();
    const base = { radar_id: golden.ids.radar, limit: 50 };
    expect(normalize(store.leads.list(base))).toEqual(golden.lead_list_default);
    expect(normalize(store.leads.list({ ...base, filters: [{ field: "price", op: "lte", value: 100 }] }))).toEqual(
      golden.lead_list_price_lte_100,
    );
    expect(normalize(store.leads.list({ ...base, sort: { by: "area", dir: "asc" } }))).toEqual(golden.lead_list_area_sort_asc);
    expect(normalize(store.leads.list({ ...base, search: "thue" }))).toEqual(golden.lead_list_search_thue);
    expect(normalize(store.leads.list({ ...base, limit: 2 }))).toEqual(golden.lead_list_page_1);
    store.close();
  });

  it("reads posts, contacts, radars, sources, stats and lead detail like Rust", () => {
    const store = open();
    expect(store.posts.search("dong da", null, 10).map((p) => p.id)).toEqual(golden.post_search_dong_da);
    expect(normalize(store.contacts.list(null, 10))).toEqual(golden.contact_list);
    expect(store.contacts.list("0912", 10)).toHaveLength(golden.contact_search_phone);
    expect(normalize(store.radars.get(golden.ids.radar))).toEqual(golden.radar_get);
    expect(normalize(store.sources.list(1_700_000_001_000))).toEqual(golden.source_list);
    expect(normalize(store.radars.stats(golden.ids.radar, 1_700_000_001_000))).toEqual(golden.radar_stats);
    const lead = store.leads.leadGet(golden.lead_get_1.lead.id);
    expect(normalize(lead)).toEqual(golden.lead_get_1);
    store.close();
  });

  it("drains the Rust-written queue rows", () => {
    const store = open();
    expect(store.jobs.claimDue(2_000_000_000_000)).toMatchObject({ kind: "evaluate_batch", dedup_key: "k1", attempts: 1 });
    expect(store.outbox.claimDue(2_000_000_000_000)).toMatchObject({ id: "01OUTBOX00000000000000001", kind: "lead" });
    store.close();
  });

  it("keeps the retained schema identical to what Rust wrote (rollback compatibility)", () => {
    const ours = Store.openInMemory();
    const theirs = new Database(path.join(FIXTURES, "tauri-v3.sqlite3"), { readonly: true });
    const schema = (db: Database.Database): string[] =>
      (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<Record<string, string>>).map(
        (r) => `${r.type}|${r.name}|${r.tbl_name}|${(r.sql ?? "").replace(/\s+/g, " ")}`,
      );
    expect(schema(ours.db)).toEqual(schema(theirs));
    theirs.close();
    ours.close();
  });

  it("a database edited by this backend still opens cleanly under the Rust migration rules", () => {
    const store = open();
    store.settings.set("launch_at_login", false);
    store.leads.setStatus(golden.lead_get_1.lead.id, "contacted", 1_700_000_002_000);
    store.close();
    const raw = new Database(path.join(tmp, "tauri-v3.sqlite3"), { readonly: true });
    expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    raw.close();
  });
});

suite("Tauri SQLite fixtures (schema v1 upgrade)", () => {
  it("upgrades a Rust-written v1 database, writing a pre-migration backup first", () => {
    const store = Store.open(copyFixture("tauri-v1.sqlite3"), path.join(tmp, "bk"));
    expect(store.listSchemaMigrations().map((m) => m.version)).toEqual([1, 2, 3]);
    const backups = fs.readdirSync(path.join(tmp, "bk"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^dealsonar-pre-v0002-\d+\.db$/);
    // data survived and the 0003 workflow columns exist
    expect((store.db.prepare("SELECT COUNT(*) AS c FROM leads").get() as { c: number }).c).toBe(3);
    expect((store.db.prepare("SELECT COUNT(*) AS c FROM leads WHERE read_at IS NULL").get() as { c: number }).c).toBe(3);
    expect(store.settings.get("launch_at_login")).toBe(true);
    store.verifyFtsIntegrity();
    store.close();
  });
});

describe.runIf(!have)("Tauri fixtures", () => {
  it("are not generated yet: run tools/gen-tauri-fixture (see header) to enable differential tests", () => {
    expect(have).toBe(false);
  });
});
