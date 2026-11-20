// Port of crates/ai-bridge/src/schema/{validator,json_extract}.rs: the recursive JSON-Schema
// subset validator used on every CLI response, and tolerant JSON extraction from CLI text.

import { AiError } from "./types";

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export function probeSmokeSchema(): JsonObject {
  return {
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
  };
}

/** Structural JSON equality (object key order is irrelevant, like `serde_json::Value`). */
export function jsonEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}

function typeName(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

function matchesJsonType(expected: string, v: Json): boolean {
  switch (expected) {
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "integer":
      return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      return false;
  }
}

const asU64 = (v: Json): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const asF64 = (v: Json): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `serde_json::Value` Display (compact JSON). */
const show = (v: Json): string => JSON.stringify(v) ?? "null";

/** Validate `instance` against `schema`. Returns `null` when valid, else a descriptive error. */
export function validateJsonSchemaError(schema: Json, instance: Json): string | null {
  return validateAt(schema, instance, "$");
}

/** Throwing variant mirroring `validate_json_schema(..).map_err(AiError::InvalidOutput)`. */
export function validateJsonSchema(schema: Json, instance: Json): void {
  const err = validateAt(schema, instance, "$");
  if (err !== null) throw AiError.invalidOutput(err);
}

function validateAt(schema: Json, instance: Json, path: string): string | null {
  if (typeof schema === "boolean") {
    return schema ? null : `${path}: schema is false (no value allowed)`;
  }
  if (!isObject(schema)) return `${path}: invalid schema (expected object or boolean)`;

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const sub of allOf) {
      const e = validateAt(sub, instance, path);
      if (e !== null) return e;
    }
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    let lastErr: string | null = null;
    let matched = false;
    for (const sub of anyOf) {
      const e = validateAt(sub, instance, path);
      if (e === null) {
        matched = true;
        break;
      }
      lastErr = e;
    }
    if (!matched) return `${path}: did not match anyOf schema (${lastErr ?? "empty anyOf"})`;
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    let matches = 0;
    let lastErr = "";
    for (const sub of oneOf) {
      const e = validateAt(sub, instance, path);
      if (e === null) matches += 1;
      else lastErr = e;
    }
    if (matches !== 1) return `${path}: expected exactly 1 match in oneOf, got ${matches} (${lastErr})`;
  }

  if ("const" in schema && !jsonEquals(instance, schema.const)) {
    return `${path}: expected const ${show(schema.const)}, got ${show(instance)}`;
  }

  const enumVals = schema.enum;
  if (Array.isArray(enumVals) && !enumVals.some((v) => jsonEquals(v, instance))) {
    return `${path}: value ${show(instance)} is not in allowed enum ${show(enumVals)}`;
  }

  if ("type" in schema) {
    const spec = schema.type;
    let ok = false;
    if (typeof spec === "string") ok = matchesJsonType(spec, instance);
    else if (Array.isArray(spec)) ok = spec.some((t) => typeof t === "string" && matchesJsonType(t, instance));
    if (!ok) return `${path}: expected type ${show(spec)}, got ${typeName(instance)}`;
  }

  if (isObject(instance)) {
    const keys = Object.keys(instance);
    const minP = asU64(schema.minProperties);
    if (minP !== null && keys.length < minP) {
      return `${path}: object has ${keys.length} properties, minProperties is ${minP}`;
    }
    const maxP = asU64(schema.maxProperties);
    if (maxP !== null && keys.length > maxP) {
      return `${path}: object has ${keys.length} properties, maxProperties is ${maxP}`;
    }
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (typeof req === "string" && !Object.prototype.hasOwnProperty.call(instance, req)) {
          return `${path}: missing required property '${req}'`;
        }
      }
    }
    const props = isObject(schema.properties) ? schema.properties : null;
    if (props) {
      for (const [k, propSchema] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(instance, k)) {
          const e = validateAt(propSchema, instance[k], `${path}.${k}`);
          if (e !== null) return e;
        }
      }
    }
    if ("additionalProperties" in schema) {
      const addl = schema.additionalProperties;
      for (const [k, v] of Object.entries(instance)) {
        const known = props !== null && Object.prototype.hasOwnProperty.call(props, k);
        if (known) continue;
        if (addl === false) return `${path}: unexpected additional property '${k}'`;
        if (addl === true) continue;
        const e = validateAt(addl, v, `${path}.${k}`);
        if (e !== null) return e;
      }
    }
  } else if (Array.isArray(instance)) {
    const minItems = asU64(schema.minItems);
    if (minItems !== null && instance.length < minItems) {
      return `${path}: array length ${instance.length} is less than minItems ${minItems}`;
    }
    const maxItems = asU64(schema.maxItems);
    if (maxItems !== null && instance.length > maxItems) {
      return `${path}: array length ${instance.length} exceeds maxItems ${maxItems}`;
    }
    if ("items" in schema) {
      for (let idx = 0; idx < instance.length; idx += 1) {
        const e = validateAt(schema.items, instance[idx], `${path}[${idx}]`);
        if (e !== null) return e;
      }
    }
  } else if (typeof instance === "string") {
    const charLen = [...instance].length;
    const minLen = asU64(schema.minLength);
    if (minLen !== null && charLen < minLen) {
      return `${path}: string length ${charLen} is less than minLength ${minLen}`;
    }
    const maxLen = asU64(schema.maxLength);
    if (maxLen !== null && charLen > maxLen) {
      return `${path}: string length ${charLen} exceeds maxLength ${maxLen}`;
    }
    if (typeof schema.pattern === "string") {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern, "u");
      } catch (err) {
        return `${path}: invalid schema regex '${schema.pattern}': ${(err as Error).message}`;
      }
      if (!re.test(instance)) return `${path}: string '${instance}' does not match pattern '${schema.pattern}'`;
    }
  } else if (typeof instance === "number") {
    if (!Number.isFinite(instance)) return `${path}: non-finite number`;
    const min = asF64(schema.minimum);
    if (min !== null && instance < min) return `${path}: number ${instance} is less than minimum ${min}`;
    const max = asF64(schema.maximum);
    if (max !== null && instance > max) return `${path}: number ${instance} exceeds maximum ${max}`;
    const exMin = asF64(schema.exclusiveMinimum);
    if (exMin !== null && instance <= exMin) {
      return `${path}: number ${instance} must be > exclusiveMinimum ${exMin}`;
    }
    const exMax = asF64(schema.exclusiveMaximum);
    if (exMax !== null && instance >= exMax) {
      return `${path}: number ${instance} must be < exclusiveMaximum ${exMax}`;
    }
  }
  return null;
}

