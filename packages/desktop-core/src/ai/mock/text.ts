// Text helpers shared by the deterministic mock AI engine (port of the helpers in
// crates/ai-bridge/src/adapters/mock/{extract,judge}.rs). Offline and side-effect free.

import { isAlphanumericChar } from "../../rules/normalize";

type Json = unknown;
export type JsonObject = Record<string, Json>;
export const isJsonObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

const FOLD_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["a", "àáảãạăằắẳẵặâầấẩẫậ"],
  ["e", "èéẻẽẹêềếểễệ"],
  ["i", "ìíỉĩị"],
  ["o", "òóỏõọôồốổỗộơờớởỡợ"],
  ["u", "ùúủũụưừứửữự"],
  ["y", "ỳýỷỹỵ"],
  ["d", "đ"],
];
const FOLD_MAP = new Map<string, string>();
for (const [target, chars] of FOLD_GROUPS) for (const c of chars) FOLD_MAP.set(c, target);

/**
 * Rust `fold_vi`: lower-case + strip Vietnamese diacritics (`đ` -> `d`). Unlike the rules
 * engine's `text_fold` it keeps whitespace and punctuation untouched, so keyword checks such as
 * `"want_intent): supply"` or `"sua "` behave exactly like the Rust mock. Input is NFC-normalised first
 * so decomposed Vietnamese also folds.
 */
export function foldVi(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFC").toLowerCase()) out += FOLD_MAP.get(ch) ?? ch;
  return out;
}

/** Char-wise fold of `original` with every folded char mapped back to its UTF-16 range. */
export class FoldIndex {
  private readonly folded: string[] = [];
  private readonly ranges: Array<readonly [number, number]> = [];

  constructor(private readonly original: string) {
    let idx = 0;
    for (const ch of original) {
      const end = idx + ch.length;
      for (const fc of foldVi(ch)) {
        this.folded.push(fc);
        this.ranges.push([idx, end]);
      }
      idx = end;
    }
  }

  /**
   * First whole-word occurrence of `needleFolded` (already folded). Returns the exact verbatim slice
   * of the original text, so evidence `raw` is always a substring of the post.
   */
  find(needleFolded: string): string | null {
    const needle = Array.from(needleFolded);
    if (needle.length === 0 || needle.length > this.folded.length) return null;
    const isAlnum = (c: string | undefined): boolean => c !== undefined && isAlphanumericChar(c);
    for (let start = 0; start + needle.length <= this.folded.length; start += 1) {
      let same = true;
      for (let k = 0; k < needle.length; k += 1) {
        if (this.folded[start + k] !== needle[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      const end = start + needle.length;
      const beforeOk = start === 0 || !isAlnum(this.folded[start - 1]);
      const afterOk = end === this.folded.length || !isAlnum(this.folded[end]);
      if (beforeOk && afterOk) return this.original.slice(this.ranges[start][0], this.ranges[end - 1][1]);
    }
    return null;
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Map a span returned by a rules extractor (which works on `text_norm`: NFC, collapsed whitespace)
 * back to a verbatim slice of the original text. Returns `null` when no verbatim slice exists.
 */
export function verbatimSpan(original: string, raw: string): string | null {
  if (raw === "") return null;
  if (original.includes(raw)) return raw;
  const parts = raw.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  try {
    const m = new RegExp(parts.map(escapeRegExp).join("\\s+"), "u").exec(original);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** Whitespace-collapsed summary truncated to `maxChars` Unicode scalars with a trailing `…`. */
export function buildShortSummary(text: string, maxChars: number): string {
  const clean = text.split(/\s+/).filter((p) => p.length > 0).join(" ");
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

export const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");
