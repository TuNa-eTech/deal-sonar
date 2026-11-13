// Mock handlers: health and diagnostics.

import type { AiUsageStats } from "../../../types/ipc";
import type { MockCommandTable } from "./types";
import { state } from "../store";

export const healthCommands: MockCommandTable = {
  health_get: async () => {
    return structuredClone(state.health);
  },

  crawl_run_list: async () => {
    return structuredClone(state.crawlRuns);
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
