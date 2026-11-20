// Port of crates/core/src/license.rs: offline Ed25519 license tokens and plan-limit enforcement.
//
// Token wire format: `DS1.<base64url_no_pad(payload_json)>.<base64url_no_pad(ed25519_sig_64)>`.
// The signature covers the ASCII bytes `DS1.<payload_b64>` (or, for tokens from older issuers, the
// bare `<payload_b64>`). Verification never touches the network.

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { CoreError } from "../backend/wire";
import type { Store } from "../store/store";

export const LICENSE_TOKEN_SETTING_KEY = "license.token";
export const LICENSE_LAST_VERIFIED_SETTING_KEY = "license.last_verified_at";
export const LICENSE_PREFIX = "DS1";
export const LICENSE_REVERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type PlanTier = "personal" | "pro";

export interface LicenseLimits {
  max_active_radars: number | null;
  max_followed_groups: number;
  max_fields_per_radar: number;
  allow_xlsx_export: boolean;
  allow_webhooks: boolean;
  allow_auto_rulesets: boolean;
}

export interface LicenseStatus {
  plan: PlanTier;
  licensee: string | null;
  issued_at: number | null;
  expires_at: number | null;
  is_valid: boolean;
  key_preview: string | null;
  limits: LicenseLimits;
}

export interface LicensePayload {
  plan: PlanTier;
  licensee: string;
  issued_at: number;
  expires_at: number | null;
}

export function limitsForPlan(plan: PlanTier): LicenseLimits {
  return plan === "personal"
    ? {
        max_active_radars: 2,
        max_followed_groups: 10,
        max_fields_per_radar: 12,
        allow_xlsx_export: false,
        allow_webhooks: false,
        allow_auto_rulesets: false,
      }
    : {
        max_active_radars: null,
        max_followed_groups: 50,
        max_fields_per_radar: 20,
        allow_xlsx_export: true,
        allow_webhooks: true,
        allow_auto_rulesets: true,
      };
}

export function defaultPersonalLicenseStatus(): LicenseStatus {
  return {
    plan: "personal",
    licensee: null,
    issued_at: null,
    expires_at: null,
    is_valid: true,
    key_preview: null,
    limits: limitsForPlan("personal"),
  };
}

/** Redacted preview of a token (never reveals the signature or payload). */
export function maskLicenseKey(token: string): string {
  const trimmed = token.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= 14) return "DS1.***";
  const chars = [...trimmed];
  return `${chars.slice(0, 8).join("")}…${chars.slice(-4).join("")}`;
}

// ---- strict base64 (Rust `base64` engines: canonical, padding per variant) ---------------------

function strictB64Decode(segment: string, urlSafe: boolean, padded: boolean): Buffer | null {
  const alphabet = urlSafe ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*$/;
  const body = padded ? segment.replace(/={0,2}$/, "") : segment;
  if (!alphabet.test(body)) return null;
  if (body.length % 4 === 1) return null;
  if (padded && segment.length % 4 !== 0) return null;
  const decoded = Buffer.from(body, urlSafe ? "base64url" : "base64");
  // Canonical form only: re-encoding must reproduce the input (rejects non-zero trailing bits).
  const reencoded = decoded.toString(urlSafe ? "base64url" : "base64").replace(/=+$/, "");
  return reencoded === body ? decoded : null;
}

function decodeB64Flexible(segment: string): Buffer {
  const decoded =
    strictB64Decode(segment, true, false) ??
    strictB64Decode(segment, true, true) ??
    strictB64Decode(segment, false, false) ??
    strictB64Decode(segment, false, true);
  if (!decoded) throw CoreError.licenseInvalid("định dạng base64 không hợp lệ");
  return decoded;
}

// ---- Ed25519 keys ------------------------------------------------------------------------------

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Embedded production seed (only used to derive a fallback public key, like the Rust constant). */
export const DEFAULT_PRODUCTION_SEED_FOR_PUBKEY = Buffer.from([
  0x44, 0x53, 0x31, 0x9a, 0x2c, 0x71, 0x4e, 0x88, 0x19, 0xb3, 0x5f, 0x07, 0xd2, 0x6a, 0xe1, 0x3c, 0x81, 0x0f, 0x54, 0xab, 0x90,
  0x2e, 0x77, 0xc4, 0x11, 0x68, 0xf3, 0x39, 0x5d, 0xa2, 0x08, 0xe7,
]);

