//! Soak-run measurements: volume, AI load, notification latency and recovery after outages,
//! computed from a DealSonar database (`docs/delivery/02-validation-plan.md §4.2`, `§8`).
//!
//! The report reads only counts, IDs and timestamps. It never includes post text, author
//! names, phone numbers or message bodies, so it can be shared.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::StoreError;

mod interruptions;
mod render;

pub use render::render_markdown;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

/// Share of unique captured posts that may need AI once rulesets are active (G4).
pub const AI_SHARE_TARGET: f64 = 0.15;
/// Median post-to-notification time must stay below this.
pub const MEDIAN_LATENCY_TARGET_MS: i64 = 10 * MINUTE_MS;

/// A period when something was deliberately or accidentally broken: machine sleep, Chrome
/// session loss, AI quota exhausted, notification channel failing. Recorded by whoever runs
/// the soak so the report can reconcile what happened around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Interruption {
    /// `machine_sleep`, `chrome_session`, `ai_quota`, `channel_error` or free text.
    pub kind: String,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoakOptions {
    /// Name of the configuration being measured, for example "10 group sôi động".
    pub label: Option<String>,
    /// Window start; defaults to the first captured post.
    pub from_ms: Option<i64>,
    /// Window end; defaults to `now_ms`, so work done after the last capture is counted.
    pub until_ms: Option<i64>,
    /// "Now" for state that is still open (pending AI, unsent messages).
    pub now_ms: i64,
    /// Notifications slower than this are listed individually.
    pub slow_after_ms: i64,
    /// Overrides when rulesets count as active; by default each radar's first activation.
    pub rules_active_from_ms: Option<i64>,
    /// Posts captured less than this long before `now_ms` are not reported as missed yet.
    pub missed_grace_ms: i64,
    /// How many individual slow or missed items to list.
    pub sample_size: usize,
    pub interruptions: Vec<Interruption>,
}

impl SoakOptions {
    pub fn new(now_ms: i64) -> Self {
        Self {
            label: None,
            from_ms: None,
            until_ms: None,
            now_ms,
            slow_after_ms: MEDIAN_LATENCY_TARGET_MS,
            rules_active_from_ms: None,
            missed_grace_ms: 5 * MINUTE_MS,
            sample_size: 10,
            interruptions: Vec::new(),
        }
    }
}

/// Summary of a list of durations (milliseconds).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Distribution {
    pub count: usize,
    pub min: Option<i64>,
    pub p50: Option<i64>,
    pub p90: Option<i64>,
    pub p95: Option<i64>,
    pub max: Option<i64>,
}

