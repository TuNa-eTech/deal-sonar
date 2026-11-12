// Data-driven ExtractorProfile engine (`02-extension.md §4.1–4.3, §7`).
// Supports `network` (JSON & NDJSON GraphQL), `embedded` (<script type="application/json">),
// `dom` ([role="article"] fallback), and Facebook Group discovery (`SourceInfo`).

import type {
  Attachment,
  AttachmentKind,
  AuthorInfo,
  ExtractionStrategy,
  ExtractorProfile,
  PostCounts,
  RawPost,
  SourceInfo,
  SourcePrivacy,
} from "../protocol";

export type StoryMarkerRule = {
  path: string;
  equals?: string;
  contains?: string;
};

export type NetworkExtractorFields = {
  post_id: string[];
  text: string[];
  author_id: string[];
  author_name: string[];
  author_typename: string[];
  is_anonymous: string[];
  created_at: string[];
  permalink: string[];
  attachments: string[];
  comments_count: string[];
  reactions_count: string[];
};

export type NetworkExtractorConfig = {
  url_patterns: string[];
  story_markers: StoryMarkerRule[];
  fields: NetworkExtractorFields;
};

export type DomExtractorConfig = {
  article_selector: string;
  text_selectors: string[];
  author_selectors: string[];
  permalink_selectors: string[];
  timestamp_selectors: string[];
  see_more_labels: string[];
};

export type SessionMarkersConfig = {
  login_url_patterns: string[];
  login_selectors: string[];
  login_texts: string[];
  checkpoint_url_patterns: string[];
  checkpoint_selectors: string[];
  checkpoint_texts: string[];
  rate_limit_texts: string[];
  inaccessible_texts: string[];
};

export const DEFAULT_NETWORK_CONFIG: NetworkExtractorConfig = {
  url_patterns: ["/api/graphql/", "/ajax/bz"],
  story_markers: [{ path: "__typename", equals: "Story" }],
  fields: {
    post_id: [
      "post_id",
      "legacy_story_hideable_id",
      "subscription_target_id",
      "comet_sections.content.story.post_id",
      "comet_sections.feedback.story.post_id",
      "id",
    ],
    text: [
      "message.text",
      "comet_sections.content.story.message.text",
      "comet_sections.content.story.comet_sections.message.story.message.text",
      "comet_sections.content.story.comet_sections.message_container.story.message.text",
      "attached_story.message.text",
    ],
    author_id: [
      "actors[0].id",
      "comet_sections.content.story.actors[0].id",
      "comet_sections.context_layout.story.comet_sections.actor_photo.story.actors[0].id",
    ],
    author_name: [
      "actors[0].name",
      "comet_sections.content.story.actors[0].name",
      "comet_sections.context_layout.story.comet_sections.title.story.actors[0].name",
    ],
    author_typename: [
      "actors[0].__typename",
      "comet_sections.content.story.actors[0].__typename",
    ],
    is_anonymous: [
      "is_author_anonymous",
      "actors[0].is_anonymous",
      "comet_sections.content.story.is_author_anonymous",
    ],
    created_at: [
      "creation_time",
      "publish_time",
      "comet_sections.context_layout.story.comet_sections.metadata[0].story.creation_time",
      "comet_sections.content.story.creation_time",
    ],
    permalink: [
      "url",
      "wwwURL",
      "permalink_url",
      "comet_sections.content.story.wwwURL",
      "comet_sections.content.story.url",
      "comet_sections.context_layout.story.comet_sections.metadata[0].story.url",
    ],
    attachments: ["attachments", "comet_sections.content.story.attachments"],
    comments_count: [
      "feedback.comment_count.total_count",
      "feedback.comments_count_summary_renderer.feedback.comment_rendering_instance.comments.total_count",
      "comet_sections.feedback.story.feedback_context.feedback_target_with_context.comment_rendering_instance.comments.total_count",
      "comment_count",
    ],
    reactions_count: [
      "feedback.reaction_count.count",
      "comet_sections.feedback.story.feedback_context.feedback_target_with_context.comet_ufi_summary_and_actions_renderer.feedback.reaction_count.count",
      "reaction_count.count",
      "reactions_count",
    ],
  },
};

export const DEFAULT_DOM_CONFIG: DomExtractorConfig = {
  article_selector:
    '[role="feed"] [role="article"], [role="main"] [role="article"], div[role="article"]',
  text_selectors: [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-testid="post_message"]',
    ".userContent",
  ],
  author_selectors: [
    '[data-ad-rendering-role="profile_name"] a',
    '[data-ad-rendering-role="profile_name"]',
    "h2 a",
    "h3 a",
    "h4 a",
    "strong a",
    "h2 span",
    "h3 span",
    "h4 span",
    "h2",
    "h3",
    "strong",
  ],
  permalink_selectors: [
    'a[href*="/posts/"]',
    'a[href*="/permalink/"]',
    'a[href*="multi_permalinks="]',
    'a[href*="story_fbid="]',
  ],
  timestamp_selectors: ["abbr[data-utime]", "time[datetime]"],
  see_more_labels: [
    "xem thêm",
    "see more",
    "… xem thêm",
    "... xem thêm",
    "…xem thêm",
    "...xem thêm",
    "… see more",
    "... see more",
  ],
};

