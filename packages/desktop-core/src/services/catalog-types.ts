// DTOs of the catalog commands (crates/core/src/dto/{radar,leads,commands}.rs) and the typed
// decoders for the command inputs. Field names stay snake_case because these objects are the
// IPC contract consumed by apps/desktop/ui/src/types/ipc.ts.

import type { FieldDef, QuietHours } from "../store/domain";
import {
  type Decoder,
  dAny,
  dBool,
  dEnum,
  dF64,
  dI32,
  dI64,
  dMap,
  dString,
  dU32,
  dUsize,
  dVec,
  doubleOpt,
  opt,
  req,
  struct,
  withDefault,
} from "./catalog-serde";

export type { FieldDef, QuietHours };

// ---- enums -------------------------------------------------------------------------------------

export const FIELD_TYPES = [
  "text",
  "number",
  "money",
  "phone",
  "location",
  "enum",
  "multi_enum",
  "boolean",
  "date",
  "range",
  "url",
] as const;
export const FILTER_OPERATORS = ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"] as const;
export const WANT_INTENTS = ["demand", "supply", "any"] as const;
export const AUTHOR_ROLES = ["end_user", "peer", "unknown"] as const;
export const NOTIFY_MODES = ["instant", "digest"] as const;
export const LEAD_STATUSES = ["new", "viewed", "contacted", "negotiating", "won", "lost", "ignored"] as const;
export const FEEDBACK_LABELS = ["correct", "irrelevant", "wrong_fields", "peer", "duplicate", "spam", "missed"] as const;
export const BLOCKLIST_KINDS = ["author", "phone", "keyword"] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type WantIntent = (typeof WANT_INTENTS)[number];
export type AuthorRole = (typeof AUTHOR_ROLES)[number];
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export type WhenMissing = "pass" | "fail";
export type RadarStatus = "draft" | "active" | "paused" | "archived";
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];
export type FeedbackOrigin = "app" | "preview";
export type BlocklistKind = (typeof BLOCKLIST_KINDS)[number];
export type SourceState = "ok" | "error" | "inaccessible";
export type DecidedBy = "dedup" | "prefilter" | "rule" | "ai" | "postfilter";
export type RejectReason = "duplicate" | "prefilter" | "irrelevant" | "peer" | "spam" | "blocked" | "hard_filter";

export const dFieldType = dEnum(FIELD_TYPES);
export const dFilterOperator = dEnum(FILTER_OPERATORS);
export const dWantIntent = dEnum(WANT_INTENTS);
export const dAuthorRole = dEnum(AUTHOR_ROLES);
export const dNotifyMode = dEnum(NOTIFY_MODES);
export const dWhenMissing = dEnum(["pass", "fail"] as const);
export const dLeadStatus = dEnum(LEAD_STATUSES);
export const dFeedbackLabel = dEnum(FEEDBACK_LABELS);
export const dFeedbackOrigin = dEnum(["app", "preview"] as const);
export const dBlocklistKind = dEnum(BLOCKLIST_KINDS);

// Lossy `from_db` conversions (`RadarStatus::from_db`, ...): unknown strings fall back.
export const radarStatusFromDb = (s: string): RadarStatus =>
  s === "active" || s === "paused" || s === "archived" ? s : "draft";
export const sourceStateFromDb = (s: string): SourceState => (s === "error" || s === "inaccessible" ? s : "ok");
export const leadStatusFromDb = (s: string): LeadStatus => ((LEAD_STATUSES as readonly string[]).includes(s) ? (s as LeadStatus) : "new");
export const feedbackLabelFromDb = (s: string): FeedbackLabel | null =>
  (FEEDBACK_LABELS as readonly string[]).includes(s) ? (s as FeedbackLabel) : null;
export const decidedByFromDb = (s: string | null | undefined): DecidedBy =>
  s === "dedup" || s === "prefilter" || s === "rule" || s === "postfilter" ? s : "ai";
export const rejectReasonFromDb = (s: string | null | undefined): RejectReason =>
  s === "duplicate" || s === "prefilter" || s === "peer" || s === "spam" || s === "blocked" || s === "hard_filter"
    ? s
    : "irrelevant";
export const blocklistKindFromDb = (s: string): BlocklistKind => (s === "author" || s === "phone" ? s : "keyword");
export const wantIntentFromDb = (s: string): WantIntent => (s === "demand" || s === "supply" ? s : "any");
export const authorRoleFromDb = (s: string): AuthorRole => (s === "end_user" || s === "peer" ? s : "unknown");
export const notifyModeFromDb = (s: string): NotifyMode => (s === "digest" ? "digest" : "instant");
export const whenMissingFromDb = (s: string): WhenMissing => (s === "fail" ? "fail" : "pass");

// ---- radar DTOs --------------------------------------------------------------------------------

