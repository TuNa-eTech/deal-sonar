// Port of crates/rules/src/extractors/phone.rs.

import { formatDomesticPhone, type ExtractionMatch } from "../types";
import { isAlphanumericChar } from "../normalize";

const URL_SPAN_RE = /(?:https?:\/\/|www\.)\S+/gi;
const PHONE_CANDIDATE_RE =
  /(?:\+[ \t]*84(?:[ \t]*\([ \t]*[0oO][ \t]*\))?[ \t.\-_()]*[235789]|84[ \t.\-_()]*[235789]|[0oO][ \t.\-_()]*[235789])(?:[ \t.\-_()]*[0-9oO]){7,10}/g;

const isAsciiDigit = (c: string | undefined): boolean => c !== undefined && c.length === 1 && c >= "0" && c <= "9";
const SEPARATORS = new Set([" ", ".", "-", "_", "(", ")"]);

function charBefore(text: string, idx: number): string | null {
  if (idx <= 0) return null;
  const lo = text.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) return text.slice(idx - 2, idx);
  return text[idx - 1];
}
function charAt(text: string, idx: number): string | null {
  if (idx >= text.length) return null;
  return String.fromCodePoint(text.codePointAt(idx)!);
}
const isRustWhitespace = (c: string): boolean => /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(c);

function extractImpl(text: string, firstOnly: boolean): ExtractionMatch[] {
  if (text.length < 9) return [];
  const matches: ExtractionMatch[] = [];
  let urls: Array<[number, number]> | null = null;

  PHONE_CANDIDATE_RE.lastIndex = 0;
  for (let m = PHONE_CANDIDATE_RE.exec(text); m; m = PHONE_CANDIDATE_RE.exec(text)) {
    let start = m.index;
    let end = m.index + m[0].length;

    if (urls === null) {
      urls = [];
      if (/http|HTTP|www\.|WWW\./.test(text)) {
        URL_SPAN_RE.lastIndex = 0;
        for (let u = URL_SPAN_RE.exec(text); u; u = URL_SPAN_RE.exec(text)) {
          urls.push([u.index, u.index + u[0].length]);
        }
      }
    }
    if (urls.some(([us, ue]) => start < ue && end > us)) continue;

    while (end > start) {
      const last = text[end - 1];
      if (isAsciiDigit(last) || last === "o" || last === "O") break;
      end -= 1;
    }
    while (start < end) {
      const first = charAt(text, start)!;
      if (isRustWhitespace(first)) start += first.length;
      else break;
    }
    if (start >= end) continue;

    if (start > 0) {
      const prev = charBefore(text, start);
      if (prev !== null) {
        const startsWithPlus = text[start] === "+";
        if (isAlphanumericChar(prev) && !startsWithPlus) continue;
        if ((prev === "/" || prev === ".") && start >= 2) {
          const prev2 = charBefore(text, start - prev.length);
          if (prev2 !== null && isAlphanumericChar(prev2)) continue;
        }
      }
    }

    if (end < text.length) {
      const next = charAt(text, end)!;
      if (isAlphanumericChar(next)) continue;
      if ((next === "." || next === ",") && isAsciiDigit(text[end + 1])) continue;
    }

    const rawSlice = text.slice(start, end);
    const parsed = parseVnPhoneCandidate(rawSlice);
    if (parsed) {
      matches.push({
        value: parsed.e164,
        raw: rawSlice,
        start,
        end,
        confidence: parsed.hadLetterO ? 0.9 : 0.98,
      });
      if (firstOnly) return matches;
    }
  }
  return matches;
}

/** Extract all Vietnamese phone numbers, normalized to E.164 (`+84...`). */
export function extractVnPhone(textNorm: string): ExtractionMatch[] {
  return extractImpl(textNorm, false);
}

export function extractVnPhoneFirst(textNorm: string): ExtractionMatch | null {
  return extractImpl(textNorm, true)[0] ?? null;
}

export function normalizeVnPhoneStr(raw: string): string | null {
  return parseVnPhoneCandidate(raw.trim())?.e164 ?? null;
}

function parseVnPhoneCandidate(raw: string): { e164: string; hadLetterO: boolean } | null {
  let letterOCount = 0;
  const chars = Array.from(raw);
  for (let idx = 0; idx < chars.length; idx += 1) {
    const ch = chars[idx];
    if (ch === "o" || ch === "O") {
      letterOCount += 1;
      let before = false;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (!SEPARATORS.has(chars[i])) {
          before = isAsciiDigit(chars[i]);
          break;
        }
      }
      let after = false;
      for (let i = idx + 1; i < chars.length; i += 1) {
        if (!SEPARATORS.has(chars[i])) {
          after = isAsciiDigit(chars[i]);
          break;
        }
      }
      if (!before && !after) return null;
    }
  }
  if (letterOCount > 3) return null;

  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = "";
  for (const ch of trimmed) {
    if (isAsciiDigit(ch)) digits += ch;
    else if (ch === "o" || ch === "O") digits += "0";
    else if (ch === "+" || SEPARATORS.has(ch)) continue;
    else return null;
  }

  let domestic: string;
  if (hasPlus) {
    if (!digits.startsWith("84")) return null;
    let rest = digits.slice(2);
    if (rest.startsWith("0")) rest = rest.slice(1);
    domestic = `0${rest}`;
  } else if (digits.startsWith("84") && (digits.length === 11 || digits.length === 12)) {
    const cand = `0${digits.slice(2)}`;
    domestic = isValidDomesticVnPhone(cand) ? cand : digits;
  } else {
    domestic = digits;
  }
  if (!isValidDomesticVnPhone(domestic)) return null;
  return { e164: `+84${domestic.slice(1)}`, hadLetterO: letterOCount > 0 };
}

function isValidDomesticVnPhone(d: string): boolean {
  if (!d.startsWith("0") || !/^[0-9]+$/.test(d)) return false;
  if (d.length === 10) {
    const b1 = d[1];
    const b2 = d[2];
    switch (b1) {
      case "3": return b2 >= "2" && b2 <= "9";
      case "5": return "25689".includes(b2);
      case "7": return "06789".includes(b2);
      case "8": return b2 >= "1" && b2 <= "9";
      case "9": return true;
      case "2": return true;
      default: return false;
    }
  }
  if (d.length === 11) return d[1] === "2";
  return false;
}

export function toDomesticPhone(e164: string): string {
  return formatDomesticPhone(e164);
}