export const DEFAULT_SESSION_MARKERS: SessionMarkersConfig = {
  login_url_patterns: ["/login", "login.php", "/recover/"],
  login_selectors: [
    "form#login_form",
    '[data-testid="royal_login_form"]',
    'form[action*="/login/"] input[name="pass"]',
  ],
  login_texts: [
    "bạn phải đăng nhập để tiếp tục",
    "you must log in to continue",
  ],
  checkpoint_url_patterns: [
    "/checkpoint/",
    "/challenge/",
    "/security/twofactor",
    "approvals_code",
  ],
  checkpoint_selectors: [
    "#checkpointBottomBar",
    'form[action*="/checkpoint/"]',
    '[data-testid="checkpoint_form"]',
  ],
  checkpoint_texts: [
    "xác minh danh tính của bạn",
    "confirm your identity",
    "kiểm tra bảo mật",
    "security check",
    "tài khoản của bạn đã tạm thời bị khóa",
    "we suspended your account",
  ],
  rate_limit_texts: [
    "bạn tạm thời bị chặn",
    "you're temporarily blocked",
    "you’re temporarily blocked",
    "có vẻ như bạn đang dùng tính năng này quá nhanh",
    "it looks like you were misusing this feature by going too fast",
  ],
  inaccessible_texts: [
    "nội dung này hiện không hiển thị",
    "this content isn't available right now",
    "trang này không hiển thị",
    "nhóm này đã bị xóa",
  ],
};

export const DEFAULT_EXTRACTOR_PROFILE: ExtractorProfile = {
  rev: 1,
  strategies: ["network", "embedded", "dom"],
  network: DEFAULT_NETWORK_CONFIG,
  dom: DEFAULT_DOM_CONFIG,
  session_markers: DEFAULT_SESSION_MARKERS,
};

// ── Safe Profile Resolution (merges partial/empty `{}` configs with defaults) ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(val: unknown, fallback: string[]): string[] {
  if (!Array.isArray(val)) return fallback;
  const filtered = val.filter((x): x is string => typeof x === "string" && x.length > 0);
  return filtered.length > 0 ? filtered : fallback;
}

export function resolveNetworkConfig(raw: unknown): NetworkExtractorConfig {
  if (!isPlainObject(raw)) return DEFAULT_NETWORK_CONFIG;
  const rawFields = isPlainObject(raw.fields) ? raw.fields : {};
  const rawMarkers = Array.isArray(raw.story_markers)
    ? raw.story_markers.filter(
        (m): m is StoryMarkerRule => isPlainObject(m) && typeof m.path === "string",
      )
    : [];

  return {
    url_patterns: asStringArray(raw.url_patterns, DEFAULT_NETWORK_CONFIG.url_patterns),
    story_markers:
      rawMarkers.length > 0 ? rawMarkers : DEFAULT_NETWORK_CONFIG.story_markers,
    fields: {
      post_id: asStringArray(rawFields.post_id, DEFAULT_NETWORK_CONFIG.fields.post_id),
      text: asStringArray(rawFields.text, DEFAULT_NETWORK_CONFIG.fields.text),
      author_id: asStringArray(
        rawFields.author_id,
        DEFAULT_NETWORK_CONFIG.fields.author_id,
      ),
      author_name: asStringArray(
        rawFields.author_name,
        DEFAULT_NETWORK_CONFIG.fields.author_name,
      ),
      author_typename: asStringArray(
        rawFields.author_typename,
        DEFAULT_NETWORK_CONFIG.fields.author_typename,
      ),
      is_anonymous: asStringArray(
        rawFields.is_anonymous,
        DEFAULT_NETWORK_CONFIG.fields.is_anonymous,
      ),
      created_at: asStringArray(
        rawFields.created_at,
        DEFAULT_NETWORK_CONFIG.fields.created_at,
      ),
      permalink: asStringArray(
        rawFields.permalink,
        DEFAULT_NETWORK_CONFIG.fields.permalink,
      ),
      attachments: asStringArray(
        rawFields.attachments,
        DEFAULT_NETWORK_CONFIG.fields.attachments,
      ),
      comments_count: asStringArray(
        rawFields.comments_count,
        DEFAULT_NETWORK_CONFIG.fields.comments_count,
      ),
      reactions_count: asStringArray(
        rawFields.reactions_count,
        DEFAULT_NETWORK_CONFIG.fields.reactions_count,
      ),
    },
  };
}

export function resolveDomConfig(raw: unknown): DomExtractorConfig {
  if (!isPlainObject(raw)) return DEFAULT_DOM_CONFIG;
  return {
    article_selector:
      typeof raw.article_selector === "string" && raw.article_selector.trim().length > 0
        ? raw.article_selector
        : DEFAULT_DOM_CONFIG.article_selector,
    text_selectors: asStringArray(raw.text_selectors, DEFAULT_DOM_CONFIG.text_selectors),
    author_selectors: asStringArray(
      raw.author_selectors,
      DEFAULT_DOM_CONFIG.author_selectors,
    ),
    permalink_selectors: asStringArray(
      raw.permalink_selectors,
      DEFAULT_DOM_CONFIG.permalink_selectors,
    ),
    timestamp_selectors: asStringArray(
      raw.timestamp_selectors,
      DEFAULT_DOM_CONFIG.timestamp_selectors,
    ),
    see_more_labels: asStringArray(
      raw.see_more_labels,
      DEFAULT_DOM_CONFIG.see_more_labels,
    ),
  };
}

