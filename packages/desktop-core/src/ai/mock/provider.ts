// Port of crates/ai-bridge/src/adapters/mock/mod.rs: the deterministic, fully offline `AiProvider`
// used for development and integration runs. It never spawns a process and never touches the
// network. Behaviour precedence per `complete()`: queued response, custom handler, heuristic engine.

import { validateJsonSchema } from "../schema";
import {
  AiError,
  type AiModelOption,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type ProbeResult,
  type ProviderId,
} from "../types";
import { heuristicCompileRules } from "./compile";
import { heuristicJudgeExtract } from "./judge";
import { heuristicSourceIds, heuristicSuggestFields } from "./suggest";
import { byteLength, isJsonObject } from "./text";

export const MOCK_FAST_MODEL = "mock-fast-v1";
export const MOCK_SMART_MODEL = "mock-smart-v1";
export const MOCK_VERSION = "dealsonar-mock 0.1.0";

/** Models offered by the mock provider (Rust `discover_mock_models`). */
export function discoverMockModels(): AiModelOption[] {
  return [
    { id: MOCK_FAST_MODEL, label: `Mock Fast (${MOCK_FAST_MODEL}) — offline, xác định`, recommended_tier: "fast", source: "builtin" },
    { id: MOCK_SMART_MODEL, label: `Mock Smart (${MOCK_SMART_MODEL}) — offline, xác định`, recommended_tier: "smart", source: "builtin" },
  ];
}

/** A scripted reply: a full response, or an error that `complete()` rejects with. */
export type MockQueuedResponse = AiResponse | Error;
export type MockHandler = (req: AiRequest) => AiResponse | Promise<AiResponse>;

export interface MockAiProviderOptions {
  /** Scripted replies consumed first, in order (one per `complete()` call). */
  responses?: Iterable<MockQueuedResponse>;
  /** Fallback used when the queue is empty; replaces the heuristic engine. */
  handler?: MockHandler;
}

function scriptedResponse(output: unknown): AiResponse {
  return { output, usage: { input_tokens: 120, output_tokens: 60, cost_usd: 0 }, model: "mock-v1", durationMs: 5 };
}

/** `probe()` smoke schema `{ok: boolean}`: exactly one property named `ok`. */
function isProbeSmokeSchema(schema: unknown): boolean {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) return false;
  const props = schema.properties;
  return "ok" in props && Object.keys(props).length === 1;
}

export class MockAiProvider implements AiProvider {
  private readonly queue: MockQueuedResponse[];
  private readonly recorded: AiRequest[] = [];
  private probeOverride: ProbeResult | null = null;
  private readonly handler: MockHandler | null;

  constructor(options: MockAiProviderOptions = {}) {
    this.queue = [...(options.responses ?? [])];
    this.handler = options.handler ?? null;
  }

  static withQueuedResponses(responses: Iterable<MockQueuedResponse>): MockAiProvider {
    return new MockAiProvider({ responses });
  }

  static withHandler(handler: MockHandler): MockAiProvider {
    return new MockAiProvider({ handler });
  }

  pushResponse(response: MockQueuedResponse): void {
    this.queue.push(response);
  }

  /** Queue a successful JSON reply (usage 120/60 tokens, model `mock-v1`). */
  pushJson(output: unknown): void {
    this.queue.push(scriptedResponse(output));
  }

  setProbeResult(probe: ProbeResult | null): void {
    this.probeOverride = probe;
  }

  recordedRequests(): AiRequest[] {
    return [...this.recorded];
  }

  callCount(): number {
    return this.recorded.length;
  }

  id(): ProviderId {
    return "mock";
  }

  async probe(): Promise<ProbeResult> {
    if (this.probeOverride) return this.probeOverride;
    return {
      installed: true,
      version: MOCK_VERSION,
      authenticated: true,
      flags_supported: true,
      latency_ms: 1,
      error: null,
      available_models: discoverMockModels(),
    };
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    this.recorded.push(structuredClone(req));

    const queued = this.queue.shift();
    if (queued !== undefined) {
      if (queued instanceof Error) throw queued;
      return queued;
    }
    if (this.handler) return this.handler(req);
    return MockAiProvider.heuristicComplete(req);
  }

  /**
   * The built-in deterministic engine for any request. The output is validated against `req.schema`
   * and a mismatch throws `AiError.invalidOutput`, exactly like a misbehaving real provider.
   */
  static heuristicComplete(req: AiRequest): AiResponse {
    if (isProbeSmokeSchema(req.schema)) {
      return {
        output: { ok: true },
        usage: { input_tokens: 24, output_tokens: 6, cost_usd: 0 },
        model: MOCK_FAST_MODEL,
        durationMs: 3,
      };
    }

    let output: unknown;
    switch (req.task) {
      case "suggest_fields": {
        const suggested = heuristicSuggestFields(req.prompt);
        const props = isJsonObject(req.schema) && isJsonObject(req.schema.properties) ? req.schema.properties : {};
        if ("suggested_source_ids" in props) suggested.suggested_source_ids = heuristicSourceIds(req.prompt);
        output = suggested;
        break;
      }
      case "judge_extract":
        output = heuristicJudgeExtract(req.prompt, req.schema);
        break;
      case "compile_rules":
        output = heuristicCompileRules(req.prompt);
        break;
      default:
        throw AiError.invalidOutput(`mock provider does not support task '${String(req.task)}'`);
    }

    validateJsonSchema(req.schema, output);

    return {
      output,
      usage: {
        input_tokens: Math.max(16, Math.floor((byteLength(req.system) + byteLength(req.prompt)) / 4)),
        output_tokens: Math.max(12, Math.floor(byteLength(JSON.stringify(output)) / 4)),
        cost_usd: 0,
      },
      model: req.tier === "fast" ? MOCK_FAST_MODEL : MOCK_SMART_MODEL,
      durationMs: 4,
    };
  }
}
