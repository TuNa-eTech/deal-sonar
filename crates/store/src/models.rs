use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

/// Generate a new monotonic-style ULID string.
pub fn new_ulid() -> String {
    Ulid::new().to_string()
}

/// Current Unix timestamp in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Validate a dynamic radar field key against `^[a-z][a-z0-9_]{0,30}$`.
pub fn is_valid_field_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 31 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// Split a 64-bit SimHash (`i64` two's complement representation) into four 16-bit bands.
pub fn simhash_bands(simhash: i64) -> [u16; 4] {
    let u = simhash as u64;
    [
        (u & 0xFFFF) as u16,
        ((u >> 16) & 0xFFFF) as u16,
        ((u >> 32) & 0xFFFF) as u16,
        ((u >> 48) & 0xFFFF) as u16,
    ]
}

/// Exact 64-bit Hamming distance between two SimHash values.
pub fn hamming_distance(a: i64, b: i64) -> u32 {
    ((a as u64) ^ (b as u64)).count_ones()
}

/// Fold Vietnamese diacritics (including `đ`/`Đ` -> `d`), lowercase, and collapse whitespace.
pub fn fold_vi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_space = true;
    for ch in input.chars() {
        if ('\u{0300}'..='\u{036F}').contains(&ch) {
            continue;
        }
        let mapped = map_vi_char(ch);
        if mapped.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            for lc in mapped.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn map_vi_char(ch: char) -> char {
    match ch {
        'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ' | 'ấ' | 'ẩ'
        | 'ẫ' | 'ậ' | 'À' | 'Á' | 'Ả' | 'Ã' | 'Ạ' | 'Ă' | 'Ằ' | 'Ắ' | 'Ẳ' | 'Ẵ' | 'Ặ' | 'Â'
        | 'Ầ' | 'Ấ' | 'Ẩ' | 'Ẫ' | 'Ậ' => 'a',
        'đ' | 'Đ' => 'd',
        'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' | 'È' | 'É' | 'Ẻ' | 'Ẽ'
        | 'Ẹ' | 'Ê' | 'Ề' | 'Ế' | 'Ể' | 'Ễ' | 'Ệ' => 'e',
        'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' | 'Ì' | 'Í' | 'Ỉ' | 'Ĩ' | 'Ị' => 'i',
        'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ' | 'ớ' | 'ở'
        | 'ỡ' | 'ợ' | 'Ò' | 'Ó' | 'Ỏ' | 'Õ' | 'Ọ' | 'Ô' | 'Ồ' | 'Ố' | 'Ổ' | 'Ỗ' | 'Ộ' | 'Ơ'
        | 'Ờ' | 'Ớ' | 'Ở' | 'Ỡ' | 'Ợ' => 'o',
        'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' | 'Ù' | 'Ú' | 'Ủ' | 'Ũ'
        | 'Ụ' | 'Ư' | 'Ừ' | 'Ứ' | 'Ử' | 'Ữ' | 'Ự' => 'u',
        'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' | 'Ỳ' | 'Ý' | 'Ỷ' | 'Ỹ' | 'Ỵ' => 'y',
        other => other,
    }
}

/// Sanitize arbitrary user search text into a safe FTS5 `MATCH` expression.
/// Expands `d`/`đ` variants per token (up to 3 positions) because SQLite's `unicode61 remove_diacritics 2`
/// strips combining marks (`Cầu Giấy` -> `cau giay`) but keeps stroked `đ` (`Đống Đa` -> `đong đa`).
/// Returns `None` if no searchable alphanumeric tokens exist.
pub fn build_fts5_query(raw: &str) -> Option<String> {
    let tokens: Vec<&str> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(16)
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let parts: Vec<String> = tokens
        .into_iter()
        .map(|tok| {
            let variants = expand_vi_d_variants(tok);
            if variants.len() == 1 {
                let escaped = variants[0].replace('"', "\"\"");
                format!("\"{escaped}\"*")
            } else {
                let disj: Vec<String> = variants
                    .into_iter()
                    .map(|v| {
                        let escaped = v.replace('"', "\"\"");
                        format!("\"{escaped}\"*")
                    })
                    .collect();
                format!("({})", disj.join(" OR "))
            }
        })
        .collect();
    Some(parts.join(" AND "))
}

fn expand_vi_d_variants(token: &str) -> Vec<String> {
    let lower_chars: Vec<char> = token.chars().flat_map(|c| c.to_lowercase()).collect();
    let d_positions: Vec<usize> = lower_chars
        .iter()
        .enumerate()
        .filter_map(|(idx, c)| matches!(*c, 'd' | 'đ').then_some(idx))
        .collect();

    if d_positions.is_empty() || d_positions.len() > 3 {
        return vec![lower_chars.into_iter().collect()];
    }

    let combos = 1usize << d_positions.len();
    let mut out = Vec::with_capacity(combos);
    for mask in 0..combos {
        let mut buf = lower_chars.clone();
        for (bit_idx, &char_pos) in d_positions.iter().enumerate() {
            buf[char_pos] = if (mask & (1 << bit_idx)) != 0 {
                'đ'
            } else {
                'd'
            };
        }
        out.push(buf.into_iter().collect());
    }
    out
}

/// Lightweight Vietnamese E.164 phone extractor used during post ingestion so peer phone signals
/// work across all captured posts even before T4/T5 evaluation.
pub fn extract_e164_phones_light(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];
        let starts_plus84 = ch == '+' && i + 2 < len && chars[i + 1] == '8' && chars[i + 2] == '4';
        let starts_zero = ch == '0'
            || ((ch == 'o' || ch == 'O')
                && (i == 0 || !chars[i - 1].is_alphabetic())
                && i + 1 < len
                && chars[i + 1].is_ascii_digit());
        let starts_84 = ch == '8'
            && i + 1 < len
            && chars[i + 1] == '4'
            && (i == 0 || !chars[i - 1].is_ascii_digit());

        if starts_plus84 || starts_zero || starts_84 {
            let mut digits = String::new();
            let mut j = i;
            if starts_plus84 {
                digits.push_str("84");
                j += 3;
            } else if starts_zero {
                digits.push('0');
                j += 1;
            } else {
                digits.push_str("84");
                j += 2;
            }

            while j < len && digits.len() < 13 {
                let c = chars[j];
                if c.is_ascii_digit() {
                    digits.push(c);
                    j += 1;
                } else if c == '.' || c == '-' || c == ' ' {
                    // Only consume separator if followed immediately by a digit
                    if j + 1 < len && chars[j + 1].is_ascii_digit() {
                        j += 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }

            // Ensure we didn't stop right in the middle of a longer number
            let trailing_digit = j < len && chars[j].is_ascii_digit();
            if !trailing_digit {
                if let Some(e164) = normalize_vn_digits_to_e164(&digits) {
                    if !results.contains(&e164) {
                        results.push(e164);
                    }
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }

    results
}

fn normalize_vn_digits_to_e164(digits: &str) -> Option<String> {
    if let Some(rest) = digits.strip_prefix("0") {
        // Mobile (9 digits after 0 -> total 10) or landline (02x... total 10 or 11)
        let first = rest.as_bytes().first().copied()?;
        let valid = matches!(first, b'3' | b'5' | b'7' | b'8' | b'9') && rest.len() == 9
            || (first == b'2' && (rest.len() == 9 || rest.len() == 10));
        if valid {
            return Some(format!("+84{rest}"));
        }
    } else if let Some(rest) = digits.strip_prefix("84") {
        let first = rest.as_bytes().first().copied()?;
        let valid = matches!(first, b'3' | b'5' | b'7' | b'8' | b'9') && rest.len() == 9
            || (first == b'2' && (rest.len() == 9 || rest.len() == 10));
        if valid {
            return Some(format!("+84{rest}"));
        }
    }
    None
}

// ============================================================================
// Shared Domain Contracts (02-radar-spec.md §3.1–3.3)
// ============================================================================

fn default_true() -> bool {
    true
}

fn default_confidence() -> f64 {
    1.0
}

fn default_notify_mode() -> String {
    "instant".to_string()
}

fn default_min_score() -> f64 {
    0.6
}

fn default_want_intent() -> String {
    "any".to_string()
}

fn default_when_missing() -> String {
    "pass".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Number,
    Money,
    Phone,
    Location,
    Enum,
    MultiEnum,
    Boolean,
    Date,
    Range,
    Url,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: FieldType,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub show_in_alert: bool,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Ai,
    Rule,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: serde_json::Value,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    pub source: FieldSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuietHours {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotifyConfig {
    #[serde(default)]
    pub channel_ids: Vec<String>,
    #[serde(default = "default_notify_mode")]
    pub mode: String,
    #[serde(default = "default_min_score")]
    pub min_score: f64,
    #[serde(default)]
    pub quiet_hours: Option<QuietHours>,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            channel_ids: Vec::new(),
            mode: default_notify_mode(),
            min_score: default_min_score(),
            quiet_hours: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    In,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    Contains,
    IsEmpty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardFilter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: serde_json::Value,
    #[serde(default = "default_when_missing")]
    pub when_missing: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchPolicy {
    #[serde(default = "default_want_intent")]
    pub want_intent: String,
    #[serde(default)]
    pub exclude_roles: Vec<String>,
    #[serde(default)]
    pub hard_filters: Vec<HardFilter>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for MatchPolicy {
    fn default() -> Self {
        Self {
            want_intent: default_want_intent(),
            exclude_roles: vec!["peer".to_string()],
            hard_filters: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

// ============================================================================
// Sources & Crawl Runs
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredSourceInput {
    #[serde(default = "default_facebook_platform")]
    pub platform: String,
    #[serde(default = "default_group_kind")]
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub url: String,
    pub privacy: Option<String>,
    pub member_count: Option<i64>,
}

fn default_facebook_platform() -> String {
    "facebook".to_string()
}

fn default_group_kind() -> String {
    "group".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpsertSourcesResult {
    pub inserted: usize,
    pub updated: usize,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub id: String,
    pub platform: String,
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub url: String,
    pub privacy: Option<String>,
    pub member_count: Option<i64>,
    pub profile_id: Option<String>,
    pub followed: bool,
    pub priority: i32,
    pub state: String,
    pub last_crawl_at: Option<i64>,
    pub avg_new_posts: f64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceListItem {
    #[serde(flatten)]
    pub source: SourceRecord,
    pub stored_post_count: i64,
    pub posts_last_24h: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrawlRunInput {
    pub id: String,
    pub source_id: String,
    pub reason: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub posts_seen: i64,
    pub posts_new: i64,
    pub page_loads: i64,
    pub strategy: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrawlRunRecord {
    pub id: String,
    pub source_id: String,
    pub source_name: Option<String>,
    pub reason: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub posts_seen: i64,
    pub posts_new: i64,
    pub page_loads: i64,
    pub strategy: Option<String>,
    pub error: Option<String>,
}

// ============================================================================
// Posts, Authors & Dedup Clusters
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorInput {
    pub external_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub is_anonymous: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorRecord {
    pub id: String,
    pub platform: String,
    pub external_id: Option<String>,
    pub name: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub post_count_7d: i64,
    pub group_count_7d: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewPost {
    pub id: Option<String>,
    pub platform: String,
    pub external_id: String,
    pub source_id: String,
    pub author: Option<AuthorInput>,
    pub permalink: String,
    pub text: Option<String>,
    pub text_norm: Option<String>,
    pub text_fold: Option<String>,
    #[serde(default)]
    pub text_truncated: bool,
    pub lang: Option<String>,
    pub content_hash: String,
    pub simhash: i64,
    pub attachments: Option<serde_json::Value>,
    pub counts: Option<serde_json::Value>,
    #[serde(default)]
    pub extracted_phones: Vec<String>,
    pub created_at: Option<i64>,
    pub captured_at: i64,
    pub strategy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostRecord {
    pub id: String,
    pub platform: String,
    pub external_id: String,
    pub source_id: String,
    pub author_id: Option<String>,
    pub permalink: String,
    pub text: Option<String>,
    pub text_norm: Option<String>,
    pub text_fold: Option<String>,
    pub text_truncated: bool,
    pub lang: Option<String>,
    pub content_hash: String,
    pub simhash: i64,
    pub simhash_bands: [u16; 4],
    pub dup_cluster_id: Option<String>,
    pub is_cluster_head: bool,
    pub attachments: Option<serde_json::Value>,
    pub counts: Option<serde_json::Value>,
    pub extracted_phones: Vec<String>,
    pub created_at: Option<i64>,
    pub captured_at: i64,
    pub strategy: String,
    pub purged_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostDetail {
    #[serde(flatten)]
    pub post: PostRecord,
    pub source_name: String,
    pub author_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimhashMatch {
    pub post: PostRecord,
    pub hamming_distance: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DupClusterRecord {
    pub id: String,
    pub head_post_id: String,
    pub size: i64,
    pub source_count: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlsoSeenInEntry {
    pub post_id: String,
    pub source_id: String,
    pub source_name: String,
    pub permalink: String,
    pub captured_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachDupResult {
    pub cluster: DupClusterRecord,
    pub is_repost_after_72h: bool,
    pub updated_lead_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerSignals {
    pub author_post_count_7d: i64,
    pub author_followed_posts_7d: i64,
    pub author_group_count_7d: i64,
    pub cluster_source_count: i64,
    pub max_distinct_authors_for_phone: i64,
    pub signal_count: u8,
    pub is_peer_override: bool,
}

// ============================================================================
// Radars, Versions & Rulesets
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarRecord {
    pub id: String,
    pub name: String,
    pub status: String,
    pub template_id: Option<String>,
    pub current_version: i32,
    pub notify: NotifyConfig,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarVersionRecord {
    pub id: String,
    pub radar_id: String,
    pub version: i32,
    pub description: String,
    pub language_hint: Option<String>,
    pub user_profession: Option<String>,
    pub fields: Vec<FieldDef>,
    pub match_policy: MatchPolicy,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarWithVersion {
    pub radar: RadarRecord,
    pub current_version: RadarVersionRecord,
    pub candidate_version: Option<RadarVersionRecord>,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateRadarDraftInput {
    pub id: Option<String>,
    pub name: String,
    pub template_id: Option<String>,
    pub description: String,
    pub language_hint: Option<String>,
    pub user_profession: Option<String>,
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub match_policy: MatchPolicy,
    #[serde(default)]
    pub notify: NotifyConfig,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRadarInput {
    pub name: Option<String>,
    pub notify: Option<NotifyConfig>,
    pub source_ids: Option<Vec<String>>,
    pub description: Option<String>,
    pub language_hint: Option<Option<String>>,
    pub user_profession: Option<Option<String>>,
    pub fields: Option<Vec<FieldDef>>,
    pub match_policy: Option<MatchPolicy>,
    /// When `false` (default) on an `active` radar, definition edits create a candidate preview
    /// `radar_versions` row while keeping `radars.current_version` unchanged until confirmed.
    /// Set `true` to immediately switch `radars.current_version` to the new version.
    #[serde(default)]
    pub activate_immediately: bool,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarUpdateResult {
    pub radar: RadarWithVersion,
    pub version_created: Option<RadarVersionRecord>,
    pub pending_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarListItem {
    pub radar: RadarRecord,
    pub current_version: RadarVersionRecord,
    pub source_ids: Vec<String>,
    pub leads_24h: i64,
    pub evaluated_posts_total: i64,
    pub false_positive_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarFunnelStats {
    pub total_evaluated: i64,
    pub dedup_rejected: i64,
    pub prefilter_rejected: i64,
    pub rule_decided: i64,
    pub rule_matched: i64,
    pub ai_decided: i64,
    pub ai_matched: i64,
    pub postfilter_rejected: i64,
    pub pending_ai: i64,
    pub ai_failed: i64,
    pub leads_total: i64,
    pub leads_notified: i64,
    pub leads_weak_match: i64,
    pub false_positive_count: i64,
    pub false_positive_rate: f64,
    pub rule_handled_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewRulesetInput {
    pub id: Option<String>,
    pub radar_version_id: String,
    pub state: String,
    pub origin: String,
    pub body: serde_json::Value,
    pub metrics: Option<serde_json::Value>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetRecord {
    pub id: String,
    pub radar_version_id: String,
    pub revision: i32,
    pub state: String,
    pub origin: String,
    pub body: serde_json::Value,
    pub metrics: Option<serde_json::Value>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
}

// ============================================================================
// Evaluations, Leads, Feedback & Dynamic Query
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationUpsertInput {
    pub id: Option<String>,
    pub post_id: String,
    pub radar_version_id: String,
    pub state: String,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    #[serde(default)]
    pub is_preview: bool,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationDoneInput {
    pub decided_by: String,
    pub verdict: String,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub decided_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRecord {
    pub id: String,
    pub post_id: String,
    pub radar_version_id: String,
    pub state: String,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
    pub is_preview: bool,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingAiEvaluationItem {
    pub evaluation: EvaluationRecord,
    pub post: PostRecord,
    pub source_name: String,
    pub author_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingAiGroup {
    pub radar_version_id: String,
    pub is_preview: bool,
    pub count: usize,
    pub oldest_created_at: i64,
    pub items: Vec<PendingAiEvaluationItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedEvaluationItem {
    pub evaluation_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub post_text: Option<String>,
    pub permalink: String,
    pub source_id: String,
    pub source_name: String,
    pub author_name: Option<String>,
    pub decided_by: Option<String>,
    pub reject_reason: Option<String>,
    pub score: Option<f64>,
    pub reason: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateLeadInput {
    pub id: Option<String>,
    pub radar_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    #[serde(default = "default_lead_status")]
    pub status: String,
    pub score: f64,
    pub summary: String,
    pub fields: BTreeMap<String, ExtractedField>,
    pub also_seen_in: Option<Vec<AlsoSeenInEntry>>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Option<Vec<String>>,
    pub now_ms: i64,
}

fn default_lead_status() -> String {
    "new".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadRecord {
    pub id: String,
    pub radar_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    pub status: String,
    pub score: f64,
    pub summary: String,
    pub fields: BTreeMap<String, ExtractedField>,
    pub also_seen_in: Vec<AlsoSeenInEntry>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEventRecord {
    pub id: String,
    pub lead_id: String,
    pub kind: String,
    pub data: Option<serde_json::Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEvaluationInfo {
    pub id: String,
    pub radar_version: i32,
    pub decided_by: Option<String>,
    pub verdict: Option<String>,
    pub score: Option<f64>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub reason: Option<String>,
    pub ruleset_id: Option<String>,
    pub ai_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadDetail {
    pub lead: LeadRecord,
    pub radar_name: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub post_text: Option<String>,
    pub post_text_norm: Option<String>,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub post_captured_at: i64,
    pub evaluation: LeadEvaluationInfo,
    pub events: Vec<LeadEventRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListItem {
    pub lead: LeadRecord,
    pub radar_name: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub post_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFieldFilter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadSort {
    pub by: String,
    #[serde(default = "default_sort_desc")]
    pub dir: SortDir,
}

fn default_sort_desc() -> SortDir {
    SortDir::Desc
}

impl Default for LeadSort {
    fn default() -> Self {
        Self {
            by: "created_at".to_string(),
            dir: SortDir::Desc,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LeadListQuery {
    pub radar_id: Option<String>,
    pub status: Option<Vec<String>>,
    pub since: Option<i64>,
    pub min_score: Option<f64>,
    #[serde(default)]
    pub filters: Vec<LeadFieldFilter>,
    pub search: Option<String>,
    pub sort: Option<LeadSort>,
    #[serde(default = "default_lead_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}

fn default_lead_limit() -> usize {
    50
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListPage {
    pub items: Vec<LeadListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordFeedbackInput {
    pub evaluation_id: String,
    pub label: String,
    pub corrected_fields: Option<BTreeMap<String, ExtractedField>>,
    pub post_text: Option<String>,
    pub origin: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedbackRecord {
    pub id: String,
    pub evaluation_id: String,
    pub radar_version_id: String,
    pub post_id: String,
    pub label: String,
    pub corrected_fields: Option<BTreeMap<String, ExtractedField>>,
    pub post_text: String,
    pub origin: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabeledSampleOrigin {
    Feedback(String),
    AiHighConfidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabeledSample {
    pub post_id: String,
    pub evaluation_id: String,
    pub post_text: String,
    pub text_fold: Option<String>,
    pub is_match: bool,
    pub author_role: Option<String>,
    pub score: Option<f64>,
    pub fields: Option<BTreeMap<String, ExtractedField>>,
    pub origin: LabeledSampleOrigin,
}

// ============================================================================
// Contacts & Blocklist
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContactRecord {
    pub id: String,
    pub display_name: Option<String>,
    pub phones: Vec<String>,
    pub author_ids: Vec<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContactSummary {
    #[serde(flatten)]
    pub contact: ContactRecord,
    pub lead_count: i64,
    pub last_lead_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContactDetail {
    pub contact: ContactRecord,
    pub leads: Vec<LeadListItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlocklistRecord {
    pub id: String,
    pub kind: String,
    pub value: String,
    pub radar_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
}

// ============================================================================
// Jobs, Outbox, Channels, AI Calls, Lifecycle
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub kind: String,
    pub dedup_key: Option<String>,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub run_at: i64,
    pub locked_at: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: serde_json::Value,
    pub state: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnqueueOutboxInput {
    pub id: Option<String>,
    pub channel_id: String,
    pub lead_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub next_try_at: i64,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutboxRecord {
    pub id: String,
    pub channel_id: String,
    pub lead_id: Option<String>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub next_try_at: i64,
    pub sent_at: Option<i64>,
    pub remote_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordAiCallInput {
    pub id: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub task: String,
    pub radar_version_id: Option<String>,
    pub item_count: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
    pub status: String,
    pub error: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiCallRecord {
    pub id: String,
    pub provider: String,
    pub model: Option<String>,
    pub task: String,
    pub radar_version_id: Option<String>,
    pub item_count: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAiUsage {
    pub day_start_ms: i64,
    pub date: String,
    pub calls: i64,
    pub items: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub evaluated_posts: i64,
    pub ai_escalated_posts: i64,
    pub ai_escalation_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageReport {
    pub days: Vec<DailyAiUsage>,
    pub total_calls: i64,
    pub total_items: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub overall_ai_escalation_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PurgeReport {
    pub posts_purged: usize,
    pub evaluations_scrubbed: usize,
    pub crawl_runs_deleted: usize,
    pub ai_calls_deleted: usize,
    pub jobs_deleted: usize,
    pub outbox_deleted: usize,
    pub authors_deleted: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaMigrationRecord {
    pub version: i32,
    pub name: String,
    pub applied_at: i64,
}
