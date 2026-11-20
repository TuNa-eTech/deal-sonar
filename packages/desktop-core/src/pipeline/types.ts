// Shared pipeline types: configuration, DTOs, and the injectable hook contracts
// (AI bridge, notification routing, license limits, IPC peers).
//
// HOOK SIGNATURES (documented for the protocol-handshake / MCP / AI / notification workers):
//
//   PipelineHooks.ai?:          AiHooks            judge_extract_all / suggest_fields / compile_rules (see below)
//   PipelineHooks.notify?:      NotificationHooks  routeLead(input) + runJob(kind, payload) for outbox-backed jobs
//   PipelineHooks.license?:     LicenseHooks       limits(now) -> LicenseLimits
//   PipelineHooks.templates?:   TemplateHooks      get(id) -> RadarTemplate | null  (for suggest_fields closest_template)
//   PipelineHooks.now?:         () => number
//
// Every hook is optional. When a hook that a feature needs is missing the feature fails with an
// explicit `CoreError` (never a fabricated success): AI features throw `ai_error`
// ("AI bridge chưa được cấu hình"), notification routing logs and skips, the notify_lead and
// flush_digest jobs fail with a retryable error, license falls back to the Personal plan limits.

import type { FieldDef, MatchPolicy } from "../store/domain";
import type { ExtractedField } from "../store/domain";

// ---------------------------------------------------------------------------------------------
// Configuration (`CoreConfig` pipeline subset)
// ---------------------------------------------------------------------------------------------

export interface PipelineConfig {
  batchTriggerCount: number;
  batchMaxWaitMs: number;
  previewBatchSize: number;
  previewMaxPosts: number;
  previewMinPostsBeforeCrawl: number;
  shadowMinPosts: number;
  shadowMinAgeMs: number;
  autoCompileMinAiEvals: number;
  autoCompileMinMatches: number;
  auditSamplePercent: number;
  auditDisagreementDemoteThreshold: number;
  auditMinSamples: number;
  jobPollIntervalMs: number;
  schedulerIntervalMs: number;
  /** Max wait for an empty-store preview to receive its crawl (Rust: 60 x 500 ms). */
  previewCrawlWaitMs: number;
  /** Poll interval while waiting for that crawl (Rust: 500 ms). */
  previewPollMs: number;
  /** Preview hard timeout (Rust: 300 s). */
  previewTimeoutMs: number;
  /** Grace window before alerting on a disconnected extension / unavailable AI (Rust: 30 min). */
  disconnectAlertGraceMs: number;
  /** Health monitor cadence (Rust: 60 s). */
  healthCheckIntervalMs: number;
  spawnBackgroundWorkers: boolean;
}

export function defaultPipelineConfig(): PipelineConfig {
  return {
    batchTriggerCount: 20,
    batchMaxWaitMs: 45_000,
    previewBatchSize: 3,
    previewMaxPosts: 50,
    previewMinPostsBeforeCrawl: 20,
    shadowMinPosts: 200,
    shadowMinAgeMs: 3 * 86_400_000,
    autoCompileMinAiEvals: 150,
    autoCompileMinMatches: 20,
    auditSamplePercent: 5,
    auditDisagreementDemoteThreshold: 0.08,
    auditMinSamples: 10,
    jobPollIntervalMs: 250,
    schedulerIntervalMs: 300_000,
    previewCrawlWaitMs: 30_000,
    previewPollMs: 500,
    previewTimeoutMs: 300_000,
    disconnectAlertGraceMs: 30 * 60_000,
    healthCheckIntervalMs: 60_000,
    spawnBackgroundWorkers: true,
  };
}

// ---------------------------------------------------------------------------------------------
// DTOs shared with the renderer (`ipc.ts`); field names are the wire contract.
// ---------------------------------------------------------------------------------------------

export type RadarStatus = "draft" | "active" | "paused" | "archived";
export type PostIntent = "demand" | "supply" | "other";
export type PipelineAuthorRole = "end_user" | "peer" | "unknown";
export type DecidedBy = "dedup" | "prefilter" | "rule" | "ai" | "postfilter";
export type FeedbackLabel = "correct" | "irrelevant" | "wrong_fields" | "peer" | "duplicate" | "spam" | "missed";
export type FacebookSessionState = "ok" | "logged_out" | "checkpoint" | "rate_limited";
export type CrawlPauseReason = "manual" | "checkpoint_awaiting_resume" | "rate_limited" | "logged_out";
export type AiHealthState = "ok" | "not_configured" | "error" | "rate_limited" | "daily_cap_reached";
export type TelegramHealthState = "ok" | "not_configured" | "error";
export type AiProviderId = "claude_cli" | "codex_cli" | "agy_cli";

