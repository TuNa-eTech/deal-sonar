//! Crawl Scheduler & Extractor Profile builder (`02-extension.md §6.1–6.2`, `01-protocol.md §4.3`).
//!
//! Computes adaptive per-source crawl intervals within the user's `hourly_page_load_budget`:
//! - Up to 3 user-pinned priority sources (`priority > 0`) run at `priority_interval_minutes` (default `5m`).
//! - High-velocity groups (`avg_new_posts > 10.0`) speed up (`max(5m, base / 2)`).
//! - Quiet groups (`avg_new_posts < 1.0` after at least one crawl) slow down up to `60m`.
//! - If total implied page loads per hour (`sum(3600 / interval_s)`) exceeds `hourly_page_load_budget`,
//!   all intervals are scaled upward proportionally so the hourly budget is never violated.

use dealsonar_protocol::{
    ActiveHours, CrawlPlan, CrawlPlanEntry, CrawlPolicy, ExtractionStrategy, ExtractorProfile,
    SourceRef,
};
use dealsonar_store::models::SourceRecord;
use serde_json::json;

use crate::dto::CrawlPolicySettings;

/// Maximum number of sources allowed to use the fast priority interval (`02-extension.md §6.2`).
pub const MAX_PRIORITY_SOURCES: usize = 3;

/// Minimum allowed scheduled crawl interval in seconds (`5 minutes`).
pub const MIN_SCHEDULED_INTERVAL_S: u32 = 300;

/// Maximum stretched crawl interval for quiet groups before budget scaling (`60 minutes`).
pub const QUIET_GROUP_MAX_INTERVAL_S: u32 = 3600;

