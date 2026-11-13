// Mock handlers: radars, previews, and stats.

import type {
  RadarDetail,
  CreateRadarDraftInput,
  Radar,
  RadarVersion,
  UpdateRadarInput,
  SuggestFieldsInput,
  SuggestFieldsResult,
  FieldDef,
  RadarStatus,
  PreviewStartInput,
  PreviewItem,
  PreviewRunState,
  FunnelStats,
} from "../../../types/ipc";
import { removeVietnameseDiacritics } from "../../format";
import type { MockCommandTable } from "./types";
import { emitMockEvent } from "../events";
import { nextId } from "../ids";
import { buildPreviewWarnings, generatePreviewItemsForRadar } from "../preview";
import { state } from "../store";
import { TEMPLATES } from "../templates";

export function getRadarDetail(id: string): RadarDetail {
  const radar = state.radars.find((r) => r.id === id);
  if (!radar) {
    throw new Error(`Không tìm thấy radar: ${id}`);
  }
  const versions = state.radarVersions
    .filter((v) => v.radar_id === id)
    .sort((a, b) => b.version - a.version);
  const current = versions.find((v) => v.version === radar.current_version) ?? versions[0];
  if (!current) {
    throw new Error(`Không tìm thấy phiên bản của radar: ${id}`);
  }
  return structuredClone({
    radar,
    current_version_data: current,
    pending_version_data: state.pendingVersions[id] ?? null,
    versions,
  });
}

