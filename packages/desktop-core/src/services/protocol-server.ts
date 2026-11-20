// Protocol v2 business logic for Chrome extension connections: a port of
// `crates/core/src/ipc_server.rs` (`handle_extension_connection`, `handle_body`,
// `ensure_source_exists`, `upsert_sources_respecting_plan`, `handle_session_status`,
// `push_crawl_request`) plus the pause/resume half of `service/chrome.rs`.
//
// Transport is not handled here: the native-host package frames the socket, classifies the first
// frame (agent vs extension) and hands a `HostExtensionConnection` to `ProtocolService.handleConnection`
// (wired into `DesktopRuntimeDeps.onExtensionConnection`). Everything pipeline-shaped is injected
// through `ProtocolPipelineHooks` so this module composes with the catalog/pipeline/health ports
// without importing them.

import type { RuntimeContext } from "../backend/runtime";
import type { HostExtensionConnection } from "../backend/host";
import { CoreError, toWireError } from "../backend/wire";
import type { CrawlRunRecord, DiscoveredSourceInput, SourceRecord } from "../store/sources";
import { EnvelopeParseError, errorEnvelope, newEnvelope, parseEnvelope, replyEnvelope } from "./protocol-envelope";
import { type ConnectedProfile, ProtocolHub } from "./protocol-hub";
import {
  type CrawlPauseReason,
  type CrawlPlan,
  type CrawlPolicy,
  type CrawlReason,
  type Envelope,
  type ExtractorProfile,
  type FacebookSessionState,
  type RawPost,
  type SessionState,
  type SourceInfo,
  type SourceRef,
  isExtensionToDesktop,
} from "./protocol-types";

/** Services this module needs from the backend runtime context. */
export type ProtocolContext = Pick<RuntimeContext, "store" | "emit" | "isShuttingDown">;

export type SystemIncidentKind = "extension_disconnected" | "extractor_broken" | "facebook_session_issue";

export interface IngestOutcome {
  /** True when a new post row was inserted; false for a duplicate. */
  inserted: boolean;
}

/** Plan, policy and extractor profile for one `config.update` (the revision is owned by the hub). */
export interface ConfigBody {
  plan: CrawlPlan;
  policy: CrawlPolicy;
  extractor: ExtractorProfile;
}

/** Ingested posts: `pipeline::ingest_raw_post` (T0-T4). */
export interface PostIngestHook {
  ingestRawPost(source: SourceRecord, post: RawPost, now: number): IngestOutcome | Promise<IngestOutcome>;
}

/** Config sync: compute the crawl plan for a Chrome profile (`compute_crawl_plan` + policy + extractor). */
export interface ConfigSyncHook {
  buildConfig(profileId: string | null): ConfigBody;
}

export interface CrawlFinishedEvent {
  run: CrawlRunRecord;
  source: SourceRecord;
  reason: CrawlReason;
  /** Extension `run_id` (equals `run.id`). */
  runId: string;
}

export interface SourcesDiscoveredEvent {
  sources: SourceInfo[];
  follow: boolean | null;
  /** Inserted + updated rows. */
  total: number;
  profileId: string | null;
}

/** Sources/crawl completion plus the plan-limit and health/alert side effects of `ipc_server.rs`. */
export interface SourcesCrawlHook {
  /** `limits.max_followed_groups` of the current license (caps `follow: true`). */
  maxFollowedGroups(now: number): number;
  /** `rt.emit_health_if_changed(now)`; the result is returned to callers that need the snapshot. */
  emitHealthIfChanged(now: number): unknown;
  /** `rt.queue_system_incident_alert`; failures are ignored like the Rust `let _ =`. */
  queueSystemIncidentAlert?(kind: SystemIncidentKind, resolved: boolean, now: number): void;
  /** Called after a crawl run is recorded and `crawl:finished` was emitted (preview waiters). */
  onCrawlFinished?(event: CrawlFinishedEvent): void;
  /** Called after sources were upserted from `sources.discovered`. */
  onSourcesDiscovered?(event: SourcesDiscoveredEvent): void;
}

export type ProtocolPipelineHooks = PostIngestHook & ConfigSyncHook & SourcesCrawlHook;

