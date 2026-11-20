// Port of crates/store/src/lib.rs on better-sqlite3.
//
// Differences from the Rust crate that are intentional:
//  * better-sqlite3 is synchronous and single-connection inside the data-owner process, so the
//    Rust `Mutex<Connection>` is not needed.
//  * Pre-migration backups and restore staging run before the process serves requests, so they
//    use the synchronous `VACUUM INTO` snapshot. Runtime `backupDatabase` uses SQLite's online
//    backup API (`db.backup`) so it does not block writers.

import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StoreError } from "./errors";
import { openDatabase } from "./sqlite";
import { foldVi, nowMs } from "./util";
import { Blocklist, Contacts } from "./contacts";
import { Leads } from "./leads";
import { Posts } from "./posts";
import { Radars } from "./radars";
import { Sources } from "./sources";
import {
  AiCalls,
  Channels,
  Jobs,
  Outbox,
  Settings,
  type PurgeReport,
  type SchemaMigrationRecord,
} from "./ops";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_DEFS: ReadonlyArray<{ version: number; name: string }> = [
  { version: 1, name: "0001_init" },
  { version: 2, name: "0002_durable_feedback" },
  { version: 3, name: "0003_workflow" },
];

export const LATEST_SCHEMA_VERSION = 3;
export const MAX_PRE_MIGRATION_BACKUPS = 5;

/**
 * Locate the retained SQL migrations. Search order: `DEALSONAR_MIGRATIONS_DIR`, `migrations/` next
 * to the bundled `main.cjs` (`__dirname`), then the package checkout (`../../migrations` from this
 * file). The first directory containing `0001_init.sql` wins.
 */
export function defaultMigrationsDir(): string {
  const candidates: string[] = [];
  if (process.env.DEALSONAR_MIGRATIONS_DIR) candidates.push(process.env.DEALSONAR_MIGRATIONS_DIR);
  if (typeof __dirname !== "undefined") candidates.push(path.join(__dirname, "migrations"));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations"));
  } catch {
    // `import.meta.url` is undefined in the CJS bundle.
  }
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, "0001_init.sql")));
  if (!found) throw new Error(`SQL migrations not found (searched: ${candidates.join(", ")})`);
  return found;
}

