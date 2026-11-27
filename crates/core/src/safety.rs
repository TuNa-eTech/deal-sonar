//! Account-safety log for the long observation (H5): every time Facebook asks the account for
//! verification, signs it out or limits it, record when, what and how many pages DealSonar had
//! loaded in the 24 hours before. Scanning is already halted on those events; the log lets the
//! owner judge whether the default scan settings are safe over 30 days.
//!
//! Nothing here stores a Facebook account name, email or cookie. The `detail` text comes from
//! the extension's URL or page markers and is cut to a short length.

use dealsonar_store::{CrawlDayActivity, Store};
use serde::{Deserialize, Serialize};

use crate::dto::{CrawlPolicySettings, Settings};
use crate::error::CoreResult;

const INCIDENTS_KEY: &str = "safety.account_incidents";
const MAX_INCIDENTS: usize = 500;
const MAX_DETAIL_CHARS: usize = 160;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// What Facebook asked of the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountIncidentKind {
    /// Verification or checkpoint page.
    Checkpoint,
    /// Signed out unexpectedly.
    LoggedOut,
    /// Rate-limit or restriction notice.
    RateLimited,
    /// The extension could not tell.
    Unknown,
}

/// One session problem. Scanning is paused from `occurred_at` until the session is healthy again
/// (and, for a verification, until the user resumes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountIncident {
    pub id: String,
    pub kind: AccountIncidentKind,
    pub occurred_at: i64,
    pub detail: String,
    /// Page loads by crawl runs in the 24 hours before the incident.
    pub page_loads_24h: i64,
    /// Page loads in the hour before the incident.
    pub page_loads_1h: i64,
    /// Scanning was halted when the incident was recorded.
    pub scanning_paused: bool,
    /// When the extension next reported a healthy session.
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSafetyReport {
    pub generated_at: i64,
    pub app_version: String,
    pub window_days: u32,
    /// The scan settings in force when the report was made (not a history of changes).
    pub crawl_policy: CrawlPolicySettings,
    pub followed_groups: i64,
    /// Days within the window on which at least one scan ran.
    pub active_days: Vec<CrawlDayActivity>,
    pub incidents: Vec<AccountIncident>,
}

fn load(store: &Store) -> CoreResult<Vec<AccountIncident>> {
    Ok(store
        .get_setting::<Vec<AccountIncident>>(INCIDENTS_KEY)?
        .unwrap_or_default())
}

fn save(store: &Store, mut incidents: Vec<AccountIncident>) -> CoreResult<()> {
    if incidents.len() > MAX_INCIDENTS {
        let excess = incidents.len() - MAX_INCIDENTS;
        incidents.drain(..excess);
    }
    store.set_setting(INCIDENTS_KEY, &incidents)?;
    Ok(())
}

/// Log a new session problem. The caller invokes this only on a change of state, so a repeated
/// report of the same problem does not create a second entry.
pub fn record_incident(
    store: &Store,
    kind: AccountIncidentKind,
    detail: Option<&str>,
    now: i64,
) -> CoreResult<AccountIncident> {
    let mut detail: String = detail
        .unwrap_or_default()
        .chars()
        .take(MAX_DETAIL_CHARS)
        .collect();
    detail = detail.trim().to_string();
    let incident = AccountIncident {
        id: dealsonar_protocol::new_ulid(),
        kind,
        occurred_at: now,
        detail,
        page_loads_24h: store.page_loads_between(now - DAY_MS, now + 1)?,
        page_loads_1h: store.page_loads_between(now - HOUR_MS, now + 1)?,
        scanning_paused: true,
        resolved_at: None,
    };
    let mut incidents = load(store)?;
    incidents.push(incident.clone());
    save(store, incidents)?;
    Ok(incident)
}

/// Mark every open incident as resolved once the session is healthy again.
pub fn resolve_open_incidents(store: &Store, now: i64) -> CoreResult<usize> {
    let mut incidents = load(store)?;
    let mut changed = 0;
    for incident in incidents.iter_mut().filter(|i| i.resolved_at.is_none()) {
        incident.resolved_at = Some(now);
        changed += 1;
    }
    if changed > 0 {
        save(store, incidents)?;
    }
    Ok(changed)
}

pub fn account_safety_report(
    store: &Store,
    settings: &Settings,
    window_days: u32,
    now: i64,
) -> CoreResult<AccountSafetyReport> {
    let window_days = window_days.clamp(1, 365);
    let since = now - i64::from(window_days) * DAY_MS;
    Ok(AccountSafetyReport {
        generated_at: now,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        window_days,
        crawl_policy: settings.crawl_policy.clone(),
        followed_groups: store.count_followed_sources()?,
        active_days: store.crawl_activity_by_day(since)?,
        incidents: load(store)?
            .into_iter()
            .filter(|incident| incident.occurred_at >= since)
            .collect(),
    })
}