export interface ProtocolServiceOptions {
  hooks: ProtocolPipelineHooks;
  /** Reported in `hello.ok` (`CARGO_PKG_VERSION` in Rust). */
  desktopVersion: string;
  hub?: ProtocolHub;
  now?: () => number;
  logger?: (message: string) => void;
}

/** Frames queued per connection before reads are paused (backpressure). */
const MAX_PENDING_FRAMES = 16;

const PAUSE_REASON: Record<CrawlPauseReason, string> = {
  manual: "manual",
  checkpoint_awaiting_resume: "checkpoint_awaiting_resume",
  rate_limited: "rate_limited",
  logged_out: "logged_out",
};

/** `ensure_source_exists`: look the source up or create the placeholder the extension pushed to. */
export function ensureSourceExists(
  ctx: Pick<ProtocolContext, "store">,
  ref: SourceRef,
  profileId: string | null,
  now: number,
): SourceRecord {
  const { sources } = ctx.store;
  const existing = sources.getByExternalId(ref.platform, ref.external_id);
  if (existing) return existing;
  const placeholder: DiscoveredSourceInput = {
    platform: ref.platform,
    kind: ref.kind,
    external_id: ref.external_id,
    name: `Group ${ref.external_id}`,
    url: `https://www.facebook.com/groups/${ref.external_id}`,
    privacy: null,
    member_count: null,
  };
  sources.upsertDiscovered([placeholder], null, profileId, now);
  const created = sources.getByExternalId(ref.platform, ref.external_id);
  if (!created) throw CoreError.internal(`failed to create placeholder source for ${ref.external_id}`);
  return created;
}

const SOURCE_LAST_ERRORS_KEY = "runtime.source_last_errors";

/** `set_source_last_error`: persists `{source_id: message}` (keys sorted like a Rust `BTreeMap`). */
export function setSourceLastError(
  ctx: Pick<ProtocolContext, "store">,
  sourceId: string,
  error: string | null,
): void {
  const map = { ...(ctx.store.settings.get<Record<string, string>>(SOURCE_LAST_ERRORS_KEY) ?? {}) };
  const trimmed = error === null ? "" : error.trim();
  if (trimmed !== "") map[sourceId] = trimmed;
  else delete map[sourceId];
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
  ctx.store.settings.set(SOURCE_LAST_ERRORS_KEY, sorted);
}

export function getSourceLastErrors(ctx: Pick<ProtocolContext, "store">): Record<string, string> {
  return ctx.store.settings.get<Record<string, string>>(SOURCE_LAST_ERRORS_KEY) ?? {};
}

/** `CoreRuntime::crawl_run_to_dto`. */
export function crawlRunToDto(run: CrawlRunRecord) {
  return {
    id: run.id,
    source_id: run.source_id,
    source_name: run.source_name ?? "",
    reason: run.reason,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    posts_seen: run.posts_seen,
    posts_new: run.posts_new,
    page_loads: run.page_loads,
    strategy: run.strategy,
    error: run.error,
  };
}

const toDiscoveredInput = (s: SourceInfo): DiscoveredSourceInput => ({
  platform: s.platform,
  kind: s.kind,
  external_id: s.external_id,
  name: s.name,
  url: s.url,
  privacy: s.privacy ?? null,
  member_count: s.member_count ?? null,
});

/** Error envelope fields for a handler failure (`CoreError::Validation` -> `invalid_payload`, ...). */
function handlerErrorEnvelope(replyTo: string, err: unknown): Envelope {
  const kind = err instanceof CoreError ? err.kind : null;
  const [code, retryable] =
    kind === "validation"
      ? (["invalid_payload", false] as const)
      : kind === "shutting_down"
        ? (["busy", true] as const)
        : (["internal", true] as const);
  return errorEnvelope(replyTo, code, toWireError(err).message, retryable);
}

/** Owns the hub and all protocol behaviour; construct once per backend and share it. */
export class ProtocolService {
  readonly hub: ProtocolHub;
  readonly hooks: ProtocolPipelineHooks;
  readonly desktopVersion: string;
  private readonly nowFn: () => number;
  private readonly logger: (message: string) => void;

  constructor(options: ProtocolServiceOptions) {
    this.hub = options.hub ?? new ProtocolHub();
    this.hooks = options.hooks;
    this.desktopVersion = options.desktopVersion;
    this.nowFn = options.now ?? Date.now;
    this.logger = options.logger ?? (() => undefined);
  }

