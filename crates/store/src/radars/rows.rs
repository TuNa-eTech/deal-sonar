//! Radar, version, and ruleset row mappers and field definition validation.

use super::*;

pub(crate) fn validate_field_defs(fields: &[FieldDef]) -> Result<(), StoreError> {
    let mut seen = BTreeSet::new();
    for f in fields {
        if !is_valid_field_key(&f.key) {
            return Err(StoreError::InvalidFieldKey(f.key.clone()));
        }
        if !seen.insert(f.key.clone()) {
            return Err(StoreError::InvalidArgument(format!(
                "duplicate field key '{}'",
                f.key
            )));
        }
    }
    Ok(())
}

pub(crate) fn map_radar_row(row: &Row<'_>) -> rusqlite::Result<RadarRecord> {
    let notify_raw: String = row.get("notify")?;
    let notify: NotifyConfig = serde_json::from_str(&notify_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RadarRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        status: row.get("status")?,
        template_id: row.get("template_id")?,
        current_version: row.get("current_version")?,
        notify,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn map_radar_version_row(row: &Row<'_>) -> rusqlite::Result<RadarVersionRecord> {
    let fields_raw: String = row.get("fields")?;
    let policy_raw: String = row.get("match_policy")?;
    let fields: Vec<FieldDef> = serde_json::from_str(&fields_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let match_policy: MatchPolicy = serde_json::from_str(&policy_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RadarVersionRecord {
        id: row.get("id")?,
        radar_id: row.get("radar_id")?,
        version: row.get("version")?,
        description: row.get("description")?,
        language_hint: row.get("language_hint")?,
        user_profession: row.get("user_profession")?,
        fields,
        match_policy,
        created_at: row.get("created_at")?,
    })
}

pub(super) fn map_ruleset_row(row: &Row<'_>) -> rusqlite::Result<RulesetRecord> {
    let body_raw: String = row.get("body")?;
    let metrics_raw: Option<String> = row.get("metrics")?;
    let body: serde_json::Value = serde_json::from_str(&body_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let metrics = metrics_raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    Ok(RulesetRecord {
        id: row.get("id")?,
        radar_version_id: row.get("radar_version_id")?,
        revision: row.get("revision")?,
        state: row.get("state")?,
        origin: row.get("origin")?,
        body,
        metrics,
        created_at: row.get("created_at")?,
        activated_at: row.get("activated_at")?,
    })
}

pub(crate) fn load_radar_with_version_conn(
    conn: &Connection,
    radar_id: &str,
) -> Result<Option<RadarWithVersion>, StoreError> {
    let Some(radar) = conn
        .query_row(
            "SELECT * FROM radars WHERE id = ?1",
            params![radar_id],
            map_radar_row,
        )
        .optional()?
    else {
        return Ok(None);
    };

    let current_version = conn.query_row(
        "SELECT * FROM radar_versions WHERE radar_id = ?1 AND version = ?2",
        params![radar_id, radar.current_version],
        map_radar_version_row,
    )?;

    let candidate_version = conn
        .query_row(
            "SELECT * FROM radar_versions
             WHERE radar_id = ?1 AND version > ?2
             ORDER BY version DESC
             LIMIT 1",
            params![radar_id, radar.current_version],
            map_radar_version_row,
        )
        .optional()?;

    let source_ids = {
        let mut stmt = conn.prepare(
            "SELECT source_id FROM radar_sources WHERE radar_id = ?1 ORDER BY source_id ASC",
        )?;
        let rows = stmt.query_map(params![radar_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Some(RadarWithVersion {
        radar,
        current_version,
        candidate_version,
        source_ids,
    }))
}
