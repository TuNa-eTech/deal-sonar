// Graceful Protocol v2 envelope parser and builders: a port of `crates/protocol/src/parser.rs`
// (`parse_raw_envelope` / `RawEnvelope::into_envelope`) plus the serde validation of every `Body`
// payload (unknown payload fields are ignored, missing `Option` fields are `None`, enums reject
// unknown variants). Error classification (`protocol_mismatch` / `unknown_type` /
// `invalid_payload`) and the retained `reply_to` id match the Rust parser.
//
// Known, intentional differences from serde_json:
//  * detail text after the prefix (for example the JSON syntax error) is the JS message;
//  * `2.0` and `2` are indistinguishable after `JSON.parse`, so `"v": 2.0` is accepted.

import { newUlid } from "../store/util";
import {
  type Body,
  type BodyType,
  type Envelope,
  type ErrorCode,
  ATTACHMENT_KINDS,
  CRAWL_REASONS,
  CRAWL_STATUSES,
  ERROR_CODES,
  EXTRACTION_STRATEGIES,
  PROTOCOL_VERSION,
  SESSION_STATES,
  SOURCE_PRIVACIES,
  isKnownMessageType,
} from "./protocol-types";

/** Structured envelope parse failure retaining the incoming `id` (when valid) for `reply_to`. */
export class EnvelopeParseError extends Error {
  constructor(
    readonly id: string | null,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeParseError";
  }

  /** Non-retryable `error` envelope with `reply_to = this.id`. */
  toErrorEnvelope(): Envelope {
    return errorEnvelope(this.id, this.code, this.message, false);
  }
}

// ── builders ─────────────────────────────────────────────────────────────────────────────────

export function withReplyTo<B extends Body>(replyTo: string | null, body: B, now: number = Date.now()): Envelope<B> {
  return { v: PROTOCOL_VERSION, id: newUlid(now), ts: now, reply_to: replyTo, ...body } as Envelope<B>;
}

/** New `v = 2` envelope with a fresh ULID `id` and `reply_to = null`. */
export const newEnvelope = <B extends Body>(body: B, now?: number): Envelope<B> => withReplyTo(null, body, now);

/** New `v = 2` reply envelope referencing `replyTo`. */
export const replyEnvelope = <B extends Body>(replyTo: string, body: B, now?: number): Envelope<B> =>
  withReplyTo(replyTo, body, now);

export const errorEnvelope = (
  replyTo: string | null,
  code: ErrorCode,
  message: string,
  retryable: boolean,
  now?: number,
): Envelope => withReplyTo<Body>(replyTo, { type: "error", payload: { code, message, retryable } }, now);

// ── envelope parsing ─────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const mismatch = (id: string | null, ver: number): EnvelopeParseError =>
  new EnvelopeParseError(id, "protocol_mismatch", `unsupported protocol version ${ver}, expected ${PROTOCOL_VERSION}`);
const invalid = (id: string | null, message: string): EnvelopeParseError =>
  new EnvelopeParseError(id, "invalid_payload", message);

interface RawEnvelope {
  id: string;
  ts: number;
  replyTo: string | null;
  type: string;
  payload: unknown;
}

