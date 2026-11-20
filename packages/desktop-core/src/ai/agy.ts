// Port of crates/ai-bridge/src/adapters/agy.rs: hardened Antigravity CLI adapter
// (`agy`, `06-ai-bridge.md §3.4`). Sandboxed print mode, schema via per-call file, slash commands
// disabled, prompt on stdin.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type CliAdapterConfig,
  WorkdirHandle,
  buildProbeSmokeRequest,
  combineSystemAndPrompt,
  effectivePath,
  fetchCliVersion,
  unwrapCliJsonEnvelope,
  verifyMandatoryFlags,
} from "./cli-util";
import { classifyCliFailure } from "./classify";
import { probeResult } from "./claude";
import { discoverAgyModels } from "./discovery";
import { resolveBinaryInPath, runCliSubprocess, withScopedTempDir } from "./subprocess";
import {
  AiError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type ProbeMode,
  type ProbeResult,
  type ProviderId,
  resolveTierModel,
} from "./types";

export const AGY_MIN_TESTED_VERSION = "1.5.4";
export const AGY_MANDATORY_FLAGS = [
  "--print",
  "--output-format",
  "--json-schema",
  "--print-timeout",
  "--sandbox",
  "--disable-slash-commands",
] as const;

export class AgyCliProvider implements AiProvider {
  /** Cached flag check; `hasModelsCmd` records whether `agy models` is listed in `--help`. */
  private verified: { ok: true; hasModelsCmd: boolean } | { ok: false; error: AiError } | null = null;
  private readonly wd: WorkdirHandle;

  constructor(readonly config: CliAdapterConfig) {
    this.wd = new WorkdirHandle(config.workdir);
  }

  id(): ProviderId {
    return "agy_cli";
  }

  probe(): Promise<ProbeResult> {
    return this.probeWithMode(this.config.defaultProbeMode);
  }
  probeQuick(): Promise<ProbeResult> {
    return this.probeWithMode("quick");
  }
  probeFull(): Promise<ProbeResult> {
    return this.probeWithMode("full");
  }

  async probeWithMode(mode: ProbeMode): Promise<ProbeResult> {
    const started = Date.now();
    const expanded = effectivePath(this.config);
    const fallbackModels = (): Promise<ProbeResult["available_models"]> =>
      discoverAgyModels(this.config, this.wd.path, expanded, false);

    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) {
      return probeResult({ error: AiError.notInstalled().message, available_models: await fallbackModels() });
    }

    let version: string | null;
    try {
      version = await fetchCliVersion(this.config, this.wd.path, expanded);
    } catch (e) {
      const err = e as AiError;
      return probeResult({
        installed: err.kind !== "not_installed",
        latency_ms: Date.now() - started,
        error: err.message,
        available_models: await fallbackModels(),
      });
    }

    let supportsModels: boolean;
    try {
      supportsModels = await this.verifyAndCacheFlags(expanded);
    } catch (e) {
      return probeResult({
        installed: true,
        version,
        latency_ms: Date.now() - started,
        error: (e as Error).message,
        available_models: await fallbackModels(),
      });
    }

    const availableModels = await discoverAgyModels(this.config, this.wd.path, expanded, supportsModels);

    if (mode === "quick") {
      return probeResult({
        installed: true,
        version,
        flags_supported: true,
        latency_ms: Date.now() - started,
        available_models: availableModels,
      });
    }

    const smokeReq = buildProbeSmokeRequest(this.config.probeTimeoutMs);
    let smoke = await this.attempt(smokeReq, expanded, true);
    if (
      !smoke.ok &&
      smoke.err.kind === "process" &&
      resolveTierModel(this.config.modelTiers, "agy_cli", smokeReq.tier) !== null
    ) {
      const retry = await this.attempt(smokeReq, expanded, false);
      if (retry.ok || retry.err.kind === "rate_limited") smoke = retry;
    }

