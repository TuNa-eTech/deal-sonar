// Protocol v2 message types (`docs/specs/01-protocol.md`), a port of the `Body` enum and payload
// structs in `crates/protocol/src/lib.rs`. Wire names are snake_case exactly as serde emits them.

export const PROTOCOL_VERSION = 2;

/** Deterministic MV3 `manifest.json` "key" extension ID. Must never change. */
export const DEFAULT_CHROME_EXTENSION_ID = "hkmjpcenjjebhpjicnbpmogidfcbmbjn";
export const LEGACY_PLACEHOLDER_EXTENSION_ID = "dealsonarchromeextensionid000001";
/** Settings key storing the paired Chrome extension ID (`03-desktop.md §2.2`). */
export const CHROME_EXTENSION_ID_SETTING_KEY = "chrome.extension_id";

export const PLATFORM_FACEBOOK = "facebook";
export const SOURCE_KIND_GROUP = "group";

export const ERROR_CODES = [
  "protocol_mismatch",
  "unknown_type",
  "invalid_payload",
  "desktop_unavailable",
  "busy",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const CRAWL_REASONS = ["scheduled", "manual", "preview", "passive"] as const;
export type CrawlReason = (typeof CRAWL_REASONS)[number];

export const CRAWL_STATUSES = ["ok", "empty", "blocked", "error"] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

export const SESSION_STATES = ["ok", "logged_out", "checkpoint", "rate_limited", "unknown"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const EXTRACTION_STRATEGIES = ["network", "embedded", "dom"] as const;
export type ExtractionStrategy = (typeof EXTRACTION_STRATEGIES)[number];

export const SOURCE_PRIVACIES = ["public", "private"] as const;
export type SourcePrivacy = (typeof SOURCE_PRIVACIES)[number];

export const ATTACHMENT_KINDS = ["photo", "video", "link", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface SourceRef {
  platform: string;
  kind: string;
  external_id: string;
}

export interface SourceInfo {
  platform: string;
  kind: string;
  external_id: string;
  name: string;
  url: string;
  privacy?: SourcePrivacy;
  member_count?: number;
}

export interface AuthorInfo {
  external_id?: string;
  name: string;
  is_anonymous: boolean;
}

export interface Attachment {
  kind: AttachmentKind;
  url?: string;
  alt?: string;
}

export interface PostCounts {
  comments?: number;
  reactions?: number;
}

export interface ExtractionInfo {
  strategy: ExtractionStrategy;
  profile_rev: number;
}

export interface RawPost {
  platform: string;
  post_id: string;
  source_external_id: string;
  permalink: string;
  author: AuthorInfo;
  text: string;
  text_truncated: boolean;
  created_at?: number;
  captured_at: number;
  attachments: Attachment[];
  counts?: PostCounts;
  extraction: ExtractionInfo;
}

/** Optional extension capability; old extensions leave operation status unknown. */
export interface CrawlRuntimeStatus {
  automatic_scanning: boolean;
  paused: boolean;
  next_crawl_at: number | null;
  last_crawl_at: number | null;
}

export interface CrawlPlanEntry {
  source_ref: SourceRef;
  interval_s: number;
  priority: number;
  max_posts_per_visit: number;
}

export interface CrawlPlan {
  entries: CrawlPlanEntry[];
}

export interface ActiveHours {
  from: string;
  to: string;
}

export interface CrawlPolicy {
  max_loads_per_hour: number;
  max_loads_per_day: number;
  active_hours: ActiveHours;
  jitter: number;
  max_scroll_steps: number;
  only_when_idle: boolean;
}

export interface ExtractorProfile {
  rev: number;
  strategies: ExtractionStrategy[];
  network: unknown;
  dom: unknown;
  session_markers: unknown;
}

// ── payloads ─────────────────────────────────────────────────────────────────────────────────

export interface HelloPayload {
  profile_id: string;
  ext_version: string;
  browser: string;
  config_rev: number;
}
export interface PostsPushPayload {
  run_id: string;
  source_ref: SourceRef;
  posts: RawPost[];
}
export interface CrawlReportPayload {
  run_id: string;
  source_ref: SourceRef;
  reason: CrawlReason;
  status: CrawlStatus;
  started_at: number;
  ended_at: number;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy?: ExtractionStrategy;
  error?: string;
  dropped_posts?: number;
}
export interface SourcesDiscoveredPayload {
  sources: SourceInfo[];
  follow?: boolean;
}
export interface SessionStatusPayload {
  runtime?: CrawlRuntimeStatus;
  platform: string;
  state: SessionState;
  detail?: string;
}
export interface HelloOkPayload {
  desktop_version: string;
  config_rev: number;
}
export interface ConfigUpdatePayload {
  rev: number;
  plan: CrawlPlan;
  policy: CrawlPolicy;
  extractor: ExtractorProfile;
}
export interface CrawlRequestPayload {
  request_id: string;
  source_ref: SourceRef;
  reason: CrawlReason;
  max_posts: number;
}
export interface CrawlPausePayload {
  until: number | null;
  reason: string;
}
export interface AckPayload {
  accepted: number;
  duplicates: number;
}
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type Body =
  | { type: "hello"; payload: HelloPayload }
  | { type: "posts.push"; payload: PostsPushPayload }
  | { type: "crawl.report"; payload: CrawlReportPayload }
  | { type: "sources.discovered"; payload: SourcesDiscoveredPayload }
  | { type: "session.status"; payload: SessionStatusPayload }
  | { type: "ping"; payload: Record<string, never> }
  | { type: "hello.ok"; payload: HelloOkPayload }
  | { type: "config.update"; payload: ConfigUpdatePayload }
  | { type: "crawl.request"; payload: CrawlRequestPayload }
  | { type: "crawl.pause"; payload: CrawlPausePayload }
  | { type: "crawl.resume"; payload: Record<string, never> }
  | { type: "ack"; payload: AckPayload }
  | { type: "pong"; payload: Record<string, never> }
  | { type: "error"; payload: ErrorPayload };

export type BodyType = Body["type"];

export interface EnvelopeHeader {
  v: number;
  id: string;
  ts: number;
  reply_to: string | null;
}

/** Serialized field order matches the Rust serializer: `v, id, ts, reply_to, type, payload`. */
export type Envelope<B extends Body = Body> = EnvelopeHeader & B;

export const KNOWN_MESSAGE_TYPES: readonly BodyType[] = [
  "hello",
  "posts.push",
  "crawl.report",
  "sources.discovered",
  "session.status",
  "ping",
  "hello.ok",
  "config.update",
  "crawl.request",
  "crawl.pause",
  "crawl.resume",
  "ack",
  "pong",
  "error",
];

const EXTENSION_TO_DESKTOP: ReadonlySet<string> = new Set([
  "hello",
  "posts.push",
  "crawl.report",
  "sources.discovered",
  "session.status",
  "ping",
]);

export const isKnownMessageType = (t: string): t is BodyType =>
  (KNOWN_MESSAGE_TYPES as readonly string[]).includes(t);

/** True for messages that originate from the Chrome extension (`01-protocol.md §4.1`). */
export const isExtensionToDesktop = (type: string): boolean => EXTENSION_TO_DESKTOP.has(type);

// ── health-facing session state shared with the health snapshot ───────────────────────────────

export type FacebookSessionState = "ok" | "logged_out" | "checkpoint" | "rate_limited";
export type CrawlPauseReason = "manual" | "checkpoint_awaiting_resume" | "rate_limited" | "logged_out";
