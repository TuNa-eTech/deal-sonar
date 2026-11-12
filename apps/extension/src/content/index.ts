// Isolated-world content script entry (`manifest.json` -> `content.js`, `run_at: "document_idle"`).
// Intentionally exports nothing so Rollup emits a pure anonymous IIFE with zero globals/imports.

import {
  TAP_CONFIG_SOURCE,
  TAP_MESSAGE_SOURCE,
  type BgToContentMessage,
  type ContentInitResponse,
  type PageContextResponse,
  type TapConfigWindowMessage,
} from "../messages";
import type { ExtractorProfile, SourceRef } from "../protocol";
import { detectSessionStatus, driveCrawlInPage, expandSeeMoreButtons } from "./drive";
import {
  DEFAULT_EXTRACTOR_PROFILE,
  extractCurrentGroupInfo,
  extractJoinedGroups,
  isJoinedGroupsHubUrl,
  resolveNetworkConfig,
  runExtractionPipeline,
} from "./extract";

const MAX_BUFFERED_TAP_PAYLOADS = 60;

function bootstrapContentScript(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const networkPayloads: string[] = [];
  let currentProfile: ExtractorProfile = DEFAULT_EXTRACTOR_PROFILE;
  let passiveSourceRef: SourceRef | null = null;
  let passiveEnabled = false;
  const passivelySentPostIds = new Set<string>();
  let passiveTimer: ReturnType<typeof setTimeout> | null = null;

  function sendTapPatterns(profile: ExtractorProfile): void {
    const netCfg = resolveNetworkConfig(profile.network);
    const msg: TapConfigWindowMessage = {
      source: TAP_CONFIG_SOURCE,
      url_patterns: netCfg.url_patterns,
    };
    window.postMessage(msg, window.location.origin);
  }

  function schedulePassiveCapture(): void {
    if (!passiveEnabled || !passiveSourceRef) return;
    if (passiveTimer !== null) clearTimeout(passiveTimer);
    passiveTimer = setTimeout(() => {
      passiveTimer = null;
      void runPassiveCapture();
    }, 1_200);
  }

  async function runPassiveCapture(): Promise<void> {
    if (!passiveEnabled || !passiveSourceRef) return;
    const session = detectSessionStatus(document, window.location.href, currentProfile);
    if (session.state !== "ok") {
      try {
        await chrome.runtime.sendMessage({
          kind: "content:session-status",
          session,
        });
      } catch {
        // Ignore if extension context invalidated
      }
      return;
    }

    expandSeeMoreButtons(document, currentProfile, 10);
    const { posts, primaryStrategy } = runExtractionPipeline({
      networkPayloads,
      doc: document,
      sourceExternalId: passiveSourceRef.external_id,
      profile: currentProfile,
    });

    const unsent = posts.filter((p) => !passivelySentPostIds.has(p.post_id));
    if (unsent.length === 0) return;

    for (const p of unsent) {
      passivelySentPostIds.add(p.post_id);
    }

    try {
      await chrome.runtime.sendMessage({
        kind: "content:passive-capture",
        sourceRef: passiveSourceRef,
        posts: unsent,
        strategy: primaryStrategy,
      });
    } catch {
      // Ignore if SW unavailable
    }
  }

  async function runJoinedGroupsDiscovery(): Promise<void> {
    if (!isJoinedGroupsHubUrl(window.location.href)) return;
    const groups = extractJoinedGroups(document, window.location.href, networkPayloads);
    if (groups.length === 0) return;
    try {
      await chrome.runtime.sendMessage({
        kind: "content:sources-discovered",
        sources: groups,
      });
    } catch {
      // Ignore if SW unavailable
    }
  }

  // 1. Listen for cloned GraphQL/XHR payloads forwarded from `tap.ts` in MAIN world
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== TAP_MESSAGE_SOURCE) return;
    if (typeof data.body !== "string" || data.body.length === 0) return;

    networkPayloads.push(data.body);
    if (networkPayloads.length > MAX_BUFFERED_TAP_PAYLOADS) {
      networkPayloads.shift();
    }

    if (passiveEnabled) {
      schedulePassiveCapture();
    } else if (isJoinedGroupsHubUrl(window.location.href)) {
      setTimeout(() => void runJoinedGroupsDiscovery(), 800);
    }
  });

  // 2. Listen for passive user scrolling in followed groups
  window.addEventListener(
    "scroll",
    () => {
      if (passiveEnabled) {
        schedulePassiveCapture();
      }
    },
    { passive: true },
  );

  // 3. Handle on-demand commands from Background Service Worker & Popup
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(
      (msg: BgToContentMessage, _sender, sendResponse) => {
        if (!msg || typeof msg !== "object" || !("kind" in msg)) {
          return false;
        }

        if (msg.kind === "dealsonar:get-page-context") {
          const response: PageContextResponse = {
            url: window.location.href,
            session: detectSessionStatus(document, window.location.href, currentProfile),
            groupInfo: extractCurrentGroupInfo(document, window.location.href),
          };
          sendResponse(response);
          return false;
        }

        if (msg.kind === "dealsonar:crawl-execute") {
          currentProfile = msg.extractor ?? currentProfile;
          sendTapPatterns(currentProfile);
          passiveEnabled = false;

          driveCrawlInPage({
            doc: document,
            win: window,
            sourceRef: msg.sourceRef,
            maxPosts: msg.maxPosts,
            maxScrollSteps: msg.maxScrollSteps,
            seenPostIds: msg.seenPostIds,
            extractor: currentProfile,
            getNetworkPayloads: () => networkPayloads,
            stepDelayMinMs: msg.stepDelayMinMs,
            stepDelayMaxMs: msg.stepDelayMaxMs,
          })
            .then((res) => sendResponse(res))
            .catch((err: unknown) =>
              sendResponse({
                status: "error",
                session: detectSessionStatus(
                  document,
                  window.location.href,
                  currentProfile,
                ),
                posts: [],
                strategy: currentProfile.strategies[0] ?? "network",
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          return true;
        }

        return false;
      },
    );
  }

  // 4. Initial handshake with Background Service Worker
  async function initWithBackground(): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    const session = detectSessionStatus(document, window.location.href, currentProfile);
    const groupInfo = extractCurrentGroupInfo(document, window.location.href);

    try {
      const res = (await chrome.runtime.sendMessage({
        kind: "content:init",
        url: window.location.href,
        session,
        groupInfo,
      })) as ContentInitResponse | undefined;

      if (res?.extractor) {
        currentProfile = res.extractor;
        sendTapPatterns(currentProfile);
      }

      if (Array.isArray(res?.seenPostIds)) {
        for (const id of res.seenPostIds) {
          passivelySentPostIds.add(id);
        }
      }

      if (res?.isFollowedGroup && res.sourceRef && !res.isActiveCrawlTab) {
        passiveSourceRef = res.sourceRef;
        passiveEnabled = true;
        schedulePassiveCapture();
      }
    } catch {
      // Background worker may still be waking up
    }

    if (isJoinedGroupsHubUrl(window.location.href)) {
      setTimeout(() => void runJoinedGroupsDiscovery(), 1_000);
    }
  }

  void initWithBackground();
}

bootstrapContentScript();
