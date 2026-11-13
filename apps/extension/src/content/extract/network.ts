// Strategies (a) network GraphQL and (b) embedded <script type="application/json"> extraction.

import type {
  Attachment,
  AttachmentKind,
  RawPost,
  AuthorInfo,
  PostCounts,
  ExtractorProfile,
} from "../../protocol";
import {
  decodeRelayStoryPostId,
  extractPostIdFromPermalink,
  isAnonymousAuthorName,
  normalizeFacebookUrl,
} from "./facebook";
import {
  firstBoolean,
  firstFiniteNumber,
  firstNonEmptyString,
  getByPath,
  normalizeTimestampMs,
  parseJsonDocuments,
} from "./json";
import {
  DEFAULT_EXTRACTOR_PROFILE,
  isPlainObject,
  type NetworkExtractorConfig,
  resolveNetworkConfig,
  type StoryMarkerRule,
} from "./profile";

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

export function mergeRawPosts(existing: RawPost, incoming: RawPost): RawPost {
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