export function resolveSessionMarkers(raw: unknown): SessionMarkersConfig {
  if (!isPlainObject(raw)) return DEFAULT_SESSION_MARKERS;
  return {
    login_url_patterns: asStringArray(
      raw.login_url_patterns,
      DEFAULT_SESSION_MARKERS.login_url_patterns,
    ),
    login_selectors: asStringArray(
      raw.login_selectors,
      DEFAULT_SESSION_MARKERS.login_selectors,
    ),
    login_texts: asStringArray(raw.login_texts, DEFAULT_SESSION_MARKERS.login_texts),
    checkpoint_url_patterns: asStringArray(
      raw.checkpoint_url_patterns,
      DEFAULT_SESSION_MARKERS.checkpoint_url_patterns,
    ),
    checkpoint_selectors: asStringArray(
      raw.checkpoint_selectors,
      DEFAULT_SESSION_MARKERS.checkpoint_selectors,
    ),
    checkpoint_texts: asStringArray(
      raw.checkpoint_texts,
      DEFAULT_SESSION_MARKERS.checkpoint_texts,
    ),
    rate_limit_texts: asStringArray(
      raw.rate_limit_texts,
      DEFAULT_SESSION_MARKERS.rate_limit_texts,
    ),
    inaccessible_texts: asStringArray(
      raw.inaccessible_texts,
      DEFAULT_SESSION_MARKERS.inaccessible_texts,
    ),
  };
}

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

