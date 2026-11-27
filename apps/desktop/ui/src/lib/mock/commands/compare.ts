// Mock handlers: compare two radar definitions on one shared set of posts.

import type {
  CompareChange,
  CompareCounts,
  CompareDefinition,
  CompareItem,
  CompareVerdict,
  DefinitionDiff,
  PreviewItem,
  RadarComparison,
  RadarComparisonSummary,
  RadarCompareInput,
  RadarCompareSide,
  RadarVersion,
} from "../../../types/ipc";
import { nextId } from "../ids";
import { generatePreviewItemsForRadar } from "../preview";
import { state } from "../store";
import type { MockCommandTable } from "./types";

function resolveSide(side: RadarCompareSide): { name: string; version: RadarVersion } {
  const radar = state.radars.find((r) => r.id === side.radar_id);
  if (!radar) throw new Error(`Không tìm thấy radar: ${side.radar_id}`);
  const wanted = side.version ?? radar.current_version;
  const version = state.radarVersions.find(
    (v) => v.radar_id === radar.id && v.version === wanted
  );
  if (!version) throw new Error(`Không tìm thấy phiên bản ${wanted} của radar ${radar.name}`);
  return { name: radar.name, version };
}

function definitionOf(side: { name: string; version: RadarVersion }): CompareDefinition {
  const v = side.version;
  return {
    radar_id: v.radar_id,
    radar_name: side.name,
    version_id: v.id,
    version: v.version,
    description: v.description,
    user_profession: v.user_profession,
    fields: v.fields,
    match_policy: v.match_policy,
  };
}

function verdictOf(item: PreviewItem): CompareVerdict {
  return {
    state: "done",
    verdict: item.verdict,
    score: item.score,
    decided_by: item.decided_by,
    reject_reason: item.verdict === "no_match" ? "irrelevant" : null,
    reason: item.reason,
    summary: item.summary,
    intent: item.intent,
    author_role: item.author_role,
    fields: item.fields,
  };
}

function describe(v: CompareVerdict): string {
  const because = v.reason ? ` — ${v.reason.replace(/\.$/, "")}` : "";
  return v.verdict === "match"
    ? `khớp ${Math.round((v.score ?? 0) * 100)}%${because}`
    : `bị loại (không liên quan)${because}`;
}

export function diffDefinitions(left: CompareDefinition, right: CompareDefinition): DefinitionDiff {
  const rightKeys = new Set(right.fields.map((f) => f.key));
  const leftKeys = new Set(left.fields.map((f) => f.key));
  const norm = (f: CompareDefinition["fields"][number]) =>
    JSON.stringify({ ...f, order: 0, show_in_alert: true });
  return {
    same_version: left.version_id === right.version_id,
    description_changed: left.description.trim() !== right.description.trim(),
    user_profession_changed: left.user_profession !== right.user_profession,
    want_intent_changed: left.match_policy.want_intent !== right.match_policy.want_intent,
    exclude_roles_changed:
      JSON.stringify([...left.match_policy.exclude_roles].sort()) !==
      JSON.stringify([...right.match_policy.exclude_roles].sort()),
    hard_filters_changed:
      JSON.stringify(left.match_policy.hard_filters) !==
      JSON.stringify(right.match_policy.hard_filters),
    fields_only_left: left.fields.filter((f) => !rightKeys.has(f.key)).map((f) => f.key),
    fields_only_right: right.fields.filter((f) => !leftKeys.has(f.key)).map((f) => f.key),
    fields_changed: left.fields
      .filter((lf) => right.fields.some((rf) => rf.key === lf.key && norm(rf) !== norm(lf)))
      .map((f) => f.key),
  };
}

const RANK: Record<CompareChange, number> = {
  newly_matched: 0,
  no_longer_matched: 1,
  fields_changed: 2,
  still_matched: 3,
  still_unmatched: 4,
  not_compared: 5,
};

