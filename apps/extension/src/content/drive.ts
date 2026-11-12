// Page controller (`02-extension.md §5, §6.4` & P1–P4 safety):
// - Session health detection (`ok`, `logged_out`, `checkpoint`, `rate_limited`)
// - Inaccessible group detection
// - Strictly read-only "Xem thêm" / "See more" text expansion inside post articles
// - Controlled scroll step driver with early-stop on `seen_post_ids` or `max_posts`

import type { CrawlPageResult, SessionDetection } from "../messages";
import type {
  ExtractionStrategy,
  ExtractorProfile,
  RawPost,
  SourceRef,
} from "../protocol";
import {
  DEFAULT_EXTRACTOR_PROFILE,
  DEFAULT_SESSION_MARKERS,
  isCommentArticle,
  resolveDomConfig,
  resolveSessionMarkers,
  runExtractionPipeline,
  type SessionMarkersConfig,
} from "./extract";

/** Inspect URL alone for login or checkpoint redirects (usable from both SW `tabs` & content script). */
export function detectSessionFromUrl(
  rawUrl: string,
  markers: SessionMarkersConfig = DEFAULT_SESSION_MARKERS,
): SessionDetection | null {
  if (!rawUrl) return null;
  const lower = rawUrl.toLowerCase();

  for (const pat of markers.checkpoint_url_patterns) {
    if (pat && lower.includes(pat.toLowerCase())) {
      return {
        state: "checkpoint",
        detail: `Chuyển hướng xác minh: ${pat}`,
      };
    }
  }

  for (const pat of markers.login_url_patterns) {
    if (pat && lower.includes(pat.toLowerCase())) {
      return {
        state: "logged_out",
        detail: `Chuyển hướng đăng nhập: ${pat}`,
      };
    }
  }

  return null;
}

