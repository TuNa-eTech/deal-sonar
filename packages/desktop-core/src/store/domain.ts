// Port of crates/store/src/models/domain.rs. The Rust types apply serde defaults and drop
// unknown keys when they round-trip JSON, and they serialize in struct field order. The
// normalizers below reproduce both so stored JSON stays byte-comparable with the Rust writer.

export type FieldType =
  | "text"
  | "number"
  | "money"
  | "phone"
  | "location"
  | "enum"
  | "multi_enum"
  | "boolean"
  | "date"
  | "range"
  | "url";

const FIELD_TYPES: readonly string[] = [
  "text",
  "number",
  "money",
  "phone",
  "location",
  "enum",
  "multi_enum",
  "boolean",
  "date",
  "range",
  "url",
];

export type FieldSource = "ai" | "rule" | "user";
export type FilterOp =
  | "eq"
  | "ne"
  | "in"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "contains"
  | "is_empty";
const FILTER_OPS: readonly string[] = [
  "eq",
  "ne",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "contains",
  "is_empty",
];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  description: string;
  required: boolean;
  options: string[] | null;
  show_in_alert: boolean;
  order: number;
}

export interface ExtractedField {
  value: unknown;
  raw?: string | null;
  confidence: number;
  source: FieldSource;
}

export interface QuietHours {
  from: string;
  to: string;
}

export interface NotifyConfig {
  channel_ids: string[];
  inherit_channels?: boolean;
  mode: string;
  min_score: number;
  quiet_hours: QuietHours | null;
  lead_ttl_hours?: number;
}

export interface HardFilter {
  field: string;
  op: FilterOp;
  value: unknown;
  when_missing: string;
}

export interface MatchPolicy {
  want_intent: string;
  exclude_roles: string[];
  hard_filters: HardFilter[];
  [extra: string]: unknown;
}

/** Error thrown when JSON does not satisfy the Rust serde type (maps to a serde_json error). */
export class DomainShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainShapeError";
  }
}

type Obj = Record<string, unknown>;

function asObject(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new DomainShapeError(`invalid type for ${what}: expected a map`);
  }
  return v as Obj;
}

function str(o: Obj, key: string, fallback?: string): string {
  const v = o[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new DomainShapeError(`missing field \`${key}\``);
  }
  if (typeof v !== "string") throw new DomainShapeError(`invalid type for \`${key}\`: expected a string`);
  return v;
}

function strArray(o: Obj, key: string): string[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new DomainShapeError(`invalid type for \`${key}\`: expected a sequence of strings`);
  }
  return v as string[];
}

function num(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number") throw new DomainShapeError(`invalid type for \`${key}\`: expected a number`);
  return v;
}

function bool(o: Obj, key: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new DomainShapeError(`invalid type for \`${key}\`: expected a boolean`);
  return v;
}

function intRange(o: Obj, key: string, fallback: number, min: number, max: number): number {
  const v = num(o, key, fallback);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new DomainShapeError(`invalid value for \`${key}\`: expected an integer in range`);
  }
  return v;
}

export function defaultNotifyConfig(): NotifyConfig {
  return { channel_ids: [], mode: "instant", min_score: 0.6, quiet_hours: null };
}

export function normalizeNotifyConfig(raw: unknown): NotifyConfig {
  const o = asObject(raw, "NotifyConfig");
  const out: NotifyConfig = {
    channel_ids: strArray(o, "channel_ids"),
    mode: str(o, "mode", "instant"),
    min_score: num(o, "min_score", 0.6),
    quiet_hours: null,
  };
  const inherit = o.inherit_channels;
  if (inherit !== undefined && inherit !== null) {
    if (typeof inherit !== "boolean") throw new DomainShapeError("invalid type for `inherit_channels`");
    out.inherit_channels = inherit;
  }
  const qh = o.quiet_hours;
  if (qh !== undefined && qh !== null) {
    const q = asObject(qh, "QuietHours");
    out.quiet_hours = { from: str(q, "from"), to: str(q, "to") };
  }
  const ttl = o.lead_ttl_hours;
  if (ttl !== undefined && ttl !== null) {
    out.lead_ttl_hours = intRange(o, "lead_ttl_hours", 0, 0, 4_294_967_295);
  }
  // Field order matches the Rust struct for stable serialization.
  const ordered: NotifyConfig = {
    channel_ids: out.channel_ids,
    ...(out.inherit_channels !== undefined ? { inherit_channels: out.inherit_channels } : {}),
    mode: out.mode,
    min_score: out.min_score,
    quiet_hours: out.quiet_hours,
    ...(out.lead_ttl_hours !== undefined ? { lead_ttl_hours: out.lead_ttl_hours } : {}),
  };
  return ordered;
}

