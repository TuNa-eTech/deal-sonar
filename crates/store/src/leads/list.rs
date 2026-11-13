//! Paginated lead listing with dynamic field filters and sorting.

use super::*;

impl Store {
    // ========================================================================
    // Dynamic `lead_list` Query (`03-desktop.md §4`, `04-data-model.md §3`, `03-risks-compliance.md §4`)
    // ========================================================================

    /// Dynamic CRM lead query with strict whitelist validation against SQL injection,
    /// field-shape-aware JSON filtering, diacritic-insensitive FTS5 across `leads_fts` and `posts_fts`,
    /// dynamic sorting, and cursor pagination.
    pub fn lead_list(&self, query: &LeadListQuery) -> Result<LeadListPage, StoreError> {
        let conn = self.lock_conn()?;

        // 1. Load allowed dynamic field definitions for whitelist validation & shape awareness.
        let allowed_fields = load_allowed_field_map(&conn, query.radar_id.as_deref())?;

        // Validate every filter field key BEFORE building any SQL.
        for filter in &query.filters {
            if !is_valid_field_key(&filter.field) {
                return Err(StoreError::InvalidFieldKey(filter.field.clone()));
            }
            if !allowed_fields.contains_key(&filter.field) {
                return Err(StoreError::UnknownRadarField {
                    radar_id: query.radar_id.clone(),
                    field: filter.field.clone(),
                });
            }
        }

        let sort = query.sort.clone().unwrap_or_default();
        let dynamic_sort_field = match sort.by.as_str() {
            "created_at" | "updated_at" | "score" => None,
            field_key => {
                if !is_valid_field_key(field_key) {
                    return Err(StoreError::InvalidFieldKey(field_key.to_string()));
                }
                let Some(fdef) = allowed_fields.get(field_key) else {
                    return Err(StoreError::UnknownRadarField {
                        radar_id: query.radar_id.clone(),
                        field: field_key.to_string(),
                    });
                };
                Some(fdef.clone())
            }
        };

        let mut sql_params: Vec<SqlValue> = Vec::new();
        let mut where_clauses: Vec<String> = Vec::new();

        if let Some(rid) = &query.radar_id {
            let p = push_param(&mut sql_params, SqlValue::Text(rid.clone()));
            where_clauses.push(format!("l.radar_id = {p}"));
        }

        if query.unread_only == Some(true) {
            where_clauses.push("l.read_at IS NULL".into());
        }
        if let Some(due) = query.follow_up_before {
            let p = push_param(&mut sql_params, SqlValue::Integer(due));
            where_clauses.push(format!(
                "l.follow_up_at <= {p} AND l.status NOT IN ('won','lost','ignored')"
            ));
        }
        if query.exclude_weak == Some(true) {
            where_clauses
                .push("l.score >= COALESCE(json_extract(r.notify, '$.min_score'), 0.6)".into());
        }
        if let Some(statuses) = &query.status {
            if !statuses.is_empty() {
                let mut ph = Vec::with_capacity(statuses.len());
                for st in statuses {
                    ph.push(push_param(&mut sql_params, SqlValue::Text(st.clone())));
                }
                where_clauses.push(format!("l.status IN ({})", ph.join(", ")));
            }
        }

        if let Some(since) = query.since {
            let p = push_param(&mut sql_params, SqlValue::Integer(since));
            where_clauses.push(format!("l.created_at >= {p}"));
        }

        if let Some(min_score) = query.min_score {
            let p = push_param(&mut sql_params, SqlValue::Real(min_score));
            where_clauses.push(format!("l.score >= {p}"));
        }

        if let Some(search_raw) = &query.search {
            if !search_raw.trim().is_empty() {
                if let Some(fts_q) = build_fts5_query(search_raw) {
                    let p1 = push_param(&mut sql_params, SqlValue::Text(fts_q.clone()));
                    let p2 = push_param(&mut sql_params, SqlValue::Text(fts_q));
                    where_clauses.push(format!(
                        "(l.rowid IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH {p1}) \
                          OR p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH {p2}))"
                    ));
                } else {
                    // Non-alphanumeric-only query matches nothing.
                    where_clauses.push("0 = 1".to_string());
                }
            }
        }

        // Dynamic field filters: every path & value bound via `sql_params`.
        for filter in &query.filters {
            let fdef = allowed_fields
                .get(&filter.field)
                .expect("validated against allowed_fields");
            let clause = build_dynamic_filter_clause(fdef, filter, &mut sql_params)?;
            where_clauses.push(clause);
        }

        let offset = parse_cursor_offset(query.cursor.as_deref())?;
        let limit = query.limit.clamp(1, 500);
        let fetch_limit = (limit + 1) as i64;

        let dir_sql = match sort.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };

