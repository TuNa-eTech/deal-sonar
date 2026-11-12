use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::models::{
    new_ulid, AiCallRecord, AiUsageReport, ChannelRecord, DailyAiUsage, EnqueueOutboxInput,
    JobRecord, OutboxRecord, RecordAiCallInput,
};
use crate::{Store, StoreError};

fn map_job_row(row: &Row<'_>) -> rusqlite::Result<JobRecord> {
    let payload_raw: String = row.get("payload")?;
    let payload: serde_json::Value = serde_json::from_str(&payload_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(JobRecord {
        id: row.get("id")?,
        kind: row.get("kind")?,
        dedup_key: row.get("dedup_key")?,
        payload,
        state: row.get("state")?,
        attempts: row.get("attempts")?,
        run_at: row.get("run_at")?,
        locked_at: row.get("locked_at")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
    })
}

fn map_channel_row(row: &Row<'_>) -> rusqlite::Result<ChannelRecord> {
    let cfg_raw: String = row.get("config")?;
    let config: serde_json::Value = serde_json::from_str(&cfg_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(ChannelRecord {
        id: row.get("id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        config,
        state: row.get("state")?,
        created_at: row.get("created_at")?,
    })
}

fn map_outbox_row(row: &Row<'_>) -> rusqlite::Result<OutboxRecord> {
    let payload_raw: String = row.get("payload")?;
    let payload: serde_json::Value = serde_json::from_str(&payload_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(OutboxRecord {
        id: row.get("id")?,
        channel_id: row.get("channel_id")?,
        lead_id: row.get("lead_id")?,
        kind: row.get("kind")?,
        payload,
        state: row.get("state")?,
        attempts: row.get("attempts")?,
        next_try_at: row.get("next_try_at")?,
        sent_at: row.get("sent_at")?,
        remote_id: row.get("remote_id")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
    })
}

fn map_ai_call_row(row: &Row<'_>) -> rusqlite::Result<AiCallRecord> {
    Ok(AiCallRecord {
        id: row.get("id")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        task: row.get("task")?,
        radar_version_id: row.get("radar_version_id")?,
        item_count: row.get("item_count")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        cost_usd: row.get("cost_usd")?,
        duration_ms: row.get("duration_ms")?,
        status: row.get("status")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
    })
}

/// Default retry delay schedule per `03-desktop.md §3.1` based on 1-based `attempts` already run.
pub fn default_job_retry_delay_ms(kind: &str, attempts: i64) -> Option<i64> {
    match kind {
        "evaluate_batch" => match attempts {
            1 => Some(60_000),  // 1 minute
            2 => Some(300_000), // 5 minutes
            3 => Some(900_000), // 15 minutes
            _ => None,
        },
        "notify_lead" => match attempts {
            1 => Some(10_000),
            2 => Some(30_000),
            3 => Some(120_000),
            4 => Some(300_000),
            5 => Some(600_000),
            _ => None,
        },
        "suggest_fields" => (attempts <= 1).then_some(5_000),
        "compile_ruleset" => (attempts <= 1).then_some(3_600_000),
        _ => None,
    }
}

impl Store {
    // ========================================================================
    // Durable Job Queue (`04-data-model.md §2.6`, `03-desktop.md §3.1`)
    // ========================================================================

    /// Enqueue a durable job. If a `queued` or `running` job with the same non-null `dedup_key`
    /// already exists (`jobs_dedup` partial unique index), gracefully returns `(existing_job, false)`.
    pub fn enqueue_job(
        &self,
        kind: &str,
        dedup_key: Option<&str>,
        payload: &serde_json::Value,
        run_at: i64,
        now_ms: i64,
    ) -> Result<(JobRecord, bool), StoreError> {
        let payload_json = serde_json::to_string(payload)?;
        let id = new_ulid();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let inserted_rows = tx.execute(
            "INSERT OR IGNORE INTO jobs (
               id, kind, dedup_key, payload, state, attempts, run_at, locked_at, error, created_at
             ) VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, NULL, NULL, ?6)",
            params![id, kind, dedup_key, payload_json, run_at, now_ms],
        )?;

        if inserted_rows > 0 {
            let job = tx.query_row("SELECT * FROM jobs WHERE id = ?1", params![id], map_job_row)?;
            tx.commit()?;
            return Ok((job, true));
        }

        // Duplicate active `dedup_key` hit the partial unique index `jobs_dedup`.
        let dk = dedup_key.ok_or_else(|| {
            StoreError::InvalidArgument("job insert ignored unexpectedly without dedup_key".into())
        })?;
        let existing = tx.query_row(
            "SELECT * FROM jobs
             WHERE dedup_key = ?1 AND state IN ('queued', 'running')
             LIMIT 1",
            params![dk],
            map_job_row,
        )?;
        tx.commit()?;
        Ok((existing, false))
    }

    /// Atomically claim the earliest due job (`state = 'queued' AND run_at <= now_ms`),
    /// transitioning it to `running`, incrementing `attempts`, and setting `locked_at = now_ms`.
    pub fn claim_due_job(&self, now_ms: i64) -> Result<Option<JobRecord>, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let due_id: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs
                 WHERE state = 'queued' AND run_at <= ?1
                 ORDER BY run_at ASC, created_at ASC
                 LIMIT 1",
                params![now_ms],
                |r| r.get(0),
            )
            .optional()?;

        let Some(job_id) = due_id else {
            return Ok(None);
        };

        tx.execute(
            "UPDATE jobs
             SET state = 'running',
                 attempts = attempts + 1,
                 locked_at = ?1
             WHERE id = ?2",
            params![now_ms, job_id],
        )?;

        let claimed = tx.query_row(
            "SELECT * FROM jobs WHERE id = ?1",
            params![job_id],
            map_job_row,
        )?;
        tx.commit()?;
        Ok(Some(claimed))
    }

    /// Mark a job `done`.
    pub fn complete_job(&self, job_id: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE jobs
             SET state = 'done',
                 locked_at = NULL,
                 error = NULL
             WHERE id = ?1",
            params![job_id],
        )?;
        Ok(changed > 0)
    }

    /// Fail or reschedule a running job:
    /// - When `retry_at` is `Some(next_run_at)`: re-queues (`state = 'queued'`, `run_at = next_run_at`, `locked_at = NULL`).
    /// - When `retry_at` is `None`: marks terminal failure (`state = 'failed'`, `locked_at = NULL`).
    pub fn fail_or_retry_job(
        &self,
        job_id: &str,
        error: &str,
        retry_at: Option<i64>,
    ) -> Result<JobRecord, StoreError> {
        let conn = self.lock_conn()?;
        let changed = if let Some(next_run_at) = retry_at {
            conn.execute(
                "UPDATE jobs
                 SET state = 'queued',
                     run_at = ?1,
                     locked_at = NULL,
                     error = ?2
                 WHERE id = ?3",
                params![next_run_at, error, job_id],
            )?
        } else {
            conn.execute(
                "UPDATE jobs
                 SET state = 'failed',
                     locked_at = NULL,
                     error = ?1
                 WHERE id = ?2",
                params![error, job_id],
            )?
        };

        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "job",
                id: job_id.to_string(),
            });
        }

        let rec = conn.query_row(
            "SELECT * FROM jobs WHERE id = ?1",
            params![job_id],
            map_job_row,
        )?;
        Ok(rec)
    }

    /// Recover jobs left in `state = 'running'` with `locked_at <= stale_before_ms`
    /// (e.g. on startup after an unclean shutdown).
    pub fn recover_stale_running_jobs(
        &self,
        stale_before_ms: i64,
        now_ms: i64,
    ) -> Result<usize, StoreError> {
        let conn = self.lock_conn()?;
        let count = conn.execute(
            "UPDATE jobs
             SET state = 'queued',
                 locked_at = NULL,
                 run_at = ?1
             WHERE state = 'running' AND (locked_at IS NULL OR locked_at <= ?2)",
            params![now_ms, stale_before_ms],
        )?;
        Ok(count)
    }

    /// Fetch a job by ID.
    pub fn get_job(&self, job_id: &str) -> Result<Option<JobRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM jobs WHERE id = ?1",
                params![job_id],
                map_job_row,
            )
            .optional()?;
        Ok(rec)
    }

    // ========================================================================
    // Notification Channels & Outbox (`04-data-model.md §2.6`, `07-notifications-export.md`)
    // ========================================================================

    /// Create a notification channel (`telegram | webhook`).
    /// Note: tokens/secrets MUST live in the OS keyring (`04-data-model.md §4`), never in `config`.
    pub fn channel_create(
        &self,
        kind: &str,
        name: &str,
        config: &serde_json::Value,
        now_ms: i64,
    ) -> Result<ChannelRecord, StoreError> {
        let id = new_ulid();
        self.channel_upsert(&id, kind, name, config, "ok", now_ms)
    }

    /// Upsert a notification channel by ID.
    pub fn channel_upsert(
        &self,
        id: &str,
        kind: &str,
        name: &str,
        config: &serde_json::Value,
        state: &str,
        now_ms: i64,
    ) -> Result<ChannelRecord, StoreError> {
        if !matches!(kind, "telegram" | "webhook") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid channel kind '{kind}'"
            )));
        }
        if !matches!(state, "ok" | "error" | "paused") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid channel state '{state}'"
            )));
        }
        let cfg_json = serde_json::to_string(config)?;
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO channels (id, kind, name, config, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               name = excluded.name,
               config = excluded.config,
               state = excluded.state",
            params![id, kind, name, cfg_json, state, now_ms],
        )?;
        let rec = conn.query_row(
            "SELECT * FROM channels WHERE id = ?1",
            params![id],
            map_channel_row,
        )?;
        Ok(rec)
    }

    /// Fetch a channel by ID.
    pub fn channel_get(&self, channel_id: &str) -> Result<Option<ChannelRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let rec = conn
            .query_row(
                "SELECT * FROM channels WHERE id = ?1",
                params![channel_id],
                map_channel_row,
            )
            .optional()?;
        Ok(rec)
    }

    /// List all configured notification channels.
    pub fn channel_list(&self) -> Result<Vec<ChannelRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT * FROM channels ORDER BY created_at ASC")?;
        let rows = stmt
            .query_map([], map_channel_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Update operational state of a channel (e.g. `state = "error"` on HTTP 401/403).
    pub fn channel_set_state(&self, channel_id: &str, state: &str) -> Result<bool, StoreError> {
        if !matches!(state, "ok" | "error" | "paused") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid channel state '{state}'"
            )));
        }
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE channels SET state = ?1 WHERE id = ?2",
            params![state, channel_id],
        )?;
        Ok(changed > 0)
    }

    /// Update name and/or JSON config of an existing channel.
    pub fn channel_update_config(
        &self,
        channel_id: &str,
        name: Option<&str>,
        config: &serde_json::Value,
    ) -> Result<bool, StoreError> {
        let cfg_json = serde_json::to_string(config)?;
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE channels
             SET name = COALESCE(?1, name),
                 config = ?2
             WHERE id = ?3",
            params![name, cfg_json, channel_id],
        )?;
        Ok(changed > 0)
    }

    /// Delete a notification channel (cascades its outbox entries and removes its ID from `radars.notify`).
    pub fn channel_delete(&self, channel_id: &str) -> Result<bool, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let radars_with_notify: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, notify FROM radars")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (rid, notify_raw) in radars_with_notify {
            if let Ok(mut notify_cfg) =
                serde_json::from_str::<crate::models::NotifyConfig>(&notify_raw)
            {
                let before = notify_cfg.channel_ids.len();
                notify_cfg.channel_ids.retain(|cid| cid != channel_id);
                if notify_cfg.channel_ids.len() != before {
                    let updated_json = serde_json::to_string(&notify_cfg)?;
                    tx.execute(
                        "UPDATE radars SET notify = ?1 WHERE id = ?2",
                        params![updated_json, rid],
                    )?;
                }
            }
        }

        let changed = tx.execute("DELETE FROM channels WHERE id = ?1", params![channel_id])?;
        tx.commit()?;
        Ok(changed > 0)
    }

    /// Enqueue an outbound notification (`lead | digest | system`).
    pub fn enqueue_outbox(&self, input: &EnqueueOutboxInput) -> Result<OutboxRecord, StoreError> {
        if !matches!(input.kind.as_str(), "lead" | "digest" | "system") {
            return Err(StoreError::InvalidArgument(format!(
                "invalid outbox kind '{}'",
                input.kind
            )));
        }
        let id = input.id.clone().unwrap_or_else(new_ulid);
        let payload_json = serde_json::to_string(&input.payload)?;
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO outbox (
               id, channel_id, lead_id, kind, payload, state, attempts,
               next_try_at, sent_at, remote_id, error, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, NULL, NULL, NULL, ?7)",
            params![
                id,
                input.channel_id,
                input.lead_id,
                input.kind,
                payload_json,
                input.next_try_at,
                input.now_ms,
            ],
        )?;
        let rec = conn.query_row(
            "SELECT * FROM outbox WHERE id = ?1",
            params![id],
            map_outbox_row,
        )?;
        Ok(rec)
    }

    /// Claim the earliest due `pending` outbox item on a healthy (`state = 'ok'`) channel,
    /// incrementing `attempts` and advancing `next_try_at` by a 60s in-flight lease.
    pub fn claim_due_outbox(&self, now_ms: i64) -> Result<Option<OutboxRecord>, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let due_id: Option<String> = tx
            .query_row(
                "SELECT o.id
                 FROM outbox o
                 JOIN channels c ON c.id = o.channel_id
                 WHERE o.state = 'pending'
                   AND o.next_try_at <= ?1
                   AND c.state = 'ok'
                 ORDER BY o.next_try_at ASC, o.created_at ASC
                 LIMIT 1",
                params![now_ms],
                |r| r.get(0),
            )
            .optional()?;

        let Some(oid) = due_id else {
            return Ok(None);
        };

        tx.execute(
            "UPDATE outbox
             SET attempts = attempts + 1,
                 next_try_at = ?1
             WHERE id = ?2",
            params![now_ms.saturating_add(60_000), oid],
        )?;

        let rec = tx.query_row(
            "SELECT * FROM outbox WHERE id = ?1",
            params![oid],
            map_outbox_row,
        )?;
        tx.commit()?;
        Ok(Some(rec))
    }

    /// Mark an outbox item `sent`, recording `remote_id` (e.g. Telegram `message_id`),
    /// and stamping `leads.notified_at` + `lead_events(kind = 'notified')` if tied to a lead.
    pub fn mark_outbox_sent(
        &self,
        outbox_id: &str,
        remote_id: Option<&str>,
        sent_at: i64,
    ) -> Result<bool, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;

        let meta: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT channel_id, lead_id FROM outbox WHERE id = ?1",
                params![outbox_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let Some((channel_id, lead_id_opt)) = meta else {
            return Ok(false);
        };

        tx.execute(
            "UPDATE outbox
             SET state = 'sent',
                 sent_at = ?1,
                 remote_id = ?2,
                 error = NULL
             WHERE id = ?3",
            params![sent_at, remote_id, outbox_id],
        )?;

        if let Some(lead_id) = lead_id_opt {
            tx.execute(
                "UPDATE leads
                 SET notified_at = COALESCE(notified_at, ?1),
                     updated_at = MAX(updated_at, ?1)
                 WHERE id = ?2",
                params![sent_at, lead_id],
            )?;
            let ev_data = serde_json::to_string(&serde_json::json!({
                "channel_id": channel_id,
                "remote_id": remote_id,
            }))?;
            tx.execute(
                "INSERT INTO lead_events (id, lead_id, kind, data, created_at)
                 VALUES (?1, ?2, 'notified', ?3, ?4)",
                params![new_ulid(), lead_id, ev_data, sent_at],
            )?;
        }

        tx.commit()?;
        Ok(true)
    }

    /// Retry, drop (if queued > `max_age_ms`, default 2h per `07-notifications-export.md §2.4`),
    /// or fail an outbox entry.
    pub fn retry_or_drop_outbox(
        &self,
        outbox_id: &str,
        error: &str,
        next_try_at: Option<i64>,
        max_attempts: i64,
        max_age_ms: i64,
        now_ms: i64,
    ) -> Result<OutboxRecord, StoreError> {
        let conn = self.lock_conn()?;
        let (attempts, created_at): (i64, i64) = conn
            .query_row(
                "SELECT attempts, created_at FROM outbox WHERE id = ?1",
                params![outbox_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                entity: "outbox",
                id: outbox_id.to_string(),
            })?;

        if now_ms.saturating_sub(created_at) > max_age_ms {
            conn.execute(
                "UPDATE outbox SET state = 'dropped', error = ?1 WHERE id = ?2",
                params![error, outbox_id],
            )?;
        } else if let Some(next_ts) = next_try_at.filter(|_| attempts < max_attempts) {
            conn.execute(
                "UPDATE outbox
                 SET state = 'pending',
                     next_try_at = ?1,
                     error = ?2
                 WHERE id = ?3",
                params![next_ts, error, outbox_id],
            )?;
        } else {
            conn.execute(
                "UPDATE outbox SET state = 'failed', error = ?1 WHERE id = ?2",
                params![error, outbox_id],
            )?;
        }

        let rec = conn.query_row(
            "SELECT * FROM outbox WHERE id = ?1",
            params![outbox_id],
            map_outbox_row,
        )?;
        Ok(rec)
    }

    // ========================================================================
    // AI Calls & Daily Usage (`04-data-model.md §2.6`, `06-ai-bridge.md §7`)
    // ========================================================================

    /// Record an AI CLI call (`ai_calls` never stores prompt/response bodies).
    pub fn record_ai_call(&self, input: &RecordAiCallInput) -> Result<AiCallRecord, StoreError> {
        let id = input.id.clone().unwrap_or_else(new_ulid);
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO ai_calls (
               id, provider, model, task, radar_version_id, item_count,
               input_tokens, output_tokens, cost_usd, duration_ms, status, error, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                input.provider,
                input.model,
                input.task,
                input.radar_version_id,
                input.item_count,
                input.input_tokens,
                input.output_tokens,
                input.cost_usd,
                input.duration_ms,
                input.status,
                input.error,
                input.now_ms,
            ],
        )?;
        let rec = conn.query_row(
            "SELECT * FROM ai_calls WHERE id = ?1",
            params![id],
            map_ai_call_row,
        )?;
        Ok(rec)
    }

    /// Aggregate daily AI usage over the last `days` days (`calls`, `items`, `input_tokens`,
    /// `output_tokens`, `cost_usd`, and `ai_escalation_rate`).
    pub fn ai_usage_get(&self, days: u32, now_ms: i64) -> Result<AiUsageReport, StoreError> {
        const DAY_MS: i64 = 86_400_000;
        let days = days.clamp(1, 365);
        let today_bucket = now_ms.div_euclid(DAY_MS);
        let start_bucket = today_bucket - i64::from(days - 1);
        let since_ms = start_bucket * DAY_MS;

        let conn = self.lock_conn()?;

        let mut daily_map: BTreeMap<i64, DailyAiUsage> = BTreeMap::new();
        for b in start_bucket..=today_bucket {
            daily_map.insert(
                b,
                DailyAiUsage {
                    day_start_ms: b * DAY_MS,
                    date: unix_day_to_ymd(b),
                    calls: 0,
                    items: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: 0.0,
                    evaluated_posts: 0,
                    ai_escalated_posts: 0,
                    ai_escalation_rate: 0.0,
                },
            );
        }

        {
            let mut stmt = conn.prepare(
                "SELECT
                   (created_at / 86400000) AS day_bucket,
                   COUNT(*),
                   COALESCE(SUM(item_count), 0),
                   COALESCE(SUM(COALESCE(input_tokens, 0)), 0),
                   COALESCE(SUM(COALESCE(output_tokens, 0)), 0),
                   COALESCE(SUM(COALESCE(cost_usd, 0.0)), 0.0)
                 FROM ai_calls
                 WHERE created_at >= ?1
                 GROUP BY day_bucket",
            )?;
            let rows = stmt.query_map(params![since_ms], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, f64>(5)?,
                ))
            })?;
            for item in rows {
                let (b, calls, items, in_tok, out_tok, cost) = item?;
                if let Some(entry) = daily_map.get_mut(&b) {
                    entry.calls = calls;
                    entry.items = items;
                    entry.input_tokens = in_tok;
                    entry.output_tokens = out_tok;
                    entry.cost_usd = cost;
                }
            }
        }

        {
            let mut stmt = conn.prepare(
                "SELECT
                   (created_at / 86400000) AS day_bucket,
                   COUNT(*),
                   COALESCE(SUM(CASE
                     WHEN decided_by = 'ai' OR ai_call_id IS NOT NULL OR state IN ('pending_ai', 'ai_failed')
                     THEN 1 ELSE 0
                   END), 0)
                 FROM evaluations
                 WHERE is_preview = 0 AND created_at >= ?1
                 GROUP BY day_bucket",
            )?;
            let rows = stmt.query_map(params![since_ms], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for item in rows {
                let (b, eval_total, ai_esc) = item?;
                if let Some(entry) = daily_map.get_mut(&b) {
                    entry.evaluated_posts = eval_total;
                    entry.ai_escalated_posts = ai_esc;
                    if eval_total > 0 {
                        entry.ai_escalation_rate = (ai_esc as f64) / (eval_total as f64);
                    }
                }
            }
        }

        let mut total_calls = 0i64;
        let mut total_items = 0i64;
        let mut total_input_tokens = 0i64;
        let mut total_output_tokens = 0i64;
        let mut total_cost_usd = 0.0f64;
        let mut total_eval = 0i64;
        let mut total_ai_esc = 0i64;

        let days_vec: Vec<DailyAiUsage> = daily_map
            .into_values()
            .inspect(|d| {
                total_calls += d.calls;
                total_items += d.items;
                total_input_tokens += d.input_tokens;
                total_output_tokens += d.output_tokens;
                total_cost_usd += d.cost_usd;
                total_eval += d.evaluated_posts;
                total_ai_esc += d.ai_escalated_posts;
            })
            .collect();

        let overall_ai_escalation_rate = if total_eval > 0 {
            (total_ai_esc as f64) / (total_eval as f64)
        } else {
            0.0
        };

        Ok(AiUsageReport {
            days: days_vec,
            total_calls,
            total_items,
            total_input_tokens,
            total_output_tokens,
            total_cost_usd,
            overall_ai_escalation_rate,
        })
    }

    /// Count total items sent to AI since the start of the current UTC day (`06-ai-bridge.md §7`:
    /// default cap 2,000 posts/day).
    pub fn count_ai_items_today(&self, now_ms: i64) -> Result<i64, StoreError> {
        const DAY_MS: i64 = 86_400_000;
        let day_start = now_ms.div_euclid(DAY_MS) * DAY_MS;
        let conn = self.lock_conn()?;
        let items: i64 = conn.query_row(
            "SELECT COALESCE(SUM(item_count), 0)
             FROM ai_calls
             WHERE created_at >= ?1",
            params![day_start],
            |r| r.get(0),
        )?;
        Ok(items)
    }

    // ========================================================================
    // Typed JSON Settings (`04-data-model.md §2.6`)
    // ========================================================================

    /// Read and deserialize a typed JSON setting by `key`.
    pub fn get_setting<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, StoreError> {
        let conn = self.lock_conn()?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        match raw {
            Some(s) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// Write a typed JSON setting by `key`.
    pub fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StoreError> {
        let json = serde_json::to_string(value)?;
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, json],
        )?;
        Ok(())
    }

    /// Remove a setting by `key`.
    pub fn delete_setting(&self, key: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let changed = conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(changed > 0)
    }

    /// Return all settings as a sorted `BTreeMap<String, serde_json::Value>`.
    pub fn settings_get_all(&self) -> Result<BTreeMap<String, serde_json::Value>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = BTreeMap::new();
        for item in rows {
            let (k, raw) = item?;
            map.insert(k, serde_json::from_str(&raw)?);
        }
        Ok(map)
    }
}

/// Proleptic Gregorian civil date (`YYYY-MM-DD`) from Unix day count (Howard Hinnant algorithm).
fn unix_day_to_ymd(unix_days: i64) -> String {
    let z = unix_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}
