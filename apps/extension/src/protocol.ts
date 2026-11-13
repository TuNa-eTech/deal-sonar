// Protocol v2 between Chrome extension and DealSonar desktop app.
// Mirror of `crates/protocol` & `docs/specs/01-protocol.md` — keep in sync.

export const PROTOCOL_VERSION = 2;

/** Native messaging host name; must match the host manifest. */
export const NATIVE_HOST = "com.dealsonar.host";

/** Chrome Native Messaging frame limits (`01-protocol.md §1`). */
export const MAX_HOST_TO_EXT_BYTES = 1_048_576; // 1 MiB
export const MAX_EXT_TO_HOST_BYTES = 67_108_864; // 64 MiB

/** Outbound `posts.push` chunking limits (`01-protocol.md §5`). */
export const MAX_PUSH_POSTS = 100;
export const MAX_PUSH_BYTES = 512 * 1024; // 512 KB UTF-8 encoded

// ── ULID Generator (Crockford's Base32, 48-bit ms timestamp + 80-bit monotonic randomness) ──

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

let lastUlidTime = -1;
let lastRandomBytes = new Uint8Array(10);

function fillRandomBytes(buf: Uint8Array): void {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf);
    return;
  }
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
}

function incrementBytes(buf: Uint8Array): boolean {
  for (let i = buf.length - 1; i >= 0; i--) {
    const val = buf[i]!;
    if (val < 255) {
      buf[i] = val + 1;
      return true;
    }
    buf[i] = 0;
  }
  return false;
}

function encodeTime48(timeMs: number): string {
  let t = Math.max(0, Math.floor(timeMs));
  // Clamp to max 48-bit unsigned int
  if (t > 0xffffffffffff) {
    t = 0xffffffffffff;
  }
  const chars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    chars[i] = CROCKFORD_ALPHABET[mod]!;
    t = (t - mod) / 32;
  }
  return chars.join("");
}

function encodeRandom80(bytes: Uint8Array): string {
  // 10 bytes = 80 bits = 16 Base32 characters (each 5 bits)
  const chars = new Array<string>(16);
  // Process two 40-bit groups (5 bytes -> 8 chars each) to avoid JS 32-bit bitwise truncation
  for (let group = 0; group < 2; group++) {
    const offset = group * 5;
    let value =
      bytes[offset]! * 0x100000000 +
      bytes[offset + 1]! * 0x1000000 +
      bytes[offset + 2]! * 0x10000 +
      bytes[offset + 3]! * 0x100 +
      bytes[offset + 4]!;
    for (let j = 7; j >= 0; j--) {
      const mod = value % 32;
      chars[group * 8 + j] = CROCKFORD_ALPHABET[mod]!;
      value = (value - mod) / 32;
    }
  }
  return chars.join("");
}

/** Generate a monotonic 26-character Crockford Base32 ULID. */
export function generateUlid(nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs);
  const random = new Uint8Array(10);
  if (ts === lastUlidTime) {
    random.set(lastRandomBytes);
    if (!incrementBytes(random)) {
      fillRandomBytes(random);
    }
  } else {
    fillRandomBytes(random);
    lastUlidTime = ts;
  }
  lastRandomBytes = random;
  return encodeTime48(ts) + encodeRandom80(random);
}

/** Reset monotonic ULID state (useful in tests with fake clocks jumping backwards). */
export function resetUlidState(): void {
  lastUlidTime = -1;
  lastRandomBytes = new Uint8Array(10);
}

export function isValidUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}

// ── Shared Data Types (`01-protocol.md §4.3`) ──

export type Platform = "facebook";
export type SourceKind = "group";
export type SourcePrivacy = "public" | "private";

export type SourceRef = {
  platform: Platform;
  kind: SourceKind;
  external_id: string;
};

export type SourceInfo = SourceRef & {
  name: string;
  url: string;
  privacy?: SourcePrivacy;
  member_count?: number;
};

