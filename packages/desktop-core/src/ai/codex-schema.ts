// Port of crates/ai-bridge/src/adapters/codex_schema.rs.
//
// Codex Structured Outputs requires closed objects whose properties are all required. Optional
// properties travel as nullable fields and are dropped again before domain validation; dynamic
// JSON (DSL predicates, extractor maps, filter values) travels as a JSON-encoded string.

import { validateJsonSchemaError } from "./schema";
import { AiError } from "./types";

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function isDynamicJson(schema: Json): boolean {
  if (!isObject(schema)) return false;
  return Object.keys(schema).length === 0 || (schema.type === "object" && schema.properties === undefined);
}

export function strictOutputSchema(schema: Json): Json {
  if (isDynamicJson(schema)) {
    return {
      type: "string",
      description: `Return a JSON-encoded string containing this value (not prose). The string will be parsed as JSON and validated against: ${JSON.stringify(schema)}`,
    };
  }
  if (!isObject(schema)) return schema;
  const wire: JsonObject = { ...schema };
  if (Array.isArray(schema.anyOf)) wire.anyOf = schema.anyOf.map(strictOutputSchema);
  if (schema.items !== undefined) wire.items = strictOutputSchema(schema.items);
  if (isObject(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : null;
    const wireProps: JsonObject = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      const projected = strictOutputSchema(property);
      const isRequired = required !== null && required.some((k) => k === key);
      wireProps[key] = isRequired ? projected : { anyOf: [projected, { type: "null" }] };
    }
    wire.properties = wireProps;
    wire.required = Object.keys(schema.properties);
    wire.additionalProperties = false;
  }
  if ("const" in wire) {
    const value = wire.const;
    delete wire.const;
    wire.enum = [value];
  }
  return wire;
}

export function decodeStrictOutput(schema: Json, wire: Json): Json {
  return decodeAt(schema, wire, "$");
}

function decodeAt(schema: Json, wire: Json, path: string): Json {
  if (isDynamicJson(schema)) {
    if (typeof wire !== "string") throw AiError.invalidOutput(`${path}: expected JSON-encoded string`);
    try {
      return JSON.parse(wire) as Json;
    } catch {
      throw AiError.invalidOutput(`${path}: invalid JSON-encoded value`);
    }
  }
  if (isObject(schema) && Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      try {
        const decoded = decodeAt(branch, structuredClone(wire), path);
        if (validateJsonSchemaError(branch, decoded) === null) return decoded;
      } catch {
        // try the next branch
      }
    }
    throw AiError.invalidOutput(`${path}: output did not match any schema branch`);
  }
  if (isObject(wire)) {
    const values: JsonObject = { ...wire };
    if (isObject(schema) && isObject(schema.properties)) {
      const required = Array.isArray(schema.required) ? schema.required : null;
      for (const [key, property] of Object.entries(schema.properties)) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
        const value = values[key];
        delete values[key];
        const isRequired = required !== null && required.some((k) => k === key);
        if (value === null && !isRequired) continue;
        values[key] = decodeAt(property, value, `${path}.${key}`);
      }
    }
    return values;
  }
  if (Array.isArray(wire)) {
    if (isObject(schema) && schema.items !== undefined) {
      return wire.map((value, idx) => decodeAt(schema.items, value, `${path}[${idx}]`));
    }
    return wire;
  }
  return wire;
}
