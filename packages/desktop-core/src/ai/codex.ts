// Port of crates/ai-bridge/src/adapters/codex.rs: hardened OpenAI Codex CLI adapter
// (`codex exec`, `06-ai-bridge.md §3.3`). Read-only sandbox, ephemeral session, strict structured
// output schema, prompt on stdin, per-call temp dir removed on every path.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type CliAdapterConfig,
  WorkdirHandle,
  buildProbeSmokeRequest,
  combineSystemAndPrompt,
  effectivePath,
  fetchCliVersion,
  helpContainsFlag,
  verifyMandatoryFlags,
} from "./cli-util";
import { classifyCliFailure } from "./classify";
import { decodeStrictOutput, strictOutputSchema } from "./codex-schema";
import { discoverCodexModels } from "./discovery";
import { extractJsonValue, validateJsonSchema } from "./schema";
import { resolveBinaryInPath, runCliSubprocess, withScopedTempDir } from "./subprocess";
import {
  AiError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type ProbeMode,
  type ProbeResult,
  type ProviderId,
  type Usage,
  resolveTierModel,
} from "./types";
import { probeResult } from "./claude";

export const CODEX_MIN_TESTED_VERSION = "0.150.1";
export const CODEX_MANDATORY_FLAGS = [
  "--json",
  "--output-schema",
  "--output-last-message",
  "--sandbox",
  "--skip-git-repo-check",
  "--ephemeral",
] as const;

export interface CodexCapabilities {
  useIgnoreUserConfig: boolean;
  useIgnoreRules: boolean;
}

export interface CodexJsonlSummary {
  usage: Usage | null;
  model: string | null;
  lastAssistantText: string | null;
  errorMessage: string | null;
}

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asU64 = (v: Json): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const orElse = (...vals: Json[]): Json => vals.find((v) => v !== undefined);

/** Parse `codex exec --json` JSONL events: usage, model, last assistant text and error message. */
export function parseCodexJsonlStdout(stdout: string): CodexJsonlSummary {
  const summary: CodexJsonlSummary = { usage: null, model: null, lastAssistantText: null, errorMessage: null };
  let totalIn = 0;
  let totalOut = 0;
  let sawTokens = false;
  let totalCost: number | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let ev: Json;
    try {
      ev = JSON.parse(trimmed) as Json;
    } catch {
      continue;
    }
    if (!isObject(ev)) continue;

    if (typeof ev.model === "string" && ev.model !== "") summary.model = ev.model;

    const evType = typeof ev.type === "string" ? ev.type : "";
    if (evType === "error" || evType === "turn.failed") {
      let msg: string | null = typeof ev.message === "string" ? ev.message : null;
      if (msg === null && ev.error !== undefined) {
        const e = ev.error;
        if (isObject(e) && typeof e.message === "string") msg = e.message;
        else if (typeof e === "string") msg = e;
      }
      if (msg !== null) summary.errorMessage = msg;
    }

    if (isObject(ev.usage)) {
      const u = ev.usage;
      const inTok = asU64(orElse(u.input_tokens, u.prompt_tokens));
      const cachedIn = asU64(u.cached_input_tokens) ?? 0;
      const outTok = asU64(orElse(u.output_tokens, u.completion_tokens));
      if (inTok !== null || outTok !== null) {
        totalIn += (inTok ?? 0) + cachedIn;
        totalOut += outTok ?? 0;
        sawTokens = true;
      }
      if (typeof u.cost_usd === "number" && Number.isFinite(u.cost_usd)) {
        totalCost = (totalCost ?? 0) + u.cost_usd;
      }
    }

    if (isObject(ev.item)) {
      const item = ev.item;
      if (typeof item.text === "string") {
        summary.lastAssistantText = item.text;
      } else if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (isObject(block) && typeof block.text === "string") summary.lastAssistantText = block.text;
        }
      }
    }
  }

  if (sawTokens || totalCost !== null) {
    summary.usage = { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost };
  }
  return summary;
}

export class CodexCliProvider implements AiProvider {
  private capabilities: { ok: true; caps: CodexCapabilities } | { ok: false; error: AiError } | null = null;
  private readonly wd: WorkdirHandle;

  constructor(readonly config: CliAdapterConfig) {
    this.wd = new WorkdirHandle(config.workdir);
  }

