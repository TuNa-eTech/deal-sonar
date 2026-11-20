// Binds the pipeline AI task layer to the integrations AI bridge of a `RuntimeContext`.
// Kept apart from `pipeline-ai.ts` so the task layer can be used (and tested) without the
// integrations state.

import type { RuntimeContext } from "../backend/runtime";
import type { AiHooks } from "../pipeline/types";
import { createPipelineAiHooks, type PipelineAiOptions } from "./pipeline-ai";
import { getAiBridge } from "./integrations-ai";

/** `PipelineHooks.ai` backed by `getAiBridge(ctx)`, resolved per call (provider swaps apply). */
export function createContextAiHooks(ctx: RuntimeContext, options: Omit<PipelineAiOptions, "bridge"> = {}): AiHooks {
  return createPipelineAiHooks({ ...options, bridge: () => getAiBridge(ctx) });
}
