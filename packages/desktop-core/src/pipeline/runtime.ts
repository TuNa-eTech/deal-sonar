// Port of crates/core/src/state.rs (`CoreRuntime`, `IpcHub`, health snapshot, settings helpers),
// scoped to what the pipeline, scheduler, jobs and the 10 assigned commands need. The OS credential
// store, outbox tracker and notification delivery stay with the notification worker; this runtime
// only reads their persisted state (`runtime.outbox_tracker`, channels, secrets).

import { TELEGRAM_BOT_TOKEN_KEY } from "../secrets/types";
import type { Store } from "../store/store";
import type { CrawlRunRecord, SourceRecord } from "../store/sources";
import { newUlid } from "../store/util";
import type { RuntimeContext } from "../backend/runtime";
import { buildCrawlPolicy, computeCrawlPlan, defaultExtractorProfile } from "./scheduler";
import {
  PERSONAL_LIMITS,
  type AiHealthState,
  type AppSettings,
  type CrawlPauseReason,
  type CrawlPolicySettings,
  type CrawlRunDto,
  type FacebookSessionState,
  type HealthStatus,
  type LicenseLimits,
  type PipelineConfig,
  type PipelineHooks,
  type SystemIncident,
  type TelegramHealthState,
} from "./types";

/** Notification crate constant `FLOOD_LEADS_PER_HOUR_THRESHOLD`. */
export const FLOOD_LEADS_PER_HOUR_THRESHOLD = 30;
export const SETTINGS_KEY = "app.settings";
export const OUTBOX_TRACKER_SETTING_KEY = "runtime.outbox_tracker";
export const PROTOCOL_VERSION = 2;
export const PLATFORM_FACEBOOK = "facebook";
export const SOURCE_KIND_GROUP = "group";