/// Compute a [`CrawlPlan`] for sources belonging to active radars (`02-extension.md §6.2`).
///
/// If `profile_filter` is `Some(pid)`, includes sources bound to `pid` or unbound (`profile_id == None`).
pub fn compute_crawl_plan(
    sources_for_active_radars: &[SourceRecord],
    settings: &CrawlPolicySettings,
    profile_filter: Option<&str>,
) -> CrawlPlan {
    let base_interval_s = settings.group_interval_minutes.max(5).saturating_mul(60);
    let priority_interval_s = settings.priority_interval_minutes.max(5).saturating_mul(60);
    let max_posts_per_visit = settings.max_posts_per_visit.clamp(5, 200);
    let hourly_budget = f64::from(settings.hourly_page_load_budget.max(1));

    let mut eligible: Vec<&SourceRecord> = sources_for_active_radars
        .iter()
        .filter(|s| {
            s.followed
                && s.state != "inaccessible"
                && match (profile_filter, s.profile_id.as_deref()) {
                    (Some(want), Some(actual)) => want == actual,
                    _ => true,
                }
        })
        .collect();

    if eligible.is_empty() {
        return CrawlPlan {
            entries: Vec::new(),
        };
    }

    // Sort priority sources first, then higher velocity, then deterministic ID.
    eligible.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| {
                b.avg_new_posts
                    .partial_cmp(&a.avg_new_posts)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut priority_slots_used = 0usize;
    let mut raw_entries: Vec<(SourceRef, u32, u32)> = Vec::with_capacity(eligible.len());

    for src in eligible {
        let is_priority = src.priority > 0 && priority_slots_used < MAX_PRIORITY_SOURCES;
        let (interval_s, prio_rank) = if is_priority {
            priority_slots_used += 1;
            (priority_interval_s.max(MIN_SCHEDULED_INTERVAL_S), 1u32)
        } else if src.avg_new_posts > 10.0 {
            let faster = (base_interval_s / 2).max(MIN_SCHEDULED_INTERVAL_S);
            (faster, 0u32)
        } else if src.last_crawl_at.is_some() && src.avg_new_posts < 1.0 {
            let slower = if src.avg_new_posts < 0.25 {
                QUIET_GROUP_MAX_INTERVAL_S
            } else {
                base_interval_s
                    .saturating_mul(2)
                    .clamp(base_interval_s, QUIET_GROUP_MAX_INTERVAL_S)
            };
            (slower.max(MIN_SCHEDULED_INTERVAL_S), 0u32)
        } else {
            (base_interval_s.max(MIN_SCHEDULED_INTERVAL_S), 0u32)
        };

        raw_entries.push((
            SourceRef {
                platform: src.platform.clone(),
                kind: src.kind.clone(),
                external_id: src.external_id.clone(),
            },
            interval_s,
            prio_rank,
        ));
    }

    let implied_loads_per_hour: f64 = raw_entries
        .iter()
        .map(|(_, interval_s, _)| 3600.0 / f64::from(*interval_s))
        .sum();

    let scale = if implied_loads_per_hour > hourly_budget {
        implied_loads_per_hour / hourly_budget
    } else {
        1.0
    };

    let entries = raw_entries
        .into_iter()
        .map(|(source_ref, interval_s, priority)| {
            let scaled = if scale > 1.0 {
                (f64::from(interval_s) * scale).ceil() as u32
            } else {
                interval_s
            };
            CrawlPlanEntry {
                source_ref,
                interval_s: scaled.max(MIN_SCHEDULED_INTERVAL_S),
                priority,
                max_posts_per_visit,
            }
        })
        .collect();

    CrawlPlan { entries }
}

/// Convert UI/Core [`CrawlPolicySettings`] into wire [`CrawlPolicy`] (`01-protocol.md §4.3`).
pub fn build_crawl_policy(settings: &CrawlPolicySettings) -> CrawlPolicy {
    CrawlPolicy {
        max_loads_per_hour: settings.hourly_page_load_budget.max(1),
        max_loads_per_day: settings.daily_page_load_budget.max(1),
        active_hours: ActiveHours {
            from: settings.active_hours.from.clone(),
            to: settings.active_hours.to.clone(),
        },
        jitter: 0.3,
        max_scroll_steps: settings.max_scroll_steps.clamp(1, 10),
        only_when_idle: settings.only_when_idle,
    }
}

/// Build the declarative data-only [`ExtractorProfile`] pushed inside `config.update` (`02-extension.md §4`).
pub fn default_extractor_profile(rev: u64) -> ExtractorProfile {
    ExtractorProfile {
        rev: rev.max(1),
        strategies: vec![
            ExtractionStrategy::Network,
            ExtractionStrategy::Embedded,
            ExtractionStrategy::Dom,
        ],
        network: json!({
            "graphql_path": "/api/graphql/",
            "feed_friendly_names": [
                "GroupsCometFeedRegularStoriesPaginationQuery",
                "CometGroupDiscussionRootSuccessQuery"
            ]
        }),
        dom: json!({
            "feed_role": "feed",
            "article_selector": "[role=\"feed\"] [role=\"article\"]",
            "permalink_patterns": ["/groups/", "/posts/", "permalink/"]
        }),
        session_markers: json!({
            "checkpoint_paths": ["/checkpoint/", "/two_step_verification/"],
            "login_paths": ["/login", "/recover/"]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::QuietHours;

    fn sample_source(id: &str, priority: i32, avg_new: f64, crawled: bool) -> SourceRecord {
        SourceRecord {
            id: id.to_string(),
            platform: "facebook".to_string(),
            kind: "group".to_string(),
            external_id: format!("ext_{id}"),
            name: format!("Group {id}"),
            url: format!("https://www.facebook.com/groups/ext_{id}"),
            privacy: Some("public".to_string()),
            member_count: Some(10_000),
            profile_id: None,
            followed: true,
            priority,
            state: "ok".to_string(),
            last_crawl_at: crawled.then_some(1_794_384_000_000),
            avg_new_posts: avg_new,
            created_at: 1_794_380_000_000,
        }
    }

    #[test]
    fn respects_priority_cap_velocity_and_hourly_budget() {
        let settings = CrawlPolicySettings {
            group_interval_minutes: 15,
            priority_interval_minutes: 5,
            hourly_page_load_budget: 30,
            daily_page_load_budget: 300,
            active_hours: QuietHours {
                from: "07:00".to_string(),
                to: "23:00".to_string(),
            },
            max_scroll_steps: 3,
            max_posts_per_visit: 25,
            only_when_idle: false,
        };

        // 4 priority sources (only 3 get 5m), 1 high-velocity (>10), 1 quiet (<0.2)
        let sources = vec![
            sample_source("p1", 1, 5.0, true),
            sample_source("p2", 1, 5.0, true),
            sample_source("p3", 1, 5.0, true),
            sample_source("p4", 1, 5.0, true),
            sample_source("fast", 0, 15.0, true),
            sample_source("quiet", 0, 0.1, true),
        ];

        let plan = compute_crawl_plan(&sources, &settings, None);
        assert_eq!(plan.entries.len(), 6);

        let prio_5m_count = plan.entries.iter().filter(|e| e.priority == 1).count();
        assert_eq!(prio_5m_count, 3);

        let quiet_entry = plan
            .entries
            .iter()
            .find(|e| e.source_ref.external_id == "ext_quiet")
            .unwrap();
        assert!(quiet_entry.interval_s >= 3600);

        // Now enforce tight budget (10 loads/hr across 6 sources -> intervals scale up)
        let mut tight = settings.clone();
        tight.hourly_page_load_budget = 10;
        let scaled = compute_crawl_plan(&sources, &tight, None);
        let total_loads_hr: f64 = scaled
            .entries
            .iter()
            .map(|e| 3600.0 / f64::from(e.interval_s))
            .sum();
        assert!(total_loads_hr <= 10.0001);
    }
}
