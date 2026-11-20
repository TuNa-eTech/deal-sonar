// rusqlite-style numbered parameters on better-sqlite3.
//
// The Rust store writes `?1, ?2, ...` and passes a positional slice. SQLite itself accepts that,
// but better-sqlite3 reports `?NNN` as a *named* parameter and then rejects positional arguments.
// Rather than rewriting every statement, connections opened through `openDatabase` translate each
// numbered statement once at prepare time:
//
//   SQL    `... VALUES (?1, ?2, ?1) ... ?5 ...`  ->  `... VALUES (?, ?, ?) ... ? ...`
//   args   [a, b, c, d, e]                       ->  [a, b, a, e]       (reordered by placeholder number)
//
// Semantics deliberately match rusqlite:
//   * a number may repeat (`?5, ?5` binds the same argument twice);
//   * holes are allowed (an argument whose number is never referenced is ignored), but the argument
//     count must equal the highest referenced number, otherwise it throws
//     "Wrong number of parameters passed to query. Got X, needed Y" (this reproduces the Rust
//     behaviour for dynamic SQL that pushes more parameters than it references);
//   * `?` inside string literals, quoted identifiers, `[..]`, backticks and comments is not a
//     placeholder, so SQL literals such as '$.min_score' or 'what?1' are untouched.
// Statements without numbered placeholders are returned untouched (anonymous `?` keeps working).
// Mixing `?` and `?N` in one statement is rejected: SQLite's own numbering rules for the mix are
// confusing and the Rust code never does it.

import Database from "better-sqlite3";

export interface TranslatedSql {
  /** SQL with every `?N` replaced by an anonymous `?`. */
  sql: string;
  /** `order[k]` = 1-based argument number bound to the k-th anonymous placeholder. */
  order: number[];
  /** Highest placeholder number referenced (what rusqlite calls the parameter count). */
  max: number;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** Returns `null` when the statement has no numbered placeholders. */
export function translateNumberedParams(sql: string): TranslatedSql | null {
  let out = "";
  const order: number[] = [];
  let bare = false;
  let max = 0;
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const c = sql[i];

    if (c === "'" || c === '"' || c === "`") {
      // Quoted text/identifier; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j += 1;
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "?") {
      let j = i + 1;
      while (isDigit(sql[j])) j += 1;
      if (j > i + 1) {
        const num = Number(sql.slice(i + 1, j));
        if (num < 1) throw new RangeError(`Invalid parameter number in SQL: ${sql.slice(i, j)}`);
        order.push(num);
        if (num > max) max = num;
        out += "?";
      } else {
        bare = true;
        out += "?";
      }
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }

  if (order.length === 0) return null;
  if (bare) {
    throw new RangeError("SQL mixes anonymous (?) and numbered (?N) parameters; use one style per statement");
  }
  return { sql: out, order, max };
}

/** Methods that take bound parameters. `bind()` is not supported on translated statements. */
const BINDING_METHODS = new Set<PropertyKey>(["run", "get", "all", "iterate"]);

function remap(args: unknown[], t: TranslatedSql): unknown[] {
  // better-sqlite3 also accepts one array of parameters.
  const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (list.length !== t.max) {
    throw new RangeError(`Wrong number of parameters passed to query. Got ${list.length}, needed ${t.max}`);
  }
  return t.order.map((num) => list[num - 1]);
}

function wrapStatement(stmt: Database.Statement, t: TranslatedSql): Database.Statement {
  const proxy: Database.Statement = new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (BINDING_METHODS.has(prop)) {
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, remap(args, t));
      }
      if (prop === "bind") {
        return () => {
          throw new TypeError("bind() is not supported on statements with numbered parameters");
        };
      }
      // safeIntegers/pluck/raw/expand return the statement itself; keep chaining on the proxy.
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

const CACHE_LIMIT = 512;

/**
 * Patches `db.prepare` so numbered parameters work. Idempotent per connection. Everything that
 * prepares through this connection (repositories, `db.transaction(...)` bodies, tests that use
 * `store.db.prepare`) gets the behaviour.
 */
export function enableNumberedParameters(db: Database.Database): Database.Database {
  const marker = "__numberedParams";
  if ((db as unknown as Record<string, unknown>)[marker]) return db;
  const original = db.prepare.bind(db) as (sql: string) => Database.Statement;
  const cache = new Map<string, TranslatedSql | null>();

  const prepare = (sql: string): Database.Statement => {
    let translated = cache.get(sql);
    if (translated === undefined) {
      translated = translateNumberedParams(sql);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(sql, translated);
    }
    return translated === null ? original(sql) : wrapStatement(original(translated.sql), translated);
  };

  Object.defineProperty(db, "prepare", { value: prepare, configurable: true, writable: true });
  Object.defineProperty(db, marker, { value: true });
  return db;
}

/** Open a better-sqlite3 connection with numbered-parameter support. */
export function openDatabase(file: string, options?: Database.Options): Database.Database {
  return enableNumberedParameters(new Database(file, options));
}
