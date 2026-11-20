// Port of crates/ai-bridge/src/adapters/{config,cli_util}.rs: shared adapter configuration,
// prompt assembly, version/flag probing and CLI JSON-envelope parsing.

import * as os from "node:os";
import * as path from "node:path";

import { classifyCliFailure } from "./classify";
import { extractJsonValue, probeSmokeSchema, validateJsonSchemaError } from "./schema";
import { expandedPathEnv, resolveBinaryInPath, runCliSubprocess, createScopedTempDir, type ScopedTempDir } from "./subprocess";
import {
  AiError,
  type AiRequest,
  type ModelTierMap,
  type ProbeMode,
  type ProviderId,
  type Usage,
} from "./types";

export interface CliAdapterConfig {
  /** Executable name (searched in the expanded `PATH`) or explicit binary path. */
  binaryPath: string;
  /** Dedicated empty directory used as `cwd` for every CLI invocation. */
  workdir: string | null;
  modelTiers: ModelTierMap;
  defaultProbeMode: ProbeMode;
  probeTimeoutMs: number;
  /** Explicit base `PATH` (hermetic tests). */
  pathOverride: string | null;
  /** Augment `PATH` with common user/system CLI directories (default true). */
  expandSystemPaths: boolean;
  extraEnv: Array<[string, string]>;
}

export function newCliAdapterConfig(defaultBinary: string, overrides: Partial<CliAdapterConfig> = {}): CliAdapterConfig {
  return {
    binaryPath: defaultBinary,
    workdir: null,
    modelTiers: {},
    defaultProbeMode: "full",
    probeTimeoutMs: 30_000,
    pathOverride: null,
    expandSystemPaths: true,
    extraEnv: [],
    ...overrides,
  };
}

export function effectivePath(cfg: CliAdapterConfig): string {
  const base = cfg.pathOverride ?? process.env.PATH ?? process.env.Path ?? "";
  return cfg.expandSystemPaths ? expandedPathEnv(base, null) : base;
}

/**
 * Configured `ai-workdir`, or (when none is configured) a lazily created private temporary
 * directory owned by the adapter, like the Rust `WorkdirHandle`.
 */
export class WorkdirHandle {
  private temp: ScopedTempDir | null = null;
  constructor(private readonly configured: string | null) {}
  get path(): string {
    if (this.configured !== null) return this.configured;
    if (!this.temp) this.temp = createScopedTempDir("dealsonar-ai-workdir-");
    return this.temp.path;
  }
  dispose(): void {
    this.temp?.dispose();
    this.temp = null;
  }
}

/** Combine system and user prompt into one stdin payload for CLIs without `--system-prompt`. */
export function combineSystemAndPrompt(system: string, prompt: string): string {
  const sys = system.trim();
  return sys === "" ? prompt : `<SYSTEM_INSTRUCTIONS>\n${sys}\n</SYSTEM_INSTRUCTIONS>\n\n${prompt}`;
}

export function buildProbeSmokeRequest(timeoutMs: number): AiRequest {
  return {
    task: "judge_extract",
    system: "Return strictly valid JSON matching the provided schema.",
    prompt: 'Smoke check: respond with {"ok": true}.',
    schema: probeSmokeSchema(),
    tier: "fast",
    timeoutMs,
  };
}

/** `--version` first non-empty line. */
export async function fetchCliVersion(cfg: CliAdapterConfig, workdir: string, expandedPath: string): Promise<string | null> {
  if (!resolveBinaryInPath(cfg.binaryPath, expandedPath)) throw AiError.notInstalled();
  const out = await runCliSubprocess(
    cfg.binaryPath,
    ["--version"],
    null,
    workdir,
    expandedPath,
    cfg.extraEnv,
    Math.min(10_000, cfg.probeTimeoutMs),
  );
  const combined = out.stdout.trim() !== "" ? out.stdout : out.stderr;
  const line = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? null;
}

export function helpContainsFlag(helpText: string, flag: string): boolean {
  return helpText.includes(flag);
}

export function verifyMandatoryFlags(
  provider: ProviderId,
  minTestedVersion: string,
  helpText: string,
  mandatoryFlags: readonly string[],
): void {
  const missing = mandatoryFlags.filter((flag) => !helpContainsFlag(helpText, flag));
  if (missing.length > 0) {
    throw AiError.securityFlagsUnsupported(
      `${provider} thiếu cờ bảo mật/đầu ra bắt buộc [${missing.join(", ")}] — phiên bản quá cũ, cần cập nhật (tối thiểu đã kiểm thử: ${minTestedVersion})`,
    );
  }
}

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asU64 = (v: Json): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const asF64 = (v: Json): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** `a.get(x).or_else(|| a.get(y))`: an explicit JSON `null` counts as present, like `Option<&Value>`. */
const firstDefined = (...vals: Json[]): Json => vals.find((v) => v !== undefined);

