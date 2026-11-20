// Port of the provider-facing half of crates/ai-bridge/src/bridge.rs: provider swap, the
// `1..=2` concurrency semaphore, schema validation of every response and the single
// invalid-output retry. Task builders (prompts, judge/suggest/compile validators, batch
// bisection) are layered on `completeValidated` by the pipeline port.

import type { Store } from "../store/store";
import type { RecordAiCallInput } from "../store/ops";
import { AgyCliProvider } from "./agy";
import { ClaudeCliProvider } from "./claude";
import { type CliAdapterConfig, newCliAdapterConfig } from "./cli-util";
import { CodexCliProvider } from "./codex";
import { validateJsonSchemaError } from "./schema";
import {
  AiError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type CliProviderId,
  type ModelTierMap,
  type ProbeResult,
  type ProviderId,
  type TaskKind,
  type Usage,
  recommendedTierDefaults,
  setTierModel,
} from "./types";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 2;

/** One recorded provider call (`AiCallRecord`); persisted through `recordAiCalls`. */
export interface AiCallRecord {
  provider: ProviderId;
  model: string | null;
  task: TaskKind;
  radar_version_id: string | null;
  item_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  status: "ok" | "error" | "invalid_output" | "timeout" | "rate_limited";
  error: string | null;
}

export interface TaskResult<T> {
  output: T;
  calls: AiCallRecord[];
  total_usage: Usage;
  total_duration_ms: number;
}

class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private permits: number) {}
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.permits += 1;
    };
  }
}

function recordToUsage(rec: AiCallRecord): Usage | null {
  if (rec.input_tokens === null && rec.output_tokens === null && rec.cost_usd === null) return null;
  return { input_tokens: rec.input_tokens ?? 0, output_tokens: rec.output_tokens ?? 0, cost_usd: rec.cost_usd };
}

function accumulateUsage(acc: Usage, delta: Usage | null): void {
  if (!delta) return;
  acc.input_tokens += delta.input_tokens;
  acc.output_tokens += delta.output_tokens;
  if (delta.cost_usd !== null && delta.cost_usd !== undefined) acc.cost_usd = (acc.cost_usd ?? 0) + delta.cost_usd;
}

export class AiBridge {
  private current: AiProvider;
  private readonly semaphore: Semaphore;
  readonly maxConcurrency: number;