export interface HardFilterDto {
  field: string;
  op: FilterOperator;
  value: unknown;
  when_missing: WhenMissing;
}

export interface MatchPolicyDto {
  want_intent: WantIntent;
  exclude_roles: AuthorRole[];
  hard_filters: HardFilterDto[];
}

export const defaultMatchPolicyDto = (): MatchPolicyDto => ({
  want_intent: "any",
  exclude_roles: ["peer"],
  hard_filters: [],
});

export interface RadarNotifyConfigDto {
  channel_ids: string[];
  /** Absent on the wire when unset (`skip_serializing_if = "Option::is_none"`). */
  inherit_channels?: boolean;
  mode: NotifyMode;
  min_score: number;
  quiet_hours: QuietHours | null;
  lead_ttl_hours: number | null;
}

export interface RadarDto {
  id: string;
  name: string;
  status: RadarStatus;
  template_id: string | null;
  current_version: number;
  source_ids: string[];
  notify: RadarNotifyConfigDto;
  created_at: number;
  updated_at: number;
  // Each of these is omitted from the wire when unknown.
  leads_24h?: number;
  false_positive_rate?: number;
  evaluated_posts_total?: number;
  rule_handled_pct?: number;
  auto_digest_flood?: boolean;
}

export interface RadarVersionDto {
  id: string;
  radar_id: string;
  version: number;
  description: string;
  language_hint: string | null;
  user_profession: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicyDto;
  created_at: number;
}

export interface RadarDetailDto {
  radar: RadarDto;
  current_version_data: RadarVersionDto;
  pending_version_data: RadarVersionDto | null;
  versions: RadarVersionDto[];
}

export interface RadarUpdateResultDto {
  detail: RadarDetailDto;
  created_new_version: boolean;
  requires_confirmation: boolean;
}

export interface FunnelStatsDto {
  days: number;
  posts_captured: number;
  dedup_dropped: number;
  prefilter_dropped: number;
  rule_decided: number;
  rule_matched: number;
  ai_decided: number;
  ai_matched: number;
  leads_created: number;
  leads_notified: number;
  leads_weak: number;
  false_positives: number;
}

export interface TemplatePlaceholderDto {
  key: string;
  hint: string;
}

export interface RadarTemplateDto {
  id: string;
  industry: string;
  name: string;
  description_template: string;
  placeholders: TemplatePlaceholderDto[];
  user_profession: string;
  fields: FieldDef[];
  match_policy: MatchPolicyDto;
  seed_ruleset: string | null;
  lead_ttl_hours: number | null;
  notify_mode: NotifyMode | null;
}

/** `RadarNotifyPatch`: `undefined` keeps the base value, `null` clears (double-option fields). */
export interface RadarNotifyPatch {
  channel_ids: string[] | null;
  inherit_channels: boolean | null;
  mode: NotifyMode | null;
  min_score: number | null;
  quiet_hours: QuietHours | null | undefined;
  lead_ttl_hours: number | null | undefined;
}

export interface CreateRadarDraftInput {
  name: string;
  template_id: string | null;
  description: string;
  user_profession: string | null;
  language_hint: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicyDto;
  source_ids: string[];
  notify: RadarNotifyPatch | null;
}

export interface UpdateRadarInput {
  id: string;
  name: string | null;
  description: string | null;
  /** `undefined` keeps, `null` clears. */
  user_profession: string | null | undefined;
  fields: FieldDef[] | null;
  match_policy: MatchPolicyDto | null;
  source_ids: string[] | null;
  notify: RadarNotifyPatch | null;
  confirm_version_upgrade: boolean | null;
}

// ---- source / post / lead DTOs -----------------------------------------------------------------

export interface SourceDto {
  id: string;
  platform: string;
  kind: string;
  external_id: string;
  name: string;
  url: string;
  privacy: string | null;
  member_count: number | null;
  profile_id: string | null;
  followed: boolean;
  priority: boolean;
  state: SourceState;
  last_crawl_at: number | null;
  avg_new_posts: number;
  posts_per_day: number;
  stored_post_count: number;
  last_error: string | null;
  created_at: number;
}

export interface ExtractedFieldDto {
  value: unknown;
  raw: string | null;
  confidence: number;
  source: "ai" | "rule" | "user";
}

export interface AlsoSeenSourceDto {
  source_id: string;
  source_name: string;
  permalink: string;
  captured_at: number;
}

