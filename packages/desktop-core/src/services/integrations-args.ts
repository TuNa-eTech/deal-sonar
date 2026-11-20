// Typed argument parsing for the integration commands. Reproduces the `parse_arg` /
// `parse_opt_arg` contract of apps/desktop/src/commands/dispatch.rs: a missing key reports
// `thiếu tham số 'k'`, a present-but-wrong value reports `tham số 'k' không hợp lệ: <serde message>`.

import { type Args, CommandError } from "../backend/wire";

type Json = unknown;

/** serde_json `Unexpected` rendering used in "invalid type" messages. */
export function describeUnexpected(v: Json): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return `boolean \`${v}\``;
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (Array.isArray(v)) return "sequence";
  return "map";
}

export const invalidType = (v: Json, expected: string): string =>
  `invalid type: ${describeUnexpected(v)}, expected ${expected}`;

/** Message for a value that cannot be parsed; surfaced as `validation_error`. */
export class ArgShapeError extends Error {}

export function badArg(key: string, message: string): CommandError {
  return new CommandError("validation_error", `tham số '${key}' không hợp lệ: ${message}`);
}

export function missingArg(key: string): CommandError {
  return new CommandError("validation_error", `thiếu tham số '${key}'`);
}

/** Run a field parser, turning its `ArgShapeError` into the wire error for `key`. */
export function parseWith<T>(key: string, value: Json, parser: (v: Json) => T): T {
  try {
    return parser(value);
  } catch (err) {
    if (err instanceof ArgShapeError) throw badArg(key, err.message);
    throw err;
  }
}

export const asString = (v: Json): string => {
  if (typeof v !== "string") throw new ArgShapeError(invalidType(v, "a string"));
  return v;
};

export const asBool = (v: Json): boolean => {
  if (typeof v !== "boolean") throw new ArgShapeError(invalidType(v, "a boolean"));
  return v;
};

export const asU32 = (v: Json): number => {
  if (typeof v !== "number") throw new ArgShapeError(invalidType(v, "u32"));
  if (!Number.isInteger(v)) throw new ArgShapeError(invalidType(v, "u32"));
  if (v < 0 || v > 4_294_967_295) throw new ArgShapeError(`invalid value: integer \`${v}\`, expected u32`);
  return v;
};

export const asI64 = (v: Json): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ArgShapeError(invalidType(v, "i64"));
  return v;
};

export function asArrayOf<T>(v: Json, item: (x: Json) => T): T[] {
  if (!Array.isArray(v)) throw new ArgShapeError(invalidType(v, "a sequence"));
  return v.map(item);
}

export const asUsize = (v: Json): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ArgShapeError(invalidType(v, "usize"));
  if (v < 0) throw new ArgShapeError(`invalid value: integer \`${v}\`, expected usize`);
  return v;
};

export const asObject = (v: Json, expected = "a map"): Record<string, Json> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ArgShapeError(invalidType(v, expected));
  return v as Record<string, Json>;
};

export function asEnum<T extends string>(v: Json, variants: readonly T[]): T {
  if (typeof v !== "string") throw new ArgShapeError(invalidType(v, "a string"));
  if (!variants.includes(v as T)) {
    throw new ArgShapeError(`unknown variant \`${v}\`, expected one of ${variants.map((x) => `\`${x}\``).join(", ")}`);
  }
  return v as T;
}

export function argRequired<T>(args: Args, key: string, parser: (v: Json) => T): T {
  if (!(key in args) || args[key] === undefined) throw missingArg(key);
  return parseWith(key, args[key], parser);
}

/** `Option<T>`: absent or `null` -> `null`. */
export function argOptional<T>(args: Args, key: string, parser: (v: Json) => T): T | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  return parseWith(key, v, parser);
}

/** The `args` object itself (`Value::Null` means "no arguments"). */
export function argsObject(args: Json): Args {
  if (args === null || args === undefined) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new CommandError("validation_error", "tham số lệnh IPC phải là đối tượng JSON");
  }
  return args as Args;
}
