//! First-run journey: when the app was first started, when the first Radar was switched on,
//! and the facts that explain why no lead has reached the user yet.
//!
//! Install time and Radar creation time are different numbers. A user can install on Monday and
//! create the Radar on Friday; the journey keeps both so first-lead timings are not blamed on the
//! wrong step.

use super::*;
use dealsonar_store::Store;
use serde::{Deserialize, Serialize};

const INSTALLED_KEY: &str = "journey.installed_at";
const FIRST_ACTIVATED_KEY: &str = "journey.first_radar_activated_at";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct InstallRecord {
    at: i64,
    /// The database already held data when this build first started, so `at` is the earliest
    /// timestamp found rather than a measured first launch.
    estimated: bool,
}

/// Record the first launch once. Safe to call on every start.
pub(crate) fn record_install(store: &Store, now: i64) -> CoreResult<()> {
    if store.get_setting::<InstallRecord>(INSTALLED_KEY)?.is_some() {
        return Ok(());
    }
    let snapshot = store.journey_snapshot()?;
    let earliest = [
        snapshot.first_followed_source_at,
        snapshot.first_radar_created_at,
        snapshot.first_post_captured_at,
    ]
    .into_iter()
    .flatten()
    .min();
    let record = match earliest {
        Some(at) if at < now => InstallRecord {
            at,
            estimated: true,
        },
        _ => InstallRecord {
            at: now,
            estimated: false,
        },
    };
    store.set_setting(INSTALLED_KEY, &record)?;
    Ok(())
}

/// Remember the first time any Radar was switched on (not the time it was created).
pub(crate) fn record_first_activation(store: &Store, now: i64) -> CoreResult<()> {
    if store.get_setting::<i64>(FIRST_ACTIVATED_KEY)?.is_none() {
        store.set_setting(FIRST_ACTIVATED_KEY, &now)?;
    }
    Ok(())
}

pub(crate) fn first_news_status(store: &Store, now: i64) -> CoreResult<FirstNewsStatus> {
    record_install(store, now)?;
    let install = store
        .get_setting::<InstallRecord>(INSTALLED_KEY)?
        .unwrap_or(InstallRecord {
            at: now,
            estimated: false,
        });
    Ok(FirstNewsStatus {
        installed_at: install.at,
        installed_at_estimated: install.estimated,
        first_radar_activated_at: store.get_setting::<i64>(FIRST_ACTIVATED_KEY)?,
        facts: store.journey_snapshot()?,
        checked_at: now,
    })
}

impl CoreService {
    pub fn first_news_status(&self) -> CoreResult<FirstNewsStatus> {
        first_news_status(&self.rt.store, now_ms())
    }
}