function firstNonEmptyString(root: unknown, paths: readonly string[]): string | undefined {
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

function firstFiniteNumber(root: unknown, paths: readonly string[]): number | undefined {
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

function firstBoolean(root: unknown, paths: readonly string[]): boolean | undefined {
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

function stripFbPrefix(raw: string): string {
  return raw.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;?\s*/, "");
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

const ANONYMOUS_NAME_PATTERNS = [
  "thành viên ẩn danh",
  "người tham gia ẩn danh",
  "anonymous participant",
  "anonymous member",
  "anonymous author",
];

function isAnonymousAuthorName(name: string): boolean {
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

function decodeRelayStoryPostId(rawId: string): string | undefined {
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

function normalizeFacebookUrl(rawUrl: string | undefined, fallbackPath?: string): string {
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

function extractAttachmentsFromNode(
  node: Record<string, unknown>,
  paths: readonly string[],
): Attachment[] {
  const results: Attachment[] = [];
  const seenKeys = new Set<string>();

  for (const p of paths) {
    const rawList = getByPath(node, p);
    if (!Array.isArray(rawList)) continue;
    for (const entry of rawList) {
      if (!isPlainObject(entry)) continue;
      // Unwrap Comet `styles.attachment` if present
      const targetObj = isPlainObject(getByPath(entry, "styles.attachment"))
        ? (getByPath(entry, "styles.attachment") as Record<string, unknown>)
        : entry;

      const media = isPlainObject(targetObj.media) ? targetObj.media : undefined;
      const typeStr = String(
        media?.__typename ??
          targetObj.__typename ??
          entry.__typename ??
          targetObj.kind ??
          "",
      ).toLowerCase();

      let kind: AttachmentKind = "other";
      if (typeStr.includes("photo") || typeStr.includes("image")) {
        kind = "photo";
      } else if (typeStr.includes("video") || typeStr.includes("reel")) {
        kind = "video";
      } else if (
        typeStr.includes("external") ||
        typeStr.includes("share") ||
        typeStr.includes("link")
      ) {
        kind = "link";
      }

      const urlCandidate = firstNonEmptyString(targetObj, [
        "media.image.uri",
        "media.playable_url",
        "url",
        "target.url",
        "action_links[0].url",
      ]);

      const altCandidate = firstNonEmptyString(targetObj, [
        "media.accessibility_caption",
        "alt",
        "alt_text",
        "title_with_entities.text",
        "title",
      ]);

      const dedupeKey = `${kind}|${urlCandidate ?? ""}|${altCandidate ?? ""}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      const att: Attachment = { kind };
      if (urlCandidate) att.url = urlCandidate;
      if (altCandidate) att.alt = altCandidate;
      results.push(att);
    }
  }

  return results;
}

function matchesStoryMarkers(
  node: Record<string, unknown>,
  markers: readonly StoryMarkerRule[],
): boolean {
  for (const rule of markers) {
    const val = getByPath(node, rule.path);
    if (typeof val !== "string") continue;
    if (rule.equals !== undefined && val === rule.equals) return true;
    if (rule.contains !== undefined && val.includes(rule.contains)) return true;
  }
  return false;
}

function extractStoryNode(
  node: Record<string, unknown>,
  cfg: NetworkExtractorConfig,
  sourceExternalId: string,
  strategy: "network" | "embedded",
  profileRev: number,
  capturedAt: number,
): RawPost | null {
  const rawPermalink = firstNonEmptyString(node, cfg.fields.permalink);
  const rawPostId = firstNonEmptyString(node, cfg.fields.post_id);
  const permalinkPostId = extractPostIdFromPermalink(rawPermalink);

  let postId = rawPostId;
  if (postId && !/^\d+$/.test(postId)) {
    postId = permalinkPostId ?? decodeRelayStoryPostId(postId) ?? postId;
  } else if (!postId && permalinkPostId) {
    postId = permalinkPostId;
  }

  if (!postId) return null;

  const text = firstNonEmptyString(node, cfg.fields.text) ?? "";
  const attachments = extractAttachmentsFromNode(node, cfg.fields.attachments);

  // Skip empty layout wrapper Story fragments with neither text nor attachments
  if (!text && attachments.length === 0) {
    return null;
  }

  const authorTypename = firstNonEmptyString(node, cfg.fields.author_typename) ?? "";
  const explicitAnon = firstBoolean(node, cfg.fields.is_anonymous);
  const rawAuthorName = firstNonEmptyString(node, cfg.fields.author_name);
  const rawAuthorId = firstNonEmptyString(node, cfg.fields.author_id);

  const isAnonymous =
    explicitAnon === true ||
    authorTypename.toLowerCase().includes("anonymous") ||
    (rawAuthorName ? isAnonymousAuthorName(rawAuthorName) : !rawAuthorId);

  const author: AuthorInfo = {
    name: rawAuthorName ?? (isAnonymous ? "Thành viên ẩn danh" : "Thành viên nhóm"),
    is_anonymous: isAnonymous,
  };
  if (!isAnonymous && rawAuthorId) {
    author.external_id = rawAuthorId;
  }

  const createdAt = normalizeTimestampMs(firstFiniteNumber(node, cfg.fields.created_at));
  const fallbackPermalink = `/groups/${encodeURIComponent(sourceExternalId)}/posts/${encodeURIComponent(postId)}/`;
  const permalink = normalizeFacebookUrl(rawPermalink, fallbackPermalink);

  const comments = firstFiniteNumber(node, cfg.fields.comments_count);
  const reactions = firstFiniteNumber(node, cfg.fields.reactions_count);
  let counts: PostCounts | undefined;
  if (comments !== undefined || reactions !== undefined) {
    counts = {};
    if (comments !== undefined && comments >= 0) counts.comments = Math.round(comments);
    if (reactions !== undefined && reactions >= 0) counts.reactions = Math.round(reactions);
  }

  const post: RawPost = {
    platform: "facebook",
    post_id: postId,
    source_external_id: sourceExternalId,
    permalink,
    author,
    text,
    text_truncated: false,
    captured_at: capturedAt,
    attachments,
    extraction: {
      strategy,
      profile_rev: profileRev,
    },
  };
  if (createdAt !== undefined) {
    post.created_at = createdAt;
  }
  if (counts !== undefined) {
    post.counts = counts;
  }
  return post;
}

function mergeRawPosts(existing: RawPost, incoming: RawPost): RawPost {
  const mergedText =
    incoming.text.length > existing.text.length ? incoming.text : existing.text;
  const mergedAuthor: AuthorInfo = {
    name:
      existing.author.name && existing.author.name !== "Thành viên nhóm"
        ? existing.author.name
        : incoming.author.name,
    is_anonymous: existing.author.is_anonymous || incoming.author.is_anonymous,
  };
  if (!mergedAuthor.is_anonymous) {
    const extId = existing.author.external_id ?? incoming.author.external_id;
    if (extId) mergedAuthor.external_id = extId;
  }

  const mergedAttachments =
    existing.attachments.length >= incoming.attachments.length
      ? existing.attachments
      : incoming.attachments;

  const createdAt = existing.created_at ?? incoming.created_at;
  const comments = existing.counts?.comments ?? incoming.counts?.comments;
  const reactions = existing.counts?.reactions ?? incoming.counts?.reactions;

  const merged: RawPost = {
    ...existing,
    text: mergedText,
    text_truncated: existing.text_truncated && incoming.text_truncated,
    author: mergedAuthor,
    attachments: mergedAttachments,
  };
  if (createdAt !== undefined) {
    merged.created_at = createdAt;
  }
  if (comments !== undefined || reactions !== undefined) {
    merged.counts = {};
    if (comments !== undefined) merged.counts.comments = comments;
    if (reactions !== undefined) merged.counts.reactions = reactions;
  }
  return merged;
}

function walkTreeForStories(
  root: unknown,
  cfg: NetworkExtractorConfig,
  sourceExternalId: string,
  strategy: "network" | "embedded",
  profileRev: number,
  capturedAt: number,
  collected: Map<string, RawPost>,
): void {
  const stack: unknown[] = [root];
  const visited = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    if (matchesStoryMarkers(record, cfg.story_markers)) {
      const extracted = extractStoryNode(
        record,
        cfg,
        sourceExternalId,
        strategy,
        profileRev,
        capturedAt,
      );
      if (extracted) {
        const prev = collected.get(extracted.post_id);
        collected.set(
          extracted.post_id,
          prev ? mergeRawPosts(prev, extracted) : extracted,
        );
      }
    }

    const values = Object.values(record);
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== null && typeof v === "object") {
        stack.push(v);
      }
    }
  }
}

/** Strategy (a): Extract posts from captured GraphQL/XHR JSON or NDJSON payloads. */
export function extractFromNetwork(
  payloads: readonly string[],
  sourceExternalId: string,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
  capturedAt: number = Date.now(),
): RawPost[] {
  const cfg = resolveNetworkConfig(profile.network);
  const collected = new Map<string, RawPost>();

  for (const body of payloads) {
    const docs = parseJsonDocuments(body);
    for (const doc of docs) {
      walkTreeForStories(
        doc,
        cfg,
        sourceExternalId,
        "network",
        profile.rev,
        capturedAt,
        collected,
      );
    }
  }

  return Array.from(collected.values());
}

/** Strategy (b): Extract posts from `<script type="application/json">` blocks in the page. */
export function extractFromEmbedded(
  doc: Document,
  sourceExternalId: string,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
  capturedAt: number = Date.now(),
): RawPost[] {
  const cfg = resolveNetworkConfig(profile.network);
  const collected = new Map<string, RawPost>();
  const scripts = doc.querySelectorAll('script[type="application/json"]');

  scripts.forEach((scriptEl) => {
    const rawText = scriptEl.textContent;
    if (!rawText || rawText.trim().length < 10) return;
    const jsonDocs = parseJsonDocuments(rawText);
    for (const parsed of jsonDocs) {
      walkTreeForStories(
        parsed,
        cfg,
        sourceExternalId,
        "embedded",
        profile.rev,
        capturedAt,
        collected,
      );
    }
  });

  return Array.from(collected.values());
}

// ── Strategy (c): Fallback DOM `[role="article"]` Extractor ──

export function isCommentArticle(el: Element): boolean {
  // Nested `[role="article"]` inside another `[role="article"]` is a comment (D-8: never collect comments)
  if (el.parentElement?.closest('[role="article"]')) {
    return true;
  }
  const ariaLabel = (el.getAttribute("aria-label") ?? "").trim().toLowerCase();
  if (
    ariaLabel.startsWith("bình luận") ||
    ariaLabel.startsWith("phản hồi") ||
    ariaLabel.startsWith("comment by") ||
    ariaLabel.startsWith("reply by")
  ) {
    return true;
  }
  return false;
}

function extractAuthorIdFromHref(href: string | null): string | undefined {
  if (!href) return undefined;
  const userMatch = /\/user\/(\d+)/i.exec(href);
  if (userMatch?.[1]) return userMatch[1];
  const profileMatch = /[?&]id=(\d+)/i.exec(href);
  if (profileMatch?.[1]) return profileMatch[1];
  return undefined;
}

function hasUnexpandedSeeMore(articleEl: Element, seeMoreLabels: readonly string[]): boolean {
  const labelSet = new Set(seeMoreLabels.map((s) => s.trim().toLowerCase()));
  const buttons = articleEl.querySelectorAll('div[role="button"], span[role="button"], button');
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i]!;
    if (btn.closest('[role="article"]') !== articleEl) continue;
    const text = (btn.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (labelSet.has(text)) return true;
  }
  return false;
}

function stripSeeMoreSuffix(text: string, seeMoreLabels: readonly string[]): string {
  let cleaned = text.trim();
  for (const label of seeMoreLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffixRe = new RegExp(`(?:\\s*[…\\.]{0,3}\\s*)${escaped}\\s*$`, "i");
    cleaned = cleaned.replace(suffixRe, "").trim();
  }
  return cleaned;
}

function extractDomTimestampMs(
  articleEl: Element,
  selectors: readonly string[],
): number | undefined {
  for (const sel of selectors) {
    const el = articleEl.querySelector(sel);
    if (!el) continue;
    const utime = el.getAttribute("data-utime");
    if (utime && /^\d+$/.test(utime)) {
      return normalizeTimestampMs(Number(utime));
    }
    const datetime = el.getAttribute("datetime");
    if (datetime) {
      const parsed = Date.parse(datetime);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractDomAttachments(articleEl: Element): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();

  const images = articleEl.querySelectorAll("img[src]");
  images.forEach((img) => {
    if (img.closest('[role="article"]') !== articleEl) return;
    const src = img.getAttribute("src") ?? "";
    if (!src || src.startsWith("data:")) return;
    // Skip emojis, static icons, and small avatar thumbnails
    if (src.includes("emoji.php") || src.includes("/images/emoji")) return;
    const widthAttr = Number(img.getAttribute("width") ?? "0");
    const heightAttr = Number(img.getAttribute("height") ?? "0");
    if ((widthAttr > 0 && widthAttr <= 48) || (heightAttr > 0 && heightAttr <= 48)) {
      return;
    }
    if (seen.has(src)) return;
    seen.add(src);
    const alt = (img.getAttribute("alt") ?? "").trim();
    const att: Attachment = { kind: "photo", url: src };
    if (alt) att.alt = alt;
    attachments.push(att);
  });

  const videos = articleEl.querySelectorAll("video");
  videos.forEach((vid) => {
    if (vid.closest('[role="article"]') !== articleEl) return;
    const src = vid.getAttribute("src") ?? undefined;
    const key = `video:${src ?? attachments.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    const att: Attachment = { kind: "video" };
    if (src) att.url = src;
    attachments.push(att);
  });

  return attachments;
}

/** Strategy (c): Fallback DOM `[role="article"]` extractor (`02-extension.md §4.3`). */
export function extractFromDom(
  doc: Document,
  sourceExternalId: string,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
  capturedAt: number = Date.now(),
): RawPost[] {
  const cfg = resolveDomConfig(profile.dom);
  const collected = new Map<string, RawPost>();

  let articles: NodeListOf<Element>;
  try {
    articles = doc.querySelectorAll(cfg.article_selector);
  } catch {
    articles = doc.querySelectorAll('[role="article"]');
  }

  articles.forEach((articleEl) => {
    if (isCommentArticle(articleEl)) return;

    // 1. Resolve permalink & post_id
    let rawPermalink: string | undefined;
    let postId: string | undefined =
      articleEl.getAttribute("data-post-id")?.trim() || undefined;

    for (const sel of cfg.permalink_selectors) {
      const anchors = articleEl.querySelectorAll(sel);
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]!;
        if (a.closest('[role="article"]') !== articleEl) continue;
        const href = a.getAttribute("href");
        if (!href) continue;
        const candidateId = extractPostIdFromPermalink(href);
        if (candidateId) {
          rawPermalink = href;
          if (!postId) postId = candidateId;
          break;
        }
      }
      if (rawPermalink && postId) break;
    }

    if (!postId) return;

    // 2. Extract post text
    let rawText = "";
    for (const sel of cfg.text_selectors) {
      const textEl = articleEl.querySelector(sel);
      if (textEl && textEl.closest('[role="article"]') === articleEl) {
        const t = (textEl.textContent ?? "").trim();
        if (t.length > rawText.length) {
          rawText = t;
        }
      }
    }

    if (!rawText) {
      // Fallback: collect `[dir="auto"]` blocks outside header links
      const dirBlocks = articleEl.querySelectorAll('div[dir="auto"]');
      const chunks: string[] = [];
      dirBlocks.forEach((b) => {
        if (b.closest('[role="article"]') !== articleEl) return;
        if (b.closest("h2, h3, h4, [role='toolbar'], form")) return;
        const t = (b.textContent ?? "").trim();
        if (t.length > 0) chunks.push(t);
      });
      rawText = chunks.join("\n").trim();
    }

    const truncatedByButton = hasUnexpandedSeeMore(articleEl, cfg.see_more_labels);
    const truncatedByEllipsis = /(?:…|\.\.\.)\s*(?:xem thêm|see more)\s*$/i.test(rawText);
    const textTruncated = truncatedByButton || truncatedByEllipsis;
    const text = stripSeeMoreSuffix(rawText, cfg.see_more_labels);

    const attachments = extractDomAttachments(articleEl);
    if (!text && attachments.length === 0) return;

    // 3. Extract author
    let authorName = "";
    let authorHref: string | null = null;
    for (const sel of cfg.author_selectors) {
      const el = articleEl.querySelector(sel);
      if (el && el.closest('[role="article"]') === articleEl) {
        const candidate = (el.textContent ?? "").trim();
        if (candidate) {
          authorName = candidate;
          authorHref =
            el.tagName.toLowerCase() === "a"
              ? el.getAttribute("href")
              : el.querySelector("a")?.getAttribute("href") ?? null;
          break;
        }
      }
    }

    const isAnonymous = authorName
      ? isAnonymousAuthorName(authorName)
      : false;
    const author: AuthorInfo = {
      name: authorName || (isAnonymous ? "Thành viên ẩn danh" : "Thành viên nhóm"),
      is_anonymous: isAnonymous,
    };
    if (!isAnonymous) {
      const authorExtId = extractAuthorIdFromHref(authorHref);
      if (authorExtId) author.external_id = authorExtId;
    }

    // 4. Optional timestamp (omitted when unavailable in DOM per `02-extension.md §4.3`)
    const createdAt = extractDomTimestampMs(articleEl, cfg.timestamp_selectors);
    const fallbackPath = `/groups/${encodeURIComponent(sourceExternalId)}/posts/${encodeURIComponent(postId)}/`;
    const permalink = normalizeFacebookUrl(rawPermalink, fallbackPath);

    const post: RawPost = {
      platform: "facebook",
      post_id: postId,
      source_external_id: sourceExternalId,
      permalink,
      author,
      text,
      text_truncated: textTruncated,
      captured_at: capturedAt,
      attachments,
      extraction: {
        strategy: "dom",
        profile_rev: profile.rev,
      },
    };
    if (createdAt !== undefined) {
      post.created_at = createdAt;
    }

    if (!collected.has(postId)) {
      collected.set(postId, post);
    }
  });

  return Array.from(collected.values());
}

// ── Combined Multi-Strategy Pipeline (`02-extension.md §4`) ──

export type ExtractionPipelineInput = {
  networkPayloads: readonly string[];
  doc: Document;
  sourceExternalId: string;
  profile?: ExtractorProfile;
  capturedAt?: number;
};

export type ExtractionPipelineOutput = {
  posts: RawPost[];
  primaryStrategy: ExtractionStrategy;
};

export function runExtractionPipeline(
  input: ExtractionPipelineInput,
): ExtractionPipelineOutput {
  const profile = input.profile ?? DEFAULT_EXTRACTOR_PROFILE;
  const capturedAt = input.capturedAt ?? Date.now();
  const strategies: ExtractionStrategy[] =
    Array.isArray(profile.strategies) && profile.strategies.length > 0
      ? profile.strategies
      : DEFAULT_EXTRACTOR_PROFILE.strategies;

  const byId = new Map<string, RawPost>();
  let primaryStrategy: ExtractionStrategy = strategies[0] ?? "network";
  let primaryStrategySet = false;

  for (const strategy of strategies) {
    if (strategy === "network") {
      const posts = extractFromNetwork(
        input.networkPayloads,
        input.sourceExternalId,
        profile,
        capturedAt,
      );
      if (posts.length > 0 && !primaryStrategySet) {
        primaryStrategy = "network";
        primaryStrategySet = true;
      }
      for (const p of posts) {
        const existing = byId.get(p.post_id);
        byId.set(p.post_id, existing ? mergeRawPosts(existing, p) : p);
      }
    } else if (strategy === "embedded") {
      const posts = extractFromEmbedded(
        input.doc,
        input.sourceExternalId,
        profile,
        capturedAt,
      );
      if (posts.length > 0 && !primaryStrategySet) {
        primaryStrategy = "embedded";
        primaryStrategySet = true;
      }
      for (const p of posts) {
        const existing = byId.get(p.post_id);
        byId.set(p.post_id, existing ? mergeRawPosts(existing, p) : p);
      }
    } else if (strategy === "dom") {
      // `dom` is fallback: run when earlier strategies yielded 0 posts, or when `dom` is first
      if (byId.size === 0) {
        const posts = extractFromDom(
          input.doc,
          input.sourceExternalId,
          profile,
          capturedAt,
        );
        if (posts.length > 0 && !primaryStrategySet) {
          primaryStrategy = "dom";
          primaryStrategySet = true;
        }
        for (const p of posts) {
          if (!byId.has(p.post_id)) {
            byId.set(p.post_id, p);
          }
        }
      }
    }
  }

  return {
    posts: Array.from(byId.values()),
    primaryStrategy,
  };
}

// ── Group Discovery (`02-extension.md §7`) ──

const RESERVED_GROUP_SLUGS = new Set([
  "joins",
  "feed",
  "discover",
  "create",
  "notifications",
  "search",
  "settings",
  "categories",
  "browse",
]);

export function extractGroupSlugOrIdFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, "https://www.facebook.com");
    if (!parsed.hostname.endsWith("facebook.com")) return null;
    const match = /^\/groups\/([^/?#]+)/i.exec(parsed.pathname);
    if (!match?.[1]) return null;
    const slug = decodeURIComponent(match[1]).trim();
    if (!slug || RESERVED_GROUP_SLUGS.has(slug.toLowerCase())) {
      return null;
    }
    return slug;
  } catch {
    return null;
  }
}

export function isJoinedGroupsHubUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, "https://www.facebook.com");
    if (!parsed.hostname.endsWith("facebook.com")) return false;
    const normalized = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return (
      normalized === "/groups" ||
      normalized === "/groups/joins" ||
      normalized === "/groups/feed"
    );
  } catch {
    return false;
  }
}

export function parsePrivacyFromText(raw: string | undefined): SourcePrivacy | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (
    lower.includes("riêng tư") ||
    lower.includes("nhóm kín") ||
    lower.includes("private") ||
    lower === "closed"
  ) {
    return "private";
  }
  if (lower.includes("công khai") || lower.includes("public") || lower === "open") {
    return "public";
  }
  return undefined;
}

