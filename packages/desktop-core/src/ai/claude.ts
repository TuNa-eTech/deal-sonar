// Port of crates/ai-bridge/src/adapters/claude.rs: hardened Claude Code CLI adapter
// (`06-ai-bridge.md §3.2`). Tools are disabled (`--tools ""`), MCP is strict, sessions are not
// persisted, the prompt travels on stdin and the process runs in an empty workdir.

import {
  type CliAdapterConfig,
  WorkdirHandle,
  buildProbeSmokeRequest,
  effectivePath,
  fetchCliVersion,
  unwrapCliJsonEnvelope,
  verifyMandatoryFlags,
} from "./cli-util";
import { classifyCliFailure } from "./classify";
import { discoverClaudeModels } from "./discovery";
import { resolveBinaryInPath, runCliSubprocess } from "./subprocess";
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

export const CLAUDE_MIN_TESTED_VERSION = "2.1.319";
export const CLAUDE_MANDATORY_FLAGS = [
  "--print",
  "--output-format",
  "--json-schema",
  "--system-prompt",
  "--tools",
  "--strict-mcp-config",
  "--no-session-persistence",
] as const;

export function probeResult(partial: Partial<ProbeResult> & Pick<ProbeResult, "available_models">): ProbeResult {
  return {
    installed: false,
    version: null,
    authenticated: false,
    flags_supported: false,
    latency_ms: null,
    error: null,
    ...partial,
  };
}

export class ClaudeCliProvider implements AiProvider {
  private verifiedFlags: { ok: true } | { ok: false; error: AiError } | null = null;
  private readonly wd: WorkdirHandle;

  constructor(readonly config: CliAdapterConfig) {
    this.wd = new WorkdirHandle(config.workdir);
  }

  id(): ProviderId {
    return "claude_cli";
  }

  private workdir(): string {
    return this.wd.path;
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
    const availableModels = discoverClaudeModels(this.config, null);
    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) {
      return probeResult({ error: AiError.notInstalled().message, available_models: availableModels });
    }

    let version: string | null;
    try {
      version = await fetchCliVersion(this.config, this.workdir(), expanded);
    } catch (e) {
      const err = e as AiError;
      return probeResult({
        installed: err.kind !== "not_installed",
        latency_ms: Date.now() - started,
        error: err.message,
        available_models: availableModels,
      });
    }

    try {
      await this.verifyAndCacheFlags(expanded);
    } catch (e) {
      return probeResult({
        installed: true,
        version,
        latency_ms: Date.now() - started,
        error: (e as Error).message,
        available_models: availableModels,
      });
    }

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
    let smoke: { ok: true; resp: AiResponse } | { ok: false; err: AiError } = await this.attempt(smokeReq, expanded, true);
    if (
      !smoke.ok &&
      smoke.err.kind === "process" &&
      resolveTierModel(this.config.modelTiers, "claude_cli", smokeReq.tier) !== null
    ) {
      const retry = await this.attempt(smokeReq, expanded, false);
      if (retry.ok || retry.err.kind === "rate_limited") smoke = retry;
    }

    const base = { installed: true, version, flags_supported: true, available_models: availableModels };
    if (smoke.ok) {
      return probeResult({ ...base, authenticated: true, latency_ms: smoke.resp.durationMs });
    }
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
    if (this.verifiedFlags) {
      if (!this.verifiedFlags.ok) throw this.verifiedFlags.error;
      return;
    }
    await this.verifyAndCacheFlags(expanded);
  }

  private async verifyAndCacheFlags(expanded: string): Promise<void> {
    const out = await runCliSubprocess(
      this.config.binaryPath,
      ["--help"],
      null,
      this.workdir(),
      expanded,
      this.config.extraEnv,
      Math.min(10_000, this.config.probeTimeoutMs),
    );
    const help = `${out.stdout}\n${out.stderr}`;
    try {
      verifyMandatoryFlags("claude_cli", CLAUDE_MIN_TESTED_VERSION, help, CLAUDE_MANDATORY_FLAGS);
      this.verifiedFlags = { ok: true };
    } catch (e) {
      this.verifiedFlags = { ok: false, error: e as AiError };
      throw e;
    }
  }

  /** Exact argument vector (exported for tests). */
  static buildArgs(req: AiRequest, resolvedModel: string | null): string[] {
    const args = [
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.schema),
      "--system-prompt",
      req.system,
    ];
    if (resolvedModel !== null) args.push("--model", resolvedModel);
    // `--tools ""` disables every tool (`06-ai-bridge.md §3.2, §6`).
    args.push("--tools", "", "--strict-mcp-config", "--no-session-persistence");
    return args;
  }

  private async executeRequest(req: AiRequest, expanded: string, useConfiguredModel: boolean): Promise<AiResponse> {
    const resolvedModel = useConfiguredModel ? resolveTierModel(this.config.modelTiers, "claude_cli", req.tier) : null;
    const args = ClaudeCliProvider.buildArgs(req, resolvedModel);
    const raw = await runCliSubprocess(
      this.config.binaryPath,
      args,
      req.prompt,
      this.workdir(),
      expanded,
      this.config.extraEnv,
      req.timeoutMs,
    );
    if (raw.exitCode !== 0) {
      throw classifyCliFailure("claude_cli", raw.exitCode, raw.stderr, raw.stdout);
    }
    const { output, usage, model } = unwrapCliJsonEnvelope(raw.stdout, req.schema, resolvedModel);
    return { output, usage, model, durationMs: raw.durationMs };
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const expanded = effectivePath(this.config);
    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) throw AiError.notInstalled();
    await this.ensureFlagsVerified(expanded);
    return this.executeRequest(req, expanded, true);
  }
}
