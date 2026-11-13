//! Command input and output contracts (`ipc.ts` & `api.ts`).

use super::*;

// ============================================================================
// Command Input & Output Contracts (`ipc.ts` & `api.ts`)
// ============================================================================

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RadarNotifyPatch {
    pub channel_ids: Option<Vec<String>>,
    pub mode: Option<NotifyMode>,
    pub min_score: Option<f64>,
    #[serde(default, with = "double_option")]
    pub quiet_hours: Option<Option<QuietHours>>,
}

impl RadarNotifyPatch {
    pub fn apply_onto(&self, base: &RadarNotifyConfig) -> RadarNotifyConfig {
        RadarNotifyConfig {
            channel_ids: self
                .channel_ids
                .clone()
                .unwrap_or_else(|| base.channel_ids.clone()),
            mode: self.mode.unwrap_or(base.mode),
            min_score: self.min_score.unwrap_or(base.min_score),
            quiet_hours: match &self.quiet_hours {
                Some(qh) => qh.clone(),
                None => base.quiet_hours.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateRadarDraftInput {
    pub name: String,
    #[serde(default)]
    pub template_id: Option<String>,
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub match_policy: MatchPolicy,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub notify: Option<RadarNotifyPatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRadarInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default, with = "double_option")]
    pub user_profession: Option<Option<String>>,
    pub fields: Option<Vec<FieldDef>>,
    pub match_policy: Option<MatchPolicy>,
    pub source_ids: Option<Vec<String>>,
    pub notify: Option<RadarNotifyPatch>,
    #[serde(default)]
    pub confirm_version_upgrade: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarUpdateResult {
    pub detail: RadarDetail,
    pub created_new_version: bool,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestFieldsInput {
    pub description: String,
    #[serde(default)]
    pub user_profession: Option<String>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub language_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefilterHintDto {
    pub any: Vec<String>,
    pub none: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestFieldsResult {
    pub suggested_name: String,
    pub want_intent: WantIntent,
    pub fields: Vec<FieldDef>,
    pub hard_filters: Vec<HardFilter>,
    pub clarifying_questions: Vec<String>,
    pub prefilter_hint: Option<PrefilterHintDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewItem {
    pub evaluation_id: String,
    pub post_id: String,
    pub verdict: String,
    pub score: f64,
    pub intent: PostIntent,
    pub author_role: AuthorRole,
    pub summary: String,
    pub reason: String,
    pub decided_by: DecidedBy,
    pub fields: BTreeMap<String, ExtractedField>,
    pub source_name: String,
    pub author_name: String,
    pub permalink: String,
    pub post_text: String,
    pub post_created_at: Option<i64>,
    pub feedback_label: Option<FeedbackLabel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewWarningCode {
    ZeroMatches,
    TooBroad,
    MissingRequiredField,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewWarning {
    pub code: PreviewWarningCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_label: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStatus {
    Crawling,
    Evaluating,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewRunState {
    pub preview_id: String,
    pub radar_id: String,
    pub radar_version: i32,
    pub status: PreviewStatus,
    pub total_posts: usize,
    pub evaluated_posts: usize,
    #[serde(default)]
    pub failed_posts: usize,
    pub items: Vec<PreviewItem>,
    pub warnings: Vec<PreviewWarning>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewStartInput {
    pub radar_id: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, with = "double_option")]
    pub user_profession: Option<Option<String>>,
    #[serde(default)]
    pub fields: Option<Vec<FieldDef>>,
    #[serde(default)]
    pub match_policy: Option<MatchPolicy>,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackOrigin {
    App,
    Preview,
}

impl FeedbackOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Preview => "preview",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFeedbackInput {
    pub evaluation_id: String,
    #[serde(default)]
    pub lead_id: Option<String>,
    #[serde(default)]
    pub post_id: Option<String>,
    #[serde(default)]
    pub radar_version_id: Option<String>,
    pub label: FeedbackLabel,
    #[serde(default)]
    pub corrected_fields: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub duplicate_of_lead_id: Option<String>,
    #[serde(default)]
    pub block_author: Option<bool>,
    pub origin: FeedbackOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadFeedbackResult {
    pub feedback_id: String,
    pub updated_lead: Option<Lead>,
    pub blocked_entry: Option<BlocklistEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Xlsx,
}

impl ExportFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadExportInput {
    pub query: LeadFilterQuery,
    pub format: ExportFormat,
    pub include_post_text: bool,
    #[serde(default)]
    pub dest_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadExportResult {
    pub path: String,
    pub format: ExportFormat,
    pub row_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramSetupStatus {
    pub bot_username: String,
    pub bot_link: String,
    pub waiting_for_start: bool,
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeConnectOptions {
    #[serde(default)]
    pub extension_id: Option<String>,
    #[serde(default)]
    pub resume_crawl: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeConnectResult {
    pub native_host_installed: bool,
    pub manifest_path: String,
    pub extension_connected: bool,
    pub facebook_session: FacebookSessionState,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceCrawlNowResult {
    pub queued: bool,
    pub run_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadCrmPatch {
    #[serde(default, with = "double_option")]
    pub note: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default, with = "double_option")]
    pub follow_up_at: Option<Option<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContactBlockResult {
    pub blocked_entries: Vec<BlocklistEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocklistRemoveResult {
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesetCompileResult {
    pub job_id: String,
    pub ruleset: Option<Ruleset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelRemoveResult {
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticBundleResult {
    pub path: String,
    pub size_bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataBackupResult {
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataPurgeResult {
    pub posts_purged: usize,
    pub evaluations_cleaned: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataDeleteAllResult {
    pub deleted: bool,
}
