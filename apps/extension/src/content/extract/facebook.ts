// Facebook-specific URL, post-id, and author-name normalization.

export function stripFbPrefix(raw: string): string {
  return raw.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;?\s*/, "");
}

const ANONYMOUS_NAME_PATTERNS = [
  "thành viên ẩn danh",
  "người tham gia ẩn danh",
  "anonymous participant",
  "anonymous member",
  "anonymous author",
];

export function isAnonymousAuthorName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return ANONYMOUS_NAME_PATTERNS.some((pat) => lower === pat || lower.includes(pat));
}

export function extractPostIdFromPermalink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const patterns = [
    /\/groups\/[^/?#]+\/(?:posts|permalink)\/(\d+)/i,
    /[?&]multi_permalinks=(\d+)/i,
    /[?&]story_fbid=(\d+)/i,
    /\/posts\/(\d+)/i,
    /\/permalink\/(\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export function decodeRelayStoryPostId(rawId: string): string | undefined {
  // Relay IDs like `UzpfSTEwMDAw...:VK:987654321` or `S:_I...:987654321`
  if (/^\d+$/.test(rawId)) return rawId;
  if (rawId.includes(":")) {
    const lastSeg = rawId.split(":").pop();
    if (lastSeg && /^\d{5,}$/.test(lastSeg)) return lastSeg;
  }
  try {
    if (/^[A-Za-z0-9+/=]{12,}$/.test(rawId) && typeof atob === "function") {
      const decoded = atob(rawId);
      const colonMatch = /:(\d{5,})$/.exec(decoded);
      if (colonMatch?.[1]) return colonMatch[1];
    }
  } catch {
    // Keep original ID if not base64
  }
  return undefined;
}

export function normalizeFacebookUrl(rawUrl: string | undefined, fallbackPath?: string): string {
  if (rawUrl && rawUrl.trim().length > 0) {
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.hostname.endsWith("facebook.com")) {
          // Strip tracking params while preserving story identifiers if needed
          parsed.searchParams.delete("__cft__[0]");
          parsed.searchParams.delete("__tn__");
          parsed.searchParams.delete("refid");
        }
        return parsed.toString();
      } catch {
        return trimmed;
      }
    }
    if (trimmed.startsWith("/")) {
      return `https://www.facebook.com${trimmed}`;
    }
  }
  return fallbackPath
    ? `https://www.facebook.com${fallbackPath}`
    : "https://www.facebook.com/groups/";
}