export function extractUsageFromObj(val: Json): Usage | null {
  if (!isObject(val)) return null;
  const usageObj = isObject(val.usage) ? val.usage : null;
  const costUsd =
    asF64(firstDefined(val.total_cost_usd, val.cost_usd)) ??
    (usageObj ? asF64(firstDefined(usageObj.cost_usd, usageObj.total_cost_usd)) : null);

  if (usageObj) {
    const baseIn = asU64(firstDefined(usageObj.input_tokens, usageObj.prompt_tokens, usageObj.promptTokenCount));
    const cacheCreate = asU64(usageObj.cache_creation_input_tokens) ?? 0;
    const cacheRead = asU64(usageObj.cache_read_input_tokens) ?? 0;
    const outTok = asU64(firstDefined(usageObj.output_tokens, usageObj.completion_tokens, usageObj.candidatesTokenCount));
    if (baseIn !== null || outTok !== null || costUsd !== null) {
      return {
        input_tokens: (baseIn ?? 0) + cacheCreate + cacheRead,
        output_tokens: outTok ?? 0,
        cost_usd: costUsd,
      };
    }
  }
  return costUsd !== null ? { input_tokens: 0, output_tokens: 0, cost_usd: costUsd } : null;
}

export function extractModelFromObj(val: Json): string | null {
  if (!isObject(val)) return null;
  const m = firstDefined(val.model, val.modelVersion);
  if (typeof m === "string" && m !== "") return m;
  if (isObject(val.modelUsage)) {
    // serde_json's default map is ordered by key.
    const first = Object.keys(val.modelUsage).sort()[0];
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * Parse the wrapper JSON of `--output-format json` CLIs (`claude`, `agy`) into
 * `(payload, usage, model)`, preferring the first candidate that satisfies `expectedSchema`.
 */
export function unwrapCliJsonEnvelope(
  rawStdout: string,
  expectedSchema: Json,
  fallbackModel: string | null,
): { output: Json; usage: Usage | null; model: string | null } {
  const top = extractJsonValue(rawStdout);

  if (isObject(top)) {
    if (top.is_error === true) {
      const v = firstDefined(top.result, top.error, top.message);
      const errMsg = v === undefined ? "CLI reported is_error=true" : typeof v === "string" ? v : JSON.stringify(v);
      throw classifyCliFailure("claude_cli", 1, errMsg, rawStdout);
    }
    if (top.stop_reason === "refusal" || top.subtype === "refusal") {
      const m = firstDefined(top.refusal, top.result);
      throw AiError.refused(typeof m === "string" ? m : "model refused request");
    }
  }

  const usage = extractUsageFromObj(top);
  const model = extractModelFromObj(top) ?? fallbackModel;

  const candidates: Json[] = [];
  if (isObject(top)) {
    if (top.structured_output !== undefined && top.structured_output !== null) candidates.push(top.structured_output);
    for (const key of ["result", "output", "response", "data"]) {
      const val = top[key];
      if (val === undefined || val === null) continue;
      if (typeof val === "string") {
        try {
          candidates.push(extractJsonValue(val));
        } catch {
          // not JSON text
        }
      } else if (typeof val === "object") {
        candidates.push(val);
      }
    }
    if (Array.isArray(top.content)) {
      for (const item of top.content) {
        if (isObject(item) && isObject(item.input)) candidates.push(item.input);
        if (isObject(item) && typeof item.text === "string") {
          try {
            candidates.push(extractJsonValue(item.text));
          } catch {
            // not JSON text
          }
        }
      }
    }
  }
  candidates.push(top);

  let firstErr: string | null = null;
  for (const cand of candidates) {
    const err = validateJsonSchemaError(expectedSchema, cand);
    if (err === null) return { output: cand, usage, model };
    if (firstErr === null) firstErr = err;
  }
  throw AiError.invalidOutput(firstErr ?? "output did not match schema");
}

/** `$HOME` for CLI model-cache discovery: `HOME`/`USERPROFILE` from extra env, then the process. */
export function userHomeDir(cfg: CliAdapterConfig): string | null {
  for (const [k, v] of cfg.extraEnv) {
    if ((k === "HOME" || k === "USERPROFILE") && v.trim() !== "") return v;
  }
  const env = process.env.HOME || process.env.USERPROFILE;
  if (env) return env;
  const home = os.homedir();
  return home ? home : null;
}

export const joinHome = (home: string, ...parts: string[]): string => path.join(home, ...parts);
