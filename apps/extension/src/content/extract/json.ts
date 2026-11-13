// Path lookup and JSON/NDJSON parsing helpers shared by the extractors.

import { stripFbPrefix } from "./facebook";

// ── Path Lookup & JSON/NDJSON Parsing Helpers ──

type PathSegment = string | number;
const pathCache = new Map<string, PathSegment[]>();

function compilePath(pathExpr: string): PathSegment[] {
  const cached = pathCache.get(pathExpr);
  if (cached) return cached;
  const segments: PathSegment[] = [];
  const tokenRegex = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(pathExpr)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      segments.push(Number(match[2]));
    }
  }
  pathCache.set(pathExpr, segments);
  return segments;
}

export function getByPath(root: unknown, pathExpr: string): unknown {
  const segments = compilePath(pathExpr);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg < 0 || seg >= cur.length) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export function firstNonEmptyString(root: unknown, paths: readonly string[]): string | undefined {
  for (const p of paths) {
    const val = getByPath(root, p);
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
    if (typeof val === "number" && Number.isFinite(val)) {
      return String(val);
    }
  }
  return undefined;
}

export function firstFiniteNumber(root: unknown, paths: readonly string[]): number | undefined {
  for (const p of paths) {
    const val = getByPath(root, p);
    if (typeof val === "number" && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === "string" && /^\d+(\.\d+)?$/.test(val.trim())) {
      const parsed = Number(val.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function firstBoolean(root: unknown, paths: readonly string[]): boolean | undefined {
  for (const p of paths) {
    const val = getByPath(root, p);
    if (typeof val === "boolean") return val;
  }
  return undefined;
}

/** Normalize Unix seconds or milliseconds into Unix milliseconds. */
export function normalizeTimestampMs(rawTs: number | undefined): number | undefined {
  if (rawTs === undefined || !Number.isFinite(rawTs) || rawTs <= 0) {
    return undefined;
  }
  // Values below 10^11 (~year 5138 in seconds, or 1973 in ms) are Unix seconds
  if (rawTs < 100_000_000_000) {
    return Math.round(rawTs * 1000);
  }
  return Math.round(rawTs);
}

/** Parse standard JSON, `for (;;);`-prefixed JSON, or multi-line NDJSON streams. */
export function parseJsonDocuments(rawBody: string): unknown[] {
  const cleaned = stripFbPrefix(rawBody).trim();
  if (!cleaned) return [];

  try {
    return [JSON.parse(cleaned)];
  } catch {
    // Fall back to line-delimited JSON (Facebook Comet GraphQL streaming format)
  }

  const docs: unknown[] = [];
  const lines = cleaned.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = stripFbPrefix(line).trim();
    if (!trimmed) continue;
    try {
      docs.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON chunk lines
    }
  }
  return docs;
}
