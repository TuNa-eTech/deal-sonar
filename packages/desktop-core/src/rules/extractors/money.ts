// Port of crates/rules/src/extractors/money.rs. Offsets are UTF-16 code units (see normalize.ts).

import { foldText, foldWithSpans, type FoldedText } from "../normalize";
import { hasAlnumAt, hasAlnumBefore } from "../prefilter";
import type { ExtractionMatch, MoneyPeriod, MoneyValue } from "../types";

export const DEFAULT_MONEY_WINDOW = 40;

const UNITS = "ty|ti|toi|trieu|tr|cu|lit|nghin|ngan|ka|k";
const PERIOD =
  "(?<period>\\s*(?:\\/\\s*(?:thang|thg|th|month|mo|nam|yr|year|ngay|dem|day)|(?:moi|1|mot)\\s+(?:thang|nam|ngay|dem)))?";

const MONEY_COMPOUND_RANGE_RE = new RegExp(
  `^(?<n1>\\d+(?:[.,]\\d+)?)` +
    `(?:\\s*(?<u1>${UNITS})(?:\\s*(?<f1>\\d{1,3}))?)?` +
    `\\s*(?:-|den|toi|~)\\s*` +
    `(?<n2>\\d+(?:[.,]\\d+)?)` +
    `\\s*(?<u2>${UNITS})` +
    `(?:\\s*(?<f2>\\d{1,3})(?:\\s*(?<sub2>trieu|tr|nghin|ngan|k))?)?` +
    `${PERIOD}\\b`,
  "d",
);
const MONEY_SINGLE_RE = new RegExp(
  `^(?<n>\\d+(?:[.,]\\d+)?)\\s*(?<u>${UNITS})` +
    `(?:\\s*(?<f>\\d{1,3})(?:\\s*(?<sub>trieu|tr|nghin|ngan|k))?)?` +
    `${PERIOD}\\b`,
  "d",
);
const MONEY_GROUPED_VND_RE = new RegExp(
  `^(?<n>\\d{1,3}(?:[.,]\\d{3})+|\\d{5,12})\\s*(?<u>vnd|dong|d)${PERIOD}\\b`,
  "d",
);
const NON_MONEY_NOUN_AFTER_DIGIT_RE =
  /^\s*(?:pn|p\.ngu|phong|ngu|tang|lau|m2|m\b|met|wc|ve\s+sinh|nguoi|cho|suat|tan|kg|km|nam\b|thang\b|ngay\b|gio\b|h\b|%)/;

type Candidate = [start: number, end: number, value: MoneyValue, confidence: number];

const isAsciiAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiAlnum = (c: number): boolean => isAsciiAlpha(c) || (c >= 0x30 && c <= 0x39);
const isAsciiDigitCode = (c: number): boolean => c >= 0x30 && c <= 0x39;

export function extractVnMoney(
  textNorm: string,
  near?: readonly string[] | null,
  window?: number | null,
): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  const folded = foldWithSpans(textNorm);
  const nearFolded = (near ?? []).map((s) => foldText(s)).filter((s) => s.length > 0);
  return extractVnMoneyFromFolded(textNorm, folded, nearFolded, window ?? undefined, false);
}