export type AuthorInfo = {
  external_id?: string;
  name: string;
  is_anonymous: boolean;
};

export type AttachmentKind = "photo" | "video" | "link" | "other";

export type Attachment = {
  kind: AttachmentKind;
  url?: string;
  alt?: string;
};

export type PostCounts = {
  comments?: number;
  reactions?: number;
};

export type ExtractionStrategy = "network" | "embedded" | "dom";

export type ExtractionInfo = {
  strategy: ExtractionStrategy;
  profile_rev: number;
};

export type RawPost = {
  platform: Platform;
  post_id: string;
  source_external_id: string;
  permalink: string;
  author: AuthorInfo;
  text: string;
  text_truncated: boolean;
  created_at?: number;
  captured_at: number;
  attachments: Attachment[];
  counts?: PostCounts;
  extraction: ExtractionInfo;
};

export type SessionState =
  | "ok"
  | "logged_out"
  | "checkpoint"
  | "rate_limited"
  | "unknown";

export type CrawlStatus = "ok" | "empty" | "blocked" | "error";

export type CrawlReason = "scheduled" | "manual" | "preview" | "passive";

export type CrawlPlanEntry = {
  source_ref: SourceRef;
  interval_s: number;
  priority: number;
  max_posts_per_visit: number;
};

export type CrawlPlan = {
  entries: CrawlPlanEntry[];
};

export type ActiveHours = {
  from: string;
  to: string;
};

export type CrawlPolicy = {
  max_loads_per_hour: number;
  max_loads_per_day: number;
  active_hours: ActiveHours;
  jitter: number;
  max_scroll_steps: number;
  only_when_idle: boolean;
};

export type ExtractorProfile = {
  rev: number;
  strategies: ExtractionStrategy[];
  network: unknown;
  dom: unknown;
  session_markers: unknown;
};

export type ErrorCode =
  | "protocol_mismatch"
  | "unknown_type"
  | "invalid_payload"
  | "desktop_unavailable"
  | "busy"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "protocol_mismatch",
  "unknown_type",
  "invalid_payload",
  "desktop_unavailable",
  "busy",
  "internal",
];

// ── Message Payloads (`01-protocol.md §4.1 & §4.2`) ──

export type EmptyPayload = Record<string, never>;

// Extension -> Desktop
export type HelloPayload = {
  profile_id: string;
  ext_version: string;
  browser: string;
  config_rev: number;
};

export type PostsPushPayload = {
  run_id: string;
  source_ref: SourceRef;
  posts: RawPost[];
};

export type CrawlReportPayload = {
  run_id: string;
  source_ref: SourceRef;
  reason: CrawlReason;
  status: CrawlStatus;
  started_at: number;
  ended_at: number;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy?: ExtractionStrategy;
  error?: string;
  dropped_posts?: number;
};

export type SourcesDiscoveredPayload = {
  sources: SourceInfo[];
  follow?: boolean;
};

export type SessionStatusPayload = {
  runtime?: { automatic_scanning:boolean; paused:boolean; next_crawl_at:number|null; last_crawl_at:number|null };
  platform: Platform;
  state: SessionState;
  detail?: string;
};

export type PingPayload = EmptyPayload;

// Desktop -> Extension
export type HelloOkPayload = {
  desktop_version: string;
  config_rev: number;
};

export type ConfigUpdatePayload = {
  rev: number;
  plan: CrawlPlan;
  policy: CrawlPolicy;
  extractor: ExtractorProfile;
};

export type CrawlRequestPayload = {
  request_id: string;
  source_ref: SourceRef;
  reason: "manual" | "preview";
  max_posts: number;
};

export type CrawlPausePayload = {
  until: number | null;
  reason: string;
};

export type CrawlResumePayload = EmptyPayload;

export type AckPayload = {
  accepted: number;
  duplicates: number;
};

export type PongPayload = EmptyPayload;

export type ErrorPayload = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
};