export const compareCommands: MockCommandTable = {
  radar_compare_run: async (args) => {
    const input = args.input as RadarCompareInput;
    const left = resolveSide(input.left);
    const right = resolveSide(input.right);
    const leftDef = definitionOf(left);
    const rightDef = definitionOf(right);
    const leftItems = generatePreviewItemsForRadar(
      left.version.radar_id,
      left.version.description,
      left.version.fields
    );
    const rightItems = generatePreviewItemsForRadar(
      right.version.radar_id,
      right.version.description,
      right.version.fields
    );
    const max = input.max_posts ?? 50;
    const chosen = leftItems
      .filter((it) => !input.post_ids?.length || input.post_ids.includes(it.post_id))
      .slice(0, max);
    if (chosen.length === 0) throw new Error("Chưa có bài nào để so sánh.");

    const items: CompareItem[] = chosen.map((lit) => {
      const rit = rightItems.find((x) => x.post_id === lit.post_id)!;
      const l = verdictOf(lit);
      const r = verdictOf(rit);
      const bothMatch = l.verdict === "match" && r.verdict === "match";
      const field_changes = bothMatch
        ? rightDef.fields
            .filter((rf) => leftDef.fields.some((lf) => lf.key === rf.key))
            .filter(
              (rf) => JSON.stringify(l.fields[rf.key]?.value) !== JSON.stringify(r.fields[rf.key]?.value)
            )
            .map((rf) => ({
              key: rf.key,
              label: rf.label,
              before: l.fields[rf.key] ?? null,
              after: r.fields[rf.key] ?? null,
            }))
        : [];
      const change: CompareChange =
        l.verdict === "no_match" && r.verdict === "match"
          ? "newly_matched"
          : l.verdict === "match" && r.verdict === "no_match"
            ? "no_longer_matched"
            : bothMatch
              ? field_changes.length
                ? "fields_changed"
                : "still_matched"
              : "still_unmatched";
      const reason = {
        newly_matched: `Mới khớp ở B: ${describe(r)}. Ở A: ${describe(l)}.`,
        no_longer_matched: `Hết khớp ở B: ${describe(r)}. Ở A: ${describe(l)}.`,
        fields_changed: `Vẫn khớp ở cả hai nhưng đổi trường trích: ${field_changes
          .map((c) => `${c.label}: «${c.before?.raw ?? "(không có)"}» → «${c.after?.raw ?? "(không có)"}»`)
          .join("; ")}.`,
        still_matched: "Khớp ở cả hai, các trường trích giống nhau.",
        still_unmatched: `Không khớp ở cả hai. A: ${describe(l)}. B: ${describe(r)}.`,
        not_compared: "Chưa so sánh được.",
      }[change];
      return {
        post_id: lit.post_id,
        change,
        reason,
        left: l,
        right: r,
        field_changes,
        source_name: lit.source_name,
        author_name: lit.author_name,
        permalink: lit.permalink,
        post_text: lit.post_text,
        post_created_at: lit.post_created_at,
      };
    });
    items.sort((a, b) => RANK[a.change] - RANK[b.change]);

    const count = (c: CompareChange) => items.filter((i) => i.change === c).length;
    const counts: CompareCounts = {
      total: items.length,
      newly_matched: count("newly_matched"),
      no_longer_matched: count("no_longer_matched"),
      fields_changed: count("fields_changed"),
      still_matched: count("still_matched"),
      still_unmatched: count("still_unmatched"),
      not_compared: count("not_compared"),
      left_matches: items.filter((i) => i.left.verdict === "match").length,
      right_matches: items.filter((i) => i.right.verdict === "match").length,
    };
    const comparison: RadarComparison = {
      id: nextId("01JCFC"),
      created_at: Date.now(),
      left: leftDef,
      right: rightDef,
      source_ids: input.source_ids ?? [],
      post_ids: items.map((i) => i.post_id),
      skipped_post_ids: [],
      counts,
      definition_diff: diffDefinitions(leftDef, rightDef),
      items,
    };
    state.comparisons.unshift(structuredClone(comparison));
    return comparison;
  },

  radar_compare_get: async (args) => {
    const found = state.comparisons.find((c) => c.id === String(args.id ?? ""));
    if (!found) throw new Error("Không tìm thấy bản so sánh.");
    return structuredClone(found);
  },

  radar_compare_list: async () =>
    state.comparisons.map(
      (c): RadarComparisonSummary => ({
        id: c.id,
        created_at: c.created_at,
        left_radar_name: c.left.radar_name,
        left_version: c.left.version,
        right_radar_name: c.right.radar_name,
        right_version: c.right.version,
        post_count: c.post_ids.length,
      })
    ),
};