export interface QuietHoursDto {
  from: string;
  to: string;
}

export interface CrawlPolicySettings {
  group_interval_minutes: number;
  priority_interval_minutes: number;
  hourly_page_load_budget: number;
  daily_page_load_budget: number;
  active_hours: QuietHoursDto;
  max_scroll_steps: number;
  max_posts_per_visit: number;
  only_when_idle: boolean;
}

export interface AppSettings {
  privacy_consent_accepted: boolean;
  onboarding_completed: boolean;
  launch_at_login: boolean;
  ai_provider: AiProviderId | null;
  model_tiers: Record<string, { fast: string; smart: string }>;
  daily_ai_post_cap: number;
  default_notify_mode: "instant" | "digest";
  digest_interval_minutes: number;
  quiet_hours_enabled: boolean;
  quiet_hours: QuietHoursDto;
  os_notifications_enabled: boolean;
  crawl_policy: CrawlPolicySettings;
  unmatched_retention_days: number;
  debug_keep_ai_io: boolean;
}

export interface FloodRadarInfo {
  radar_id: string;
  radar_name: string;
  leads_last_hour: number;
}

export interface HealthStatus {
  automatic_scanning: boolean | null;
  next_crawl_at: number | null;
  last_crawl_at: number | null;
  runtime_checked_at: number | null;
  extension_connected: boolean;
  extension_version: string | null;
  facebook_session: FacebookSessionState;
  crawl_paused: boolean;
  crawl_pause_reason: CrawlPauseReason | null;
  page_loads_last_hour: number;
  page_loads_today: number;
  ai_state: AiHealthState;
  ai_provider: AiProviderId | null;
  ai_error: string | null;
  ai_rate_limit_reset_at: number | null;
  pending_ai_posts: number;
  telegram_state: TelegramHealthState;
  telegram_channel_count: number;
  outbox_pending: number;
  outbox_failed: number;
  flood_radars: FloodRadarInfo[];
  checked_at: number;
}

export interface CrawlRunDto {
  id: string;
  source_id: string;
  source_name: string;
  reason: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  posts_seen: number;
  posts_new: number;
  page_loads: number;
  strategy: string | null;
  error: string | null;
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
  status: string;
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
  also_seen_in: Array<{ source_id: string; source_name: string; permalink: string; captured_at: number }>;
  notified_at: number | null;
  follow_up_at: number | null;
  note: string | null;
  tags: string[];
  feedback_label: FeedbackLabel | null;
  created_at: number;
  updated_at: number;
}

export interface ExtractedFieldDto {
  value: unknown;
  raw: string | null;
  confidence: number;
  source: string;
}

export interface RadarNotifyConfigDto {
  channel_ids: string[];
  inherit_channels?: boolean;
  mode: string;
  min_score: number;
  quiet_hours: QuietHoursDto | null;
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
  leads_24h?: number;
  false_positive_rate?: number;
  evaluated_posts_total?: number;
  rule_handled_pct?: number;
  auto_digest_flood?: boolean;
}

export interface PreviewItem {
  evaluation_id: string;
  post_id: string;
  verdict: string;
  score: number;
  intent: PostIntent;
  author_role: PipelineAuthorRole;
  summary: string;
  reason: string;
  decided_by: DecidedBy;
  fields: Record<string, ExtractedFieldDto>;
  source_name: string;
  author_name: string;
  permalink: string;
  post_text: string;
  post_created_at: number | null;
  feedback_label: FeedbackLabel | null;
}

export type PreviewWarningCode = "zero_matches" | "too_broad" | "missing_required_field";
export interface PreviewWarning {
  code: PreviewWarningCode;
  field_key?: string;
  field_label?: string;
  message: string;
}
export type PreviewStatus = "crawling" | "evaluating" | "done" | "error";

export interface PreviewRunState {
  preview_id: string;
  radar_id: string;
  radar_version: number;
  source_ids?: string[];
  status: PreviewStatus;
  total_posts: number;
  evaluated_posts: number;
  failed_posts: number;
  items: PreviewItem[];
  warnings: PreviewWarning[];
  error: string | null;
}