const DEFAULT_PUBLIC_KEY_BYTES = Buffer.from([
  0x52, 0x4d, 0x87, 0x97, 0x07, 0xd8, 0x11, 0xeb, 0x4f, 0x7d, 0x15, 0x28, 0x37, 0x77, 0x2b, 0x1d, 0x67, 0x13, 0xb2, 0xf0, 0x6e,
  0x36, 0x70, 0x05, 0x59, 0x46, 0x3a, 0x1c, 0x15, 0x8b, 0x20, 0x3c,
]);

const P = (1n << 255n) - 19n;
const D = (() => {
  const mod = (a: bigint): bigint => ((a % P) + P) % P;
  const pow = (b: bigint, e: bigint): bigint => {
    let result = 1n;
    let base = mod(b);
    let exp = e;
    while (exp > 0n) {
      if (exp & 1n) result = mod(result * base);
      base = mod(base * base);
      exp >>= 1n;
    }
    return result;
  };
  return mod(-121665n * pow(121666n, P - 2n));
})();

function modP(a: bigint): bigint {
  return ((a % P) + P) % P;
}
function powP(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = modP(result * b);
    b = modP(b * b);
    e >>= 1n;
  }
  return result;
}

/** True when the 32 bytes decompress to a point on edwards25519 (curve25519-dalek `decompress`). */
export function isValidEdwardsPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = modP(y);
  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(D * y2 + 1n);
  if (v === 0n) return u === 0n;
  const ratio = modP(u * powP(v, P - 2n));
  if (ratio === 0n) return true;
  return powP(ratio, (P - 1n) / 2n) === 1n;
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}
function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}
function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** Production verifying key; falls back to the key derived from the embedded seed. */
export function defaultVerifyingKey(): KeyObject {
  if (isValidEdwardsPoint(DEFAULT_PUBLIC_KEY_BYTES)) return publicKeyFromRaw(DEFAULT_PUBLIC_KEY_BYTES);
  return createPublicKey(privateKeyFromSeed(DEFAULT_PRODUCTION_SEED_FOR_PUBKEY));
}

type Json = unknown;

