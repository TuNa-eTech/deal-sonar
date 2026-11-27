use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::extractors::phone::{extract_vn_phone, normalize_vn_phone_str};
use crate::normalize::fold_text;

/// Minimum character count required when a post has no attachments (`05-pipeline-rules.md §5`).
pub const PREFILTER_MIN_CHARS_NO_MEDIA: usize = 15;

/// Kind of blocklist entry (`04-data-model.md §2.5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlocklistKind {
    Author,
    Phone,
    Keyword,
}

/// Blocklist item for T3 prefilter (`04-data-model.md §2.5`, `05-pipeline-rules.md §5`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocklistEntry {
    pub kind: BlocklistKind,
    pub value: String,
}

/// Reason a post was rejected in T3 prefilter (`05-pipeline-rules.md §5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefilterRejectReason {
    /// Author, phone, or keyword matched `blocklist` (`reject_reason = "blocked"`).
    Blocked(BlocklistKind),
    /// Empty or `< 15` chars without attachments (`reject_reason = "prefilter"`).
    TooShort,
    /// Post consists solely of URL(s) (`reject_reason = "prefilter"`).
    UrlOnly,
    /// Rejected by the active ruleset's `prefilter` section (`reject_reason = "prefilter"`).
    RulesetPrefilter,
}

impl PrefilterRejectReason {
    /// Canonical SQLite `evaluations.reject_reason` string (`04-data-model.md §2.4`).
    pub const fn as_db_reject_reason(&self) -> &'static str {
        match self {
            Self::Blocked(_) => "blocked",
            Self::TooShort | Self::UrlOnly | Self::RulesetPrefilter => "prefilter",
        }
    }
}

/// Input bundle for basic T3 prefilter checks (steps 1–3 of `05-pipeline-rules.md §5`).
#[derive(Debug, Clone)]
pub struct BasicPrefilterInput<'a> {
    pub author_id: Option<&'a str>,
    pub text_norm: &'a str,
    pub text_fold: &'a str,
    pub has_attachments: bool,
}

/// Check whether a post is empty, or shorter than 15 characters without attachments (`05-pipeline-rules.md §5`).
pub fn is_too_short(text_norm: &str, has_attachments: bool) -> bool {
    let trimmed = text_norm.trim();
    if trimmed.is_empty() {
        return true;
    }
    !has_attachments && trimmed.chars().count() < PREFILTER_MIN_CHARS_NO_MEDIA
}

static BARE_DOMAIN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|vn|net|org|io|me|ly|be|co|info|gg|app|link|shop|xyz|online|store|site|top|watch|edu|gov|asia|biz|tv|cc|gl)(?:/\S*)?$",
    )
    .expect("valid bare domain regex")
});

/// Check whether a non-empty post consists solely of one or more URLs (`05-pipeline-rules.md §5`).
pub fn is_url_only(text_norm: &str) -> bool {
    let trimmed = text_norm.trim();
    if trimmed.is_empty() {
        return false;
    }

    let mut count = 0usize;
    for raw_token in trimmed.split_whitespace() {
        let token = raw_token.trim_matches(|c: char| {
            matches!(
                c,
                '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '"' | '\''
            )
        });
        let token = token.trim_end_matches('.');
        if token.is_empty() {
            continue;
        }
        count += 1;
        if !is_single_url_token(token) {
            return false;
        }
    }
    count > 0
}

fn is_single_url_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    {
        return rest.contains('.') && rest.len() >= 4 && !rest.starts_with('.');
    }
    if let Some(rest) = lower.strip_prefix("www.") {
        return rest.contains('.') && rest.len() >= 4;
    }
    BARE_DOMAIN_RE.is_match(token)
}

#[inline(always)]
pub(crate) fn has_alnum_before(s: &str, byte_idx: usize) -> bool {
    if byte_idx == 0 {
        return false;
    }
    let prev = s.as_bytes()[byte_idx - 1];
    if prev < 0x80 {
        prev.is_ascii_alphanumeric()
    } else {
        s[..byte_idx]
            .chars()
            .next_back()
            .map(|c| c.is_alphanumeric())
            .unwrap_or(false)
    }
}

#[inline(always)]
pub(crate) fn has_alnum_at(s: &str, byte_idx: usize) -> bool {
    let bytes = s.as_bytes();
    if byte_idx >= bytes.len() {
        return false;
    }
    let cur = bytes[byte_idx];
    if cur < 0x80 {
        cur.is_ascii_alphanumeric()
    } else {
        s[byte_idx..]
            .chars()
            .next()
            .map(|c| c.is_alphanumeric())
            .unwrap_or(false)
    }
}

