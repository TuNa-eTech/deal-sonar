// Port of crates/rules/src/extractors/regex_ext.rs.
//
// Rust compiles DSL regexes with the linear-time `regex` crate. JavaScript regexes backtrack, so
// on top of the Rust safety checks (length, nested repeat, `{N}` bound) this port also rejects
// what the Rust syntax rejects (look-around, back-references) and any repeated group that
// contains alternation (`(a|a)*`), the remaining catastrophic-backtracking shape. Those patterns
// fail with `RegexSafetyError` instead of risking an event-loop stall.

import { foldWithSpans, type FoldedText } from "../normalize";
import { numberToJsonValue } from "./number";
import type { ExtractionMatch } from "../types";

export const MAX_REGEX_PATTERN_LEN = 512;
export const REGEX_COMPILED_SIZE_LIMIT = 256 * 1024;
export const MAX_REGEX_BOUNDED_REPEAT = 120;

export type RegexCast = "string" | "int" | "float" | "bool";

export class RegexSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexSafetyError";
  }
  static empty(): RegexSafetyError {
    return new RegexSafetyError("regex pattern must not be empty");
  }
  static tooLong(n: number): RegexSafetyError {
    return new RegexSafetyError(`regex pattern length ${n} exceeds limit of ${MAX_REGEX_PATTERN_LEN} bytes`);
  }
  static nestedQuantifier(): RegexSafetyError {
    return new RegexSafetyError("regex pattern contains nested repetition quantifiers (`06-ai-bridge.md §5.3`)");
  }
  static excessiveRepetition(n: number): RegexSafetyError {
    return new RegexSafetyError(
      `regex pattern contains excessive bounded repetition \`{${n}}\` (max ${MAX_REGEX_BOUNDED_REPEAT})`,
    );
  }
  static invalidCaptureGroup(group: number, max: number): RegexSafetyError {
    return new RegexSafetyError(`capture group ${group} out of bounds for regex with ${max} groups`);
  }
  static compile(detail: string): RegexSafetyError {
    return new RegexSafetyError(`failed to compile linear-time regex: ${detail}`);
  }
}

/** A validated, compiled DSL regex. `re` always has flags `dg`; `source` is the Rust-syntax text. */
export interface CompiledRegex {
  source: string;
  re: RegExp;
  /** Same pattern without the `g`/`d` flags, safe for stateless `.test()`. */
  test: RegExp;
  captureCount: number;
}

type Quant = [isRepeat: boolean, maxBound: number | null];

function peekQuantifier(chars: readonly string[], idx: number): Quant | null {
  const ch = chars[idx];
  if (ch === undefined) return null;
  if (ch === "*" || ch === "+") return [true, null];
  if (ch === "?") return [false, 1];
  if (ch === "{") {
    let end = idx + 1;
    while (end < chars.length && chars[end] !== "}") {
      if (!/[0-9,]/.test(chars[end])) return null;
      end += 1;
    }
    if (end >= chars.length || end === idx + 1) return null;
    const inside = chars.slice(idx + 1, end).join("");
    const comma = inside.indexOf(",");
    if (comma >= 0) {
      const loS = inside.slice(0, comma);
      const hiS = inside.slice(comma + 1);
      const lo = /^[0-9]+$/.test(loS) ? Number(loS) : 0;
      if (hiS.length === 0) return [true, lo];
      if (!/^[0-9]+$/.test(hiS)) return null;
      const maxB = Math.max(lo, Number(hiS));
      return [maxB > 1, maxB];
    }
    if (!/^[0-9]+$/.test(inside)) return null;
    const exact = Number(inside);
    return [exact > 1, exact];
  }
  return null;
}