function parsePayload(bytes: Buffer): LicensePayload {
  let value: Json;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Json;
  } catch (e) {
    throw CoreError.licenseInvalid(`nội dung bản quyền không hợp lệ: ${(e as Error).message}`);
  }
  const bad = (msg: string): CoreError => CoreError.licenseInvalid(`nội dung bản quyền không hợp lệ: ${msg}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad("invalid type: expected a map");
  const o = value as Record<string, Json>;
  if (o.plan !== "personal" && o.plan !== "pro") {
    throw bad(o.plan === undefined ? "missing field `plan`" : "unknown variant for `plan`, expected `personal` or `pro`");
  }
  if (typeof o.licensee !== "string") throw bad(o.licensee === undefined ? "missing field `licensee`" : "invalid type for `licensee`");
  if (typeof o.issued_at !== "number" || !Number.isInteger(o.issued_at)) {
    throw bad(o.issued_at === undefined ? "missing field `issued_at`" : "invalid type for `issued_at`");
  }
  let expires: number | null = null;
  if (o.expires_at !== undefined && o.expires_at !== null) {
    if (typeof o.expires_at !== "number" || !Number.isInteger(o.expires_at)) throw bad("invalid type for `expires_at`");
    expires = o.expires_at;
  }
  return { plan: o.plan, licensee: o.licensee, issued_at: o.issued_at, expires_at: expires };
}

/** Offline Ed25519 license verifier. */
export class LicenseVerifier {
  private readonly key: KeyObject;

  constructor(key: KeyObject = defaultVerifyingKey()) {
    this.key = key;
  }

  static withPublicKey(publicKeyBytes: Uint8Array): LicenseVerifier {
    if (publicKeyBytes.length !== 32 || !isValidEdwardsPoint(publicKeyBytes)) {
      throw CoreError.licenseInvalid("khoá công khai Ed25519 không hợp lệ: invalid point");
    }
    return new LicenseVerifier(publicKeyFromRaw(publicKeyBytes));
  }

  /** Cryptographically verify `DS1.<payload>.<sig>` and decode its payload. */
  verifyToken(rawToken: string): LicensePayload {
    const cleaned = [...rawToken].filter((c) => !/\s/u.test(c)).join("");
    const parts = cleaned.split(".");
    if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
      throw CoreError.licenseInvalid("mã bản quyền phải có định dạng DS1.<payload>.<signature>");
    }
    const [, payloadB64, sigB64] = parts;
    if (payloadB64 === "" || sigB64 === "") throw CoreError.licenseInvalid("thiếu nội dung hoặc chữ ký bản quyền");

    const sig = decodeB64Flexible(sigB64);
    if (sig.length !== 64) throw CoreError.licenseInvalid("chữ ký Ed25519 phải đúng 64 byte");

    const canonical = Buffer.from(`${LICENSE_PREFIX}.${payloadB64}`, "utf8");
    let verified = false;
    try {
      verified =
        cryptoVerify(null, canonical, this.key, sig) || cryptoVerify(null, Buffer.from(payloadB64, "utf8"), this.key, sig);
    } catch {
      verified = false;
    }
    if (!verified) throw CoreError.licenseInvalid("chữ ký số Ed25519 không khớp");

    const payload = parsePayload(decodeB64Flexible(payloadB64));
    if (payload.licensee.trim() === "") throw CoreError.licenseInvalid("thiếu thông tin người sở hữu bản quyền");
    if (payload.expires_at !== null && payload.expires_at <= payload.issued_at) {
      throw CoreError.licenseInvalid("thời hạn bản quyền không hợp lệ (expires_at <= issued_at)");
    }
    return payload;
  }

  /**
   * Evaluate a stored token at `nowMs`. An expired token reports `is_valid = false` and the
   * Personal plan; an unverifiable token keeps only the masked preview.
   */
  evaluateStatus(rawToken: string | null, nowMs: number): LicenseStatus {
    const token = rawToken?.trim();
    if (!token) return defaultPersonalLicenseStatus();
    const preview = maskLicenseKey(token);
    try {
      const payload = this.verifyToken(token);
      const expired = payload.expires_at !== null && nowMs >= payload.expires_at;
      return {
        plan: expired ? "personal" : payload.plan,
        licensee: payload.licensee,
        issued_at: payload.issued_at,
        expires_at: payload.expires_at,
        is_valid: !expired,
        key_preview: preview,
        limits: limitsForPlan(expired ? "personal" : payload.plan),
      };
    } catch {
      return {
        plan: "personal",
        licensee: null,
        issued_at: null,
        expires_at: null,
        is_valid: false,
        key_preview: preview,
        limits: limitsForPlan("personal"),
      };
    }
  }
}

/** Offline license signer for issuance tooling and deterministic tests. */
export class LicenseSigner {
  private readonly priv: KeyObject;
  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
    this.priv = privateKeyFromSeed(seed);
  }
  verifier(): LicenseVerifier {
    return new LicenseVerifier(createPublicKey(this.priv));
  }
  publicKeyBytes(): Buffer {
    return rawPublicKey(createPublicKey(this.priv));
  }
  sign(payload: LicensePayload): string {
    const json = JSON.stringify({
      plan: payload.plan,
      licensee: payload.licensee,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    });
    const payloadB64 = Buffer.from(json, "utf8").toString("base64url");
    const sig = cryptoSign(null, Buffer.from(`${LICENSE_PREFIX}.${payloadB64}`, "utf8"), this.priv);
    return `${LICENSE_PREFIX}.${payloadB64}.${sig.toString("base64url")}`;
  }
}

/**
 * On expiry or downgrade, pause active radars beyond `limits.max_active_radars` (newest first),
 * never deleting data. Returns the ids that were paused.
 */
export function enforcePlanLimitsOnStore(store: Store, limits: LicenseLimits, nowMs: number): string[] {
  const maxActive = limits.max_active_radars;
  if (maxActive === null) return [];
  const active = store.radars
    .list(false, nowMs)
    .filter((item) => item.radar.status === "active")
    .map((item) => item.radar);
  if (active.length <= maxActive) return [];
  active.sort(
    (a, b) =>
      a.created_at - b.created_at || a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const paused: string[] = [];
  for (const excess of active.slice(maxActive)) {
    store.radars.setStatus(excess.id, "paused", nowMs);
    paused.push(excess.id);
  }
  return paused;
}
