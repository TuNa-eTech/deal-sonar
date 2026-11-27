//! Reconciliation around declared interruptions: what was late, what is still open, whether
//! anything was sent twice, and how long recovery took.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{Distribution, Interruption, SoakOptions};
use crate::StoreError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterruptionReport {
    pub kind: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_ms: i64,
    pub note: Option<String>,

    /// Posts published while things were down, and how many only arrived after recovery.
    pub posts_published_during: i64,
    pub posts_published_during_captured_late: i64,
    pub posts_captured_during: i64,
    /// Publication-to-capture time of the posts that were captured late.
    pub late_capture_lag: Distribution,

    /// Evaluations waiting for AI when the interruption started and ended.
    pub backlog_at_start: i64,
    pub backlog_at_end: i64,
    /// When the last evaluation waiting at the end was decided, if all of them were.
    pub backlog_cleared_at_ms: Option<i64>,
    pub backlog_drain_ms: Option<i64>,
    pub evaluations_created_during: i64,
    pub evaluation_delay: Distribution,
    /// Evaluations from before the end of the interruption that are still not done.
    pub evaluations_unresolved_now: i64,

    pub ai_calls_during: BTreeMap<String, i64>,
    pub first_ok_ai_call_at_ms: Option<i64>,
    pub ai_recovery_ms: Option<i64>,

    pub leads_created_during: i64,
    pub leads_notified_after_end: i64,
    /// End of the interruption to delivery, for leads created during it.
    pub notification_delay_after_end: Distribution,
    pub leads_never_notified: i64,
    pub messages_failed_or_dropped: i64,
    pub messages_retried: i64,
    pub leads_sent_more_than_once: i64,

    /// Plain-language reading of the numbers above.
    pub findings: Vec<String>,
}

fn one(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<i64, StoreError> {
    Ok(conn.query_row(sql, p, |r| r.get(0))?)
}

fn many(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<i64>, StoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(p, |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(super) fn reconcile(
    conn: &Connection,
    opts: &SoakOptions,
) -> Result<Vec<InterruptionReport>, StoreError> {
    opts.interruptions
        .iter()
        .map(|i| reconcile_one(conn, i))
        .collect()
}

fn backlog_at(conn: &Connection, t: i64) -> Result<i64, StoreError> {
    one(
        conn,
        "SELECT COUNT(*) FROM evaluations
         WHERE is_preview = 0 AND created_at <= ?1 AND (decided_at IS NULL OR decided_at > ?1)",
        params![t],
    )
}

fn reconcile_one(conn: &Connection, i: &Interruption) -> Result<InterruptionReport, StoreError> {
    let (s, e) = (i.start_ms, i.end_ms.max(i.start_ms));

    let posts_published_during = one(
        conn,
        "SELECT COUNT(*) FROM posts WHERE created_at BETWEEN ?1 AND ?2
           AND (dup_cluster_id IS NULL OR is_cluster_head = 1)",
        params![s, e],
    )?;
    let late_lags = many(
        conn,
        "SELECT captured_at - created_at FROM posts
         WHERE created_at BETWEEN ?1 AND ?2 AND captured_at > ?2
           AND (dup_cluster_id IS NULL OR is_cluster_head = 1)",
        params![s, e],
    )?;
    let posts_captured_during = one(
        conn,
        "SELECT COUNT(*) FROM posts WHERE captured_at BETWEEN ?1 AND ?2
           AND (dup_cluster_id IS NULL OR is_cluster_head = 1)",
        params![s, e],
    )?;

    let backlog_at_start = backlog_at(conn, s)?;
    let backlog_at_end = backlog_at(conn, e)?;
    let (open_at_end, last_decided): (i64, Option<i64>) = conn.query_row(
        "SELECT COALESCE(SUM(decided_at IS NULL), 0), MAX(decided_at) FROM evaluations
         WHERE is_preview = 0 AND created_at <= ?1 AND (decided_at IS NULL OR decided_at > ?1)",
        params![e],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let backlog_cleared_at_ms = (backlog_at_end > 0 && open_at_end == 0)
        .then_some(last_decided)
        .flatten();

    let evaluations_created_during = one(
        conn,
        "SELECT COUNT(*) FROM evaluations WHERE is_preview = 0 AND created_at BETWEEN ?1 AND ?2",
        params![s, e],
    )?;
    let evaluation_delay = many(
        conn,
        "SELECT MAX(decided_at - created_at, 0) FROM evaluations
         WHERE is_preview = 0 AND created_at BETWEEN ?1 AND ?2 AND decided_at IS NOT NULL",
        params![s, e],
    )?;
    let evaluations_unresolved_now = one(
        conn,
        "SELECT COUNT(*) FROM evaluations
         WHERE is_preview = 0 AND created_at <= ?1 AND state IN ('pending_ai', 'ai_failed')",
        params![e],
    )?;

    let mut ai_calls_during = BTreeMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*) FROM ai_calls WHERE created_at BETWEEN ?1 AND ?2 GROUP BY status",
        )?;
        let rows = stmt.query_map(params![s, e], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (status, n) = row?;
            ai_calls_during.insert(status, n);
        }
    }
    let first_ok_ai_call_at_ms: Option<i64> = conn.query_row(
        "SELECT MIN(created_at) FROM ai_calls WHERE status = 'ok' AND created_at >= ?1",
        params![e],
        |r| r.get(0),
    )?;

    let leads_created_during = one(
        conn,
        "SELECT COUNT(*) FROM leads WHERE created_at BETWEEN ?1 AND ?2",
        params![s, e],
    )?;
    let delivery_times: Vec<Option<i64>> = {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(MIN(o.sent_at), l.notified_at) FROM leads l
             LEFT JOIN outbox o ON o.lead_id = l.id AND o.state = 'sent'
             WHERE l.created_at BETWEEN ?1 AND ?2 GROUP BY l.id",
        )?;
        let rows = stmt.query_map(params![s, e], |r| r.get::<_, Option<i64>>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let late: Vec<i64> = delivery_times
        .iter()
        .flatten()
        .filter(|t| **t > e)
        .map(|t| t - e)
        .collect();
    let leads_never_notified = delivery_times.iter().filter(|t| t.is_none()).count() as i64;
    let (failed, retried): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(state IN ('failed', 'dropped')), 0), COALESCE(SUM(attempts > 1 OR error IS NOT NULL), 0)
         FROM outbox WHERE created_at BETWEEN ?1 AND ?2",
        params![s, e],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let leads_sent_more_than_once = one(
        conn,
        "SELECT COUNT(*) FROM (
           SELECT 1 FROM outbox o JOIN leads l ON l.id = o.lead_id
           WHERE o.state = 'sent' AND l.created_at BETWEEN ?1 AND ?2
           GROUP BY o.lead_id, o.channel_id HAVING COUNT(*) > 1)",
        params![s, e],
    )?;

    let mut report = InterruptionReport {
        kind: i.kind.clone(),
        start_ms: s,
        end_ms: e,
        duration_ms: e - s,
        note: i.note.clone(),
        posts_published_during,
        posts_published_during_captured_late: late_lags.len() as i64,
        posts_captured_during,
        late_capture_lag: Distribution::from_values(late_lags),
        backlog_at_start,
        backlog_at_end,
        backlog_cleared_at_ms,
        backlog_drain_ms: backlog_cleared_at_ms.map(|t| (t - e).max(0)),
        evaluations_created_during,
        evaluation_delay: Distribution::from_values(evaluation_delay),
        evaluations_unresolved_now,
        ai_calls_during,
        first_ok_ai_call_at_ms,
        ai_recovery_ms: first_ok_ai_call_at_ms.map(|t| t - e),
        leads_created_during,
        leads_notified_after_end: late.len() as i64,
        notification_delay_after_end: Distribution::from_values(late),
        leads_never_notified,
        messages_failed_or_dropped: failed,
        messages_retried: retried,
        leads_sent_more_than_once,
        findings: Vec::new(),
    };
    report.findings = findings(&report);
    Ok(report)
}

