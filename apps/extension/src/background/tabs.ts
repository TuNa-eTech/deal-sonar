// Tab helpers for the active crawl lifecycle (`02-extension.md §5`).

import { extractGroupSlugOrIdFromUrl } from "../content/extract";
import type { PageContextResponse } from "../messages";
import { ALARM_TAB_SAFETY_PREFIX } from "./context";

// ── Active Crawl Tab Lifecycle (`02-extension.md §5`) ──

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("crawl_aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("crawl_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function queryUserIdleState(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.idle?.queryState) return true;
  try {
    const idleState = await chrome.idle.queryState(60);
    return idleState === "idle" || idleState === "locked";
  } catch {
    return true;
  }
}

export async function findExistingUserGroupTab(
  externalId: string,
): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  try {
    const tabs = await chrome.tabs.query({
      url: "https://www.facebook.com/groups/*",
    });
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const slug = extractGroupSlugOrIdFromUrl(tab.url);
      if (slug && slug.toLowerCase() === externalId.toLowerCase()) {
        return tab;
      }
    }
  } catch {
    // Ignore tab query error
  }
  return null;
}

// Explicit current-tab mode must never select another open tab or silently create one.
export async function findCurrentGroupTab(externalId: string): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return null;
  const slug = extractGroupSlugOrIdFromUrl(tab.url);
  if (!slug) return null;
  if (slug.toLowerCase() === externalId.toLowerCase()) return tab;
  try {
    const context = await chrome.tabs.sendMessage(tab.id, {
      kind: "dealsonar:get-page-context",
    }) as PageContextResponse | undefined;
    // Facebook can expose a numeric group ID on a tab with a vanity slug URL.
    if (context?.groupInfo?.external_id.toLowerCase() === externalId.toLowerCase()) return tab;
  } catch { /* Content script unavailable: fail without touching a different tab. */ }
  return null;
}

export async function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<chrome.tabs.Tab> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) throw new Error("crawl_aborted");
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleepWithAbort(350, signal);
  }
  return chrome.tabs.get(tabId);
}

export async function safeCloseTab(tabId: number | null): Promise<void> {
  if (tabId === null || typeof chrome === "undefined" || !chrome.tabs?.remove) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already have been closed by user or safety alarm
  }
  try {
    await chrome.alarms?.clear(`${ALARM_TAB_SAFETY_PREFIX}${tabId}`);
  } catch {
    // Ignore
  }
}