export interface LeadDto {
  id: string;
  radar_id: string;
  radar_name: string;
  radar_version_id: string;
  radar_version: number;
  post_id: string;
  evaluation_id: string;
  contact_id: string | null;
  status: LeadStatus;
  read_at: number | null;
  score: number;
  is_weak_match: boolean;
  summary: string;
  reason: string | null;
  decided_by: DecidedBy;
  fields: Record<string, ExtractedFieldDto>;
  source_id: string;
  source_name: string;
  author_id: string | null;
  author_name: string;
  permalink: string;
  post_created_at: number | null;
  expires_at: number | null;
  also_seen_in: AlsoSeenSourceDto[];
  notified_at: number | null;
  follow_up_at: number | null;
  note: string | null;
  tags: string[];
  feedback_label: FeedbackLabel | null;
  created_at: number;
  updated_at: number;
}

export interface LeadEventDto {
  id: string;
  lead_id: string;
  kind: string;
  data: Record<string, unknown> | null;
  created_at: number;
}

export interface PostDto {
  id: string;
  platform: string;
  external_id: string;
  source_id: string;
  source_name: string;
  author_id: string | null;
  author_name: string;
  permalink: string;
  text: string | null;
  text_truncated: boolean;
  lang: string | null;
  created_at: number | null;
  captured_at: number;
  strategy: string;
  purged_at: number | null;
}

export interface SourcePostCursor {
  at: number;
  id: string;
}

export interface SourcePostPageDto {
  items: PostDto[];
  next_cursor: SourcePostCursor | null;
}

export interface PosterActivityDto {
  posts_7d: number;
  groups_7d: number;
  same_post_groups: number;
  phone_shared_by_authors: number;
  looks_like_peer: boolean;
}

export interface LeadDetailDto {
  lead: LeadDto;
  post: PostDto;
  radar_fields: FieldDef[];
  events: LeadEventDto[];
  poster: PosterActivityDto | null;
}

export interface LeadListResponseDto {
  items: LeadDto[];
  total: number;
  next_cursor: string | null;
}

export interface RejectedEvaluationDto {
  evaluation_id: string;
  post_id: string;
  radar_id: string;
  radar_version_id: string;
  decided_by: DecidedBy;
  reject_reason: RejectReason;
  score: number | null;
  reason: string | null;
  source_name: string;
  author_name: string;
  permalink: string;
  post_text: string;
  captured_at: number;
  /** Omitted from the wire unless the evaluation was marked `missed`. */
  marked_missed?: boolean;
}

export interface ContactDto {
  id: string;
  display_name: string;
  phones: string[];
  author_ids: string[];
  note: string | null;
  lead_count: number;
  is_blocked: boolean;
  created_at: number;
  updated_at: number;
}

export interface ContactDetailDto {
  contact: ContactDto;
  leads: LeadDto[];
}

export interface BlocklistEntryDto {
  id: string;
  kind: BlocklistKind;
  value: string;
  display_label: string | null;
  radar_id: string | null;
  reason: string | null;
  created_at: number;
}

export interface ContactBlockResultDto {
  blocked_entries: BlocklistEntryDto[];
}

export interface BlocklistRemoveResultDto {
  removed: boolean;
}

export interface LeadFeedbackResultDto {
  feedback_id: string;
  updated_lead: LeadDto | null;
  blocked_entry: BlocklistEntryDto | null;
}

// ---- lead command inputs -----------------------------------------------------------------------

export interface DynamicFieldFilter {
  field: string;
  op: FilterOperator;
  value: unknown;
}

export interface LeadFilterQuery {
  unread_only: boolean | null;
  follow_up_before: number | null;
  follow_up_after: number | null;
  radar_id: string | null;
  status: LeadStatus[] | null;
  include_weak: boolean | null;
  since: number | null;
  filters: DynamicFieldFilter[] | null;
  search: string | null;
  sort: { by: string; dir: string } | null;
  limit: number | null;
  cursor: string | null;
  expired: boolean | null;
}

export interface LeadFeedbackInput {
  evaluation_id: string;
  lead_id: string | null;
  post_id: string | null;
  radar_version_id: string | null;
  label: FeedbackLabel;
  corrected_fields: Record<string, unknown> | null;
  duplicate_of_lead_id: string | null;
  block_author: boolean | null;
  origin: FeedbackOrigin;
}

/** `LeadCrmPatch`: `undefined` keeps the stored value, `null` clears it. */
export interface LeadCrmPatch {
  note: string | null | undefined;
  tags: string[] | null | undefined;
  follow_up_at: number | null | undefined;
}

// ---- decoders ----------------------------------------------------------------------------------

export const dFieldDef: Decoder<FieldDef> = struct<FieldDef>("FieldDef", {
  key: req(dString),
  label: req(dString),
  type: req(dFieldType),
  description: withDefault(dString, () => ""),
  required: withDefault(dBool, () => false),
  options: opt(dVec(dString)),
  show_in_alert: withDefault(dBool, () => true),
  order: withDefault(dI32, () => 0),
});