export function extractVnMoneyFromFolded(
  textNorm: string,
  folded: FoldedText,
  nearFolded: readonly string[],
  window: number | undefined,
  firstOnly: boolean,
): ExtractionMatch[] {
  const tf = folded.text_fold;
  const len = tf.length;
  if (len < 2) return [];

  const raw: Candidate[] = [];
  const win = window ?? DEFAULT_MONEY_WINDOW;
  const maxKw = nearFolded.reduce((m, s) => Math.max(m, s.length), 0);
  const nearOk = (s: number, e: number): boolean =>
    nearFolded.length === 0 || minDistanceToNearKeywords(tf, s, e, nearFolded, win, maxKw) === 0;

  let minPos = 0;
  for (const base of folded.digitStarts()) {
    if (base < minPos) continue;
    const tail = tf.slice(base, Math.min(base + 128, len));
    const numTokLen = skipGroupedOrDecimalNumber(tail);
    let ws = numTokLen;
    while (ws < tail.length && tail.charCodeAt(ws) === 0x20) ws += 1;
    const after = tail.slice(ws);
    const b0 = after.length > 0 ? after.charCodeAt(0) : 0;
    const b1 = after.length > 1 ? after.charCodeAt(1) : 0;
    const b2 = after.length > 2 ? after.charCodeAt(2) : 0;
    const c = (ch: string): number => ch.charCodeAt(0);

    let isUnitPrefix = false;
    switch (b0) {
      case c("t"):
        isUnitPrefix =
          ((b1 === c("y") || b1 === c("i")) && !isAsciiAlpha(b2)) ||
          (b1 === c("o") && b2 === c("i")) ||
          (b1 === c("r") && (b2 === c("i") || !isAsciiAlpha(b2)));
        break;
      case c("c"):
        isUnitPrefix = b1 === c("u") && !isAsciiAlpha(b2);
        break;
      case c("l"):
        isUnitPrefix = b1 === c("i") && b2 === c("t");
        break;
      case c("n"):
        isUnitPrefix = b1 === c("g") && (b2 === c("h") || b2 === c("a"));
        break;
      case c("k"):
        isUnitPrefix = (b1 === c("a") && !isAsciiAlpha(b2)) || !isAsciiAlnum(b1);
        break;
      default:
        isUnitPrefix = false;
    }
    const isRangeConnector = b0 === c("-") || b0 === c("~") || after.startsWith("den ") || after.startsWith("toi ");
    const isVndPrefix =
      numTokLen >= 5 && ((b0 === c("v") && b1 === c("n")) || (b0 === c("d") && (b1 === c("o") || !isAsciiAlnum(b1))));

    if (!isUnitPrefix && !isRangeConnector && !isVndPrefix) {
      minPos = base + Math.max(numTokLen, 1);
      continue;
    }

    const canHaveRange =
      isRangeConnector ||
      (isUnitPrefix && (after.includes("-") || after.includes("~") || after.includes(" den ") || after.includes(" toi ")));

    // 1. Compound ranges.
    if (canHaveRange) {
      const m = MONEY_COMPOUND_RANGE_RE.exec(tail);
      if (m?.groups && m.indices?.groups) {
        const g = m.groups;
        const ix = m.indices.groups;
        const fullEnd = base + m[0].length;
        if (!hasAlnumAt(tf, fullEnd)) {
          const mult2 = unitMultiplier(g.u2);
          const mult1 = g.u1 !== undefined ? unitMultiplier(g.u1) : mult2;
          const n1 = parseDecimalNum(g.n1);
          const n2 = parseDecimalNum(g.n2);
          if (n1 !== null && n2 !== null) {
            const amount1 = computeUnitAmount(g.n1, n1, mult1, g.f1 ?? null, null, true);
            let endFold = fullEnd;
            let f2: string | null = g.f2 ?? null;
            const sub2 = g.sub2 ?? null;
            if (g.f2 !== undefined) {
              const u2End = base + ix.u2[1];
              const hadSpace = base + ix.f2[0] > u2End;
              const f2End = base + ix.f2[1];
              if (hadSpace && sub2 === null && NON_MONEY_NOUN_AFTER_DIGIT_RE.test(tf.slice(f2End))) {
                f2 = null;
                if (g.period === undefined) endFold = u2End;
              }
            }
            const amount2 = computeUnitAmount(g.n2, n2, mult2, f2, sub2, true);
            if (amount1 > 0 && amount2 > 0) {
              const [minV, maxV] = amount1 <= amount2 ? [amount1, amount2] : [amount2, amount1];
              const period = g.period !== undefined ? parsePeriod(g.period) : null;
              const [startFold] = absorbMoneyPrefix(tf, base, true);
              raw.push([startFold, endFold, { min: minV, max: maxV, currency: "VND", period }, 0.95]);
              if (firstOnly && nearOk(startFold, endFold)) break;
              minPos = endFold;
              continue;
            }
          }
        }
      }
    }

    // 2. Single shorthand/unit amounts.
    if (isUnitPrefix) {
      const m = MONEY_SINGLE_RE.exec(tail);
      if (m?.groups && m.indices?.groups) {
        const g = m.groups;
        const ix = m.indices.groups;
        const fullEnd = base + m[0].length;
        if (!hasAlnumAt(tf, fullEnd)) {
          const nVal = parseDecimalNum(g.n);
          if (nVal !== null) {
            const mult = unitMultiplier(g.u);
            let endFold = fullEnd;
            let f: string | null = g.f ?? null;
            const sub = g.sub ?? null;
            if (g.f !== undefined) {
              const uEnd = base + ix.u[1];
              const hadSpace = base + ix.f[0] > uEnd;
              const fEnd = base + ix.f[1];
              const hasDecimal = g.n.includes(".") || g.n.includes(",");
              if (
                hasDecimal ||
                mult < 1_000_000 ||
                (hadSpace && sub === null && NON_MONEY_NOUN_AFTER_DIGIT_RE.test(tf.slice(fEnd)))
              ) {
                f = null;
                if (g.period === undefined) endFold = uEnd;
              }
            }
            const [startFold, isUpper] = absorbMoneyPrefix(tf, base, false);
            const amount = computeUnitAmount(g.n, nVal, mult, f, sub, false);
            if (amount > 0 && !overlapsAny(raw, startFold, endFold)) {
              const period = g.period !== undefined ? parsePeriod(g.period) : null;
              raw.push([startFold, endFold, { min: isUpper ? 0 : amount, max: amount, currency: "VND", period }, 0.94]);
              if (firstOnly && nearOk(startFold, endFold)) break;
              minPos = endFold;
              continue;
            }
          }
        }
      }
    }

    // 3. Grouped VND amounts.
    if (isVndPrefix) {
      const m = MONEY_GROUPED_VND_RE.exec(tail);
      if (m?.groups) {
        const g = m.groups;
        const fullEnd = base + m[0].length;
        if (!hasAlnumAt(tf, fullEnd)) {
          const amount = Number.parseInt(g.n.replace(/[^0-9]/g, ""), 10);
          if (Number.isFinite(amount) && amount >= 1_000) {
            const [startFold, isUpper] = absorbMoneyPrefix(tf, base, false);
            if (!overlapsAny(raw, startFold, fullEnd)) {
              const period = g.period !== undefined ? parsePeriod(g.period) : null;
              raw.push([startFold, fullEnd, { min: isUpper ? 0 : amount, max: amount, currency: "VND", period }, 0.93]);
              if (firstOnly && nearFolded.length === 0) break;
              minPos = fullEnd;
              continue;
            }
          }
        }
      }
    }
  }

  if (raw.length === 0) return [];
  raw.sort((a, b) => a[0] - b[0]);

  const toMatch = (fs: number, fe: number, val: MoneyValue, conf: number): ExtractionMatch | null => {
    const span = folded.mapSpan(fs, fe);
    if (!span) return null;
    return { value: val, raw: textNorm.slice(span[0], span[1]), start: span[0], end: span[1], confidence: conf };
  };

  if (nearFolded.length > 0) {
    const filtered: Array<[number, number, number, MoneyValue, number]> = [];
    for (const [fs, fe, val, conf] of raw) {
      const d = minDistanceToNearKeywords(tf, fs, fe, nearFolded, win, maxKw);
      if (d !== null) {
        filtered.push([d, fs, fe, val, conf]);
        if (firstOnly && d === 0) break;
      }
    }
    filtered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return filtered.map(([, fs, fe, val, conf]) => toMatch(fs, fe, val, conf)).filter((m): m is ExtractionMatch => m !== null);
  }
  return raw.map(([fs, fe, val, conf]) => toMatch(fs, fe, val, conf)).filter((m): m is ExtractionMatch => m !== null);
}

