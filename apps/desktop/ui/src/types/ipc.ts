/**
 * Typed Tauri IPC contracts for DealSonar Desktop UI (`03-desktop.md §4`,
 * `04-data-model.md`, `02-radar-spec.md`, `05-pipeline-rules.md`,
 * `06-ai-bridge.md`, `07-notifications-export.md`).
 *
 * All DTO properties use `snake_case` to match Rust `serde` structs directly.
 * All IDs are ULID strings; all timestamps are Unix milliseconds (`number`).
 */

export type RadarStatus = "draft" | "active" | "paused" | "archived";

export type FieldType =
  | "text"
  | "number"
  | "money"
  | "phone"
  | "location"
  | "enum"
  | "multi_enum"
  | "boolean"
  | "date"
  | "range"
  | "url";

export type WantIntent = "demand" | "supply" | "any";
export type PostIntent = "demand" | "supply" | "other";
export type AuthorRole = "end_user" | "peer" | "unknown";
export type FieldSource = "ai" | "rule" | "user";

export type FilterOperator =
  | "eq"
  | "ne"
  | "in"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "contains"
  | "is_empty";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  description: string;
  required: boolean;
  options: string[] | null;
  show_in_alert: boolean;
  order: number;
}

export interface HardFilter {
  field: string;
  op: FilterOperator;
  value?: unknown;
  when_missing: "pass" | "fail";
}

export interface MatchPolicy {
  want_intent: WantIntent;
  exclude_roles: AuthorRole[];
  hard_filters: HardFilter[];
}

export interface QuietHours {
  from: string;
  to: string;
}

export interface RadarNotifyConfig {
  channel_ids: string[];
  mode: "instant" | "digest";
  min_score: number;
  quiet_hours: QuietHours | null;
}

export interface Radar {
  id: string;
  name: string;
  status: RadarStatus;
  template_id: string | null;
  current_version: number;
  source_ids: string[];
  notify: RadarNotifyConfig;
  created_at: number;
  updated_at: number;
  // Operational summary fields for Radar list & Inbox
  leads_24h?: number;
  false_positive_rate?: number;
  evaluated_posts_total?: number;
  rule_handled_pct?: number;
  auto_digest_flood?: boolean;
}

export interface RadarVersion {
  id: string;
  radar_id: string;
  version: number;
  description: string;
  language_hint: string | null;
  user_profession: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicy;
  created_at: number;
}

export interface RadarDetail {
  radar: Radar;
  current_version_data: RadarVersion;
  pending_version_data: RadarVersion | null;
  versions: RadarVersion[];
}

export interface TemplatePlaceholder {
  key: string;
  hint: string;
}

export interface RadarTemplate {
  id: string;
  industry: string;
  name: string;
  description_template: string;
  placeholders: TemplatePlaceholder[];
  user_profession: string;
  fields: FieldDef[];
  match_policy: MatchPolicy;
  seed_ruleset: string | null;
}

export type SourceState = "ok" | "error" | "inaccessible";

