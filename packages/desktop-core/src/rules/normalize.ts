// Port of crates/rules/src/normalize.rs (T1 normalization, T2 SimHash dedup artifacts).
//
// Offsets: Rust reports UTF-8 byte offsets; this port reports UTF-16 code-unit offsets into the
// JS strings (`text_norm.slice(start, end) === raw` holds, which is the contract extractors rely
// on). Nothing persisted depends on the unit.
//
// Known divergence: `detect_lang` uses `whatlang` trigram models in Rust. There is no equivalent
// dependency, so `detectLang` is a script + Vietnamese/English stop-word heuristic with the same
// output codes and the same `"und"` threshold. See PipelineService docs "remaining blockers".

import { createHash } from "node:crypto";

import { isWhitespace } from "../store/util";

export const NEAR_DUP_MIN_CHARS = 80;
export const NEAR_DUP_MAX_HAMMING = 3;
export const LANG_DETECT_MIN_CHARS = 20;
export const DEDUP_WINDOW_MS = 14 * 86_400_000;
export const REPOST_ALLOW_AFTER_MS = 72 * 3_600_000;

export interface NormalizedText {
  text_norm: string;
  text_fold: string;
  lang: string;
  content_hash: string;
  /** Signed 64-bit two's-complement SimHash (SQLite INTEGER). */
  simhash: bigint;
  simhash_bands: [number, number, number, number];
}

const cpOf = (ch: string): number => ch.codePointAt(0)!;

export function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

export function isZeroWidthOrInvisible(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0x20dd && cp <= 0x20e4) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** Rust `char::is_control` (general category Cc). */
export function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

const ALNUM_RE = /^[\p{Alphabetic}\p{N}]$/u;
const ALPHA_RE = /^\p{Alphabetic}$/u;
const NUMERIC_RE = /^\p{N}$/u;
/** Rust `char::is_alphanumeric`. */
export const isAlphanumericChar = (ch: string): boolean => ALNUM_RE.test(ch);
export const isAlphabeticChar = (ch: string): boolean => ALPHA_RE.test(ch);
export const isNumericChar = (ch: string): boolean => NUMERIC_RE.test(ch);

function mapEnclosedDecorativeChar(cp: number): string | null {
  if (cp >= 0x1f130 && cp <= 0x1f149) return String.fromCharCode(65 + (cp - 0x1f130));
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode(65 + (cp - 0x1f150));
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(65 + (cp - 0x1f170));
  return null;
}

function needsDecorativeNfkc(cp: number): boolean {
  return (
    (cp >= 0x1d400 && cp <= 0x1d7ff) ||
    (cp >= 0xff01 && cp <= 0xff5e) ||
    (cp >= 0x24b6 && cp <= 0x24e9) ||
    cp === 0x2102 ||
    (cp >= 0x210a && cp <= 0x2113) ||
    cp === 0x2115 ||
    (cp >= 0x2119 && cp <= 0x211d) ||
    cp === 0x2124 ||
    cp === 0x212c ||
    (cp >= 0x212f && cp <= 0x2131) ||
    (cp >= 0x2133 && cp <= 0x2134)
  );
}

/** `text_norm` (05-pipeline-rules.md §3). */
export function normalizeNfcClean(raw: string): string {
  let pre = "";
  for (const c of raw) {
    const cp = cpOf(c);
    if (isZeroWidthOrInvisible(cp)) continue;
    if (isWhitespace(cp)) {
      pre += " ";
      continue;
    }
    if (isControl(cp)) continue;
    const mapped = mapEnclosedDecorativeChar(cp);
    if (mapped !== null) {
      pre += mapped;
      continue;
    }
    if (needsDecorativeNfkc(cp)) {
      for (const kc of c.normalize("NFKC")) {
        const kcp = cpOf(kc);
        if (!isZeroWidthOrInvisible(kcp) && !isControl(kcp)) pre += isWhitespace(kcp) ? " " : kc;
      }
    } else {
      pre += c;
    }
  }
  let out = "";
  let prevSpace = true;
  for (const c of pre.normalize("NFC")) {
    if (isWhitespace(cpOf(c))) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
    } else {
      out += c;
      prevSpace = false;
    }
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);
  return out;
}

