// Port of crates/notify/src/webhook.rs: URL policy, HMAC-SHA256 signing, `lead.created` payloads
// and the single-attempt signed POST used by the outbox worker.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { redactSecret } from "../secrets/types";
import { newUlid } from "../store/util";
import { NotifyError } from "./errors";
import type { NotifyExtractedField } from "./format";

/** Header carrying the HMAC-SHA256 signature. */
export const WEBHOOK_SIGNATURE_HEADER = "X-DealSonar-Signature";
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const MAX_WEBHOOK_RETRIES = 5;

const CONTROL_OR_SPACE = /[\p{Cc}\s]/u;

/**
 * User-configured webhook target: `https://<host>` or `http://localhost` / `http://127.0.0.1`.
 * Rejects userinfo spoofing (`http://localhost@evil.com`) and subdomain spoofing
 * (`http://localhost.evil.com`).
 */
export function validateWebhookUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (trimmed === "" || CONTROL_OR_SPACE.test(trimmed)) throw NotifyError.insecureWebhookUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw NotifyError.insecureWebhookUrl(rawUrl);
  }
  if (parsed.username !== "" || parsed.password !== "") throw NotifyError.insecureWebhookUrl(rawUrl);
  const host = parsed.hostname;
  if (host === "") throw NotifyError.insecureWebhookUrl(rawUrl);
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && (host.toLowerCase() === "localhost" || host === "127.0.0.1")) return parsed;
  throw NotifyError.insecureWebhookUrl(rawUrl);
}

/** `sha256=<hex>` HMAC-SHA256 over the raw body bytes. */
export function signWebhookBody(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}`;
}

/** Constant-time verification of `X-DealSonar-Signature: sha256=<hex>`. */
export function verifyWebhookSignature(secret: string, body: Uint8Array | string, signatureHeader: string): boolean {
  const trimmed = signatureHeader.trim();
  if (!trimmed.startsWith("sha256=")) return false;
  const hex = trimmed.slice("sha256=".length);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest();
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Retry backoff seconds for `priorAttempts` (`0..5`). */
export function webhookRetryBackoffS(priorAttempts: number): number | null {
  switch (priorAttempts) {
    case 0:
      return 10;
    case 1:
      return 30;
    case 2:
      return 120;
    case 3:
      return 300;
    case 4:
      return 600;
    default:
      return null;
  }
}

/** `whsec_` + 48 hex chars (24 random bytes). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** Local-time RFC 3339 with seconds precision and numeric offset (`+07:00`, never `Z`). */
export function formatLocalRfc3339(tsMs: number): string | null {
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = `${sign}${pad(Math.trunc(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  const year = d.getFullYear();
  const yearText = year >= 0 && year <= 9999 ? pad(year, 4) : String(year);
  return `${yearText}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off}`;
}

export interface WebhookFieldEntry {
  value: unknown;
  raw: string;
}
export interface WebhookPostPayload {
  permalink: string;
  created_at?: string;
  source: string;
  author: string;
  text?: string;
}
export interface WebhookLeadPayload {
  id: string;
  score: number;
  summary: string;
  fields: Record<string, WebhookFieldEntry>;
  post: WebhookPostPayload;
}
export interface WebhookLeadCreatedPayload {
  event: string;
  id: string;
  created_at: string;
  radar: { id: string; name: string };
  lead: WebhookLeadPayload;
}

export interface NewLeadCreatedInput {
  eventCreatedAtMs: number;
  radarId: string;
  radarName: string;
  leadId: string;
  score: number;
  summary: string;
  extractedFields: Readonly<Record<string, NotifyExtractedField>>;
  permalink: string;
  postCreatedAtMs: number | null;
  sourceName: string;
  authorName: string;
  postText: string | null;
}

/** `lead.created` payload with a fresh ULID event id and RFC 3339 timestamps. */
export function newLeadCreatedPayload(input: NewLeadCreatedInput): WebhookLeadCreatedPayload {
  const fields: Record<string, WebhookFieldEntry> = {};
  for (const [k, v] of Object.entries(input.extractedFields)) fields[k] = { value: v.value, raw: v.raw };
  const post: WebhookPostPayload = { permalink: input.permalink, source: input.sourceName, author: input.authorName };
  if (input.postCreatedAtMs !== null) {
    post.created_at = formatLocalRfc3339(input.postCreatedAtMs) ?? "1970-01-01T00:00:00+00:00";
  }
  if (input.postText !== null) post.text = input.postText;
  // Field order mirrors the Rust struct so the signed JSON is stable.
  const ordered: WebhookPostPayload = {
    permalink: post.permalink,
    ...(post.created_at !== undefined ? { created_at: post.created_at } : {}),
    source: post.source,
    author: post.author,
    ...(post.text !== undefined ? { text: post.text } : {}),
  };
  return {
    event: "lead.created",
    id: newUlid(),
    created_at: formatLocalRfc3339(input.eventCreatedAtMs) ?? "1970-01-01T00:00:00+00:00",
    radar: { id: input.radarId, name: input.radarName },
    lead: { id: input.leadId, score: input.score, summary: input.summary, fields, post: ordered },
  };
}

export type WebhookDeliveryOutcome =
  | { kind: "sent"; status_code: number }
  | { kind: "retryable"; next_delay_s: number; reason: string }
  | { kind: "exhausted"; reason: string };

export interface WebhookClientConfig {
  timeout_ms: number;
  /** HTTP transport (defaults to the global `fetch`); tests inject a controlled endpoint. */
  fetch?: typeof fetch;
}

function classifyFailure(priorAttempts: number, reason: string): WebhookDeliveryOutcome {
  const next = webhookRetryBackoffS(priorAttempts);
  return next !== null ? { kind: "retryable", next_delay_s: next, reason } : { kind: "exhausted", reason };
}

/**
 * Webhook sender with URL policy enforcement, HMAC-SHA256 signing and a 10s timeout.
 *
 * Redirects are not followed: a redirect would re-send the signed body to a host the user never
 * configured (the Rust client follows them). A 3xx answer is treated like any other non-2xx failure.
 */
export class WebhookClient {
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;

  constructor(config: Partial<WebhookClientConfig> = {}) {
    this.timeoutMs = config.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.http = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** Validate `url`, sign the JSON body with `secret` and make one POST attempt. */
  async sendOnce(
    url: string,
    secret: string,
    payload: WebhookLeadCreatedPayload,
    priorAttempts: number,
  ): Promise<WebhookDeliveryOutcome> {
    const validated = validateWebhookUrl(url);
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      throw NotifyError.serialization((e as Error).message);
    }
    const signature = signWebhookBody(secret, body);
    try {
      const res = await this.http(validated.href, {
        method: "POST",
        headers: { "content-type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signature },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
      });
      // Drain so the socket is released.
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { kind: "sent", status_code: res.status };
      return classifyFailure(priorAttempts, `HTTP ${res.status}`);
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string } };
      let reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "request timed out" : (e?.message ?? String(err));
      if (e?.cause?.code) reason = `${reason}: ${e.cause.code}`;
      return classifyFailure(priorAttempts, redactSecret(reason, secret));
    }
  }
}
