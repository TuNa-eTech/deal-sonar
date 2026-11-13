// ExtractorProfile types, built-in defaults, and safe resolution of partial configs.

import type { ExtractorProfile } from "../../protocol";

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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
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
