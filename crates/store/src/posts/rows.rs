//! Post, author, and dup cluster row mappers.

use super::*;

pub(crate) fn map_post_row(row: &Row<'_>) -> rusqlite::Result<PostRecord> {
    let attachments_raw: Option<String> = row.get("attachments")?;
    let counts_raw: Option<String> = row.get("counts")?;
    let phones_raw: Option<String> = row.get("extracted_phones")?;

    let attachments = attachments_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let counts = counts_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let extracted_phones: Vec<String> = phones_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let b0 = row.get::<_, i64>("simhash_b0")? as u16;
    let b1 = row.get::<_, i64>("simhash_b1")? as u16;
    let b2 = row.get::<_, i64>("simhash_b2")? as u16;
    let b3 = row.get::<_, i64>("simhash_b3")? as u16;

    Ok(PostRecord {
        id: row.get("id")?,
        platform: row.get("platform")?,
        external_id: row.get("external_id")?,
        source_id: row.get("source_id")?,
        author_id: row.get("author_id")?,
        permalink: row.get("permalink")?,
        text: row.get("text")?,
        text_norm: row.get("text_norm")?,
        text_fold: row.get("text_fold")?,
        text_truncated: row.get::<_, i64>("text_truncated")? != 0,
        lang: row.get("lang")?,
        content_hash: row.get("content_hash")?,
        simhash: row.get("simhash")?,
        simhash_bands: [b0, b1, b2, b3],
        dup_cluster_id: row.get("dup_cluster_id")?,
        is_cluster_head: row.get::<_, i64>("is_cluster_head")? != 0,
        attachments,
        counts,
        extracted_phones,
        created_at: row.get("created_at")?,
        captured_at: row.get("captured_at")?,
        strategy: row.get("strategy")?,
        purged_at: row.get("purged_at")?,
    })
}

pub(super) fn map_author_row(row: &Row<'_>) -> rusqlite::Result<AuthorRecord> {
    Ok(AuthorRecord {
        id: row.get("id")?,
        platform: row.get("platform")?,
        external_id: row.get("external_id")?,
        name: row.get("name")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
        post_count_7d: row.get("post_count_7d")?,
        group_count_7d: row.get("group_count_7d")?,
    })
}

pub(super) fn map_cluster_row(row: &Row<'_>) -> rusqlite::Result<DupClusterRecord> {
    Ok(DupClusterRecord {
        id: row.get("id")?,
        head_post_id: row.get("head_post_id")?,
        size: row.get("size")?,
        source_count: row.get("source_count")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}