/** Load the canonical migrations (0001-0003) byte-for-byte from `dir`. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  return MIGRATION_DEFS.map((m) => ({
    ...m,
    sql: fs.readFileSync(path.join(dir, `${m.name}.sql`), "utf8"),
  }));
}

export interface StoreOpenOptions {
  migrations?: Migration[];
}

const DAY_MS = 86_400_000;

const APP_TABLES = [
  "ai_calls",
  "authors",
  "blocklist",
  "channels",
  "contacts",
  "crawl_runs",
  "dup_clusters",
  "evaluations",
  "feedback",
  "jobs",
  "lead_events",
  "leads",
  "outbox",
  "posts",
  "radar_sources",
  "radar_versions",
  "radars",
  "rulesets",
  "schema_migrations",
  "settings",
  "sources",
] as const;

export class Store {
  readonly db: Database.Database;
  readonly dbPath: string | null;
  readonly backupDir: string | null;

  readonly jobs: Jobs;
  readonly channels: Channels;
  readonly outbox: Outbox;
  readonly aiCalls: AiCalls;
  readonly settings: Settings;
  readonly sources: Sources;
  readonly posts: Posts;
  readonly leads: Leads;
  readonly contacts: Contacts;
  readonly blocklist: Blocklist;
  readonly radars: Radars;

  private constructor(db: Database.Database, dbPath: string | null, backupDir: string | null) {
    this.db = db;
    this.dbPath = dbPath;
    this.backupDir = backupDir;
    this.jobs = new Jobs(db);
    this.channels = new Channels(db);
    this.outbox = new Outbox(db);
    this.aiCalls = new AiCalls(db);
    this.settings = new Settings(db);
    this.sources = new Sources(db);
    this.posts = new Posts(db);
    this.leads = new Leads(db);
    this.contacts = new Contacts(db);
    this.blocklist = new Blocklist(db);
    this.radars = new Radars(db);
  }

  /** In-memory store with all migrations applied. */
  static openInMemory(options: StoreOpenOptions = {}): Store {
    const db = openDatabase(":memory:");
    configureConnection(db);
    applyMigrations(db, null, options.migrations ?? loadMigrations());
    return new Store(db, null, null);
  }

  /**
   * File-backed store in WAL mode. Rejects newer schemas and writes an automatic pre-migration
   * backup before upgrading an existing non-empty database.
   */
  static open(dbPath: string, backupDir: string, options: StoreOpenOptions = {}): Store {
    const parent = path.dirname(dbPath);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    const db = openDatabase(dbPath);
    try {
      configureConnection(db);
      applyMigrations(db, backupDir, options.migrations ?? loadMigrations());
    } catch (err) {
      db.close();
      throw err;
    }
    return new Store(db, dbPath, backupDir);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Validate and freeze an external backup before scheduling offline restoration. */
  static stageRestore(source: string, dataDir: string): void {
    const src = openDatabase(source, { readonly: true, fileMustExist: true });
    try {
      validateRestoreConnection(src);
      const temporary = path.join(dataDir, "restore-staging.sqlite3");
      backupConnectionToPathSync(src, temporary);
      fs.renameSync(temporary, path.join(dataDir, "restore-pending.sqlite3"));
    } finally {
      src.close();
    }
  }

  /** Called before opening the live store or starting workers. Preserves a recovery backup. */
  static applyPendingRestore(dbPath: string, backups: string): void {
    const pending = path.join(path.dirname(dbPath), "restore-pending.sqlite3");
    if (!fs.existsSync(pending)) return;
    const src = openDatabase(pending, { readonly: true, fileMustExist: true });
    try {
      validateRestoreConnection(src);
      if (fs.existsSync(dbPath)) {
        const live = openDatabase(dbPath);
        try {
          fs.mkdirSync(backups, { recursive: true });
          backupConnectionToPathSync(live, path.join(backups, `before-restore-${nowMs()}.sqlite3`));
        } finally {
          live.close();
        }
      }
      backupConnectionToPathSync(src, dbPath);
      // Never replay a historical backup's outbound queue with current keychain credentials.
      const restored = openDatabase(dbPath);
      try {
        restored.prepare("UPDATE outbox SET state='dropped' WHERE state IN ('pending','failed')").run();
        restored.prepare("UPDATE channels SET state='error'").run();
      } finally {
        restored.close();
      }
    } finally {
      src.close();
    }
    fs.rmSync(pending);
  }

  listSchemaMigrations(): SchemaMigrationRecord[] {
    return this.db
      .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
      .all() as SchemaMigrationRecord[];
  }

  /** Current `PRAGMA journal_mode`, lowercased (`"wal"` for file-backed stores). */
  journalMode(): string {
    return String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
  }

  /** Online hot backup of the live database to `destPath` via SQLite's backup API. */
  async backupDatabase(destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) fs.rmSync(destPath);
    await this.db.backup(destPath);
  }

  /** Run FTS5 `integrity-check` on `posts_fts` and `leads_fts`. */
  verifyFtsIntegrity(): void {
    this.db.prepare("INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')").run();
    this.db.prepare("INSERT INTO leads_fts(leads_fts) VALUES ('integrity-check')").run();
  }

  /** Daily retention cleanup (04-data-model.md §5). */
  purgeExpired(now: number, unmatchedRetentionDays: number): PurgeReport {
    const postCutoff = now - unmatchedRetentionDays * DAY_MS;
    const cutoff90d = now - 90 * DAY_MS;
    const cutoff14d = now - 14 * DAY_MS;
    const db = this.db;

    const run = db.transaction((): PurgeReport => {
      const postsPurged = db
        .prepare(
          `UPDATE posts
           SET text = NULL, text_norm = NULL, text_fold = NULL, attachments = NULL,
               extracted_phones = NULL, purged_at = ?1
           WHERE purged_at IS NULL
             AND captured_at < ?2
             AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.post_id = posts.id)`,
        )
        .run(now, postCutoff).changes;

      const evaluationsScrubbed = db
        .prepare(
          `UPDATE evaluations
           SET summary = NULL, reason = NULL, fields = NULL
           WHERE post_id IN (SELECT id FROM posts WHERE purged_at IS NOT NULL)
             AND (summary IS NOT NULL OR reason IS NOT NULL OR fields IS NOT NULL)`,
        )
        .run().changes;

      const crawlRunsDeleted = db
        .prepare("DELETE FROM crawl_runs WHERE started_at < ?1")
        .run(cutoff90d).changes;

      db.prepare(
        `UPDATE evaluations SET ai_call_id = NULL
         WHERE ai_call_id IN (SELECT id FROM ai_calls WHERE created_at < ?1)`,
      ).run(cutoff90d);

      const aiCallsDeleted = db.prepare("DELETE FROM ai_calls WHERE created_at < ?1").run(cutoff90d).changes;

      const jobsDeleted = db
        .prepare("DELETE FROM jobs WHERE state IN ('done', 'failed') AND created_at < ?1")
        .run(cutoff14d).changes;

      const outboxDeleted = db
        .prepare(
          `DELETE FROM outbox
           WHERE state IN ('sent', 'dropped')
             AND COALESCE(sent_at, created_at) < ?1`,
        )
        .run(cutoff14d).changes;

      db.prepare(
        `UPDATE posts SET author_id = NULL
         WHERE author_id IS NOT NULL
           AND text IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM posts p2
             WHERE p2.author_id = posts.author_id AND p2.text IS NOT NULL
           )`,
      ).run();

      const authorsDeleted = db
        .prepare(
          `DELETE FROM authors
           WHERE NOT EXISTS (
             SELECT 1 FROM posts p WHERE p.author_id = authors.id AND p.text IS NOT NULL
           )`,
        )
        .run().changes;

      return {
        posts_purged: postsPurged,
        evaluations_scrubbed: evaluationsScrubbed,
        crawl_runs_deleted: crawlRunsDeleted,
        ai_calls_deleted: aiCallsDeleted,
        jobs_deleted: jobsDeleted,
        outbox_deleted: outboxDeleted,
        authors_deleted: authorsDeleted,
      };
    });
    return run();
  }

  /** Delete all user data and remove stored backups in `backupDir`. */
  deleteAllData(): void {
    const db = this.db;
    db.transaction(() => {
      for (const table of [
        "follow_up_deliveries",
        "jobs",
        "outbox",
        "blocklist",
        "feedback",
        "lead_events",
        "leads",
        "evaluations",
        "ai_calls",
        "rulesets",
        "radar_sources",
        "radar_versions",
        "radars",
        "posts",
        "crawl_runs",
        "sources",
        "authors",
        "dup_clusters",
        "contacts",
        "channels",
        "settings",
      ]) {
        db.exec(`DELETE FROM ${table}`);
      }
      db.exec("INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')");
      db.exec("INSERT INTO leads_fts(leads_fts) VALUES ('rebuild')");
    })();

    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    } catch {
      // best effort, like the Rust `let _ =`
    }

    if (this.backupDir && fs.existsSync(this.backupDir)) {
      for (const entry of fs.readdirSync(this.backupDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          try {
            fs.rmSync(path.join(this.backupDir, entry.name));
          } catch {
            // ignore
          }
        }
      }
    }
  }

  /** Remove `.db`, `-wal`, `-shm` and backup files after the Store is closed. */
  static destroyFiles(dbPath: string, backupDir: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${dbPath}${suffix}`;
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    }
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  }

  /** Row counts of all application tables for diagnostic bundles. */
  tableRowCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of APP_TABLES) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      counts[table] = row.c;
    }
    return counts;
  }
}

function configureConnection(db: Database.Database): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");

  // Deterministic Vietnamese diacritic-insensitive, case-insensitive substring matcher.
  db.function("dealsonar_fold_contains", { deterministic: true }, (haystack: unknown, needle: unknown) => {
    if (typeof haystack !== "string" || typeof needle !== "string") return 0;
    const nFold = foldVi(needle);
    if (nFold === "") return 1;
    return foldVi(haystack).includes(nFold) ? 1 : 0;
  });
}

function applyMigrations(db: Database.Database, backupDir: string | null, migrations: Migration[]): void {
  const latestKnown = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  const hasTable =
    (
      db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations') AS e",
        )
        .get() as { e: number }
    ).e === 1;
  const dbVersion = hasTable
    ? (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v
    : 0;

  if (dbVersion > latestKnown) throw StoreError.newerSchemaVersion(dbVersion, latestKnown);

  const pending = migrations.filter((m) => m.version > dbVersion).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  const userTables = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`,
      )
      .get() as { c: number }
  ).c;

  if ((dbVersion > 0 || userTables > 0) && backupDir) {
    createPreMigrationBackup(db, backupDir, pending[0].version);
    prunePreMigrationBackups(backupDir, MAX_PRE_MIGRATION_BACKUPS);
  }

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(
        m.version,
        m.name,
        nowMs(),
      );
    })();
  }
}