export interface ExtToDesktopPayloadMap {
  "hello": HelloPayload;
  "posts.push": PostsPushPayload;
  "crawl.report": CrawlReportPayload;
  "sources.discovered": SourcesDiscoveredPayload;
  "session.status": SessionStatusPayload;
  "ping": PingPayload;
  "error": ErrorPayload;
}

export interface DesktopToExtPayloadMap {
  "hello.ok": HelloOkPayload;
  "config.update": ConfigUpdatePayload;
  "crawl.request": CrawlRequestPayload;
  "crawl.pause": CrawlPausePayload;
  "crawl.resume": CrawlResumePayload;
  "ack": AckPayload;
  "pong": PongPayload;
  "error": ErrorPayload;
}

export type ProtocolPayloadMap = ExtToDesktopPayloadMap & DesktopToExtPayloadMap;
export type ExtMessageType = keyof ExtToDesktopPayloadMap;
export type DesktopMessageType = keyof DesktopToExtPayloadMap;
export type MessageType = keyof ProtocolPayloadMap;

export type EnvelopeOf<K extends MessageType> = {
  [M in K]: {
    v: number;
    id: string;
    ts: number;
    reply_to: string | null;
    type: M;
    payload: ProtocolPayloadMap[M];
  };
}[K];

/**
 * Protocol v2 wire envelope (`01-protocol.md §2`):
 * `{"v": 2, "id": "...", "ts": 1794384000000, "reply_to": null, "type": "posts.push", "payload": {...}}`
 *
 * Accepts either a `MessageType` key (`Envelope<"posts.push">`), a custom payload type,
 * or no type argument (`Envelope`, which is the discriminated union of all messages).
 */
export type Envelope<T = MessageType> = T extends MessageType
  ? EnvelopeOf<T>
  : {
      v: number;
      id: string;
      ts: number;
      reply_to: string | null;
      type: string;
      payload: T;
    };

export type ExtEnvelope<K extends ExtMessageType = ExtMessageType> = EnvelopeOf<K>;
export type DesktopEnvelope<K extends DesktopMessageType = DesktopMessageType> = EnvelopeOf<K>;

export type OutboundDurableType = "posts.push" | "crawl.report" | "sources.discovered";
export type DurableEnvelope = ExtEnvelope<OutboundDurableType>;

// ── Envelope Builders & Validators ──

export function createEnvelope<K extends MessageType>(
  type: K,
  payload: ProtocolPayloadMap[K],
  options?: { id?: string; ts?: number; reply_to?: string | null },
): EnvelopeOf<K> {
  const ts = options?.ts ?? Date.now();
  const id = options?.id ?? generateUlid(ts);
  return {
    v: PROTOCOL_VERSION,
    id,
    ts,
    reply_to: options?.reply_to ?? null,
    type,
    payload,
  } as EnvelopeOf<K>;
}

export function replyEnvelope<K extends MessageType>(
  replyTo: string,
  type: K,
  payload: ProtocolPayloadMap[K],
  options?: { id?: string; ts?: number },
): EnvelopeOf<K> {
  return createEnvelope(type, payload, {
    id: options?.id,
    ts: options?.ts,
    reply_to: replyTo,
  });
}

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string | unknown): number {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return textEncoder.encode(str).byteLength;
}

const DESKTOP_MESSAGE_TYPES = new Set<DesktopMessageType>([
  "hello.ok",
  "config.update",
  "crawl.request",
  "crawl.pause",
  "crawl.resume",
  "ack",
  "pong",
  "error",
]);

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isSourceRef(val: unknown): val is SourceRef {
  return (
    isRecord(val) &&
    val.platform === "facebook" &&
    val.kind === "group" &&
    typeof val.external_id === "string" &&
    val.external_id.length > 0
  );
}

