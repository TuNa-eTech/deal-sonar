// Port of `StoreError` (crates/store/src/lib.rs). Display strings are kept identical because the
// desktop layer forwards them to the UI as error messages.

export type StoreErrorKind =
  | "sqlite"
  | "json"
  | "io"
  | "newer_schema_version"
  | "invalid_field_key"
  | "unknown_radar_field"
  | "invalid_filter_value"
  | "invalid_argument"
  | "not_found"
  | "lock_poisoned";

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly detail: Record<string, unknown>;

  constructor(kind: StoreErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    this.detail = detail;
  }

  static invalidArgument(message: string): StoreError {
    return new StoreError("invalid_argument", `invalid argument: ${message}`, { message });
  }

  static notFound(entity: string, id: string): StoreError {
    return new StoreError("not_found", `${entity} not found: ${id}`, { entity, id });
  }

  static newerSchemaVersion(dbVersion: number, appVersion: number): StoreError {
    return new StoreError(
      "newer_schema_version",
      `database schema version ${dbVersion} is newer than supported version ${appVersion}; please update DealSonar`,
      { dbVersion, appVersion },
    );
  }

  static invalidFieldKey(key: string): StoreError {
    return new StoreError("invalid_field_key", `invalid dynamic field key '${key}'`, { key });
  }

  static unknownRadarField(radarId: string | null, field: string): StoreError {
    // Rust `{:?}` of Option<String>.
    const dbg = radarId === null ? "None" : `Some(${JSON.stringify(radarId)})`;
    return new StoreError("unknown_radar_field", `unknown field '${field}' for radar ${dbg}`, {
      radarId,
      field,
    });
  }

  static invalidFilterValue(field: string, op: string, message: string): StoreError {
    return new StoreError(
      "invalid_filter_value",
      `invalid filter value for field '${field}' (${op}): ${message}`,
      { field, op, message },
    );
  }
}

/** Map native errors (better-sqlite3, JSON, fs) onto the Rust `StoreError` display strings. */
export function toStoreError(err: unknown): StoreError {
  if (err instanceof StoreError) return err;
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (typeof e?.code === "string" && e.code.startsWith("SQLITE_")) {
    return new StoreError("sqlite", `SQLite error: ${message}`, { code: e.code });
  }
  if (err instanceof SyntaxError || (err as { name?: unknown })?.name === "DomainShapeError") {
    return new StoreError("json", `JSON serialization error: ${message}`);
  }
  if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) {
    return new StoreError("io", `I/O error: ${message}`, { code: e.code });
  }
  return new StoreError("sqlite", `SQLite error: ${message}`);
}
