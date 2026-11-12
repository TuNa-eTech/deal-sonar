// Internal Chrome runtime/tab messaging contracts between content scripts, popup, and background SW.

import type { QuickScanOptions } from "./scan-options";

import type {
  CrawlStatus,
  ExtractionStrategy,
  ExtractorProfile,
  RawPost,
  SessionState,
  SourceInfo,
  SourceRef,
} from "./protocol";

export const TAP_MESSAGE_SOURCE = "dealsonar-ext-tap";
export const TAP_CONFIG_SOURCE = "dealsonar-ext-tap-config";

export type TapWindowMessage = {
  source: typeof TAP_MESSAGE_SOURCE;
  url: string;
  body: string;
  ts: number;
};

export type TapConfigWindowMessage = {
  source: typeof TAP_CONFIG_SOURCE;
  url_patterns: string[];
};

export type SessionDetection = {
  state: SessionState;
  detail?: string;
};

export type CrawlPageResult = {
  status: CrawlStatus;
  session: SessionDetection;
  posts: RawPost[];
  strategy: ExtractionStrategy;
  inaccessible?: boolean;
  error?: string;
};

// Content -> Background
export type ContentInitMessage = {
  kind: "content:init";
  url: string;
  session: SessionDetection;
  groupInfo: SourceInfo | null;
};

export type ContentInitResponse = {
  extractor: ExtractorProfile;
  isFollowedGroup: boolean;
  sourceRef: SourceRef | null;
  isActiveCrawlTab: boolean;
  seenPostIds: string[];
};

export type ContentSessionMessage = {
  kind: "content:session-status";
  session: SessionDetection;
};

export type ContentSourcesDiscoveredMessage = {
  kind: "content:sources-discovered";
  sources: SourceInfo[];
  follow?: boolean;
};

export type ContentPassiveCaptureMessage = {
  kind: "content:passive-capture";
  sourceRef: SourceRef;
  posts: RawPost[];
  strategy: ExtractionStrategy;
};

export type ContentToBgMessage =
  | ContentInitMessage
  | ContentSessionMessage
  | ContentSourcesDiscoveredMessage
  | ContentPassiveCaptureMessage;

// Background / Popup -> Content
export type BgCrawlExecuteMessage = {
  kind: "dealsonar:crawl-execute";
  sourceRef: SourceRef;
  maxPosts: number;
  maxScrollSteps: number;
  seenPostIds: string[];
  extractor: ExtractorProfile;
  stepDelayMinMs?: number;
  stepDelayMaxMs?: number;
};

export type BgGetPageContextMessage = {
  kind: "dealsonar:get-page-context";
};

export type PageContextResponse = {
  url: string;
  session: SessionDetection;
  groupInfo: SourceInfo | null;
};

export type BgToContentMessage = BgCrawlExecuteMessage | BgGetPageContextMessage;

// Popup -> Background
export type PopupStatusSnapshot = {
  connected: boolean;
  desktopAvailable: boolean;
  desktopVersion?: string;
  connectionError?: string;
  extensionId?: string;
  session: {
    state: SessionState;
    detail?: string;
    updatedAt: number;
  };
  lastCrawlAt: number | null;
  nextCrawlAt: number | null;
  followedGroupsCount: number;
  followedExternalIds: string[];
  loadsLastHour: number;
  maxLoadsPerHour: number;
  pause: {
    paused: boolean;
    until: number | null;
    reason: string | null;
    requiresDesktopResume: boolean;
  };
  queuedPostsCount: number;
  automaticScanning?: boolean;
  scanOptions?: QuickScanOptions;
  activeCrawl?: { sourceExternalId: string } | null;
  lastScan?: ScanSummary | null;
  scanSources?: SourceRef[];
};

export type ScanSummary = {
  sourceExternalId: string;
  status: CrawlStatus;
  postsSeen: number;
  postsNew: number;
  endedAt: number;
  error?: string;
};

export type PopupScanMessage = { kind: "popup:scan-now"; source: SourceRef; options?: QuickScanOptions };
export type PopupSetScanOptionsMessage = { kind: "popup:set-scan-options"; options: QuickScanOptions };
export type PopupAutoScanMessage = { kind: "popup:set-automatic"; enabled: boolean };
export type PopupScanResponse = { ok: boolean; error?: string; status: PopupStatusSnapshot };

export type PopupGetStatusMessage = {
  kind: "popup:get-status";
};

export type PopupReconnectMessage = {
  kind: "popup:reconnect";
};

export type PopupPauseMessage = {
  kind: "popup:pause";
  durationMs: number | null;
};

export type PopupResumeMessage = {
  kind: "popup:resume";
};

export type PopupFollowGroupMessage = {
  kind: "popup:follow-group";
  group: SourceInfo;
};

export type PopupToBgMessage =
  | PopupSetScanOptionsMessage
  | PopupScanMessage
  | PopupAutoScanMessage
  | PopupGetStatusMessage
  | PopupReconnectMessage
  | PopupPauseMessage
  | PopupResumeMessage
  | PopupFollowGroupMessage;

export type RuntimeMessage = ContentToBgMessage | PopupToBgMessage;
