// Port of crates/rules/src/extractors/number.rs.

import { foldText, foldWithSpans, isAlphanumericChar, type FoldedText } from "../normalize";
import type { ExtractionMatch } from "../types";

export interface NumberExtractorConfig {
  units: string[];
  prefixes: string[];
  multipliers: Record<string, number>;
}

export function defaultNumberConfig(): NumberExtractorConfig {
  return { units: [], prefixes: [], multipliers: {} };
}

const DEFAULT_UNITS: ReadonlyArray<[string, number]> = [
  ["van km", 10_000], ["van", 10_000], ["nghin km", 1_000], ["ngan km", 1_000], ["km", 1], ["tan", 1],
  ["ta", 1], ["yen", 1], ["kg", 1], ["phong ngu", 1], ["p.ngu", 1], ["pn", 1], ["ngu", 1], ["wc", 1],
  ["tang", 1], ["lau", 1], ["cho", 1], ["ghe", 1], ["suat", 1], ["chiec", 1], ["cai", 1], ["bo", 1],
  ["thung", 1], ["kien", 1], ["pallet", 1], ["nam kinh nghiem", 1], ["nam kn", 1],
];
const DEFAULT_PREFIXES = ["doi", "nam sx", "san xuat", "sx", "so luong", "sl"];

const PLAIN_NUMBER_RE = /^\s*[+-]?(?<n>\d+(?:[.,]\d+)?)\s*$/;
const NUM_TOKEN_RE = /\d+(?:[.,]\d+)?/;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** Rust `Option<Value>` from f64: integral -> integer JSON, else 4-decimal rounding. */
export function numberToJsonValue(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  const rounded = Math.round(v);
  if (Math.abs(v - rounded) < 1e-9) return rounded;
  return Math.round(v * 10_000) / 10_000;
}

function parseFloatLoose(s: string): number | null {
  const t = s.replace(",", ".");
  return /^[0-9]+(?:\.[0-9]+)?$/.test(t) ? Number(t) : null;
}

function builtinUnitMultiplier(u: string): number {
  if (u === "van" || u.startsWith("van ")) return 10_000;
  if (u === "nghin" || u.startsWith("nghin ") || u === "ngan" || u.startsWith("ngan ")) return 1_000;
  return 1;
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

export function extractNumber(textNorm: string, config: NumberExtractorConfig): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  return extractNumberFromFolded(textNorm, foldWithSpans(textNorm), config);
}

export function extractNumberFromFolded(
  textNorm: string,
  folded: FoldedText,
  config: NumberExtractorConfig,
): ExtractionMatch[] {
  const tf = folded.text_fold;
  if (tf.length === 0) return [];
  const useDefaults = config.units.length === 0 && config.prefixes.length === 0;
  const has = (o: Record<string, number>, k: string): number | undefined =>
    Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

  let unitSpecs: Array<[string, number]> = useDefaults
    ? DEFAULT_UNITS.map(([u, mult]) => [u, has(config.multipliers, u) ?? mult] as [string, number])
    : config.units
        .map((u) => {
          const uf = foldText(u);
          return [uf, has(config.multipliers, uf) ?? builtinUnitMultiplier(uf)] as [string, number];
        })
        .filter(([uf]) => uf.length > 0);
  unitSpecs = unitSpecs.map((x, i) => [x, i] as const).sort((a, b) => byteLen(b[0][0]) - byteLen(a[0][0]) || a[1] - b[1]).map(([x]) => x);

  const prefixSpecs = (useDefaults ? [...DEFAULT_PREFIXES] : config.prefixes.map((p) => foldText(p)).filter((p) => p.length > 0))
    .map((x, i) => [x, i] as const)
    .sort((a, b) => byteLen(b[0]) - byteLen(a[0]) || a[1] - b[1])
    .map(([x]) => x);

  const hits: Array<[number, number, number, number]> = [];
  const overlaps = (s: number, e: number): boolean => hits.some(([hs, he]) => s < he && e > hs);

  // 1. number + unit suffix
  for (const nStart of folded.digitStarts()) {
    let nEnd = nStart + 1;
    while (nEnd < tf.length && isDigit(tf.charCodeAt(nEnd))) nEnd += 1;
    if (nEnd + 1 < tf.length && (tf[nEnd] === "." || tf[nEnd] === ",") && isDigit(tf.charCodeAt(nEnd + 1))) {
      nEnd += 2;
      while (nEnd < tf.length && isDigit(tf.charCodeAt(nEnd))) nEnd += 1;
    }
    let unitStart = nEnd;
    while (unitStart < tf.length && tf[unitStart] === " ") unitStart += 1;
    if (unitStart >= tf.length) continue;
    for (const [unit, mult] of unitSpecs) {
      const unitEnd = unitStart + unit.length;
      if (unitEnd <= tf.length && tf.startsWith(unit, unitStart)) {
        const rightOk = unitEnd === tf.length || !isAlphanumericChar(String.fromCodePoint(tf.codePointAt(unitEnd)!));
        if (rightOk) {
          const base = parseFloatLoose(tf.slice(nStart, nEnd));
          if (base !== null) {
            if (!overlaps(nStart, unitEnd)) {
              const jv = numberToJsonValue(base * mult);
              if (jv !== null) hits.push([nStart, unitEnd, jv, 0.93]);
            }
            break;
          }
        }
      }
    }
  }

  // 2. prefix cue + number
  for (const prefix of prefixSpecs) {
    let from = 0;
    for (;;) {
      const pStart = tf.indexOf(prefix, from);
      if (pStart < 0) break;
      const pEnd = pStart + prefix.length;
      const prevCh = pStart === 0 ? null : lastChar(tf, pStart);
      const leftOk = pStart === 0 || !(prevCh !== null && isAlphanumericChar(prevCh));
      const nextCh = pEnd < tf.length ? String.fromCodePoint(tf.codePointAt(pEnd)!) : null;
      const rightSep = nextCh !== null && !isAlphanumericChar(nextCh);
      if (leftOk && rightSep) {
        const rest = tf.slice(pEnd);
        const trimmed = rest.replace(/^[ :\-.]+/, "");
        const skip = rest.length - trimmed.length;
        const nm = NUM_TOKEN_RE.exec(trimmed);
        if (nm && nm.index === 0) {
          const fullEnd = pEnd + skip + nm[0].length;
          const endOk = fullEnd === tf.length || !isAlphanumericChar(String.fromCodePoint(tf.codePointAt(fullEnd)!));
          if (endOk && !overlaps(pStart, fullEnd)) {
            const val = parseFloatLoose(nm[0]);
            if (val !== null) {
              const jv = numberToJsonValue(val);
              if (jv !== null) hits.push([pStart, fullEnd, jv, 0.92]);
            }
          }
        }
      }
      from = pStart + String.fromCodePoint(tf.codePointAt(pStart)!).length;
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

function lastChar(s: string, idx: number): string {
  const lo = s.charCodeAt(idx - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && idx >= 2 ? s.slice(idx - 2, idx) : s[idx - 1];
}

/** `FieldType::Number` renormalization of a standalone snippet. */
export function parseStandaloneNumber(raw: string): number | null {
  const first = extractNumber(raw, defaultNumberConfig())[0];
  if (first) return first.value as number;
  const folded = foldText(raw);
  const m = PLAIN_NUMBER_RE.exec(folded);
  if (!m?.groups) return null;
  const f = parseFloatLoose(m.groups.n);
  if (f === null) return null;
  const sign = folded.trimStart().startsWith("-") ? -1 : 1;
  return numberToJsonValue(sign * f);
}