  now(): number {
    return this.nowFn();
  }

  log(message: string): void {
    this.logger(message);
  }

  /** `DesktopRuntimeDeps.onExtensionConnection`. The returned session is for tests/diagnostics. */
  handleConnection = (ctx: ProtocolContext, connection: HostExtensionConnection): ProtocolSession =>
    new ProtocolSession(this, ctx, connection);

  // ── outbound helpers (desktop -> extension) ───────────────────────────────────────────────

  /** `config.update` for one profile at the current `config_rev`. */
  buildConfigUpdate(profileId: string | null): Envelope {
    const body = this.hooks.buildConfig(profileId);
    return newEnvelope({ type: "config.update", payload: { rev: this.hub.configRev, ...body } }, this.now());
  }

  /** `bump_and_push_config`: increment `config_rev` and push a per-profile plan to every connection. */
  bumpAndPushConfig(): number {
    this.hub.configRev += 1;
    const rev = this.hub.configRev;
    for (const conn of [...this.hub.connections.values()]) {
      const body = this.hooks.buildConfig(conn.profileId);
      conn.send(newEnvelope({ type: "config.update", payload: { rev, ...body } }, this.now()));
    }
    return rev;
  }

  /**
   * `push_crawl_request`: on-demand `crawl.request` to the source's pinned profile, falling back
   * to any connected profile when the pinned one is offline. Returns how many connections took it
   * (0 means the extension is offline).
   */
  pushCrawlRequest(source: SourceRecord, reason: CrawlReason, maxPosts: number, requestId: string): number {
    const env = newEnvelope(
      {
        type: "crawl.request",
        payload: {
          request_id: requestId,
          source_ref: { platform: source.platform, kind: source.kind, external_id: source.external_id },
          reason,
          max_posts: maxPosts,
        },
      },
      this.now(),
    );
    const sent = this.hub.sendToProfile(source.profile_id, env);
    if (sent === 0 && source.profile_id !== null) return this.hub.sendToProfile(null, env);
    return sent;
  }

  broadcastPause(reason: string, until: number | null = null): number {
    return this.hub.sendToProfile(null, newEnvelope({ type: "crawl.pause", payload: { until, reason } }, this.now()));
  }

  broadcastResume(): number {
    return this.hub.sendToProfile(null, newEnvelope({ type: "crawl.resume", payload: {} }, this.now()));
  }

  /**
   * `chrome_connect(resume_crawl = true)` step: clear a pause, reset the session to `ok` and
   * tell the extension. Returns whether anything was paused.
   */
  resumeCrawlAfterReconnect(): boolean {
    if (!this.hub.crawlPaused) return false;
    this.hub.crawlPaused = false;
    this.hub.crawlPauseReason = null;
    this.hub.facebookSession = "ok";
    this.broadcastResume();
    return true;
  }

  /**
   * `set_crawl_paused`: manual pause/resume (tray). Resuming is refused while the Facebook
   * session is not `ok`. Returns whether the state changed.
   */
  setCrawlPaused(paused: boolean): boolean {
    const hub = this.hub;
    if (paused) {
      if (hub.crawlPaused) return false;
      hub.crawlPaused = true;
      hub.crawlPauseReason = "manual";
      this.broadcastPause("manual");
      return true;
    }
    if (hub.facebookSession !== "ok") {
      throw CoreError.validation("Không thể tiếp tục quét khi phiên Facebook đang có sự cố");
    }
    if (!hub.crawlPaused) return false;
    hub.crawlPaused = false;
    hub.crawlPauseReason = null;
    this.broadcastResume();
    return true;
  }

  // ── session status (shared with tests) ────────────────────────────────────────────────────