export function checkRegexPatternSafety(pattern: string): void {
  if (pattern.length === 0) throw RegexSafetyError.empty();
  const byteLen = Buffer.byteLength(pattern, "utf8");
  if (byteLen > MAX_REGEX_PATTERN_LEN) throw RegexSafetyError.tooLong(byteLen);

  const groupHasQuantifier: boolean[] = [];
  const groupHasAlternation: boolean[] = [];
  let inClass = false;
  const chars = Array.from(pattern);
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    switch (ch) {
      case "[":
        inClass = true;
        i += 1;
        break;
      case "(":
        groupHasQuantifier.push(false);
        groupHasAlternation.push(false);
        i += 1;
        break;
      case "|":
        if (groupHasAlternation.length > 0) groupHasAlternation[groupHasAlternation.length - 1] = true;
        i += 1;
        break;
      case ")": {
        const innerQuantified = groupHasQuantifier.pop() ?? false;
        const innerAlt = groupHasAlternation.pop() ?? false;
        const q = peekQuantifier(chars, i + 1);
        if (q) {
          const [isRepeat, maxBound] = q;
          if (maxBound !== null && maxBound > MAX_REGEX_BOUNDED_REPEAT) {
            throw RegexSafetyError.excessiveRepetition(maxBound);
          }
          if (isRepeat && innerQuantified) throw RegexSafetyError.nestedQuantifier();
          if (isRepeat && innerAlt) throw RegexSafetyError.nestedQuantifier();
          if (isRepeat && groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        } else if (innerQuantified && groupHasQuantifier.length > 0) {
          groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        }
        i += 1;
        break;
      }
      case "*":
      case "+":
        if (groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        i += 1;
        break;
      case "{": {
        const q = peekQuantifier(chars, i);
        if (q) {
          const [isRepeat, maxBound] = q;
          if (maxBound !== null && maxBound > MAX_REGEX_BOUNDED_REPEAT) {
            throw RegexSafetyError.excessiveRepetition(maxBound);
          }
          if (isRepeat && groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
        }
        i += 1;
        break;
      }
      default:
        i += 1;
    }
  }
}

/** Translate the Rust-regex dialect subset to a JS pattern; throws on unsupported syntax. */
function toJsPattern(pattern: string): { source: string; ignoreCase: boolean } {
  let src = pattern;
  let ignoreCase = true;
  const lead = /^\(\?([a-z]+)\)/.exec(src);
  if (lead) {
    if (lead[1] !== "i") throw RegexSafetyError.compile(`unsupported inline flag group (?${lead[1]})`);
    src = src.slice(lead[0].length);
  }
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx === undefined) throw RegexSafetyError.compile("incomplete escape");
      if (!inClass && /[1-9]/.test(nx)) throw RegexSafetyError.compile("backreferences are not supported");
      if (nx === "k") throw RegexSafetyError.compile("backreferences are not supported");
      if (!inClass && nx === "A") out += "^";
      else if (!inClass && nx === "z") out += "$";
      else out += `\\${nx}`;
      i += 1;
      continue;
    }
    if (inClass) {
      out += ch;
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (src[i + 1] === "^") {
        out += "^";
        i += 1;
      }
      if (src[i + 1] === "]") {
        out += "\\]";
        i += 1;
      }
      continue;
    }
    if (ch === "(" && src[i + 1] === "?") {
      if (src.startsWith("(?P<", i)) {
        out += "(?<";
        i += 3;
        continue;
      }
      if (src.startsWith("(?:", i) || src.startsWith("(?<", i)) {
        if (src.startsWith("(?<=", i) || src.startsWith("(?<!", i)) throw RegexSafetyError.compile("look-around is not supported");
        out += ch;
        continue;
      }
      throw RegexSafetyError.compile("look-around or inline flags are not supported");
    }
    out += ch;
  }
  return { source: out, ignoreCase };
}

