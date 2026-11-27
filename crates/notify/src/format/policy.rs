//! Quiet hours and notification policy decisions.

use super::*;

/// Quiet hours window (`"HH:MM"` 24-hour local time, e.g. `22:30` to `06:30`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuietHours {
    pub from: String,
    pub to: String,
}

pub(super) fn parse_hh_mm(s: &str) -> Option<u16> {
    let (h_str, m_str) = s.trim().split_once(':')?;
    let h: u16 = h_str.parse().ok()?;
    let m: u16 = m_str.parse().ok()?;
    if h < 24 && m < 60 {
        Some(h * 60 + m)
    } else {
        None
    }
}

/// Returns `true` if `local_minutes_since_midnight` (`hour * 60 + minute`) falls inside `quiet`.
pub fn is_in_quiet_hours(quiet: &QuietHours, hour: u8, minute: u8) -> bool {
    let Some(from_m) = parse_hh_mm(&quiet.from) else {
        return false;
    };
    let Some(to_m) = parse_hh_mm(&quiet.to) else {
        return false;
    };
    let cur = u16::from(hour) * 60 + u16::from(minute);
    match from_m.cmp(&to_m) {
        std::cmp::Ordering::Equal => false,
        std::cmp::Ordering::Less => cur >= from_m && cur < to_m,
        std::cmp::Ordering::Greater => cur >= from_m || cur < to_m,
    }
}

/// Reason a lead was not queued for notification (`07-notifications-export.md §3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifySkipReason {
    RadarNotActive,
    NoChannelsConfigured,
    BelowMinScore,
    DuplicateClusterMember,
    StaleEvaluation,
    PreviewOrBackfill,
}

/// Routing decision for a newly matched lead (`07-notifications-export.md §3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyDecision {
    SendInstant { trigger_flood_auto_digest: bool },
    QueueDigest { trigger_flood_auto_digest: bool },
    Skip(NotifySkipReason),
}

/// Input parameters for evaluating `07-notifications-export.md §3` notification rules.
#[derive(Debug, Clone)]
pub struct NotifyPolicyCheck<'a> {
    pub radar_active: bool,
    pub has_channels: bool,
    pub digest_mode: bool,
    pub score: f64,
    pub min_score: f64,
    pub is_cluster_head: bool,
    pub repost_after_72h: bool,
    pub captured_at_ms: i64,
    pub decided_at_ms: i64,
    pub quiet_hours: Option<&'a QuietHours>,
    pub local_hour: u8,
    pub local_minute: u8,
    pub is_preview_or_backfill: bool,
    pub leads_in_last_hour: usize,
}

/// Evaluates all 6 notification rules + quiet hours + `> 30/hr` flood guard (`07-notifications-export.md §3`).
pub fn evaluate_notify_policy(check: &NotifyPolicyCheck<'_>) -> NotifyDecision {
    const SIX_HOURS_MS: i64 = 6 * 60 * 60 * 1000;

    if !check.radar_active {
        return NotifyDecision::Skip(NotifySkipReason::RadarNotActive);
    }
    if !check.has_channels {
        return NotifyDecision::Skip(NotifySkipReason::NoChannelsConfigured);
    }
    if check.is_preview_or_backfill {
        return NotifyDecision::Skip(NotifySkipReason::PreviewOrBackfill);
    }
    if check.score < check.min_score {
        return NotifyDecision::Skip(NotifySkipReason::BelowMinScore);
    }
    if !check.is_cluster_head && !check.repost_after_72h {
        return NotifyDecision::Skip(NotifySkipReason::DuplicateClusterMember);
    }
    if check.decided_at_ms.saturating_sub(check.captured_at_ms) > SIX_HOURS_MS {
        return NotifyDecision::Skip(NotifySkipReason::StaleEvaluation);
    }

    let flood = check.leads_in_last_hour > FLOOD_LEADS_PER_HOUR_THRESHOLD;
    let in_quiet = check
        .quiet_hours
        .is_some_and(|qh| is_in_quiet_hours(qh, check.local_hour, check.local_minute));

    if check.digest_mode || flood || in_quiet {
        NotifyDecision::QueueDigest {
            trigger_flood_auto_digest: flood && !check.digest_mode,
        }
    } else {
        NotifyDecision::SendInstant {
            trigger_flood_auto_digest: false,
        }
    }
}
