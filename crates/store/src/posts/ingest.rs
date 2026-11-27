//! Post insertion, phone recording, and author upserts.

use super::*;

impl Store {
    /// Idempotent post insertion by `(platform, external_id)`.
    /// Returns `(PostRecord, is_new)`. When `is_new` is true, upserts the author (when not anonymous)
    /// and refreshes the author's 7-day `post_count_7d` and `group_count_7d`.
    pub fn insert_post(&self, input: &NewPost) -> Result<(PostRecord, bool), StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        if let Some(existing) = tx
            .query_row(
                "SELECT * FROM posts WHERE platform = ?1 AND external_id = ?2",
                params![input.platform, input.external_id],
                map_post_row,
            )
            .optional()?
        {
            return Ok((existing, false));
        }

        let author_id = if let Some(author) = &input.author {
            upsert_author_tx(&tx, &input.platform, author, input.captured_at)?
        } else {
            None
        };

        let post_id = input.id.clone().unwrap_or_else(new_ulid);
        let bands = simhash_bands(input.simhash);

        let mut phone_set: BTreeSet<String> = input.extracted_phones.iter().cloned().collect();
        if let Some(t) = &input.text {
            for p in extract_e164_phones_light(t) {
                phone_set.insert(p);
            }
        }
        let phones_vec: Vec<String> = phone_set.into_iter().collect();
        let phones_json = if phones_vec.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&phones_vec)?)
        };

        let attachments_json = input
            .attachments
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let counts_json = input
            .counts
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        tx.execute(
            "INSERT INTO posts (
               id, platform, external_id, source_id, author_id, permalink,
               text, text_norm, text_fold, text_truncated, lang,
               content_hash, simhash, simhash_b0, simhash_b1, simhash_b2, simhash_b3,
               dup_cluster_id, is_cluster_head, attachments, counts, extracted_phones,
               created_at, captured_at, strategy, purged_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6,
               ?7, ?8, ?9, ?10, ?11,
               ?12, ?13, ?14, ?15, ?16, ?17,
               NULL, 1, ?18, ?19, ?20,
               ?21, ?22, ?23, NULL
             )",
            params![
                post_id,
                input.platform,
                input.external_id,
                input.source_id,
                author_id,
                input.permalink,
                input.text,
                input.text_norm,
                input.text_fold,
                i64::from(input.text_truncated),
                input.lang,
                input.content_hash,
                input.simhash,
                i64::from(bands[0]),
                i64::from(bands[1]),
                i64::from(bands[2]),
                i64::from(bands[3]),
                attachments_json,
                counts_json,
                phones_json,
                input.created_at,
                input.captured_at,
                input.strategy,
            ],
        )?;

        if let Some(aid) = &author_id {
            refresh_author_7d_stats_tx(&tx, aid)?;
        }

        let created = tx.query_row(
            "SELECT * FROM posts WHERE id = ?1",
            params![post_id],
            map_post_row,
        )?;
        tx.commit()?;
        Ok((created, true))
    }

    /// Record normalized E.164 phone numbers extracted from a post (e.g. from `vn_phone` extractor).
    pub fn record_post_phones(&self, post_id: &str, phones: &[String]) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let existing_raw: Option<Option<String>> = conn
            .query_row(
                "SELECT extracted_phones FROM posts WHERE id = ?1",
                params![post_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(existing_opt) = existing_raw else {
            return Ok(false);
        };
        let mut merged: BTreeSet<String> = existing_opt
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        for p in phones {
            merged.insert(p.clone());
        }
        let json = if merged.is_empty() {
            None
        } else {
            Some(serde_json::to_string(
                &merged.into_iter().collect::<Vec<_>>(),
            )?)
        };
        let changed = conn.execute(
            "UPDATE posts SET extracted_phones = ?1 WHERE id = ?2",
            params![json, post_id],
        )?;
        Ok(changed > 0)
    }

    /// Fetch an author by ULID.
    pub fn author_get(&self, author_id: &str) -> Result<Option<AuthorRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM authors WHERE id = ?1",
                params![author_id],
                map_author_row,
            )
            .optional()?;
        Ok(rec)
    }
}

pub(super) fn upsert_author_tx(
    conn: &rusqlite::Connection,
    platform: &str,
    author: &AuthorInput,
    captured_at: i64,
) -> Result<Option<String>, StoreError> {
    if author.is_anonymous && author.external_id.is_none() {
        return Ok(None);
    }

    if let Some(ext_id) = &author.external_id {
        if let Some(existing_id) = conn
            .query_row(
                "SELECT id FROM authors WHERE platform = ?1 AND external_id = ?2",
                params![platform, ext_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE authors
                 SET name = ?1,
                     first_seen_at = MIN(first_seen_at, ?2),
                     last_seen_at = MAX(last_seen_at, ?2)
                 WHERE id = ?3",
                params![author.name, captured_at, existing_id],
            )?;
            return Ok(Some(existing_id));
        }

        let id = new_ulid();
        conn.execute(
            "INSERT INTO authors (
               id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 0)",
            params![id, platform, ext_id, author.name, captured_at],
        )?;
        Ok(Some(id))
    } else {
        if author.name.trim().is_empty() {
            return Ok(None);
        }
        if let Some(existing_id) = conn
            .query_row(
                "SELECT id FROM authors WHERE platform = ?1 AND external_id IS NULL AND name = ?2",
                params![platform, author.name],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE authors
                 SET first_seen_at = MIN(first_seen_at, ?1),
                     last_seen_at = MAX(last_seen_at, ?1)
                 WHERE id = ?2",
                params![captured_at, existing_id],
            )?;
            return Ok(Some(existing_id));
        }
        let id = new_ulid();
        conn.execute(
            "INSERT INTO authors (
               id, platform, external_id, name, first_seen_at, last_seen_at, post_count_7d, group_count_7d
             ) VALUES (?1, ?2, NULL, ?3, ?4, ?4, 0, 0)",
            params![id, platform, author.name, captured_at],
        )?;
        Ok(Some(id))
    }
}

pub(super) fn refresh_author_7d_stats_tx(
    conn: &rusqlite::Connection,
    author_id: &str,
) -> Result<(), StoreError> {
    let max_ts: i64 = conn.query_row(
        "SELECT COALESCE(MAX(captured_at), 0) FROM posts WHERE author_id = ?1",
        params![author_id],
        |r| r.get(0),
    )?;
    let since_7d = max_ts.saturating_sub(7 * 86_400_000);
    let (post_count_7d, group_count_7d): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT source_id)
         FROM posts
         WHERE author_id = ?1 AND captured_at >= ?2",
        params![author_id, since_7d],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    conn.execute(
        "UPDATE authors SET post_count_7d = ?1, group_count_7d = ?2 WHERE id = ?3",
        params![post_count_7d, group_count_7d, author_id],
    )?;
    Ok(())
}