/** Collect visible text outside feed post `[role="article"]` nodes so post text never spoofs session state. */
function collectNonArticleText(doc: Document): string {
  const root = doc.body ?? doc.documentElement;
  if (!root) return "";

  const parts: string[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest('[role="article"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current: Node | null;
  let totalLen = 0;
  while ((current = walker.nextNode()) !== null && totalLen < 20_000) {
    const val = current.nodeValue?.trim();
    if (val) {
      parts.push(val);
      totalLen += val.length;
    }
  }

  return parts.join(" ").toLowerCase();
}

function countTopLevelPostArticles(doc: Document): number {
  const all = doc.querySelectorAll('[role="article"]');
  let count = 0;
  all.forEach((el) => {
    if (!isCommentArticle(el)) count++;
  });
  return count;
}

export function detectSessionStatus(
  doc: Document,
  currentUrl: string,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
): SessionDetection {
  const markers = resolveSessionMarkers(profile.session_markers);

  // 1. URL-based redirect check
  const urlDetection = detectSessionFromUrl(currentUrl, markers);
  if (urlDetection) return urlDetection;

  // 2. DOM selector checks for checkpoint
  for (const sel of markers.checkpoint_selectors) {
    try {
      if (doc.querySelector(sel)) {
        return { state: "checkpoint", detail: `Phát hiện biểu mẫu xác minh (${sel})` };
      }
    } catch {
      // Ignore invalid custom selector
    }
  }

  // 3. DOM selector checks for login form (when feed articles are absent)
  const postArticleCount = countTopLevelPostArticles(doc);
  if (postArticleCount === 0) {
    for (const sel of markers.login_selectors) {
      try {
        if (doc.querySelector(sel)) {
          return { state: "logged_out", detail: `Phát hiện biểu mẫu đăng nhập (${sel})` };
        }
      } catch {
        // Ignore invalid custom selector
      }
    }
  }

  // 4. Non-article page & modal banner text checks
  const nonArticleText = collectNonArticleText(doc);

  for (const phrase of markers.rate_limit_texts) {
    if (phrase && nonArticleText.includes(phrase.toLowerCase())) {
      return {
        state: "rate_limited",
        detail: `Thông báo giới hạn tạm thời: ${phrase}`,
      };
    }
  }

  if (postArticleCount === 0) {
    for (const phrase of markers.checkpoint_texts) {
      if (phrase && nonArticleText.includes(phrase.toLowerCase())) {
        return {
          state: "checkpoint",
          detail: `Yêu cầu xác minh: ${phrase}`,
        };
      }
    }

    for (const phrase of markers.login_texts) {
      if (phrase && nonArticleText.includes(phrase.toLowerCase())) {
        return {
          state: "logged_out",
          detail: `Yêu cầu đăng nhập: ${phrase}`,
        };
      }
    }
  }

  return { state: "ok" };
}

export function detectGroupInaccessible(
  doc: Document,
  _currentUrl: string,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
): { inaccessible: boolean; reason?: string } {
  if (countTopLevelPostArticles(doc) > 0) {
    return { inaccessible: false };
  }

  const markers = resolveSessionMarkers(profile.session_markers);
  const nonArticleText = collectNonArticleText(doc);

  for (const phrase of markers.inaccessible_texts) {
    if (phrase && nonArticleText.includes(phrase.toLowerCase())) {
      return {
        inaccessible: true,
        reason: `Group không truy cập được: ${phrase}`,
      };
    }
  }

  // Private group where user is no longer a member (P4: never auto-join; skip source)
  const hasPrivateNotice =
    nonArticleText.includes("nhóm riêng tư") || nonArticleText.includes("private group");
  const hasJoinGate =
    nonArticleText.includes("tham gia nhóm") || nonArticleText.includes("join group");
  if (hasPrivateNotice && hasJoinGate) {
    return {
      inaccessible: true,
      reason: "Chưa là thành viên của nhóm riêng tư",
    };
  }

  return { inaccessible: false };
}

// ── Safe Read-Only "Xem thêm" / "See more" Text Expansion (P1 Safety) ──

const FORBIDDEN_ACTION_KEYWORDS = [
  "thích",
  "like",
  "bình luận",
  "phản hồi",
  "comment",
  "reply",
  "chia sẻ",
  "share",
  "tham gia",
  "join",
  "theo dõi",
  "follow",
  "nhắn tin",
  "message",
  "gửi",
  "send",
  "đăng",
  "post",
  "lưu",
  "save",
  "báo cáo",
  "report",
  "ẩn",
  "hide",
  "chặn",
  "block",
];

const expandedElements = new WeakSet<Element>();

export function isSafeSeeMoreButton(
  el: Element,
  allowedLabels: ReadonlySet<string>,
): boolean {
  if (expandedElements.has(el)) return false;

  // Must be inside a top-level post article, NEVER a comment article or outside feed
  const parentArticle = el.closest('[role="article"]');
  if (!parentArticle || isCommentArticle(parentArticle)) {
    return false;
  }

  // NEVER click anchors or anything inside an `<a href>` link
  const tag = el.tagName.toLowerCase();
  if (tag === "a" || el.closest("a[href]")) {
    return false;
  }

  // Must be an explicit button-role element, never a form submit or toolbar action
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (tag !== "button" && role !== "button") {
    return false;
  }
  if (tag === "button") {
    const btnType = (el.getAttribute("type") ?? "button").toLowerCase();
    if (btnType === "submit") return false;
  }
  if (el.closest('form, [role="toolbar"], [role="navigation"], h1, h2, h3, h4')) {
    return false;
  }

  // Exact normalized text match against safe "Xem thêm" / "See more" labels
  const normalizedText = (el.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!allowedLabels.has(normalizedText)) {
    return false;
  }

  // Verify aria-label / title do not hint at any write/social interaction
  const combinedAttrs = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`
    .trim()
    .toLowerCase();
  if (combinedAttrs) {
    for (const kw of FORBIDDEN_ACTION_KEYWORDS) {
      if (combinedAttrs.includes(kw)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Clicks ONLY verified read-only "Xem thêm" / "See more" post-text expansion buttons
 * inside top-level post articles. Returns the number of expanded buttons.
 */
export function expandSeeMoreButtons(
  root: ParentNode,
  profile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE,
  maxClicks: number = 25,
): number {
  const domCfg = resolveDomConfig(profile.dom);
  const allowedLabels = new Set(
    domCfg.see_more_labels.map((l) => l.replace(/\s+/g, " ").trim().toLowerCase()),
  );

  const candidates = root.querySelectorAll('div[role="button"], span[role="button"], button');
  let clicked = 0;

  for (let i = 0; i < candidates.length && clicked < maxClicks; i++) {
    const el = candidates[i]!;
    if (!isSafeSeeMoreButton(el, allowedLabels)) continue;
    expandedElements.add(el);
    if (typeof (el as HTMLElement).click === "function") {
      try {
        (el as HTMLElement).click();
        clicked++;
      } catch {
        // Ignore DOM click errors
      }
    }
  }

  return clicked;
}

// ── Controlled Scroll Step Driver (`02-extension.md §5`) ──

export type DriveCrawlOptions = {
  doc: Document;
  win: Window;
  sourceRef: SourceRef;
  maxPosts: number;
  maxScrollSteps: number;
  seenPostIds: readonly string[];
  extractor?: ExtractorProfile;
  getNetworkPayloads: () => readonly string[];
  stepDelayMinMs?: number;
  stepDelayMaxMs?: number;
  expandSettleMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  rngFn?: () => number;
  scrollFn?: (win: Window) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultScroll(win: Window): void {
  const delta = Math.max(Math.round((win.innerHeight || 800) * 0.85), 600);
  try {
    win.scrollBy({ top: delta, behavior: "smooth" });
  } catch {
    win.scrollBy(0, delta);
  }
}

export async function driveCrawlInPage(
  options: DriveCrawlOptions,
): Promise<CrawlPageResult> {
  const extractor = options.extractor ?? DEFAULT_EXTRACTOR_PROFILE;
  const primaryDefault: ExtractionStrategy = extractor.strategies[0] ?? "network";
  const currentUrl = options.win.location?.href ?? "";

  // 1. Check session health first (`02-extension.md §6.4`)
  const session = detectSessionStatus(options.doc, currentUrl, extractor);
  if (session.state !== "ok") {
    return {
      status: "blocked",
      session,
      posts: [],
      strategy: primaryDefault,
      error: session.detail ?? `session_${session.state}`,
    };
  }

  // 2. Check if group is inaccessible
  const accessCheck = detectGroupInaccessible(options.doc, currentUrl, extractor);
  if (accessCheck.inaccessible) {
    return {
      status: "error",
      session,
      posts: [],
      strategy: primaryDefault,
      inaccessible: true,
      error: accessCheck.reason ?? "Group không truy cập được",
    };
  }

  const sleep = options.sleepFn ?? defaultSleep;
  const rng = options.rngFn ?? Math.random;
  const scroll = options.scrollFn ?? defaultScroll;
  const minDelay = options.stepDelayMinMs ?? 1_500;
  const maxDelay = Math.max(minDelay, options.stepDelayMaxMs ?? 4_000);
  const expandSettleMs = options.expandSettleMs ?? 120;

  const seenSet = new Set(options.seenPostIds);
  const maxPosts = Math.max(1, options.maxPosts);
  const maxSteps = Math.max(0, Math.min(options.maxScrollSteps, 10));

  const collected = new Map<string, RawPost>();
  let usedStrategy: ExtractionStrategy = primaryDefault;
  let hitKnownPost = false;

  for (let step = 0; step <= maxSteps; step++) {
    // Re-check session in case a rate-limit modal appeared after scrolling
    const stepSession = detectSessionStatus(
      options.doc,
      options.win.location?.href ?? currentUrl,
      extractor,
    );
    if (stepSession.state !== "ok") {
      return {
        status: "blocked",
        session: stepSession,
        posts: Array.from(collected.values()).slice(0, maxPosts),
        strategy: usedStrategy,
        error: stepSession.detail ?? `session_${stepSession.state}`,
      };
    }

    const expandedCount = expandSeeMoreButtons(options.doc, extractor);
    if (expandedCount > 0 && expandSettleMs > 0) {
      await sleep(expandSettleMs);
    }

    const { posts, primaryStrategy } = runExtractionPipeline({
      networkPayloads: options.getNetworkPayloads(),
      doc: options.doc,
      sourceExternalId: options.sourceRef.external_id,
      profile: extractor,
    });

    if (posts.length > 0) {
      usedStrategy = primaryStrategy;
    }

    for (const post of posts) {
      if (seenSet.has(post.post_id)) {
        hitKnownPost = true;
      }
      const prev = collected.get(post.post_id);
      if (!prev || post.text.length > prev.text.length) {
        collected.set(post.post_id, post);
      }
    }

    // Stop early when encountering a previously seen post_id or reaching max_posts
    if (hitKnownPost || collected.size >= maxPosts || step === maxSteps) {
      break;
    }

    scroll(options.win);
    const pauseMs = Math.round(minDelay + rng() * (maxDelay - minDelay));
    await sleep(pauseMs);
  }

  const finalPosts = Array.from(collected.values()).slice(0, maxPosts);
  return {
    status: finalPosts.length > 0 ? "ok" : "empty",
    session: { state: "ok" },
    posts: finalPosts,
    strategy: usedStrategy,
  };
}
