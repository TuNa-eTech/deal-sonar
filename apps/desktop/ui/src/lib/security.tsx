import React from "react";

/**
 * Security utilities (`03-risks-compliance.md §4`):
 * 1. NEVER render untrusted post content, summaries, author names, or group names as HTML.
 * 2. Highlight extracted `raw` evidence spans purely by splitting string slices into
 *    React text/mark elements (zero raw HTML DOM injection, zero clickable links inside post text).
 * 3. Strictly validate Facebook permalinks before opening externally.
 */

export interface RawHighlightSpan {
  raw: string;
  fieldLabel?: string;
}

interface TextInterval {
  start: number;
  end: number;
  label?: string;
}

/**
 * Case-insensitive substring finder on raw post text that preserves exact character
 * indices of the original `text` string so sliced segments remain lossless and escaped by React.
 */
function findSpanIntervals(text: string, spans: Array<RawHighlightSpan | string>): TextInterval[] {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const candidates: TextInterval[] = [];

  for (const item of spans) {
    const rawStr = (typeof item === "string" ? item : item.raw)?.trim();
    const label = typeof item === "string" ? undefined : item.fieldLabel;
    if (!rawStr) continue;

    const needle = rawStr.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(needle, searchFrom);
      if (idx === -1) break;
      candidates.push({
        start: idx,
        end: idx + rawStr.length,
        label,
      });
      searchFrom = idx + Math.max(1, needle.length);
    }
  }

  if (candidates.length === 0) return [];

  // Prefer earlier start, then longer match; drop overlapping intervals.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: TextInterval[] = [];
  for (const cand of candidates) {
    const prev = merged[merged.length - 1];
    if (!prev || cand.start >= prev.end) {
      merged.push(cand);
    }
  }
  return merged;
}

/**
 * Pure React plain-text highlighter.
 * Splits `text` into plain string children and `<mark>` elements.
 * - Never parses HTML tags (`<img src=x onerror=alert(1)>` renders literally as text).
 * - Never turns URLs in post text into `<a>` links (`03-risks-compliance.md §4`).
 */
export function renderHighlightedPostText(
  text: string | null | undefined,
  rawSpans: Array<RawHighlightSpan | string> = []
): React.ReactNode {
  if (!text) {
    return <span className="text-muted">Nội dung bài viết đã hết hạn lưu giữ hoặc trống.</span>;
  }

  const intervals = findSpanIntervals(text, rawSpans);
  if (intervals.length === 0) {
    return <React.Fragment>{text}</React.Fragment>;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  intervals.forEach((interval, idx) => {
    if (interval.start > cursor) {
      nodes.push(
        <React.Fragment key={`txt-${idx}-${cursor}`}>
          {text.slice(cursor, interval.start)}
        </React.Fragment>
      );
    }
    const matchedSlice = text.slice(interval.start, interval.end);
    nodes.push(
      <mark
        key={`hl-${idx}-${interval.start}`}
        className="evidence-mark"
        title={interval.label ? `Bằng chứng trích xuất: ${interval.label}` : "Bằng chứng trích xuất"}
      >
        {matchedSlice}
      </mark>
    );
    cursor = interval.end;
  });

  if (cursor < text.length) {
    nodes.push(<React.Fragment key={`txt-tail-${cursor}`}>{text.slice(cursor)}</React.Fragment>);
  }

  return nodes;
}

const ALLOWED_FB_ORIGINS = new Set([
  "https://www.facebook.com",
  "https://m.facebook.com",
  "https://web.facebook.com",
]);

const ALLOWED_FB_PREFIXES = [
  "https://www.facebook.com/",
  "https://m.facebook.com/",
  "https://web.facebook.com/",
];

/**
 * Validates that a permalink strictly belongs to Facebook over HTTPS with no credentials
 * or origin-confusion tricks (`03-risks-compliance.md §4`).
 */
export function isSafeFacebookPermalink(permalink: string | null | undefined): boolean {
  if (!permalink || typeof permalink !== "string") return false;
  const trimmed = permalink.trim();
  if (!ALLOWED_FB_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (!ALLOWED_FB_ORIGINS.has(parsed.origin)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface OpenPermalinkResult {
  opened: boolean;
  error: string | null;
}

/**
 * Opens a post permalink ONLY if it passes `isSafeFacebookPermalink`.
 * Blocks `javascript:`, `data:`, `http://`, and non-Facebook phishing domains.
 */
export function openFacebookPermalink(permalink: string | null | undefined): OpenPermalinkResult {
  if (!isSafeFacebookPermalink(permalink)) {
    return {
      opened: false,
      error:
        "Đã chặn mở liên kết: đường dẫn không thuộc tên miền Facebook hợp lệ (https://www.facebook.com/).",
    };
  }
  const cleanUrl = permalink!.trim();
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(cleanUrl, "_blank", "noopener,noreferrer");
  }
  return { opened: true, error: null };
}

/**
 * Opens a known first-party setup destination (`facebook.com` or `t.me/<bot>`).
 */
export function openSafeSetupUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const allowed =
      ALLOWED_FB_ORIGINS.has(parsed.origin) ||
      (parsed.origin === "https://t.me" && /^\/[A-Za-z0-9_]{3,64}$/.test(parsed.pathname));
    if (!allowed) return false;
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * CSV formula-injection guard (`07-notifications-export.md §5`):
 * Prefixes `'` if a cell starts with `=`, `+`, `-`, or `@`.
 */
export function escapeCsvCell(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let str = String(raw);
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
