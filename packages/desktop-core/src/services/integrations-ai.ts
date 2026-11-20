// AI hooks for PipelineService.
//
// The pipeline owns prompts and result interpretation. It reaches the CLI providers through these
// functions, which add what `CoreRuntime` adds around `AiBridge` in Rust: the shared bridge,
// in-flight tracking (so shutdown can wait for running calls), `ai_calls` accounting and the
// AI health state machine (`rate_limit_reset_at`, `last_error`, `first_unavailable_at`).
//
// Signatures (all take the `RuntimeContext` the handlers use):
//
//   getAiBridge(ctx): AiBridge
//   runAiTask(ctx, req: AiRequest, opts?: { radarVersionId?: string | null; itemCount?: number }):
//       Promise<TaskResult<unknown>>      // throws CoreError("ai") on failure after recording it
//   noteAiFailure(ctx, error: AiError, now: number): Promise<void>
//   noteAiSuccess(ctx, now: number): Promise<void>
//   aiBackoffUntil(ctx, now: number): number | null     // honour before starting a batch
//   aiDailyBudget(ctx, now: number): { cap: number; used: number; remaining: number }

import type { AiBridge, AiCallRecord, TaskResult } from "../ai/bridge";
import { recordAiCalls } from "../ai/bridge";
import { AiError, type AiRequest } from "../ai/types";
import type { RuntimeContext } from "../backend/runtime";
import { aiToCoreError } from "../notify/errors";
import {
  emitHealthIfChanged,
  getIntegrations,
  loadSettings,
  queueSystemIncidentAlert,
} from "./integrations-state";

export function getAiBridge(ctx: RuntimeContext): AiBridge {
  return getIntegrations(ctx).bridge;
}

/** Record a failed batch/task in the AI health state (`run_evaluate_batch_for_version` error arm). */
export async function noteAiFailure(ctx: RuntimeContext, error: AiError, now: number): Promise<void> {
  const ai = getIntegrations(ctx).aiHealth;
  if (error.kind === "rate_limited") {
    const wait = Math.max(1_000, error.retryAfterMs ?? 60_000);
    ai.rateLimitResetAt = now + wait;
  } else {
    ai.lastError = error.message;
    if (ai.firstUnavailableAt === null) ai.firstUnavailableAt = now;
  }
  await emitHealthIfChanged(ctx, now);
}

/** Clear AI error state after a successful call; sends the recovery alert if one was raised. */
export async function noteAiSuccess(ctx: RuntimeContext, now: number): Promise<void> {
  const state = getIntegrations(ctx);
  state.aiHealth.lastError = null;
  state.aiHealth.rateLimitResetAt = null;
  state.aiHealth.firstUnavailableAt = null;
  const wasAlerted = state.incidents.aiUnavailableAlerted;
  state.incidents.aiUnavailableAlerted = false;
  if (wasAlerted) {
    try {
      queueSystemIncidentAlert(ctx, { kind: "ai_unavailable", pending_posts: 0 }, true, now);
    } catch {
      // `let _ =`
    }
  }
  try {
    ctx.store.leads.requeueAiFailedEvaluations();
  } catch {
    // `let _ =`
  }
  await emitHealthIfChanged(ctx, now);
}

/** Epoch ms until which AI calls must wait (active rate-limit window), or `null`. */
export function aiBackoffUntil(ctx: RuntimeContext, now: number): number | null {
  const reset = getIntegrations(ctx).aiHealth.rateLimitResetAt;
  return reset !== null && reset > now ? reset : null;
}

/** Daily post budget (`settings.daily_ai_post_cap`) and what is left of it today (UTC day). */
export function aiDailyBudget(ctx: RuntimeContext, now: number): { cap: number; used: number; remaining: number } {
  const cap = loadSettings(ctx.store).daily_ai_post_cap;
  const used = ctx.store.aiCalls.countItemsToday(now);
  return { cap, used, remaining: Math.max(0, cap - used) };
}

/**
 * Run one validated AI task: tracked as in-flight, schema-checked, retried once on invalid
 * output, every call persisted in `ai_calls`, health updated on both outcomes.
 */
export async function runAiTask(
  ctx: RuntimeContext,
  req: AiRequest,
  opts: { radarVersionId?: string | null; itemCount?: number } = {},
): Promise<TaskResult<unknown>> {
  const state = getIntegrations(ctx);
  try {
    const result = await state.withInflightAi(() =>
      state.bridge.completeValidated(req, opts.radarVersionId ?? null, opts.itemCount ?? 1),
    );
    const now = Date.now();
    recordAiCalls(ctx.store, result.calls, now);
    await noteAiSuccess(ctx, now);
    return result;
  } catch (err) {
    if (err instanceof AiError) {
      const now = Date.now();
      const failedCalls = (err as AiError & { calls?: AiCallRecord[] }).calls;
      if (failedCalls) recordAiCalls(ctx.store, failedCalls, now);
      await noteAiFailure(ctx, err, now);
      throw aiToCoreError(err.message);
    }
    throw err;
  }
}
