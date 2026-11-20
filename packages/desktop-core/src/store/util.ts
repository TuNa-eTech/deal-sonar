// Port of crates/store/src/models/util.rs: ids, time, text folding, FTS5 query,
// SimHash bands and light Vietnamese phone extraction.

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidTime = -1;
let lastUlidRandom = 0n;
const MAX_RANDOM = (1n << 80n) - 1n;

/** Generate a ULID string (monotonic within one process millisecond). */
export function newUlid(nowMs: number = Date.now()): string {
  let random: bigint;
  let time = nowMs;
  if (time <= lastUlidTime) {
    time = lastUlidTime;
    random = lastUlidRandom + 1n;
    if (random > MAX_RANDOM) {
      time += 1;
      random = randomBigInt80();
    }
  } else {
    random = randomBigInt80();
  }
  lastUlidTime = time;
  lastUlidRandom = random;
  let out = "";
  let t = BigInt(time);
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[Number(t & 31n)] + out;
    t >>= 5n;
  }
  let r = random;
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand = CROCKFORD[Number(r & 31n)] + rand;
    r >>= 5n;
  }
  return out + rand;
}

function randomBigInt80(): bigint {
  const bytes = randomBytes(10);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Current Unix timestamp in milliseconds. */
export function nowMs(): number {
  return Date.now();
}

/** Validate a dynamic radar field key against `^[a-z][a-z0-9_]{0,30}$`. */
export function isValidFieldKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,30}$/.test(key);
}

/** Split a 64-bit SimHash (signed i64 two's complement) into four 16-bit bands. */
export function simhashBands(simhash: bigint): [number, number, number, number] {
  const u = BigInt.asUintN(64, simhash);
  return [
    Number(u & 0xffffn),
    Number((u >> 16n) & 0xffffn),
    Number((u >> 32n) & 0xffffn),
    Number((u >> 48n) & 0xffffn),
  ];
}

/** Exact 64-bit Hamming distance. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// Rust `char::is_whitespace` (Unicode White_Space); differs from JS `\s` at U+0085 and U+FEFF.
export function isWhitespace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

const VI_MAP: Record<string, string> = {};
function registerVi(target: string, chars: string): void {
  for (const c of chars) VI_MAP[c] = target;
}
registerVi("a", "àáảãạăằắẳẵặâầấẩẫậÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬ");
registerVi("d", "đĐ");
registerVi("e", "èéẻẽẹêềếểễệÈÉẺẼẸÊỀẾỂỄỆ");
registerVi("i", "ìíỉĩịÌÍỈĨỊ");
registerVi("o", "òóỏõọôồốổỗộơờớởỡợÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢ");
registerVi("u", "ùúủũụưừứửữựÙÚỦŨỤƯỪỨỬỮỰ");
registerVi("y", "ỳýỷỹỵỲÝỶỸỴ");

export function mapViChar(ch: string): string {
  return VI_MAP[ch] ?? ch;
}

/** Fold Vietnamese diacritics (đ -> d), lowercase, and collapse whitespace. */
export function foldVi(input: string): string {
  let out = "";
  let prevSpace = true;
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    const mapped = mapViChar(ch);
    if (isWhitespace(mapped.codePointAt(0)!)) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
    } else {
      out += mapped.toLowerCase();
      prevSpace = false;
    }
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);
  return out;
}

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ALPHA = /\p{Alphabetic}/u;

/**
 * Sanitize user search text into a safe FTS5 MATCH expression. Returns null if there are no
 * searchable alphanumeric tokens. Expands d/đ variants per token (up to 3 positions).
 */
export function buildFts5Query(raw: string): string | null {
  const tokens: string[] = [];
  let cur = "";
  for (const ch of raw) {
    if (ALNUM.test(ch)) {
      cur += ch;
    } else if (cur) {
      tokens.push(cur);
      cur = "";
    }
  }
  if (cur) tokens.push(cur);
  const limited = tokens.slice(0, 16);
  if (limited.length === 0) return null;
  const quote = (v: string): string => `"${v.replaceAll('"', '""')}"*`;
  const parts = limited.map((tok) => {
    const variants = expandViDVariants(tok);
    if (variants.length === 1) return quote(variants[0]);
    return `(${variants.map(quote).join(" OR ")})`;
  });
  return parts.join(" AND ");
}

export function expandViDVariants(token: string): string[] {
  // Per-char lowercase (Rust `char::to_lowercase` may expand one char into several).
  const chars: string[] = [];
  for (const ch of token) for (const lc of Array.from(ch.toLowerCase())) chars.push(lc);
  const dPositions: number[] = [];
  chars.forEach((c, idx) => {
    if (c === "d" || c === "đ") dPositions.push(idx);
  });
  if (dPositions.length === 0 || dPositions.length > 3) return [chars.join("")];
  const combos = 1 << dPositions.length;
  const out: string[] = [];
  for (let mask = 0; mask < combos; mask += 1) {
    const buf = chars.slice();
    dPositions.forEach((pos, bit) => {
      buf[pos] = (mask & (1 << bit)) !== 0 ? "đ" : "d";
    });
    out.push(buf.join(""));
  }
  return out;
}

const isAsciiDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** Lightweight Vietnamese E.164 phone extractor used during post ingestion. */
export function extractE164PhonesLight(text: string): string[] {
  const results: string[] = [];
  const chars = Array.from(text);
  const len = chars.length;
  let i = 0;
  while (i < len) {
    const ch = chars[i];
    const startsPlus84 = ch === "+" && i + 2 < len && chars[i + 1] === "8" && chars[i + 2] === "4";
    const startsZero =
      ch === "0" ||
      ((ch === "o" || ch === "O") &&
        (i === 0 || !ALPHA.test(chars[i - 1])) &&
        i + 1 < len &&
        isAsciiDigit(chars[i + 1]));
    const starts84 =
      ch === "8" && i + 1 < len && chars[i + 1] === "4" && (i === 0 || !isAsciiDigit(chars[i - 1]));

    if (startsPlus84 || startsZero || starts84) {
      let digits = "";
      let j = i;
      if (startsPlus84) {
        digits += "84";
        j += 3;
      } else if (startsZero) {
        digits += "0";
        j += 1;
      } else {
        digits += "84";
        j += 2;
      }
      while (j < len && digits.length < 13) {
        const c = chars[j];
        if (isAsciiDigit(c)) {
          digits += c;
          j += 1;
        } else if (c === "." || c === "-" || c === " ") {
          if (j + 1 < len && isAsciiDigit(chars[j + 1])) j += 1;
          else break;
        } else {
          break;
        }
      }
      const trailingDigit = j < len && isAsciiDigit(chars[j]);
      if (!trailingDigit) {
        const e164 = normalizeVnDigitsToE164(digits);
        if (e164 !== null) {
          if (!results.includes(e164)) results.push(e164);
          i = j;
          continue;
        }
      }
    }
    i += 1;
  }
  return results;
}

export function normalizeVnDigitsToE164(digits: string): string | null {
  const rest = digits.startsWith("0")
    ? digits.slice(1)
    : digits.startsWith("84")
      ? digits.slice(2)
      : null;
  if (rest === null || rest.length === 0) return null;
  const first = rest[0];
  const valid =
    ("35789".includes(first) && rest.length === 9) ||
    (first === "2" && (rest.length === 9 || rest.length === 10));
  return valid ? `+84${rest}` : null;
}