function foldSpecialLatin(c: string): string | null {
  switch (c) {
    case "đ":
    case "Đ":
    case "ð":
    case "Ð":
    case "₫":
      return "d";
    case "ł":
    case "Ł":
      return "l";
    case "ø":
    case "Ø":
      return "o";
    case "ß":
      return "ss";
    case "æ":
    case "Æ":
      return "ae";
    case "œ":
    case "Œ":
      return "oe";
    case "–":
    case "—":
    case "−":
    case "‒":
    case "―":
      return "-";
    case "×":
      return "x";
    case "’":
    case "‘":
      return "'";
    case "“":
    case "”":
      return '"';
    default:
      return null;
  }
}

const KEPT_FOLD_PUNCT = new Set([
  ".", ",", "-", "/", "+", ":", ";", "(", ")", "%", "'", '"', "?", "!", "@", "#", "&", "=", "_",
]);
export const isKeptFoldPunctuation = (c: string): boolean => KEPT_FOLD_PUNCT.has(c);

const VI_FOLD: Record<string, string> = {};
function regVi(target: string, chars: string): void {
  for (const c of chars) VI_FOLD[c] = target;
}
regVi("a", "àáảãạăằắẳẵặâầấẩẫậÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬ");
regVi("d", "đĐ");
regVi("e", "èéẻẽẹêềếểễệÈÉẺẼẸÊỀẾỂỄỆ");
regVi("i", "ìíỉĩịÌÍỈĨỊ");
regVi("o", "òóỏõọôồốổỗộơờớởỡợÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢ");
regVi("u", "ùúủũụưừứửữựÙÚỦŨỤƯỪỨỬỮỰ");
regVi("y", "ỳýỷỹỵỲÝỶỸỴ");

export class FoldedText {
  private starts: number[];
  private ends: number[];
  private wordCache: Array<[number, number]> | null = null;
  private digitCache: number[] | null = null;

  constructor(
    readonly text_fold: string,
    starts: number[],
    ends: number[],
  ) {
    this.starts = starts;
    this.ends = ends;
  }

  /** Map `[foldStart, foldEnd)` of `text_fold` to `[start, end)` of `text_norm`, trimming spaces. */
  mapSpan(foldStart: number, foldEnd: number): [number, number] | null {
    if (foldStart >= foldEnd || foldEnd > this.text_fold.length) return null;
    const t = this.text_fold;
    while (foldStart < foldEnd && t.charCodeAt(foldStart) === 0x20) foldStart += 1;
    while (foldEnd > foldStart && t.charCodeAt(foldEnd - 1) === 0x20) foldEnd -= 1;
    if (foldStart >= foldEnd) return null;
    const start = this.starts[foldStart];
    const end = this.ends[foldEnd - 1];
    if (start === undefined || end === undefined) return null;
    return start <= end ? [start, end] : null;
  }

  /** Maximal alphanumeric word spans of `text_fold`. */
  words(): ReadonlyArray<[number, number]> {
    if (!this.wordCache) {
      const out: Array<[number, number]> = [];
      const re = /[\p{Alphabetic}\p{N}]+/gu;
      for (let m = re.exec(this.text_fold); m; m = re.exec(this.text_fold)) {
        out.push([m.index, m.index + m[0].length]);
      }
      this.wordCache = out;
    }
    return this.wordCache;
  }

  /** Offsets of words whose first char is an ASCII digit. */
  digitStarts(): readonly number[] {
    if (!this.digitCache) {
      const t = this.text_fold;
      this.digitCache = this.words()
        .map(([s]) => s)
        .filter((s) => {
          const c = t.charCodeAt(s);
          return c >= 0x30 && c <= 0x39;
        });
    }
    return this.digitCache;
  }
}

