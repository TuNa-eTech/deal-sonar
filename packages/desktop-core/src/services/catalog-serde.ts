// Typed JSON decoders that reproduce the serde behaviour the Rust desktop dispatcher relied on:
// `parse_arg` / `parse_opt_arg` (apps/desktop/src/commands/dispatch.rs) deserialize each argument
// with serde, so a wrong shape produces `tham số '<key>' không hợp lệ: <serde message>`.
//
// A decoder returns a fresh, normalized value (defaults filled, unknown keys dropped) and throws
// `SerdeError` with the serde_json message text. `parseArg`/`parseOptArg` wrap that in the
// `CommandError("validation_error", ...)` the UI already displays.

import { CommandError } from "../backend/wire";

export class SerdeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerdeError";
  }
}

export type Decoder<T> = (value: unknown) => T;
export type PlainObject = Record<string, unknown>;

/** serde_json `Unexpected` display. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  return "map";
}

export const typeError = (value: unknown, expected: string): SerdeError =>
  new SerdeError(`invalid type: ${describe(value)}, expected ${expected}`);

export const isPlainObject = (v: unknown): v is PlainObject => typeof v === "object" && v !== null && !Array.isArray(v);

const hasOwn = (o: PlainObject, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

export const dString: Decoder<string> = (v) => {
  if (typeof v !== "string") throw typeError(v, "a string");
  return v;
};

export const dBool: Decoder<boolean> = (v) => {
  if (typeof v !== "boolean") throw typeError(v, "a boolean");
  return v;
};

/** `serde_json::Value`: anything, with an absent value treated as `null`. */
export const dAny: Decoder<unknown> = (v) => (v === undefined ? null : v);

export const dF64: Decoder<number> = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw typeError(v, "f64");
  return v;
};

function integer(name: string, min: number, max: number): Decoder<number> {
  return (v) => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw typeError(v, name);
    if (v < min || v > max) throw new SerdeError(`invalid value: integer \`${v}\`, expected ${name}`);
    return v;
  };
}

export const dI64: Decoder<number> = integer("i64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
export const dI32: Decoder<number> = integer("i32", -2_147_483_648, 2_147_483_647);
export const dU32: Decoder<number> = integer("u32", 0, 4_294_967_295);
export const dUsize: Decoder<number> = integer("usize", 0, Number.MAX_SAFE_INTEGER);

/** `Option<T>`: `null`/absent become `null`. */
export const dOption =
  <T>(inner: Decoder<T>): Decoder<T | null> =>
  (v) =>
    v === null || v === undefined ? null : inner(v);

export const dVec =
  <T>(inner: Decoder<T>): Decoder<T[]> =>
  (v) => {
    if (!Array.isArray(v)) throw typeError(v, "a sequence");
    return v.map((item) => inner(item));
  };

/** `BTreeMap<String, T>`: keys come back sorted. */
export const dMap =
  <T>(inner: Decoder<T>): Decoder<Record<string, T>> =>
  (v) => {
    if (!isPlainObject(v)) throw typeError(v, "a map");
    const out: Record<string, T> = {};
    for (const key of Object.keys(v).sort()) out[key] = inner(v[key]);
    return out;
  };

/** Unit-variant enum with `rename_all = "snake_case"` already applied to `variants`. */
export function dEnum<T extends string>(variants: readonly T[]): Decoder<T> {
  return (v) => {
    if (typeof v !== "string") throw typeError(v, "string or map");
    if (!(variants as readonly string[]).includes(v)) {
      const list = variants.map((x) => `\`${x}\``).join(", ");
      throw new SerdeError(`unknown variant \`${v}\`, expected ${variants.length === 1 ? list : `one of ${list}`}`);
    }
    return v as T;
  };
}

export interface Field<T> {
  read(obj: PlainObject, key: string): T;
}

/** Required field (no `Option`, no `#[serde(default)]`). */
export const req = <T>(dec: Decoder<T>): Field<T> => ({
  read(obj, key) {
    if (!hasOwn(obj, key)) throw new SerdeError(`missing field \`${key}\``);
    return dec(obj[key]);
  },
});

/** `Option<T>` field: absent or `null` is `null`. */
export const opt = <T>(dec: Decoder<T>): Field<T | null> => ({
  read: (obj, key) => (hasOwn(obj, key) ? dOption(dec)(obj[key]) : null),
});

/** `#[serde(default = ...)]` field. */
export const withDefault = <T>(dec: Decoder<T>, make: () => T): Field<T> => ({
  read: (obj, key) => (hasOwn(obj, key) ? dec(obj[key]) : make()),
});

/**
 * `Option<Option<T>>` with `#[serde(default, with = "double_option")]`: absent is `undefined`
 * (keep), explicit `null` is `null` (clear), otherwise the decoded value.
 */
export const doubleOpt = <T>(dec: Decoder<T>): Field<T | null | undefined> => ({
  read(obj, key) {
    if (!hasOwn(obj, key)) return undefined;
    const raw = obj[key];
    return raw === null ? null : dec(raw);
  },
});

export type Fields<T> = { [K in keyof T]-?: Field<T[K]> };

export function struct<T>(name: string, fields: Fields<T>): Decoder<T> {
  return (v) => {
    if (!isPlainObject(v)) throw typeError(v, `struct ${name}`);
    const out: PlainObject = {};
    for (const key of Object.keys(fields) as Array<keyof T & string>) {
      out[key] = fields[key].read(v, key);
    }
    return out as T;
  };
}

/** `parse_arg`: the key must be present. */
export function parseArg<T>(args: PlainObject, key: string, dec: Decoder<T>): T {
  if (!hasOwn(args, key) || args[key] === undefined) {
    throw new CommandError("validation_error", `thiếu tham số '${key}'`);
  }
  return decodeArg(key, dec, args[key]);
}

/** `parse_opt_arg`: absent or `null` is `null`. */
export function parseOptArg<T>(args: PlainObject, key: string, dec: Decoder<T>): T | null {
  const raw = args[key];
  if (raw === undefined || raw === null) return null;
  return decodeArg(key, dec, raw);
}

function decodeArg<T>(key: string, dec: Decoder<T>, raw: unknown): T {
  try {
    return dec(raw);
  } catch (err) {
    if (err instanceof SerdeError) {
      throw new CommandError("validation_error", `tham số '${key}' không hợp lệ: ${err.message}`);
    }
    throw err;
  }
}

/** Run a decoder outside the argument layer (stored JSON); returns `null` on a serde failure. */
export function tryDecode<T>(dec: Decoder<T>, raw: unknown): T | null {
  try {
    return dec(raw);
  } catch (err) {
    if (err instanceof SerdeError) return null;
    throw err;
  }
}

/** `serde_json::Value` objects serialize their keys in sorted order (no `preserve_order`). */
export function sortedJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sortedJson(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: PlainObject = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedJson(value[key]);
    return out as T;
  }
  return value;
}