/// Word-boundary-aware match of an already-folded keyword/phrase inside `text_fold`.
///
/// Prevents Vietnamese false positives such as `"an"` matching `"can"` or `"mua"` matching `"muon"`,
/// while matching multi-word phrases (`"can thue"`, `"ben em co"`) cleanly.
pub fn kw_contains_folded(text_fold: &str, needle_fold: &str) -> bool {
    let needle = needle_fold.trim();
    if needle.is_empty() || needle.len() > text_fold.len() {
        return false;
    }
    let check_left = has_alnum_at(needle, 0);
    let check_right = has_alnum_before(needle, needle.len());

    let mut search_from = 0usize;
    while let Some(rel) = text_fold[search_from..].find(needle) {
        let start = search_from + rel;
        let end = start + needle.len();

        let left_ok = !check_left || !has_alnum_before(text_fold, start);
        let right_ok = !check_right || !has_alnum_at(text_fold, end);

        if left_ok && right_ok {
            return true;
        }

        let next_b = text_fold.as_bytes()[start];
        let step = if next_b < 0x80 {
            1
        } else {
            text_fold[start..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(1)
        };
        search_from = start + step;
    }

    false
}

/// Check if `text_fold` matches a blocklist keyword (folding the keyword automatically).
pub fn matches_blocklist_keyword(text_fold: &str, keyword: &str) -> bool {
    let kw_fold = fold_text(keyword);
    kw_contains_folded(text_fold, &kw_fold)
}

/// Check if any phone extracted from `text_norm` matches a blocked phone number (in E.164 or domestic form).
pub fn matches_blocklist_phone(text_norm: &str, blocked_phones: &[String]) -> bool {
    if blocked_phones.is_empty() {
        return false;
    }
    let extracted = extract_vn_phone(text_norm);
    if extracted.is_empty() {
        return false;
    }
    for m in &extracted {
        if let Some(e164) = m.value.as_str() {
            for blocked in blocked_phones {
                let norm_blocked =
                    normalize_vn_phone_str(blocked).unwrap_or_else(|| blocked.trim().to_string());
                if norm_blocked == e164 {
                    return true;
                }
            }
        }
    }
    false
}

/// Check author, extracted phones, and keywords against a list of [`BlocklistEntry`] items.
pub fn matches_blocklist(
    author_id: Option<&str>,
    text_norm: &str,
    text_fold: &str,
    entries: &[BlocklistEntry],
) -> Option<BlocklistKind> {
    if entries.is_empty() {
        return None;
    }

    if let Some(aid) = author_id {
        let aid_trimmed = aid.trim();
        if !aid_trimmed.is_empty()
            && entries
                .iter()
                .any(|e| e.kind == BlocklistKind::Author && e.value.trim() == aid_trimmed)
        {
            return Some(BlocklistKind::Author);
        }
    }

    let has_phone_entries = entries.iter().any(|e| e.kind == BlocklistKind::Phone);
    if has_phone_entries {
        let extracted = extract_vn_phone(text_norm);
        for m in &extracted {
            if let Some(e164) = m.value.as_str() {
                for entry in entries.iter().filter(|e| e.kind == BlocklistKind::Phone) {
                    let norm_blocked = normalize_vn_phone_str(&entry.value)
                        .unwrap_or_else(|| entry.value.trim().to_string());
                    if norm_blocked == e164 {
                        return Some(BlocklistKind::Phone);
                    }
                }
            }
        }
    }

    for entry in entries.iter().filter(|e| e.kind == BlocklistKind::Keyword) {
        if matches_blocklist_keyword(text_fold, &entry.value) {
            return Some(BlocklistKind::Keyword);
        }
    }

    None
}

/// Execute T3 steps 1–3 (`05-pipeline-rules.md §5`):
/// 1. Blocklist (author, phone, keyword) -> `Blocked`
/// 2. Empty or `< 15` chars without attachments -> `TooShort`
/// 3. URL-only post -> `UrlOnly`
pub fn run_basic_prefilter(
    input: &BasicPrefilterInput<'_>,
    blocklist: &[BlocklistEntry],
) -> Option<PrefilterRejectReason> {
    if let Some(kind) =
        matches_blocklist(input.author_id, input.text_norm, input.text_fold, blocklist)
    {
        return Some(PrefilterRejectReason::Blocked(kind));
    }
    if is_too_short(input.text_norm, input.has_attachments) {
        return Some(PrefilterRejectReason::TooShort);
    }
    if is_url_only(input.text_norm) {
        return Some(PrefilterRejectReason::UrlOnly);
    }
    None
}
