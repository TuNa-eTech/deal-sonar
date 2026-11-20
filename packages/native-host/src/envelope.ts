/**
 * Minimal Protocol v2 envelope helpers needed by the transport layer. Full envelope
 * validation/dispatch is backend business logic; the host only extracts the incoming
 * `id` and fabricates `error` envelopes.
 */
import { randomBytes } from "node:crypto";
import {
  DESKTOP_UNAVAILABLE_MESSAGE,
  MAX_HOST_TO_EXT_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";

export type ErrorCode =
  | "protocol_mismatch"
  | "unknown_type"
  | "invalid_payload"
  | "desktop_unavailable"
  | "busy"
  | "internal";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generate a 26-char ULID (48-bit ms timestamp + 80 random bits). */
export function newUlid(nowMs: number = Date.now()): string {
  let t = nowMs;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let rand = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let tail = "";
  for (let i = 0; i < 16; i += 1) {
    tail = CROCKFORD[Number(rand & 31n)]! + tail;
    rand >>= 5n;
  }
  return time + tail;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Best-effort extraction of the top-level non-empty string `"id"` from raw frame bytes
 * (port of `extract_envelope_id`). Returns null for non-objects / invalid JSON / missing id.
 */
export function extractEnvelopeId(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface ErrorEnvelope {
  v: number;
  id: string;
  ts: number;
  reply_to: string | null;
  type: "error";
  payload: { code: ErrorCode; message: string; retryable: boolean };
}

/** Standard v2 `error` envelope (field order matches the Rust serializer). */
export function buildErrorEnvelope(
  replyTo: string | null,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): ErrorEnvelope {
  return {
    v: PROTOCOL_VERSION,
    id: newUlid(),
    ts: Date.now(),
    reply_to: replyTo,
    type: "error",
    payload: { code, message, retryable },
  };
}

/**
 * Serialized `desktop_unavailable` error replying to `incomingFrame`, guaranteed to fit the
 * host -> extension limit (falls back to `reply_to: null` for a pathologically huge `id`).
 */
export function buildDesktopUnavailableBytes(incomingFrame: Uint8Array): Buffer {
  const incomingId = extractEnvelopeId(incomingFrame);
  const bytes = Buffer.from(
    JSON.stringify(
      buildErrorEnvelope(incomingId, "desktop_unavailable", DESKTOP_UNAVAILABLE_MESSAGE, true),
    ),
    "utf8",
  );
  if (bytes.length <= MAX_HOST_TO_EXT_BYTES) return bytes;
  return Buffer.from(
    JSON.stringify(
      buildErrorEnvelope(null, "desktop_unavailable", DESKTOP_UNAVAILABLE_MESSAGE, true),
    ),
    "utf8",
  );
}
