// Current-tab Facebook group detection and follow prompt.

import type { SourceInfo } from "../protocol";
import type { PopupStatusSnapshot, PageContextResponse } from "../messages";
import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import { byId } from "./state";

function isGroupAlreadyFollowed(
  group: SourceInfo,
  slugFromUrl: string | null,
  followedIds: readonly string[],
): boolean {
  const lowerSet = new Set(followedIds.map((id) => id.toLowerCase()));
  if (lowerSet.has(group.external_id.toLowerCase())) return true;
  if (slugFromUrl && lowerSet.has(slugFromUrl.toLowerCase())) return true;
  return false;
}

export function renderGroupContext(
  group: SourceInfo | null,
  slugFromUrl: string | null,
  status: PopupStatusSnapshot,
): void {
  const card = byId("group-context-card");
  if (!group) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  byId("group-context-name").textContent = group.name;

  const metaParts: string[] = [];
  if (group.privacy === "public") metaParts.push("Nhóm công khai");
  if (group.privacy === "private") metaParts.push("Nhóm riêng tư");
  if (group.member_count !== undefined) {
    metaParts.push(`${group.member_count.toLocaleString("vi-VN")} thành viên`);
  }
  if (metaParts.length === 0) {
    metaParts.push(`ID: ${group.external_id}`);
  }
  byId("group-context-meta").textContent = metaParts.join(", ");

  const alreadyFollowed = isGroupAlreadyFollowed(
    group,
    slugFromUrl,
    status.followedExternalIds,
  );
  const followBtn = byId<HTMLButtonElement>("btn-follow-group");
  const followedBadge = byId("badge-following-group");

  if (alreadyFollowed) {
    followBtn.classList.add("hidden");
    followedBadge.classList.remove("hidden");
  } else {
    followBtn.classList.remove("hidden");
    followedBadge.classList.add("hidden");
  }
}

export async function detectActiveTabGroup(): Promise<{
  group: SourceInfo | null;
  slug: string | null;
}> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return { group: null, slug: null };
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab?.url) return { group: null, slug: null };

    const slug = extractGroupSlugOrIdFromUrl(activeTab.url);
    if (!slug) return { group: null, slug: null };

    if (activeTab.id !== undefined) {
      try {
        const ctx = (await chrome.tabs.sendMessage(activeTab.id, {
          kind: "dealsonar:get-page-context",
        })) as PageContextResponse | undefined;
        if (ctx?.groupInfo) {
          return { group: ctx.groupInfo, slug };
        }
      } catch {
        // Content script not yet injected on pre-existing tab; fall back to tab metadata
      }
    }

    const cleanedTitle = (activeTab.title ?? "")
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*[|–-]\s*Facebook\s*$/i, "")
      .trim();

    return {
      slug,
      group: {
        platform: "facebook",
        kind: "group",
        external_id: slug,
        name: cleanedTitle || `Nhóm ${slug}`,
        url: `https://www.facebook.com/groups/${encodeURIComponent(slug)}/`,
      },
    };
  } catch {
    return { group: null, slug: null };
  }
}
