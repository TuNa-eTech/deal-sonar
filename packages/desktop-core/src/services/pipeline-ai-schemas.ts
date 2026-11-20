// Task JSON schemas for the pipeline AI layer. Port of crates/ai-bridge/src/schema/task_schemas.rs
// (`06-ai-bridge.md §3.5, §5`). Every schema is validated against the provider response by
// `AiBridge.invokeOnce` with the subset validator in `../ai/schema`.

import type { FieldDef } from "../store/domain";

type Json = Record<string, unknown>;

const KEY_PATTERN = "^[a-z][a-z0-9_]{1,30}$";

/** Output schema for `suggest_fields` (`06-ai-bridge.md §5.1`). */
export function suggestFieldsSchema(): Json {
  return {
    type: "object",
    required: ["fields", "want_intent", "suggested_name"],
    additionalProperties: false,
    properties: {
      suggested_name: { type: "string", minLength: 1, maxLength: 60 },
      want_intent: { type: "string", enum: ["demand", "supply", "any"] },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          required: ["key", "label", "type", "description", "required"],
          additionalProperties: false,
          properties: {
            key: { type: "string", pattern: KEY_PATTERN },
            label: { type: "string", minLength: 1 },
            type: {
              type: "string",
              enum: ["text", "number", "money", "phone", "location", "enum", "multi_enum", "boolean", "date", "range", "url"],
            },
            description: { type: "string", minLength: 1 },
            required: { type: "boolean" },
            options: { type: ["array", "null"], items: { type: "string", minLength: 1 } },
          },
        },
      },
      hard_filters: {
        type: "array",
        items: {
          type: "object",
          required: ["field", "op", "value"],
          additionalProperties: false,
          properties: {
            field: { type: "string", pattern: KEY_PATTERN },
            op: { type: "string", enum: ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"] },
            value: {},
            when_missing: { type: "string", enum: ["pass", "fail"] },
          },
        },
      },
      clarifying_questions: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } },
      prefilter_hint: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              any: { type: "array", items: { type: "string" } },
              none: { type: "array", items: { type: "string" } },
            },
          },
          { type: "null" },
        ],
      },
    },
  };
}

/** Per-field `value` sub-schema of the dynamic `judge_extract` schema. */
export function fieldValueSubschema(field: FieldDef): Json {
  const opts = field.options !== null && field.options !== undefined && field.options.length > 0 ? field.options : null;
  switch (field.type) {
    case "text":
    case "phone":
    case "url":
      return { type: ["string", "null"] };
    case "date":
      return { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}" }, { type: "null" }] };
    case "number":
      return { type: ["number", "null"] };
    case "boolean":
      return { type: ["boolean", "null"] };
    case "money":
      return {
        anyOf: [
          {
            type: "object",
            required: ["min", "max", "currency", "period"],
            additionalProperties: false,
            properties: {
              min: { type: "number" },
              max: { type: "number" },
              currency: { type: "string", minLength: 1 },
              period: { type: ["string", "null"] },
            },
          },
          { type: "null" },
        ],
      };
    case "location":
      return {
        anyOf: [
          {
            type: "object",
            required: ["raw", "province", "district", "ward"],
            additionalProperties: false,
            properties: {
              raw: { type: "string" },
              province: { type: ["string", "null"] },
              district: { type: ["string", "null"] },
              ward: { type: ["string", "null"] },
            },
          },
          { type: "null" },
        ],
      };
    case "range":
      return {
        anyOf: [
          {
            type: "object",
            required: ["min", "max", "unit"],
            additionalProperties: false,
            properties: { min: { type: "number" }, max: { type: "number" }, unit: { type: "string", minLength: 1 } },
          },
          { type: "null" },
        ],
      };
    case "enum":
      return opts ? { anyOf: [{ type: "string", enum: opts }, { type: "null" }] } : { type: ["string", "null"] };
    case "multi_enum":
      return opts
        ? { anyOf: [{ type: "array", items: { type: "string", enum: opts } }, { type: "null" }] }
        : { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] };
  }
}

