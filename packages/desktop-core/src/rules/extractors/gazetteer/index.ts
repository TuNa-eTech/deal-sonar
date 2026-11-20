// Port of gazetteer/{mod,index,matcher}.rs: Vietnamese administrative location extractor
// (`vn_admin`). The Rust byte-mask / next-byte prefilters only skip candidates that
// `starts_with(phrase)` would reject, so this port keeps the exact first-word table and the
// phrase check.

import { foldText, foldWithSpans, isAlphanumericChar, type FoldedText } from "../../normalize";
import { hasAlnumAt } from "../../prefilter";
import type { ExtractionMatch, LocationValue } from "../../types";
import { CITIES } from "./data-cities";
import { PROVINCES_AND_HANOI } from "./data-provinces-hanoi";
import type { AdminEntry } from "./entry";

export type { AdminEntry } from "./entry";

interface Item {
  phrase: string;
  entryIdx: number;
  isShort: boolean;
}
interface GazetteerIndex {
  entries: AdminEntry[];
  byFirstWord: Map<string, Item[]>;
  provinceScopeMap: Map<string, string>;
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

function scanAlnumEnd(s: string, start: number): number {
  let idx = start;
  while (idx < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(idx)!);
    if (!isAlphanumericChar(ch)) break;
    idx += ch.length;
  }
  return idx;
}

function buildIndex(): GazetteerIndex {
  const entries = [...PROVINCES_AND_HANOI, ...CITIES];
  const raw = new Map<string, Item[]>();
  const provinceScopeMap = new Map<string, string>();
  entries.forEach((entry, entryIdx) => {
    if (entry.district === null && entry.ward === null) {
      for (const a of entry.aliases) provinceScopeMap.set(a, entry.province);
      for (const s of entry.shortAliases) provinceScopeMap.set(s, entry.province);
    }
    const add = (phrase: string, isShort: boolean): void => {
      const firstEnd = scanAlnumEnd(phrase, 0);
      if (firstEnd === 0) return;
      const first = phrase.slice(0, firstEnd);
      const list = raw.get(first) ?? [];
      list.push({ phrase, entryIdx, isShort });
      raw.set(first, list);
    };
    for (const a of entry.aliases) add(a, false);
    for (const s of entry.shortAliases) add(s, true);
  });
  for (const list of raw.values()) {
    list.sort((a, b) => byteLen(b.phrase) - byteLen(a.phrase) || Number(a.isShort) - Number(b.isShort));
  }
  return { entries, byFirstWord: raw, provinceScopeMap };
}

let cachedIndex: GazetteerIndex | null = null;
const vnAdminIndex = (): GazetteerIndex => (cachedIndex ??= buildIndex());

function isLocationConnector(gap: string): boolean {
  const g = gap.trim();
  return [
    "", ",", "-", "/", ".", ", quan", ", q.", ", phuong", ", p.", ", huyen", ", tp", "quan", "tp",
  ].includes(g);
}