export const radarCommands: MockCommandTable = {
  radar_list: async () => {
    return structuredClone(state.radars.filter((r) => r.status !== "archived"));
  },

  radar_get: async (args) => {
    return getRadarDetail(String(args.id ?? ""));
  },

  radar_create_draft: async (args) => {
    const input = args.input as CreateRadarDraftInput;
    if (input.fields.length > state.license.limits.max_fields_per_radar) {
      throw new Error(
        `Gói hiện tại giới hạn tối đa ${state.license.limits.max_fields_per_radar} trường mỗi radar.`
      );
    }
    const now = Date.now();
    const radarId = nextId("01JCF3");
    const versionId = nextId("01JCF4");
    const defaultChannels = state.channels.filter((c) => c.state === "ok").map((c) => c.id);

    const radar: Radar = {
      id: radarId,
      name: input.name.trim() || "Radar mới",
      status: "draft",
      template_id: input.template_id ?? null,
      current_version: 1,
      source_ids: [...input.source_ids],
      notify: {
        channel_ids: input.notify?.channel_ids ?? defaultChannels,
        mode: input.notify?.mode ?? state.settings.default_notify_mode,
        min_score: input.notify?.min_score ?? 0.6,
        quiet_hours:
          input.notify?.quiet_hours ??
          (state.settings.quiet_hours_enabled ? state.settings.quiet_hours : null),
      },
      created_at: now,
      updated_at: now,
      leads_24h: 0,
      false_positive_rate: 0,
      evaluated_posts_total: 0,
      rule_handled_pct: input.template_id?.startsWith("bds.") ? 80 : 0,
    };

    const rv: RadarVersion = {
      id: versionId,
      radar_id: radarId,
      version: 1,
      description: input.description,
      language_hint: input.language_hint ?? "vi",
      user_profession: input.user_profession ?? null,
      fields: input.fields.map((f, idx) => ({ ...f, order: idx + 1 })),
      match_policy: input.match_policy,
      created_at: now,
    };

    state.radars.unshift(radar);
    state.radarVersions.push(rv);

    // Follow selected sources up to plan limit
    for (const sid of input.source_ids) {
      const s = state.sources.find((x) => x.id === sid);
      if (s) s.followed = true;
    }

    if (input.template_id?.startsWith("bds.")) {
      state.rulesets.push({
        id: nextId("01JCF5"),
        radar_version_id: versionId,
        revision: 1,
        state: "active",
        origin: "seed",
        body: structuredClone(state.rulesets[0]?.body ?? {
          dsl: 1,
          prefilter: { any: ["can thue", "can mua"], none: ["tuyen sale"], min_len: 20 },
          classify: [],
          extract: [],
          thresholds: { accept: 0.9, reject: 0.9 },
        }),
        metrics: {
          rule_handled_pct: 80,
          ai_handled_pct: 20,
          accept_precision: 0.95,
          false_negative_rate: 0.02,
          sample_size: 50,
        },
        created_at: now,
        activated_at: now,
      });
    }

    return getRadarDetail(radarId);
  },

  radar_update: async (args) => {
    const input = args.input as UpdateRadarInput;
    const radar = state.radars.find((r) => r.id === input.id);
    if (!radar) throw new Error(`Không tìm thấy radar: ${input.id}`);
    const detail = getRadarDetail(input.id);
    const cur = detail.current_version_data;
    const now = Date.now();

    if (input.name !== undefined) radar.name = input.name;
    if (input.source_ids !== undefined) radar.source_ids = [...input.source_ids];
    if (input.notify !== undefined) {
      radar.notify = { ...radar.notify, ...input.notify };
    }
    radar.updated_at = now;

    const definitionChanged =
      (input.description !== undefined && input.description !== cur.description) ||
      (input.user_profession !== undefined && input.user_profession !== cur.user_profession) ||
      (input.fields !== undefined && JSON.stringify(input.fields) !== JSON.stringify(cur.fields)) ||
      (input.match_policy !== undefined &&
        JSON.stringify(input.match_policy) !== JSON.stringify(cur.match_policy));

    if (!definitionChanged) {
      return {
        detail: getRadarDetail(radar.id),
        created_new_version: false,
        requires_confirmation: false,
      };
    }

    const nextVerNum = cur.version + 1;
    const newVersion: RadarVersion = {
      id: nextId("01JCF4"),
      radar_id: radar.id,
      version: nextVerNum,
      description: input.description ?? cur.description,
      language_hint: cur.language_hint,
      user_profession:
        input.user_profession !== undefined ? input.user_profession : cur.user_profession,
      fields: (input.fields ?? cur.fields).map((f, i) => ({ ...f, order: i + 1 })),
      match_policy: input.match_policy ?? cur.match_policy,
      created_at: now,
    };

    // Per 02-radar-spec.md §4: if radar is active and user hasn't confirmed version upgrade yet,
    // keep running old version while staging pending version for preview!
    if (radar.status === "active" && !input.confirm_version_upgrade) {
      state.pendingVersions[radar.id] = newVersion;
      return {
        detail: getRadarDetail(radar.id),
        created_new_version: true,
        requires_confirmation: true,
      };
    }

    delete state.pendingVersions[radar.id];
    state.radarVersions.push(newVersion);
    radar.current_version = nextVerNum;
    return {
      detail: getRadarDetail(radar.id),
      created_new_version: true,
      requires_confirmation: false,
    };
  },

  radar_suggest_fields: async (args) => {
    const input = args.input as SuggestFieldsInput;
    if (input.template_id) {
      const tpl = TEMPLATES.find((t) => t.id === input.template_id);
      if (tpl) {
        return structuredClone({
          suggested_name: tpl.name,
          want_intent: tpl.match_policy.want_intent,
          fields: tpl.fields,
          hard_filters: tpl.match_policy.hard_filters,
          clarifying_questions: [],
          prefilter_hint: null,
        } satisfies SuggestFieldsResult);
      }
    }

    const folded = removeVietnameseDiacritics(input.description).toLowerCase();
    const isBds =
      folded.includes("can ho") ||
      folded.includes("chung cu") ||
      folded.includes("thue nha") ||
      folded.includes("phong ngu");

    const fields: FieldDef[] = isBds
      ? [
          {
            key: "deal_type",
            label: "Nhu cầu",
            type: "enum",
            description: "Khách cần thuê hay mua",
            required: true,
            options: ["thuê", "mua"],
            show_in_alert: true,
            order: 1,
          },
          {
            key: "location",
            label: "Khu vực",
            type: "location",
            description: "Quận, phường hoặc khu vực khách tìm",
            required: true,
            options: null,
            show_in_alert: true,
            order: 2,
          },
          {
            key: "price",
            label: "Ngân sách / Giá",
            type: "money",
            description: "Tầm giá nêu trong bài",
            required: false,
            options: null,
            show_in_alert: true,
            order: 3,
          },
          {
            key: "bedrooms",
            label: "Số phòng ngủ",
            type: "number",
            description: "Số phòng ngủ mong muốn",
            required: false,
            options: null,
            show_in_alert: true,
            order: 4,
          },
          {
            key: "phone",
            label: "Số điện thoại",
            type: "phone",
            description: "Số điện thoại liên hệ trong bài",
            required: false,
            options: null,
            show_in_alert: true,
            order: 5,
          },
        ]
      : [
          {
            key: "need_summary",
            label: "Nhu cầu chính",
            type: "text",
            description: "Hạng mục hoặc sản phẩm cụ thể trong bài",
            required: true,
            options: null,
            show_in_alert: true,
            order: 1,
          },
          {
            key: "location",
            label: "Khu vực",
            type: "location",
            description: "Địa điểm nêu trong bài",
            required: false,
            options: null,
            show_in_alert: true,
            order: 2,
          },
          {
            key: "budget",
            label: "Ngân sách / Giá",
            type: "money",
            description: "Mức giá đề cập trong bài",
            required: false,
            options: null,
            show_in_alert: true,
            order: 3,
          },
          {
            key: "phone",
            label: "Số điện thoại",
            type: "phone",
            description: "Số điện thoại liên hệ",
            required: false,
            options: null,
            show_in_alert: true,
            order: 4,
          },
        ];

    const clarifying: string[] = [];
    if (input.description.trim().length < 35) {
      clarifying.push("Bạn muốn giới hạn ở khu vực/quận nào cụ thể không?");
      clarifying.push("Có ngưỡng ngân sách tối đa hay tối thiểu nào cần lọc cứng không?");
    }

    const result: SuggestFieldsResult = {
      suggested_name: input.description.trim().slice(0, 48) || "Radar tuỳ chỉnh",
      want_intent: folded.includes("can ban") || folded.includes("cho thue") ? "supply" : "demand",
      fields,
      hard_filters: [],
      clarifying_questions: clarifying,
      prefilter_hint: {
        any: ["can", "tim"],
        none: ["tuyen cong tac vien"],
      },
    };
    return result;
  },

  radar_set_status: async (args) => {
    const id = String(args.id ?? "");
    const status = args.status as RadarStatus;
    const radar = state.radars.find((r) => r.id === id);
    if (!radar) throw new Error(`Không tìm thấy radar: ${id}`);

    if (status === "active" && radar.status !== "active") {
      const maxActive = state.license.limits.max_active_radars;
      const activeCount = state.radars.filter((r) => r.status === "active").length;
      if (maxActive !== null && activeCount >= maxActive) {
        throw new Error(
          `Gói Cá nhân giới hạn tối đa ${maxActive} radar đang chạy cùng lúc. Hãy tạm dừng một radar khác hoặc nâng cấp gói Chuyên nghiệp.`
        );
      }
    }

    radar.status = status;
    radar.updated_at = Date.now();
    return structuredClone(radar);
  },

  radar_preview_start: async (args) => {
    const input = args.input as PreviewStartInput;
    const detail = getRadarDetail(input.radar_id);
    const effectiveFields =
      input.fields ??
      detail.pending_version_data?.fields ??
      detail.current_version_data.fields;
    const effectiveDesc =
      input.description ??
      detail.pending_version_data?.description ??
      detail.current_version_data.description;

    const allItems = generatePreviewItemsForRadar(
      input.radar_id,
      effectiveDesc,
      effectiveFields
    );
    const previewId = nextId("01JCFD");
    const firstBatch: PreviewItem[] = [];
    const secondBatch = allItems;

    const initialState: PreviewRunState = {
      preview_id: previewId,
      radar_id: input.radar_id,
      radar_version:
        detail.pending_version_data?.version ?? detail.current_version_data.version,
      status: secondBatch.length > 0 ? "evaluating" : "done",
      total_posts: allItems.length,
      evaluated_posts: firstBatch.length,
      items: firstBatch,
      warnings: secondBatch.length === 0 ? buildPreviewWarnings(effectiveFields, allItems) : [],
      error: null,
    };
    state.previews[input.radar_id] = initialState;

    if (secondBatch.length > 0) {
      setTimeout(() => {
        if (state.previews[input.radar_id]?.preview_id !== previewId || state.previews[input.radar_id]?.status !== "evaluating") return;
        const warnings = buildPreviewWarnings(effectiveFields, allItems);
        const completed: PreviewRunState = {
          ...initialState,
          status: "done",
          evaluated_posts: allItems.length,
          items: allItems,
          warnings,
        };
        state.previews[input.radar_id] = completed;
        emitMockEvent("preview:progress", {
          preview_id: previewId,
          radar_id: input.radar_id,
          status: "done",
          evaluated_posts: allItems.length,
          total_posts: allItems.length,
          new_items: secondBatch,
          warnings,
        });
      }, 15);
    }

    return structuredClone(initialState);
  },

  radar_preview_cancel: async (args) => {
    const preview = state.previews[String(args.radar_id)];
    if (!preview || preview.preview_id !== args.preview_id) throw new Error("Không tìm thấy phiên xem thử.");
    if (preview.status === "evaluating" || preview.status === "crawling") {
      preview.status = "error";
      preview.error = "Đã dừng xem thử.";
    }
    return structuredClone(preview);
  },

  radar_preview_get: async (args) => {
    const radarId = String(args.radar_id ?? "");
    const existing = state.previews[radarId];
    if (!existing) {
      throw new Error("Chưa có phiên xem thử nào cho radar này.");
    }
    return structuredClone(existing);
  },

  radar_stats: async (args) => {
    const stats: FunnelStats = {
      days: Number(args.days ?? 7),
      posts_captured: 2450,
      dedup_dropped: 420,
      prefilter_dropped: 1380,
      rule_decided: 533,
      rule_matched: 42,
      ai_decided: 117,
      ai_matched: 26,
      leads_created: 58,
      leads_notified: 49,
      leads_weak: 9,
      false_positives: 4,
    };
    return stats;
  },
};
