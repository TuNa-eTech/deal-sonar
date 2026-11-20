import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  Store,
  StoreError,
  buildFts5Query,
  defaultJobRetryDelayMs,
  defaultMigrationsDir,
  extractE164PhonesLight,
  foldVi,
  hammingDistance,
  isValidFieldKey,
  loadMigrations,
  newUlid,
  normalizeNotifyConfig,
  simhashBands,
  unixDayToYmd,
} from "../src";

const ORACLE_MIGRATIONS = path.resolve(__dirname, "../../../crates/store/migrations");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-core-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function paths() {
  return { db: path.join(tmp, "data", "dealsonar.db"), backups: path.join(tmp, "data", "backups") };
}

/** Insert the minimum rows needed for a lead (FKs are enforced). */
function seedLead(store: Store, leadId = "L1"): void {
  const db = store.db;
  db.exec(`
    INSERT INTO sources (id, external_id, name, url, created_at) VALUES ('S1','g1','Group','https://x',1);
    INSERT INTO posts (id, platform, external_id, source_id, permalink, text, content_hash, simhash, captured_at, strategy)
      VALUES ('P1','facebook','p1','S1','https://p','hello','h',0,1,'t');
    INSERT INTO radars (id, name, notify, created_at, updated_at) VALUES ('R1','r','{}',1,1);
    INSERT INTO radar_versions (id, radar_id, version, description, fields, match_policy, created_at)
      VALUES ('V1','R1',1,'d','[]','{}',1);
    INSERT INTO evaluations (id, post_id, radar_version_id, state, created_at) VALUES ('E1','P1','V1','done',1);
    INSERT INTO leads (id, radar_id, radar_version_id, post_id, evaluation_id, score, summary, fields, created_at, updated_at)
      VALUES ('${leadId}','R1','V1','P1','E1',0.9,'sum','{}',1,1);
  `);
}

describe("migrations (retained schema)", () => {
  it("are byte-identical to the Rust oracle migrations", () => {
    for (const name of ["0001_init", "0002_durable_feedback", "0003_workflow"]) {
      const ours = fs.readFileSync(path.join(defaultMigrationsDir(), `${name}.sql`));
      const oracle = fs.readFileSync(path.join(ORACLE_MIGRATIONS, `${name}.sql`));
      expect(ours.equals(oracle), name).toBe(true);
    }
  });

  it("applies 0001-0003 in memory", () => {
    const store = Store.openInMemory();
    expect(store.listSchemaMigrations().map((m) => [m.version, m.name])).toEqual([
      [1, "0001_init"],
      [2, "0002_durable_feedback"],
      [3, "0003_workflow"],
    ]);
    expect(LATEST_SCHEMA_VERSION).toBe(3);
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    const cols = store.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("read_at");
    store.verifyFtsIntegrity();
    store.close();
  });

  it("opens file store in WAL mode", () => {
    const p = paths();
    const store = Store.open(p.db, p.backups);
    expect(store.journalMode()).toBe("wal");
    store.close();
  });

  it("rejects a database from a newer schema", () => {
    const p = paths();
    Store.open(p.db, p.backups).close();
    const raw = new Database(p.db);
    raw.prepare("INSERT INTO schema_migrations VALUES (99,'future',1)").run();
    raw.close();
    expect(() => Store.open(p.db, p.backups)).toThrowError(StoreError);
    expect(() => Store.open(p.db, p.backups)).toThrowError(/newer than supported version 3/);
  });

  it("writes a pre-migration backup when upgrading and keeps at most 5", () => {
    const p = paths();
    const all = loadMigrations();
    Store.open(p.db, p.backups, { migrations: all.slice(0, 1) }).close();
    expect(fs.existsSync(p.backups)).toBe(false); // fresh DB: no backup
    Store.open(p.db, p.backups).close(); // 1 -> 3 upgrade
    const files = fs.readdirSync(p.backups);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^dealsonar-pre-v0002-\d+\.db$/);

    for (let i = 0; i < 8; i += 1) {
      const raw = new Database(p.db);
      raw.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
      raw.exec("DROP TABLE follow_up_deliveries; DROP INDEX idx_leads_read; DROP INDEX idx_leads_follow_up; ALTER TABLE leads DROP COLUMN read_at;");
      raw.close();
      Store.open(p.db, p.backups).close();
    }
    expect(fs.readdirSync(p.backups).length).toBeLessThanOrEqual(5);
  });

  it("upgrades a v1 database preserving data and rewriting feedback expected_match", () => {
    const p = paths();
    const all = loadMigrations();
    const v1 = Store.open(p.db, p.backups, { migrations: all.slice(0, 1) });
    seedLead(v1);
    v1.db.exec(`
      INSERT INTO feedback VALUES ('F1','E1','V1','P1','correct',NULL,'t','user',1);
      INSERT INTO feedback VALUES ('F2','E1','V1','P1','missed',NULL,'t','user',2);
      INSERT INTO feedback VALUES ('F3','E1','V1','P1','wrong',NULL,'t','user',3);
      UPDATE leads SET status = 'contacted' WHERE id = 'L1';
    `);
    v1.close();
    const v3 = Store.open(p.db, p.backups);
    const fb = v3.db.prepare("SELECT id, expected_match FROM feedback ORDER BY id").all();
    expect(fb).toEqual([
      { id: "F1", expected_match: 1 }, // label 'correct' with NULL verdict -> COALESCE(NULL, 1)
      { id: "F2", expected_match: 1 }, // 'missed'
      { id: "F3", expected_match: 0 }, // anything else
    ]);
    const lead = v3.db.prepare("SELECT status, read_at FROM leads WHERE id='L1'").get() as {
      status: string;
      read_at: number | null;
    };
    expect(lead.status).toBe("contacted");
    expect(lead.read_at).toBe(1);
    v3.close();
  });
});