export function notifySendsToChannel(cfg: NotifyConfig, channelId: string): boolean {
  return (cfg.inherit_channels ?? cfg.channel_ids.length === 0) || cfg.channel_ids.includes(channelId);
}

export function normalizeFieldDef(raw: unknown): FieldDef {
  const o = asObject(raw, "FieldDef");
  const type = str(o, "type");
  if (!FIELD_TYPES.includes(type)) throw new DomainShapeError(`unknown variant \`${type}\``);
  let options: string[] | null = null;
  if (o.options !== undefined && o.options !== null) {
    options = strArray(o, "options");
  }
  return {
    key: str(o, "key"),
    label: str(o, "label"),
    type: type as FieldType,
    description: str(o, "description", ""),
    required: bool(o, "required", false),
    options,
    show_in_alert: bool(o, "show_in_alert", true),
    order: intRange(o, "order", 0, -2_147_483_648, 2_147_483_647),
  };
}

export function normalizeFieldDefs(raw: unknown): FieldDef[] {
  if (!Array.isArray(raw)) throw new DomainShapeError("invalid type: expected a sequence");
  return raw.map(normalizeFieldDef);
}

export function normalizeHardFilter(raw: unknown): HardFilter {
  const o = asObject(raw, "HardFilter");
  const op = str(o, "op");
  if (!FILTER_OPS.includes(op)) throw new DomainShapeError(`unknown variant \`${op}\``);
  return {
    field: str(o, "field"),
    op: op as FilterOp,
    value: o.value === undefined ? null : o.value,
    when_missing: str(o, "when_missing", "pass"),
  };
}

const MATCH_POLICY_KNOWN = new Set(["want_intent", "exclude_roles", "hard_filters"]);

export function defaultMatchPolicy(): MatchPolicy {
  return { want_intent: "any", exclude_roles: ["peer"], hard_filters: [] };
}

export function normalizeMatchPolicy(raw: unknown): MatchPolicy {
  const o = asObject(raw, "MatchPolicy");
  const hf = o.hard_filters;
  if (hf !== undefined && !Array.isArray(hf)) throw new DomainShapeError("invalid type for `hard_filters`");
  const out: MatchPolicy = {
    want_intent: str(o, "want_intent", "any"),
    exclude_roles: strArray(o, "exclude_roles"),
    hard_filters: ((hf as unknown[] | undefined) ?? []).map(normalizeHardFilter),
  };
  // `#[serde(flatten)] extra: BTreeMap` serializes extras in sorted key order after known fields.
  for (const key of Object.keys(o).filter((k) => !MATCH_POLICY_KNOWN.has(k)).sort()) {
    out[key] = o[key];
  }
  return out;
}

export function normalizeExtractedField(raw: unknown): ExtractedField {
  const o = asObject(raw, "ExtractedField");
  const source = str(o, "source");
  if (source !== "ai" && source !== "rule" && source !== "user") {
    throw new DomainShapeError(`unknown variant \`${source}\``);
  }
  if (!("value" in o)) throw new DomainShapeError("missing field `value`");
  const rawText = o.raw;
  if (rawText !== undefined && rawText !== null && typeof rawText !== "string") {
    throw new DomainShapeError("invalid type for `raw`");
  }
  return {
    value: o.value,
    raw: (rawText as string | null | undefined) ?? null,
    confidence: num(o, "confidence", 1.0),
    source,
  };
}
