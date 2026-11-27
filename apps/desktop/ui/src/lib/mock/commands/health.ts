// Mock handlers: health and diagnostics.

import type { AccountSafetyReport, AiUsageStats, FirstNewsStatus } from "../../../types/ipc";
import type { MockCommandTable } from "./types";
import { state } from "../store";

export const healthCommands: MockCommandTable = {
  health_get: async () => {
    return structuredClone(state.health);
  },

  crawl_run_list: async () => {
    return structuredClone(state.crawlRuns);
  },

  account_safety_report: async (args) => {
    const now = Date.now();
    return {
      generated_at: now,
      app_version: "mock",
      window_days: Number(args.days ?? 30),
      crawl_policy: {
        group_interval_minutes: 15, priority_interval_minutes: 5, hourly_page_load_budget: 60,
        daily_page_load_budget: 600, active_hours: { from: "07:00", to: "23:00" },
        max_scroll_steps: 3, max_posts_per_visit: 25, only_when_idle: false,
      },
      followed_groups: state.sources.filter((source) => source.followed).length,
      active_days: [],
      incidents: [],
    } satisfies AccountSafetyReport;
  },

  first_news_status: async () => {
    const now = Date.now();
    const active = state.radars.filter((radar) => radar.status === "active");
    const activeSourceIds = new Set(active.flatMap((radar) => radar.source_ids));
    const posts = state.posts.filter((post) => activeSourceIds.has(post.source_id));
    const min = (values: number[]) => (values.length ? Math.min(...values) : null);
    const max = (values: number[]) => (values.length ? Math.max(...values) : null);
    const leadTimes = state.leads.map((lead) => lead.created_at);
    const createdTimes = state.radars.map((radar) => radar.created_at);
    return {
      installed_at: Math.min(now, ...createdTimes) - 3_600_000,
      installed_at_estimated: false,
      first_radar_activated_at: min(active.map((radar) => radar.updated_at)),
      first_followed_source_at: state.sources.some((source) => source.followed) ? min(createdTimes) : null,
      first_radar_created_at: min(createdTimes),
      first_post_captured_at: min(state.posts.map((post) => post.captured_at)),
      first_lead_at: min(leadTimes),
      first_delivery_at: min(state.leads.filter((lead) => lead.notified_at).map((lead) => lead.notified_at!)),
      active_radars: active.length,
      active_sources: activeSourceIds.size,
      posts_captured: posts.length,
      last_post_captured_at: max(posts.map((post) => post.captured_at)),
      evaluated_match: state.leads.length,
      evaluated_no_match: 0,
      waiting_ai: state.health.pending_ai_posts,
      last_evaluated_at: max(leadTimes),
      leads_total: state.leads.length,
      last_lead_at: max(leadTimes),
      delivery_pending: state.health.outbox_pending,
      delivery_failed: state.health.outbox_failed,
      last_delivery_at: max(state.leads.filter((lead) => lead.notified_at).map((lead) => lead.notified_at!)),
      last_delivery_error: null,
      checked_at: now,
    } satisfies FirstNewsStatus;
  },

  ai_usage_get: async () => {
    const stats: AiUsageStats = {
      today_items: 142,
      daily_cap: state.settings.daily_ai_post_cap,
      total_calls: 58,
      total_items: 940,
      total_input_tokens: 412_800,
      total_output_tokens: 98_400,
      total_cost_usd: 0.84,
      avg_ai_escalation_pct: 18,
      daily: [
        {
          date: "2026-11-12",
          calls: 9,
          items: 142,
          input_tokens: 61_200,
          output_tokens: 14_800,
          cost_usd: 0.13,
          ai_escalation_pct: 17.5,
        },
        {
          date: "2026-11-11",
          calls: 14,
          items: 228,
          input_tokens: 98_400,
          output_tokens: 23_100,
          cost_usd: 0.21,
          ai_escalation_pct: 18.2,
        },
        {
          date: "2026-11-10",
          calls: 12,
          items: 196,
          input_tokens: 86_500,
          output_tokens: 20_400,
          cost_usd: 0.18,
          ai_escalation_pct: 19.0,
        },
        {
          date: "2026-11-09",
          calls: 11,
          items: 184,
          input_tokens: 81_200,
          output_tokens: 19_600,
          cost_usd: 0.16,
          ai_escalation_pct: 17.8,
        },
        {
          date: "2026-11-08",
          calls: 12,
          items: 190,
          input_tokens: 85_500,
          output_tokens: 20_500,
          cost_usd: 0.16,
          ai_escalation_pct: 18.4,
        },
      ],
    };
    return stats;
  },

  diagnostic_bundle_create: async () => {
    return {
      path: `~/Downloads/dealsonar-diagnostics-${Date.now()}.zip`,
      size_bytes: 184_320,
      created_at: Date.now(),
    };
  },
};