/** `parse_raw_envelope`: header validation with `v` checked before every other v2 field. */
function parseRawEnvelope(bytes: Uint8Array): RawEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8.decode(bytes));
  } catch (err) {
    throw invalid(null, `malformed JSON frame: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRec(value)) throw invalid(null, "envelope must be a JSON object");
  const obj = value;

  const extractedId = typeof obj.id === "string" && obj.id !== "" ? obj.id : null;

  // 1. `v` first, so legacy v1 frames report `protocol_mismatch`.
  const v = obj.v;
  if (v === undefined) {
    const legacy = obj.version;
    if (typeof legacy === "number" && Number.isSafeInteger(legacy) && legacy !== PROTOCOL_VERSION) {
      throw new EnvelopeParseError(
        extractedId,
        "protocol_mismatch",
        `unsupported legacy protocol version ${legacy}, expected ${PROTOCOL_VERSION}`,
      );
    }
    throw invalid(extractedId, "missing integer field 'v'");
  }
  if (typeof v !== "number") throw invalid(extractedId, "field 'v' must be an integer");
  if (!Number.isSafeInteger(v)) throw invalid(extractedId, "field 'v' must be an integer");
  if (v !== PROTOCOL_VERSION) throw mismatch(extractedId, v);

  // 2. `id`
  if (extractedId === null) throw invalid(null, "missing or invalid non-empty string field 'id'");
  const id = extractedId;

  // 3. `ts`
  if (typeof obj.ts !== "number" || !Number.isSafeInteger(obj.ts)) {
    throw invalid(id, "missing or invalid integer field 'ts'");
  }

  // 4. `reply_to`
  let replyTo: string | null;
  const rt = obj.reply_to;
  if (rt === undefined || rt === null) replyTo = null;
  else if (typeof rt === "string") {
    if (rt === "") throw invalid(id, "field 'reply_to' must be null or a non-empty string");
    replyTo = rt;
  } else throw invalid(id, "field 'reply_to' must be null or a string");

  // 5. `type`
  if (typeof obj.type !== "string" || obj.type === "") {
    throw invalid(id, "missing or invalid string field 'type'");
  }

  return { id, ts: obj.ts, replyTo, type: obj.type, payload: obj.payload === undefined ? null : obj.payload };
}

/** Parse UTF-8 JSON bytes into a typed v2 envelope with structured error classification. */
export function parseEnvelope(bytes: Uint8Array): Envelope {
  const raw = parseRawEnvelope(bytes);
  if (!isKnownMessageType(raw.type)) {
    throw new EnvelopeParseError(raw.id, "unknown_type", `unknown message type '${raw.type}'`);
  }
  if (!isRec(raw.payload)) {
    throw invalid(raw.id, `expected object 'payload' for message type '${raw.type}'`);
  }
  let body: Body;
  try {
    body = parseBody(raw.type, raw.payload);
  } catch (err) {
    if (err instanceof PayloadError) throw invalid(raw.id, `invalid payload: ${err.message}`);
    throw err;
  }
  return { v: PROTOCOL_VERSION, id: raw.id, ts: raw.ts, reply_to: raw.replyTo, ...body } as Envelope;
}

/** Best-effort extraction of the top-level non-empty string `"id"` (`extract_envelope_id`). */
export function extractEnvelopeId(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(strictUtf8.decode(bytes));
    if (isRec(parsed) && typeof parsed.id === "string" && parsed.id !== "") return parsed.id;
  } catch {
    /* not JSON */
  }
  return null;
}

// ── serde-style payload validation ───────────────────────────────────────────────────────────

class PayloadError extends Error {}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "sequence";
  switch (typeof v) {
    case "string":
      return `string ${JSON.stringify(v)}`;
    case "boolean":
      return `boolean \`${v}\``;
    case "number":
      return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
    default:
      return "map";
  }
}

const typeErr = (v: unknown, expected: string): PayloadError =>
  new PayloadError(`invalid type: ${describe(v)}, expected ${expected}`);
const missing = (key: string): PayloadError => new PayloadError(`missing field \`${key}\``);

function struct(v: unknown, name: string): Rec {
  if (!isRec(v)) throw typeErr(v, `struct ${name}`);
  return v;
}

function reqStr(o: Rec, key: string): string {
  const v = o[key];
  if (v === undefined) throw missing(key);
  if (typeof v !== "string") throw typeErr(v, "a string");
  return v;
}

function optStr(o: Rec, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw typeErr(v, "a string");
  return v;
}

function reqBool(o: Rec, key: string): boolean {
  const v = o[key];
  if (v === undefined) throw missing(key);
  if (typeof v !== "boolean") throw typeErr(v, "a boolean");
  return v;
}

function intIn(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw typeErr(v, label);
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new PayloadError(`invalid value: integer \`${v}\`, expected ${label}`);
  }
  return v;
}

