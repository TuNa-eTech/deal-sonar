//! Contacts and blocklist.

use super::*;

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
