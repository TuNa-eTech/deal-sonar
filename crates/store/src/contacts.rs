use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::leads::map_lead_list_item_row;
use crate::models::{
    fold_vi, new_ulid, BlocklistRecord, ContactDetail, ContactRecord, ContactSummary,
};
use crate::{Store, StoreError};

fn map_contact_row(row: &Row<'_>) -> rusqlite::Result<ContactRecord> {
    let phones_raw: Option<String> = row.get("phones")?;
    let authors_raw: Option<String> = row.get("author_ids")?;
    let phones: Vec<String> = phones_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let author_ids: Vec<String> = authors_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    Ok(ContactRecord {
        id: row.get("id")?,
        display_name: row.get("display_name")?,
        phones,
        author_ids,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_blocklist_row(row: &Row<'_>) -> rusqlite::Result<BlocklistRecord> {
    Ok(BlocklistRecord {
        id: row.get("id")?,
        kind: row.get("kind")?,
        value: row.get("value")?,
        radar_id: row.get("radar_id")?,
        reason: row.get("reason")?,
        created_at: row.get("created_at")?,
    })
}

impl Store {
    // ========================================================================
    // Contacts (`04-data-model.md §2.5`, `05-pipeline-rules.md §9`)
    // ========================================================================

    /// Find or create (and merge if needed) a `contacts` row by E.164 phones first, then by `author_id`.
    pub fn upsert_contact_from_lead(
        &self,
        author_id: Option<&str>,
        author_name: Option<&str>,
        e164_phones: &[String],
        now_ms: i64,
    ) -> Result<Option<ContactRecord>, StoreError> {
        let clean_author_id = author_id.map(str::trim).filter(|s| !s.is_empty());
        let clean_phones: Vec<String> = e164_phones
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        if clean_author_id.is_none() && clean_phones.is_empty() {
            return Ok(None);
        }

        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let mut matched_ids: BTreeSet<String> = BTreeSet::new();

        for phone in &clean_phones {
            let mut stmt = tx.prepare(
                "SELECT id FROM contacts
                 WHERE phones IS NOT NULL
                   AND EXISTS (SELECT 1 FROM json_each(phones) jp WHERE jp.value = ?1)",
            )?;
            let rows = stmt.query_map(params![phone], |r| r.get::<_, String>(0))?;
            for cid in rows {
                matched_ids.insert(cid?);
            }
        }

        if let Some(aid) = clean_author_id {
            let mut stmt = tx.prepare(
                "SELECT id FROM contacts
                 WHERE author_ids IS NOT NULL
                   AND EXISTS (SELECT 1 FROM json_each(author_ids) ja WHERE ja.value = ?1)",
            )?;
            let rows = stmt.query_map(params![aid], |r| r.get::<_, String>(0))?;
            for cid in rows {
                matched_ids.insert(cid?);
            }
        }

        let clean_name = author_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);

        let contact_id = if matched_ids.is_empty() {
            let id = new_ulid();
            let phones_json = (!clean_phones.is_empty())
                .then(|| serde_json::to_string(&clean_phones))
                .transpose()?;
            let authors_vec: Vec<String> =
                clean_author_id.iter().map(|s| (*s).to_string()).collect();
            let authors_json = (!authors_vec.is_empty())
                .then(|| serde_json::to_string(&authors_vec))
                .transpose()?;

            tx.execute(
                "INSERT INTO contacts (
                   id, display_name, phones, author_ids, note, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
                params![id, clean_name, phones_json, authors_json, now_ms],
            )?;
            id
        } else {
            // Load matched contacts ordered by earliest `created_at` so primary contact is stable.
            let mut matched_contacts = Vec::with_capacity(matched_ids.len());
            for cid in &matched_ids {
                if let Some(rec) = tx
                    .query_row(
                        "SELECT * FROM contacts WHERE id = ?1",
                        params![cid],
                        map_contact_row,
                    )
                    .optional()?
                {
                    matched_contacts.push(rec);
                }
            }
            matched_contacts.sort_by_key(|c| (c.created_at, c.id.clone()));

            let primary = &matched_contacts[0];
            let primary_id = primary.id.clone();

            let mut merged_phones: BTreeSet<String> = primary.phones.iter().cloned().collect();
            let mut merged_authors: BTreeSet<String> = primary.author_ids.iter().cloned().collect();
            let mut merged_name = primary.display_name.clone();
            let mut notes: Vec<String> = primary.note.iter().cloned().collect();

            for secondary in matched_contacts.iter().skip(1) {
                for p in &secondary.phones {
                    merged_phones.insert(p.clone());
                }
                for a in &secondary.author_ids {
                    merged_authors.insert(a.clone());
                }
                if merged_name.is_none() && secondary.display_name.is_some() {
                    merged_name = secondary.display_name.clone();
                }
                if let Some(n) = &secondary.note {
                    if !n.is_empty() && !notes.contains(n) {
                        notes.push(n.clone());
                    }
                }
                // Repoint existing leads before deleting merged secondary contact.
                tx.execute(
                    "UPDATE leads SET contact_id = ?1 WHERE contact_id = ?2",
                    params![primary_id, secondary.id],
                )?;
                tx.execute("DELETE FROM contacts WHERE id = ?1", params![secondary.id])?;
            }

            for p in clean_phones {
                merged_phones.insert(p);
            }
            if let Some(aid) = clean_author_id {
                merged_authors.insert(aid.to_string());
            }
            if merged_name.is_none() {
                merged_name = clean_name;
            }

            let phones_vec: Vec<String> = merged_phones.into_iter().collect();
            let authors_vec: Vec<String> = merged_authors.into_iter().collect();
            let phones_json = (!phones_vec.is_empty())
                .then(|| serde_json::to_string(&phones_vec))
                .transpose()?;
            let authors_json = (!authors_vec.is_empty())
                .then(|| serde_json::to_string(&authors_vec))
                .transpose()?;
            let merged_note = (!notes.is_empty()).then(|| notes.join("\n"));

            tx.execute(
                "UPDATE contacts
                 SET display_name = ?1,
                     phones = ?2,
                     author_ids = ?3,
                     note = ?4,
                     updated_at = ?5
                 WHERE id = ?6",
                params![
                    merged_name,
                    phones_json,
                    authors_json,
                    merged_note,
                    now_ms,
                    primary_id,
                ],
            )?;
            primary_id
        };

        let contact = tx.query_row(
            "SELECT * FROM contacts WHERE id = ?1",
            params![contact_id],
            map_contact_row,
        )?;
        tx.commit()?;
        Ok(Some(contact))
    }

    /// List contacts with lead count and latest lead timestamp, optionally filtered by `search`.
    pub fn contact_list(
        &self,
        search: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ContactSummary>, StoreError> {
        let limit = limit.clamp(1, 500) as i64;
        let conn = self.lock_conn()?;
        let search_trimmed = search.map(str::trim).filter(|s| !s.is_empty());

        let map_summary = |row: &Row<'_>| -> rusqlite::Result<ContactSummary> {
            Ok(ContactSummary {
                contact: map_contact_row(row)?,
                lead_count: row.get("lead_count")?,
                last_lead_at: row.get("last_lead_at")?,
            })
        };

        if let Some(q) = search_trimmed {
            let mut stmt = conn.prepare(
                "SELECT
                   c.*,
                   COUNT(l.id) AS lead_count,
                   MAX(l.created_at) AS last_lead_at
                 FROM contacts c
                 LEFT JOIN leads l ON l.contact_id = c.id
                 WHERE dealsonar_fold_contains(
                   COALESCE(c.display_name, '') || ' ' || COALESCE(c.phones, '') || ' ' || COALESCE(c.note, ''),
                   ?1
                 ) = 1
                 GROUP BY c.id
                 ORDER BY c.updated_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![q, limit], map_summary)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        } else {
            let mut stmt = conn.prepare(
                "SELECT
                   c.*,
                   COUNT(l.id) AS lead_count,
                   MAX(l.created_at) AS last_lead_at
                 FROM contacts c
                 LEFT JOIN leads l ON l.contact_id = c.id
                 GROUP BY c.id
                 ORDER BY c.updated_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit], map_summary)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }
    }

    /// Fetch a contact along with its historical leads.
    pub fn contact_get(&self, contact_id: &str) -> Result<Option<ContactDetail>, StoreError> {
        let conn = self.lock_conn()?;
        let Some(contact) = conn
            .query_row(
                "SELECT * FROM contacts WHERE id = ?1",
                params![contact_id],
                map_contact_row,
            )
            .optional()?
        else {
            return Ok(None);
        };

        let leads = {
            let mut stmt = conn.prepare(
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
                 WHERE l.contact_id = ?1
                 ORDER BY l.created_at DESC",
            )?;
            let rows = stmt.query_map(params![contact_id], map_lead_list_item_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        Ok(Some(ContactDetail { contact, leads }))
    }

    /// Update note on a contact.
    pub fn contact_note(
        &self,
        contact_id: &str,
        note: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<ContactRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE contacts SET note = ?1, updated_at = ?2 WHERE id = ?3",
            params![note, now_ms, contact_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let rec = conn
            .query_row(
                "SELECT * FROM contacts WHERE id = ?1",
                params![contact_id],
                map_contact_row,
            )
            .optional()?;
        Ok(rec)
    }

    // ========================================================================
    // Blocklist (`04-data-model.md §2.5`, `05-pipeline-rules.md §5`)
    // ========================================================================

    /// Add an entry (`author | phone | keyword`) to the blocklist (idempotent on `(kind, value, radar_id)`).
    pub fn blocklist_add(
        &self,
        kind: &str,
        value: &str,
        radar_id: Option<&str>,
        reason: Option<&str>,
        now_ms: i64,
    ) -> Result<BlocklistRecord, StoreError> {
        if !matches!(kind, "author" | "phone" | "keyword") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid blocklist kind '{kind}'"
            )));
        }
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(StoreError::InvalidArgument(
                "blocklist value cannot be empty".to_string(),
            ));
        }

        let conn = self.lock_conn()?;

        if let Some(existing) = find_existing_blocklist_conn(&conn, kind, trimmed, radar_id)? {
            return Ok(existing);
        }

        let id = new_ulid();
        conn.execute(
            "INSERT INTO blocklist (id, kind, value, radar_id, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, kind, trimmed, radar_id, reason, now_ms],
        )?;

        let rec = conn.query_row(
            "SELECT * FROM blocklist WHERE id = ?1",
            params![id],
            map_blocklist_row,
        )?;
        Ok(rec)
    }

    /// Remove a blocklist entry by ID.
    pub fn blocklist_remove(&self, blocklist_id: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute("DELETE FROM blocklist WHERE id = ?1", params![blocklist_id])?;
        Ok(changed > 0)
    }

    /// List blocklist entries. When `radar_id` is `Some`, returns global (`radar_id IS NULL`)
    /// plus radar-specific entries; when `None`, returns all entries.
    pub fn blocklist_list(
        &self,
        radar_id: Option<&str>,
    ) -> Result<Vec<BlocklistRecord>, StoreError> {
        let conn = self.lock_conn()?;
        if let Some(rid) = radar_id {
            let mut stmt = conn.prepare(
                "SELECT * FROM blocklist
                 WHERE radar_id IS NULL OR radar_id = ?1
                 ORDER BY created_at DESC",
            )?;
            let rows = stmt
                .query_map(params![rid], map_blocklist_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        } else {
            let mut stmt = conn.prepare("SELECT * FROM blocklist ORDER BY created_at DESC")?;
            let rows = stmt
                .query_map([], map_blocklist_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }
    }

    /// Check whether a post matches any global or radar-specific blocklist entry (`author`, `phone`, `keyword`).
    pub fn is_blocked(
        &self,
        radar_id: Option<&str>,
        author_external_id_or_id: Option<&str>,
        phones: &[String],
        text_fold: Option<&str>,
    ) -> Result<bool, StoreError> {
        Ok(self
            .find_matching_blocklist(radar_id, author_external_id_or_id, phones, text_fold)?
            .is_some())
    }

    /// Return the first matching blocklist entry (`author`, `phone`, or `keyword`) if blocked.
    pub fn find_matching_blocklist(
        &self,
        radar_id: Option<&str>,
        author_external_id_or_id: Option<&str>,
        phones: &[String],
        text_fold: Option<&str>,
    ) -> Result<Option<BlocklistRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let entries: Vec<BlocklistRecord> = if let Some(rid) = radar_id {
            let mut stmt =
                conn.prepare("SELECT * FROM blocklist WHERE radar_id IS NULL OR radar_id = ?1")?;
            let rows = stmt.query_map(params![rid], map_blocklist_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare("SELECT * FROM blocklist WHERE radar_id IS NULL")?;
            let rows = stmt.query_map([], map_blocklist_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        if entries.is_empty() {
            return Ok(None);
        }

        // Resolve both internal author ULID and platform `external_id` so either matches `kind = 'author'`.
        let mut author_candidates = BTreeSet::new();
        if let Some(raw_aid) = author_external_id_or_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            author_candidates.insert(raw_aid.to_string());
            let mut stmt = conn
                .prepare("SELECT id, external_id FROM authors WHERE id = ?1 OR external_id = ?1")?;
            let rows = stmt.query_map(params![raw_aid], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            for pair in rows {
                let (id, ext_opt) = pair?;
                author_candidates.insert(id);
                if let Some(ext) = ext_opt {
                    author_candidates.insert(ext);
                }
            }
        }

        let folded_post = text_fold.map(fold_vi);

        for entry in entries {
            match entry.kind.as_str() {
                "author" => {
                    if author_candidates.contains(&entry.value) {
                        return Ok(Some(entry));
                    }
                }
                "phone" => {
                    if phones.iter().any(|p| p == &entry.value) {
                        return Ok(Some(entry));
                    }
                }
                "keyword" => {
                    if let Some(haystack) = &folded_post {
                        let kw = fold_vi(&entry.value);
                        if !kw.is_empty() && haystack.contains(&kw) {
                            return Ok(Some(entry));
                        }
                    }
                }
                _ => {}
            }
        }

        Ok(None)
    }
}

fn find_existing_blocklist_conn(
    conn: &Connection,
    kind: &str,
    value: &str,
    radar_id: Option<&str>,
) -> Result<Option<BlocklistRecord>, StoreError> {
    let rec = if let Some(rid) = radar_id {
        conn.query_row(
            "SELECT * FROM blocklist WHERE kind = ?1 AND value = ?2 AND radar_id = ?3",
            params![kind, value, rid],
            map_blocklist_row,
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT * FROM blocklist WHERE kind = ?1 AND value = ?2 AND radar_id IS NULL",
            params![kind, value],
            map_blocklist_row,
        )
        .optional()?
    };
    Ok(rec)
}