/** Parse Vietnamese & English member counts (e.g., `"45,2K thành viên"`, `"1,2 triệu thành viên"`, `"12.500 members"`). */
export function parseMemberCountFromText(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (!lower.includes("thành viên") && !lower.includes("member")) {
    return undefined;
  }

  // Match number + optional unit before "thành viên" / "members"
  const re =
    /(\d+(?:[.,]\d+)*)\s*(tr|triệu|m|k|nghìn|ngàn)?\s*(?:thành viên|members?)/i;
  const match = re.exec(raw);
  if (!match?.[1]) return undefined;

  const numRaw = match[1];
  const unit = (match[2] ?? "").toLowerCase();

  let value: number;
  if (unit) {
    // Decimal separator in compact form (`45,2K` or `45.2K`)
    value = Number(numRaw.replace(",", "."));
    if (!Number.isFinite(value)) return undefined;
    if (unit === "k" || unit === "nghìn" || unit === "ngàn") {
      value *= 1_000;
    } else if (unit === "m" || unit === "tr" || unit === "triệu") {
      value *= 1_000_000;
    }
  } else {
    // Plain integer with thousand separators (`12.500` or `12,500` or `850`)
    const digitsOnly = numRaw.replace(/[.,]/g, "");
    value = Number(digitsOnly);
  }

  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function walkTreeForGroups(root: unknown, out: Map<string, SourceInfo>): void {
  const stack: unknown[] = [root];
  const visited = new WeakSet<object>();

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (visited.has(cur)) continue;
    visited.add(cur);

    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      continue;
    }

    const obj = cur as Record<string, unknown>;
    if (obj.__typename === "Group") {
      const id = firstNonEmptyString(obj, ["id", "groupID"]);
      const name = firstNonEmptyString(obj, ["name", "title"]);
      const rawUrl = firstNonEmptyString(obj, ["url", "wwwURL"]);
      const slugFromUrl = rawUrl ? extractGroupSlugOrIdFromUrl(rawUrl) : null;
      const externalId = id ?? slugFromUrl ?? undefined;

      if (externalId && name) {
        const privacy = parsePrivacyFromText(
          firstNonEmptyString(obj, [
            "visibility",
            "privacy_info.title.text",
            "group_privacy",
          ]),
        );
        const memberCount = firstFiniteNumber(obj, [
          "group_member_profiles.count",
          "member_count",
          "members_count",
        ]);
        const url = normalizeFacebookUrl(
          rawUrl,
          `/groups/${encodeURIComponent(externalId)}/`,
        );

        const existing = out.get(externalId);
        const info: SourceInfo = {
          platform: "facebook",
          kind: "group",
          external_id: externalId,
          name: existing?.name ?? name,
          url: existing?.url ?? url,
        };
        const mergedPrivacy = privacy ?? existing?.privacy;
        if (mergedPrivacy) info.privacy = mergedPrivacy;
        const mergedCount =
          memberCount !== undefined
            ? Math.round(memberCount)
            : existing?.member_count;
        if (mergedCount !== undefined) info.member_count = mergedCount;
        out.set(externalId, info);
      }
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === "object") stack.push(val);
    }
  }
}