const U32_MAX = 4_294_967_295;
const reqU64 = (o: Rec, key: string): number => {
  if (o[key] === undefined) throw missing(key);
  return intIn(o[key], "u64", 0, Number.MAX_SAFE_INTEGER);
};
const reqU32 = (o: Rec, key: string): number => {
  if (o[key] === undefined) throw missing(key);
  return intIn(o[key], "u32", 0, U32_MAX);
};
const reqI64 = (o: Rec, key: string): number => {
  if (o[key] === undefined) throw missing(key);
  return intIn(o[key], "i64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
};
const optU64 = (o: Rec, key: string): number | undefined =>
  o[key] === undefined || o[key] === null ? undefined : intIn(o[key], "u64", 0, Number.MAX_SAFE_INTEGER);
const optU32 = (o: Rec, key: string): number | undefined =>
  o[key] === undefined || o[key] === null ? undefined : intIn(o[key], "u32", 0, U32_MAX);
const optI64 = (o: Rec, key: string): number | null =>
  o[key] === undefined || o[key] === null ? null : intIn(o[key], "i64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

function reqF64(o: Rec, key: string): number {
  const v = o[key];
  if (v === undefined) throw missing(key);
  if (typeof v !== "number") throw typeErr(v, "f64");
  return v;
}

function parseEnum<T extends string>(v: unknown, variants: readonly T[]): T {
  if (typeof v !== "string") throw typeErr(v, "a string");
  if (!(variants as readonly string[]).includes(v)) {
    throw new PayloadError(`unknown variant \`${v}\`, expected one of ${variants.map((x) => `\`${x}\``).join(", ")}`);
  }
  return v as T;
}

function reqEnum<T extends string>(o: Rec, key: string, variants: readonly T[]): T {
  if (o[key] === undefined) throw missing(key);
  return parseEnum(o[key], variants);
}

function optEnum<T extends string>(o: Rec, key: string, variants: readonly T[]): T | undefined {
  return o[key] === undefined || o[key] === null ? undefined : parseEnum(o[key], variants);
}

function seq<T>(v: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(v)) throw typeErr(v, "a sequence");
  return v.map(parse);
}

function reqSeq<T>(o: Rec, key: string, parse: (item: unknown) => T): T[] {
  if (o[key] === undefined) throw missing(key);
  return seq(o[key], parse);
}

const clean = <T extends Rec>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

function parseSourceRef(v: unknown) {
  const o = struct(v, "SourceRef");
  return { platform: reqStr(o, "platform"), kind: reqStr(o, "kind"), external_id: reqStr(o, "external_id") };
}

function parseSourceInfo(v: unknown) {
  const o = struct(v, "SourceInfo");
  return clean({
    platform: reqStr(o, "platform"),
    kind: reqStr(o, "kind"),
    external_id: reqStr(o, "external_id"),
    name: reqStr(o, "name"),
    url: reqStr(o, "url"),
    privacy: optEnum(o, "privacy", SOURCE_PRIVACIES),
    member_count: optU64(o, "member_count"),
  });
}

function parseRawPost(v: unknown) {
  const o = struct(v, "RawPost");
  const author = struct(o.author === undefined ? missingValue("author") : o.author, "AuthorInfo");
  const extraction = struct(o.extraction === undefined ? missingValue("extraction") : o.extraction, "ExtractionInfo");
  let counts: { comments?: number; reactions?: number } | undefined;
  if (o.counts !== undefined && o.counts !== null) {
    const c = struct(o.counts, "PostCounts");
    counts = clean({ comments: optU64(c, "comments"), reactions: optU64(c, "reactions") });
  }
  return clean({
    platform: reqStr(o, "platform"),
    post_id: reqStr(o, "post_id"),
    source_external_id: reqStr(o, "source_external_id"),
    permalink: reqStr(o, "permalink"),
    author: clean({
      external_id: optStr(author, "external_id"),
      name: reqStr(author, "name"),
      is_anonymous: reqBool(author, "is_anonymous"),
    }),
    text: reqStr(o, "text"),
    text_truncated: reqBool(o, "text_truncated"),
    created_at: o.created_at === undefined || o.created_at === null ? undefined : intIn(o.created_at, "i64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    captured_at: reqI64(o, "captured_at"),
    attachments:
      o.attachments === undefined || o.attachments === null
        ? []
        : seq(o.attachments, (a) => {
            const ao = struct(a, "Attachment");
            return clean({
              kind: reqEnum(ao, "kind", ATTACHMENT_KINDS),
              url: optStr(ao, "url"),
              alt: optStr(ao, "alt"),
            });
          }),
    counts,
    extraction: { strategy: reqEnum(extraction, "strategy", EXTRACTION_STRATEGIES), profile_rev: reqU64(extraction, "profile_rev") },
  });
}

// A struct value that is absent: reported as the same `missing field` error serde gives.
function missingValue(key: string): never {
  throw missing(key);
}

function parseRuntime(v: unknown) {
  const o = struct(v, "CrawlRuntimeStatus");
  return {
    automatic_scanning: reqBool(o, "automatic_scanning"),
    paused: reqBool(o, "paused"),
    next_crawl_at: optI64(o, "next_crawl_at"),
    last_crawl_at: optI64(o, "last_crawl_at"),
  };
}

function reqStruct(o: Rec, key: string, name: string): Rec {
  if (o[key] === undefined) throw missing(key);
  return struct(o[key], name);
}

function parseConfigUpdate(o: Rec) {
  const plan = reqStruct(o, "plan", "CrawlPlan");
  const policy = reqStruct(o, "policy", "CrawlPolicy");
  const extractor = reqStruct(o, "extractor", "ExtractorProfile");
  const hours = reqStruct(policy, "active_hours", "ActiveHours");
  const value = (e: Rec, key: string): unknown => (e[key] === undefined ? {} : e[key]);
  return {
    rev: reqU64(o, "rev"),
    plan: {
      entries: reqSeq(plan, "entries", (item) => {
        const e = struct(item, "CrawlPlanEntry");
        return {
          source_ref: parseSourceRef(e.source_ref === undefined ? missingValue("source_ref") : e.source_ref),
          interval_s: reqU32(e, "interval_s"),
          priority: reqU32(e, "priority"),
          max_posts_per_visit: reqU32(e, "max_posts_per_visit"),
        };
      }),
    },
    policy: {
      max_loads_per_hour: reqU32(policy, "max_loads_per_hour"),
      max_loads_per_day: reqU32(policy, "max_loads_per_day"),
      active_hours: { from: reqStr(hours, "from"), to: reqStr(hours, "to") },
      jitter: reqF64(policy, "jitter"),
      max_scroll_steps: reqU32(policy, "max_scroll_steps"),
      only_when_idle: reqBool(policy, "only_when_idle"),
    },
    extractor: {
      rev: reqU64(extractor, "rev"),
      strategies: reqSeq(extractor, "strategies", (s) => parseEnum(s, EXTRACTION_STRATEGIES)),
      network: value(extractor, "network"),
      dom: value(extractor, "dom"),
      session_markers: value(extractor, "session_markers"),
    },
  };
}

/** Validate `payload` for `type` and project it to the known fields. */
function parseBody(type: BodyType, p: Rec): Body {
  switch (type) {
    case "hello":
      return {
        type,
        payload: {
          profile_id: reqStr(p, "profile_id"),
          ext_version: reqStr(p, "ext_version"),
          browser: reqStr(p, "browser"),
          config_rev: reqU64(p, "config_rev"),
        },
      };
    case "posts.push":
      return {
        type,
        payload: {
          run_id: reqStr(p, "run_id"),
          source_ref: parseSourceRef(p.source_ref === undefined ? missingValue("source_ref") : p.source_ref),
          posts: reqSeq(p, "posts", parseRawPost),
        },
      };
    case "crawl.report":
      return {
        type,
        payload: clean({
          run_id: reqStr(p, "run_id"),
          source_ref: parseSourceRef(p.source_ref === undefined ? missingValue("source_ref") : p.source_ref),
          reason: reqEnum(p, "reason", CRAWL_REASONS),
          status: reqEnum(p, "status", CRAWL_STATUSES),
          started_at: reqI64(p, "started_at"),
          ended_at: reqI64(p, "ended_at"),
          posts_seen: reqU32(p, "posts_seen"),
          posts_new: reqU32(p, "posts_new"),
          page_loads: reqU32(p, "page_loads"),
          strategy: optEnum(p, "strategy", EXTRACTION_STRATEGIES),
          error: optStr(p, "error"),
          dropped_posts: optU32(p, "dropped_posts"),
        }),
      };
    case "sources.discovered": {
      const follow = p.follow;
      if (follow !== undefined && follow !== null && typeof follow !== "boolean") throw typeErr(follow, "a boolean");
      return {
        type,
        payload: clean({
          sources: reqSeq(p, "sources", parseSourceInfo),
          follow: (follow ?? undefined) as boolean | undefined,
        }),
      };
    }
    case "session.status":
      return {
        type,
        payload: clean({
          runtime: p.runtime === undefined || p.runtime === null ? undefined : parseRuntime(p.runtime),
          platform: reqStr(p, "platform"),
          state: reqEnum(p, "state", SESSION_STATES),
          detail: optStr(p, "detail"),
        }),
      };
    case "ping":
    case "crawl.resume":
    case "pong":
      return { type, payload: {} };
    case "hello.ok":
      return { type, payload: { desktop_version: reqStr(p, "desktop_version"), config_rev: reqU64(p, "config_rev") } };
    case "config.update":
      return { type, payload: parseConfigUpdate(p) };
    case "crawl.request":
      return {
        type,
        payload: {
          request_id: reqStr(p, "request_id"),
          source_ref: parseSourceRef(p.source_ref === undefined ? missingValue("source_ref") : p.source_ref),
          reason: reqEnum(p, "reason", CRAWL_REASONS),
          max_posts: reqU32(p, "max_posts"),
        },
      };
    case "crawl.pause":
      return { type, payload: { until: optI64(p, "until"), reason: reqStr(p, "reason") } };
    case "ack":
      return { type, payload: { accepted: reqU32(p, "accepted"), duplicates: reqU32(p, "duplicates") } };
    case "error":
      return {
        type,
        payload: {
          code: reqEnum(p, "code", ERROR_CODES),
          message: reqStr(p, "message"),
          retryable: reqBool(p, "retryable"),
        },
      };
  }
}