export function compileSafeRegex(pattern: string): CompiledRegex {
  checkRegexPatternSafety(pattern);
  const { source, ignoreCase } = toJsPattern(pattern);
  const unicode = !/^[\x00-\x7f]*$/.test(pattern) || /\\[pP]\{/.test(pattern);
  const flags = `${ignoreCase ? "i" : ""}${unicode ? "u" : ""}`;
  let re: RegExp;
  let test: RegExp;
  try {
    re = new RegExp(source, `dg${flags}`);
    test = new RegExp(source, flags);
  } catch (err) {
    throw RegexSafetyError.compile(err instanceof Error ? err.message : String(err));
  }
  const captureCount = (new RegExp(`${source}|`, flags).exec("")?.length ?? 1) - 1;
  return { source: pattern, re, test, captureCount };
}

function castCapture(s: string, cast: RegexCast): unknown {
  const trimmed = s.trim();
  switch (cast) {
    case "string":
      return trimmed;
    case "int": {
      const cleaned = Array.from(trimmed).filter((c) => (c >= "0" && c <= "9") || c === "-").join("");
      if (!/^[+-]?[0-9]+$/.test(cleaned)) return undefined;
      const v = Number(cleaned);
      return Number.isSafeInteger(v) ? v : undefined;
    }
    case "float": {
      const normalized = trimmed.replace(",", ".");
      if (!/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(normalized)) return undefined;
      const v = numberToJsonValue(Number(normalized));
      return v === null ? undefined : v;
    }
    case "bool": {
      const lower = trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
      return !["", "false", "0", "no", "khong", "không"].includes(lower);
    }
  }
}

function* matchesOf(cr: CompiledRegex, text: string): Generator<RegExpExecArray> {
  const re = cr.re;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex += 1;
    else yield m;
  }
}

function groupText(
  cr: CompiledRegex,
  slice: string,
  group: number,
): { text: string; start: number; end: number } | null {
  const re = new RegExp(cr.re.source, cr.re.flags.replace("g", ""));
  const m = re.exec(slice);
  if (!m) return null;
  const idx = m.indices?.[group];
  if (!idx || m[group] === undefined) return null;
  return { text: m[group], start: idx[0], end: idx[1] };
}

export function extractCompiledRegex(
  textNorm: string,
  folded: FoldedText,
  regex: CompiledRegex,
  group: number,
  cast: RegexCast,
  firstOnly = false,
): ExtractionMatch[] {
  if (textNorm.length === 0) return [];
  const tf = folded.text_fold;
  const out: ExtractionMatch[] = [];
  for (const m0 of matchesOf(regex, tf)) {
    const s0 = m0.index;
    const e0 = s0 + m0[0].length;
    const span = folded.mapSpan(s0, e0);
    if (!span) continue;
    const [ns, ne] = span;
    let capText: string;
    if (group === 0) {
      capText = textNorm.slice(ns, ne);
    } else {
      let g = groupText(regex, m0[0], group);
      let base = s0;
      if (!g) {
        const winS = Math.max(0, s0 - 1);
        const winE = Math.min(tf.length, e0 + 1);
        g = groupText(regex, tf.slice(winS, winE), group);
        base = winS;
        if (!g) continue;
      }
      const gs = folded.mapSpan(base + g.start, base + g.end);
      capText = gs ? textNorm.slice(gs[0], gs[1]) : g.text;
    }
    const val = castCapture(capText, cast);
    if (val !== undefined) {
      out.push({ value: val, raw: textNorm.slice(ns, ne), start: ns, end: ne, confidence: 0.9 });
      if (firstOnly) return out;
    }
  }
  if (out.length > 0 || /^[\x00-\x7f]*$/.test(regex.source)) return out;

  for (const m0 of matchesOf(regex, textNorm)) {
    let capText = m0[0];
    if (group !== 0) {
      const g = groupText(regex, m0[0], group);
      if (!g) continue;
      capText = g.text;
    }
    const val = castCapture(capText, cast);
    if (val !== undefined) {
      out.push({ value: val, raw: m0[0], start: m0.index, end: m0.index + m0[0].length, confidence: 0.9 });
      if (firstOnly) return out;
    }
  }
  return out;
}

export function extractRegex(textNorm: string, pattern: string, group: number, cast: RegexCast): ExtractionMatch[] {
  const compiled = compileSafeRegex(pattern);
  const maxGroup = compiled.captureCount;
  if (group > maxGroup) throw RegexSafetyError.invalidCaptureGroup(group, maxGroup);
  return extractCompiledRegex(textNorm, foldWithSpans(textNorm), compiled, group, cast);
}
