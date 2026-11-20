// Port of crates/core/src/workers/{jobs,health}.rs: durable job processing, follow-up reminders,
// the health monitor, config re-push scheduler and daily maintenance.
//
// Outbox delivery, Telegram polling and digest formatting stay with the notification worker; the
// `notify_lead` / `flush_digest` job kinds are delegated to `PipelineHooks.notify.runJob` and FAIL
// (retryable per the Rust retry table) when no hook is installed instead of being marked done.

import { CoreError } from "../backend/wire";
import { defaultJobRetryDelayMs, type JobRecord } from "../store/ops";
import { runEvaluateBatchForVersion, scheduleEvaluateBatchJob } from "./ai-batch";
import { loadLeadDto } from "./finalize";
import type { PipelineRuntime } from "./runtime";
import { FLOOD_LEADS_PER_HOUR_THRESHOLD } from "./runtime";
import { runAuditRuleset, runCompileRulesetForVersion } from "./rulesets";

/** Follow-ups are delivered durably per scheduled timestamp; overdue work stays visible until claimed. */
export function dispatchDueFollowups(rt: PipelineRuntime, now: number): number {
  const settings = rt.loadSettings();
  const ids = rt.store.leads.claimDueFollowUps(now);
  for (const id of ids) {
    const lead = loadLeadDto(rt, id);
    if (!lead) continue;
    rt.emit("lead:reminder", lead);
    if (settings.os_notifications_enabled) {
      rt.notifyOs({ lead_id: lead.id, radar_name: "Đến hạn liên hệ", summary: lead.summary });
    }
  }
  return ids.length;
}

function payloadString(job: JobRecord, key: string): string | null {
  const p = job.payload as Record<string, unknown> | null;
  const v = p?.[key];
  return typeof v === "string" ? v : null;
}

export async function executeJob(rt: PipelineRuntime, job: JobRecord): Promise<void> {
  switch (job.kind) {
    case "evaluate_batch": {
      const rvid = payloadString(job, "radar_version_id");
      if (rvid === null) throw CoreError.validation("evaluate_batch missing radar_version_id");
      const silent = (job.payload as Record<string, unknown> | null)?.silent === true;
      await runEvaluateBatchForVersion(rt, rvid, silent);
      return;
    }
    case "notify_lead":
    case "flush_digest": {
      if (!rt.hooks.notify) throw CoreError.internal(`${job.kind}: no notification hook installed`);
      if (job.kind === "flush_digest" && payloadString(job, "radar_id") === null) {
        throw CoreError.validation("flush_digest missing radar_id");
      }
      await rt.hooks.notify.runJob(job.kind, (job.payload ?? {}) as Record<string, unknown>);
      return;
    }
    case "compile_ruleset": {
      const rvid = payloadString(job, "radar_version_id");
      if (rvid === null) throw CoreError.validation("compile_ruleset missing radar_version_id");
      await runCompileRulesetForVersion(rt, rvid);
      return;
    }
    case "audit_ruleset": {
      const rvid = payloadString(job, "radar_version_id");
      const rsid = payloadString(job, "ruleset_id");
      if (rvid !== null && rsid !== null) {
        await runAuditRuleset(rt, rvid, rsid);
      } else {
        for (const item of rt.store.radars.list(false, rt.now())) {
          if (item.radar.status !== "active") continue;
          const active = rt.store.radars.getActiveRuleset(item.current_version.id);
          if (active) await runAuditRuleset(rt, item.current_version.id, active.id);
        }
      }
      return;
    }
    case "purge_expired": {
      const settings = rt.loadSettings();
      const now = rt.now();
      rt.store.purgeExpired(now, settings.unmatched_retention_days);
      rt.store.leads.cleanupPreviewEvaluations(null, now - 86_400_000);
      return;
    }
    default:
      throw CoreError.validation(`unknown job kind '${job.kind}'`);
  }
}