  constructor(provider: AiProvider, maxConcurrency: number = MIN_CONCURRENCY) {
    this.current = provider;
    this.maxConcurrency = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.trunc(maxConcurrency)));
    this.semaphore = new Semaphore(this.maxConcurrency);
  }

  provider(): AiProvider {
    return this.current;
  }
  providerId(): ProviderId {
    return this.current.id();
  }
  setProvider(provider: AiProvider): void {
    this.current = provider;
  }

  async probe(): Promise<ProbeResult> {
    const release = await this.semaphore.acquire();
    try {
      return await this.current.probe();
    } finally {
      release();
    }
  }

  /** One provider call under the semaphore; the response is schema-checked and recorded. */
  async invokeOnce(
    req: AiRequest,
    radarVersionId: string | null,
    itemCount: number,
  ): Promise<{ result: { ok: true; response: AiResponse } | { ok: false; error: AiError }; record: AiCallRecord }> {
    const provider = this.current;
    const started = Date.now();
    let raw: { ok: true; response: AiResponse } | { ok: false; error: AiError };
    {
      const release = await this.semaphore.acquire();
      try {
        raw = { ok: true, response: await provider.complete(req) };
      } catch (e) {
        raw = { ok: false, error: e instanceof AiError ? e : AiError.process(-1, (e as Error).message) };
      } finally {
        release();
      }
    }
    const wall = Date.now() - started;

    let checked = raw;
    if (raw.ok) {
      const schemaErr = validateJsonSchemaError(req.schema, raw.response.output);
      if (schemaErr !== null) checked = { ok: false, error: AiError.invalidOutput(schemaErr) };
    }

    const base = { provider: provider.id(), task: req.task, radar_version_id: radarVersionId, item_count: itemCount };
    const record: AiCallRecord = checked.ok
      ? {
          ...base,
          model: checked.response.model,
          input_tokens: checked.response.usage?.input_tokens ?? null,
          output_tokens: checked.response.usage?.output_tokens ?? null,
          cost_usd: checked.response.usage?.cost_usd ?? null,
          duration_ms: Math.max(checked.response.durationMs, wall),
          status: "ok",
          error: null,
        }
      : {
          ...base,
          model: null,
          input_tokens: null,
          output_tokens: null,
          cost_usd: null,
          duration_ms: wall,
          status: checked.error.callStatus(),
          error: checked.error.message,
        };
    return { result: checked, record };
  }

  /**
   * Low-level validated call: acquires the semaphore, validates `output` against `req.schema` and
   * retries **once** on `invalid_output`. Callers persist `calls` with `recordAiCalls`.
   */
  async completeValidated(
    req: AiRequest,
    radarVersionId: string | null = null,
    itemCount = 1,
  ): Promise<TaskResult<unknown>> {
    const calls: AiCallRecord[] = [];
    const totalUsage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: null };
    let totalDuration = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { result, record } = await this.invokeOnce(req, radarVersionId, itemCount);
      totalDuration += record.duration_ms;
      accumulateUsage(totalUsage, recordToUsage(record));
      calls.push(record);
      if (result.ok) {
        return { output: result.response.output, calls, total_usage: totalUsage, total_duration_ms: totalDuration };
      }
      if (result.error.kind === "invalid_output" && attempt === 0) continue;
      // Attach the attempts so callers can still account for failed calls.
      throw Object.assign(result.error, { calls });
    }
    throw AiError.invalidOutput("unreachable retry state");
  }
}

/** Persist call records in `ai_calls` (never prompts or responses). Errors are swallowed like `let _ =`. */
export function recordAiCalls(
  store: Store,
  calls: readonly AiCallRecord[],
  nowMs: number,
  overrides: Partial<Pick<RecordAiCallInput, "task" | "radar_version_id" | "item_count">> = {},
): void {
  for (const c of calls) {
    try {
      store.aiCalls.record({
        provider: c.provider,
        model: c.model,
        task: overrides.task ?? c.task,
        radar_version_id: overrides.radar_version_id !== undefined ? overrides.radar_version_id : c.radar_version_id,
        item_count: overrides.item_count ?? c.item_count,
        input_tokens: c.input_tokens,
        output_tokens: c.output_tokens,
        cost_usd: c.cost_usd,
        duration_ms: c.duration_ms,
        status: c.status,
        error: c.error,
        now_ms: nowMs,
      });
    } catch {
      // accounting must never fail the task
    }
  }
}

export const CLI_BINARY_NAME: Record<CliProviderId, string> = {
  claude_cli: "claude",
  codex_cli: "codex",
  agy_cli: "agy",
};

/**
 * Build a CLI adapter for the persisted settings (`build_cli_provider_for_settings`): tier models
 * start from the recommended defaults and are overlaid with the user's saved tier map.
 */
export function buildCliProvider(
  provider: CliProviderId,
  savedTiers: Partial<Record<CliProviderId, { fast: string; smart: string }>>,
  workdir: string,
  overrides: Partial<CliAdapterConfig> = {},
): AiProvider {
  const tiers: ModelTierMap = recommendedTierDefaults();
  for (const pid of Object.keys(savedTiers) as CliProviderId[]) {
    const t = savedTiers[pid];
    if (!t) continue;
    setTierModel(tiers, pid, "fast", t.fast);
    setTierModel(tiers, pid, "smart", t.smart);
  }
  const cfg = newCliAdapterConfig(CLI_BINARY_NAME[provider], { modelTiers: tiers, workdir, ...overrides });
  switch (provider) {
    case "claude_cli":
      return new ClaudeCliProvider(cfg);
    case "codex_cli":
      return new CodexCliProvider(cfg);
    case "agy_cli":
      return new AgyCliProvider(cfg);
  }
}
