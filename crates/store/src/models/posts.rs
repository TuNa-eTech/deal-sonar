//! Posts, authors, and dedup clusters.

use super::*;

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
