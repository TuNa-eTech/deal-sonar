// Facebook Group discovery (`SourceInfo`).

import type { SourcePrivacy, SourceInfo } from "../../protocol";
import { normalizeFacebookUrl } from "./facebook";
import { firstFiniteNumber, firstNonEmptyString, parseJsonDocuments } from "./json";

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
