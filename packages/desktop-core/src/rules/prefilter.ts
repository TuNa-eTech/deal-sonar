// Port of crates/rules/src/prefilter.rs (T3 basic prefilter, blocklist matching).

import { extractVnPhone, normalizeVnPhoneStr } from "./extractors/phone";
import { foldText, isAlphanumericChar } from "./normalize";

export const PREFILTER_MIN_CHARS_NO_MEDIA = 15;

export type BlocklistKind = "author" | "phone" | "keyword";
export interface BlocklistEntry {
  kind: BlocklistKind;
  value: string;
}

/** `Blocked(kind)` | `TooShort` | `UrlOnly` | `RulesetPrefilter`. */
export type PrefilterRejectReason =
  | { kind: "blocked"; blocklist: BlocklistKind }
  | { kind: "too_short" }
  | { kind: "url_only" }
  | { kind: "ruleset_prefilter" };

/** Canonical `evaluations.reject_reason` string. */
export function asDbRejectReason(reason: PrefilterRejectReason): "blocked" | "prefilter" {
  return reason.kind === "blocked" ? "blocked" : "prefilter";
}

export interface BasicPrefilterInput {
  author_id: string | null;
  text_norm: string;
  text_fold: string;
  has_attachments: boolean;
}

/** Rust `str::trim` (Unicode White_Space). */
export function rustTrim(s: string): string {
  return s.replace(/^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "").replace(
    /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/,
    "",
  );
}

export function isTooShort(textNorm: string, hasAttachments: boolean): boolean {
  const trimmed = rustTrim(textNorm);
  if (trimmed.length === 0) return true;
  return !hasAttachments && Array.from(trimmed).length < PREFILTER_MIN_CHARS_NO_MEDIA;
}

const BARE_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|vn|net|org|io|me|ly|be|co|info|gg|app|link|shop|xyz|online|store|site|top|watch|edu|gov|asia|biz|tv|cc|gl)(?:\/\S*)?$/i;

export function isUrlOnly(textNorm: string): boolean {
  const trimmed = rustTrim(textNorm);
  if (trimmed.length === 0) return false;
  let count = 0;
  for (const rawToken of trimmed.split(/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/)) {
    if (rawToken.length === 0) continue;
    let token = rawToken.replace(/^[<>()[\]{},;"']+/, "").replace(/[<>()[\]{},;"']+$/, "");
    token = token.replace(/\.+$/, "");
    if (token.length === 0) continue;
    count += 1;
    if (!isSingleUrlToken(token)) return false;
  }
  return count > 0;
}

function isSingleUrlToken(token: string): boolean {
  const lower = token.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const prefix of ["https://", "http://"]) {
    if (lower.startsWith(prefix)) {
      const rest = lower.slice(prefix.length);
      return rest.includes(".") && rest.length >= 4 && !rest.startsWith(".");
    }
  }
  if (lower.startsWith("www.")) {
    const rest = lower.slice(4);
    return rest.includes(".") && rest.length >= 4;
  }
  return BARE_DOMAIN_RE.test(token);
}

export function hasAlnumBefore(s: string, idx: number): boolean {
  if (idx <= 0) return false;
  const lo = s.charCodeAt(idx - 1);
  const ch = lo >= 0xdc00 && lo <= 0xdfff && idx >= 2 ? s.slice(idx - 2, idx) : s[idx - 1];
  return isAlphanumericChar(ch);
}

export function hasAlnumAt(s: string, idx: number): boolean {
  if (idx >= s.length) return false;
  return isAlphanumericChar(String.fromCodePoint(s.codePointAt(idx)!));
}

/** Word-boundary-aware match of an already-folded needle inside `text_fold`. */
export function kwContainsFolded(textFold: string, needleFold: string): boolean {
  const needle = rustTrim(needleFold);
  if (needle.length === 0 || needle.length > textFold.length) return false;
  const checkLeft = hasAlnumAt(needle, 0);
  const checkRight = hasAlnumBefore(needle, needle.length);
  let from = 0;
  for (;;) {
    const start = textFold.indexOf(needle, from);
    if (start < 0) return false;
    const end = start + needle.length;
    if ((!checkLeft || !hasAlnumBefore(textFold, start)) && (!checkRight || !hasAlnumAt(textFold, end))) return true;
    from = start + String.fromCodePoint(textFold.codePointAt(start)!).length;
  }
}

export function matchesBlocklistKeyword(textFold: string, keyword: string): boolean {
  return kwContainsFolded(textFold, foldText(keyword));
}

export function matchesBlocklistPhone(textNorm: string, blockedPhones: readonly string[]): boolean {
  if (blockedPhones.length === 0) return false;
  for (const m of extractVnPhone(textNorm)) {
    if (typeof m.value !== "string") continue;
    for (const blocked of blockedPhones) {
      if ((normalizeVnPhoneStr(blocked) ?? rustTrim(blocked)) === m.value) return true;
    }
  }
  return false;
}

export function matchesBlocklist(
  authorId: string | null,
  textNorm: string,
  textFold: string,
  entries: readonly BlocklistEntry[],
): BlocklistKind | null {
  if (entries.length === 0) return null;
  if (authorId !== null) {
    const aid = rustTrim(authorId);
    if (aid.length > 0 && entries.some((e) => e.kind === "author" && rustTrim(e.value) === aid)) return "author";
  }
  const phoneEntries = entries.filter((e) => e.kind === "phone");
  if (phoneEntries.length > 0) {
    for (const m of extractVnPhone(textNorm)) {
      if (typeof m.value !== "string") continue;
      for (const entry of phoneEntries) {
        if ((normalizeVnPhoneStr(entry.value) ?? rustTrim(entry.value)) === m.value) return "phone";
      }
    }
  }
  for (const entry of entries) {
    if (entry.kind === "keyword" && matchesBlocklistKeyword(textFold, entry.value)) return "keyword";
  }
  return null;
}

/** T3 steps 1-3: blocklist, too-short, url-only. */
export function runBasicPrefilter(
  input: BasicPrefilterInput,
  blocklist: readonly BlocklistEntry[],
): PrefilterRejectReason | null {
  const kind = matchesBlocklist(input.author_id, input.text_norm, input.text_fold, blocklist);
  if (kind !== null) return { kind: "blocked", blocklist: kind };
  if (isTooShort(input.text_norm, input.has_attachments)) return { kind: "too_short" };
  if (isUrlOnly(input.text_norm)) return { kind: "url_only" };
  return null;
}