/** One pass: follow-up reminders, pending-AI batch triggers, then claim and run every due job. */
export async function tickJobsOnce(rt: PipelineRuntime): Promise<number> {
  const now = rt.now();
  dispatchDueFollowups(rt, now);

  for (const g of rt.store.leads.listPendingAiBatches()) {
    if (g.is_preview) continue;
    if (g.count >= rt.config.batchTriggerCount || now - g.oldest_created_at >= rt.config.batchMaxWaitMs) {
      scheduleEvaluateBatchJob(rt, g.radar_version_id, true, now);
    }
  }

  let processed = 0;
  while (!rt.shuttingDown) {
    const job = rt.store.jobs.claimDue(rt.now());
    if (!job) break;
    try {
      await executeJob(rt, job);
      rt.store.jobs.complete(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = defaultJobRetryDelayMs(job.kind, job.attempts);
      const updated = rt.store.jobs.failOrRetry(job.id, message, delay === null ? null : rt.now() + delay);
      if (updated.state === "failed") {
        rt.emit("job:failed", { job_id: updated.id, kind: updated.kind, error: message, failed_at: rt.now() });
      }
    }
    processed += 1;
  }
  return processed;
}

// ---- health monitor + daily maintenance --------------------------------------------------------

export function isWithinActiveHours(active: { from: string; to: string }, now: number): boolean {
  const dt = new Date(now);
  const cur = dt.getHours() * 60 + dt.getMinutes();
  const parse = (s: string): number | null => {
    const m = /^(\d+):(\d+)$/.exec(s.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = parse(active.from);
  const to = parse(active.to);
  if (from === null || to === null) return true;
  return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
}

/** 1-minute invariants: disconnect/AI incidents after a 30 min grace, AI recovery requeue, flood cool-down. */
export async function checkHealthAndIncidents(rt: PipelineRuntime, now: number): Promise<void> {
  const settings = rt.loadSettings();
  const activeRadars = rt.store.radars.countActive();

  if (rt.peers.size === 0) {
    const since = rt.lastDisconnectedAt ?? rt.startedAtMs;
    if (
      activeRadars > 0 &&
      now - since >= rt.config.disconnectAlertGraceMs &&
      isWithinActiveHours(settings.crawl_policy.active_hours, now) &&
      !rt.incidents.extDisconnectedAlerted
    ) {
      rt.incidents.extDisconnectedAlerted = true;
      rt.queueSystemIncident({ kind: "extension_disconnected" }, false, now);
    }
  }

  const pendingLive = rt.store.leads
    .listPendingAiBatches()
    .filter((g) => !g.is_preview)
    .reduce((n, g) => n + g.count, 0);
  const aiHealthy = rt.aiHealth.lastError === null && (rt.aiHealth.rateLimitResetAt === null || rt.aiHealth.rateLimitResetAt <= now);
  if (aiHealthy) {
    if (rt.store.leads.requeueAiFailedEvaluations() > 0) rt.wakeJobs();
    if (rt.incidents.aiUnavailableAlerted) {
      rt.incidents.aiUnavailableAlerted = false;
      rt.queueSystemIncident({ kind: "ai_unavailable", pending_posts: 0 }, true, now);
    }
  } else if (rt.aiHealth.firstUnavailableAt !== null) {
    if (pendingLive > 0 && now - rt.aiHealth.firstUnavailableAt >= rt.config.disconnectAlertGraceMs && !rt.incidents.aiUnavailableAlerted) {
      rt.incidents.aiUnavailableAlerted = true;
      rt.queueSystemIncident({ kind: "ai_unavailable", pending_posts: pendingLive }, false, now);
    }
  }

  for (const rid of rt.getFloodAutoDigestRadars()) {
    if (rt.store.leads.countLeadsInLastHour(rid, now) <= FLOOD_LEADS_PER_HOUR_THRESHOLD) {
      rt.markRadarFloodAutoDigest(rid, false);
      rt.incidents.floodAlertedRadars.delete(rid);
    }
  }

  await rt.emitHealthIfChanged(now);
}

export function runDailyMaintenance(rt: PipelineRuntime, now: number): void {
  const paused = rt.hooks.license?.enforcePlanLimits?.(now) ?? [];
  if (paused.length > 0) rt.bumpAndPushConfig();
  const day = Math.floor(now / 86_400_000);
  rt.enqueueAndWakeJob("audit_ruleset", `audit_ruleset:${day}`, {}, now);
  rt.enqueueAndWakeJob("purge_expired", `purge_expired:${day}`, {}, now);
}

// ---- background loops -------------------------------------------------------------------------

/** Jobs loop + health/scheduler/maintenance loop. Safe to `stop()` multiple times. */
export class BackgroundWorkers {
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private tickInFlight: Promise<unknown> | null = null;
  private pendingWake = false;
  private lastDailyDay = -1;

  constructor(private readonly rt: PipelineRuntime) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const rt = this.rt;
    const boot = rt.now();
    try {
      rt.store.jobs.recoverStaleRunning(boot - 300_000, boot);
    } catch (err) {
      rt.log(`recover stale jobs failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.unsubscribe = rt.onJobWake(() => this.requestTick());
    this.timers.push(setInterval(() => this.requestTick(), rt.config.jobPollIntervalMs));
    this.timers.push(
      setInterval(() => {
        if (rt.shuttingDown) return;
        void checkHealthAndIncidents(rt, rt.now()).catch((err: unknown) =>
          rt.log(`health monitor check failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }, rt.config.healthCheckIntervalMs),
    );
    this.timers.push(
      setInterval(() => {
        if (!rt.shuttingDown && rt.isAnyConnected()) {
          try {
            rt.bumpAndPushConfig();
          } catch (err) {
            rt.log(`config push failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }, rt.config.schedulerIntervalMs),
    );
    this.timers.push(
      setInterval(() => {
        if (rt.shuttingDown) return;
        const now = rt.now();
        const bucket = Math.floor(now / 86_400_000);
        if (bucket !== this.lastDailyDay) {
          this.lastDailyDay = bucket;
          try {
            runDailyMaintenance(rt, now);
          } catch (err) {
            rt.log(`daily maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }, 3_600_000),
    );
    for (const t of this.timers) t.unref?.();
    this.requestTick();
  }

  /** Coalesced tick: at most one pass runs at a time; a wake during a pass schedules one more. */
  private requestTick(): void {
    if (!this.running || this.rt.shuttingDown) return;
    if (this.tickInFlight) {
      this.pendingWake = true;
      return;
    }
    this.tickInFlight = tickJobsOnce(this.rt)
      .catch((err: unknown) => this.rt.log(`jobs worker tick error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.tickInFlight = null;
        if (this.pendingWake) {
          this.pendingWake = false;
          this.requestTick();
        }
      });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.tickInFlight;
  }
}
