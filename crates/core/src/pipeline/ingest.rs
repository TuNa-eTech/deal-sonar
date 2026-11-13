//! T0–T2: post ingestion, normalization, dedup, and the silent 24h backfill.

use super::*;

/// Extract union of all Vietnamese E.164 phone numbers in `text_norm`.
pub fn collect_e164_phones(text_norm: &str) -> Vec<String> {
    let mut out = extract_e164_phones_light(text_norm);
    for m in extract_vn_phone(text_norm) {
        if let Some(s) = m.value.as_str() {
            if !out.iter().any(|existing| existing == s) {
                out.push(s.to_string());
            }
        }
    }
    out
}

/// T0–T4 synchronous ingestion for a single [`RawPost`] (`05-pipeline-rules.md §2–6`).
pub fn ingest_raw_post(
    rt: &Arc<CoreRuntime>,
    source: &SourceRecord,
    raw: &RawPost,
    now: i64,
) -> CoreResult<IngestPostOutcome> {
    // T1: Normalize text, language detection, content_hash, and 64-bit SimHash
    let norm = normalize_text(&raw.text);
    let phones = collect_e164_phones(&norm.text_norm);

    let attachments_val = if raw.attachments.is_empty() {
        None
    } else {
        Some(serde_json::to_value(&raw.attachments)?)
    };
    let counts_val = raw.counts.as_ref().map(serde_json::to_value).transpose()?;

    // T0: Idempotent post + author upsert
    let new_post = NewPost {
        id: None,
        platform: raw.platform.clone(),
        external_id: raw.post_id.clone(),
        source_id: source.id.clone(),
        author: Some(AuthorInput {
            external_id: raw.author.external_id.clone(),
            name: raw.author.name.clone(),
            is_anonymous: raw.author.is_anonymous,
        }),
        permalink: raw.permalink.clone(),
        text: Some(raw.text.clone()),
        text_norm: Some(norm.text_norm.clone()),
        text_fold: Some(norm.text_fold.clone()),
        text_truncated: raw.text_truncated,
        lang: Some(norm.lang.clone()),
        content_hash: norm.content_hash.clone(),
        simhash: norm.simhash,
        attachments: attachments_val,
        counts: counts_val,
        extracted_phones: phones.clone(),
        created_at: raw.created_at,
        captured_at: raw.captured_at,
        strategy: raw.extraction.strategy.as_str().to_string(),
    };

    let (post, inserted) = rt.store.insert_post(&new_post)?;
    if !inserted {
        return Ok(IngestPostOutcome::DuplicateStored(post));
    }

    if !phones.is_empty() {
        let _ = rt.store.record_post_phones(&post.id, &phones)?;
    }

    // Active radars watching this source
    let active_radars = rt.store.list_active_radars_for_source(&source.id)?;

    // T2: Exact (`content_hash`, 14d) + Near-duplicate (`simhash` Hamming <= 3, >= 80 chars, 14d)
    let since_14d = post.captured_at.saturating_sub(DEDUP_WINDOW_MS);
    let matched_dup = if let Some(exact) =
        rt.store
            .find_exact_dup_excluding(&post.content_hash, since_14d, Some(&post.id))?
    {
        Some(exact)
    } else if norm.text_norm.chars().count() >= NEAR_DUP_MIN_CHARS {
        rt.store
            .find_simhash_dups_excluding(
                post.simhash,
                NEAR_DUP_MAX_HAMMING,
                since_14d,
                Some(&post.id),
            )?
            .into_iter()
            .next()
            .map(|m| m.post)
    } else {
        None
    };

    let mut repost_after_72h = false;
    if let Some(matched) = matched_dup {
        let attach = rt
            .store
            .create_or_attach_dup_cluster(&matched.id, &post.id)?;
        for updated_lead_id in &attach.updated_lead_ids {
            if let Ok(Some(lead_dto)) = load_lead_dto(rt, updated_lead_id) {
                rt.emit(CoreEvent::LeadUpdated(lead_dto));
            }
        }

        if !attach.is_repost_after_72h {
            // Within 72h: record `dedup / duplicate` evaluation per active radar for funnel stats and stop!
            for rw in &active_radars {
                let _ = rt.store.upsert_evaluation(&EvaluationUpsertInput {
                    id: None,
                    post_id: post.id.clone(),
                    radar_version_id: rw.current_version.id.clone(),
                    state: "done".to_string(),
                    decided_by: Some("dedup".to_string()),
                    verdict: Some("no_match".to_string()),
                    reject_reason: Some("duplicate".to_string()),
                    score: Some(0.0),
                    intent: None,
                    author_role: None,
                    summary: None,
                    reason: Some("Bài đăng trùng trong cụm 72 giờ".to_string()),
                    fields: None,
                    ruleset_id: None,
                    ai_call_id: None,
                    is_preview: false,
                    created_at: now,
                    decided_at: Some(now),
                })?;
            }
            return Ok(IngestPostOutcome::ClusterDuplicate(post));
        }
        repost_after_72h = true;
    }

    // Refresh post row if cluster attachment mutated `dup_cluster_id` / `is_cluster_head`
    let post_current = rt.store.post_get(&post.id)?.map(|d| d.post).unwrap_or(post);

    // T3–T4 per subscribed active radar
    for rw in &active_radars {
        evaluate_post_for_radar_sync(
            rt,
            &post_current,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            &rw.current_version,
            EvalMode::Live { repost_after_72h },
            now,
        )?;
    }

    Ok(IngestPostOutcome::Processed(post_current))
}

/// Convert a [`RadarWithVersion`] + post list into silent 24h backfill (`02-radar-spec.md §4`).
pub async fn run_silent_backfill_24h(
    rt: &Arc<CoreRuntime>,
    rw: &RadarWithVersion,
    now: i64,
) -> CoreResult<usize> {
    if rw.source_ids.is_empty() {
        return Ok(0);
    }
    let since_24h = now.saturating_sub(24 * 3_600_000);
    let posts =
        rt.store
            .list_recent_posts_for_sources_since(&rw.source_ids, Some(since_24h), 200)?;
    if posts.is_empty() {
        return Ok(0);
    }

    let mut queued_ai = false;
    let mut evaluated = 0usize;
    for post in &posts {
        // Skip non-head cluster duplicates
        if !post.is_cluster_head {
            continue;
        }
        let raw_text = post.text.as_deref().unwrap_or("");
        let norm = normalize_text(raw_text);
        let eval = evaluate_post_for_radar_sync(
            rt,
            post,
            &norm,
            &rw.radar.id,
            &rw.radar.name,
            &rw.radar.status,
            &rw.radar.notify,
            &rw.current_version,
            EvalMode::BackfillSilent,
            now,
        )?;
        evaluated += 1;
        if eval.state == "pending_ai" {
            queued_ai = true;
        }
    }

    if queued_ai {
        let _ = run_evaluate_batch_for_version(rt, &rw.current_version.id, true).await?;
    }
    Ok(evaluated)
}
