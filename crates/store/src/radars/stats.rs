//! Radar funnel statistics.

use super::*;

impl Store {
    /// Compute 7-day pipeline funnel statistics (`05-pipeline-rules.md §11`).
    /// Pass `Some(radar_id)` for a single radar or `None` for global Health funnel stats.
    pub fn radar_stats(
        &self,
        radar_id: Option<&str>,
        now_ms: i64,
    ) -> Result<RadarFunnelStats, StoreError> {
        let since_7d = now_ms.saturating_sub(7 * 86_400_000);
        let conn = self.lock_conn()?;

        let (
            total_evaluated,
            dedup_rejected,
            prefilter_rejected,
            rule_decided,
            rule_matched,
            ai_decided,
            ai_matched,
            postfilter_rejected,
            pending_ai,
            ai_failed,
        ): (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) = if let Some(rid) = radar_id {
            conn.query_row(
                "SELECT
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'dedup' OR e.reject_reason = 'duplicate' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'prefilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'postfilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'pending_ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'ai_failed' THEN 1 ELSE 0 END), 0)
                 FROM evaluations e
                 JOIN radar_versions rv ON rv.id = e.radar_version_id
                 WHERE rv.radar_id = ?1 AND e.is_preview = 0 AND e.created_at >= ?2",
                params![rid, since_7d],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )?
        } else {
            conn.query_row(
                "SELECT
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'dedup' OR e.reject_reason = 'duplicate' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'prefilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'rule' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'ai' AND e.verdict = 'match' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.decided_by = 'postfilter' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'pending_ai' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN e.state = 'ai_failed' THEN 1 ELSE 0 END), 0)
                 FROM evaluations e
                 WHERE e.is_preview = 0 AND e.created_at >= ?1",
                params![since_7d],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )?
        };

        let (leads_total, leads_notified, leads_weak_match): (i64, i64, i64) = if let Some(rid) =
            radar_id
        {
            conn.query_row(
                    "SELECT
                       COUNT(*),
                       COALESCE(SUM(CASE WHEN l.notified_at IS NOT NULL THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE
                         WHEN l.score < COALESCE(CAST(json_extract(r.notify, '$.min_score') AS REAL), 0.6)
                         THEN 1 ELSE 0
                       END), 0)
                     FROM leads l
                     JOIN radars r ON r.id = l.radar_id
                     WHERE l.radar_id = ?1 AND l.created_at >= ?2",
                    params![rid, since_7d],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
        } else {
            conn.query_row(
                    "SELECT
                       COUNT(*),
                       COALESCE(SUM(CASE WHEN l.notified_at IS NOT NULL THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE
                         WHEN l.score < COALESCE(CAST(json_extract(r.notify, '$.min_score') AS REAL), 0.6)
                         THEN 1 ELSE 0
                       END), 0)
                     FROM leads l
                     JOIN radars r ON r.id = l.radar_id
                     WHERE l.created_at >= ?1",
                    params![since_7d],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
        };

        let false_positive_count: i64 = if let Some(rid) = radar_id {
            conn.query_row(
                "SELECT COUNT(DISTINCT f.evaluation_id)
                 FROM feedback f
                 JOIN radar_versions rv ON rv.id = f.radar_version_id
                 WHERE rv.radar_id = ?1
                   AND f.created_at >= ?2
                   AND f.origin != 'preview'
                   AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')",
                params![rid, since_7d],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(DISTINCT f.evaluation_id)
                 FROM feedback f
                 WHERE f.created_at >= ?1
                   AND f.origin != 'preview'
                   AND f.label IN ('irrelevant', 'peer', 'duplicate', 'spam')",
                params![since_7d],
                |r| r.get(0),
            )?
        };

        let fp_denom = if leads_notified > 0 {
            leads_notified
        } else {
            leads_total
        };
        let false_positive_rate = if fp_denom > 0 {
            ((false_positive_count as f64) / (fp_denom as f64)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let rule_vs_ai_total = prefilter_rejected + rule_decided + ai_decided;
        let rule_handled_ratio = if rule_vs_ai_total > 0 {
            ((prefilter_rejected + rule_decided) as f64) / (rule_vs_ai_total as f64)
        } else {
            0.0
        };

        Ok(RadarFunnelStats {
            total_evaluated,
            dedup_rejected,
            prefilter_rejected,
            rule_decided,
            rule_matched,
            ai_decided,
            ai_matched,
            postfilter_rejected,
            pending_ai,
            ai_failed,
            leads_total,
            leads_notified,
            leads_weak_match,
            false_positive_count,
            false_positive_rate,
            rule_handled_ratio,
        })
    }
}
