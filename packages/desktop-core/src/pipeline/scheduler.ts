// Port of crates/core/src/scheduler.rs: adaptive crawl plan, wire policy and extractor profile
// (`02-extension.md §6.1–6.2`, `01-protocol.md §4.3`).

import type { SourceRecord } from "../store/sources";
import type { CrawlPolicySettings } from "./types";

export const MAX_PRIORITY_SOURCES = 3;
export const MIN_SCHEDULED_INTERVAL_S = 300;
export const QUIET_GROUP_MAX_INTERVAL_S = 3600;

export interface CrawlPlanEntry {
  source_ref: { platform: string; kind: string; external_id: string };
  interval_s: number;
  priority: number;
  max_posts_per_visit: number;
}
export interface CrawlPlan {
  entries: CrawlPlanEntry[];
}
export interface CrawlPolicyWire {
  max_loads_per_hour: number;
  max_loads_per_day: number;
  active_hours: { from: string; to: string };
  jitter: number;
  max_scroll_steps: number;
  only_when_idle: boolean;
}
export interface ExtractorProfileWire {
  rev: number;
  strategies: string[];
  network: Record<string, unknown>;
  dom: Record<string, unknown>;
  session_markers: Record<string, unknown>;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Plan for sources of active radars; `profileFilter` keeps sources bound to that profile or unbound. */
export function computeCrawlPlan(
  sources: readonly SourceRecord[],
  settings: CrawlPolicySettings,
  profileFilter: string | null = null,
): CrawlPlan {
  const baseIntervalS = Math.max(settings.group_interval_minutes, 5) * 60;
  const priorityIntervalS = Math.max(settings.priority_interval_minutes, 5) * 60;
  const maxPostsPerVisit = clamp(settings.max_posts_per_visit, 5, 200);
  const hourlyBudget = Math.max(settings.hourly_page_load_budget, 1);

  const eligible = sources.filter(
    (s) =>
      s.followed &&
      s.state !== "inaccessible" &&
      (profileFilter === null || s.profile_id === null || s.profile_id === profileFilter),
  );
  if (eligible.length === 0) return { entries: [] };

  eligible.sort(
    (a, b) =>
      b.priority - a.priority ||
      (b.avg_new_posts > a.avg_new_posts ? 1 : b.avg_new_posts < a.avg_new_posts ? -1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  let prioritySlotsUsed = 0;
  const raw: Array<[SourceRecord, number, number]> = [];
  for (const src of eligible) {
    const isPriority = src.priority > 0 && prioritySlotsUsed < MAX_PRIORITY_SOURCES;
    let intervalS: number;
    let prioRank = 0;
    if (isPriority) {
      prioritySlotsUsed += 1;
      intervalS = Math.max(priorityIntervalS, MIN_SCHEDULED_INTERVAL_S);
      prioRank = 1;
    } else if (src.avg_new_posts > 10.0) {
      intervalS = Math.max(Math.floor(baseIntervalS / 2), MIN_SCHEDULED_INTERVAL_S);
    } else if (src.last_crawl_at !== null && src.avg_new_posts < 1.0) {
      const slower =
        src.avg_new_posts < 0.25
          ? QUIET_GROUP_MAX_INTERVAL_S
          : clamp(baseIntervalS * 2, baseIntervalS, QUIET_GROUP_MAX_INTERVAL_S);
      intervalS = Math.max(slower, MIN_SCHEDULED_INTERVAL_S);
    } else {
      intervalS = Math.max(baseIntervalS, MIN_SCHEDULED_INTERVAL_S);
    }
    raw.push([src, intervalS, prioRank]);
  }

  const implied = raw.reduce((sum, [, i]) => sum + 3600 / i, 0);
  const scale = implied > hourlyBudget ? implied / hourlyBudget : 1;
  return {
    entries: raw.map(([src, intervalS, priority]) => {
      const scaled = scale > 1 ? Math.ceil(intervalS * scale) : intervalS;
      return {
        source_ref: { platform: src.platform, kind: src.kind, external_id: src.external_id },
        interval_s: Math.max(scaled, MIN_SCHEDULED_INTERVAL_S),
        priority,
        max_posts_per_visit: maxPostsPerVisit,
      };
    }),
  };
}

export function buildCrawlPolicy(s: CrawlPolicySettings): CrawlPolicyWire {
  return {
    max_loads_per_hour: Math.max(s.hourly_page_load_budget, 1),
    max_loads_per_day: Math.max(s.daily_page_load_budget, 1),
    active_hours: { from: s.active_hours.from, to: s.active_hours.to },
    jitter: 0.3,
    max_scroll_steps: clamp(s.max_scroll_steps, 1, 10),
    only_when_idle: s.only_when_idle,
  };
}

export function defaultExtractorProfile(rev: number): ExtractorProfileWire {
  return {
    rev: Math.max(rev, 1),
    strategies: ["network", "embedded", "dom"],
    network: {},
    dom: {},
    session_markers: {},
  };
}
