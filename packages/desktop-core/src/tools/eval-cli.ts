// Command line of the offline AI quality evaluator (port of crates/ai-bridge/src/bin/eval.rs).
//
//   node packages/desktop-core/scripts/eval.mjs [OPTIONS]
//
// Same options, defaults, messages and exit codes as the Rust binary; the AI path is the Electron
// pipeline AI layer (`createPipelineAiHooks` over an `AiBridge`).

import * as fs from "node:fs";

import { AiBridge } from "../ai/bridge";
import { AgyCliProvider } from "../ai/agy";
import { ClaudeCliProvider } from "../ai/claude";
import { newCliAdapterConfig } from "../ai/cli-util";
import { CodexCliProvider } from "../ai/codex";
import { type AiProvider, type ModelTier, type ModelTierMap, type ProviderId, setTierModel } from "../ai/types";
import { createPipelineAiHooks } from "../services/pipeline-ai";
import {
  builtinBdsEvalSuite,
  formatEvalReport,
  parseGoldenJsonl,
  parseRadarContextJson,
  runOfflineEval,
} from "./eval";
import { MockAiProvider } from "../ai/mock";

export const EVAL_HELP = `\
DealSonar Offline AI Quality Evaluator (\`06-ai-bridge.md §8\`)

USAGE:
  node packages/desktop-core/scripts/eval.mjs [OPTIONS]

OPTIONS:
  --dataset <path.jsonl>     Path to labeled golden JSONL dataset (omit to run built-in BĐS suite)
  --radar <radar.json>       Path to radar definition JSON (omit to use built-in BĐS radar)
  --provider <id>            Provider: mock | claude | codex | agy (default: mock)
  --model <name>             Optional concrete model override for evaluation tier
  --tier <fast|smart>        Model tier when --model is set (default: fast)
  --batch-size <n>           Number of posts per judge_extract batch (default: 20)
  --json                     Also print machine-readable JSON summary at the end
  -h, --help                 Show this help message
`;

export interface EvalCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): string;
}

export interface EvalCliDeps {
  /** Provider factory (tests inject scripted providers). Default: mock or the real CLI adapters. */
  createProvider?(id: ProviderId, tiers: ModelTierMap): AiProvider;
}

const defaultIo: EvalCliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readFile: (path) => fs.readFileSync(path, "utf8"),
};

/** `ProviderId::from_str`. */
export function parseProviderId(value: string): ProviderId {
  const key = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  switch (key) {
    case "claude":
    case "claude_cli":
    case "claude-cli":
      return "claude_cli";
    case "codex":
    case "codex_cli":
    case "codex-cli":
      return "codex_cli";
    case "agy":
    case "agy_cli":
    case "agy-cli":
    case "antigravity":
      return "agy_cli";
    case "mock":
      return "mock";
    default:
      throw new Error(`unknown provider '${key}' (expected claude_cli, codex_cli, agy_cli, or mock)`);
  }
}

/** `ModelTier::from_str`. */
export function parseModelTier(value: string): ModelTier {
  const key = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (key === "fast" || key === "smart") return key;
  throw new Error(`unknown model tier '${key}' (expected fast or smart)`);
}

