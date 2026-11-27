//! Read-only facts behind "why have I not got a lead yet?" and the first-run journey.
//!
//! Counts cover non-preview work for Radars that are `active`, so a draft's trial run never
//! looks like real delivery.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// Aggregated pipeline facts, from first post captured to first message delivered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneySnapshot {
    pub first_followed_source_at: Option<i64>,
    pub first_radar_created_at: Option<i64>,
    pub first_post_captured_at: Option<i64>,
    pub first_lead_at: Option<i64>,
    pub first_delivery_at: Option<i64>,
    pub active_radars: i64,
    /// Distinct groups followed by active Radars.
    pub active_sources: i64,
    /// Posts stored from those groups.
    pub posts_captured: i64,
    pub last_post_captured_at: Option<i64>,
    pub evaluated_match: i64,
    pub evaluated_no_match: i64,
    /// Posts waiting for AI, including ones whose AI call failed.
    pub waiting_ai: i64,
    pub last_evaluated_at: Option<i64>,
    pub leads_total: i64,
    pub last_lead_at: Option<i64>,
    pub delivery_pending: i64,
    pub delivery_failed: i64,
    pub last_delivery_at: Option<i64>,
    pub last_delivery_error: Option<String>,
}

const ACTIVE_VERSIONS: &str = "SELECT v.id FROM radar_versions v JOIN radars r ON r.id = v.radar_id WHERE r.status = 'active'";

impl Store {
    pub fn journey_snapshot(&self) -> Result<JourneySnapshot, StoreError> {
        let conn = self.lock_conn()?;
        let one = |sql: &str| -> Result<Option<i64>, StoreError> {
            Ok(conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))?)
        };
        let count = |sql: &str| -> Result<i64, StoreError> {
            Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?)
        };
        let active_sources = "SELECT DISTINCT rs.source_id FROM radar_sources rs JOIN radars r ON r.id = rs.radar_id WHERE r.status = 'active'";

        let last_delivery_error: Option<String> = conn
            .query_row(
                "SELECT error FROM outbox WHERE state = 'failed' AND error IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1",
                params![],
                |r| r.get(0),
            )
            .optional()?;

        Ok(JourneySnapshot {
            first_followed_source_at: one(
                "SELECT MIN(created_at) FROM sources WHERE followed = 1",
            )?,
            first_radar_created_at: one("SELECT MIN(created_at) FROM radars")?,
            first_post_captured_at: one("SELECT MIN(captured_at) FROM posts")?,
            first_lead_at: one("SELECT MIN(created_at) FROM leads")?,
            first_delivery_at: one("SELECT MIN(sent_at) FROM outbox WHERE state = 'sent'")?,
            active_radars: count("SELECT COUNT(*) FROM radars WHERE status = 'active'")?,
            active_sources: count(&format!("SELECT COUNT(*) FROM ({active_sources})"))?,
            posts_captured: count(&format!(
                "SELECT COUNT(*) FROM posts WHERE source_id IN ({active_sources})"
            ))?,
            last_post_captured_at: one(&format!(
                "SELECT MAX(captured_at) FROM posts WHERE source_id IN ({active_sources})"
            ))?,
            evaluated_match: count(&format!(
                "SELECT COUNT(*) FROM evaluations WHERE is_preview = 0 AND state = 'done'
                 AND verdict = 'match' AND radar_version_id IN ({ACTIVE_VERSIONS})"
            ))?,
            evaluated_no_match: count(&format!(
                "SELECT COUNT(*) FROM evaluations WHERE is_preview = 0 AND state = 'done'
                 AND verdict = 'no_match' AND radar_version_id IN ({ACTIVE_VERSIONS})"
            ))?,
            waiting_ai: count(&format!(
                "SELECT COUNT(*) FROM evaluations WHERE is_preview = 0
                 AND state IN ('pending_ai', 'ai_failed')
                 AND radar_version_id IN ({ACTIVE_VERSIONS})"
            ))?,
            last_evaluated_at: one(&format!(
                "SELECT MAX(decided_at) FROM evaluations WHERE is_preview = 0 AND state = 'done'
                 AND radar_version_id IN ({ACTIVE_VERSIONS})"
            ))?,
            leads_total: count("SELECT COUNT(*) FROM leads")?,
            last_lead_at: one("SELECT MAX(created_at) FROM leads")?,
            delivery_pending: count("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")?,
            delivery_failed: count("SELECT COUNT(*) FROM outbox WHERE state = 'failed'")?,
            last_delivery_at: one("SELECT MAX(sent_at) FROM outbox WHERE state = 'sent'")?,
            last_delivery_error,
        })
    }
}