impl Distribution {
    pub fn from_values(mut values: Vec<i64>) -> Self {
        values.sort_unstable();
        let n = values.len();
        if n == 0 {
            return Self::default();
        }
        let rank = |p: f64| values[(((p * n as f64).ceil() as usize).max(1) - 1).min(n - 1)];
        let median = if n % 2 == 1 {
            values[n / 2]
        } else {
            (values[n / 2 - 1] + values[n / 2]) / 2
        };
        Self {
            count: n,
            min: values.first().copied(),
            p50: Some(median),
            p90: Some(rank(0.90)),
            p95: Some(rank(0.95)),
            max: values.last().copied(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SoakReport {
    pub label: Option<String>,
    pub generated_at_ms: i64,
    pub schema_version: i64,
    pub window: Window,
    pub collection: Collection,
    pub evaluation: EvaluationLoad,
    pub rules: RulesImpact,
    pub ai: AiLoad,
    pub notifications: Notifications,
    pub latency: Latency,
    pub interruptions: Vec<interruptions::InterruptionReport>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    pub from_ms: i64,
    pub until_ms: i64,
    pub days: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceVolume {
    pub source_id: String,
    pub name: String,
    pub posts: i64,
    pub unique_posts: i64,
    pub posts_per_day: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceGap {
    pub source_id: String,
    pub name: String,
    pub longest_gap_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CrawlSummary {
    pub runs: i64,
    pub by_status: BTreeMap<String, i64>,
    pub page_loads: i64,
    /// Longest stretch without a successful crawl, per source (largest first).
    pub longest_gaps: Vec<SourceGap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Collection {
    pub sources_followed: i64,
    pub posts_captured: i64,
    /// Posts that are not a cross-group repost of another captured post.
    pub unique_posts: i64,
    pub duplicate_posts: i64,
    pub posts_per_day: f64,
    pub per_source: Vec<SourceVolume>,
    pub crawl: CrawlSummary,
    /// Time between a post being published and the extension capturing it.
    pub capture_lag: Distribution,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayLoad {
    /// Day number counted from the start of the window, starting at 1.
    pub day: i64,
    pub posts_captured: i64,
    pub pairs_evaluated: i64,
    pub pairs_needing_ai: i64,
    pub ai_calls: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarLoad {
    pub radar_id: String,
    pub radar_name: String,
    pub pairs_evaluated: i64,
    pub pairs_needing_ai: i64,
    pub unique_posts_needing_ai: i64,
    pub rules_active_from_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MissedPair {
    pub post_id: String,
    pub radar_id: String,
    pub captured_at_ms: i64,
}

/// Post x radar pairs: what had to be scored and by which stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluationLoad {
    pub pairs_evaluated: i64,
    pub by_decided_by: BTreeMap<String, i64>,
    pub by_state: BTreeMap<String, i64>,
    pub pairs_needing_ai: i64,
    pub unique_posts_evaluated: i64,
    pub unique_posts_needing_ai: i64,
    /// Unique posts needing AI over unique posts captured, whole window.
    pub ai_share_of_unique_posts: Option<f64>,
    pub pending_ai_now: i64,
    pub ai_failed_now: i64,
    pub per_radar: Vec<RadarLoad>,
    pub per_day: Vec<DayLoad>,
    /// Pairs of a captured unique post and an active, subscribed radar that has no evaluation.
    pub possibly_missed_pairs: i64,
    pub possibly_missed_sample: Vec<MissedPair>,
}

/// AI need once rulesets run, against the G4 target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RulesImpact {
    pub radars_with_rules: i64,
    pub radars_without_rules: i64,
    pub rules_active_from_ms: Option<i64>,
    pub unique_posts_captured: i64,
    pub unique_posts_needing_ai: i64,
    pub ai_share_of_unique_posts: Option<f64>,
    pub target: f64,
    pub meets_target: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarAi {
    pub radar_id: String,
    pub radar_name: String,
    pub calls: i64,
    pub items: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub share_of_items: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiLoad {
    pub calls: i64,
    pub by_status: BTreeMap<String, i64>,
    pub by_task: BTreeMap<String, i64>,
    pub by_provider: BTreeMap<String, i64>,
    pub items: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Calls that hit the provider's quota (`rate_limited`).
    pub quota_hits: i64,
    pub duration: Distribution,
    pub per_radar: Vec<RadarAi>,
    /// Calls with a radar version that no longer exists (for example a deleted radar).
    pub unattributed_calls: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RadarSent {
    pub radar_id: String,
    pub radar_name: String,
    pub leads: i64,
    pub notified: i64,
    pub messages_sent: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicateSends {
    /// Leads delivered more than once to the same channel.
    pub leads_sent_more_than_once: i64,
    pub extra_messages: i64,
    /// Posts delivered to the same channel for more than one radar.
    pub posts_sent_for_multiple_radars: i64,
    pub extra_messages_across_radars: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notifications {
    pub leads_created: i64,
    pub leads_notified: i64,
    pub leads_not_notified: i64,
    pub outbox_by_state: BTreeMap<String, i64>,
    pub outbox_by_kind: BTreeMap<String, i64>,
    pub messages_sent: i64,
    /// Messages that needed more than one attempt or are waiting after a failed attempt.
    pub messages_retried: i64,
    pub messages_failed_or_dropped: i64,
    pub messages_still_pending: i64,
    pub duplicates: DuplicateSends,
    pub per_radar: Vec<RadarSent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlowNotification {
    pub lead_id: String,
    pub radar_id: String,
    pub post_id: String,
    pub total_ms: i64,
    pub capture_ms: i64,
    pub processing_ms: i64,
}

/// Publication-to-delivery time of notified leads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Latency {
    pub notified_leads: i64,
    pub total: Distribution,
    pub capture: Distribution,
    pub processing: Distribution,
    pub target_median_ms: i64,
    pub median_within_target: Option<bool>,
    pub slow_after_ms: i64,
    pub slow_count: i64,
    pub slowest: Vec<SlowNotification>,
}

/// Build the report from an open database connection.
pub fn build_soak_report(conn: &Connection, opts: &SoakOptions) -> Result<SoakReport, StoreError> {
    let schema_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let first: Option<i64> =
        conn.query_row("SELECT MIN(captured_at) FROM posts", [], |r| r.get(0))?;
    let mut warnings = Vec::new();
    let from = opts.from_ms.or(first).unwrap_or(opts.now_ms);
    let until = opts.until_ms.unwrap_or(opts.now_ms).max(from);
    if first.is_none() {
        warnings.push("Cơ sở dữ liệu chưa có bài nào được thu.".to_string());
    }
    let days = ((until - from) as f64 / DAY_MS as f64).max(1.0 / 24.0);
    let window = Window {
        from_ms: from,
        until_ms: until,
        days,
    };

    let ctx = Ctx {
        conn,
        from,
        until,
        days,
        opts,
    };
    let radar_names = ctx.radar_names()?;
    let collection = ctx.collection()?;
    let evaluation_rows = ctx.evaluation_rows()?;
    let activations = ctx.rule_activations()?;
    let ai_calls = ctx.ai_calls(&radar_names)?;
    let (evaluation, rules) = ctx.evaluation_and_rules(
        &evaluation_rows,
        &activations,
        &radar_names,
        &collection,
        &ai_calls,
        &mut warnings,
    )?;
    let ai = ctx.ai_load(&ai_calls, &radar_names)?;
    let (notifications, latency) = ctx.notifications_and_latency(&radar_names)?;
    let interruptions = interruptions::reconcile(conn, opts)?;

    Ok(SoakReport {
        label: opts.label.clone(),
        generated_at_ms: opts.now_ms,
        schema_version,
        window,
        collection,
        evaluation,
        rules,
        ai,
        notifications,
        latency,
        interruptions,
        warnings,
    })
}

struct Ctx<'a> {
    conn: &'a Connection,
    from: i64,
    until: i64,
    days: f64,
    opts: &'a SoakOptions,
}

struct EvalRow {
    post_id: String,
    radar_id: String,
    state: String,
    decided_by: Option<String>,
    created_at: i64,
    needs_ai: bool,
}

struct AiRow {
    provider: String,
    task: String,
    status: String,
    radar_id: Option<String>,
    items: i64,
    input_tokens: i64,
    output_tokens: i64,
    duration_ms: i64,
    created_at: i64,
}

fn ratio(n: i64, d: i64) -> Option<f64> {
    (d > 0).then(|| n as f64 / d as f64)
}

impl Ctx<'_> {
    fn day_of(&self, ts: i64) -> i64 {
        ((ts - self.from).max(0) / DAY_MS) + 1
    }

    fn radar_names(&self) -> Result<HashMap<String, String>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT id, name FROM radars")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn collection(&self) -> Result<Collection, StoreError> {
        let sources_followed: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM sources WHERE followed = 1", [], |r| {
                    r.get(0)
                })?;
        let unique = "(p.dup_cluster_id IS NULL OR p.is_cluster_head = 1)";

        let mut per_source = Vec::new();
        {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT s.id, s.name, COUNT(p.id),
                        COALESCE(SUM(CASE WHEN {unique} THEN 1 ELSE 0 END), 0)
                 FROM sources s
                 LEFT JOIN posts p ON p.source_id = s.id AND p.captured_at BETWEEN ?1 AND ?2
                 WHERE s.followed = 1 OR p.id IS NOT NULL
                 GROUP BY s.id ORDER BY s.name"
            ))?;
            let rows = stmt.query_map(params![self.from, self.until], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (source_id, name, posts, unique_posts) = row?;
                per_source.push(SourceVolume {
                    source_id,
                    name,
                    posts,
                    unique_posts,
                    posts_per_day: posts as f64 / self.days,
                });
            }
        }
        let posts_captured: i64 = per_source.iter().map(|s| s.posts).sum();
        let unique_posts: i64 = per_source.iter().map(|s| s.unique_posts).sum();

        let lags: Vec<i64> = {
            let mut stmt = self.conn.prepare(
                "SELECT MAX(captured_at - created_at, 0) FROM posts
                 WHERE created_at IS NOT NULL AND captured_at BETWEEN ?1 AND ?2",
            )?;
            let rows = stmt.query_map(params![self.from, self.until], |r| r.get::<_, i64>(0))?;
            rows.collect::<Result<_, _>>()?
        };

        Ok(Collection {
            sources_followed,
            posts_captured,
            unique_posts,
            duplicate_posts: posts_captured - unique_posts,
            posts_per_day: posts_captured as f64 / self.days,
            per_source,
            crawl: self.crawl_summary()?,
            capture_lag: Distribution::from_values(lags),
        })
    }

    fn crawl_summary(&self) -> Result<CrawlSummary, StoreError> {
        let mut summary = CrawlSummary::default();
        let mut stmt = self.conn.prepare(
            "SELECT c.source_id, s.name, c.status, c.started_at, c.page_loads
             FROM crawl_runs c JOIN sources s ON s.id = c.source_id
             WHERE c.reason IN ('scheduled', 'manual', 'passive') AND c.started_at BETWEEN ?1 AND ?2
             ORDER BY c.source_id, c.started_at",
        )?;
        let rows = stmt.query_map(params![self.from, self.until], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let mut last_ok: HashMap<String, i64> = HashMap::new();
        let mut gaps: BTreeMap<String, (String, i64)> = BTreeMap::new();
        for row in rows {
            let (source_id, name, status, started, loads) = row?;
            summary.runs += 1;
            summary.page_loads += loads;
            *summary.by_status.entry(status.clone()).or_default() += 1;
            if matches!(status.as_str(), "ok" | "empty") {
                let since = last_ok.get(&source_id).copied().unwrap_or(self.from);
                let entry = gaps.entry(source_id.clone()).or_insert((name, 0));
                entry.1 = entry.1.max(started - since);
                last_ok.insert(source_id, started);
            }
        }
        // The stretch after the last good crawl counts too.
        for (source_id, (_, gap)) in gaps.iter_mut() {
            let since = last_ok.get(source_id).copied().unwrap_or(self.from);
            *gap = (*gap).max(self.until - since);
        }
        let mut list: Vec<SourceGap> = gaps
            .into_iter()
            .map(|(source_id, (name, longest_gap_ms))| SourceGap {
                source_id,
                name,
                longest_gap_ms,
            })
            .collect();
        list.sort_by(|a, b| b.longest_gap_ms.cmp(&a.longest_gap_ms));
        list.truncate(self.opts.sample_size);
        summary.longest_gaps = list;
        Ok(summary)
    }

    fn evaluation_rows(&self) -> Result<Vec<EvalRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT e.post_id, rv.radar_id, e.state, e.decided_by, e.created_at,
                    (e.decided_by = 'ai' OR e.ai_call_id IS NOT NULL
                     OR e.state IN ('pending_ai', 'ai_failed'))
             FROM evaluations e JOIN radar_versions rv ON rv.id = e.radar_version_id
             WHERE e.is_preview = 0 AND e.created_at BETWEEN ?1 AND ?2",
        )?;
        let rows = stmt.query_map(params![self.from, self.until], |r| {
            Ok(EvalRow {
                post_id: r.get(0)?,
                radar_id: r.get(1)?,
                state: r.get(2)?,
                decided_by: r.get(3)?,
                created_at: r.get(4)?,
                needs_ai: r.get::<_, i64>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// First activation of any ruleset, per radar.
    fn rule_activations(&self) -> Result<HashMap<String, i64>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT rv.radar_id, MIN(rs.activated_at)
             FROM rulesets rs JOIN radar_versions rv ON rv.id = rs.radar_version_id
             WHERE rs.activated_at IS NOT NULL GROUP BY rv.radar_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn ai_calls(&self, _names: &HashMap<String, String>) -> Result<Vec<AiRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT a.provider, a.task, a.status, rv.radar_id, a.item_count,
                    COALESCE(a.input_tokens, 0), COALESCE(a.output_tokens, 0),
                    a.duration_ms, a.created_at
             FROM ai_calls a LEFT JOIN radar_versions rv ON rv.id = a.radar_version_id
             WHERE a.created_at BETWEEN ?1 AND ?2",
        )?;
        let rows = stmt.query_map(params![self.from, self.until], |r| {
            Ok(AiRow {
                provider: r.get(0)?,
                task: r.get(1)?,
                status: r.get(2)?,
                radar_id: r.get(3)?,
                items: r.get(4)?,
                input_tokens: r.get(5)?,
                output_tokens: r.get(6)?,
                duration_ms: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn evaluation_and_rules(
        &self,
        rows: &[EvalRow],
        activations: &HashMap<String, i64>,
        names: &HashMap<String, String>,
        collection: &Collection,
        ai_calls: &[AiRow],
        warnings: &mut Vec<String>,
    ) -> Result<(EvaluationLoad, RulesImpact), StoreError> {
        let mut by_decided_by: BTreeMap<String, i64> = BTreeMap::new();
        let mut by_state: BTreeMap<String, i64> = BTreeMap::new();
        let mut posts: BTreeSet<&str> = BTreeSet::new();
        let mut ai_posts: BTreeSet<&str> = BTreeSet::new();
        let mut per_radar: BTreeMap<&str, (i64, i64, BTreeSet<&str>)> = BTreeMap::new();
        let mut days: BTreeMap<i64, DayLoad> = BTreeMap::new();
        let mut bump = |day: i64, f: &dyn Fn(&mut DayLoad)| {
            let entry = days.entry(day).or_insert(DayLoad {
                day,
                posts_captured: 0,
                pairs_evaluated: 0,
                pairs_needing_ai: 0,
                ai_calls: 0,
            });
            f(entry);
        };

        let mut pairs_needing_ai = 0;
        for row in rows {
            *by_decided_by
                .entry(
                    row.decided_by
                        .clone()
                        .unwrap_or_else(|| "chưa quyết định".into()),
                )
                .or_default() += 1;
            *by_state.entry(row.state.clone()).or_default() += 1;
            posts.insert(&row.post_id);
            let entry = per_radar.entry(&row.radar_id).or_default();
            entry.0 += 1;
            bump(self.day_of(row.created_at), &|d| d.pairs_evaluated += 1);
            if row.needs_ai {
                pairs_needing_ai += 1;
                ai_posts.insert(&row.post_id);
                entry.1 += 1;
                entry.2.insert(&row.post_id);
                bump(self.day_of(row.created_at), &|d| d.pairs_needing_ai += 1);
            }
        }
        for call in ai_calls {
            bump(self.day_of(call.created_at), &|d| d.ai_calls += 1);
        }
        {
            let mut stmt = self.conn.prepare(
                "SELECT captured_at FROM posts
                 WHERE captured_at BETWEEN ?1 AND ?2 AND (dup_cluster_id IS NULL OR is_cluster_head = 1)",
            )?;
            let times = stmt.query_map(params![self.from, self.until], |r| r.get::<_, i64>(0))?;
            for t in times {
                bump(self.day_of(t?), &|d| d.posts_captured += 1);
            }
        }

        let (pending_ai_now, ai_failed_now): (i64, i64) = self.conn.query_row(
            "SELECT COALESCE(SUM(state = 'pending_ai'), 0), COALESCE(SUM(state = 'ai_failed'), 0)
             FROM evaluations WHERE is_preview = 0",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let mut radar_loads: Vec<RadarLoad> = per_radar
            .iter()
            .map(|(id, (pairs, ai, ai_unique))| RadarLoad {
                radar_id: (*id).to_string(),
                radar_name: names.get(*id).cloned().unwrap_or_else(|| (*id).to_string()),
                pairs_evaluated: *pairs,
                pairs_needing_ai: *ai,
                unique_posts_needing_ai: ai_unique.len() as i64,
                rules_active_from_ms: self
                    .opts
                    .rules_active_from_ms
                    .or(activations.get(*id).copied()),
            })
            .collect();
        radar_loads.sort_by(|a, b| b.pairs_needing_ai.cmp(&a.pairs_needing_ai));

        let (missed, missed_sample) = self.possibly_missed()?;

        // Once rulesets are active: unique posts that still needed AI over unique posts captured.
        let from_for = |radar_id: &str| {
            self.opts
                .rules_active_from_ms
                .or(activations.get(radar_id).copied())
        };
        let radars_with_rules = per_radar.keys().filter(|id| from_for(id).is_some()).count() as i64;
        let radars_without_rules = per_radar.len() as i64 - radars_with_rules;
        let rules_from = per_radar.keys().filter_map(|id| from_for(id)).min();
        let (captured_after, ai_after) = match rules_from {
            None => (0, 0),
            Some(start) => {
                let captured: i64 = self.conn.query_row(
                    "SELECT COUNT(*) FROM posts
                     WHERE captured_at BETWEEN ?1 AND ?2 AND (dup_cluster_id IS NULL OR is_cluster_head = 1)",
                    params![start.max(self.from), self.until],
                    |r| r.get(0),
                )?;
                let mut ai_set: BTreeSet<&str> = BTreeSet::new();
                for row in rows {
                    if row.needs_ai && from_for(&row.radar_id).is_some_and(|s| row.created_at >= s)
                    {
                        ai_set.insert(&row.post_id);
                    }
                }
                (captured, ai_set.len() as i64)
            }
        };
        let share_after = ratio(ai_after, captured_after);
        if rules_from.is_none() {
            warnings.push(
                "Chưa có bộ luật nào hoạt động trong khoảng đo nên chưa tính được tỷ lệ bài cần AI sau khi có luật."
                    .to_string(),
            );
        }
        if radars_without_rules > 0 && radars_with_rules > 0 {
            warnings.push(format!(
                "{radars_without_rules} radar chưa có bộ luật nên không tính vào tỷ lệ sau khi có luật."
            ));
        }

        let evaluation = EvaluationLoad {
            pairs_evaluated: rows.len() as i64,
            by_decided_by,
            by_state,
            pairs_needing_ai,
            unique_posts_evaluated: posts.len() as i64,
            unique_posts_needing_ai: ai_posts.len() as i64,
            ai_share_of_unique_posts: ratio(ai_posts.len() as i64, collection.unique_posts),
            pending_ai_now,
            ai_failed_now,
            per_radar: radar_loads,
            per_day: days.into_values().collect(),
            possibly_missed_pairs: missed,
            possibly_missed_sample: missed_sample,
        };
        let rules = RulesImpact {
            radars_with_rules,
            radars_without_rules,
            rules_active_from_ms: rules_from,
            unique_posts_captured: captured_after,
            unique_posts_needing_ai: ai_after,
            ai_share_of_unique_posts: share_after,
            target: AI_SHARE_TARGET,
            meets_target: share_after.map(|s| s <= AI_SHARE_TARGET),
        };
        Ok((evaluation, rules))
    }

    /// Unique captured posts that an active, subscribed radar never evaluated. The radar's
    /// activation history is not stored, so a radar switched on after the post was captured
    /// shows up here too; read it as "check these", not as proof of loss.
    fn possibly_missed(&self) -> Result<(i64, Vec<MissedPair>), StoreError> {
        let sql = "FROM posts p
             JOIN radar_sources rs ON rs.source_id = p.source_id
             JOIN radars r ON r.id = rs.radar_id
             WHERE r.status = 'active' AND r.created_at <= p.captured_at
               AND p.captured_at BETWEEN ?1 AND ?2
               AND (p.dup_cluster_id IS NULL OR p.is_cluster_head = 1)
               AND NOT EXISTS (
                 SELECT 1 FROM evaluations e JOIN radar_versions rv ON rv.id = e.radar_version_id
                 WHERE rv.radar_id = r.id AND e.post_id = p.id AND e.is_preview = 0)";
        let until = self.until.min(self.opts.now_ms - self.opts.missed_grace_ms);
        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) {sql}"),
            params![self.from, until],
            |r| r.get(0),
        )?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT p.id, r.id, p.captured_at {sql} ORDER BY p.captured_at LIMIT ?3"
        ))?;
        let sample = stmt
            .query_map(
                params![self.from, until, self.opts.sample_size as i64],
                |r| {
                    Ok(MissedPair {
                        post_id: r.get(0)?,
                        radar_id: r.get(1)?,
                        captured_at_ms: r.get(2)?,
                    })
                },
            )?
            .collect::<Result<_, _>>()?;
        Ok((total, sample))
    }

    fn ai_load(
        &self,
        calls: &[AiRow],
        names: &HashMap<String, String>,
    ) -> Result<AiLoad, StoreError> {
        let mut load = AiLoad {
            calls: calls.len() as i64,
            by_status: BTreeMap::new(),
            by_task: BTreeMap::new(),
            by_provider: BTreeMap::new(),
            items: 0,
            input_tokens: 0,
            output_tokens: 0,
            quota_hits: 0,
            duration: Distribution::default(),
            per_radar: Vec::new(),
            unattributed_calls: 0,
        };
        let mut per_radar: BTreeMap<&str, RadarAi> = BTreeMap::new();
        for call in calls {
            *load.by_status.entry(call.status.clone()).or_default() += 1;
            *load.by_task.entry(call.task.clone()).or_default() += 1;
            *load.by_provider.entry(call.provider.clone()).or_default() += 1;
            load.items += call.items;
            load.input_tokens += call.input_tokens;
            load.output_tokens += call.output_tokens;
            load.quota_hits += i64::from(call.status == "rate_limited");
            match &call.radar_id {
                Some(id) => {
                    let e = per_radar.entry(id).or_insert_with(|| RadarAi {
                        radar_id: id.clone(),
                        radar_name: names.get(id).cloned().unwrap_or_else(|| id.clone()),
                        calls: 0,
                        items: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        share_of_items: 0.0,
                    });
                    e.calls += 1;
                    e.items += call.items;
                    e.input_tokens += call.input_tokens;
                    e.output_tokens += call.output_tokens;
                }
                None => load.unattributed_calls += 1,
            }
        }
        load.duration = Distribution::from_values(calls.iter().map(|c| c.duration_ms).collect());
        let attributed: i64 = per_radar.values().map(|r| r.items).sum();
        let mut list: Vec<RadarAi> = per_radar.into_values().collect();
        for r in &mut list {
            r.share_of_items = if attributed > 0 {
                r.items as f64 / attributed as f64
            } else {
                0.0
            };
        }
        list.sort_by(|a, b| b.items.cmp(&a.items));
        load.per_radar = list;
        Ok(load)
    }

    fn notifications_and_latency(
        &self,
        names: &HashMap<String, String>,
    ) -> Result<(Notifications, Latency), StoreError> {
        let (leads_created, leads_notified): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(notified_at IS NOT NULL), 0) FROM leads
             WHERE created_at BETWEEN ?1 AND ?2",
            params![self.from, self.until],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let mut outbox_by_state = BTreeMap::new();
        let mut outbox_by_kind = BTreeMap::new();
        let (mut sent, mut retried, mut failed, mut pending) = (0, 0, 0, 0);
        {
            let mut stmt = self.conn.prepare(
                "SELECT state, kind, (attempts > 1 OR error IS NOT NULL) FROM outbox
                 WHERE created_at BETWEEN ?1 AND ?2",
            )?;
            let rows = stmt.query_map(params![self.from, self.until], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (state, kind, had_failure) = row?;
                match state.as_str() {
                    "sent" => sent += 1,
                    "failed" | "dropped" => failed += 1,
                    "pending" => pending += 1,
                    _ => {}
                }
                retried += had_failure;
                *outbox_by_state.entry(state).or_default() += 1;
                *outbox_by_kind.entry(kind).or_default() += 1;
            }
        }

        // Duplicates: the same lead twice to one channel, or one post for several radars.
        let (dup_leads, dup_extra): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(n - 1), 0) FROM (
               SELECT COUNT(*) AS n FROM outbox o JOIN leads l ON l.id = o.lead_id
               WHERE o.state = 'sent' AND l.created_at BETWEEN ?1 AND ?2
               GROUP BY o.lead_id, o.channel_id HAVING n > 1)",
            params![self.from, self.until],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let (dup_posts, dup_posts_extra): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(n - 1), 0) FROM (
               SELECT COUNT(DISTINCT l.radar_id) AS n FROM outbox o JOIN leads l ON l.id = o.lead_id
               WHERE o.state = 'sent' AND l.created_at BETWEEN ?1 AND ?2
               GROUP BY l.post_id, o.channel_id HAVING n > 1)",
            params![self.from, self.until],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let mut per_radar: BTreeMap<String, RadarSent> = BTreeMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT l.radar_id, COUNT(DISTINCT l.id),
                        COUNT(DISTINCT CASE WHEN l.notified_at IS NOT NULL THEN l.id END),
                        COUNT(o.id)
                 FROM leads l LEFT JOIN outbox o ON o.lead_id = l.id AND o.state = 'sent'
                 WHERE l.created_at BETWEEN ?1 AND ?2 GROUP BY l.radar_id",
            )?;
            let rows = stmt.query_map(params![self.from, self.until], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (radar_id, leads, notified, messages_sent) = row?;
                per_radar.insert(
                    radar_id.clone(),
                    RadarSent {
                        radar_name: names
                            .get(&radar_id)
                            .cloned()
                            .unwrap_or_else(|| radar_id.clone()),
                        radar_id,
                        leads,
                        notified,
                        messages_sent,
                    },
                );
            }
        }

        let notifications = Notifications {
            leads_created,
            leads_notified,
            leads_not_notified: leads_created - leads_notified,
            outbox_by_state,
            outbox_by_kind,
            messages_sent: sent,
            messages_retried: retried,
            messages_failed_or_dropped: failed,
            messages_still_pending: pending,
            duplicates: DuplicateSends {
                leads_sent_more_than_once: dup_leads,
                extra_messages: dup_extra,
                posts_sent_for_multiple_radars: dup_posts,
                extra_messages_across_radars: dup_posts_extra,
            },
            per_radar: per_radar.into_values().collect(),
        };

        Ok((notifications, self.latency()?))
    }

    fn latency(&self) -> Result<Latency, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT l.id, l.radar_id, l.post_id,
                    COALESCE(MIN(o.sent_at), l.notified_at),
                    COALESCE(p.created_at, p.captured_at), p.captured_at
             FROM leads l JOIN posts p ON p.id = l.post_id
             LEFT JOIN outbox o ON o.lead_id = l.id AND o.state = 'sent'
             WHERE l.created_at BETWEEN ?1 AND ?2
             GROUP BY l.id HAVING COALESCE(MIN(o.sent_at), l.notified_at) IS NOT NULL",
        )?;
        let mut all = Vec::new();
        let rows = stmt.query_map(params![self.from, self.until], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (lead_id, radar_id, post_id, sent, posted, captured) = row?;
            all.push(SlowNotification {
                lead_id,
                radar_id,
                post_id,
                total_ms: (sent - posted).max(0),
                capture_ms: (captured - posted).max(0),
                processing_ms: (sent - captured).max(0),
            });
        }
        let total = Distribution::from_values(all.iter().map(|n| n.total_ms).collect());
        let slow_after = self.opts.slow_after_ms;
        let mut slow: Vec<SlowNotification> = all
            .iter()
            .filter(|n| n.total_ms > slow_after)
            .cloned()
            .collect();
        let slow_count = slow.len() as i64;
        slow.sort_by(|a, b| b.total_ms.cmp(&a.total_ms));
        slow.truncate(self.opts.sample_size);
        Ok(Latency {
            notified_leads: all.len() as i64,
            median_within_target: total.p50.map(|m| m < MEDIAN_LATENCY_TARGET_MS),
            total,
            capture: Distribution::from_values(all.iter().map(|n| n.capture_ms).collect()),
            processing: Distribution::from_values(all.iter().map(|n| n.processing_ms).collect()),
            target_median_ms: MEDIAN_LATENCY_TARGET_MS,
            slow_after_ms: slow_after,
            slow_count,
            slowest: slow,
        })
    }
}

impl crate::Store {
    /// Build a soak report from this store's database.
    pub fn soak_report(&self, opts: &SoakOptions) -> Result<SoakReport, StoreError> {
        let conn = self.lock_conn()?;
        build_soak_report(&conn, opts)
    }
}
