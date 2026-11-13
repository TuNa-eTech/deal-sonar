// Data-driven ExtractorProfile engine (`02-extension.md §4.1–4.3, §7`).
// Supports `network` (JSON & NDJSON GraphQL), `embedded` (<script type="application/json">),
// `dom` ([role="article"] fallback), and Facebook Group discovery (`SourceInfo`).

export {
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_DOM_CONFIG,
  DEFAULT_SESSION_MARKERS,
  DEFAULT_EXTRACTOR_PROFILE,
  resolveNetworkConfig,
  resolveDomConfig,
  resolveSessionMarkers,
} from "./profile";
export type {
  StoryMarkerRule,
  NetworkExtractorFields,
  NetworkExtractorConfig,
  DomExtractorConfig,
  SessionMarkersConfig,
} from "./profile";
export { getByPath, normalizeTimestampMs, parseJsonDocuments } from "./json";
export { extractPostIdFromPermalink } from "./facebook";
export { extractFromNetwork, extractFromEmbedded } from "./network";
export { isCommentArticle, extractFromDom } from "./dom";
export { runExtractionPipeline } from "./pipeline";
export type { ExtractionPipelineInput, ExtractionPipelineOutput } from "./pipeline";
export {
  extractGroupSlugOrIdFromUrl,
  isJoinedGroupsHubUrl,
  parsePrivacyFromText,
  parseMemberCountFromText,
  extractCurrentGroupInfo,
  extractJoinedGroups,
} from "./groups";