/** `text_fold` with exact spans back into `text_norm` (`fold_with_spans`). */
export function foldWithSpans(textNorm: string): FoldedText {
  let fold = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let prevSpace = true;

  const push = (s: string, chunkStart: number, chunkEnd: number): void => {
    fold += s;
    for (let i = 0; i < s.length; i += 1) {
      starts.push(chunkStart);
      ends.push(chunkEnd);
    }
  };

  const len = textNorm.length;
  let pos = 0;
  while (pos < len) {
    const first = String.fromCodePoint(textNorm.codePointAt(pos)!);
    const chunkStart = pos;
    let chunkEnd = pos + first.length;
    let hasTrailing = false;
    let cluster = first;
    while (chunkEnd < len) {
      const next = textNorm.codePointAt(chunkEnd)!;
      if (!isCombiningMark(next)) break;
      hasTrailing = true;
      const nc = String.fromCodePoint(next);
      cluster += nc;
      chunkEnd += nc.length;
    }
    pos = chunkEnd;

    if (!hasTrailing) {
      const b = first.charCodeAt(0);
      if (first.length === 1 && b < 0x80) {
        if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
          push(first.toLowerCase(), chunkStart, chunkEnd);
          prevSpace = false;
        } else if (isKeptFoldPunctuation(first)) {
          push(first, chunkStart, chunkEnd);
          prevSpace = false;
        } else if (!isControl(b) && !prevSpace) {
          push(" ", chunkStart, chunkEnd);
          prevSpace = true;
        }
        continue;
      }
      const vi = VI_FOLD[first];
      if (vi !== undefined) {
        push(vi, chunkStart, chunkEnd);
        prevSpace = false;
        continue;
      }
    }

    let emitted = "";
    for (const kc of cluster.normalize("NFKC")) {
      const kcp = cpOf(kc);
      if (isZeroWidthOrInvisible(kcp) || isControl(kcp)) continue;
      const rep = foldSpecialLatin(kc);
      if (rep !== null) {
        emitted += rep;
        continue;
      }
      const enc = mapEnclosedDecorativeChar(kcp);
      if (enc !== null) {
        emitted += enc.toLowerCase();
        continue;
      }
      for (const lc of kc.toLowerCase()) {
        const rep1 = foldSpecialLatin(lc);
        if (rep1 !== null) {
          emitted += rep1;
          continue;
        }
        for (const dc of lc.normalize("NFD")) {
          if (isCombiningMark(cpOf(dc))) continue;
          const rep2 = foldSpecialLatin(dc);
          if (rep2 !== null) emitted += rep2;
          else if (isAlphanumericChar(dc) || isKeptFoldPunctuation(dc)) emitted += dc;
          else emitted += " ";
        }
      }
    }
    if (emitted.length === 0) continue;
    for (const ec of emitted) {
      if (isWhitespace(cpOf(ec))) {
        if (!prevSpace) {
          push(" ", chunkStart, chunkEnd);
          prevSpace = true;
        }
      } else {
        push(ec, chunkStart, chunkEnd);
        prevSpace = false;
      }
    }
  }

  if (fold.endsWith(" ")) {
    fold = fold.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return new FoldedText(fold, starts, ends);
}

/** Lowercase diacritic-free fold of arbitrary text (`fold_text`). */
export function foldText(input: string): string {
  return foldWithSpans(normalizeNfcClean(input)).text_fold;
}