  id(): ProviderId {
    return "codex_cli";
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
    const availableModels = discoverCodexModels(this.config);
    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) {
      return probeResult({ error: AiError.notInstalled().message, available_models: availableModels });
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
        available_models: availableModels,
      });
    }

    let caps: CodexCapabilities;
    try {
      caps = await this.detectAndCacheFlags(expanded);
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
    let smoke = await this.attempt(smokeReq, expanded, caps, true);

    // If `--ignore-user-config` strips Codex auth credentials, retry without it and cache the set.
    if (!smoke.ok && smoke.err.kind === "not_authenticated" && caps.useIgnoreUserConfig) {
      caps = { ...caps, useIgnoreUserConfig: false };
      const retry = await this.attempt(smokeReq, expanded, caps, true);
      if (retry.ok || retry.err.kind === "rate_limited") {
        this.capabilities = { ok: true, caps };
        smoke = retry;
      }
    }

    // A stale configured model name must not fail the auth probe: retry with the CLI default.
    if (
      !smoke.ok &&
      smoke.err.kind === "process" &&
      resolveTierModel(this.config.modelTiers, "codex_cli", smokeReq.tier) !== null
    ) {
      const retry = await this.attempt(smokeReq, expanded, caps, false);
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
    caps: CodexCapabilities,
    useConfiguredModel: boolean,
  ): Promise<{ ok: true; resp: AiResponse } | { ok: false; err: AiError }> {
    try {
      return { ok: true, resp: await this.executeRequest(req, expanded, caps, useConfiguredModel) };
    } catch (e) {
      if (e instanceof AiError) return { ok: false, err: e };
      throw e;
    }
  }

  private async ensureCapabilities(expanded: string): Promise<CodexCapabilities> {
    if (this.capabilities) {
      if (!this.capabilities.ok) throw this.capabilities.error;
      return this.capabilities.caps;
    }
    return this.detectAndCacheFlags(expanded);
  }

  private async detectAndCacheFlags(expanded: string): Promise<CodexCapabilities> {
    const helpTimeout = Math.min(10_000, this.config.probeTimeoutMs);
    const execHelp = await runCliSubprocess(
      this.config.binaryPath,
      ["exec", "--help"],
      null,
      this.wd.path,
      expanded,
      this.config.extraEnv,
      helpTimeout,
    );
    let combined = `${execHelp.stdout}\n${execHelp.stderr}`;

    const flagsOk = (text: string): boolean => {
      try {
        verifyMandatoryFlags("codex_cli", CODEX_MIN_TESTED_VERSION, text, CODEX_MANDATORY_FLAGS);
        return true;
      } catch {
        return false;
      }
    };

    // Flags may be documented on the root command instead of `exec`.
    if (!flagsOk(combined)) {
      try {
        const root = await runCliSubprocess(
          this.config.binaryPath,
          ["--help"],
          null,
          this.wd.path,
          expanded,
          this.config.extraEnv,
          helpTimeout,
        );
        combined += `\n${root.stdout}\n${root.stderr}`;
      } catch {
        // keep the `exec --help` text
      }
    }

    try {
      verifyMandatoryFlags("codex_cli", CODEX_MIN_TESTED_VERSION, combined, CODEX_MANDATORY_FLAGS);
    } catch (e) {
      this.capabilities = { ok: false, error: e as AiError };
      throw e;
    }
    const caps: CodexCapabilities = {
      useIgnoreUserConfig: helpContainsFlag(combined, "--ignore-user-config"),
      useIgnoreRules: helpContainsFlag(combined, "--ignore-rules"),
    };
    this.capabilities = { ok: true, caps };
    return caps;
  }

  /** Exact argument vector (exported for tests). */
  static buildArgs(
    schemaPath: string,
    outPath: string,
    resolvedModel: string | null,
    caps: CodexCapabilities,
  ): string[] {
    const args = ["exec", "--json", "--output-schema", schemaPath, "--output-last-message", outPath];
    if (resolvedModel !== null) args.push("--model", resolvedModel);
    args.push(
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      "mcp_servers.dealsonar.enabled=false",
    );
    if (caps.useIgnoreUserConfig) args.push("--ignore-user-config");
    if (caps.useIgnoreRules) args.push("--ignore-rules");
    // "-" makes `codex exec` read the prompt from stdin.
    args.push("-");
    return args;
  }

  private async executeRequest(
    req: AiRequest,
    expanded: string,
    caps: CodexCapabilities,
    useConfiguredModel: boolean,
  ): Promise<AiResponse> {
    return withScopedTempDir("dealsonar-codex-call-", async (tmp) => {
      const schemaPath = path.join(tmp, "schema.json");
      const outPath = path.join(tmp, "last_message.json");
      const wireSchema = strictOutputSchema(req.schema);
      try {
        await fs.writeFile(schemaPath, JSON.stringify(wireSchema), { mode: 0o600 });
      } catch (e) {
        throw AiError.process(-1, `failed to write codex schema file: ${(e as Error).message}`);
      }

      const resolvedModel = useConfiguredModel ? resolveTierModel(this.config.modelTiers, "codex_cli", req.tier) : null;
      const args = CodexCliProvider.buildArgs(schemaPath, outPath, resolvedModel, caps);
      const raw = await runCliSubprocess(
        this.config.binaryPath,
        args,
        combineSystemAndPrompt(req.system, req.prompt),
        this.wd.path,
        expanded,
        this.config.extraEnv,
        req.timeoutMs,
      );

      const info = parseCodexJsonlStdout(raw.stdout);

      if (raw.exitCode !== 0) {
        const ctx = info.errorMessage !== null ? `${raw.stderr}\n${info.errorMessage}` : raw.stderr;
        throw classifyCliFailure("codex_cli", raw.exitCode, ctx, raw.stdout);
      }

      if (info.errorMessage !== null) {
        const exists = await fs
          .access(outPath)
          .then(() => true)
          .catch(() => false);
        if (!exists) throw classifyCliFailure("codex_cli", 1, info.errorMessage, raw.stdout);
      }

      let rawMessage: string;
      try {
        const content = await fs.readFile(outPath, "utf8");
        rawMessage = content.trim() !== "" ? content : (info.lastAssistantText ?? raw.stdout);
      } catch {
        rawMessage = info.lastAssistantText ?? raw.stdout;
      }

      const wireOutput = extractJsonValue(rawMessage);
      validateJsonSchema(wireSchema, wireOutput);
      const output = decodeStrictOutput(req.schema, wireOutput);
      validateJsonSchema(req.schema, output);

      return { output, usage: info.usage, model: info.model ?? resolvedModel, durationMs: raw.durationMs };
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const expanded = effectivePath(this.config);
    if (!resolveBinaryInPath(this.config.binaryPath, expanded)) throw AiError.notInstalled();
    const caps = await this.ensureCapabilities(expanded);
    return this.executeRequest(req, expanded, caps, true);
  }
}
