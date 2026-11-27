//! Ruleset persistence and state transitions.

use super::*;

impl Store {
    // ========================================================================
    // Rulesets
    // ========================================================================

    /// Insert a new ruleset revision (`candidate | shadow | active | retired`).
    /// When `state == "active"`, automatically retires any previously active ruleset for `radar_version_id`.
    pub fn insert_ruleset(&self, input: &NewRulesetInput) -> Result<RulesetRecord, StoreError> {
        if !matches!(
            input.state.as_str(),
            "candidate" | "shadow" | "active" | "retired"
        ) {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset state '{}'",
                input.state
            )));
        }
        if !matches!(input.origin.as_str(), "seed" | "compiled" | "user") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset origin '{}'",
                input.origin
            )));
        }

        let id = input.id.clone().unwrap_or_else(new_ulid);
        let body_json = serde_json::to_string(&input.body)?;
        let metrics_json = input
            .metrics
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let next_rev: i32 = tx.query_row(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM rulesets WHERE radar_version_id = ?1",
            params![input.radar_version_id],
            |r| r.get(0),
        )?;

        if input.state == "active" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'active'",
                params![input.radar_version_id],
            )?;
        } else if input.state == "shadow" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'shadow'",
                params![input.radar_version_id],
            )?;
        }

        let activated_at = (input.state == "active").then_some(input.now_ms);

        tx.execute(
            "INSERT INTO rulesets (
               id, radar_version_id, revision, state, origin, body, metrics, created_at, activated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                input.radar_version_id,
                next_rev,
                input.state,
                input.origin,
                body_json,
                metrics_json,
                input.now_ms,
                activated_at,
            ],
        )?;

        let rec = tx.query_row(
            "SELECT * FROM rulesets WHERE id = ?1",
            params![id],
            map_ruleset_row,
        )?;
        tx.commit()?;
        Ok(rec)
    }

    /// Transition a ruleset's lifecycle state (`candidate | shadow | active | retired`),
    /// optionally recording gate/audit metrics.
    pub fn update_ruleset_state(
        &self,
        ruleset_id: &str,
        state: &str,
        metrics: Option<&serde_json::Value>,
        now_ms: i64,
    ) -> Result<RulesetRecord, StoreError> {
        if !matches!(state, "candidate" | "shadow" | "active" | "retired") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid ruleset state '{state}'"
            )));
        }
        let metrics_json = metrics.map(serde_json::to_string).transpose()?;

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let radar_version_id: String = tx
            .query_row(
                "SELECT radar_version_id FROM rulesets WHERE id = ?1",
                params![ruleset_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "ruleset",
                id: ruleset_id.to_string(),
            })?;

        if state == "active" {
            tx.execute(
                "UPDATE rulesets SET state = 'retired'
                 WHERE radar_version_id = ?1 AND state = 'active' AND id != ?2",
                params![radar_version_id, ruleset_id],
            )?;
            tx.execute(
                "UPDATE rulesets
                 SET state = 'active',
                     metrics = COALESCE(?1, metrics),
                     activated_at = COALESCE(activated_at, ?2)
                 WHERE id = ?3",
                params![metrics_json, now_ms, ruleset_id],
            )?;
        } else {
            if state == "shadow" {
                tx.execute(
                    "UPDATE rulesets SET state = 'retired'
                     WHERE radar_version_id = ?1 AND state = 'shadow' AND id != ?2",
                    params![radar_version_id, ruleset_id],
                )?;
            }
            tx.execute(
                "UPDATE rulesets
                 SET state = ?1,
                     metrics = COALESCE(?2, metrics)
                 WHERE id = ?3",
                params![state, metrics_json, ruleset_id],
            )?;
        }

        let rec = tx.query_row(
            "SELECT * FROM rulesets WHERE id = ?1",
            params![ruleset_id],
            map_ruleset_row,
        )?;
        tx.commit()?;
        Ok(rec)
    }

    /// Get the currently `active` ruleset for `radar_version_id`.
    pub fn get_active_ruleset(
        &self,
        radar_version_id: &str,
    ) -> Result<Option<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM rulesets
                 WHERE radar_version_id = ?1 AND state = 'active'
                 ORDER BY revision DESC
                 LIMIT 1",
                params![radar_version_id],
                map_ruleset_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// Get the currently `shadow` ruleset for `radar_version_id`.
    pub fn get_shadow_ruleset(
        &self,
        radar_version_id: &str,
    ) -> Result<Option<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM rulesets
                 WHERE radar_version_id = ?1 AND state = 'shadow'
                 ORDER BY revision DESC
                 LIMIT 1",
                params![radar_version_id],
                map_ruleset_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List all rulesets for `radar_version_id` ordered by `revision DESC`.
    pub fn list_rulesets(&self, radar_version_id: &str) -> Result<Vec<RulesetRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT * FROM rulesets WHERE radar_version_id = ?1 ORDER BY revision DESC")?;
        let rows = stmt
            .query_map(params![radar_version_id], map_ruleset_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