  /** `handle_session_status`. */
  applySessionStatus(state: SessionState, now: number): void {
    const hub = this.hub;
    const { hooks } = this;
    if (state === "ok") {
      const wasCheckpoint =
        hub.facebookSession === "checkpoint" || hub.crawlPauseReason === "checkpoint_awaiting_resume";
      hub.facebookSession = "ok";
      if (wasCheckpoint) {
        // After a checkpoint clears, stay paused until the user explicitly resumes crawling.
        hub.crawlPaused = true;
        hub.crawlPauseReason = "checkpoint_awaiting_resume";
      } else if (hub.crawlPauseReason === "logged_out" || hub.crawlPauseReason === "rate_limited") {
        hub.crawlPaused = false;
        hub.crawlPauseReason = null;
      }
      if (hub.incidents.fbSessionAlerted) {
        hub.incidents.fbSessionAlerted = false;
        this.queueAlert("facebook_session_issue", true, now);
      }
      hooks.emitHealthIfChanged(now);
      return;
    }

    const mapped: Record<Exclude<SessionState, "ok">, [FacebookSessionState, CrawlPauseReason]> = {
      logged_out: ["logged_out", "logged_out"],
      checkpoint: ["checkpoint", "checkpoint_awaiting_resume"],
      rate_limited: ["rate_limited", "rate_limited"],
      unknown: ["logged_out", "logged_out"],
    };
    const [session, pauseReason] = mapped[state];
    hub.facebookSession = session;
    hub.crawlPaused = true;
    hub.crawlPauseReason = pauseReason;

    this.broadcastPause(`facebook_${state}`);

    if (!hub.incidents.fbSessionAlerted) {
      hub.incidents.fbSessionAlerted = true;
      this.queueAlert("facebook_session_issue", false, now);
    }
    hooks.emitHealthIfChanged(now);
  }

