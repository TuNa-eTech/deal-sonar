import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Store, enableNumberedParameters, openDatabase, translateNumberedParams } from "../src";

describe("translateNumberedParams", () => {
  it("returns null for statements without numbered placeholders", () => {
    expect(translateNumberedParams("SELECT 1")).toBeNull();
    expect(translateNumberedParams("SELECT dealsonar_fold_contains(?, ?)")).toBeNull();
  });

  it("rewrites ?N to ? and records the argument order, repeats and holes", () => {
    const t = translateNumberedParams("INSERT INTO t VALUES (?1, ?2, ?5, ?5, ?2)")!;
    expect(t.sql).toBe("INSERT INTO t VALUES (?, ?, ?, ?, ?)");
    expect(t.order).toEqual([1, 2, 5, 5, 2]);
    expect(t.max).toBe(5); // ?3 and ?4 are holes: their arguments exist but are never bound
  });

  it("handles multi-digit numbers and keeps order across the statement", () => {
    const t = translateNumberedParams("SELECT ?12, ?1, ?10")!;
    expect(t.order).toEqual([12, 1, 10]);
    expect(t.max).toBe(12);
  });

  it("does not touch ? inside literals, quoted identifiers, brackets or comments", () => {
    const sql = `SELECT '?1', 'it''s ?2', "col?3", [x?4], \`y?5\`, ?1 -- ?6
      /* ?7 */ FROM t WHERE a = ?2 AND json_extract(f, '$.k') = ?3`;
    const t = translateNumberedParams(sql)!;
    expect(t.order).toEqual([1, 2, 3]);
    expect(t.sql).toContain(`'?1', 'it''s ?2', "col?3", [x?4], \`y?5\``);
    expect(t.sql).toContain("-- ?6");
    expect(t.sql).toContain("/* ?7 */");
    expect(t.sql).toContain("'$.k'");
  });

  it("rejects mixing anonymous and numbered parameters and ?0", () => {
    expect(() => translateNumberedParams("SELECT ?1, ?")).toThrow(/mixes anonymous/);
    expect(() => translateNumberedParams("SELECT ?0")).toThrow(/Invalid parameter number/);
  });
});

describe("openDatabase (numbered parameters on better-sqlite3)", () => {
  function db() {
    const d = openDatabase(":memory:");
    d.exec("CREATE TABLE t (a INTEGER, b TEXT, c TEXT)");
    return d;
  }

  it("binds positional arguments by placeholder number", () => {
    const d = db();
    d.prepare("INSERT INTO t (a, b, c) VALUES (?1, ?2, ?3)").run(1, "x", "y");
    d.prepare("INSERT INTO t (a, b, c) VALUES (?3, ?2, ?1)").run("c", "b", "9");
    expect(d.prepare("SELECT a, b, c FROM t ORDER BY rowid").all()).toEqual([
      { a: 1, b: "x", c: "y" },
      { a: 9, b: "b", c: "c" }, // '9' stored through INTEGER affinity
    ]);
    d.close();
  });

  it("supports repeated numbers", () => {
    const d = db();
    d.prepare("INSERT INTO t (a, b, c) VALUES (?1, ?2, ?2)").run(5, "same");
    expect(d.prepare("SELECT b, c FROM t").get()).toEqual({ b: "same", c: "same" });
    d.close();
  });

  it("supports holes and requires the argument count to equal the highest number (rusqlite rule)", () => {
    const d = db();
    expect(d.prepare("SELECT ?3 AS v").get("skip1", "skip2", "third")).toEqual({ v: "third" });
    expect(() => d.prepare("SELECT ?3 AS v").get("only", "two")).toThrow(
      "Wrong number of parameters passed to query. Got 2, needed 3",
    );
    // extra pushed-but-unreferenced arguments are an error, as in the Rust dynamic filter quirk
    expect(() => d.prepare("SELECT 1 + ?1 AS v").get(1, 2, 3)).toThrow(/Got 3, needed 1/);
    d.close();
  });

  it("leaves SQL literals intact", () => {
    const d = db();
    expect(d.prepare("SELECT '?1 and $.x' AS lit, ?1 AS v").get(7)).toEqual({ lit: "?1 and $.x", v: 7 });
    d.close();
  });

  it("works with get/all/iterate/run results and an array argument", () => {
    const d = db();
    const ins = d.prepare("INSERT INTO t (a, b) VALUES (?1, ?2)");
    expect(ins.run(1, "a").changes).toBe(1);
    expect(ins.run([2, "b"]).changes).toBe(1);
    const sel = d.prepare("SELECT a FROM t WHERE a >= ?1 ORDER BY a");
    expect(sel.all(1)).toEqual([{ a: 1 }, { a: 2 }]);
    expect([...sel.iterate(2)]).toEqual([{ a: 2 }]);
    expect(sel.get(3)).toBeUndefined();
    d.close();
  });

  it("keeps statement chaining (safeIntegers, pluck) and bigint binding", () => {
    const d = db();
    const stmt = d.prepare("SELECT ?1 AS v").safeIntegers(true);
    expect(stmt.get(-5n)).toEqual({ v: -5n });
    expect(d.prepare("SELECT ?1 + 1").pluck().get(41)).toBe(42);
    d.close();
  });

  it("works inside transactions and keeps anonymous statements untouched", () => {
    const d = db();
    d.transaction(() => {
      d.prepare("INSERT INTO t (a) VALUES (?1)").run(1);
      d.prepare("INSERT INTO t (a) VALUES (?)").run(2);
    })();
    expect(d.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 2 });
    d.close();
  });

  it("is idempotent", () => {
    const d = openDatabase(":memory:");
    const patched = d.prepare;
    enableNumberedParameters(d);
    expect(d.prepare).toBe(patched);
    expect(d.prepare("SELECT ?1 AS v").get(1)).toEqual({ v: 1 });
    d.close();
  });
});

describe("store integration", () => {
  it("runs numbered store statements end to end (migrations insert, settings, jobs)", () => {
    const store = Store.openInMemory();
    expect(store.listSchemaMigrations()).toHaveLength(3);
    store.settings.set("k", { n: 1 });
    expect(store.settings.get("k")).toEqual({ n: 1 });
    const [job, created] = store.jobs.enqueue("evaluate_batch", "d", {}, 1, 1);
    expect(created).toBe(true);
    expect(store.jobs.get(job.id)?.dedup_key).toBe("d");
    store.close();
  });

  it("never opens a connection that bypasses the translator", () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && entry.name !== "sqlite.ts") {
          if (/new\s+Database\s*\(/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

});
