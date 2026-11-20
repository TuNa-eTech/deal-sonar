// Port of crates/rules/src/extractors/enum_kw.rs. The Rust byte-mask prefilters are pure
// optimizations over exact first-word lookups, so this port keeps only the lookup table.

import { foldText, foldWithSpans, isAlphanumericChar, type FoldedText } from "../normalize";
import { hasAlnumAt, hasAlnumBefore } from "../prefilter";
import type { ExtractionMatch } from "../types";

export interface CompiledEnumPatterns {
  byFirstWord: Map<string, Array<[kw: string, enumVal: string]>>;
  other: Array<[kw: string, enumVal: string]>;
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function scanAlnumPrefix(s: string): number {
  let idx = 0;
  while (idx < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(idx)!);
    if (!isAlphanumericChar(ch)) break;
    idx += ch.length;
  }
  return idx;
}

export function compileEnumPatterns(map: Readonly<Record<string, readonly string[]>>): CompiledEnumPatterns {
  const byFirstWord = new Map<string, Array<[string, string]>>();
  const other: Array<[string, string]> = [];
  for (const enumVal of Object.keys(map).sort(cmp)) {
    for (const kw of map[enumVal]) {
      const kf = foldText(kw);
      if (kf.length === 0) continue;
      const firstLen = scanAlnumPrefix(kf);
      if (firstLen > 0) {
        const tok = kf.slice(0, firstLen);
        const bucket = byFirstWord.get(tok) ?? [];
        bucket.push([kf, enumVal]);
        byFirstWord.set(tok, bucket);
      } else {
        other.push([kf, enumVal]);
      }
    }
  }
  const order = (a: [string, string], b: [string, string]): number => byteLen(b[0]) - byteLen(a[0]) || cmp(a[1], b[1]);
  for (const bucket of byFirstWord.values()) bucket.sort(order);
  other.sort(order);
  return { byFirstWord, other };
}

export function extractEnumKw(
  textNorm: string,
  map: Readonly<Record<string, readonly string[]>>,
  multi: boolean,
): ExtractionMatch[] {
  if (textNorm.length === 0 || Object.keys(map).length === 0) return [];
  return extractEnumKwCompiled(textNorm, foldWithSpans(textNorm), compileEnumPatterns(map), multi, false);
}

/** Boolean keyword-set check (no span mapping). */
export function matchesAnyEnumKw(folded: FoldedText, patterns: CompiledEnumPatterns): boolean {
  const tf = folded.text_fold;
  if (tf.length === 0 || (patterns.byFirstWord.size === 0 && patterns.other.length === 0)) return false;
  if (patterns.byFirstWord.size > 0) {
    for (const [ws, we] of folded.words()) {
      const candidates = patterns.byFirstWord.get(tf.slice(ws, we));
      if (!candidates) continue;
      for (const [kw] of candidates) {
        const end = ws + kw.length;
        if (end <= tf.length && tf.startsWith(kw, ws)) {
          if (!hasAlnumBefore(kw, kw.length) || !hasAlnumAt(tf, end)) return true;
        }
      }
    }
  }
  return patterns.other.some(([kw]) => tf.includes(kw));
}

export function extractEnumKwCompiled(
  textNorm: string,
  folded: FoldedText,
  patterns: CompiledEnumPatterns,
  multi: boolean,
  firstOnly: boolean,
): ExtractionMatch[] {
  const tf = folded.text_fold;
  if (tf.length === 0 || (patterns.byFirstWord.size === 0 && patterns.other.length === 0)) return [];
  const chosen: Array<[number, number, string]> = [];

  if (patterns.byFirstWord.size > 0) {
    let skipUntil = 0;
    for (const [ws, we] of folded.words()) {
      if (ws < skipUntil) continue;
      const candidates = patterns.byFirstWord.get(tf.slice(ws, we));
      if (!candidates) continue;
      for (const [kw, enumVal] of candidates) {
        const end = ws + kw.length;
        if (end <= tf.length && tf.startsWith(kw, ws)) {
          if (!hasAlnumBefore(kw, kw.length) || !hasAlnumAt(tf, end)) {
            chosen.push([ws, end, enumVal]);
            skipUntil = end;
            break;
          }
        }
      }
      if (chosen.length > 0 && !multi && firstOnly && patterns.other.length === 0) break;
    }
  }

  for (const [kw, enumVal] of patterns.other) {
    let from = 0;
    for (;;) {
      const start = tf.indexOf(kw, from);
      if (start < 0) break;
      const end = start + kw.length;
      if (!chosen.some(([cs, ce]) => start < ce && end > cs)) {
        chosen.push([start, end, enumVal]);
        if (!multi) break;
      }
      from = start + 1;
    }
  }
  if (chosen.length === 0) return [];
  chosen.sort((a, b) => a[0] - b[0]);

  if (multi) {
    const distinct: string[] = [];
    let first: [number, number] | null = null;
    for (const [s, e, val] of chosen) {
      const span = folded.mapSpan(s, e);
      if (span) {
        if (first === null) first = span;
        if (!distinct.includes(val)) distinct.push(val);
      }
    }
    if (!first) return [];
    return [{ value: distinct, raw: textNorm.slice(first[0], first[1]), start: first[0], end: first[1], confidence: 0.9 }];
  }

  const out: ExtractionMatch[] = [];
  for (const [s, e, val] of chosen) {
    const span = folded.mapSpan(s, e);
    if (!span) continue;
    out.push({ value: val, raw: textNorm.slice(span[0], span[1]), start: span[0], end: span[1], confidence: 0.92 });
  }
  return out;
}