export const dHardFilter: Decoder<HardFilterDto> = struct<HardFilterDto>("HardFilter", {
  field: req(dString),
  op: req(dFilterOperator),
  value: withDefault(dAny, () => null),
  when_missing: withDefault(dWhenMissing, (): WhenMissing => "pass"),
});

export const dMatchPolicy: Decoder<MatchPolicyDto> = struct<MatchPolicyDto>("MatchPolicy", {
  want_intent: req(dWantIntent),
  exclude_roles: withDefault(dVec(dAuthorRole), (): AuthorRole[] => []),
  hard_filters: withDefault(dVec(dHardFilter), (): HardFilterDto[] => []),
});

export const dQuietHours: Decoder<QuietHours> = struct<QuietHours>("QuietHours", {
  from: req(dString),
  to: req(dString),
});

export const dRadarNotifyPatch: Decoder<RadarNotifyPatch> = struct<RadarNotifyPatch>("RadarNotifyPatch", {
  channel_ids: opt(dVec(dString)),
  inherit_channels: opt(dBool),
  mode: opt(dNotifyMode),
  min_score: opt(dF64),
  quiet_hours: doubleOpt(dQuietHours),
  lead_ttl_hours: doubleOpt(dU32),
});

export const dCreateRadarDraftInput: Decoder<CreateRadarDraftInput> = struct<CreateRadarDraftInput>(
  "CreateRadarDraftInput",
  {
    name: req(dString),
    template_id: opt(dString),
    description: req(dString),
    user_profession: opt(dString),
    language_hint: opt(dString),
    fields: withDefault(dVec(dFieldDef), (): FieldDef[] => []),
    match_policy: withDefault(dMatchPolicy, defaultMatchPolicyDto),
    source_ids: withDefault(dVec(dString), (): string[] => []),
    notify: opt(dRadarNotifyPatch),
  },
);

export const dUpdateRadarInput: Decoder<UpdateRadarInput> = struct<UpdateRadarInput>("UpdateRadarInput", {
  id: req(dString),
  name: opt(dString),
  description: opt(dString),
  user_profession: doubleOpt(dString),
  fields: opt(dVec(dFieldDef)),
  match_policy: opt(dMatchPolicy),
  source_ids: opt(dVec(dString)),
  notify: opt(dRadarNotifyPatch),
  confirm_version_upgrade: opt(dBool),
});

const dDynamicFieldFilter: Decoder<DynamicFieldFilter> = struct<DynamicFieldFilter>("DynamicFieldFilter", {
  field: req(dString),
  op: req(dFilterOperator),
  value: withDefault(dAny, () => null),
});

export const dLeadFilterQuery: Decoder<LeadFilterQuery> = struct<LeadFilterQuery>("LeadFilterQuery", {
  unread_only: opt(dBool),
  follow_up_before: opt(dI64),
  follow_up_after: opt(dI64),
  radar_id: opt(dString),
  status: opt(dVec(dLeadStatus)),
  include_weak: opt(dBool),
  since: opt(dI64),
  filters: opt(dVec(dDynamicFieldFilter)),
  search: opt(dString),
  sort: opt(struct<{ by: string; dir: string }>("LeadSortInput", { by: req(dString), dir: req(dString) })),
  limit: opt(dUsize),
  cursor: opt(dString),
  expired: opt(dBool),
});

export const dLeadFeedbackInput: Decoder<LeadFeedbackInput> = struct<LeadFeedbackInput>("LeadFeedbackInput", {
  evaluation_id: req(dString),
  lead_id: opt(dString),
  post_id: opt(dString),
  radar_version_id: opt(dString),
  label: req(dFeedbackLabel),
  corrected_fields: opt(dMap(dAny)),
  duplicate_of_lead_id: opt(dString),
  block_author: opt(dBool),
  origin: req(dFeedbackOrigin),
});

export const dSourcePostCursor: Decoder<SourcePostCursor> = struct<SourcePostCursor>("SourcePostCursor", {
  at: req(dI64),
  id: req(dString),
});

export const dTemplatePlaceholder: Decoder<TemplatePlaceholderDto> = struct<TemplatePlaceholderDto>(
  "TemplatePlaceholder",
  { key: req(dString), hint: req(dString) },
);

export const dRadarTemplate: Decoder<RadarTemplateDto> = struct<RadarTemplateDto>("RadarTemplate", {
  id: req(dString),
  industry: req(dString),
  name: req(dString),
  description_template: req(dString),
  placeholders: withDefault(dVec(dTemplatePlaceholder), (): TemplatePlaceholderDto[] => []),
  user_profession: req(dString),
  fields: req(dVec(dFieldDef)),
  match_policy: req(dMatchPolicy),
  seed_ruleset: opt(dString),
  lead_ttl_hours: opt(dU32),
  notify_mode: opt(dNotifyMode),
});