fn findings(r: &InterruptionReport) -> Vec<String> {
    let mut out = Vec::new();
    if r.posts_published_during_captured_late > 0 {
        out.push(format!(
            "{} bài đăng trong lúc gián đoạn chỉ được thu sau khi phục hồi (chậm nhất {} phút sau khi đăng).",
            r.posts_published_during_captured_late,
            r.late_capture_lag.max.unwrap_or(0) / 60_000
        ));
    }
    if r.backlog_at_end > 0 {
        match r.backlog_drain_ms {
            Some(ms) => out.push(format!(
                "{} lượt chấm đang chờ lúc kết thúc; xử lý hết sau {} phút.",
                r.backlog_at_end,
                ms / 60_000
            )),
            None => out.push(format!(
                "{} lượt chấm đang chờ lúc kết thúc và vẫn chưa xử lý hết.",
                r.backlog_at_end
            )),
        }
    }
    if r.evaluations_unresolved_now > 0 {
        out.push(format!(
            "{} lượt chấm từ trước lúc kết thúc vẫn chờ AI hoặc lỗi AI: có thể bị sót.",
            r.evaluations_unresolved_now
        ));
    }
    let ai_bad: i64 = r
        .ai_calls_during
        .iter()
        .filter(|(status, _)| status.as_str() != "ok")
        .map(|(_, n)| n)
        .sum();
    if ai_bad > 0 {
        out.push(format!(
            "{ai_bad} lần gọi AI lỗi hoặc chạm hạn mức trong khoảng này."
        ));
    }
    if let Some(ms) = r
        .ai_recovery_ms
        .filter(|_| ai_bad > 0 || r.kind == "ai_quota")
    {
        out.push(format!(
            "Lần gọi AI thành công đầu tiên sau gián đoạn: sau {} phút.",
            ms.max(0) / 60_000
        ));
    }
    if r.leads_notified_after_end > 0 {
        out.push(format!(
            "{} tin tạo trong lúc gián đoạn được gửi sau khi kết thúc (trung vị {} phút).",
            r.leads_notified_after_end,
            r.notification_delay_after_end.p50.unwrap_or(0) / 60_000
        ));
    }
    if r.leads_never_notified > 0 {
        out.push(format!(
            "{} tin tạo trong lúc gián đoạn chưa có thông báo nào (gồm tin điểm thấp và tin quá hạn, cần đối chiếu từng tin).",
            r.leads_never_notified
        ));
    }
    if r.messages_failed_or_dropped > 0 {
        out.push(format!(
            "{} thông báo thất bại hoặc bị bỏ.",
            r.messages_failed_or_dropped
        ));
    }
    if r.leads_sent_more_than_once > 0 {
        out.push(format!(
            "{} tin bị gửi trùng tới cùng một kênh sau phục hồi.",
            r.leads_sent_more_than_once
        ));
    }
    if out.is_empty() {
        out.push("Không thấy bài chậm, sót hay gửi trùng quanh khoảng này.".to_string());
    }
    out
}
