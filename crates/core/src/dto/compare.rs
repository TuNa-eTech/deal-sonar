//! Radar variant comparison: two radar definitions evaluated on one shared set of posts.

use super::*;

/// One side of a comparison: a saved radar version. `version = None` means the radar's
/// current version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RadarCompareSide {
    pub radar_id: String,
    #[serde(default)]
    pub version: Option<i32>,
}

/// Which two definitions to compare and on which posts.
///
/// The shared set is either explicit (`post_ids`) or the most recent posts of `source_ids`.
/// With neither, the groups both radars follow are used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RadarCompareInput {
    pub left: RadarCompareSide,
    pub right: RadarCompareSide,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub post_ids: Option<Vec<String>>,
    #[serde(default)]
    pub max_posts: Option<usize>,
}

/// The exact definition a side was evaluated with. Radar versions are immutable, so
/// `version_id` is enough to reproduce it; the rest keeps the record readable on its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompareDefinition {
    pub radar_id: String,
    pub radar_name: String,
    pub version_id: String,
    pub version: i32,
    pub description: String,
    pub user_profession: Option<String>,
    pub fields: Vec<FieldDef>,
    pub match_policy: MatchPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareChange {
    /// Matches on the right only.
    NewlyMatched,
    /// Matches on the left only.
    NoLongerMatched,
    /// Matches on both sides but at least one shared field was extracted differently.
    FieldsChanged,
    /// Matches on both sides with the same extracted fields.
    StillMatched,
    /// Matches on neither side.
    StillUnmatched,
    /// At least one side could not be scored (for example an AI failure).
    NotCompared,
}

/// How one definition judged one post.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompareVerdict {
    /// `done`, `ai_failed` or `pending_ai`.
    pub state: String,
    /// `match` or `no_match`; `None` when the post was not scored.
    pub verdict: Option<String>,
    pub score: Option<f64>,
    pub decided_by: Option<String>,
    pub reject_reason: Option<String>,
    pub reason: Option<String>,
    pub summary: Option<String>,
    pub intent: Option<String>,
    pub author_role: Option<String>,
    pub fields: BTreeMap<String, ExtractedField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompareFieldChange {
    pub key: String,
    pub label: String,
    pub before: Option<ExtractedField>,
    pub after: Option<ExtractedField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompareItem {
    pub post_id: String,
    pub change: CompareChange,
    /// Why the post moved (or stayed), from both sides' own reasons.
    pub reason: String,
    pub left: CompareVerdict,
    pub right: CompareVerdict,
    /// Fields defined on both sides whose extracted value differs.
    pub field_changes: Vec<CompareFieldChange>,
    // Post details are not stored with the record (they follow the post's retention);
    // they are filled in when a comparison is returned.
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub permalink: String,
    #[serde(default)]
    pub post_text: Option<String>,
    #[serde(default)]
    pub post_created_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompareCounts {
    pub total: usize,
    pub newly_matched: usize,
    pub no_longer_matched: usize,
    pub fields_changed: usize,
    pub still_matched: usize,
    pub still_unmatched: usize,
    pub not_compared: usize,
    pub left_matches: usize,
    pub right_matches: usize,
}

/// What differs between the two definitions, to help read the per-post reasons.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefinitionDiff {
    pub same_version: bool,
    pub description_changed: bool,
    pub user_profession_changed: bool,
    pub want_intent_changed: bool,
    pub exclude_roles_changed: bool,
    pub hard_filters_changed: bool,
    pub fields_only_left: Vec<String>,
    pub fields_only_right: Vec<String>,
    pub fields_changed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarComparison {
    pub id: String,
    pub created_at: i64,
    pub left: CompareDefinition,
    pub right: CompareDefinition,
    /// Groups the shared posts came from (empty when explicit `post_ids` were given).
    pub source_ids: Vec<String>,
    /// The exact posts both definitions were evaluated on.
    pub post_ids: Vec<String>,
    /// Requested posts that no longer have text and were left out.
    pub skipped_post_ids: Vec<String>,
    pub counts: CompareCounts,
    pub definition_diff: DefinitionDiff,
    pub items: Vec<CompareItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RadarComparisonSummary {
    pub id: String,
    pub created_at: i64,
    pub left_radar_name: String,
    pub left_version: i32,
    pub right_radar_name: String,
    pub right_version: i32,
    pub post_count: usize,
}