export interface PreviewStartInput {
  radar_id: string;
  description?: string | null;
  /** `undefined` keeps, `null` clears, string sets (serde `Option<Option<String>>`). */
  user_profession?: string | null;
  fields?: FieldDef[] | null;
  match_policy?: MatchPolicy | null;
  source_ids?: string[] | null;
}

export interface SuggestFieldsInput {
  description: string;
  user_profession?: string | null;
  template_id?: string | null;
  language_hint?: string | null;
  suggest_sources?: boolean;
}

// ---------------------------------------------------------------------------------------------
// AI hook contract (mirrors crates/ai-bridge JSON shapes)
// ---------------------------------------------------------------------------------------------

export type AiCallStatus = "ok" | "invalid_output" | "timeout" | "rate_limited" | "error";

/** `AiError` as a thrown value. `retryAfterMs` is only set for `kind: "rate_limited"`. */
export class AiHookError extends Error {
  constructor(
    readonly kind: "not_installed" | "not_authenticated" | "rate_limited" | "timeout" | "invalid_output" | "refused" | "security_flags_unsupported" | "process",
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly calls: readonly AiCallTelemetry[] = [],
  ) {
    super(message);
    this.name = "AiHookError";
  }
  callStatus(): AiCallStatus {
    switch (this.kind) {
      case "invalid_output": return "invalid_output";
      case "timeout": return "timeout";
      case "rate_limited": return "rate_limited";
      default: return "error";
    }
  }
}

export interface AiCallTelemetry {
  provider: string;
  model: string | null;
  task: "suggest_fields" | "judge_extract" | "compile_rules";
  radar_version_id: string | null;
  item_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  status: AiCallStatus;
  error: string | null;
}

export type AiWantIntent = "demand" | "supply" | "any";

export interface AiFeedbackExample {
  is_positive: boolean;
  label: string;
  post_text: string;
  author_role: PipelineAuthorRole | null;
  corrected_fields: Record<string, unknown> | null;
}

export interface RadarPromptContext {
  radar_version_id: string;
  description: string;
  user_profession: string | null;
  language_hint: string | null;
  want_intent: AiWantIntent;
  exclude_roles: PipelineAuthorRole[];
  fields: FieldDef[];
  feedback_examples: AiFeedbackExample[];
}

export interface PostPromptInput {
  post_id: string;
  ref: number;
  group_name: string;
  author_name: string | null;
  created_at_ms: number | null;
  text: string;
  rule_hints: Record<string, unknown> | null;
}

export interface AiFieldCandidate {
  raw: string | null;
  value: unknown;
  confidence: number;
}

export interface JudgeItemResult {
  ref: number;
  match: boolean;
  score: number;
  intent: PostIntent;
  author_role: PipelineAuthorRole;
  is_spam: boolean;
  summary: string;
  reason: string;
  fields: Record<string, AiFieldCandidate>;
}

export type PostEvalOutcome =
  | { state: "done"; post_id: string; result: JudgeItemResult }
  | { state: "ai_failed"; post_id: string; ref: number; error: string };

export interface JudgeBatchReport {
  outcomes: PostEvalOutcome[];
  calls: AiCallTelemetry[];
}

export interface BatchConfig {
  /** `20` live, `10` preview; the bridge also enforces the 24,000-char prompt budget. */
  max_posts: number;
  preview: boolean;
}

export interface SuggestFieldsBridgeInput {
  description: string;
  user_profession: string | null;
  language_hint: string | null;
  closest_template: unknown | null;
  source_candidates: Array<{ id: string; name: string; stored_posts: number }>;
}

export interface SuggestFieldsBridgeOutput {
  suggested_name: string;
  want_intent: AiWantIntent;
  fields: Array<{ key: string; label: string; type: string; description: string; required: boolean; options?: string[] | null }>;
  hard_filters: Array<{ field: string; op: string; value: unknown; when_missing: string }>;
  clarifying_questions: string[];
  prefilter_hint: { any: string[]; none: string[] } | null;
  suggested_source_ids: string[];
}

export interface CompileRulesBridgeInput {
  radar: RadarPromptContext;
  labeled_samples: Array<{
    post_text: string;
    is_match: boolean;
    author_role: PipelineAuthorRole | null;
    expected_fields: Record<string, unknown>;
  }>;
  current_ruleset: unknown | null;
  current_ruleset_errors: string[];
}