function validateDesktopPayload(type: DesktopMessageType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "hello.ok":
      if (typeof payload.desktop_version !== "string" || typeof payload.config_rev !== "number") {
        return "hello.ok requires desktop_version (string) and config_rev (number)";
      }
      return null;
    case "config.update":
      if (
        typeof payload.rev !== "number" ||
        !isRecord(payload.plan) ||
        !Array.isArray(payload.plan.entries) ||
        !isRecord(payload.policy) ||
        !isRecord(payload.extractor)
      ) {
        return "config.update requires rev, plan.entries, policy, and extractor";
      }
      return null;
    case "crawl.request":
      if (
        typeof payload.request_id !== "string" ||
        !isSourceRef(payload.source_ref) ||
        (payload.reason !== "manual" && payload.reason !== "preview") ||
        typeof payload.max_posts !== "number"
      ) {
        return "crawl.request requires request_id, source_ref, reason, and max_posts";
      }
      return null;
    case "crawl.pause":
      if (
        (payload.until !== null && typeof payload.until !== "number") ||
        typeof payload.reason !== "string"
      ) {
        return "crawl.pause requires until (number|null) and reason (string)";
      }
      return null;
    case "crawl.resume":
    case "pong":
      return null;
    case "ack":
      if (typeof payload.accepted !== "number" || typeof payload.duplicates !== "number") {
        return "ack requires accepted (number) and duplicates (number)";
      }
      return null;
    case "error":
      if (
        typeof payload.code !== "string" ||
        !ERROR_CODES.includes(payload.code as ErrorCode) ||
        typeof payload.message !== "string" ||
        typeof payload.retryable !== "boolean"
      ) {
        return "error requires valid code, message, and retryable";
      }
      return null;
  }
}

export type ParseEnvelopeResult =
  | { ok: true; envelope: DesktopEnvelope }
  | { ok: false; code: ErrorCode; message: string; id: string | null };

/**
 * Parse and validate an incoming Desktop -> Extension message per `01-protocol.md §3`:
 * - Unknown fields inside `payload` are ignored.
 * - `v !== 2` -> `protocol_mismatch`
 * - Unknown `type` -> `unknown_type`
 * - Malformed envelope or payload -> `invalid_payload`
 */
export function parseDesktopEnvelope(raw: unknown): ParseEnvelopeResult {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        code: "invalid_payload",
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        id: null,
      };
    }
  }

  if (!isRecord(obj)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Envelope must be a JSON object",
      id: null,
    };
  }

  const incomingId = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : null;

  if (typeof obj.v !== "number") {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Envelope missing numeric protocol version 'v'",
      id: incomingId,
    };
  }

  if (obj.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol_mismatch",
      message: `Unsupported protocol version ${obj.v}, expected ${PROTOCOL_VERSION}`,
      id: incomingId,
    };
  }

  if (
    !incomingId ||
    typeof obj.ts !== "number" ||
    (obj.reply_to !== null && obj.reply_to !== undefined && typeof obj.reply_to !== "string") ||
    typeof obj.type !== "string"
  ) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Envelope missing required header fields (id, ts, type)",
      id: incomingId,
    };
  }

  if (!DESKTOP_MESSAGE_TYPES.has(obj.type as DesktopMessageType)) {
    return {
      ok: false,
      code: "unknown_type",
      message: `Unknown message type '${obj.type}'`,
      id: incomingId,
    };
  }

  if (!isRecord(obj.payload)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: `Payload for '${obj.type}' must be an object`,
      id: incomingId,
    };
  }

  const msgType = obj.type as DesktopMessageType;
  const payloadErr = validateDesktopPayload(msgType, obj.payload);
  if (payloadErr) {
    return {
      ok: false,
      code: "invalid_payload",
      message: payloadErr,
      id: incomingId,
    };
  }

  return {
    ok: true,
    envelope: {
      v: obj.v,
      id: incomingId,
      ts: obj.ts,
      reply_to: (obj.reply_to as string | null | undefined) ?? null,
      type: msgType,
      payload: obj.payload as DesktopToExtPayloadMap[typeof msgType],
    } as DesktopEnvelope,
  };
}