export function simhashToI64(u: bigint): bigint {
  return BigInt.asIntN(64, u);
}
export function simhashFromI64(i: bigint): bigint {
  return BigInt.asUintN(64, i);
}
export function simhashBandsOf(u: bigint): [number, number, number, number] {
  const x = BigInt.asUintN(64, u);
  return [
    Number(x & 0xffffn),
    Number((x >> 16n) & 0xffffn),
    Number((x >> 32n) & 0xffffn),
    Number((x >> 48n) & 0xffffn),
  ];
}
export function hammingDistanceU64(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
export function isNearDuplicate(lenA: number, simA: bigint, lenB: number, simB: bigint): boolean {
  return (
    lenA >= NEAR_DUP_MIN_CHARS && lenB >= NEAR_DUP_MIN_CHARS && hammingDistanceU64(simA, simB) <= NEAR_DUP_MAX_HAMMING
  );
}

/** Lowercase hex SHA-256 of the alphabetic, non-numeric chars of `text_fold`. */
export function computeContentHash(textFold: string): string {
  let kept = "";
  for (const c of textFold) {
    const cp = cpOf(c);
    if (isWhitespace(cp) || isNumericChar(c) || !isAlphabeticChar(c)) continue;
    kept += c;
  }
  return createHash("sha256").update(kept, "utf8").digest("hex");
}

const MASK64 = (1n << 64n) - 1n;
function hashShingle64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK64;
  }
  h = ((h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  h = ((h ^ (h >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return h ^ (h >> 31n);
}

/** 64-bit Charikar SimHash over 3-word shingles of `text_fold`; returns the unsigned value. */
export function computeSimhash(textFold: string): bigint {
  const words = textFold.split(/[^\p{Alphabetic}\p{N}]/u).filter((w) => w.length > 0);
  if (words.length === 0) return 0n;
  const weights = new Array<number>(64).fill(0);
  const accumulate = (hash: bigint): void => {
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += ((hash >> BigInt(bit)) & 1n) === 1n ? 1 : -1;
    }
  };
  if (words.length < 3) {
    for (const w of words) accumulate(hashShingle64(w));
  } else {
    for (let i = 0; i + 2 < words.length; i += 1) {
      accumulate(hashShingle64(`${words[i]} ${words[i + 1]} ${words[i + 2]}`));
    }
  }
  let simhash = 0n;
  for (let bit = 0; bit < 64; bit += 1) if (weights[bit] > 0) simhash |= 1n << BigInt(bit);
  return simhash;
}

const VI_SPECIFIC = /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/giu;
const EN_STOP = new Set([
  "the", "and", "is", "are", "for", "with", "this", "that", "you", "to", "of", "in", "on", "at", "have", "will", "from", "your",
]);
const VI_STOP = new Set([
  "va", "la", "cua", "co", "can", "cho", "thue", "ban", "mua", "nha", "dat", "lien", "he", "gia", "tai", "voi", "o", "nhu", "khong", "duoc",
]);

/** Script + stop-word language heuristic (replaces `whatlang`; see file header). */
export function detectLang(textNorm: string): string {
  const chars = Array.from(textNorm);
  if (chars.length < LANG_DETECT_MIN_CHARS) return "und";
  const counts = { latin: 0, han: 0, kana: 0, hangul: 0, thai: 0, cyrillic: 0, arabic: 0, devanagari: 0, khmer: 0 };
  let letters = 0;
  for (const c of chars) {
    const cp = cpOf(c);
    if (!isAlphabeticChar(c)) continue;
    letters += 1;
    if (cp < 0x250 || (cp >= 0x1e00 && cp <= 0x1eff)) counts.latin += 1;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) counts.han += 1;
    else if (cp >= 0x3040 && cp <= 0x30ff) counts.kana += 1;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) counts.hangul += 1;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) counts.thai += 1;
    else if (cp >= 0x0400 && cp <= 0x04ff) counts.cyrillic += 1;
    else if (cp >= 0x0600 && cp <= 0x06ff) counts.arabic += 1;
    else if (cp >= 0x0900 && cp <= 0x097f) counts.devanagari += 1;
    else if (cp >= 0x1780 && cp <= 0x17ff) counts.khmer += 1;
  }
  if (letters === 0) return "und";
  if (counts.kana > 0 && counts.kana + counts.han >= counts.latin) return "ja";
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (dominant[0] !== "latin" && dominant[1] * 2 >= letters) {
    switch (dominant[0]) {
      case "han": return "zh";
      case "hangul": return "ko";
      case "thai": return "th";
      case "cyrillic": return "ru";
      case "arabic": return "ar";
      case "devanagari": return "hi";
      case "khmer": return "km";
      default: return "und";
    }
  }
  const viMarked = (textNorm.match(VI_SPECIFIC) ?? []).length;
  const tokens = foldText(textNorm).split(/[^a-z]+/).filter(Boolean);
  const viStop = tokens.filter((t) => VI_STOP.has(t)).length;
  const enStop = tokens.filter((t) => EN_STOP.has(t)).length;
  if (viMarked / Math.max(counts.latin, 1) >= 0.05 || viStop > enStop) return viMarked > 0 || viStop > 0 ? "vi" : "und";
  if (enStop > 0) return "en";
  return "und";
}

export function canonicalLangCode(code: string): string {
  switch (code.trim()) {
    case "vie": case "vi": case "vi-VN": case "vi_VN": return "vi";
    case "eng": case "en": case "en-US": case "en-GB": return "en";
    case "cmn": case "zho": case "zh": return "zh";
    case "jpn": case "ja": return "ja";
    case "kor": case "ko": return "ko";
    case "fra": case "fre": case "fr": return "fr";
    case "deu": case "ger": case "de": return "de";
    case "spa": case "es": return "es";
    case "por": case "pt": return "pt";
    case "rus": case "ru": return "ru";
    case "tha": case "th": return "th";
    default: return code.trim();
  }
}

export function normalizeText(raw: string): NormalizedText {
  const text_norm = normalizeNfcClean(raw);
  const folded = foldWithSpans(text_norm);
  const text_fold = folded.text_fold;
  const sim = computeSimhash(text_fold);
  return {
    text_norm,
    text_fold,
    lang: detectLang(text_norm),
    content_hash: computeContentHash(text_fold),
    simhash: simhashToI64(sim),
    simhash_bands: simhashBandsOf(sim),
  };
}

/** AI input truncation: >2,500 chars keep first 1,800 and last 500 (counted in code points). */
export function truncateForAi(textNorm: string): [string, boolean] {
  const chars = Array.from(textNorm);
  if (chars.length <= 2500) return [textNorm, false];
  return [`${chars.slice(0, 1800).join("")}\n…\n${chars.slice(chars.length - 500).join("")}`, true];
}