function createPreMigrationBackup(db: Database.Database, backupDir: string, nextVersion: number): string {
  fs.mkdirSync(backupDir, { recursive: true });
  let ts = nowMs();
  let dest: string;
  for (;;) {
    dest = path.join(backupDir, `dealsonar-pre-v${String(nextVersion).padStart(4, "0")}-${ts}.db`);
    if (!fs.existsSync(dest)) break;
    ts += 1;
  }
  backupConnectionToPathSync(db, dest);
  return dest;
}

function prunePreMigrationBackups(backupDir: string, keep: number): void {
  if (!fs.existsSync(backupDir)) return;
  const backups: Array<{ key: string; file: string }> = [];
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith("dealsonar-pre-v") && name.endsWith(".db")) {
      const stem = name.slice(0, -3);
      const tail = stem.slice(stem.lastIndexOf("-") + 1);
      const ts = /^\d+$/.test(tail) ? BigInt(tail) : 0n;
      backups.push({ key: `${ts.toString().padStart(20, "0")}-${name}`, file: path.join(backupDir, name) });
    }
  }
  backups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (backups.length > keep) {
    for (const old of backups.slice(0, backups.length - keep)) {
      try {
        fs.rmSync(old.file);
      } catch {
        // ignore
      }
    }
  }
}