function cleanGroupTitle(raw: string): string {
  return raw
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*[|–-]\s*Facebook\s*$/i, "")
    .trim();
}

/** Extract `SourceInfo` for the group currently open in the tab (used by "Theo dõi group này"). */
export function extractCurrentGroupInfo(
  doc: Document,
  currentUrl: string,
): SourceInfo | null {
  const slugOrId = extractGroupSlugOrIdFromUrl(currentUrl);
  if (!slugOrId) return null;

  // Check embedded JSON for rich group metadata
  const embeddedGroups = new Map<string, SourceInfo>();
  doc.querySelectorAll('script[type="application/json"]').forEach((s) => {
    if (!s.textContent) return;
    for (const parsed of parseJsonDocuments(s.textContent)) {
      walkTreeForGroups(parsed, embeddedGroups);
    }
  });

  let matchedEmbedded: SourceInfo | undefined = embeddedGroups.get(slugOrId);
  if (!matchedEmbedded) {
    for (const g of embeddedGroups.values()) {
      const gSlug = extractGroupSlugOrIdFromUrl(g.url);
      if (gSlug && gSlug.toLowerCase() === slugOrId.toLowerCase()) {
        matchedEmbedded = g;
        break;
      }
    }
  }

  // Extract name from DOM header / meta / title
  const h1Text = cleanGroupTitle(doc.querySelector("h1")?.textContent ?? "");
  const ogTitle = cleanGroupTitle(
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "",
  );
  const docTitle = cleanGroupTitle(doc.title ?? "");

  const name =
    matchedEmbedded?.name ||
    h1Text ||
    ogTitle ||
    (docTitle && docTitle.toLowerCase() !== "facebook" ? docTitle : "") ||
    `Nhóm ${slugOrId}`;

  const headerContainer =
    doc.querySelector('[role="main"]') ?? doc.body ?? doc.documentElement;
  const headerText = (headerContainer?.textContent ?? "").slice(0, 4000);

  const privacy = matchedEmbedded?.privacy ?? parsePrivacyFromText(headerText);
  const memberCount =
    matchedEmbedded?.member_count ?? parseMemberCountFromText(headerText);

  const externalId = matchedEmbedded?.external_id ?? slugOrId;
  const canonicalUrl = `https://www.facebook.com/groups/${encodeURIComponent(externalId)}/`;

  const info: SourceInfo = {
    platform: "facebook",
    kind: "group",
    external_id: externalId,
    name,
    url: canonicalUrl,
  };
  if (privacy) info.privacy = privacy;
  if (memberCount !== undefined) info.member_count = memberCount;
  return info;
}