function defaultCreateProvider(id: ProviderId, tiers: ModelTierMap): AiProvider {
  switch (id) {
    case "mock":
      return new MockAiProvider();
    case "claude_cli":
      return new ClaudeCliProvider(newCliAdapterConfig("claude", { modelTiers: tiers }));
    case "codex_cli":
      return new CodexCliProvider(newCliAdapterConfig("codex", { modelTiers: tiers }));
    case "agy_cli":
      return new AgyCliProvider(newCliAdapterConfig("agy", { modelTiers: tiers }));
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs the evaluator. Resolves to the process exit code (0 success, 1 failure). */
export async function runEvalCli(args: readonly string[], ioOverrides: Partial<EvalCliIo> = {}, deps: EvalCliDeps = {}): Promise<number> {
  const io: EvalCliIo = { ...defaultIo, ...ioOverrides };
  const fail = (message: string): number => {
    io.stderr(`${message}\n`);
    return 1;
  };

  let datasetPath: string | null = null;
  let radarPath: string | null = null;
  let providerId: ProviderId = "mock";
  let modelOverride: string | null = null;
  let tier: ModelTier = "fast";
  let batchSize = 20;
  let emitJson = false;

  let i = 0;
  const next = (): string | undefined => args[i++];
  while (i < args.length) {
    const arg = args[i++] as string;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(EVAL_HELP);
        return 0;
      case "--dataset": {
        const val = next();
        if (val === undefined) return fail("Error: --dataset requires a file path");
        datasetPath = val;
        break;
      }
      case "--radar": {
        const val = next();
        if (val === undefined) return fail("Error: --radar requires a file path");
        radarPath = val;
        break;
      }
      case "--provider": {
        const val = next();
        if (val === undefined) return fail("Error: --provider requires mock|claude|codex|agy");
        try {
          providerId = parseProviderId(val);
        } catch (e) {
          return fail(`Error: ${messageOf(e)}`);
        }
        break;
      }
      case "--model": {
        const val = next();
        if (val === undefined) return fail("Error: --model requires a model name");
        modelOverride = val;
        break;
      }
      case "--tier": {
        const val = next();
        if (val === undefined) return fail("Error: --tier requires fast or smart");
        try {
          tier = parseModelTier(val);
        } catch (e) {
          return fail(`Error: ${messageOf(e)}`);
        }
        break;
      }
      case "--batch-size": {
        const val = next();
        if (val === undefined) return fail("Error: --batch-size requires a positive integer");
        // Rust `usize::from_str`: digits only (an optional leading `+` is accepted), then `n > 0`.
        const n = /^\+?\d+$/.test(val) ? Number(val) : Number.NaN;
        if (!Number.isSafeInteger(n) || n <= 0) return fail(`Error: invalid --batch-size '${val}'`);
        batchSize = n;
        break;
      }
      case "--json":
        emitJson = true;
        break;
      default:
        return fail(`Error: unknown argument '${arg}'. Pass --help for usage.`);
    }
  }

  const defaults = builtinBdsEvalSuite();

  let radar = defaults.radar;
  if (radarPath !== null) {
    let raw: string;
    try {
      raw = io.readFile(radarPath);
    } catch (e) {
      return fail(`Error reading radar '${radarPath}': ${messageOf(e)}`);
    }
    try {
      radar = parseRadarContextJson(raw);
    } catch (e) {
      return fail(`Error parsing radar '${radarPath}': ${messageOf(e)}`);
    }
  }

  let samples = defaults.samples;
  if (datasetPath !== null) {
    let raw: string;
    try {
      raw = io.readFile(datasetPath);
    } catch (e) {
      return fail(`Error reading dataset '${datasetPath}': ${messageOf(e)}`);
    }
    try {
      samples = parseGoldenJsonl(raw);
    } catch (e) {
      return fail(`Error parsing dataset '${datasetPath}': ${messageOf(e)}`);
    }
  }

  const tiers: ModelTierMap = {};
  if (modelOverride !== null) setTierModel(tiers, providerId, tier, modelOverride);

  try {
    const provider = (deps.createProvider ?? defaultCreateProvider)(providerId, tiers);
    const hooks = createPipelineAiHooks({ bridge: new AiBridge(provider) });
    const summary = await runOfflineEval(hooks, radar, samples, batchSize);
    io.stdout(formatEvalReport(summary));
    if (emitJson) io.stdout(`\n${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (e) {
    return fail(`Evaluation failed: ${messageOf(e)}`);
  }
}

/** Entry used by `scripts/eval.mjs`. */
export function main(args: readonly string[]): Promise<number> {
  return runEvalCli(args);
}
