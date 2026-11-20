// PipelineService: the Electron-side owner of the Rust `CoreRuntime` pipeline responsibilities
// (post ingest/evaluate, previews, rulesets, crawl scheduling, durable jobs, IPC peer registry).
//
// Composition (coordinator):
//   const pipeline = PipelineService.for(ctx, { hooks });      // memoized per RuntimeContext
//   pipeline.start();                                          // jobs + health + scheduler loops
//   const handlers = { ...DEFAULT_HANDLERS, ...PIPELINE_HANDLERS };   // see ./pipeline-handlers
//   onExtensionConnection = (ctx, conn) => {                   // protocol-handshake worker
//     const peer = PipelineService.for(ctx).attachPeer({ send: (env) => void conn.sendEnvelope(env) },
//                                                      { desktopVersion });
//     conn.onFrame((f) => peer.consume(parse(f)));  conn.onClose(() => peer.detach());
//   };
//   shutdown: await pipeline.stop();
//
// See `../pipeline/types.ts` for the hook signatures (AI bridge, notification routing, license,
// templates).

import { CommandError, CoreError } from "../backend/wire";
import type { RuntimeContext } from "../backend/runtime";
import { DomainShapeError, normalizeFieldDefs, normalizeMatchPolicy } from "../store/domain";
import type { RadarWithVersion, RulesetRecord } from "../store/radars";
import { newUlid } from "../store/util";
import { aiCoreError, recordAiCalls, recordFailedAiCalls, requireAi } from "../pipeline/ai-batch";
import { rulesetRecordToDto, radarToDto, type DtoRulesetBody, type RulesetDto } from "../pipeline/dto";
import { ingestRawPost, runSilentBackfill24h, type IngestPostOutcome, type RawPost } from "../pipeline/ingest";
import { BackgroundWorkers, executeJob, tickJobsOnce } from "../pipeline/jobs";
import { attachPeer, pushCrawlRequest, type PeerOptions, type PipelinePeerHandle, type PipelinePeerTransport } from "../pipeline/peers";
import { cancelRadarPreview, getRadarPreview, startRadarPreview } from "../pipeline/preview";
import { crawlRunToDto, makeEnvelope, PipelineRuntime, PLATFORM_FACEBOOK, SOURCE_KIND_GROUP } from "../pipeline/runtime";
import { runCompileRulesetForVersion, saveUserRuleset } from "../pipeline/rulesets";
import {
  defaultPipelineConfig,
  type CrawlRunDto,
  type HealthStatus,
  type PipelineConfig,
  type PipelineHooks,
  type PreviewRunState,
  type PreviewStartInput,
  type RadarDto,
  type RadarStatus,
  type SuggestFieldsBridgeInput,
  type SuggestFieldsInput,
} from "../pipeline/types";
import type { FieldDef, HardFilter } from "../store/domain";

export interface PipelineServiceOptions {
  hooks?: PipelineHooks;
  config?: Partial<PipelineConfig>;
  /** Reported in `hello.ok` (defaults to `ctx.config.appVersion ?? "0.0.0"`). */
  desktopVersion?: string;
}

export interface SuggestFieldsResultDto {
  suggested_name: string;
  want_intent: "demand" | "supply" | "any";
  fields: FieldDef[];
  hard_filters: HardFilter[];
  clarifying_questions: string[];
  prefilter_hint: { any: string[]; none: string[] } | null;
  suggested_source_ids: string[];
}

export interface SourceCrawlNowResult {
  queued: boolean;
  run_id: string;
}

export interface RulesetCompileResult {
  job_id: string;
  ruleset: RulesetDto | null;
}

const instances = new WeakMap<RuntimeContext, PipelineService>();
const FILTER_OPS = ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"] as const;

export class PipelineService {
  readonly runtime: PipelineRuntime;
  private readonly workers: BackgroundWorkers;
  private readonly peers = new Set<PipelinePeerHandle>();
  private readonly desktopVersion: string;
  private lastRadarNow = 0;
  private stopped = false;

  private constructor(ctx: RuntimeContext, options: PipelineServiceOptions) {
    this.runtime = new PipelineRuntime(ctx, { ...defaultPipelineConfig(), ...options.config }, options.hooks ?? {});
    this.workers = new BackgroundWorkers(this.runtime);
    this.desktopVersion = options.desktopVersion ?? ctx.config.appVersion ?? "0.0.0";
  }