export interface Source {
  id: string;
  platform: "facebook";
  kind: "group";
  external_id: string;
  name: string;
  url: string;
  privacy: "public" | "private" | null;
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

export interface MoneyValue {
  min: number;
  max: number;
  currency: string;
  period: "month" | "year" | "day" | null;
}

export interface LocationValue {
  raw: string;
  province: string | null;
  district: string | null;
  ward: string | null;
}

export interface RangeValue {
  min: number;
  max: number;
  unit: string;
}

export interface ExtractedField {
  value: unknown;
  raw: string | null;
  confidence: number;
  source: FieldSource;
}

export type LeadStatus =
  | "new"
  | "viewed"
  | "contacted"
  | "negotiating"
  | "won"
  | "lost"
  | "ignored";

export type DecidedBy = "dedup" | "prefilter" | "rule" | "ai" | "postfilter";

export type RejectReason =
  | "duplicate"
  | "prefilter"
  | "irrelevant"
  | "peer"
  | "spam"
  | "blocked"
  | "hard_filter";

export type FeedbackLabel =
  | "correct"
  | "irrelevant"
  | "wrong_fields"
  | "peer"
  | "duplicate"
  | "spam"
  | "missed";

export interface AlsoSeenSource {
  source_id: string;
  source_name: string;
  permalink: string;
  captured_at: number;
}

export interface Lead {
  id: string;
  radar_id: string;
  radar_name: string;
  radar_version_id: string;
  radar_version: number;
  post_id: string;
  evaluation_id: string;
  contact_id: string | null;
  status: LeadStatus;
  score: number;
  is_weak_match: boolean;
  summary: string;
  reason: string | null;
  decided_by: DecidedBy;
  fields: Record<string, ExtractedField>;
  source_id: string;
  source_name: string;
  author_id: string | null;
  author_name: string;
  permalink: string;
  post_created_at: number | null;
  also_seen_in: AlsoSeenSource[];
  notified_at: number | null;
  follow_up_at: number | null;
  note: string | null;
  tags: string[];
  feedback_label: FeedbackLabel | null;
  created_at: number;
  updated_at: number;
}

export interface LeadEvent {
  id: string;
  lead_id: string;
  kind: "created" | "status_changed" | "field_edited" | "notified" | "noted" | "feedback";
  data: Record<string, unknown> | null;
  created_at: number;
}

export interface Post {
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
  strategy: "network" | "embedded" | "dom";
  purged_at: number | null;
}

export interface LeadDetail {
  lead: Lead;
  post: Post;
  radar_fields: FieldDef[];
  events: LeadEvent[];
}

export interface DynamicFieldFilter {
  field: string;
  op: FilterOperator;
  value?: unknown;
}

export interface LeadFilterQuery {
  radar_id?: string | null;
  status?: LeadStatus[];
  include_weak?: boolean;
  since?: number | null;
  filters?: DynamicFieldFilter[];
  search?: string | null;
  sort?: {
    by: string;
    dir: "asc" | "desc";
  };
  limit?: number;
  cursor?: string | null;
}

export interface LeadListResponse {
  items: Lead[];
  total: number;
  next_cursor: string | null;
}

export interface RejectedEvaluation {
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
  marked_missed?: boolean;
}

export interface Contact {
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

export interface ContactDetail {
  contact: Contact;
  leads: Lead[];
}

export type BlocklistKind = "author" | "phone" | "keyword";

export interface BlocklistEntry {
  id: string;
  kind: BlocklistKind;
  value: string;
  display_label?: string | null;
  radar_id: string | null;
  reason: string | null;
  created_at: number;
}

export type FacebookSessionState = "ok" | "logged_out" | "checkpoint" | "rate_limited";
export type AiProviderId = "claude_cli" | "codex_cli" | "agy_cli";
export type AiHealthState = "ok" | "not_configured" | "error" | "rate_limited" | "daily_cap_reached";

export interface HealthStatus {
  extension_connected: boolean;
  extension_version: string | null;
  facebook_session: FacebookSessionState;
  crawl_paused: boolean;
  crawl_pause_reason: "manual" | "checkpoint_awaiting_resume" | "rate_limited" | "logged_out" | null;
  page_loads_last_hour: number;
  page_loads_today: number;
  ai_state: AiHealthState;
  ai_provider: AiProviderId | null;
  ai_error: string | null;
  ai_rate_limit_reset_at: number | null;
  pending_ai_posts: number;
  telegram_state: "ok" | "not_configured" | "error";
  telegram_channel_count: number;
  outbox_pending: number;
  outbox_failed: number;
  flood_radars: Array<{ radar_id: string; radar_name: string; leads_last_hour: number }>;
  checked_at: number;
}

export interface CrawlRun {
  id: string;
  source_id: string;
  source_name: string;
  reason: "scheduled" | "manual" | "preview" | "passive";
  status: "ok" | "empty" | "blocked" | "error";
  started_at: number;
  ended_at: number | null;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy: "network" | "embedded" | "dom" | null;
  error: string | null;
}

export interface AiDailyUsageRow {
  date: string;
  calls: number;
  items: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  ai_escalation_pct: number;
}

export interface AiUsageStats {
  today_items: number;
  daily_cap: number;
  total_calls: number;
  total_items: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_ai_escalation_pct: number;
  daily: AiDailyUsageRow[];
}

export interface FunnelStats {
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

export interface RulesetExtractorRule {
  field: string;
  extractor: string;
  near?: string[];
  window?: number;
  scope?: string;
  pattern?: string;
  map?: Record<string, string[]>;
}

export interface RulesetClassifyRule {
  id: string;
  description?: string;
  kw_any?: string[];
  kw_none?: string[];
  has_field?: string;
  verdict: "match" | "no_match";
  confidence: number;
  set?: Record<string, string>;
}

export interface RulesetBody {
  dsl: 1;
  prefilter: {
    any: string[];
    none: string[];
    min_len?: number;
  };
  classify: RulesetClassifyRule[];
  extract: RulesetExtractorRule[];
  thresholds: {
    accept: number;
    reject: number;
  };
}

export interface RulesetMetrics {
  rule_handled_pct: number;
  ai_handled_pct: number;
  accept_precision: number;
  false_negative_rate: number;
  sample_size: number;
}

export interface Ruleset {
  id: string;
  radar_version_id: string;
  revision: number;
  state: "candidate" | "shadow" | "active" | "retired";
  origin: "seed" | "compiled" | "user";
  body: RulesetBody;
  metrics: RulesetMetrics | null;
  created_at: number;
  activated_at: number | null;
}

export interface ModelTierMap {
  fast: string;
  smart: string;
}

export interface CrawlPolicySettings {
  group_interval_minutes: number;
  priority_interval_minutes: number;
  hourly_page_load_budget: number;
  daily_page_load_budget: number;
  active_hours: {
    from: string;
    to: string;
  };
  max_scroll_steps: number;
  max_posts_per_visit: number;
  only_when_idle: boolean;
}

export interface Settings {
  privacy_consent_accepted: boolean;
  onboarding_completed: boolean;
  launch_at_login: boolean;
  ai_provider: AiProviderId | null;
  model_tiers: Record<AiProviderId, ModelTierMap>;
  daily_ai_post_cap: number;
  default_notify_mode: "instant" | "digest";
  digest_interval_minutes: number;
  quiet_hours_enabled: boolean;
  quiet_hours: QuietHours;
  os_notifications_enabled: boolean;
  crawl_policy: CrawlPolicySettings;
  unmatched_retention_days: number;
  debug_keep_ai_io: boolean;
}

export type PlanTier = "personal" | "pro";

export interface LicenseStatus {
  plan: PlanTier;
  licensee: string | null;
  issued_at: number | null;
  expires_at: number | null;
  is_valid: boolean;
  key_preview: string | null;
  limits: {
    max_active_radars: number | null; // 2 for personal, null (unlimited) for pro
    max_followed_groups: number;      // 10 for personal, 50 for pro
    max_fields_per_radar: number;     // 12 for personal, 20 for pro
    allow_xlsx_export: boolean;
    allow_webhooks: boolean;
    allow_auto_rulesets: boolean;
  };
}

export interface ProbeResult {
  provider: AiProviderId;
  binary_name: "claude" | "codex" | "agy";
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  flags_supported: boolean;
  latency_ms: number | null;
  error: string | null;
  install_hint: string;
  login_command: string;
}

export interface Channel {
  id: string;
  kind: "telegram" | "webhook";
  name: string;
  config: {
    chat_id?: string;
    bot_username?: string;
    chat_type?: "private" | "group";
    url?: string;
  };
  state: "ok" | "error";
  last_error?: string | null;
  created_at: number;
}

// --- Command Input & Output Contracts ---

export interface CreateRadarDraftInput {
  name: string;
  template_id: string | null;
  description: string;
  user_profession: string | null;
  language_hint?: string | null;
  fields: FieldDef[];
  match_policy: MatchPolicy;
  source_ids: string[];
  notify?: Partial<RadarNotifyConfig>;
}

export interface UpdateRadarInput {
  id: string;
  name?: string;
  description?: string;
  user_profession?: string | null;
  fields?: FieldDef[];
  match_policy?: MatchPolicy;
  source_ids?: string[];
  notify?: Partial<RadarNotifyConfig>;
  confirm_version_upgrade?: boolean;
}

export interface RadarUpdateResult {
  detail: RadarDetail;
  created_new_version: boolean;
  requires_confirmation: boolean;
}

export interface SuggestFieldsInput {
  description: string;
  user_profession?: string | null;
  template_id?: string | null;
  language_hint?: string | null;
}

export interface SuggestFieldsResult {
  suggested_name: string;
  want_intent: WantIntent;
  fields: FieldDef[];
  hard_filters: HardFilter[];
  clarifying_questions: string[];
  prefilter_hint: {
    any: string[];
    none: string[];
  } | null;
}

export interface PreviewItem {
  evaluation_id: string;
  post_id: string;
  verdict: "match" | "no_match";
  score: number;
  intent: PostIntent;
  author_role: AuthorRole;
  summary: string;
  reason: string;
  decided_by: DecidedBy;
  fields: Record<string, ExtractedField>;
  source_name: string;
  author_name: string;
  permalink: string;
  post_text: string;
  post_created_at: number | null;
  feedback_label: FeedbackLabel | null;
}

export interface PreviewWarning {
  code: "zero_matches" | "too_broad" | "missing_required_field";
  field_key?: string;
  field_label?: string;
  message: string;
}

export interface PreviewRunState {
  preview_id: string;
  radar_id: string;
  radar_version: number;
  status: "crawling" | "evaluating" | "done" | "error";
  total_posts: number;
  evaluated_posts: number;
  items: PreviewItem[];
  warnings: PreviewWarning[];
  error: string | null;
}

export interface PreviewStartInput {
  radar_id: string;
  description?: string;
  user_profession?: string | null;
  fields?: FieldDef[];
  match_policy?: MatchPolicy;
  source_ids?: string[];
}

export interface LeadFeedbackInput {
  evaluation_id: string;
  lead_id?: string | null;
  post_id?: string | null;
  radar_version_id?: string | null;
  label: FeedbackLabel;
  corrected_fields?: Record<string, unknown> | null;
  duplicate_of_lead_id?: string | null;
  block_author?: boolean;
  origin: "app" | "preview";
}

export interface LeadFeedbackResult {
  feedback_id: string;
  updated_lead: Lead | null;
  blocked_entry: BlocklistEntry | null;
}

export interface LeadExportInput {
  query: LeadFilterQuery;
  format: "csv" | "xlsx";
  include_post_text: boolean;
  dest_path?: string | null;
}

export interface LeadExportResult {
  path: string;
  format: "csv" | "xlsx";
  row_count: number;
  content_preview?: string;
}

export interface TelegramSetupStatus {
  bot_username: string;
  bot_link: string;
  waiting_for_start: boolean;
  channels: Channel[];
}

export interface ChromeConnectResult {
  native_host_installed: boolean;
  manifest_path: string;
  extension_connected: boolean;
  facebook_session: FacebookSessionState;
  message: string;
}

// --- Real-time Tauri Event Payloads (`03-desktop.md §4`) ---

export interface PreviewProgressEvent {
  preview_id: string;
  radar_id: string;
  status: PreviewRunState["status"];
  evaluated_posts: number;
  total_posts: number;
  new_items: PreviewItem[];
  warnings: PreviewWarning[];
}

export interface JobFailedEvent {
  job_id: string;
  kind: string;
  error: string;
  failed_at: number;
}

export interface TauriEventMap {
  "lead:new": Lead;
  "lead:updated": Lead;
  "preview:progress": PreviewProgressEvent;
  "health:changed": HealthStatus;
  "crawl:finished": CrawlRun;
  "job:failed": JobFailedEvent;
}
