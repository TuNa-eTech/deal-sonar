// AI task layer for PipelineService (`PipelineHooks.ai`). Port of the task half of
// crates/ai-bridge/src/bridge.rs: prompts, structured schemas, response validation/mapping,
// the single invalid-output retry per task, recursive batch bisection for `judge_extract` and
// tier selection (judge = fast, suggest/compile = smart).
//
// Composition (coordinator):
//   import { createPipelineAiHooks } from "./services/pipeline-ai";
//   import { createContextAiHooks } from "./services/pipeline-ai-context";   // binds getAiBridge(ctx)
//   PipelineService.for(ctx, { hooks: { ai: createContextAiHooks(ctx), ... } });
//
// Bookkeeping contract. The pipeline (`pipeline/ai-batch.ts`, `rulesets.ts`, `PipelineService`)
// already tracks in-flight calls, persists `report.calls` / `task.calls` into `ai_calls` and drives
// the AI health state machine. These hooks therefore call `AiBridge.invokeOnce` directly and return
// the per-call telemetry instead of going through `runAiTask`, which would record every call a
// second time. When a task fails, the thrown `PipelineAiError` carries the attempts made so far in
// `.calls` (the pipeline records these attempts when the task fails).

import type { AiBridge, AiCallRecord } from "../ai/bridge";
import { AiError, type AiRequest } from "../ai/types";
import {
  AiHookError,
  type AiCallTelemetry,
  type AiHooks,
  type BatchConfig,
  type CompileRulesBridgeInput,
  type JudgeBatchReport,
  type PostEvalOutcome,
  type PostPromptInput,
  type RadarPromptContext,
  type SuggestFieldsBridgeInput,
  type SuggestFieldsBridgeOutput,
} from "../pipeline/types";
import {
  buildCompileRulesRequest,
  buildJudgeExtractRequest,
  buildSuggestFieldsRequest,
  generateBoundaryNonce,
  splitPostsIntoBatches,
} from "./pipeline-ai-prompts";
import { JudgeSchemaCache } from "./pipeline-ai-schemas";
import { validateCompileRulesOutput, validateJudgeExtractOutput, validateSuggestFieldsOutput } from "./pipeline-ai-validate";

export interface PipelineAiOptions {
  /** The shared bridge, or a getter so a provider swap / bridge rebuild is picked up per call. */
  bridge: AiBridge | (() => AiBridge);
  /** Boundary nonce source (tests inject a deterministic one). Default: 48 random bits as hex. */
  nonce?: () => string;
  /** Replaces the per-task default CLI timeout (60 s / 120 s / 180 s). */
  timeoutOverrideMs?: number | null;
  log?: (message: string) => void;
}

/** `AiHookError` that also carries the provider calls made before the task failed. */
export class PipelineAiError extends AiHookError {
  constructor(
    kind: AiHookError["kind"],
    message: string,
    retryAfterMs: number | null,
    calls: AiCallTelemetry[],
  ) {
    super(kind, message, retryAfterMs, calls);
    this.name = "PipelineAiError";
  }
}

export interface SuggestFieldsTask {
  output: SuggestFieldsBridgeOutput;
  calls: AiCallTelemetry[];
}
export interface CompileRulesTask {
  output: unknown;
  calls: AiCallTelemetry[];
}

const toTelemetry = (rec: AiCallRecord): AiCallTelemetry => ({
  provider: rec.provider,
  model: rec.model,
  task: rec.task,
  radar_version_id: rec.radar_version_id,
  item_count: rec.item_count,
  input_tokens: rec.input_tokens,
  output_tokens: rec.output_tokens,
  cost_usd: rec.cost_usd,
  duration_ms: rec.duration_ms,
  status: rec.status,
  error: rec.error,
});

function toHookError(err: AiError, calls: AiCallTelemetry[]): PipelineAiError {
  return new PipelineAiError(err.kind, err.message, err.retryAfterMs, [...calls]);
}

/** After a successful provider call, a semantic failure downgrades that call's record (usage stays). */
function markInvalid(record: AiCallRecord, err: AiError): AiCallRecord {
  return { ...record, status: "invalid_output", error: err.message };
}

/** `ensure_unique_refs`: keep caller refs when unique, else renumber `1..=n` for the prompt. */
function ensureUniqueRefs(posts: readonly PostPromptInput[]): PostPromptInput[] {
  const seen = new Set<number>();
  if (posts.every((p) => !seen.has(p.ref) && seen.add(p.ref))) return [...posts];
  return posts.map((p, idx) => ({ ...p, ref: idx + 1 }));
}

