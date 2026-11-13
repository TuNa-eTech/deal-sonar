// Mock handlers: rulesets.

import type { RulesetBody, Ruleset } from "../../../types/ipc";
import { getRadarDetail } from "./radars";
import type { MockCommandTable } from "./types";
import { nextId } from "../ids";
import { state } from "../store";

export const rulesetCommands: MockCommandTable = {
  ruleset_list: async (args) => {
    const radarId = String(args.radar_id ?? "");
    const versionIds = new Set(
      state.radarVersions.filter((v) => v.radar_id === radarId).map((v) => v.id)
    );
    return structuredClone(
      state.rulesets
        .filter((rs) => versionIds.has(rs.radar_version_id))
        .sort((a, b) => b.revision - a.revision)
    );
  },

  ruleset_save_user: async (args) => {
    const radarVersionId = String(args.radar_version_id ?? "");
    const body = args.body as RulesetBody;
    const existing = state.rulesets.filter((r) => r.radar_version_id === radarVersionId);
    const nextRev = existing.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
    for (const r of existing) {
      if (r.state === "active") r.state = "retired";
    }
    const now = Date.now();
    const created: Ruleset = {
      id: nextId("01JCF5"),
      radar_version_id: radarVersionId,
      revision: nextRev,
      state: "active",
      origin: "user",
      body: structuredClone(body),
      metrics: {
        rule_handled_pct: 84,
        ai_handled_pct: 16,
        accept_precision: 0.96,
        false_negative_rate: 0.014,
        sample_size: 200,
      },
      created_at: now,
      activated_at: now,
    };
    state.rulesets.unshift(created);
    return structuredClone(created);
  },

  ruleset_compile_now: async (args) => {
    const radarId = String(args.radar_id ?? "");
    const detail = getRadarDetail(radarId);
    const rvId = detail.current_version_data.id;
    const existing = state.rulesets.filter((r) => r.radar_version_id === rvId);
    const nextRev = existing.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
    const baseBody = existing[0]?.body ?? {
      dsl: 1 as const,
      prefilter: { any: ["can thue", "can mua"], none: ["tuyen sale"], min_len: 20 },
      classify: [],
      extract: [{ field: "phone", extractor: "vn_phone" }],
      thresholds: { accept: 0.9, reject: 0.9 },
    };
    const compiled: Ruleset = {
      id: nextId("01JCF5"),
      radar_version_id: rvId,
      revision: nextRev,
      state: "shadow",
      origin: "compiled",
      body: structuredClone(baseBody),
      metrics: {
        rule_handled_pct: 79,
        ai_handled_pct: 21,
        accept_precision: 0.97,
        false_negative_rate: 0.01,
        sample_size: 160,
      },
      created_at: Date.now(),
      activated_at: null,
    };
    state.rulesets.unshift(compiled);
    return { job_id: nextId("01JCFJ"), ruleset: structuredClone(compiled) };
  },
};