    const base = { installed: true, version, flags_supported: true, available_models: availableModels };
    if (smoke.ok) return probeResult({ ...base, authenticated: true, latency_ms: smoke.resp.durationMs });
    const elapsed = Date.now() - started;
    if (smoke.err.kind === "not_authenticated") {
      return probeResult({ ...base, latency_ms: elapsed, error: AiError.notAuthenticated().message });
    }
    if (smoke.err.kind === "rate_limited") {
      return probeResult({ ...base, authenticated: true, latency_ms: elapsed, error: `rate_limited: ${smoke.err.message}` });
    }
    return probeResult({ ...base, latency_ms: elapsed, error: smoke.err.message });
  }

  private async attempt(
    req: AiRequest,
    expanded: string,
    useConfiguredModel: boolean,
  ): Promise<{ ok: true; resp: AiResponse } | { ok: false; err: AiError }> {
    try {
      return { ok: true, resp: await this.executeRequest(req, expanded, useConfiguredModel) };
    } catch (e) {
      if (e instanceof AiError) return { ok: false, err: e };
      throw e;
    }
  }

  private async ensureFlagsVerified(expanded: string): Promise<void> {
    if (this.verified) {
      if (!this.verified.ok) throw this.verified.error;
      return;
    }
    await this.verifyAndCacheFlags(expanded);
  }

  private async verifyAndCacheFlags(expanded: string): Promise<boolean> {
    const out = await runCliSubprocess(
      this.config.binaryPath,
      ["--help"],
      null,
      this.wd.path,
      expanded,
      this.config.extraEnv,
      Math.min(10_000, this.config.probeTimeoutMs),
    );
    const help = `${out.stdout}\n${out.stderr}`;
    const hasModelsCmd = help.includes("models");
    try {
      verifyMandatoryFlags("agy_cli", AGY_MIN_TESTED_VERSION, help, AGY_MANDATORY_FLAGS);
    } catch (e) {
      this.verified = { ok: false, error: e as AiError };
      throw e;
    }
    this.verified = { ok: true, hasModelsCmd };
    return hasModelsCmd;
  }

  /** Exact argument vector (exported for tests). */
  static buildArgs(schemaPath: string, resolvedModel: string | null, timeoutMs: number): string[] {
    const timeoutSecs = Math.max(1, Math.floor(timeoutMs / 1000));
    const args = ["--print", "--output-format", "json", "--json-schema", schemaPath];
    if (resolvedModel !== null) args.push("--model", resolvedModel);
    args.push("--print-timeout", `${timeoutSecs}s`, "--sandbox", "--disable-slash-commands");
    return args;
  }

  private async executeRequest(req: AiRequest, expanded: string, useConfiguredModel: boolean): Promise<AiResponse> {
    return withScopedTempDir("dealsonar-agy-call-", async (tmp) => {
      const schemaPath = path.join(tmp, "schema.json");
      try {
        await fs.writeFile(schemaPath, JSON.stringify(req.schema), { mode: 0o600 });
      } catch (e) {
        throw AiError.process(-1, `failed to write agy schema file: ${(e as Error).message}`);
      }
      const resolvedModel = useConfiguredModel ? resolveTierModel(this.config.modelTiers, "agy_cli", req.tier) : null;
      const args = AgyCliProvider.buildArgs(schemaPath, resolvedModel, req.timeoutMs);
      const raw = await runCliSubprocess(
        this.config.binaryPath,
        args,
        combineSystemAndPrompt(req.system, req.prompt),
        this.wd.path,
        expanded,
        this.config.extraEnv,
        req.timeoutMs,
      );
      if (raw.exitCode !== 0) throw classifyCliFailure("agy_cli", raw.exitCode, raw.stderr, raw.stdout);
      const { output, usage, model } = unwrapCliJsonEnvelope(raw.stdout, req.schema, resolvedModel);
      return { output, usage, model, durationMs: raw.durationMs };
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const expanded = effectivePath(this.config);
    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) throw AiError.notInstalled();
    await this.ensureFlagsVerified(expanded);
    return this.executeRequest(req, expanded, true);
  }
}
