//! Sources, posts, leads, contacts, and blocklist (`ipc.ts`).

use super::*;

// ============================================================================
// Sources, Posts, Leads, Contacts, Blocklist (`ipc.ts`)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Ok,
    Error,
    Inaccessible,
}

impl SourceState {
    pub fn from_db(s: &str) -> Self {
        match s {
            "error" => Self::Error,
            "inaccessible" => Self::Inaccessible,
            _ => Self::Ok,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
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
    pub priority: bool,
    pub state: SourceState,
    pub last_crawl_at: Option<i64>,
    pub avg_new_posts: f64,
    pub posts_per_day: i64,
    pub stored_post_count: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedField {
    pub value: Value,
    pub raw: Option<String>,
    pub confidence: f64,
    pub source: FieldSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeadStatus {
    New,
    Viewed,
    Contacted,
    Negotiating,
    Won,
    Lost,
    Ignored,
}

impl LeadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Viewed => "viewed",
            Self::Contacted => "contacted",
            Self::Negotiating => "negotiating",
            Self::Won => "won",
            Self::Lost => "lost",
            Self::Ignored => "ignored",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "viewed" => Self::Viewed,
            "contacted" => Self::Contacted,
            "negotiating" => Self::Negotiating,
            "won" => Self::Won,
            "lost" => Self::Lost,
            "ignored" => Self::Ignored,
            _ => Self::New,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    Dedup,
    Prefilter,
    Rule,
    Ai,
    Postfilter,
}

impl DecidedBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dedup => "dedup",
            Self::Prefilter => "prefilter",
            Self::Rule => "rule",
            Self::Ai => "ai",
            Self::Postfilter => "postfilter",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("dedup") => Self::Dedup,
            Some("prefilter") => Self::Prefilter,
            Some("rule") => Self::Rule,
            Some("postfilter") => Self::Postfilter,
            _ => Self::Ai,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Duplicate,
    Prefilter,
    Irrelevant,
    Peer,
    Spam,
    Blocked,
    HardFilter,
}

impl RejectReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::Prefilter => "prefilter",
            Self::Irrelevant => "irrelevant",
            Self::Peer => "peer",
            Self::Spam => "spam",
            Self::Blocked => "blocked",
            Self::HardFilter => "hard_filter",
        }
    }

    pub fn from_db(s: Option<&str>) -> Self {
        match s {
            Some("duplicate") => Self::Duplicate,
            Some("prefilter") => Self::Prefilter,
            Some("peer") => Self::Peer,
            Some("spam") => Self::Spam,
            Some("blocked") => Self::Blocked,
            Some("hard_filter") => Self::HardFilter,
            _ => Self::Irrelevant,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackLabel {
    Correct,
    Irrelevant,
    WrongFields,
    Peer,
    Duplicate,
    Spam,
    Missed,
}

impl FeedbackLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Correct => "correct",
            Self::Irrelevant => "irrelevant",
            Self::WrongFields => "wrong_fields",
            Self::Peer => "peer",
            Self::Duplicate => "duplicate",
            Self::Spam => "spam",
            Self::Missed => "missed",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "correct" => Some(Self::Correct),
            "irrelevant" => Some(Self::Irrelevant),
            "wrong_fields" => Some(Self::WrongFields),
            "peer" => Some(Self::Peer),
            "duplicate" => Some(Self::Duplicate),
            "spam" => Some(Self::Spam),
            "missed" => Some(Self::Missed),
            _ => None,
        }
    }

    pub fn is_negative(&self) -> bool {
        matches!(
            self,
            Self::Irrelevant | Self::Peer | Self::Duplicate | Self::Spam
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlsoSeenSource {
    pub source_id: String,
    pub source_name: String,
    pub permalink: String,
    pub captured_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lead {
    pub id: String,
    pub radar_id: String,
    pub radar_name: String,
    pub radar_version_id: String,
    pub radar_version: i32,
    pub post_id: String,
    pub evaluation_id: String,
    pub contact_id: Option<String>,
    pub status: LeadStatus,
    pub read_at: Option<i64>,
    pub score: f64,
    pub is_weak_match: bool,
    pub summary: String,
    pub reason: Option<String>,
    pub decided_by: DecidedBy,
    pub fields: BTreeMap<String, ExtractedField>,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub permalink: String,
    pub post_created_at: Option<i64>,
    pub also_seen_in: Vec<AlsoSeenSource>,
    pub notified_at: Option<i64>,
    pub follow_up_at: Option<i64>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub feedback_label: Option<FeedbackLabel>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadEvent {
    pub id: String,
    pub lead_id: String,
    pub kind: String,
    pub data: Option<BTreeMap<String, Value>>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Post {
    pub id: String,
    pub platform: String,
    pub external_id: String,
    pub source_id: String,
    pub source_name: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub permalink: String,
    pub text: Option<String>,
    pub text_truncated: bool,
    pub lang: Option<String>,
    pub created_at: Option<i64>,
    pub captured_at: i64,
    pub strategy: String,
    pub purged_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadDetail {
    pub lead: Lead,
    pub post: Post,
    pub radar_fields: Vec<FieldDef>,
    pub events: Vec<LeadEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DynamicFieldFilter {
    pub field: String,
    pub op: FilterOperator,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadSortInput {
    pub by: String,
    pub dir: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LeadFilterQuery {
    #[serde(default)]
    pub unread_only: Option<bool>,
    #[serde(default)]
    pub follow_up_before: Option<i64>,
    #[serde(default)]
    pub radar_id: Option<String>,
    #[serde(default)]
    pub status: Option<Vec<LeadStatus>>,
    #[serde(default)]
    pub include_weak: Option<bool>,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub filters: Option<Vec<DynamicFieldFilter>>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: Option<LeadSortInput>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadListResponse {
    pub items: Vec<Lead>,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedEvaluation {
    pub evaluation_id: String,
    pub post_id: String,
    pub radar_id: String,
    pub radar_version_id: String,
    pub decided_by: DecidedBy,
    pub reject_reason: RejectReason,
    pub score: Option<f64>,
    pub reason: Option<String>,
    pub source_name: String,
    pub author_name: String,
    pub permalink: String,
    pub post_text: String,
    pub captured_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked_missed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub display_name: String,
    pub phones: Vec<String>,
    pub author_ids: Vec<String>,
    pub note: Option<String>,
    pub lead_count: i64,
    pub is_blocked: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContactDetail {
    pub contact: Contact,
    pub leads: Vec<Lead>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlocklistKind {
    Author,
    Phone,
    Keyword,
}

impl BlocklistKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Phone => "phone",
            Self::Keyword => "keyword",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "author" => Self::Author,
            "phone" => Self::Phone,
            _ => Self::Keyword,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocklistEntry {
    pub id: String,
    pub kind: BlocklistKind,
    pub value: String,
    #[serde(default)]
    pub display_label: Option<String>,
    pub radar_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
}