/** Extract list of joined groups from `/groups/joins` or `/groups/feed` (`02-extension.md §7`). */
export function extractJoinedGroups(
  doc: Document,
  _currentUrl?: string,
  networkPayloads: readonly string[] = [],
): SourceInfo[] {
  const byId = new Map<string, SourceInfo>();

  // 1. Embedded JSON scripts
  doc.querySelectorAll('script[type="application/json"]').forEach((s) => {
    if (!s.textContent) return;
    for (const parsed of parseJsonDocuments(s.textContent)) {
      walkTreeForGroups(parsed, byId);
    }
  });

  // 2. Network GraphQL payloads
  for (const body of networkPayloads) {
    for (const parsed of parseJsonDocuments(body)) {
      walkTreeForGroups(parsed, byId);
    }
  }

  // 3. DOM group links & cards
  const root = doc.querySelector('[role="main"]') ?? doc.body;
  if (root) {
    const links = root.querySelectorAll('a[href*="/groups/"]');
    links.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      // Skip individual post permalinks when discovering groups
      if (/\/(?:posts|permalink)\//i.test(href) || href.includes("multi_permalinks=")) {
        return;
      }
      const slugOrId = extractGroupSlugOrIdFromUrl(href);
      if (!slugOrId) return;

      const linkText = cleanGroupTitle((a.textContent ?? "").replace(/\s+/g, " "));
      if (!linkText || linkText.length < 2) return;
      // Ignore action links like "Xem nhóm" / "View group" if we already have this group
      const lowerLink = linkText.toLowerCase();
      if (
        lowerLink === "xem nhóm" ||
        lowerLink === "view group" ||
        lowerLink === "truy cập"
      ) {
        return;
      }

      const cardEl =
        a.closest('[role="listitem"], [data-visualcompletion], li, article') ??
        a.parentElement;
      const cardText = cardEl?.textContent ?? "";
      const privacy = parsePrivacyFromText(cardText);
      const memberCount = parseMemberCountFromText(cardText);

      // Avoid duplicating if embedded JSON already matched by URL slug
      for (const existing of byId.values()) {
        const existingSlug = extractGroupSlugOrIdFromUrl(existing.url);
        if (
          existing.external_id === slugOrId ||
          (existingSlug && existingSlug.toLowerCase() === slugOrId.toLowerCase())
        ) {
          if (!existing.privacy && privacy) existing.privacy = privacy;
          if (existing.member_count === undefined && memberCount !== undefined) {
            existing.member_count = memberCount;
          }
          return;
        }
      }

      const info: SourceInfo = {
        platform: "facebook",
        kind: "group",
        external_id: slugOrId,
        name: linkText,
        url: `https://www.facebook.com/groups/${encodeURIComponent(slugOrId)}/`,
      };
      if (privacy) info.privacy = privacy;
      if (memberCount !== undefined) info.member_count = memberCount;
      byId.set(slugOrId, info);
    });
  }

  return Array.from(byId.values());
}
