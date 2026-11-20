// Port of crates/ai-bridge/src/types.rs (provider layer only): ids, tier map, request/response,
// probe result and the classified `AiError`. Task prompts/validators for judge_extract,
// suggest_fields and compile_rules belong to the pipeline port and plug in through `AiBridge`.

export type ProviderId = "claude_cli" | "codex_cli" | "agy_cli" | "mock";
export type CliProviderId = Exclude<ProviderId, "mock">;
export type ModelTier = "fast" | "smart";
export type TaskKind = "suggest_fields" | "judge_extract" | "compile_rules";
export type ProbeMode = "quick" | "full";

export interface ProviderTierModels {
  fast?: string | null;
  smart?: string | null;
}
/** `(ProviderId, ModelTier) -> --model` mapping; empty entries omit `--model`. */
export type ModelTierMap = Partial<Record<ProviderId, ProviderTierModels>>;

export function recommendedTierDefaults(): ModelTierMap {
  return {
    claude_cli: { fast: "haiku", smart: "sonnet" },
    codex_cli: { fast: "codex-mini-latest", smart: "gpt-5-codex" },
    agy_cli: { fast: "gemini-2.5-flash", smart: "gemini-2.5-pro" },
  };
}

export function setTierModel(map: ModelTierMap, provider: ProviderId, tier: ModelTier, model: string | null): void {
  const cleaned = model === null || model.trim() === "" ? null : model.trim();
  const entry = map[provider] ?? {};
  entry[tier] = cleaned;
  map[provider] = entry;
}

export function resolveTierModel(map: ModelTierMap, provider: ProviderId, tier: ModelTier): string | null {
  const model = map[provider]?.[tier];
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed === "" ? null : trimmed;
}

export interface AiRequest {
  task: TaskKind;
  system: string;
  prompt: string;
  schema: unknown;
  tier: ModelTier;
  /** Hard wall-clock limit for the CLI process (the Rust `Duration`). */
  timeoutMs: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number | null;
}

export interface AiResponse {
  output: unknown;
  usage: Usage | null;
  model: string | null;
  durationMs: number;
}

export interface AiModelOption {
  id: string;
  label: string;
  recommended_tier?: ModelTier;
  source: string;
}

export interface ProbeResult {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  flags_supported: boolean;
  latency_ms: number | null;
  error: string | null;
  available_models: AiModelOption[];
}

export type AiErrorKind =
  | "not_installed"
  | "not_authenticated"
  | "rate_limited"
  | "timeout"
  | "invalid_output"
  | "refused"
  | "security_flags_unsupported"
  | "process";

/** Rust `Debug` rendering of `Option<Duration>` used in the `RateLimited` message. */
function debugDuration(ms: number): string {
  if (ms >= 1000) {
    const secs = Math.floor(ms / 1000);
    const frac = String(ms % 1000)
      .padStart(3, "0")
      .replace(/0+$/, "");
    return frac === "" ? `${secs}s` : `${secs}.${frac}s`;
  }
  return `${ms}ms`;
}

/** Classified AI failure. `message` is the Rust `Display` string (shown in the UI / stored in ai_calls). */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly retryAfterMs: number | null;
  readonly exitCode: number | null;
  readonly detail: string;

  private constructor(kind: AiErrorKind, message: string, detail = "", retryAfterMs: number | null = null, exitCode: number | null = null) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
    this.exitCode = exitCode;
  }

  static notInstalled(): AiError {
    return new AiError("not_installed", "CLI AI chưa được cài đặt trên máy");
  }
  static notAuthenticated(): AiError {
    return new AiError("not_authenticated", "CLI AI chưa đăng nhập hoặc phiên đăng nhập đã hết hạn");
  }
  static rateLimited(retryAfterMs: number | null): AiError {
    const rendered = retryAfterMs === null ? "None" : `Some(${debugDuration(retryAfterMs)})`;
    return new AiError("rate_limited", `Đã chạm giới hạn hạn mức AI (thử lại sau: ${rendered})`, "", retryAfterMs);
  }
  static timeout(): AiError {
    return new AiError("timeout", "Lời gọi AI quá thời gian chờ");
  }
  static invalidOutput(detail: string): AiError {
    return new AiError("invalid_output", `Đầu ra AI không hợp lệ theo schema: ${detail}`, detail);
  }
  static refused(detail: string): AiError {
    return new AiError("refused", `Mô hình từ chối xử lý yêu cầu: ${detail}`, detail);
  }
  static securityFlagsUnsupported(detail: string): AiError {
    return new AiError(
      "security_flags_unsupported",
      `Phiên bản CLI không hỗ trợ các cờ bảo mật bắt buộc: ${detail}`,
      detail,
    );
  }
  static process(code: number, stderr: string): AiError {
    return new AiError("process", `Tiến trình CLI kết thúc với mã lỗi ${code}: ${stderr}`, stderr, null, code);
  }

  /** `ai_calls.status` value (`04-data-model.md §2.6`). */
  callStatus(): "ok" | "error" | "invalid_output" | "timeout" | "rate_limited" {
    switch (this.kind) {
      case "invalid_output":
        return "invalid_output";
      case "timeout":
        return "timeout";
      case "rate_limited":
        return "rate_limited";
      default:
        return "error";
    }
  }

  isBisectableBatchFailure(): boolean {
    return this.kind === "invalid_output" || this.kind === "refused";
  }
}

/** Common provider interface implemented by every CLI adapter (and by injected test doubles). */
export interface AiProvider {
  id(): ProviderId;
  probe(): Promise<ProbeResult>;
  complete(req: AiRequest): Promise<AiResponse>;
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError;
}