export interface AiHooks {
  /** Provider id recorded in `ai_calls` for calls that fail before producing telemetry (`claude_cli`, ... or `mock`). */
  providerId(): string;
  judgeExtractAll(radar: RadarPromptContext, posts: PostPromptInput[], config: BatchConfig): Promise<JudgeBatchReport>;
  suggestFields(input: SuggestFieldsBridgeInput): Promise<{ output: SuggestFieldsBridgeOutput; calls: AiCallTelemetry[] }>;
  /** Returns the raw DSL JSON validated by the bridge (DSL v1 + safe regex). */
  compileRules(input: CompileRulesBridgeInput): Promise<{ output: unknown; calls: AiCallTelemetry[] }>;
}

// ---------------------------------------------------------------------------------------------
// Notification / license / template hooks
// ---------------------------------------------------------------------------------------------

export interface LeadNotificationInput {
  lead: import("../store/leads").LeadRecord;
  post: import("../store/posts").PostRecord;
  sourceName: string;
  authorName: string;
  radarId: string;
  radarName: string;
  radarStatus: string;
  radarNotify: import("../store/domain").NotifyConfig;
  radarVersion: import("../store/radars").RadarVersionRecord;
  /** `live` | `backfill_silent` | `preview`; `repostAfter72h` only applies to `live`. */
  mode: EvalMode;
  now: number;
}

export type SystemIncident =
  | { kind: "ai_unavailable"; pending_posts: number }
  | { kind: "extension_disconnected" }
  | { kind: "facebook_session_issue" }
  | { kind: "extractor_broken" }
  | { kind: "radar_flood_auto_digest"; radar_name: string; leads_last_hour: number };

export interface NotificationHooks {
  /** Deduplicated system incident (or recovery when `resolved`) alert to all healthy channels. Optional; best-effort. */
  queueSystemIncident?(incident: SystemIncident, resolved: boolean, now: number): void | Promise<void>;
  /**
   * Channel routing for a freshly created lead (quiet hours, digest/flood policy, Telegram/webhook
   * outbox rows, `notify_lead` job). OS-notification fallback is handled by the pipeline itself.
   */
  routeLead(input: LeadNotificationInput): void | Promise<void>;
  /** Executes the outbox-backed durable jobs `notify_lead` and `flush_digest`. */
  runJob(kind: "notify_lead" | "flush_digest", payload: Record<string, unknown>): Promise<void>;
}

export interface LicenseLimits {
  max_active_radars: number | null;
  max_followed_groups: number;
  max_fields_per_radar: number;
  allow_xlsx_export: boolean;
  allow_webhooks: boolean;
  allow_auto_rulesets: boolean;
  /** Plan label for error text (`Personal` / `Pro`). */
  plan?: string;
}

export interface LicenseHooks {
  limits(now: number): LicenseLimits;
  /**
   * Re-verify the license and auto-pause radars exceeding the plan (daily maintenance). Returns the
   * ids of radars that were paused. Optional.
   */
  enforcePlanLimits?(now: number): string[];
}

export interface TemplateHooks {
  get(id: string): unknown | null;
}

export interface PipelineHooks {
  ai?: AiHooks;
  notify?: NotificationHooks;
  license?: LicenseHooks;
  templates?: TemplateHooks;
  now?: () => number;
  log?: (message: string) => void;
}

export const PERSONAL_LIMITS: LicenseLimits = {
  max_active_radars: 2,
  max_followed_groups: 10,
  max_fields_per_radar: 12,
  allow_xlsx_export: false,
  allow_webhooks: false,
  allow_auto_rulesets: false,
  plan: "Personal",
};

// ---------------------------------------------------------------------------------------------
// Evaluation modes and candidate decisions
// ---------------------------------------------------------------------------------------------

export type EvalMode =
  | { kind: "live"; repostAfter72h: boolean }
  | { kind: "backfill_silent" }
  | { kind: "preview" };

export const isPreview = (m: EvalMode): boolean => m.kind === "preview";
export const isSilentOrPreview = (m: EvalMode): boolean => m.kind !== "live";
export const repostAfter72h = (m: EvalMode): boolean => m.kind === "live" && m.repostAfter72h;

export interface CandidateDecision {
  decidedBy: "rule" | "ai";
  rulesetId: string | null;
  aiCallId: string | null;
  isMatch: boolean;
  rawScore: number;
  intent: PostIntent;
  authorRole: PipelineAuthorRole;
  isSpam: boolean;
  summary: string;
  reason: string;
  /** Rules-engine fields (`raw` always a non-empty string). */
  candidateFields: Record<string, import("../rules/types").ExtractedField>;
}

export type StoreExtractedField = ExtractedField;
