//! Page-load counts behind the account-safety log: how heavily the account was used before an
//! incident, and on which days scanning actually ran.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// Scanning activity for one local calendar day. Only days with at least one crawl run appear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlDayActivity {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub runs: i64,
    pub page_loads: i64,
    /// Runs that ended `blocked` (a login or verification page was hit).
    pub blocked_runs: i64,
}

impl Store {
    /// Page loads recorded by crawl runs that started in `[since_ms, until_ms)`.
    pub fn page_loads_between(&self, since_ms: i64, until_ms: i64) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(page_loads), 0) FROM crawl_runs
             WHERE started_at >= ?1 AND started_at < ?2",
            params![since_ms, until_ms],
            |r| r.get(0),
        )?)
    }

    /// Crawl activity per local day since `since_ms`, oldest first.
    pub fn crawl_activity_by_day(
        &self,
        since_ms: i64,
    ) -> Result<Vec<CrawlDayActivity>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                    COUNT(*), COALESCE(SUM(page_loads), 0),
                    COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0)
             FROM crawl_runs WHERE started_at >= ?1
             GROUP BY day ORDER BY day ASC",
        )?;
        let rows = stmt
            .query_map(params![since_ms], |r| {
                Ok(CrawlDayActivity {
                    date: r.get(0)?,
                    runs: r.get(1)?,
                    page_loads: r.get(2)?,
                    blocked_runs: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