describe("text helpers (Rust parity vectors)", () => {
  it("foldVi folds diacritics, đ, case and whitespace", () => {
    expect(foldVi("  Đống  Đa,\tHà Nội ")).toBe("dong da, ha noi");
    expect(foldVi("Cầu Giấy")).toBe("cau giay");
    expect(foldVi("e\u0301")).toBe("e"); // combining marks dropped
    expect(foldVi("a\u0085b")).toBe("a b"); // Rust White_Space includes U+0085
    expect(foldVi("a\ufeffb")).toBe("a\ufeffb"); // but not U+FEFF
  });

  it("dealsonar_fold_contains matches in SQL", () => {
    const store = Store.openInMemory();
    const q = (h: unknown, n: unknown) =>
      (store.db.prepare("SELECT dealsonar_fold_contains(?, ?) AS r").get(h, n) as { r: number }).r;
    expect(q("Chung cư Cầu Giấy", "cau giay")).toBe(1);
    expect(q("Chung cư", "")).toBe(1);
    expect(q("Chung cư", "nhà")).toBe(0);
    expect(q(null, "x")).toBe(0);
    expect(q("x", null)).toBe(0);
    store.close();
  });

  it("buildFts5Query sanitizes and expands d/đ", () => {
    expect(buildFts5Query("Cầu Giấy")).toBe('"cầu"* AND "giấy"*');
    expect(buildFts5Query("Đống Đa")).toBe('("dống"* OR "đống"*) AND ("da"* OR "đa"*)');
    expect(buildFts5Query('  "--*" ')).toBeNull();
    expect(buildFts5Query("dd dd dd dd")).toContain("AND");
    expect(buildFts5Query("a b c d e f g h i j k l m n o p q r s")!.split(" AND ")).toHaveLength(16);
  });

  it("extracts Vietnamese phones like the Rust light extractor", () => {
    expect(extractE164PhonesLight("Liên hệ 0912 345 678 hoặc 091-234-5679")).toEqual(["+84912345678", "+84912345679"]);
    expect(extractE164PhonesLight("call +84 912.345.678 now")).toEqual(["+84912345678"]);
    expect(extractE164PhonesLight("0912345678901")).toEqual([]); // trailing digits: not a phone
    expect(extractE164PhonesLight("O912345678")).toEqual(["+84912345678"]);
    expect(extractE164PhonesLight("0212 3456 789")).toEqual(["+842123456789"]);
    expect(extractE164PhonesLight("0112345678")).toEqual([]);
  });

  it("validates field keys", () => {
    expect(isValidFieldKey("price_vnd")).toBe(true);
    expect(isValidFieldKey("Price")).toBe(false);
    expect(isValidFieldKey("1a")).toBe(false);
    expect(isValidFieldKey("a".repeat(31))).toBe(true);
    expect(isValidFieldKey("a".repeat(32))).toBe(false);
  });

  it("simhash bands and hamming use unsigned 64-bit semantics", () => {
    expect(simhashBands(-1n)).toEqual([0xffff, 0xffff, 0xffff, 0xffff]);
    expect(simhashBands(0x1234_5678_9abc_def0n)).toEqual([0xdef0, 0x9abc, 0x5678, 0x1234]);
    expect(hammingDistance(-1n, 0n)).toBe(64);
    expect(hammingDistance(5n, 3n)).toBe(2);
  });

  it("converts unix days to civil dates", () => {
    expect(unixDayToYmd(0)).toBe("1970-01-01");
    expect(unixDayToYmd(19_723)).toBe("2024-01-01");
    expect(unixDayToYmd(19_782)).toBe("2024-02-29");
    expect(unixDayToYmd(-1)).toBe("1969-12-31");
  });

  it("generates sortable 26-char ULIDs", () => {
    const ids = Array.from({ length: 50 }, () => newUlid());
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("NotifyConfig serde parity", () => {
  it("applies defaults, drops unknown keys and keeps struct order", () => {
    const cfg = normalizeNotifyConfig({ channel_ids: ["c1"], extra: 1 });
    expect(JSON.stringify(cfg)).toBe(
      '{"channel_ids":["c1"],"mode":"instant","min_score":0.6,"quiet_hours":null}',
    );
    const full = normalizeNotifyConfig({
      lead_ttl_hours: 24,
      inherit_channels: false,
      quiet_hours: { from: "22:00", to: "07:00" },
      min_score: 0.8,
      mode: "digest",
    });
    expect(Object.keys(full)).toEqual(["channel_ids", "inherit_channels", "mode", "min_score", "quiet_hours", "lead_ttl_hours"]);
  });
});

describe("jobs", () => {
  it("dedups live jobs, claims by due time, retries and recovers stale", () => {
    const store = Store.openInMemory();
    const [a, createdA] = store.jobs.enqueue("evaluate_batch", "k", { n: 1 }, 100, 50);
    const [b, createdB] = store.jobs.enqueue("evaluate_batch", "k", { n: 2 }, 100, 51);
    expect(createdA).toBe(true);
    expect(createdB).toBe(false);
    expect(b.id).toBe(a.id);
    expect(store.jobs.claimDue(99)).toBeNull();
    const claimed = store.jobs.claimDue(100)!;
    expect(claimed).toMatchObject({ id: a.id, state: "running", attempts: 1, locked_at: 100 });
    expect(store.jobs.claimDue(1000)).toBeNull();

    const retried = store.jobs.failOrRetry(a.id, "boom", 500);
    expect(retried).toMatchObject({ state: "queued", run_at: 500, locked_at: null, error: "boom" });
    store.jobs.claimDue(600);
    expect(store.jobs.recoverStaleRunning(600, 700)).toBe(1);
    expect(store.jobs.get(a.id)).toMatchObject({ state: "queued", run_at: 700 });
    store.jobs.claimDue(700);
    expect(store.jobs.failOrRetry(a.id, "dead", null).state).toBe("failed");
    // a failed job no longer holds the dedup slot
    expect(store.jobs.enqueue("evaluate_batch", "k", {}, 0, 800)[1]).toBe(true);
    expect(() => store.jobs.failOrRetry("missing", "x", null)).toThrowError(/job not found: missing/);
    store.close();
  });

  it("matches the documented retry schedule", () => {
    expect(defaultJobRetryDelayMs("evaluate_batch", 3)).toBe(900_000);
    expect(defaultJobRetryDelayMs("evaluate_batch", 4)).toBeNull();
    expect(defaultJobRetryDelayMs("notify_lead", 5)).toBe(600_000);
    expect(defaultJobRetryDelayMs("suggest_fields", 1)).toBe(5_000);
    expect(defaultJobRetryDelayMs("compile_ruleset", 2)).toBeNull();
    expect(defaultJobRetryDelayMs("other", 1)).toBeNull();
  });
});

describe("channels and outbox", () => {
  it("validates channels and rewrites radars.notify on delete", () => {
    const store = Store.openInMemory();
    const ch = store.channels.create("telegram", "TG", { chat: 1 }, 10);
    expect(() => store.channels.create("sms", "x", {}, 1)).toThrowError(/invalid channel kind 'sms'/);
    expect(() => store.channels.setState(ch.id, "bad")).toThrowError(/invalid channel state 'bad'/);
    store.db
      .prepare("INSERT INTO radars (id, name, notify, created_at, updated_at) VALUES ('R1','r',?,1,1)")
      .run(JSON.stringify({ channel_ids: [ch.id, "other"], mode: "instant", min_score: 0.6, quiet_hours: null }));
    expect(store.channels.delete(ch.id)).toBe(true);
    const notify = JSON.parse((store.db.prepare("SELECT notify FROM radars").get() as { notify: string }).notify);
    expect(notify).toEqual({
      channel_ids: ["other"],
      inherit_channels: false,
      mode: "instant",
      min_score: 0.6,
      quiet_hours: null,
    });
    store.close();
  });

  it("claims with a 60s lease, marks sent with lead event, and retries/drops", () => {
    const store = Store.openInMemory();
    seedLead(store);
    const ch = store.channels.create("webhook", "W", { url: "https://example.test" }, 1);
    const item = store.outbox.enqueue({ channel_id: ch.id, lead_id: "L1", kind: "lead", payload: { a: 1 }, next_try_at: 100, now_ms: 100 });
    expect(() => store.outbox.enqueue({ channel_id: ch.id, kind: "bogus", payload: {}, next_try_at: 0, now_ms: 0 })).toThrowError(/invalid outbox kind/);
    expect(store.outbox.claimDue(99)).toBeNull();
    const claimed = store.outbox.claimDue(100)!;
    expect(claimed).toMatchObject({ id: item.id, attempts: 1, next_try_at: 60_100 });
    expect(store.outbox.claimDue(101)).toBeNull();

    const retried = store.outbox.retryOrDrop(item.id, "net", 200_000, 5, 7_200_000, 1000);
    expect(retried).toMatchObject({ state: "pending", next_try_at: 200_000, error: "net" });
    expect(store.outbox.retryOrDrop(item.id, "net", null, 5, 7_200_000, 1000).state).toBe("failed");
    expect(store.outbox.retryOrDrop(item.id, "old", 5, 5, 1000, 100_000).state).toBe("dropped");

    expect(store.outbox.markSent(item.id, "m1", 5000)).toBe(true);
    expect(store.outbox.markSent("nope", null, 1)).toBe(false);
    const lead = store.db.prepare("SELECT notified_at, updated_at FROM leads WHERE id='L1'").get();
    expect(lead).toEqual({ notified_at: 5000, updated_at: 5000 });
    const ev = store.db.prepare("SELECT kind, data FROM lead_events").get() as { kind: string; data: string };
    expect(ev.kind).toBe("notified");
    expect(JSON.parse(ev.data)).toEqual({ channel_id: ch.id, remote_id: "m1" });

    store.channels.setState(ch.id, "error");
    const again = store.outbox.enqueue({ channel_id: ch.id, kind: "system", payload: {}, next_try_at: 0, now_ms: 0 });
    expect(again.state).toBe("pending");
    expect(store.outbox.claimDue(10)).toBeNull(); // unhealthy channel
    store.close();
  });
});

describe("ai usage and settings", () => {
  it("aggregates per UTC day and fills empty days", () => {
    const store = Store.openInMemory();
    const day = 86_400_000;
    const now = 20_000 * day + 5000;
    store.aiCalls.record({ provider: "codex", task: "eval", item_count: 3, input_tokens: 10, output_tokens: 5, cost_usd: 0.5, duration_ms: 1, status: "ok", now_ms: now });
    store.aiCalls.record({ provider: "codex", task: "eval", item_count: 2, duration_ms: 1, status: "ok", now_ms: now - day });
    const rep = store.aiCalls.usage(3, now);
    expect(rep.days.map((d) => d.date)).toEqual([unixDayToYmd(19_998), unixDayToYmd(19_999), unixDayToYmd(20_000)]);
    expect(rep.days.map((d) => d.calls)).toEqual([0, 1, 1]);
    expect(rep.total_items).toBe(5);
    expect(rep.total_input_tokens).toBe(10);
    expect(rep.total_cost_usd).toBeCloseTo(0.5);
    expect(store.aiCalls.countItemsToday(now)).toBe(3);
    expect(store.aiCalls.usage(0, now).days).toHaveLength(1);
    expect(store.aiCalls.usage(9999, now).days).toHaveLength(365);
    store.close();
  });

  it("round-trips typed settings sorted by key", () => {
    const store = Store.openInMemory();
    expect(store.settings.get("x")).toBeNull();
    store.settings.set("b", { n: 1 });
    store.settings.set("a", [1, 2]);
    store.settings.set("a", [3]);
    expect(store.settings.get("a")).toEqual([3]);
    expect(Object.keys(store.settings.getAll())).toEqual(["a", "b"]);
    expect(store.settings.delete("a")).toBe(true);
    expect(store.settings.delete("a")).toBe(false);
    store.close();
  });
});

describe("backup, restore, purge, delete", () => {
  it("takes an online backup that opens as a valid store", async () => {
    const p = paths();
    const store = Store.open(p.db, p.backups);
    store.settings.set("k", 1);
    const dest = path.join(tmp, "out", "b.sqlite3");
    await store.backupDatabase(dest);
    store.close();
    const copy = Store.open(dest, path.join(tmp, "bk"));
    expect(copy.settings.get("k")).toBe(1);
    copy.close();
  });

  it("stages and applies a restore, dropping the outbound queue and erroring channels", () => {
    const p = paths();
    const dataDir = path.dirname(p.db);
    const src = Store.open(path.join(tmp, "src.db"), path.join(tmp, "srcbk"));
    seedLead(src);
    const ch = src.channels.create("webhook", "W", { url: "https://example.test" }, 1);
    src.outbox.enqueue({ channel_id: ch.id, kind: "system", payload: {}, next_try_at: 0, now_ms: 0 });
    src.settings.set("restored", true);
    src.close();

    const live = Store.open(p.db, p.backups);
    live.settings.set("live", true);
    live.close();

    Store.stageRestore(path.join(tmp, "src.db"), dataDir);
    expect(fs.existsSync(path.join(dataDir, "restore-pending.sqlite3"))).toBe(true);
    Store.applyPendingRestore(p.db, p.backups);
    expect(fs.existsSync(path.join(dataDir, "restore-pending.sqlite3"))).toBe(false);
    expect(fs.readdirSync(p.backups).some((f) => f.startsWith("before-restore-"))).toBe(true);

    const restored = Store.open(p.db, p.backups);
    expect(restored.settings.get("restored")).toBe(true);
    expect(restored.settings.get("live")).toBeNull();
    expect((restored.db.prepare("SELECT state FROM outbox").get() as { state: string }).state).toBe("dropped");
    expect((restored.db.prepare("SELECT state FROM channels").get() as { state: string }).state).toBe("error");
    restored.close();
  });

  it("rejects an invalid restore source", () => {
    const bad = path.join(tmp, "bad.db");
    const raw = new Database(bad);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER, name TEXT, applied_at INTEGER); INSERT INTO schema_migrations VALUES (9,'x',1);");
    raw.close();
    expect(() => Store.stageRestore(bad, tmp)).toThrowError(/Phiên bản bản sao lưu không tương thích/);
  });

  it("purges expired content per retention rules but keeps hashes", () => {
    const store = Store.openInMemory();
    const day = 86_400_000;
    const now = 100 * day;
    store.db.exec(`
      INSERT INTO sources (id, external_id, name, url, created_at) VALUES ('S1','g1','G','u',1);
      INSERT INTO authors (id, platform, external_id, name, first_seen_at, last_seen_at) VALUES ('A1','facebook','a','n',1,1);
      INSERT INTO posts (id, platform, external_id, source_id, author_id, permalink, text, text_norm, text_fold, content_hash, simhash, captured_at, strategy)
        VALUES ('OLD','facebook','1','S1','A1','p','t','t','t','hash',7,${now - 40 * day},'s');
      INSERT INTO posts (id, platform, external_id, source_id, permalink, text, content_hash, simhash, captured_at, strategy)
        VALUES ('NEW','facebook','2','S1','p','t','hash2',8,${now - day},'s');
      INSERT INTO jobs (id, kind, payload, state, run_at, created_at) VALUES ('J1','k','{}','done',0,${now - 20 * day});
    `);
    const report = store.purgeExpired(now, 30);
    expect(report).toMatchObject({ posts_purged: 1, jobs_deleted: 1, authors_deleted: 1 });
    const old = store.db.prepare("SELECT text, content_hash, simhash, purged_at, author_id FROM posts WHERE id='OLD'").get();
    expect(old).toEqual({ text: null, content_hash: "hash", simhash: 7, purged_at: now, author_id: null });
    expect((store.db.prepare("SELECT text FROM posts WHERE id='NEW'").get() as { text: string }).text).toBe("t");
    store.verifyFtsIntegrity();
    store.close();
  });

  it("deletes all data, rebuilds FTS and clears backups", () => {
    const p = paths();
    const store = Store.open(p.db, p.backups);
    seedLead(store);
    store.settings.set("k", 1);
    fs.mkdirSync(p.backups, { recursive: true });
    fs.writeFileSync(path.join(p.backups, "x.db"), "x");
    store.deleteAllData();
    const counts = store.tableRowCounts();
    for (const [table, n] of Object.entries(counts)) {
      if (table !== "schema_migrations") expect(n, table).toBe(0);
    }
    expect(counts.schema_migrations).toBe(3);
    expect(fs.readdirSync(p.backups)).toEqual([]);
    store.verifyFtsIntegrity();
    store.close();
    Store.destroyFiles(p.db, p.backups);
    expect(fs.existsSync(p.db)).toBe(false);
  });
});