export function createPipelineAiHooks(options: PipelineAiOptions): AiHooks {
  const getBridge = (): AiBridge => (typeof options.bridge === "function" ? options.bridge() : options.bridge);
  const nextNonce = options.nonce ?? generateBoundaryNonce;
  const timeout = options.timeoutOverrideMs ?? null;
  const schemas = new JudgeSchemaCache();

  async function suggestFields(input: SuggestFieldsBridgeInput): Promise<SuggestFieldsTask> {
    const bridge = getBridge();
    const calls: AiCallTelemetry[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = buildSuggestFieldsRequest(input, timeout);
      const { result, record } = await bridge.invokeOnce(req, null, 1);
      let parsed: SuggestFieldsBridgeOutput | null = null;
      let failure: AiError | null = null;
      let finalRecord = record;
      if (result.ok) {
        try {
          parsed = validateSuggestFieldsOutput(result.response.output);
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          failure = e;
          finalRecord = markInvalid(record, e);
        }
      } else {
        failure = result.error;
      }
      calls.push(toTelemetry(finalRecord));
      if (parsed) return { output: parsed, calls };
      if (failure && failure.kind === "invalid_output" && attempt === 0) continue;
      throw toHookError(failure as AiError, calls);
    }
    throw new PipelineAiError("invalid_output", "unreachable retry state", null, calls);
  }

  async function compileRules(input: CompileRulesBridgeInput): Promise<CompileRulesTask> {
    const bridge = getBridge();
    const calls: AiCallTelemetry[] = [];
    const sampleCount = Math.max(input.labeled_samples.length, 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = buildCompileRulesRequest(input, nextNonce(), timeout);
      const { result, record } = await bridge.invokeOnce(req, input.radar.radar_version_id, sampleCount);
      let output: unknown;
      let ok = false;
      let failure: AiError | null = null;
      let finalRecord = record;
      if (result.ok) {
        try {
          validateCompileRulesOutput(result.response.output, input.radar.fields);
          output = result.response.output;
          ok = true;
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          failure = e;
          finalRecord = markInvalid(record, e);
        }
      } else {
        failure = result.error;
      }
      calls.push(toTelemetry(finalRecord));
      if (ok) return { output, calls };
      if (failure && failure.kind === "invalid_output" && attempt === 0) continue;
      throw toHookError(failure as AiError, calls);
    }
    throw new PipelineAiError("invalid_output", "unreachable retry state", null, calls);
  }

  interface BatchSink {
    outcomes: PostEvalOutcome[];
    calls: AiCallTelemetry[];
  }

  /**
   * One slice: attempt + one retry on `invalid_output`/`refused`, then split in halves until a
   * single bad post is isolated as `ai_failed`. Any other error (rate limit, timeout, process,
   * auth) aborts the whole task; the semaphore is only held per provider call, so recursion
   * cannot deadlock.
   */
  async function evalSlice(
    bridge: AiBridge,
    radar: RadarPromptContext,
    slice: readonly PostPromptInput[],
    origSlice: readonly PostPromptInput[],
    schema: unknown,
    sink: BatchSink,
  ): Promise<void> {
    const expectedRefs = slice.map((p) => p.ref);
    let lastBisectable: AiError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req: AiRequest = buildJudgeExtractRequest(radar, slice, schema, nextNonce(), timeout);
      const { result, record } = await bridge.invokeOnce(req, radar.radar_version_id, slice.length);
      let items: ReturnType<typeof validateJudgeExtractOutput> | null = null;
      let failure: AiError | null = null;
      let finalRecord = record;
      if (result.ok) {
        try {
          items = validateJudgeExtractOutput(result.response.output, expectedRefs, radar.fields);
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          failure = e;
          finalRecord = markInvalid(record, e);
        }
      } else {
        failure = result.error;
      }
      sink.calls.push(toTelemetry(finalRecord));

      if (items) {
        const byRef = new Map(items.map((item) => [item.ref, item]));
        slice.forEach((norm, i) => {
          const orig = origSlice[i];
          const item = byRef.get(norm.ref);
          if (!item) throw new Error("validated exact ref presence");
          sink.outcomes.push({ state: "done", post_id: orig.post_id, result: { ...item, ref: orig.ref } });
        });
        return;
      }
      const err = failure as AiError;
      if (!err.isBisectableBatchFailure()) throw toHookError(err, sink.calls);
      lastBisectable = err;
      if (attempt === 0) options.log?.(`judge_extract batch of ${slice.length} failed validation on attempt 1; retrying once`);
    }

    const errMsg = lastBisectable?.message ?? "invalid AI output";
    if (slice.length === 1) {
      sink.outcomes.push({ state: "ai_failed", post_id: origSlice[0].post_id, ref: origSlice[0].ref, error: errMsg });
      return;
    }
    const mid = Math.floor(slice.length / 2);
    options.log?.(`judge_extract retry failed; bisecting batch of ${slice.length} into ${mid}+${slice.length - mid}`);
    await evalSlice(bridge, radar, slice.slice(0, mid), origSlice.slice(0, mid), schema, sink);
    await evalSlice(bridge, radar, slice.slice(mid), origSlice.slice(mid), schema, sink);
  }

  async function judgeExtractAll(radar: RadarPromptContext, posts: PostPromptInput[], config: BatchConfig): Promise<JudgeBatchReport> {
    const bridge = getBridge();
    const sink: BatchSink = { outcomes: [], calls: [] };
    for (const chunk of splitPostsIntoBatches(radar, posts, config)) {
      const normalized = ensureUniqueRefs(chunk);
      const schema = schemas.getOrBuild(radar.radar_version_id, radar.fields);
      await evalSlice(bridge, radar, normalized, chunk, schema, sink);
    }
    return { outcomes: sink.outcomes, calls: sink.calls };
  }

  return { providerId: () => getBridge().providerId(), judgeExtractAll, suggestFields, compileRules };
}