/** Consistent snapshot of `src` into a fresh file at `destPath` (synchronous). */
function backupConnectionToPathSync(src: Database.Database, destPath: string): void {
  const parent = path.dirname(destPath);
  if (parent) fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(destPath)) fs.rmSync(destPath);
  src.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
}

function validateRestoreConnection(conn: Database.Database): void {
  const check = conn.pragma("integrity_check", { simple: true });
  if (check !== "ok") throw StoreError.invalidArgument("Bản sao lưu không toàn vẹn");
  const row = conn.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const version = row.v;
  if (version === null) throw new StoreError("sqlite", "SQLite error: Invalid column type Null at index: 0");
  if (version < 1 || version > LATEST_SCHEMA_VERSION) {
    throw StoreError.invalidArgument("Phiên bản bản sao lưu không tương thích");
  }
  for (const table of ["radars", "radar_versions", "leads", "posts", "sources", "settings", "channels"]) {
    conn.prepare(`SELECT * FROM ${table} LIMIT 0`);
  }
  const violations = (conn.prepare("SELECT COUNT(*) AS c FROM pragma_foreign_key_check").get() as { c: number }).c;
  if (violations > 0) throw StoreError.invalidArgument("Bản sao lưu có liên kết dữ liệu không hợp lệ");
}
