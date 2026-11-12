use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;

use crate::types::{AiError, ProviderId};

const MAX_STDERR_CHARS: usize = 1000;

/// Pattern table entry for classifying CLI errors (`06-ai-bridge.md §3.5`).
struct ClassifierPatterns {
    auth_substrings: &'static [&'static str],
    rate_limit_substrings: &'static [&'static str],
    refusal_substrings: &'static [&'static str],
}

const COMMON_PATTERNS: ClassifierPatterns = ClassifierPatterns {
    auth_substrings: &[
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
    ],
    rate_limit_substrings: &[
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
    ],
    refusal_substrings: &[
        "model refused",
        "content policy violation",
        "safety refusal",
        "blocked by safety",
        "refused to respond",
    ],
};

/// Parses a human or header `retry_after` duration from stderr/stdout text or JSON.
pub fn parse_retry_after(text: &str) -> Option<Duration> {
    static JSON_MS_RE: OnceLock<Regex> = OnceLock::new();
    static JSON_SEC_RE: OnceLock<Regex> = OnceLock::new();
    static PROSE_RE: OnceLock<Regex> = OnceLock::new();

    let json_ms_re = JSON_MS_RE.get_or_init(|| {
        Regex::new(r#"(?i)"retry[_-]?after[_-]?ms"\s*:\s*(\d+)"#).expect("valid regex")
    });
    if let Some(caps) = json_ms_re.captures(text) {
        if let Ok(ms) = caps[1].parse::<u64>() {
            return Some(Duration::from_millis(ms));
        }
    }

    let json_sec_re = JSON_SEC_RE.get_or_init(|| {
        Regex::new(r#"(?i)"retry[_-]?after(?:_seconds)?"\s*:\s*(\d+)"#).expect("valid regex")
    });
    if let Some(caps) = json_sec_re.captures(text) {
        if let Ok(secs) = caps[1].parse::<u64>() {
            return Some(Duration::from_secs(secs));
        }
    }

    let prose_re = PROSE_RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:retry[-_ ]after|try again in|wait|resets? in)[:=\s]+(\d+)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?",
        )
        .expect("valid regex")
    });
    if let Some(caps) = prose_re.captures(text) {
        if let Ok(val) = caps[1].parse::<u64>() {
            let unit = caps
                .get(2)
                .map(|m| m.as_str().to_ascii_lowercase())
                .unwrap_or_else(|| "s".to_string());
            let dur = match unit.as_str() {
                "ms" | "millisecond" | "milliseconds" => Duration::from_millis(val),
                "m" | "min" | "mins" | "minute" | "minutes" => Duration::from_secs(val * 60),
                "h" | "hr" | "hrs" | "hour" | "hours" => Duration::from_secs(val * 3600),
                _ => Duration::from_secs(val),
            };
            return Some(dur);
        }
    }

    None
}

/// Classifies a non-zero exit code and stderr/stdout text into a typed `AiError`.
pub fn classify_cli_failure(
    _provider: ProviderId,
    exit_code: i32,
    stderr: &str,
    stdout: &str,
) -> AiError {
    let combined = format!("{stderr}\n{stdout}");
    let lower = combined.to_ascii_lowercase();

    for pat in COMMON_PATTERNS.rate_limit_substrings {
        if lower.contains(pat) {
            return AiError::RateLimited {
                retry_after: parse_retry_after(&combined),
            };
        }
    }

    for pat in COMMON_PATTERNS.auth_substrings {
        if lower.contains(pat) {
            return AiError::NotAuthenticated;
        }
    }

    for pat in COMMON_PATTERNS.refusal_substrings {
        if lower.contains(pat) {
            return AiError::Refused(truncate_diagnostic(stderr, stdout));
        }
    }

    AiError::Process {
        code: exit_code,
        stderr: truncate_diagnostic(stderr, stdout),
    }
}

pub(crate) fn truncate_diagnostic(stderr: &str, stdout: &str) -> String {
    let source = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let mut out = String::new();
    for (idx, ch) in source.chars().enumerate() {
        if idx >= MAX_STDERR_CHARS {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}
