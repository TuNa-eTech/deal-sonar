// Port of crates/ai-bridge/src/classify.rs: map CLI exit failures to typed `AiError`s.

import { AiError, type ProviderId } from "./types";

const MAX_STDERR_CHARS = 1000;

const AUTH_SUBSTRINGS = [
  "not logged in",
  "not authenticated",
  "authentication failed",
  "authentication error",
  "authentication required",
  "unauthenticated",
  "unauthorized",
  "http 401",
  "status 401",
  "status: 401",
  "error 401",
  "invalid api key",
  "invalid_api_key",
  "missing api key",
  "api key not found",
  "credentials not found",
  "no credentials",
  "token expired",
  "oauth token expired",
  "session expired",
  "login required",
  "please sign in",
  "please log in",
  "run `claude login`",
  "claude login",
  "claude auth login",
  "codex login",
  "codex auth",
  "agy login",
  "agy auth",
];

const RATE_LIMIT_SUBSTRINGS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "rate-limit",
  "too many requests",
  "http 429",
  "status 429",
  "status: 429",
  "error 429",
  "quota exceeded",
  "insufficient_quota",
  "usage limit",
  "out of credits",
  "exhausted your",
  "hit your limit",
  "reached your usage limit",
  "plan limit",
  "billing hard limit",
];

const REFUSAL_SUBSTRINGS = [
  "model refused",
  "content policy violation",
  "safety refusal",
  "blocked by safety",
  "refused to respond",
];

/** Rust `to_ascii_lowercase`: only ASCII letters change. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Parse a retry-after hint (JSON `retry_after_ms`, `retry_after`, or prose) into milliseconds. */
export function parseRetryAfter(text: string): number | null {
  const jsonMs = /"retry[_-]?after[_-]?ms"\s*:\s*(\d+)/i.exec(text);
  if (jsonMs) return Number(jsonMs[1]);

  const jsonSec = /"retry[_-]?after(?:_seconds)?"\s*:\s*(\d+)/i.exec(text);
  if (jsonSec) return Number(jsonSec[1]) * 1000;

  const prose =
    /(?:retry[-_ ]after|try again in|wait|resets? in)[:=\s]+(\d+)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?/i.exec(
      text,
    );
  if (prose) {
    const val = Number(prose[1]);
    const unit = (prose[2] ?? "s").toLowerCase();
    switch (unit) {
      case "ms":
      case "millisecond":
      case "milliseconds":
        return val;
      case "m":
      case "min":
      case "mins":
      case "minute":
      case "minutes":
        return val * 60_000;
      case "h":
      case "hr":
      case "hrs":
      case "hour":
      case "hours":
        return val * 3_600_000;
      default:
        return val * 1000;
    }
  }
  return null;
}

export function truncateDiagnostic(stderr: string, stdout: string): string {
  const source = stderr.trim() !== "" ? stderr.trim() : stdout.trim();
  const chars = [...source];
  if (chars.length <= MAX_STDERR_CHARS) return source;
  return `${chars.slice(0, MAX_STDERR_CHARS).join("")}...`;
}

/** Classify a non-zero exit (or an `is_error` envelope) into a typed `AiError`. */
export function classifyCliFailure(_provider: ProviderId, exitCode: number, stderr: string, stdout: string): AiError {
  const combined = `${stderr}\n${stdout}`;
  const lower = asciiLower(combined);

  if (RATE_LIMIT_SUBSTRINGS.some((p) => lower.includes(p))) {
    return AiError.rateLimited(parseRetryAfter(combined));
  }
  if (AUTH_SUBSTRINGS.some((p) => lower.includes(p))) {
    return AiError.notAuthenticated();
  }
  if (REFUSAL_SUBSTRINGS.some((p) => lower.includes(p))) {
    return AiError.refused(truncateDiagnostic(stderr, stdout));
  }
  return AiError.process(exitCode, truncateDiagnostic(stderr, stdout));
}