// ---- JSON extraction --------------------------------------------------------------------------

function tryParse(text: string): { ok: true; value: Json } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    return { ok: false };
  }
}

export function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf("```");
    if (start < 0) break;
    const afterTicks = rest.slice(start + 3);
    const nl = afterTicks.indexOf("\n");
    if (nl < 0) break;
    const bodyStart = afterTicks.slice(nl + 1);
    const end = bodyStart.indexOf("```");
    if (end < 0) break;
    blocks.push(bodyStart.slice(0, end));
    rest = bodyStart.slice(end + 3);
  }
  return blocks;
}

export function findBalancedObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Extract a JSON value from raw CLI text: direct parse, then fenced code blocks, then the first
 * balanced `{ ... }` object inside surrounding prose.
 */
export function extractJsonValue(raw: string): Json {
  const trimmed = raw.trim();
  if (trimmed === "") throw AiError.invalidOutput("empty CLI output");
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;
  for (const fenced of extractFencedBlocks(trimmed)) {
    const parsed = tryParse(fenced.trim());
    if (parsed.ok) return parsed.value;
  }
  for (let idx = 0; idx < trimmed.length; idx += 1) {
    if (trimmed[idx] !== "{") continue;
    const end = findBalancedObjectEnd(trimmed, idx);
    if (end !== null) {
      const parsed = tryParse(trimmed.slice(idx, end));
      if (parsed.ok) return parsed.value;
    }
  }
  throw AiError.invalidOutput("could not parse valid JSON object from CLI output");
}
