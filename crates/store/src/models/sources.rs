//! Sources and crawl runs.

use super::*;

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

pub(super) fn default_facebook_platform() -> String {
    "facebook".to_string()
}

pub(super) fn default_group_kind() -> String {
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