function absorbMoneyPrefix(tf: string, numStart: number, allowTu: boolean): [number, boolean] {
  const before = tf.slice(0, numStart).replace(/ +$/, "");
  if (before.length === numStart) return [numStart, false];
  for (const p of ["khong qua", "toi da", "duoi"]) {
    if (before.endsWith(p)) {
      const restLen = before.length - p.length;
      if (!hasAlnumBefore(before, restLen)) return [restLen, true];
    }
  }
  for (const p of ["khoang", "tam", "tren"]) {
    if (before.endsWith(p)) {
      const restLen = before.length - p.length;
      if (!hasAlnumBefore(before, restLen)) return [restLen, false];
    }
  }
  if (allowTu && before.endsWith("tu")) {
    const restLen = before.length - 2;
    if (!hasAlnumBefore(before, restLen)) return [restLen, false];
  }
  return [numStart, false];
}

function overlapsAny(existing: readonly Candidate[], start: number, end: number): boolean {
  return existing.some(([s, e]) => start < e && end > s);
}

function unitMultiplier(unit: string): number {
  switch (unit) {
    case "ty": case "ti": case "toi": return 1_000_000_000;
    case "trieu": case "tr": case "cu": return 1_000_000;
    case "lit": return 100_000;
    case "nghin": case "ngan": case "ka": case "k": return 1_000;
    default: return 1;
  }
}

