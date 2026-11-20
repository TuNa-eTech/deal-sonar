// Port of crates/rules/src/extractors/date_vi.rs.

import { foldWithSpans, isAlphanumericChar, type FoldedText } from "../normalize";
import type { ExtractionMatch } from "../types";

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function ymd(y: number, m: number, d: number): Ymd | null {
  if (!Number.isInteger(y) || y < -262143 || y > 262142) return null;
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = daysInMonth(y, m);
  if (d > dim) return null;
  return { y, m, d };
}

const toDays = (v: Ymd): number => Math.floor(Date.UTC(v.y, v.m - 1, v.d) / 86_400_000);
function fromDays(n: number): Ymd {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const addDays = (v: Ymd, n: number): Ymd => fromDays(toDays(v) + n);
/** Mon=0 .. Sun=6 */
const weekdayFromMonday = (v: Ymd): number => (new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay() + 6) % 7;

function nextMonth(y: number, m: number): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}
function lastDayOfMonth(y: number, m: number): Ymd | null {
  const [ny, nm] = nextMonth(y, m);
  const first = ymd(ny, nm, 1);
  return first ? addDays(first, -1) : null;
}
function upcomingWeekend(d: Ymd, extraWeeks: number): Ymd {
  const wd = weekdayFromMonday(d);
  const sat = wd === 6 && extraWeeks === 0 ? d : addDays(d, (5 + 7 - wd) % 7);
  return addDays(sat, extraWeeks * 7);
}
const nextMonday = (d: Ymd): Ymd => addDays(d, 7 - weekdayFromMonday(d));
function upcomingWeekday(d: Ymd, target: number): Ymd {
  return addDays(d, (target - weekdayFromMonday(d) + 7) % 7);
}

