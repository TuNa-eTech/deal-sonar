// Strategy (c): fallback DOM `[role="article"]` extraction.

import type { Attachment, ExtractorProfile, RawPost, AuthorInfo } from "../../protocol";
import {
  extractPostIdFromPermalink,
  isAnonymousAuthorName,
  normalizeFacebookUrl,
} from "./facebook";
import { normalizeTimestampMs } from "./json";
import { DEFAULT_EXTRACTOR_PROFILE, resolveDomConfig } from "./profile";

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