  queueAlert(kind: SystemIncidentKind, resolved: boolean, now: number): void {
    try {
      this.hooks.queueSystemIncidentAlert?.(kind, resolved, now);
    } catch (err) {
      this.log(`system incident alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Port of `upsert_sources_respecting_plan`. Returns inserted + updated rows. */
  upsertSourcesRespectingPlan(
    ctx: Pick<ProtocolContext, "store">,
    sources: SourceInfo[],
    follow: boolean | null,
    profileId: string | null,
    now: number,
  ): number {
    if (sources.length === 0) return 0;
    const store = ctx.store.sources;

    if (follow !== true) {
      const res = store.upsertDiscovered(sources.map(toDiscoveredInput), follow, profileId, now);
      return res.inserted + res.updated;
    }

    // `follow: true` is honoured only within the plan's followed-group limit.
    const maxGroups = this.hooks.maxFollowedGroups(now);
    const currentFollowed = Math.max(0, store.countFollowed());
    let remaining = Math.max(0, maxGroups - currentFollowed);
    const allowed: DiscoveredSourceInput[] = [];
    const capped: DiscoveredSourceInput[] = [];
    for (const s of sources) {
      const input = toDiscoveredInput(s);
      const alreadyFollowed = store.getByExternalId(s.platform, s.external_id)?.followed === true;
      if (alreadyFollowed) allowed.push(input);
      else if (remaining > 0) {
        remaining -= 1;
        allowed.push(input);
      } else capped.push(input);
    }
    let total = 0;
    if (allowed.length > 0) {
      const res = store.upsertDiscovered(allowed, true, profileId, now);
      total += res.inserted + res.updated;
    }
    if (capped.length > 0) {
      const res = store.upsertDiscovered(capped, false, profileId, now);
      total += res.inserted + res.updated;
    }
    return total;
  }
}

/** One extension connection: serial frame processing, error mapping and cleanup. */
export class ProtocolSession {
  readonly connId: number;
  private boundProfileId: string | null = null;
  private closed = false;
  private pending = 0;
  private paused = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: ProtocolService,
    private readonly ctx: ProtocolContext,
    private readonly connection: HostExtensionConnection,
  ) {
    this.connId = service.hub.allocConnId();
    connection.onFrame((frame) => this.enqueue(frame));
    connection.onClose(() => this.handleClose());
  }

  /** Resolves when every frame received so far has been processed. */
  idle(): Promise<void> {
    return this.chain;
  }

  private get hub(): ProtocolHub {
    return this.service.hub;
  }

  private send(envelope: Envelope): boolean {
    if (this.closed) return false;
    try {
      this.connection.sendEnvelope(envelope).catch((err: unknown) => {
        this.service.log(`IPC sendEnvelope failed (conn ${this.connId}): ${err instanceof Error ? err.message : String(err)}`);
      });
      return true;
    } catch (err) {
      this.service.log(`IPC sendEnvelope failed (conn ${this.connId}): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private enqueue(frame: Buffer): void {
    if (this.closed) return;
    this.pending += 1;
    if (this.pending >= MAX_PENDING_FRAMES && !this.paused) {
      this.paused = true;
      this.connection.pause();
    }
    this.chain = this.chain.then(async () => {
      try {
        if (!this.closed) await this.processFrame(frame);
      } catch (err) {
        this.service.log(`IPC frame handler failed (conn ${this.connId}): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.pending -= 1;
        if (this.paused && this.pending === 0 && !this.closed) {
          this.paused = false;
          this.connection.resume();
        }
      }
    });
  }

  private async processFrame(bytes: Buffer): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(bytes);
    } catch (err) {
      if (err instanceof EnvelopeParseError) {
        // Structured error reply WITHOUT dropping the stream (`01-protocol.md §4.2`).
        this.send(err.toErrorEnvelope());
        return;
      }
      throw err;
    }

    if (!isExtensionToDesktop(envelope.type)) {
      this.send(
        errorEnvelope(envelope.id, "unknown_type", `unexpected message direction for type '${envelope.type}'`, false),
      );
      return;
    }

    if (envelope.type === "hello") this.boundProfileId = envelope.payload.profile_id;

    try {
      if (this.ctx.isShuttingDown()) throw CoreError.shuttingDown();
      await this.handleBody(envelope.id, envelope);
    } catch (err) {
      this.service.log(`IPC message handler error (conn ${this.connId}): ${toWireError(err).message}`);
      this.send(handlerErrorEnvelope(envelope.id, err));
    }
  }

  private ack(msgId: string, accepted: number, duplicates: number): void {
    this.send(replyEnvelope(msgId, { type: "ack", payload: { accepted, duplicates } }, this.service.now()));
  }

  /** Replay a stored ACK for an already-processed message id. Returns true when replayed. */
  private replayDuplicate(msgId: string): boolean {
    const prior = this.hub.dedup.get(msgId);
    if (!prior) return false;
    this.ack(msgId, prior[0], prior[1]);
    return true;
  }

  private async handleBody(msgId: string, envelope: Envelope): Promise<void> {
    const now = this.service.now();
    const { hooks } = this.service;
    const store = this.ctx.store;
    const hub = this.hub;

    switch (envelope.type) {
      case "hello": {
        const p = envelope.payload;
        const current = hub.configRev;
        const wasPaused = hub.crawlPaused;
        const pauseReason = hub.crawlPauseReason;
        hub.lastDisconnectedAt = null;
        const profile: ConnectedProfile = {
          connId: this.connId,
          profileId: p.profile_id,
          extVersion: p.ext_version,
          browser: p.browser,
          connectedAt: now,
          crawlRuntime: null,
          send: (env) => this.send(env),
        };
        hub.connections.set(this.connId, profile);

        if (hub.incidents.extDisconnectedAlerted) {
          hub.incidents.extDisconnectedAlerted = false;
          this.service.queueAlert("extension_disconnected", true, now);
        }

        this.send(
          replyEnvelope(msgId, { type: "hello.ok", payload: { desktop_version: this.service.desktopVersion, config_rev: current } }, now),
        );

        if (p.config_rev < current) this.send(this.service.buildConfigUpdate(p.profile_id));

        if (wasPaused) {
          this.send(
            newEnvelope({ type: "crawl.pause", payload: { until: null, reason: pauseReason ? PAUSE_REASON[pauseReason] : "paused" } }, now),
          );
        }
        hooks.emitHealthIfChanged(now);
        return;
      }

      case "posts.push": {
        if (this.replayDuplicate(msgId)) return;
        const { source_ref: ref, posts } = envelope.payload;
        const primary = ensureSourceExists(this.ctx, ref, this.boundProfileId, now);
        let accepted = 0;
        let duplicates = 0;
        for (const post of posts) {
          const postSource =
            post.source_external_id === primary.external_id && post.platform === primary.platform
              ? primary
              : ensureSourceExists(
                  this.ctx,
                  { platform: post.platform, kind: ref.kind, external_id: post.source_external_id },
                  this.boundProfileId,
                  now,
                );
          const outcome = await hooks.ingestRawPost(postSource, post, now);
          if (outcome.inserted) accepted += 1;
          else duplicates += 1;
        }
        hub.dedup.insert(msgId, [accepted, duplicates]);
        this.ack(msgId, accepted, duplicates);
        return;
      }

      case "crawl.report": {
        if (this.replayDuplicate(msgId)) return;
        const r = envelope.payload;
        const source = ensureSourceExists(this.ctx, r.source_ref, this.boundProfileId, now);
        const run = store.sources.recordCrawlRun({
          id: r.run_id,
          source_id: source.id,
          reason: r.reason,
          status: r.status,
          started_at: r.started_at,
          ended_at: r.ended_at,
          posts_seen: r.posts_seen,
          posts_new: r.posts_new,
          page_loads: r.page_loads,
          strategy: r.strategy ?? null,
          error: r.error ?? null,
        });

        switch (r.status) {
          case "ok":
          case "empty":
            store.sources.setState(source.id, "ok");
            setSourceLastError(this.ctx, source.id, null);
            break;
          case "blocked":
            store.sources.setState(source.id, "inaccessible");
            setSourceLastError(this.ctx, source.id, r.error ?? "group blocked or inaccessible");
            break;
          case "error":
            store.sources.setState(source.id, "error");
            setSourceLastError(this.ctx, source.id, r.error ?? "crawl failed");
            break;
        }

        this.trackExtractorHealth(r.status, r.posts_seen, source.id, now);

        this.ctx.emit("crawl:finished", crawlRunToDto(run));
        hooks.onCrawlFinished?.({ run, source, reason: r.reason, runId: r.run_id });
        hooks.emitHealthIfChanged(now);

        hub.dedup.insert(msgId, [1, 0]);
        this.ack(msgId, 1, 0);
        return;
      }

      case "sources.discovered": {
        if (this.replayDuplicate(msgId)) return;
        const { sources, follow } = envelope.payload;
        const total = this.service.upsertSourcesRespectingPlan(
          this.ctx,
          sources,
          follow ?? null,
          this.boundProfileId,
          now,
        );
        if (total > 0) hooks.onSourcesDiscovered?.({ sources, follow: follow ?? null, total, profileId: this.boundProfileId });
        if (follow !== undefined && total > 0) this.service.bumpAndPushConfig();
        const accepted = Math.min(total, 4_294_967_295);
        hub.dedup.insert(msgId, [accepted, 0]);
        this.ack(msgId, accepted, 0);
        return;
      }

      case "session.status": {
        const p = envelope.payload;
        if (p.runtime) {
          const conn = hub.connections.get(this.connId);
          if (conn) conn.crawlRuntime = { at: now, status: p.runtime };
        }
        this.service.applySessionStatus(p.state, now);
        this.ack(msgId, 1, 0);
        return;
      }

      case "ping":
        this.send(replyEnvelope(msgId, { type: "pong", payload: {} }, now));
        return;

      default:
        throw CoreError.validation("unsupported message body on IPC server");
    }
  }

  /** 3 consecutive `empty` crawls across distinct sources while the session is `ok` (`02-extension.md §4`). */
  private trackExtractorHealth(status: string, postsSeen: number, sourceId: string, now: number): void {
    const hub = this.hub;
    let brokenNow = false;
    let recovered = false;
    if (status === "empty" && hub.facebookSession === "ok") {
      if (!hub.consecutiveEmptySources.includes(sourceId)) hub.consecutiveEmptySources.push(sourceId);
      if (hub.consecutiveEmptySources.length >= 3) {
        hub.extractorBroken = true;
        brokenNow = true;
      }
    } else if (status === "ok" && postsSeen > 0) {
      hub.consecutiveEmptySources = [];
      if (hub.extractorBroken) {
        hub.extractorBroken = false;
        recovered = true;
      }
    }

    if (brokenNow) {
      if (!hub.incidents.extractorBrokenAlerted) {
        hub.incidents.extractorBrokenAlerted = true;
        this.service.queueAlert("extractor_broken", false, now);
      }
    } else if (recovered && hub.incidents.extractorBrokenAlerted) {
      hub.incidents.extractorBrokenAlerted = false;
      this.service.queueAlert("extractor_broken", true, now);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const hub = this.hub;
    let becameAllDisconnected = false;
    if (hub.connections.delete(this.connId) && hub.connections.size === 0) {
      hub.lastDisconnectedAt = this.service.now();
      becameAllDisconnected = true;
    }
    if (becameAllDisconnected || this.boundProfileId !== null) {
      try {
        this.service.hooks.emitHealthIfChanged(this.service.now());
      } catch (err) {
        this.service.log(`health emit after disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