  /** Memoized per `RuntimeContext`; `options` only apply on first creation. */
  static for(ctx: RuntimeContext, options: PipelineServiceOptions = {}): PipelineService {
    let svc = instances.get(ctx);
    if (!svc) {
      svc = new PipelineService(ctx, options);
      instances.set(ctx, svc);
    }
    return svc;
  }

  /** Install/replace hooks (partial merge). */
  configure(hooks: PipelineHooks): void {
    this.runtime.hooks = { ...this.runtime.hooks, ...hooks };
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  /** Start the jobs loop, health monitor, config scheduler and daily maintenance. Honors `spawnBackgroundWorkers`. */
  start(): void {
    if (this.stopped || !this.runtime.config.spawnBackgroundWorkers) return;
    this.workers.start();
  }

  /** Graceful stop: flag shutdown, abort previews, wait <= 10 s for in-flight AI, stop loops, drop peers. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.runtime.beginShutdown();
    await this.runtime.waitForInflightAi(10_000);
    await this.workers.stop();
    for (const p of [...this.peers]) p.detach();
    await this.runtime.drainBackground();
  }

  private ensureNotShuttingDown(): void {
    if (this.runtime.shuttingDown || this.stopped) throw CoreError.shuttingDown();
  }

  /** Strictly increasing timestamp for radar mutations (`monotonic_radar_now_ms`). */
  private monotonicNow(): number {
    const now = Math.max(this.runtime.now(), this.lastRadarNow + 1);
    this.lastRadarNow = now;
    return now;
  }

  // ---- IPC peers -----------------------------------------------------------------------------

  /** Register an extension relay connection; `consume` each parsed envelope, `detach` on close. */
  attachPeer(transport: PipelinePeerTransport, options: Partial<PeerOptions> = {}): PipelinePeerHandle {
    this.ensureNotShuttingDown();
    const inner = attachPeer(this.runtime, transport, { desktopVersion: options.desktopVersion ?? this.desktopVersion });
    const handle: PipelinePeerHandle = {
      connId: inner.connId,
      consume: (env) => {
        if (this.runtime.shuttingDown) {
          transport.send(makeEnvelope("error", { code: "busy", message: CoreError.shuttingDown().message, retryable: true }, env.id ?? null));
          return;
        }
        inner.consume(env);
      },
      detach: () => {
        inner.detach();
        this.peers.delete(handle);
      },
    };
    this.peers.add(handle);
    return handle;
  }

  /** Synchronous T0-T4 ingestion (used by the peer path, MCP/agent tests and golden-data tests). */
  ingestRawPost(sourceId: string, raw: RawPost, now: number = this.runtime.now()): IngestPostOutcome {
    this.ensureNotShuttingDown();
    const source = this.runtime.store.sources.get(sourceId);
    if (!source) throw CoreError.notFound("source", sourceId);
    return ingestRawPost(this.runtime, source, raw, now);
  }

  /** Run one pass of the jobs loop (tests and manual wake). */
  tickJobs(): Promise<number> {
    return tickJobsOnce(this.runtime);
  }

  // ---- commands ------------------------------------------------------------------------------

  sourceCrawlNow(id: string, reason: string | null): SourceCrawlNowResult {
    this.ensureNotShuttingDown();
    const rt = this.runtime;
    const source = rt.store.sources.get(id);
    if (!source) throw CoreError.notFound("source", id);
    const crawlReason = reason === "preview" ? "preview" : "manual";
    const settings = rt.loadSettings();
    const runId = newUlid();
    const sent = pushCrawlRequest(rt, source, crawlReason, settings.crawl_policy.max_posts_per_visit, runId);
    return { queued: sent > 0, run_id: runId };
  }

  async radarSuggestFields(input: SuggestFieldsInput): Promise<SuggestFieldsResultDto> {
    this.ensureNotShuttingDown();
    if (input.description.trim().length === 0) {
      throw CoreError.validation("Description cannot be empty for field suggestion");
    }
    const rt = this.runtime;
    const now = this.monotonicNow();
    const limits = rt.licenseLimits(now);
    const sources = input.suggest_sources ? rt.store.sources.list(now) : [];
    const followed = new Set(sources.filter((s) => s.followed).map((s) => s.id));
    const maxGroups = limits.max_followed_groups;
    const candidates = sources
      .filter(
        (s) =>
          s.platform === PLATFORM_FACEBOOK &&
          s.kind === SOURCE_KIND_GROUP &&
          s.state === "ok" &&
          (s.followed || followed.size < maxGroups),
      )
      .map((s) => ({ id: s.id, name: s.name, stored_posts: s.stored_post_count }));

    const bridgeInput: SuggestFieldsBridgeInput = {
      description: input.description,
      user_profession: input.user_profession ?? null,
      language_hint: input.language_hint ?? "vi",
      closest_template: input.template_id ? (rt.hooks.templates?.get(input.template_id) ?? null) : null,
      source_candidates: candidates,
    };

    const ai = requireAi(rt);
    let task;
    try {
      task = await rt.withInflightAi(() => ai.suggestFields(bridgeInput));
    } catch (err) {
      try {
        recordFailedAiCalls(rt, err, now);
      } catch (error) {
        rt.log(`record suggest_fields ai call failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw aiCoreError(err);
    }
    // Rust records every call with item_count 1 and ignores bookkeeping failures.
    try {
      recordAiCalls(rt, task.calls.map((c) => ({ ...c, task: "suggest_fields" as const, radar_version_id: null, item_count: 1 })), now);
    } catch (err) {
      rt.log(`record suggest_fields ai call failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const out = task.output;
    const suggested: string[] = [];
    for (const id of out.suggested_source_ids) {
      if (suggested.length === 3) break;
      if (candidates.some((c) => c.id === id) && !suggested.includes(id) && (followed.has(id) || followed.size < maxGroups)) {
        followed.add(id);
        suggested.push(id);
      }
    }
    const fields: FieldDef[] = out.fields.slice(0, limits.max_fields_per_radar).map((sf, idx) => ({
      key: sf.key,
      label: sf.label,
      type: sf.type as FieldDef["type"],
      description: sf.description,
      required: sf.required,
      options: sf.options ?? null,
      show_in_alert: true,
      order: idx,
    }));
    const hardFilters: HardFilter[] = out.hard_filters
      .filter((f) => fields.some((fd) => fd.key === f.field))
      .map((hf) => {
        const op = hf.op.trim();
        return {
          field: hf.field,
          op: ((FILTER_OPS as readonly string[]).includes(op) ? op : "eq") as HardFilter["op"],
          value: hf.value,
          when_missing: hf.when_missing === "fail" ? "fail" : "pass",
        };
      });
    return {
      suggested_name: out.suggested_name,
      want_intent: out.want_intent,
      fields,
      hard_filters: hardFilters,
      clarifying_questions: out.clarifying_questions,
      prefilter_hint: out.prefilter_hint ? { any: out.prefilter_hint.any, none: out.prefilter_hint.none } : null,
      suggested_source_ids: suggested,
    };
  }

  /** `radar_set_status_from_desktop`: the activation gate for drafts, then {@link radarSetStatus}. */
  async radarSetStatusFromDesktop(id: string, status: RadarStatus, previewId: string | null): Promise<RadarDto> {
    if (status === "active") {
      const rw = this.requireRadar(id);
      if (rw.source_ids.length === 0) throw CoreError.validation("Hãy chọn ít nhất một nhóm cho radar.");
      if (rw.radar.status === "draft") {
        if (previewId === null) throw CoreError.validation("Hãy xem thử bản nháp trước khi bật radar.");
        const preview = getRadarPreview(this.runtime, id, null);
        if (preview.preview_id !== previewId || preview.status !== "done" || preview.total_posts === 0) {
          throw CoreError.validation("Cần hoàn tất xem thử trên bài thật.");
        }
      }
    }
    return this.radarSetStatus(id, status);
  }

  async radarSetStatus(id: string, status: RadarStatus): Promise<RadarDto> {
    this.ensureNotShuttingDown();
    const rt = this.runtime;
    const now = this.monotonicNow();
    const existing = this.requireRadar(id);
    const prev = existing.radar.status;
    if (status === "active" && prev !== "active") {
      const limits = rt.licenseLimits(now);
      if (limits.max_active_radars !== null) {
        const curActive = Math.max(rt.store.radars.countActive(), 0);
        if (curActive >= limits.max_active_radars) {
          throw CoreError.licenseLimit(`Current ${limits.plan ?? "Personal"} plan allows at most ${limits.max_active_radars} active radars`);
        }
      }
    }
    rt.store.radars.setStatus(id, status, now);

    // `paused -> active` silently back-fills the last 24h (`02-radar-spec.md §4`).
    if (status === "active" && prev === "paused") {
      const refreshed = rt.store.radars.get(id) ?? existing;
      await runSilentBackfill24h(rt, refreshed, now);
      rt.wakeJobs();
    }
    rt.bumpAndPushConfig();
    await rt.emitHealthIfChanged(now);
    return this.radarDto(this.requireRadar(id), this.runtime.now());
  }

  async radarPreviewStart(input: PreviewStartInput): Promise<PreviewRunState> {
    this.ensureNotShuttingDown();
    return startRadarPreview(this.runtime, input);
  }

  radarPreviewGet(radarId: string, previewId: string | null): PreviewRunState {
    return getRadarPreview(this.runtime, radarId, previewId);
  }

  radarPreviewCancel(radarId: string, previewId: string): Promise<PreviewRunState> {
    return cancelRadarPreview(this.runtime, radarId, previewId);
  }

  /**
   * Compile the radar's current version now. Enqueues the durable `compile_ruleset` job and, when
   * this call claims that same job, runs it inline so the UI gets the ruleset immediately.
   * (Deliberate fix over Rust: a different job claimed by accident is executed instead of being
   * left `running` until the next boot-time stale recovery.)
   */
  async rulesetCompileNow(radarId: string): Promise<RulesetCompileResult> {
    this.ensureNotShuttingDown();
    const rt = this.runtime;
    const now = this.monotonicNow();
    if (!rt.licenseLimits(now).allow_auto_rulesets) {
      throw CoreError.licenseLimit(
        "AI auto-ruleset compilation requires the Pro (Chuyên nghiệp) plan; manual ruleset editing is available on all plans",
      );
    }
    const rw = this.requireRadar(radarId);
    const rvid = rw.current_version.id;
    const [job] = rt.store.jobs.enqueue("compile_ruleset", `compile_ruleset:${rvid}`, { radar_version_id: rvid }, now, now);

    const claimed = rt.store.jobs.claimDue(now);
    if (claimed && claimed.id === job.id) {
      try {
        const rec: RulesetRecord | null = await runCompileRulesetForVersion(rt, rvid);
        rt.store.jobs.complete(claimed.id);
        return { job_id: claimed.id, ruleset: rec ? rulesetRecordToDto(rec) : null };
      } catch (err) {
        rt.store.jobs.failOrRetry(claimed.id, err instanceof Error ? err.message : String(err), null);
        throw err;
      }
    }
    if (claimed) {
      try {
        await executeJob(rt, claimed);
        rt.store.jobs.complete(claimed.id);
      } catch (err) {
        rt.store.jobs.failOrRetry(claimed.id, err instanceof Error ? err.message : String(err), null);
      }
    }
    return { job_id: job.id, ruleset: null };
  }

  /** User-edited ruleset save (`ruleset_save_user`); exported for the radars/rulesets handler owner. */
  rulesetSaveUser(radarId: string, radarVersionId: string, body: DtoRulesetBody): RulesetDto {
    this.ensureNotShuttingDown();
    const rw = this.requireRadar(radarId);
    if (rw.current_version.id !== radarVersionId && rw.candidate_version?.id !== radarVersionId) {
      throw CoreError.validation(`radar_version_id '${radarVersionId}' does not belong to radar '${radarId}'`);
    }
    return saveUserRuleset(this.runtime, radarVersionId, body, this.runtime.now());
  }

  healthGet(): Promise<HealthStatus> {
    return this.runtime.computeHealthStatus(this.runtime.now());
  }

  crawlRunList(sourceId: string | null, limit: number): CrawlRunDto[] {
    return this.runtime.store.sources.listCrawlRuns(sourceId, limit).map(crawlRunToDto);
  }

  async setCrawlPaused(paused: boolean): Promise<HealthStatus> {
    this.ensureNotShuttingDown();
    const rt = this.runtime;
    const now = rt.now();
    if (paused) {
      if (!rt.crawlPaused) {
        rt.crawlPaused = true;
        rt.crawlPauseReason = "manual";
        rt.sendToProfile(null, makeEnvelope("crawl.pause", { until: null, reason: "manual" }, null, now));
      }
    } else {
      if (rt.facebookSession !== "ok") {
        throw CoreError.validation("Không thể tiếp tục quét khi phiên Facebook đang có sự cố");
      }
      if (rt.crawlPaused) {
        rt.crawlPaused = false;
        rt.crawlPauseReason = null;
        rt.sendToProfile(null, makeEnvelope("crawl.resume", {}, null, now));
      }
    }
    return rt.emitHealthIfChanged(now);
  }

  toggleCrawlPaused(): Promise<HealthStatus> {
    return this.setCrawlPaused(!this.runtime.crawlPaused);
  }

  // ---- helpers -------------------------------------------------------------------------------

  private requireRadar(id: string): RadarWithVersion {
    const rw = this.runtime.store.radars.get(id);
    if (!rw) throw CoreError.notFound("radar", id);
    return rw;
  }

  /** `Radar` DTO as returned by `radar_get(...).radar`. */
  radarDto(rw: RadarWithVersion, now: number): RadarDto {
    const rt = this.runtime;
    const stats = rt.store.radars.stats(rw.radar.id, now);
    const meta = rt.store.radars.list(true, now).find((i) => i.radar.id === rw.radar.id);
    return radarToDto(rw, meta, stats.rule_handled_ratio, rt.getFloodAutoDigestRadars().has(rw.radar.id));
  }
}

// ---- argument parsing for the handler table (Tauri `parse_arg` semantics) ------------------------

const argError = (key: string, detail: string): CommandError =>
  new CommandError("validation_error", `tham số '${key}' không hợp lệ: ${detail}`);

export function wrapDomainShape<T>(key: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DomainShapeError) throw argError(key, err.message);
    throw err;
  }
}

/** Parse the `input` object of `radar_preview_start` (serde defaults, Option<Option<_>> semantics). */
export function parsePreviewStartInput(raw: unknown): PreviewStartInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw argError("input", "invalid type: expected a map");
  const o = raw as Record<string, unknown>;
  if (typeof o.radar_id !== "string") throw argError("input", "missing field `radar_id`");
  const out: PreviewStartInput = { radar_id: o.radar_id };
  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== "string") throw argError("input", "invalid type for `description`");
    out.description = o.description;
  }
  if ("user_profession" in o) {
    if (o.user_profession !== null && typeof o.user_profession !== "string") throw argError("input", "invalid type for `user_profession`");
    out.user_profession = o.user_profession as string | null;
  }
  if (o.fields !== undefined && o.fields !== null) out.fields = wrapDomainShape("input", () => normalizeFieldDefs(o.fields));
  if (o.match_policy !== undefined && o.match_policy !== null) out.match_policy = wrapDomainShape("input", () => normalizeMatchPolicy(o.match_policy));
  if (o.source_ids !== undefined && o.source_ids !== null) {
    if (!Array.isArray(o.source_ids) || o.source_ids.some((s) => typeof s !== "string")) throw argError("input", "invalid type for `source_ids`");
    out.source_ids = o.source_ids as string[];
  }
  return out;
}

export function parseSuggestFieldsInput(raw: unknown): SuggestFieldsInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw argError("input", "invalid type: expected a map");
  const o = raw as Record<string, unknown>;
  if (typeof o.description !== "string") throw argError("input", "missing field `description`");
  const optStr = (k: string): string | null => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw argError("input", `invalid type for \`${k}\``);
    return v;
  };
  if (o.suggest_sources !== undefined && typeof o.suggest_sources !== "boolean") throw argError("input", "invalid type for `suggest_sources`");
  return {
    description: o.description,
    user_profession: optStr("user_profession"),
    template_id: optStr("template_id"),
    language_hint: optStr("language_hint"),
    suggest_sources: (o.suggest_sources as boolean | undefined) ?? false,
  };
}

export const RADAR_STATUSES: readonly RadarStatus[] = ["draft", "active", "paused", "archived"];