type Hier = [string | null, string | null, string | null];
function compatibleHierarchy(a: Hier, b: Hier): boolean {
  if (a[0] !== null && b[0] !== null && a[0] !== b[0]) return false;
  if (a[1] !== null && b[1] !== null && a[1] !== b[1]) return false;
  if (a[2] !== null && b[2] !== null && a[2] !== b[2]) return false;
  return !(a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

const CUES = [
  "khu vuc", "kv", "khu", "quan", "q", "huyen", "phuong", "man", "o", "tai", "gan", "quanh", "ben", "huong", "tuyen", "di", "den", "ve",
];

function lastChar(s: string): string | null {
  if (s.length === 0) return null;
  const lo = s.charCodeAt(s.length - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && s.length >= 2 ? s.slice(-2) : s[s.length - 1];
}

function hasLocationCueBefore(tf: string, pos: number): boolean {
  const prefix = tf.slice(0, pos).replace(/[ ,:\-(/]+$/, "");
  for (const cue of CUES) {
    if (prefix.endsWith(cue)) {
      const before = prefix.slice(0, prefix.length - cue.length);
      const last = lastChar(before);
      if (before.length === 0 || !(last !== null && isAlphanumericChar(last))) return true;
    }
  }
  return false;
}

function shortAliasContextOk(tf: string, pos: number, endPos: number, phrase: string): boolean {
  if (phrase === "tx") {
    const after = tf.slice(endPos).replace(/^\s+/, "");
    if (
      ["son tay", "tu son", "phu my", "ben cat", "tan uyen", "dong trieu", "quang yen", "ninh hoa"].some((p) =>
        after.startsWith(p),
      )
    ) {
      return false;
    }
  }
  if (phrase === "tb" && tf.slice(0, pos).endsWith("gia ")) return false;
  return true;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function tryMatchWord(
  tf: string,
  idx: GazetteerIndex,
  canonicalScope: string | null,
  pos: number,
  firstEnd: number,
): [number, AdminEntry, number] | null {
  const bucket = idx.byFirstWord.get(tf.slice(pos, firstEnd));
  if (!bucket) return null;
  let best: [number, AdminEntry, number] | null = null;
  for (const { phrase, entryIdx, isShort } of bucket) {
    const endPos = pos + phrase.length;
    if (endPos > tf.length || !tf.startsWith(phrase, pos)) continue;
    const entry = idx.entries[entryIdx];
    if (canonicalScope !== null) {
      if (asciiLower(entry.province) !== asciiLower(canonicalScope) && entry.province !== canonicalScope) continue;
    }
    if (hasAlnumAt(tf, endPos)) continue;
    if (isShort && !shortAliasContextOk(tf, pos, endPos, phrase)) continue;
    let conf: number;
    if (isShort) conf = canonicalScope !== null || hasLocationCueBefore(tf, pos) ? 0.9 : 0.8;
    else if (entry.ward !== null) conf = 0.97;
    else if (entry.district !== null) conf = 0.95;
    else conf = 0.93;
    if (best) {
      if (endPos > best[0] || (endPos === best[0] && conf > best[2])) best = [endPos, entry, conf];
    } else {
      best = [endPos, entry, conf];
    }
  }
  return best;
}

interface Merged {
  start: number;
  end: number;
  province: string | null;
  district: string | null;
  ward: string | null;
  confidence: number;
}

export function extractGazetteerFromFolded(
  textNorm: string,
  folded: FoldedText,
  scope: string | null,
  firstOnly: boolean,
): ExtractionMatch[] {
  const tf = folded.text_fold;
  if (tf.length === 0) return [];
  const idx = vnAdminIndex();

  let canonicalScope: string | null = null;
  if (scope !== null) {
    const trimmed = scope.trim();
    if (trimmed.length > 0) {
      const f = foldText(trimmed);
      const collapsed = f.replace(/\./g, " ").split(/\s+/).filter(Boolean).join(" ");
      canonicalScope = idx.provinceScopeMap.get(f) ?? idx.provinceScopeMap.get(collapsed) ?? trimmed;
    }
  }

  const rawHits: Array<[number, number, AdminEntry, number]> = [];
  let skipUntil = 0;
  for (const [ws, we] of folded.words()) {
    if (firstOnly) {
      const last = rawHits[rawHits.length - 1];
      if (last && Math.max(0, ws - last[1]) > 25) break;
    }
    if (ws < skipUntil) continue;
    const r = tryMatchWord(tf, idx, canonicalScope, ws, we);
    if (r) {
      rawHits.push([ws, r[0], r[1], r[2]]);
      skipUntil = r[0];
    }
  }
  if (rawHits.length === 0) return [];

  const merged: Merged[] = [];
  for (const [s, e, entry, conf] of rawHits) {
    const last = merged[merged.length - 1];
    if (
      last &&
      isLocationConnector(tf.slice(last.end, s)) &&
      compatibleHierarchy([last.province, last.district, last.ward], [entry.province, entry.district, entry.ward])
    ) {
      last.end = e;
      last.province = last.province ?? entry.province;
      if (last.district === null) last.district = entry.district;
      if (last.ward === null) last.ward = entry.ward;
      last.confidence = Math.max(last.confidence, conf, 0.96);
      continue;
    }
    merged.push({ start: s, end: e, province: entry.province, district: entry.district, ward: entry.ward, confidence: conf });
  }

  const out: ExtractionMatch[] = [];
  for (const hit of merged) {
    const span = folded.mapSpan(hit.start, hit.end);
    if (!span) continue;
    const raw = textNorm.slice(span[0], span[1]);
    const loc: LocationValue = { raw, province: hit.province, district: hit.district, ward: hit.ward };
    out.push({ value: loc, raw, start: span[0], end: span[1], confidence: hit.confidence });
  }
  return out;
}

export function extractGazetteer(textNorm: string, scope?: string | null): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  return extractGazetteerFromFolded(textNorm, foldWithSpans(textNorm), scope ?? null, false);
}