function formatYmd(v: Ymd): string {
  return `${String(v.y).padStart(4, "0")}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

/** Calendar date in Vietnam time (UTC+7) for a Unix-ms timestamp. */
export function refDateFromTsMs(refTsMs: number): Ymd {
  const t = Math.trunc(refTsMs) + 7 * 3600 * 1000;
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return { y: 2026, m: 1, d: 1 };
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const ISO_DATE_RE = /\b(?<y>20\d{2}|19\d{2})-(?<m>0[1-9]|1[0-2])-(?<d>0[1-9]|[12]\d|3[01])\b/g;
const DMY_DATE_RE = /\b(?:ngay\s+)?(?<d>0?[1-9]|[12]\d|3[01])[/-](?<m>0?[1-9]|1[0-2])[/-](?<y>20\d{2}|19\d{2}|\d{2})\b/g;
const DM_TEXT_RE = /\b(?:ngay\s+)?(?<d>0?[1-9]|[12]\d|3[01])\s+thang\s+(?<m>0?[1-9]|1[0-2])(?:\s+nam\s+(?<y>20\d{2}))?\b/g;
const DM_SLASH_RE = /\b(?<prefix>ngay\s+)?(?<d>0?[1-9]|[12]\d|3[01])\/(?<m>0?[1-9]|1[0-2])\b/g;
const IN_N_DAYS_RE = /\b(?:sau\s+(?<n1>\d{1,2})\s+ngay|(?<n2>\d{1,2})\s+ngay\s+(?:nua|toi))\b/g;
const SPECIFIC_MONTH_BOUND_RE =
  /\b(?<pos>dau|giua|cuoi)\s+thang\s+(?<m>0?[1-9]|1[0-2])(?:\s*[/\-]\s*(?<y>20\d{2}))?\b/g;
const NON_DATE_BEFORE_SLASH_RE = /(?:ngo|ngach|hem|so|duong|kiet|tang|lau|can|lo|ty\s+le|ti\s+le)\s*$/;

function* findAll(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex += 1;
    yield m;
  }
}

type Hit = [start: number, end: number, date: Ymd, confidence: number];
const overlaps = (hits: readonly Hit[], s: number, e: number): boolean => hits.some(([hs, he]) => s < he && e > hs);

function resolveDayMonth(ref: Ymd, day: number, month: number): Ymd | null {
  const cand = ymd(ref.y, month, day);
  if (cand) {
    if (toDays(ref) - toDays(cand) > 60) {
      const nextYr = ymd(ref.y + 1, month, day);
      if (nextYr) return nextYr;
    }
    return cand;
  }
  return ymd(ref.y + 1, month, day);
}

const RELATIVE: ReadonlyArray<[string, (d: Ymd) => Ymd | null, number]> = [
  ["ngay hom nay", (d) => d, 0.96],
  ["hom nay", (d) => d, 0.96],
  ["bua nay", (d) => d, 0.94],
  ["ngay mai", (d) => addDays(d, 1), 0.96],
  ["sang mai", (d) => addDays(d, 1), 0.95],
  ["chieu mai", (d) => addDays(d, 1), 0.95],
  ["toi mai", (d) => addDays(d, 1), 0.95],
  ["ngay kia", (d) => addDays(d, 2), 0.95],
  ["ngay mot", (d) => addDays(d, 2), 0.95],
  ["hom qua", (d) => addDays(d, -1), 0.95],
  ["cuoi tuan nay", (d) => upcomingWeekend(d, 0), 0.92],
  ["cuoi tuan sau", (d) => upcomingWeekend(d, 1), 0.92],
  ["cuoi tuan", (d) => upcomingWeekend(d, 0), 0.9],
  ["dau tuan sau", (d) => nextMonday(d), 0.91],
  ["tuan sau", (d) => nextMonday(d), 0.86],
  ["cuoi thang nay", (d) => lastDayOfMonth(d.y, d.m), 0.94],
  ["cuoi thang sau", (d) => { const [ny, nm] = nextMonth(d.y, d.m); return lastDayOfMonth(ny, nm); }, 0.94],
  ["cuoi thang", (d) => lastDayOfMonth(d.y, d.m), 0.91],
  ["dau thang sau", (d) => { const [ny, nm] = nextMonth(d.y, d.m); return ymd(ny, nm, 1); }, 0.95],
  ["dau thang toi", (d) => { const [ny, nm] = nextMonth(d.y, d.m); return ymd(ny, nm, 1); }, 0.94],
  ["sang thang", (d) => { const [ny, nm] = nextMonth(d.y, d.m); return ymd(ny, nm, 1); }, 0.88],
  ["dau thang nay", (d) => ymd(d.y, d.m, 1), 0.93],
  ["giua thang nay", (d) => ymd(d.y, d.m, 15), 0.91],
  ["giua thang sau", (d) => { const [ny, nm] = nextMonth(d.y, d.m); return ymd(ny, nm, 15); }, 0.91],
  ["chu nhat", (d) => upcomingWeekday(d, 6), 0.9],
  ["mai", (d) => addDays(d, 1), 0.88],
];

const NON_TOMORROW_BEFORE = [
  "hoang", "tan", "phuong", "bach", "khuong", "xuan", "ban", "sao", "hoa", "cay", "khuyen", "thuong", "mai", "chi", "co", "anh", "em", "dong",
];

function lastCharOf(s: string): string | null {
  if (s.length === 0) return null;
  const lo = s.charCodeAt(s.length - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && s.length >= 2 ? s.slice(-2) : s[s.length - 1];
}

function bareMaiContextOk(tf: string, start: number, end: number): boolean {
  const before = tf.slice(0, start).replace(/\s+$/, "");
  for (const w of NON_TOMORROW_BEFORE) {
    if (before.endsWith(w)) {
      const rest = before.slice(0, before.length - w.length);
      const last = lastCharOf(rest);
      if (rest.length === 0 || !(last !== null && isAlphanumericChar(last))) return false;
    }
  }
  const after = tf.slice(end).replace(/^\s+/, "");
  if (after.startsWith("dich") || after.startsWith("dong") || after.startsWith("moi")) return false;
  return true;
}

export function extractDateVi(textNorm: string, refTsMs: number): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  return extractDateViFromFolded(textNorm, foldWithSpans(textNorm), refTsMs);
}

export function extractDateViFromFolded(textNorm: string, folded: FoldedText, refTsMs: number): ExtractionMatch[] {
  const tf = folded.text_fold;
  if (tf.length === 0) return [];
  const ref = refDateFromTsMs(refTsMs);
  const hits: Hit[] = [];
  const hasDash = tf.includes("-");
  const hasSlash = tf.includes("/");
  const hasThang = tf.includes("thang");
  const hasNgay = tf.includes("ngay");
  const num = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10) || 0);

  if (hasDash) {
    for (const m of findAll(ISO_DATE_RE, tf)) {
      const g = m.groups!;
      const date = ymd(num(g.y), num(g.m), num(g.d));
      if (date) hits.push([m.index, m.index + m[0].length, date, 0.99]);
    }
  }

  if (hasSlash || hasDash) {
    for (const m of findAll(DMY_DATE_RE, tf)) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(hits, s, e)) continue;
      const g = m.groups!;
      const rawY = num(g.y);
      const y = rawY < 100 ? 2000 + rawY : rawY;
      if (y >= 1970 && y <= 2100) {
        const date = ymd(y, num(g.m), num(g.d));
        if (date) hits.push([s, e, date, 0.98]);
      }
    }
  }

  if (hasThang) {
    for (const m of findAll(DM_TEXT_RE, tf)) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(hits, s, e)) continue;
      const g = m.groups!;
      const d = num(g.d);
      const mo = num(g.m);
      const date = g.y !== undefined ? ymd(Number.parseInt(g.y, 10), mo, d) : resolveDayMonth(ref, d, mo);
      if (date) hits.push([s, e, date, 0.96]);
    }

    for (const m of findAll(SPECIFIC_MONTH_BOUND_RE, tf)) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(hits, s, e)) continue;
      const g = m.groups!;
      const mo = num(g.m);
      const y = g.y !== undefined ? Number.parseInt(g.y, 10) : mo < ref.m ? ref.y + 1 : ref.y;
      let date: Ymd | null = null;
      if (g.pos === "dau") date = ymd(y, mo, 1);
      else if (g.pos === "giua") date = ymd(y, mo, 15);
      else if (g.pos === "cuoi") date = lastDayOfMonth(y, mo);
      if (date) hits.push([s, e, date, 0.92]);
    }
  }

  if (hasSlash) {
    for (const m of findAll(DM_SLASH_RE, tf)) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(hits, s, e)) continue;
      if (tf.startsWith("/", e)) continue;
      const g = m.groups!;
      const hasPrefix = g.prefix !== undefined;
      const d = num(g.d);
      const mo = num(g.m);
      if (!hasPrefix) {
        if (d === 24 && (mo === 7 || mo === 24)) continue;
        if (NON_DATE_BEFORE_SLASH_RE.test(tf.slice(0, s))) continue;
      }
      const date = resolveDayMonth(ref, d, mo);
      if (date) hits.push([s, e, date, hasPrefix ? 0.95 : 0.88]);
    }
  }

  if (hasNgay) {
    for (const m of findAll(IN_N_DAYS_RE, tf)) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(hits, s, e)) continue;
      const g = m.groups!;
      const days = Number.parseInt(g.n1 ?? g.n2 ?? "0", 10);
      if (Number.isFinite(days)) hits.push([s, e, addDays(ref, days), 0.92]);
    }
  }

  for (const [phrase, compute, conf] of RELATIVE) {
    let from = 0;
    for (;;) {
      const start = tf.indexOf(phrase, from);
      if (start < 0) break;
      const end = start + phrase.length;
      const prev = start === 0 ? null : lastCharOf(tf.slice(0, start));
      const leftOk = start === 0 || !(prev !== null && isAlphanumericChar(prev));
      const rightOk = end === tf.length || !isAlphanumericChar(String.fromCodePoint(tf.codePointAt(end)!));
      const contextOk = phrase === "mai" ? bareMaiContextOk(tf, start, end) : true;
      if (leftOk && rightOk && contextOk && !overlaps(hits, start, end)) {
        const date = compute(ref);
        if (date) hits.push([start, end, date, conf]);
      }
      from = start + String.fromCodePoint(tf.codePointAt(start)!).length;
    }
  }

  hits.sort((a, b) => a[0] - b[0]);
  const out: ExtractionMatch[] = [];
  for (const [s, e, date, conf] of hits) {
    const span = folded.mapSpan(s, e);
    if (!span) continue;
    out.push({ value: formatYmd(date), raw: textNorm.slice(span[0], span[1]), start: span[0], end: span[1], confidence: conf });
  }
  return out;
}