/** Protocol v2 envelope (`{"v","id","ts","reply_to","type","payload"}`). */
export interface ProtocolEnvelope {
  v: number;
  id: string;
  ts: number;
  reply_to: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export function makeEnvelope(type: string, payload: Record<string, unknown>, replyTo: string | null = null, now = Date.now()): ProtocolEnvelope {
  return { v: PROTOCOL_VERSION, id: newUlid(now), ts: now, reply_to: replyTo, type, payload };
}

export interface CrawlRuntimeStatus {
  paused: boolean;
  automatic_scanning: boolean;
  next_crawl_at?: number | null;
  [extra: string]: unknown;
}

export interface ConnectedProfile {
  connId: number;
  profileId: string;
  extVersion: string;
  browser: string;
  connectedAt: number;
  crawlRuntime: [number, CrawlRuntimeStatus] | null;
  send: (envelope: ProtocolEnvelope) => void;
}

/** Bounded FIFO of processed message ids (`MessageDedupCache`). */
export class MessageDedupCache {
  private readonly capacity: number;
  private readonly order: string[] = [];
  private readonly entries = new Map<string, [number, number]>();
  constructor(capacity: number) {
    this.capacity = Math.max(capacity, 64);
  }
  get(msgId: string): [number, number] | undefined {
    return this.entries.get(msgId);
  }
  insert(msgId: string, ack: [number, number]): void {
    if (this.entries.has(msgId)) {
      this.entries.set(msgId, ack);
      return;
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.order.push(msgId);
    this.entries.set(msgId, ack);
  }
}

export interface AiRuntimeHealth {
  lastError: string | null;
  rateLimitResetAt: number | null;
  firstUnavailableAt: number | null;
  dailyCapReachedDate: string | null;
}

export interface IncidentTracker {
  fbSessionAlerted: boolean;
  extDisconnectedAlerted: boolean;
  aiUnavailableAlerted: boolean;
  extractorBrokenAlerted: boolean;
  floodAlertedRadars: Set<string>;
}

export interface JobFailedPayload {
  job_id: string;
  kind: string;
  error: string;
  failed_at: number;
}

export function defaultSettings(): AppSettings {
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

/** Start of the local calendar day in Unix ms. */
export function startOfLocalDayMs(tsMs: number): number {
  const d = new Date(tsMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function crawlRunToDto(r: CrawlRunRecord): CrawlRunDto {
  return {
    id: r.id,
    source_id: r.source_id,
    source_name: r.source_name ?? "",
    reason: r.reason,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    posts_seen: r.posts_seen,
    posts_new: r.posts_new,
    page_loads: r.page_loads,
    strategy: r.strategy,
    error: r.error,
  };
}

export class PipelineShutdownError extends Error {
  constructor() {
    super("hệ thống đang tắt");
    this.name = "PipelineShutdownError";
  }
}

/** Shared runtime state of the pipeline (Rust `CoreRuntime` subset). */
export class PipelineRuntime {
  readonly store: Store;
  readonly config: PipelineConfig;
  hooks: PipelineHooks;
  readonly startedAtMs: number;

  // IpcHub
  readonly peers = new Map<number, ConnectedProfile>();
  private nextConnId = 1;
  lastDisconnectedAt: number | null = null;
  facebookSession: FacebookSessionState = "ok";
  crawlPaused = false;
  crawlPauseReason: CrawlPauseReason | null = null;
  configRev = 1;
  consecutiveEmptySources: string[] = [];
  extractorBroken = false;
  readonly dedup = new MessageDedupCache(4_096);

  readonly aiHealth: AiRuntimeHealth = { lastError: null, rateLimitResetAt: null, firstUnavailableAt: null, dailyCapReachedDate: null };
  readonly incidents: IncidentTracker = {
    fbSessionAlerted: false,
    extDisconnectedAlerted: false,
    aiUnavailableAlerted: false,
    extractorBrokenAlerted: false,
    floodAlertedRadars: new Set<string>(),
  };

  readonly previews = new Map<string, import("./types").PreviewRunState>();
  readonly latestPreviewByRadar = new Map<string, string>();
  readonly previewCancellations = new Map<string, AbortController>();
  lastEmittedHealth: HealthStatus | null = null;

  shuttingDown = false;
  readonly shutdown = new AbortController();
  inflightAiCalls = 0;
  private inflightWaiters: Array<() => void> = [];
  private jobWakers: Array<() => void> = [];

  constructor(
    private readonly ctx: RuntimeContext,
    config: PipelineConfig,
    hooks: PipelineHooks,
  ) {
    this.store = ctx.store;
    this.config = config;
    this.hooks = hooks;
    this.startedAtMs = this.now();
  }

  now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }

  get secrets(): RuntimeContext["secrets"] {
    return this.ctx.secrets;
  }

  /** Emit a UI push event (`lead:new`, `preview:progress`, `health:changed`, ...). */
  emit(event: string, payload: unknown): void {
    if (this.shuttingDown && event !== "job:failed") return;
    this.ctx.emit(event, payload);
  }

  notifyOs(payload: Parameters<RuntimeContext["notifyOs"]>[0]): void {
    this.ctx.notifyOs(payload);
  }

  // ---- settings ------------------------------------------------------------------------------

  loadSettings(): AppSettings {
    const saved = this.store.settings.get<Partial<AppSettings>>(SETTINGS_KEY);
    const base = defaultSettings();
    if (!saved) return base;
    const cp: Partial<CrawlPolicySettings> = saved.crawl_policy ?? {};
    return {
      ...base,
      ...saved,
      model_tiers: { ...base.model_tiers, ...(saved.model_tiers ?? {}) },
      quiet_hours: { ...base.quiet_hours, ...(saved.quiet_hours ?? {}) },
      crawl_policy: {
        ...base.crawl_policy,
        ...cp,
        active_hours: { ...base.crawl_policy.active_hours, ...(cp.active_hours ?? {}) },
      },
    };
  }

  licenseLimits(now: number): LicenseLimits {
    return this.hooks.license ? this.hooks.license.limits(now) : PERSONAL_LIMITS;
  }

  // ---- jobs ----------------------------------------------------------------------------------

  /** Resolved by the jobs loop to run immediately instead of waiting for the next poll. */
  onJobWake(waker: () => void): () => void {
    this.jobWakers.push(waker);
    return () => {
      this.jobWakers = this.jobWakers.filter((w) => w !== waker);
    };
  }
  wakeJobs(): void {
    for (const w of [...this.jobWakers]) w();
  }

  enqueueAndWakeJob(kind: string, dedupKey: string | null, payload: unknown, runAt: number): [import("../store/ops").JobRecord, boolean] {
    const now = this.now();
    const res = this.store.jobs.enqueue(kind, dedupKey, payload, runAt, now);
    if (runAt <= now) this.wakeJobs();
    return res;
  }

  // ---- background task tracking -----------------------------------------------------------------

  private readonly background = new Set<Promise<unknown>>();

  /** Track a fire-and-forget task (notification routing, health emit) so shutdown/tests can drain it. */
  spawn(task: Promise<unknown>, label: string): void {
    const tracked = task.catch((err: unknown) => {
      this.log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /** Resolve once every tracked background task has settled. */
  async drainBackground(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  log(message: string): void {
    this.hooks.log?.(message);
  }

  // ---- inflight AI accounting ------------------------------------------------------------------

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

  /** Wait for in-flight AI calls to finish (graceful shutdown), at most `timeoutMs`. */
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

  // ---- IpcHub --------------------------------------------------------------------------------

  allocConnId(): number {
    return this.nextConnId++;
  }
  isAnyConnected(): boolean {
    return this.peers.size > 0;
  }

  /** Push to one profile (or broadcast when `profileId` is null). Returns the accepting stream count. */
  sendToProfile(profileId: string | null, envelope: ProtocolEnvelope): number {
    let sent = 0;
    for (const conn of [...this.peers.values()]) {
      if (profileId === null || conn.profileId === profileId) {
        try {
          conn.send(envelope);
          sent += 1;
        } catch {
          // A dead stream is cleaned up by its owner through `detachPeer`.
        }
      }
    }
    return sent;
  }

  /** Recompute plan + policy + extractor profile, bump `config_rev`, push `config.update` to every profile. */
  bumpAndPushConfig(): number {
    const settings = this.loadSettings();
    const activeSources = this.store.sources.listForActiveRadars();
    this.configRev += 1;
    const rev = this.configRev;
    const policy = buildCrawlPolicy(settings.crawl_policy);
    const extractor = defaultExtractorProfile(1);
    for (const conn of [...this.peers.values()]) {
      const plan = computeCrawlPlan(activeSources, settings.crawl_policy, conn.profileId);
      try {
        conn.send(makeEnvelope("config.update", { rev, plan, policy, extractor }, null, this.now()));
      } catch {
        // see sendToProfile
      }
    }
    return rev;
  }

  buildConfigUpdateForProfile(profileId: string): [number, ProtocolEnvelope] {
    const settings = this.loadSettings();
    const activeSources = this.store.sources.listForActiveRadars();
    const rev = this.configRev;
    const plan = computeCrawlPlan(activeSources, settings.crawl_policy, profileId);
    const policy = buildCrawlPolicy(settings.crawl_policy);
    const extractor = defaultExtractorProfile(1);
    return [rev, makeEnvelope("config.update", { rev, plan, policy, extractor }, null, this.now())];
  }

  // ---- persisted runtime flags -----------------------------------------------------------------

  setSourceLastError(sourceId: string, error: string | null): void {
    const map = this.store.settings.get<Record<string, string>>("runtime.source_last_errors") ?? {};
    const trimmed = error?.trim() ?? "";
    if (trimmed.length > 0) map[sourceId] = trimmed;
    else delete map[sourceId];
    this.store.settings.set("runtime.source_last_errors", sortRecord(map));
  }
  getSourceLastErrors(): Record<string, string> {
    return this.store.settings.get<Record<string, string>>("runtime.source_last_errors") ?? {};
  }

  markRadarFloodAutoDigest(radarId: string, active: boolean): void {
    const set = new Set(this.store.settings.get<string[]>("runtime.flood_auto_digest_radars") ?? []);
    if (active) set.add(radarId);
    else set.delete(radarId);
    this.store.settings.set("runtime.flood_auto_digest_radars", [...set].sort());
  }
  getFloodAutoDigestRadars(): Set<string> {
    return new Set(this.store.settings.get<string[]>("runtime.flood_auto_digest_radars") ?? []);
  }

  getEvalFeedbackLabels(): Record<string, string> {
    return this.store.settings.get<Record<string, string>>("runtime.feedback_by_eval") ?? {};
  }

  /** Queue the digest-pending lead and its `flush_digest` job (Rust `enqueue_digest_lead`). */
  enqueueDigestLead(radarId: string, leadId: string, now: number): void {
    const key = `runtime.digest_pending.${radarId}`;
    const pending = this.store.settings.get<string[]>(key) ?? [];
    if (!pending.includes(leadId)) {
      pending.push(leadId);
      this.store.settings.set(key, pending);
    }
    const settings = this.loadSettings();
    const delayMs = Math.max(settings.digest_interval_minutes, 1) * 60_000;
    this.store.jobs.enqueue("flush_digest", `flush_digest:${radarId}`, { radar_id: radarId }, now + delayMs, now);
  }

  queueSystemIncident(incident: SystemIncident, resolved: boolean, now: number): void {
    const hook = this.hooks.notify?.queueSystemIncident;
    if (!hook) return;
    try {
      const out = hook.call(this.hooks.notify, incident, resolved, now);
      if (out instanceof Promise) out.catch(() => undefined);
    } catch {
      // Incident alerts are best-effort (Rust `let _ =`).
    }
  }

  // ---- health --------------------------------------------------------------------------------

  private outboxCounts(): [number, number] {
    const map = this.store.settings.get<Record<string, { channel_id: string; state: string }>>(OUTBOX_TRACKER_SETTING_KEY) ?? {};
    let pending = 0;
    let failed = 0;
    for (const e of Object.values(map)) {
      if (e.state === "pending") pending += 1;
      else if (e.state === "failed") failed += 1;
    }
    return [pending, failed];
  }

  private tokenPresence: { at: number; present: boolean } | null = null;

  /** Bot-token presence, re-read from the OS credential store at most once per 30 s. */
  async telegramTokenPresent(now: number): Promise<boolean> {
    if (this.tokenPresence && now - this.tokenPresence.at < 30_000) return this.tokenPresence.present;
    let present = false;
    try {
      present = (await this.ctx.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY)) !== null;
    } catch {
      present = false;
    }
    this.tokenPresence = { at: now, present };
    return present;
  }

  /** Forget the cached bot-token presence (call after `telegram_set_token`). */
  invalidateTelegramTokenCache(): void {
    this.tokenPresence = null;
  }

  ipcSnapshot(now: number) {
    const conns = [...this.peers.values()];
    const extConnected = conns.length > 0;
    const extVersion = conns.length > 0 ? conns.reduce((a, b) => (b.connectedAt >= a.connectedAt ? b : a)).extVersion : null;

    const reports = conns.map((c) => c.crawlRuntime).filter((r): r is [number, CrawlRuntimeStatus] => r !== null && now - r[0] < 90_000);
    const complete = conns.length > 0 && reports.length === conns.length;
    const automaticScanning = complete ? reports.some(([, s]) => s.automatic_scanning === true) : null;
    const extensionPaused = reports.some(([, s]) => s.paused === true);
    const nextCrawls = reports.map(([, s]) => s.next_crawl_at).filter((n): n is number => typeof n === "number");
    const nextCrawlAt = nextCrawls.length > 0 ? Math.min(...nextCrawls) : null;
    const runtimeCheckedAt = reports.length > 0 ? Math.min(...reports.map(([at]) => at)) : null;
    const crawlPaused = this.crawlPaused || extensionPaused;

    return {
      extension_connected: extConnected,
      extension_version: extVersion,
      facebook_session: this.facebookSession,
      crawl_paused: crawlPaused,
      crawl_pause_reason: this.crawlPauseReason,
      automatic_scanning: automaticScanning,
      next_crawl_at: nextCrawlAt,
      runtime_checked_at: runtimeCheckedAt,
    };
  }

  async computeHealthStatus(now: number): Promise<HealthStatus> {
    const hasBotToken = await this.telegramTokenPresent(now);
    const settings = this.loadSettings();
    const ipc = this.ipcSnapshot(now);
    const runs = this.store.sources.listCrawlRuns(null, 500);
    const oneHourAgo = now - 3_600_000;
    const dayStart = startOfLocalDayMs(now);
    let pageLoadsLastHour = 0;
    let pageLoadsToday = 0;
    for (const r of runs) {
      if (r.started_at >= oneHourAgo) pageLoadsLastHour += r.page_loads;
      if (r.started_at >= dayStart) pageLoadsToday += r.page_loads;
    }

    const pendingAiPosts = this.store.leads
      .listPendingAiBatches()
      .filter((g) => !g.is_preview)
      .reduce((n, g) => n + g.count, 0);

    const todayAiItems = this.store.aiCalls.countItemsToday(now);
    if (this.aiHealth.rateLimitResetAt !== null && this.aiHealth.rateLimitResetAt <= now) this.aiHealth.rateLimitResetAt = null;
    const providerId = this.hooks.ai?.providerId() ?? null;
    let aiState: AiHealthState;
    if (settings.ai_provider === null && providerId !== "mock") aiState = "not_configured";
    else if (this.aiHealth.rateLimitResetAt !== null) aiState = "rate_limited";
    else if (todayAiItems >= settings.daily_ai_post_cap) aiState = "daily_cap_reached";
    else if (this.aiHealth.lastError !== null) aiState = "error";
    else aiState = "ok";
    const aiProvider = settings.ai_provider ?? (providerId === "mock" ? "claude_cli" : null);

    const channels = this.store.channels.list();
    const tgChannels = channels.filter((c) => c.kind === "telegram");
    let telegramState: TelegramHealthState;
    if (!hasBotToken && tgChannels.length === 0) telegramState = "not_configured";
    else if (tgChannels.some((c) => c.state === "error")) telegramState = "error";
    else if (tgChannels.length > 0) telegramState = "ok";
    else telegramState = "not_configured";

    const [outboxPending, outboxFailed] = this.outboxCounts();

    const floodRadars: HealthStatus["flood_radars"] = [];
    for (const item of this.store.radars.list(false, now)) {
      if (item.radar.status === "active") {
        const lastHr = this.store.leads.countLeadsInLastHour(item.radar.id, now);
        if (lastHr > FLOOD_LEADS_PER_HOUR_THRESHOLD) {
          floodRadars.push({ radar_id: item.radar.id, radar_name: item.radar.name, leads_last_hour: lastHr });
        }
      }
    }

    const finished = runs.filter((r) => (r.status === "ok" || r.status === "empty") && r.ended_at !== null).map((r) => r.ended_at as number);
    return {
      automatic_scanning: ipc.automatic_scanning,
      next_crawl_at: ipc.next_crawl_at,
      last_crawl_at: finished.length > 0 ? Math.max(...finished) : null,
      runtime_checked_at: ipc.runtime_checked_at,
      extension_connected: ipc.extension_connected,
      extension_version: ipc.extension_version,
      facebook_session: ipc.facebook_session,
      crawl_paused: ipc.crawl_paused,
      crawl_pause_reason: this.crawlPauseReason,
      page_loads_last_hour: pageLoadsLastHour,
      page_loads_today: pageLoadsToday,
      ai_state: aiState,
      ai_provider: aiProvider,
      ai_error: this.aiHealth.lastError,
      ai_rate_limit_reset_at: this.aiHealth.rateLimitResetAt,
      pending_ai_posts: pendingAiPosts,
      telegram_state: telegramState,
      telegram_channel_count: tgChannels.length,
      outbox_pending: outboxPending,
      outbox_failed: outboxFailed,
      flood_radars: floodRadars,
      checked_at: now,
    };
  }

  /** Emit `health:changed` only when an operational field differs from the last emitted snapshot. */
  async emitHealthIfChanged(now: number): Promise<HealthStatus> {
    const current = await this.computeHealthStatus(now);
    const prev = this.lastEmittedHealth;
    const changed = prev === null || JSON.stringify({ ...prev, checked_at: current.checked_at }) !== JSON.stringify(current);
    if (changed) {
      this.lastEmittedHealth = current;
      this.emit("health:changed", current);
    }
    return current;
  }

  /** Fire-and-forget variant for synchronous call sites (errors are swallowed like Rust `let _ =`). */
  emitHealthSoon(now: number = this.now()): void {
    this.emitHealthIfChanged(now).catch(() => undefined);
  }

  /** Release listeners and mark shutdown. Pending previews are aborted. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.shutdown.abort();
    for (const c of this.previewCancellations.values()) c.abort();
    this.wakeJobs();
  }
}

function sortRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
}

export type { SourceRecord };