/** Dynamic `judge_extract` schema for a radar version's fields (`06-ai-bridge.md §5.2`). */
export function buildJudgeExtractSchema(fields: readonly FieldDef[]): Json {
  const fieldProps: Record<string, unknown> = {};
  const requiredKeys: string[] = [];
  for (const f of fields) {
    requiredKeys.push(f.key);
    fieldProps[f.key] = {
      type: "object",
      required: ["raw", "value", "confidence"],
      additionalProperties: false,
      properties: {
        raw: { type: ["string", "null"] },
        value: fieldValueSubschema(f),
        confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
      },
    };
  }
  return {
    type: "object",
    required: ["results"],
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "match", "score", "intent", "author_role", "is_spam", "summary", "reason", "fields"],
          additionalProperties: false,
          properties: {
            ref: { type: "integer", minimum: 0 },
            match: { type: "boolean" },
            score: { type: "number", minimum: 0.0, maximum: 1.0 },
            intent: { type: "string", enum: ["demand", "supply", "other"] },
            author_role: { type: "string", enum: ["end_user", "peer", "unknown"] },
            is_spam: { type: "boolean" },
            summary: { type: "string", maxLength: 140 },
            reason: { type: "string", maxLength: 200 },
            fields: { type: "object", required: requiredKeys, additionalProperties: false, properties: fieldProps },
          },
        },
      },
    },
  };
}

/** Output schema for `compile_rules` DSL v1 (`06-ai-bridge.md §5.3`, `05-pipeline-rules.md §6.2`). */
export function compileRulesSchema(): Json {
  return {
    type: "object",
    required: ["dsl", "prefilter", "classify", "extract", "thresholds"],
    additionalProperties: false,
    properties: {
      dsl: { type: "integer", const: 1 },
      prefilter: {
        type: "object",
        additionalProperties: false,
        properties: {
          any: { type: "array", items: { type: "string", minLength: 1 } },
          none: { type: "array", items: { type: "string", minLength: 1 } },
          min_len: { type: "integer", minimum: 0 },
        },
      },
      classify: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "when", "verdict", "confidence"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1 },
            when: { type: "object", minProperties: 1 },
            verdict: { type: "string", enum: ["match", "no_match"] },
            confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
            set: {
              type: "object",
              additionalProperties: false,
              properties: {
                intent: { type: "string", enum: ["demand", "supply", "other"] },
                author_role: { type: "string", enum: ["end_user", "peer", "unknown"] },
              },
            },
          },
        },
      },
      extract: {
        type: "array",
        items: {
          type: "object",
          required: ["field", "extractor"],
          properties: {
            field: { type: "string", pattern: KEY_PATTERN },
            extractor: {
              type: "string",
              enum: ["vn_money", "vn_phone", "vn_area", "gazetteer", "number", "date_vi", "enum_kw", "regex"],
            },
            near: { type: "array", items: { type: "string" } },
            window: { type: "integer", minimum: 1 },
            dict: { type: "string" },
            scope: { type: "string" },
            pattern: { type: "string" },
            group: { type: "integer", minimum: 0 },
            cast: { type: "string", enum: ["int", "float", "string", "bool"] },
            unit: { type: "string" },
            map: { type: "object" },
          },
        },
      },
      thresholds: {
        type: "object",
        required: ["accept", "reject"],
        additionalProperties: false,
        properties: {
          accept: { type: "number", minimum: 0.0, maximum: 1.0 },
          reject: { type: "number", minimum: 0.0, maximum: 1.0 },
        },
      },
    },
  };
}

const MAX_CACHED_SCHEMAS = 256;

/** Cache of dynamic `judge_extract` schemas keyed by radar version and field definitions. */
export class JudgeSchemaCache {
  private readonly byVersion = new Map<string, Json>();

  getOrBuild(radarVersionId: string, fields: readonly FieldDef[]): Json {
    const key = `${radarVersionId}\u0000${JSON.stringify(fields)}`;
    const cached = this.byVersion.get(key);
    if (cached) return cached;
    const built = buildJudgeExtractSchema(fields);
    if (this.byVersion.size >= MAX_CACHED_SCHEMAS) this.byVersion.clear();
    this.byVersion.set(key, built);
    return built;
  }

  get size(): number {
    return this.byVersion.size;
  }
}
