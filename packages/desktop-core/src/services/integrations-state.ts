// Shared runtime state of the integrations services (settings, license, AI bridge, Telegram /
// webhook clients, outbox tracker, health). It is the TS counterpart of the parts of the Rust
// `CoreRuntime` (crates/core/src/state.rs) that this port owns.
//
// `RuntimeContext` has no slot for service state, so it is kept in a `WeakMap` keyed by the
// context. `getIntegrations(ctx)` creates it lazily with production defaults; the composition root
// (or a test) may call `configureIntegrations(ctx, deps)` first to inject transports and hooks.

import * as fs from "node:fs";
import * as path from "node:path";

import { AiBridge, buildCliProvider } from "../ai/bridge";
import { MockAiProvider } from "../ai/mock";
import type { AiProvider, CliProviderId } from "../ai/types";
import type { RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { type SecretStore, TELEGRAM_BOT_TOKEN_KEY } from "../secrets/types";
import type { EvaluationRecord } from "../store/leads";
import type { EnqueueOutboxInput, OutboxRecord } from "../store/ops";
import type { Store } from "../store/store";
import {
  FLOOD_LEADS_PER_HOUR_THRESHOLD,
  type SystemIncidentKind,
  formatSystemAlertHtml,
} from "../notify/format";
import { TelegramClient, type TelegramClientConfig, sendMessageHtml } from "../notify/telegram";
import { WebhookClient, type WebhookClientConfig } from "../notify/webhook";
import { LICENSE_TOKEN_SETTING_KEY, LicenseVerifier, type LicenseStatus } from "./integrations-license";

// ---- settings DTOs (crates/core/src/dto/system.rs) -----------------------------------------------

export type AiProviderId = CliProviderId;
export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["claude_cli", "codex_cli", "agy_cli"];

export const AI_PROVIDER_META: Record<AiProviderId, { binary: string; installHint: string; loginCommand: string }> = {
  claude_cli: { binary: "claude", installHint: "npm install -g @anthropic-ai/claude-code", loginCommand: "claude login" },
  codex_cli: { binary: "codex", installHint: "npm install -g @openai/codex", loginCommand: "codex login" },
  agy_cli: { binary: "agy", installHint: "Cài đặt Google Antigravity IDE / CLI (agy)", loginCommand: "agy auth login" },
};

export interface ModelTierPair {
  fast: string;
  smart: string;
}
export interface QuietHoursDto {
  from: string;
  to: string;
}
export type NotifyMode = "instant" | "digest";

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

export interface Settings {
  privacy_consent_accepted: boolean;
  onboarding_completed: boolean;
  launch_at_login: boolean;
  ai_provider: AiProviderId | null;
  model_tiers: Partial<Record<AiProviderId, ModelTierPair>>;
  daily_ai_post_cap: number;
  default_notify_mode: NotifyMode;
  digest_interval_minutes: number;
  quiet_hours_enabled: boolean;
  quiet_hours: QuietHoursDto;
  os_notifications_enabled: boolean;
  crawl_policy: CrawlPolicySettings;
  unmatched_retention_days: number;
  debug_keep_ai_io: boolean;
}

export function defaultSettings(): Settings {
  return {
    privacy_consent_accepted: false,
    onboarding_completed: false,
    launch_at_login: true,
    ai_provider: null,
    model_tiers: {
      claude_cli: { fast: "haiku", smart: "sonnet" },
      codex_cli: { fast: "codex-mini-latest", smart: "gpt-5-codex" },
      agy_cli: { fast: "gemini-2.5-flash", smart: "gemini-2.5-pro" },
    },
    daily_ai_post_cap: 2_000,
    default_notify_mode: "instant",
    digest_interval_minutes: 30,
    quiet_hours_enabled: false,
    quiet_hours: { from: "22:30", to: "06:30" },
    os_notifications_enabled: true,
    crawl_policy: {
      group_interval_minutes: 15,
      priority_interval_minutes: 5,
      hourly_page_load_budget: 60,
      daily_page_load_budget: 600,
      active_hours: { from: "07:00", to: "23:00" },
      max_scroll_steps: 3,
      max_posts_per_visit: 25,
      only_when_idle: false,
    },
    unmatched_retention_days: 90,
    debug_keep_ai_io: false,
  };
}

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fill any missing/ill-typed stored key from the defaults (older databases, partial writes). */
export function normalizeSettings(raw: Json): Settings {
  const d = defaultSettings();
  if (!isObject(raw)) return d;
  const bool = (v: Json, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
  const u32 = (v: Json, dflt: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : dflt);
  const qh = (v: Json, dflt: QuietHoursDto): QuietHoursDto =>
    isObject(v) && typeof v.from === "string" && typeof v.to === "string" ? { from: v.from, to: v.to } : dflt;

  const tiers: Settings["model_tiers"] = isObject(raw.model_tiers) ? {} : { ...d.model_tiers };
  if (isObject(raw.model_tiers)) {
    for (const pid of AI_PROVIDER_IDS) {
      const t = raw.model_tiers[pid];
      if (isObject(t) && typeof t.fast === "string" && typeof t.smart === "string") {
        tiers[pid] = { fast: t.fast, smart: t.smart };
      }
    }
  }
  const cp = isObject(raw.crawl_policy) ? raw.crawl_policy : {};
  return {
    privacy_consent_accepted: bool(raw.privacy_consent_accepted, d.privacy_consent_accepted),
    onboarding_completed: bool(raw.onboarding_completed, d.onboarding_completed),
    launch_at_login: bool(raw.launch_at_login, d.launch_at_login),
    ai_provider: AI_PROVIDER_IDS.includes(raw.ai_provider as AiProviderId) ? (raw.ai_provider as AiProviderId) : null,
    model_tiers: tiers,
    daily_ai_post_cap: u32(raw.daily_ai_post_cap, d.daily_ai_post_cap),
    default_notify_mode: raw.default_notify_mode === "digest" ? "digest" : "instant",
    digest_interval_minutes: u32(raw.digest_interval_minutes, d.digest_interval_minutes),
    quiet_hours_enabled: bool(raw.quiet_hours_enabled, d.quiet_hours_enabled),
    quiet_hours: qh(raw.quiet_hours, d.quiet_hours),
    os_notifications_enabled: bool(raw.os_notifications_enabled, d.os_notifications_enabled),
    crawl_policy: {
      group_interval_minutes: u32(cp.group_interval_minutes, d.crawl_policy.group_interval_minutes),
      priority_interval_minutes: u32(cp.priority_interval_minutes, d.crawl_policy.priority_interval_minutes),
      hourly_page_load_budget: u32(cp.hourly_page_load_budget, d.crawl_policy.hourly_page_load_budget),
      daily_page_load_budget: u32(cp.daily_page_load_budget, d.crawl_policy.daily_page_load_budget),
      active_hours: qh(cp.active_hours, d.crawl_policy.active_hours),
      max_scroll_steps: u32(cp.max_scroll_steps, d.crawl_policy.max_scroll_steps),
      max_posts_per_visit: u32(cp.max_posts_per_visit, d.crawl_policy.max_posts_per_visit),
      only_when_idle: bool(cp.only_when_idle, d.crawl_policy.only_when_idle),
    },
    unmatched_retention_days: u32(raw.unmatched_retention_days, d.unmatched_retention_days),
    debug_keep_ai_io: bool(raw.debug_keep_ai_io, d.debug_keep_ai_io),
  };
}

export const APP_SETTINGS_KEY = "app.settings";
export const OUTBOX_TRACKER_SETTING_KEY = "runtime.outbox_tracker";

export function loadSettings(store: Store): Settings {
  return normalizeSettings(store.settings.get(APP_SETTINGS_KEY));
}
export function saveSettings(store: Store, settings: Settings): void {
  store.settings.set(APP_SETTINGS_KEY, settings);
}

// ---- health DTO ---------------------------------------------------------------------------------

export type FacebookSessionState = "ok" | "logged_out" | "checkpoint" | "rate_limited";
export type AiHealthState = "ok" | "not_configured" | "error" | "rate_limited" | "daily_cap_reached";
export type TelegramHealthState = "ok" | "not_configured" | "error";

export interface HealthStatus {
  automatic_scanning: boolean | null;
  next_crawl_at: number | null;
  last_crawl_at: number | null;
  runtime_checked_at: number | null;
  extension_connected: boolean;
  extension_version: string | null;
  facebook_session: FacebookSessionState;
  crawl_paused: boolean;
  crawl_pause_reason: string | null;
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
  flood_radars: Array<{ radar_id: string; radar_name: string; leads_last_hour: number }>;
  checked_at: number;
}

/** Chrome-extension / crawl state owned by the IPC hub (`IpcHubState` + fresh crawl reports). */
export interface IpcHealthSnapshot {
  extension_connected: boolean;
  extension_version: string | null;
  facebook_session: FacebookSessionState;
  /** Hub pause flag OR any fresh (< 90 s) extension report that says it is paused. */
  crawl_paused: boolean;
  crawl_pause_reason: string | null;
  automatic_scanning: boolean | null;
  next_crawl_at: number | null;
  runtime_checked_at: number | null;
}

export const DISCONNECTED_IPC: IpcHealthSnapshot = {
  extension_connected: false,
  extension_version: null,
  facebook_session: "ok",
  crawl_paused: false,
  crawl_pause_reason: null,
  automatic_scanning: null,
  next_crawl_at: null,
  runtime_checked_at: null,
};

// ---- hooks into the other ports ------------------------------------------------------------------

/**
 * Seams to services owned by other workers. Every hook is optional; the documented default is the
 * behaviour when the owner is not wired yet (never a fabricated success).
 */
export interface IntegrationHooks {
  /** Chrome IPC hub state for `health_get`/diagnostics. Default: extension disconnected. */
  ipcSnapshot?(ctx: RuntimeContext): IpcHealthSnapshot;
  emitHealthIfChanged?(now: number): Promise<HealthStatus>;
  /** Resume crawling (Telegram `/resume`, clears pause + `crawl.resume`). Returns true if it resumed. Default: false. */
  resumeCrawl?(ctx: RuntimeContext): boolean;
  /** Recompute plan/policy and push `config.update` to connected profiles. Default: no-op. */
  bumpAndPushConfig?(ctx: RuntimeContext): void;
  /** Wake the durable job loop (a due job was enqueued). Default: no-op. */
  wakeJobs?(ctx: RuntimeContext): void;
  /** Lead DTO (`load_lead_dto`) for `lead:updated`. Default: no event is emitted. */
  loadLeadDto?(ctx: RuntimeContext, leadId: string): unknown | null;
  /** Immediate demotion check after negative feedback on a rule-decided evaluation. Default: no-op. */
  onNegativeFeedback?(ctx: RuntimeContext, evaluation: EvaluationRecord, nowMs: number): void | Promise<void>;
  /** Drop in-memory preview caches after `data_delete_all`. Default: no-op. */
  onDataDeleted?(ctx: RuntimeContext): void;
  /** Sync OS login-item state after `settings_set { launch_at_login }`. Default: no-op. */
  onLaunchAtLoginChanged?(ctx: RuntimeContext, enabled: boolean): void;
  /** Radar service used by `workspace_action("rollback")`. Default: the action answers `not_implemented`. */
  radar?: {
    get(ctx: RuntimeContext, id: string): unknown;
    update(ctx: RuntimeContext, input: Record<string, unknown>): { detail: unknown };
  };
}

export interface IntegrationDeps {
  hooks?: IntegrationHooks;
  /** AI provider override for tests. The default follows runtime configuration and saved settings. */
  aiProvider?: AiProvider;
  aiHealth?: AiRuntimeHealth;
  licenseVerifier?: LicenseVerifier;
  telegram?: TelegramClient;
  telegramConfig?: Partial<TelegramClientConfig>;
  webhook?: WebhookClient;
  webhookConfig?: Partial<WebhookClientConfig>;
  /** Job/outbox poll interval and Telegram long-poll timing (ms / s). */
  outboxPollMs?: number;
  telegramPollTimeoutS?: number;
  telegramIdleSleepMs?: number;
}

export interface OutboxTrackerEntry {
  channel_id: string;
  state: string;
}

export interface AiRuntimeHealth {
  lastError: string | null;
  rateLimitResetAt: number | null;
  firstUnavailableAt: number | null;
  dailyCapReachedDate: string | null;
}

export class IntegrationState {
  readonly hooks: IntegrationHooks;
  readonly licenseVerifier: LicenseVerifier;
  readonly telegram: TelegramClient;
  readonly webhook: WebhookClient;
  readonly bridge: AiBridge;
  readonly aiHealth: AiRuntimeHealth;
  readonly incidents = {
    fbSessionAlerted: false,
    extDisconnectedAlerted: false,
    aiUnavailableAlerted: false,
    extractorBrokenAlerted: false,
    floodAlertedRadars: new Set<string>(),
  };
  readonly outboxTracker = new Map<string, OutboxTrackerEntry>();
  outboxPending = 0;
  outboxFailed = 0;
  lastEmittedHealth: HealthStatus | null = null;
  inflightAiCalls = 0;
  private inflightWaiters: Array<() => void> = [];
  readonly outboxPollMs: number;
  readonly telegramPollTimeoutS: number;
  readonly telegramIdleSleepMs: number;
  /** Set by the worker controller so enqueuers can wake the outbox loop. */
  outboxWake: (() => void) | null = null;
  workersStop: (() => Promise<void>) | null = null;

  constructor(deps: IntegrationDeps, provider: AiProvider) {
    this.hooks = deps.hooks ?? {};
    this.aiHealth = deps.aiHealth ?? {
      lastError: null, rateLimitResetAt: null, firstUnavailableAt: null, dailyCapReachedDate: null,
    };
    this.licenseVerifier = deps.licenseVerifier ?? new LicenseVerifier();
    this.telegram = deps.telegram ?? new TelegramClient(deps.telegramConfig);
    this.webhook = deps.webhook ?? new WebhookClient(deps.webhookConfig);
    this.bridge = new AiBridge(provider);
    this.outboxPollMs = deps.outboxPollMs ?? 250;
    this.telegramPollTimeoutS = deps.telegramPollTimeoutS ?? 25;
    this.telegramIdleSleepMs = deps.telegramIdleSleepMs ?? 500;
  }

  /** Track an in-flight AI call so shutdown can wait for it (`InflightAiGuard`). */
  async withInflightAi<T>(fn: () => Promise<T>): Promise<T> {
    this.inflightAiCalls += 1;
    try {
      return await fn();
    } finally {
      this.inflightAiCalls -= 1;
      if (this.inflightAiCalls <= 0) {
        const waiters = this.inflightWaiters;
        this.inflightWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  /** Resolve when no AI call is in flight, or after `timeoutMs`. */
  waitForInflightAi(timeoutMs: number): Promise<void> {
    if (this.inflightAiCalls <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.inflightWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const REGISTRY = new WeakMap<RuntimeContext, IntegrationState>();
const PENDING_DEPS = new WeakMap<RuntimeContext, IntegrationDeps>();

/** Inject transports/hooks before the first handler call. Replaces any existing state. */
export function configureIntegrations(ctx: RuntimeContext, deps: IntegrationDeps): IntegrationState {
  PENDING_DEPS.set(ctx, deps);
  REGISTRY.delete(ctx);
  return getIntegrations(ctx);
}

export function resetIntegrations(ctx: RuntimeContext): void {
  REGISTRY.delete(ctx);
  PENDING_DEPS.delete(ctx);
}

/** Build the CLI provider that matches persisted settings (`build_cli_provider_for_settings`). */
export function cliProviderForSettings(provider: AiProviderId, settings: Settings, ctx: RuntimeContext): AiProvider {
  const workdir = path.join(ctx.config.dataDir, "ai-workdir");
  try {
    fs.mkdirSync(workdir, { recursive: true });
  } catch {
    // best effort, like the Rust `let _ =`
  }
  return buildCliProvider(provider, settings.model_tiers, workdir);
}

export function getIntegrations(ctx: RuntimeContext): IntegrationState {
  const existing = REGISTRY.get(ctx);
  if (existing) return existing;
  const deps = PENDING_DEPS.get(ctx) ?? {};

  // Production default: Claude CLI, switched to the persisted selection (builder `start()`).
  const settings = loadSettings(ctx.store);
  const initial: AiProvider =
    deps.aiProvider ?? (ctx.config.mockAi
      ? new MockAiProvider()
      : cliProviderForSettings(settings.ai_provider ?? "claude_cli", settings, ctx));
  const state = new IntegrationState(deps, initial);
  REGISTRY.set(ctx, state);
  restoreOutboxTracker(ctx, state);
  return state;
}

// ---- time helpers -------------------------------------------------------------------------------

export const nowMs = (): number => Date.now();

let lastMutationMs = 0;
/** `monotonic_radar_now_ms`: wall clock, strictly increasing within the process. */
export function monotonicNowMs(): number {
  const next = Math.max(Date.now(), lastMutationMs + 1);
  lastMutationMs = next;
  return next;
}

export function startOfLocalDayMs(tsMs: number): number {
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return tsMs - (((tsMs % 86_400_000) + 86_400_000) % 86_400_000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function ensureNotShuttingDown(ctx: RuntimeContext): void {
  if (ctx.isShuttingDown()) throw CoreError.shuttingDown();
}

// ---- license ------------------------------------------------------------------------------------

export function currentLicenseStatus(ctx: RuntimeContext, now: number): LicenseStatus {
  const token = ctx.store.settings.get<string>(LICENSE_TOKEN_SETTING_KEY);
  return getIntegrations(ctx).licenseVerifier.evaluateStatus(token, now);
}

// ---- outbox tracker (`runtime.outbox_tracker`) ----------------------------------------------------

function syncOutboxCounts(state: IntegrationState): void {
  let pending = 0;
  let failed = 0;
  for (const entry of state.outboxTracker.values()) {
    if (entry.state === "pending") pending += 1;
    else if (entry.state === "failed") failed += 1;
  }
  state.outboxPending = pending;
  state.outboxFailed = failed;
}

function persistOutboxTracker(store: Store, state: IntegrationState): void {
  if (state.outboxTracker.size === 0) store.settings.delete(OUTBOX_TRACKER_SETTING_KEY);
  else store.settings.set(OUTBOX_TRACKER_SETTING_KEY, Object.fromEntries([...state.outboxTracker].sort()));
}

/** Restore the persisted tracker, pruning orphaned channels and terminal states. */
export function restoreOutboxTracker(ctx: RuntimeContext, state: IntegrationState): void {
  const channelIds = new Set(ctx.store.channels.list().map((c) => c.id));
  const loaded = ctx.store.settings.get<Record<string, OutboxTrackerEntry>>(OUTBOX_TRACKER_SETTING_KEY) ?? {};
  const kept = new Map<string, OutboxTrackerEntry>();
  for (const [id, entry] of Object.entries(isObject(loaded) ? loaded : {})) {
    if (
      isObject(entry) &&
      typeof entry.channel_id === "string" &&
      channelIds.has(entry.channel_id) &&
      (entry.state === "pending" || entry.state === "failed")
    ) {
      kept.set(id, { channel_id: entry.channel_id, state: entry.state });
    }
  }
  state.outboxTracker.clear();
  for (const [k, v] of kept) state.outboxTracker.set(k, v);
  if (kept.size !== Object.keys(isObject(loaded) ? loaded : {}).length) persistOutboxTracker(ctx.store, state);
  syncOutboxCounts(state);
}

/** Enqueue an outbox row and persist its `pending` state. */
export function enqueueOutboxTracked(ctx: RuntimeContext, input: EnqueueOutboxInput): OutboxRecord {
  const state = getIntegrations(ctx);
  const rec = ctx.store.outbox.enqueue(input);
  state.outboxTracker.set(rec.id, { channel_id: rec.channel_id, state: "pending" });
  syncOutboxCounts(state);
  ctx.store.settings.set(OUTBOX_TRACKER_SETTING_KEY, Object.fromEntries([...state.outboxTracker].sort()));
  state.outboxWake?.();
  return rec;
}

/** `pending`/`failed` are tracked; `sent`/`dropped` remove the entry. */
export function updateOutboxTrackedState(ctx: RuntimeContext, outboxId: string, channelId: string, newState: string): void {
  const state = getIntegrations(ctx);
  if (newState === "pending" || newState === "failed") state.outboxTracker.set(outboxId, { channel_id: channelId, state: newState });
  else state.outboxTracker.delete(outboxId);
  syncOutboxCounts(state);
  persistOutboxTracker(ctx.store, state);
}

export function removeChannelFromOutboxTracker(ctx: RuntimeContext, channelId: string): void {
  const state = getIntegrations(ctx);
  for (const [id, entry] of [...state.outboxTracker]) if (entry.channel_id === channelId) state.outboxTracker.delete(id);
  syncOutboxCounts(state);
  persistOutboxTracker(ctx.store, state);
}

export function clearOutboxTrackerInMemory(ctx: RuntimeContext): void {
  const state = getIntegrations(ctx);
  state.outboxTracker.clear();
  state.outboxPending = 0;
  state.outboxFailed = 0;
}

// ---- health -------------------------------------------------------------------------------------

export function telegramChatId(config: unknown): number | null {
  if (!isObject(config)) return null;
  const v = config.chat_id;
  if (typeof v === "string") {
    return /^[+-]?\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
  }
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/** Full health snapshot (`CoreRuntime::compute_health_status`). */
export async function computeHealthStatus(ctx: RuntimeContext, now: number): Promise<HealthStatus> {
  const state = getIntegrations(ctx);
  const store = ctx.store;
  const settings = loadSettings(store);
  const ipc = state.hooks.ipcSnapshot?.(ctx) ?? DISCONNECTED_IPC;

  const runs = store.sources.listCrawlRuns(null, 500);
  const oneHourAgo = now - 3_600_000;
  const dayStart = startOfLocalDayMs(now);
  let pageLoadsLastHour = 0;
  let pageLoadsToday = 0;
  for (const r of runs) {
    if (r.started_at >= oneHourAgo) pageLoadsLastHour += r.page_loads;
    if (r.started_at >= dayStart) pageLoadsToday += r.page_loads;
  }

  const pendingAiPosts = store.leads
    .listPendingAiBatches()
    .filter((g) => !g.is_preview)
    .reduce((sum, g) => sum + g.count, 0);

  const todayAiItems = store.aiCalls.countItemsToday(now);
  const ai = state.aiHealth;
  if (ai.rateLimitResetAt !== null && ai.rateLimitResetAt <= now) ai.rateLimitResetAt = null;
  let aiState: AiHealthState;
  if (settings.ai_provider === null && state.bridge.providerId() !== "mock") aiState = "not_configured";
  else if (ai.rateLimitResetAt !== null) aiState = "rate_limited";
  else if (todayAiItems >= settings.daily_ai_post_cap) aiState = "daily_cap_reached";
  else if (ai.lastError !== null) aiState = "error";
  else aiState = "ok";
  const aiProvider: AiProviderId | null =
    settings.ai_provider ?? (state.bridge.providerId() === "mock" ? "claude_cli" : null);

  const channels = store.channels.list();
  const tgChannels = channels.filter((c) => c.kind === "telegram");
  let hasBotToken = false;
  try {
    hasBotToken = (await ctx.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY)) !== null;
  } catch {
    hasBotToken = false;
  }
  let telegramState: TelegramHealthState;
  if (!hasBotToken && tgChannels.length === 0) telegramState = "not_configured";
  else if (tgChannels.some((c) => c.state === "error")) telegramState = "error";
  else if (tgChannels.length > 0) telegramState = "ok";
  else telegramState = "not_configured";

  const floodRadars: HealthStatus["flood_radars"] = [];
  for (const item of store.radars.list(false, now)) {
    if (item.radar.status !== "active") continue;
    const lastHr = store.leads.countLeadsInLastHour(item.radar.id, now);
    if (lastHr > FLOOD_LEADS_PER_HOUR_THRESHOLD) {
      floodRadars.push({ radar_id: item.radar.id, radar_name: item.radar.name, leads_last_hour: lastHr });
    }
  }

  const lastCrawlEnds = runs
    .filter((r) => r.status === "ok" || r.status === "empty")
    .map((r) => r.ended_at)
    .filter((t): t is number => t !== null);

  return {
    automatic_scanning: ipc.automatic_scanning,
    next_crawl_at: ipc.next_crawl_at,
    last_crawl_at: lastCrawlEnds.length > 0 ? Math.max(...lastCrawlEnds) : null,
    runtime_checked_at: ipc.runtime_checked_at,
    extension_connected: ipc.extension_connected,
    extension_version: ipc.extension_version,
    facebook_session: ipc.facebook_session,
    crawl_paused: ipc.crawl_paused,
    crawl_pause_reason: ipc.crawl_pause_reason,
    page_loads_last_hour: pageLoadsLastHour,
    page_loads_today: pageLoadsToday,
    ai_state: aiState,
    ai_provider: aiProvider,
    ai_error: ai.lastError,
    ai_rate_limit_reset_at: ai.rateLimitResetAt,
    pending_ai_posts: pendingAiPosts,
    telegram_state: telegramState,
    telegram_channel_count: tgChannels.length,
    outbox_pending: state.outboxPending,
    outbox_failed: state.outboxFailed,
    flood_radars: floodRadars,
    checked_at: now,
  };
}

/** Emit `health:changed` only when an operational field differs from the last snapshot. */
export async function emitHealthIfChanged(ctx: RuntimeContext, now: number): Promise<HealthStatus> {
  const state = getIntegrations(ctx);
  if (state.hooks.emitHealthIfChanged) return state.hooks.emitHealthIfChanged(now);
  const current = await computeHealthStatus(ctx, now);
  const prev = state.lastEmittedHealth;
  const changed = prev === null || JSON.stringify({ ...prev, checked_at: current.checked_at }) !== JSON.stringify(current);
  if (changed) {
    state.lastEmittedHealth = current;
    ctx.emit("health:changed", current);
  }
  return current;
}

// ---- system incident alerts ----------------------------------------------------------------------

/**
 * Queue a deduplicated Telegram system alert (or recovery notice) on every healthy channel.
 * Returns the number of outbox rows created.
 */
export function queueSystemIncidentAlert(
  ctx: RuntimeContext,
  incident: SystemIncidentKind,
  resolved: boolean,
  now: number,
): number {
  const paused = ctx.store.settings.get<boolean>("telegram.notifications_paused") ?? false;
  if (paused && !resolved) return 0;
  const html = formatSystemAlertHtml(incident, resolved);
  let queued = 0;
  for (const ch of ctx.store.channels.list()) {
    if (ch.kind !== "telegram" || ch.state !== "ok") continue;
    const chatId = telegramChatId(ch.config);
    if (chatId === null) continue;
    enqueueOutboxTracked(ctx, {
      channel_id: ch.id,
      lead_id: null,
      kind: "system",
      payload: sendMessageHtml(chatId, html, null),
      next_try_at: now,
      now_ms: now,
    });
    queued += 1;
  }
  return queued;
}

/** Secrets helper that never throws (`.ok().flatten()`). */
export async function tryGetSecret(secrets: SecretStore, key: string): Promise<string | null> {
  try {
    return await secrets.getSecret(key);
  } catch {
    return null;
  }
}