        let filter_param_count = sql_params.len();
        let order_sql = if let Some(fdef) = &dynamic_sort_field {
            let expr = build_dynamic_sort_expr(fdef, &mut sql_params);
            format!(
                "CASE WHEN {expr} IS NULL THEN 1 ELSE 0 END ASC, {expr} {dir_sql}, l.created_at DESC, l.id DESC"
            )
        } else {
            let col = match sort.by.as_str() {
                "updated_at" => "l.updated_at",
                "score" => "l.score",
                _ => "l.created_at",
            };
            format!("{col} {dir_sql}, l.id {dir_sql}")
        };

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM leads l JOIN radars r ON r.id=l.radar_id JOIN posts p ON p.id=l.post_id JOIN sources s ON s.id=p.source_id LEFT JOIN authors a ON a.id=p.author_id {where_sql}"), params_from_iter(sql_params[..filter_param_count].iter()), |r|r.get(0))?;
        let p_limit = push_param(&mut sql_params, SqlValue::Integer(fetch_limit));
        let p_offset = push_param(&mut sql_params, SqlValue::Integer(offset as i64));

        let sql = format!(
            "SELECT
               l.*,
               r.name AS radar_name,
               p.source_id,
               s.name AS source_name,
               p.author_id,
               a.name AS author_name,
               p.permalink,
               p.created_at AS post_created_at,
               p.text AS post_text
             FROM leads l
             JOIN radars r ON r.id = l.radar_id
             JOIN posts p ON p.id = l.post_id
             JOIN sources s ON s.id = p.source_id
             LEFT JOIN authors a ON a.id = p.author_id
             {where_sql}
             ORDER BY {order_sql}
             LIMIT {p_limit} OFFSET {p_offset}"
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut items = stmt
            .query_map(params_from_iter(sql_params), map_lead_list_item_row)?
            .collect::<Result<Vec<_>, _>>()?;

        let next_cursor = if items.len() > limit {
            items.truncate(limit);
            Some(format!("off:{}", offset + limit))
        } else {
            None
        };

        Ok(LeadListPage {
            items,
            next_cursor,
            total: total as usize,
        })
    }
}

pub(super) fn load_allowed_field_map(
    conn: &Connection,
    radar_id: Option<&str>,
) -> Result<BTreeMap<String, FieldDef>, StoreError> {
    let mut map = BTreeMap::new();
    if let Some(rid) = radar_id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM radars WHERE id = ?1)",
            params![rid],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound {
                entity: "radar",
                id: rid.to_string(),
            });
        }
        // Load fields from radar versions (oldest -> current so current_version wins on type).
        let mut stmt = conn.prepare(
            "SELECT rv.fields
             FROM radar_versions rv
             JOIN radars r ON r.id = rv.radar_id
             WHERE rv.radar_id = ?1 AND rv.version <= r.current_version
             ORDER BY rv.version ASC",
        )?;
        let rows = stmt.query_map(params![rid], |r| r.get::<_, String>(0))?;
        for raw in rows {
            let defs: Vec<FieldDef> = serde_json::from_str(&raw?)?;
            for f in defs {
                if is_valid_field_key(&f.key) {
                    map.insert(f.key.clone(), f);
                }
            }
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT rv.fields
             FROM radar_versions rv
             JOIN radars r ON r.id = rv.radar_id
             WHERE rv.version = r.current_version
             ORDER BY r.updated_at ASC",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for raw in rows {
            let defs: Vec<FieldDef> = serde_json::from_str(&raw?)?;
            for f in defs {
                if is_valid_field_key(&f.key) {
                    map.insert(f.key.clone(), f);
                }
            }
        }
    }
    Ok(map)
}

pub(super) fn push_param(params: &mut Vec<SqlValue>, val: SqlValue) -> String {
    params.push(val);
    format!("?{}", params.len())
}

pub(super) fn parse_cursor_offset(cursor: Option<&str>) -> Result<usize, StoreError> {
    let Some(c) = cursor else {
        return Ok(0);
    };
    let trimmed = c.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let num_str = trimmed.strip_prefix("off:").unwrap_or(trimmed);
    num_str
        .parse::<usize>()
        .map_err(|_| StoreError::InvalidArgument(format!("invalid pagination cursor '{trimmed}'")))
}