function parseDecimalNum(s: string): number | null {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function computeUnitAmount(
  nRaw: string,
  nVal: number,
  mult: number,
  frac: string | null,
  subUnit: string | null,
  allowFracOnDecimal: boolean,
): number {
  const base = Math.round(nVal * mult);
  const hasDecimal = nRaw.includes(".") || nRaw.includes(",");
  if (hasDecimal && !allowFracOnDecimal) return base;
  if (frac !== null && !hasDecimal && mult >= 1_000_000) {
    const fVal = Number.parseInt(frac, 10);
    if (Number.isFinite(fVal)) {
      if (subUnit !== null) {
        const subMult = unitMultiplier(subUnit);
        if (subMult < mult) return base + fVal * subMult;
      }
      return base + fVal * Math.trunc(mult / 10 ** frac.length);
    }
  }
  return base;
}

function parsePeriod(rawPeriod: string): MoneyPeriod | null {
  const p = rawPeriod.trim();
  if (["thang", "thg", "th", "month", "mo"].some((s) => p.endsWith(s))) return "month";
  if (["nam", "yr", "year"].some((s) => p.endsWith(s))) return "year";
  if (["ngay", "dem", "day"].some((s) => p.endsWith(s))) return "day";
  return null;
}

function skipGroupedOrDecimalNumber(s: string): number {
  let i = 0;
  while (i < s.length && isAsciiDigitCode(s.charCodeAt(i))) i += 1;
  while (i + 1 < s.length && (s[i] === "." || s[i] === ",") && isAsciiDigitCode(s.charCodeAt(i + 1))) {
    i += 1;
    while (i < s.length && isAsciiDigitCode(s.charCodeAt(i))) i += 1;
  }
  return i;
}

function charDistanceWithin(
  tf: string,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  maxChars: number,
): number | null {
  let gapStart: number;
  let gapEnd: number;
  if (aEnd < bStart) {
    gapStart = aEnd;
    gapEnd = bStart;
  } else if (bEnd < aStart) {
    gapStart = bEnd;
    gapEnd = aStart;
  } else {
    return 0;
  }
  if (gapEnd - gapStart > maxChars * 4) return null;
  const n = Array.from(tf.slice(gapStart, gapEnd)).length;
  return n <= maxChars ? n : null;
}

/** Closest `near` keyword (whole-word) distance in characters, or null when beyond `maxChars`. */
export function minDistanceToNearKeywords(
  tf: string,
  fStart: number,
  fEnd: number,
  keywords: readonly string[],
  maxChars: number,
  maxKwLen: number,
): number | null {
  const margin = maxChars * 4 + maxKwLen + 2;
  const winS = Math.max(0, fStart - margin);
  const winE = Math.min(tf.length, fEnd + margin);
  const local = tf.slice(winS, winE);
  let minDist = Number.MAX_SAFE_INTEGER;
  for (const kw of keywords) {
    if (kw.length === 0 || kw.length > local.length) continue;
    let from = 0;
    for (;;) {
      const rel = local.indexOf(kw, from);
      if (rel < 0) break;
      const ks = winS + rel;
      const ke = ks + kw.length;
      if (!hasAlnumBefore(tf, ks) && !hasAlnumAt(tf, ke)) {
        const d = charDistanceWithin(tf, fStart, fEnd, ks, ke, maxChars);
        if (d !== null && d < minDist) {
          minDist = d;
          if (d === 0) return 0;
        }
      }
      from = rel + String.fromCodePoint(local.codePointAt(rel)!).length;
    }
  }
  return minDist <= maxChars ? minDist : null;
}
