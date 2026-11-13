// Mock handlers: leads.

import type {
  LeadFilterQuery,
  LeadListResponse,
  LeadDetail,
  LeadStatus,
  LeadFeedbackInput,
  Lead,
  BlocklistEntry,
  LeadFeedbackResult,
  LeadExportInput,
  LeadExportResult,
} from "../../../types/ipc";
import { removeVietnameseDiacritics, formatExtractedFieldValue } from "../../format";
import { escapeCsvCell } from "../../security";
import type { MockCommandTable } from "./types";
import { emitMockEvent } from "../events";
import { getNumericComparable, getStringComparableValues, matchesDynamicFilter } from "../filters";
import { nextId } from "../ids";
import { invokeMockCommand } from "../index";
import { state } from "../store";

export const leadCommands: MockCommandTable = {
  lead_list: async (args) => {
    const query = (args.query ?? args) as LeadFilterQuery;
    let items = [...state.leads];
    if (query.unread_only) items = items.filter(l=>!l.read_at && l.status!=="viewed");
    if (query.follow_up_before!=null) items=items.filter(l=>l.follow_up_at!=null && l.follow_up_at<=query.follow_up_before! && !["won","lost","ignored"].includes(l.status));

    if (query.radar_id) {
      // Validate dynamic filter keys against radar fields (mirroring 04-data-model.md §3)
      const rv = state.radarVersions
        .filter((v) => v.radar_id === query.radar_id)
        .sort((a, b) => b.version - a.version)[0];
      if (rv && query.filters?.length) {
        const allowed = new Set(rv.fields.map((f) => f.key));
        for (const f of query.filters) {
          if (!/^[a-z][a-z0-9_]{0,30}$/.test(f.field) || !allowed.has(f.field)) {
            throw new Error(`Khoá trường lọc không hợp lệ: ${f.field}`);
          }
        }
      }
      items = items.filter((l) => l.radar_id === query.radar_id);
    }

    if (!query.include_weak) {
      items = items.filter((l) => !l.is_weak_match);
    }

    if (query.status && query.status.length > 0) {
      const set = new Set(query.status);
      items = items.filter((l) => set.has(l.status));
    }

    if (query.since) {
      items = items.filter((l) => l.created_at >= query.since!);
    }

    if (query.search && query.search.trim().length > 0) {
      const q = removeVietnameseDiacritics(query.search.trim()).toLowerCase();
      items = items.filter((l) => {
        const post = state.posts.find((p) => p.id === l.post_id);
        const haystack = removeVietnameseDiacritics(
          `${l.summary} ${l.note ?? ""} ${l.author_name} ${post?.text ?? ""}`
        ).toLowerCase();
        return haystack.includes(q);
      });
    }

    if (query.filters && query.filters.length > 0) {
      for (const f of query.filters) {
        items = items.filter((l) => matchesDynamicFilter(l, f));
      }
    }

    const sortBy = query.sort?.by ?? "created_at";
    const dir = query.sort?.dir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      if (sortBy === "created_at") return (a.created_at - b.created_at) * dir;
      if (sortBy === "score") return (a.score - b.score) * dir;
      const na = getNumericComparable(a.fields[sortBy], "min");
      const nb = getNumericComparable(b.fields[sortBy], "min");
      if (na !== null && nb !== null) return (na - nb) * dir;
      const sa = getStringComparableValues(a.fields[sortBy])[0] ?? "";
      const sb = getStringComparableValues(b.fields[sortBy])[0] ?? "";
      return sa.localeCompare(sb, "vi") * dir;
    });

    const limit = query.limit ?? 50;
    const startOffset = query.cursor ? Number(query.cursor) || 0 : 0;
    const paged = items.slice(startOffset, startOffset + limit);
    const nextCursor =
      startOffset + limit < items.length ? String(startOffset + limit) : null;

    const resp: LeadListResponse = {
      items: structuredClone(paged),
      total: items.length,
      next_cursor: nextCursor,
    };
    return resp;
  },

  lead_mark_read: async (args) => {
    const lead=state.leads.find(l=>l.id===args.id);
    if (!lead) throw new Error("Không tìm thấy tin");
    lead.read_at ??= Date.now();
    return invokeMockCommand("lead_get", {id:lead.id});
  },

  lead_get: async (args) => {
    const id = String(args.id ?? "");
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
    const post =
      state.posts.find((p) => p.id === lead.post_id) ?? {
        id: lead.post_id,
        platform: "facebook",
        external_id: lead.post_id,
        source_id: lead.source_id,
        source_name: lead.source_name,
        author_id: lead.author_id,
        author_name: lead.author_name,
        permalink: lead.permalink,
        text: lead.summary,
        text_truncated: false,
        lang: "vi",
        created_at: lead.post_created_at,
        captured_at: lead.created_at,
        strategy: "network" as const,
        purged_at: null,
      };
    const rv = state.radarVersions.find((v) => v.id === lead.radar_version_id);
    const detail: LeadDetail = {
      lead: structuredClone(lead),
      post: structuredClone(post),
      radar_fields: structuredClone(rv?.fields ?? []),
      events: structuredClone(state.leadEvents[lead.id] ?? []),
    };
    return detail;
  },

  lead_set_status: async (args) => {
    const id = String(args.id ?? "");
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
    const now = Date.now();
    if (args.status !== undefined) {
      lead.status = args.status as LeadStatus;
    }
    if (args.note !== undefined) {
      lead.note = (args.note as string | null) || null;
    }
    if (args.tags !== undefined) {
      lead.tags = (args.tags as string[] | null) ?? [];
    }
    if (args.follow_up_at !== undefined) {
      lead.follow_up_at = (args.follow_up_at as number | null) ?? null;
    }
    lead.updated_at = now;
    state.leadEvents[lead.id] = [
      ...(state.leadEvents[lead.id] ?? []),
      {
        id: nextId("01JCFE"),
        lead_id: lead.id,
        kind: args.note !== undefined ? "noted" : "status_changed",
        data: { status: lead.status, note: lead.note },
        created_at: now,
      },
    ];
    emitMockEvent("lead:updated", structuredClone(lead));
    return invokeMockCommand("lead_get", { id });
  },

  lead_update_field: async (args) => {
    const id = String(args.id ?? "");
    const fieldKey = String(args.field_key ?? "");
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) throw new Error(`Không tìm thấy tin: ${id}`);
    const now = Date.now();
    const prev = lead.fields[fieldKey];
    lead.fields[fieldKey] = {
      value: args.value,
      raw: (args.raw as string | null | undefined) ?? prev?.raw ?? null,
      confidence: 1.0,
      source: "user",
    };
    lead.updated_at = now;
    state.leadEvents[lead.id] = [
      ...(state.leadEvents[lead.id] ?? []),
      {
        id: nextId("01JCFE"),
        lead_id: lead.id,
        kind: "field_edited",
        data: { field_key: fieldKey, value: args.value },
        created_at: now,
      },
    ];
    emitMockEvent("lead:updated", structuredClone(lead));
    return invokeMockCommand("lead_get", { id });
  },

  lead_feedback: async (args) => {
    const input = args.input as LeadFeedbackInput;
    const feedbackId = nextId("01JCFF");
    let updatedLead: Lead | null = null;
    let blockedEntry: BlocklistEntry | null = null;

    if (input.origin === "preview") {
      // Store in previewFeedback so re-running preview uses this feedback immediately!
      for (const [rId, prevState] of Object.entries(state.previews)) {
        const item = prevState.items.find((it) => it.evaluation_id === input.evaluation_id);
        if (item) {
          item.feedback_label = input.label;
          state.previewFeedback[rId] = {
            ...(state.previewFeedback[rId] ?? {}),
            [input.evaluation_id]: input.label,
          };
        }
      }
    }

    if (input.label === "missed") {
      const rej = state.rejectedEvaluations.find(
        (e) => e.evaluation_id === input.evaluation_id
      );
      if (rej) {
        rej.marked_missed = true;
      }
    }

    if (input.lead_id) {
      const lead = state.leads.find((l) => l.id === input.lead_id);
      if (lead) {
        lead.feedback_label = input.label;
        if (
          input.label === "irrelevant" ||
          input.label === "peer" ||
          input.label === "spam" ||
          input.label === "duplicate"
        ) {
          lead.status = "ignored";
        }
        if (input.label === "wrong_fields" && input.corrected_fields) {
          for (const [k, v] of Object.entries(input.corrected_fields)) {
            lead.fields[k] = {
              value: v,
              raw: lead.fields[k]?.raw ?? null,
              confidence: 1.0,
              source: "user",
            };
          }
        }
        lead.updated_at = Date.now();
        updatedLead = structuredClone(lead);
        emitMockEvent("lead:updated", structuredClone(lead));

        if (input.block_author && (lead.author_id || lead.author_name)) {
          blockedEntry = {
            id: nextId("01JCFB"),
            kind: "author",
            value: lead.author_id ?? lead.author_name,
            display_label: lead.author_name,
            radar_id: null,
            reason: "Người cùng nghề (chặn từ phản hồi tin)",
            created_at: Date.now(),
          };
          state.blocklist.unshift(blockedEntry);
        }
      }
    }

    const res: LeadFeedbackResult = {
      feedback_id: feedbackId,
      updated_lead: updatedLead,
      blocked_entry: blockedEntry,
    };
    return res;
  },

  lead_export: async (args) => {
    const input = args.input as LeadExportInput;
    const listRes = await invokeMockCommand<LeadListResponse>("lead_list", {
      query: { ...input.query, limit: 10_000, cursor: null },
    });
    const rv = input.query.radar_id
      ? state.radarVersions.find((v) => v.radar_id === input.query.radar_id)
      : undefined;
    const fields = rv?.fields ?? [];

    const headers = [
      "Thời điểm đăng",
      "Radar",
      "Trạng thái",
      "Điểm",
      "Tóm tắt",
      "Group",
      "Tác giả",
      "Liên kết",
      ...(input.include_post_text ? ["Nội dung"] : []),
      ...fields.map((f) => f.label),
    ];

    const rows = listRes.items.map((lead) => {
      const post = state.posts.find((p) => p.id === lead.post_id);
      const fixed = [
        lead.post_created_at ? new Date(lead.post_created_at).toISOString() : "",
        lead.radar_name,
        lead.status,
        lead.score.toFixed(2),
        lead.summary,
        lead.source_name,
        lead.author_name,
        lead.permalink,
        ...(input.include_post_text ? [post?.text ?? ""] : []),
      ];
      const dyn = fields.map((f) => formatExtractedFieldValue(f, lead.fields[f.key]));
      return [...fixed, ...dyn].map(escapeCsvCell).join(",");
    });

    const csvBody = "\uFEFF" + [headers.map(escapeCsvCell).join(","), ...rows].join("\r\n");
    const ext = input.format === "xlsx" ? "xlsx" : "csv";
    const outPath =
      input.dest_path ?? `~/Downloads/dealsonar-leads-${new Date().toISOString().slice(0, 10)}.${ext}`;

    const result: LeadExportResult = {
      path: outPath,
      format: input.format,
      row_count: listRes.items.length,
      content_preview: csvBody,
    };
    return result;
  },
};
