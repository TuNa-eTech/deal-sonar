// Port of crates/rules/src/extractors/area.rs.

import { foldWithSpans, type FoldedText } from "../normalize";
import { hasAlnumAt } from "../prefilter";
import type { ExtractionMatch, RangeValue } from "../types";

const AREA_RANGE_RE =
  /^(?<n1>\d+(?:[.,]\d+)?)\s*(?:m2|met\s+vuong|m\s+vuong)?\s*(?:-|den|toi|~)\s*(?<n2>\d+(?:[.,]\d+)?)\s*(?:m2|met\s+vuong|m\s+vuong)\b/;
const AREA_DIM_RE =
  /^(?<w>\d+m\d+|\d+(?:[.,]\d+)?)(?:\s*(?<wu>m|met))?\s*x\s*(?<l>\d+m\d+|\d+(?:[.,]\d+)?)(?:\s*(?<lu>m2|m|met))?\b/;
const AREA_SINGLE_RE = /^(?<n>\d+(?:[.,]\d+)?)\s*(?:m2|met\s+vuong|m\s+vuong)\b/;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAlnum = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function hasAreaCue(tf: string): boolean {
  if (tf.includes("m2") || tf.includes("vuong")) return true;
  const len = tf.length;
  let from = 0;
  for (;;) {
    const x = tf.indexOf("x", from);
    if (x < 0) return false;
    let r = x + 1;
    while (r < len && tf[r] === " ") r += 1;
    if (r < len && isDigit(tf.charCodeAt(r)) && x > 0) {
      let l = x;
      while (l > 0 && tf[l - 1] === " ") l -= 1;
      if (l > 0) {
        const lb = tf.charCodeAt(l - 1);
        if (isDigit(lb) || lb === 0x6d || lb === 0x74) return true;
      }
    }
    from = x + 1;
  }
}

export function extractVnArea(textNorm: string): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  return extractVnAreaFromFolded(textNorm, foldWithSpans(textNorm), false);
}

export function extractVnAreaFromFolded(textNorm: string, folded: FoldedText, firstOnly: boolean): ExtractionMatch[] {
  const tf = folded.text_fold;
  const len = tf.length;
  if (len < 2 || !hasAreaCue(tf)) return [];

  const hits: Array<[number, number, RangeValue, number]> = [];
  let minPos = 0;
  for (const d of folded.digitStarts()) {
    if (d < minPos) continue;
    const tail = tf.slice(d, Math.min(d + 96, len));
    const afterNum = skipNumberToken(tail);
    let ws = afterNum;
    while (ws < tail.length && tail[ws] === " ") ws += 1;
    const after = tail.slice(ws);
    const b0 = after.length > 0 ? after.charCodeAt(0) : 0;
    const b1 = after.length > 1 ? after.charCodeAt(1) : 0;

    const isMUnit = b0 === 0x6d && (b1 === 0x32 || b1 === 0x65 || b1 === 0x20 || isDigit(b1) || !isAlnum(b1));
    const isXDim = b0 === 0x78;
    const isRangeConn = b0 === 0x2d || b0 === 0x7e || after.startsWith("den ") || after.startsWith("toi ");
    if (!isMUnit && !isXDim && !isRangeConn) {
      minPos = d + Math.max(afterNum, 1);
      continue;
    }

    const canMatchRange =
      (isRangeConn ||
        (isMUnit && (after.includes("-") || after.includes("~") || after.includes(" den ") || after.includes(" toi ")))) &&
      after.includes("m");

    if (canMatchRange) {
      const m = AREA_RANGE_RE.exec(tail);
      if (m?.groups) {
        const absEnd = d + m[0].length;
        if (!hasAlnumAt(tf, absEnd)) {
          const v1 = parseDimNumber(m.groups.n1);
          const v2 = parseDimNumber(m.groups.n2);
          if (v1 !== null && v2 !== null && v1 > 0 && v2 > 0) {
            const [minV, maxV] = v1 <= v2 ? [v1, v2] : [v2, v1];
            hits.push([d, absEnd, { min: round2(minV), max: round2(maxV), unit: "m2" }, 0.96]);
            if (firstOnly) break;
            minPos = absEnd;
            continue;
          }
        }
      }
    }

    if (isXDim || (isMUnit && after.includes("x"))) {
      const m = AREA_DIM_RE.exec(tail);
      if (m?.groups) {
        const absEnd = d + m[0].length;
        if (!hasAlnumAt(tf, absEnd)) {
          const wStr = m.groups.w;
          const lStr = m.groups.l;
          const w = parseDimNumber(wStr);
          const l = parseDimNumber(lStr);
          if (w !== null && l !== null) {
            const explicit =
              m.groups.wu !== undefined || m.groups.lu !== undefined || wStr.includes("m") || lStr.includes("m");
            const product = round2(w * l);
            if (w > 0.5 && w <= 500 && l > 0.5 && l <= 1000 && (explicit || product >= 6)) {
              hits.push([d, absEnd, { min: product, max: product, unit: "m2" }, explicit ? 0.94 : 0.88]);
              if (firstOnly) break;
              minPos = absEnd;
              continue;
            }
          }
        }
      }
    }

    if (isMUnit) {
      const m = AREA_SINGLE_RE.exec(tail);
      if (m) {
        const absEnd = d + m[0].length;
        if (!hasAlnumAt(tf, absEnd)) {
          const s = m[0];
          let numEnd = 0;
          while (numEnd < s.length && (isDigit(s.charCodeAt(numEnd)) || s[numEnd] === "." || s[numEnd] === ",")) numEnd += 1;
          const val = parseDimNumber(s.slice(0, numEnd));
          if (val !== null && val > 0) {
            const v = round2(val);
            hits.push([d, absEnd, { min: v, max: v, unit: "m2" }, 0.96]);
            if (firstOnly) break;
            minPos = absEnd;
            continue;
          }
        }
      }
    }
  }

  hits.sort((a, b) => a[0] - b[0]);
  const out: ExtractionMatch[] = [];
  for (const [s, e, val, conf] of hits) {
    const span = folded.mapSpan(s, e);
    if (!span) continue;
    out.push({ value: val, raw: textNorm.slice(span[0], span[1]), start: span[0], end: span[1], confidence: conf });
  }
  return out;
}

function strictFloat(s: string): number | null {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(s) ? Number(s) : null;
}

export function parseDimNumber(s: string): number | null {
  const i = s.indexOf("m");
  if (i >= 0) {
    const w = strictFloat(s.slice(0, i));
    const f = strictFloat(s.slice(i + 1));
    if (w === null || f === null) return null;
    return w + f / 10 ** s.slice(i + 1).length;
  }
  return strictFloat(s.replace(",", "."));
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function skipNumberToken(s: string): number {
  let i = 0;
  while (i < s.length && isDigit(s.charCodeAt(i))) i += 1;
  if (i + 1 < s.length && (s[i] === "." || s[i] === ",") && isDigit(s.charCodeAt(i + 1))) {
    i += 1;
    while (i < s.length && isDigit(s.charCodeAt(i))) i += 1;
  }
  return i;
}
