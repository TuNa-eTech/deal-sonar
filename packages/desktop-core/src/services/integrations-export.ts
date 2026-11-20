// Handler: lead_export. Ports `CoreService::lead_export` / `build_store_lead_query`
// (crates/core/src/service/leads.rs) on top of the CSV/XLSX writers in src/notify/export.ts.

import * as fs from "node:fs";
import * as path from "node:path";

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { type ExportLeadRow, exportCsv, exportXlsx } from "../notify/export";
import { extractedFieldsStoreToNotify } from "../notify/format";
import type { FieldDef, FilterOp } from "../store/domain";
import type { LeadListItem, LeadListQuery } from "../store/leads";
import {
  ArgShapeError,
  argRequired,
  asArrayOf,
  asBool,
  asEnum,
  asI64,
  asObject,
  asString,
  asUsize,
} from "./integrations-args";
import { guarded } from "./integrations-outbox";
import { currentLicenseStatus, nowMs } from "./integrations-state";

type Json = unknown;

export type ExportFormat = "csv" | "xlsx";
const EXPORT_FORMATS = ["csv", "xlsx"] as const;
const FILTER_OPS: readonly FilterOp[] = ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "contains", "is_empty"];
const LEAD_STATUSES = ["new", "viewed", "contacted", "negotiating", "won", "lost", "ignored"] as const;

export interface LeadFilterQueryDto {
  unread_only?: boolean | null;
  follow_up_before?: number | null;
  follow_up_after?: number | null;
  radar_id?: string | null;
  status?: string[] | null;
  include_weak?: boolean | null;
  since?: number | null;
  filters?: Array<{ field: string; op: FilterOp; value: unknown }> | null;
  search?: string | null;
  sort?: { by: string; dir: string } | null;
  limit?: number | null;
  cursor?: string | null;
  expired?: boolean | null;
}

export interface LeadExportInput {
  lead_ids: string[] | null;
  query: LeadFilterQueryDto;
  format: ExportFormat;
  include_post_text: boolean;
  dest_path: string | null;
}

export interface LeadExportResult {
  path: string;
  format: ExportFormat;
  row_count: number;
  content_preview?: string;
}

function optional<T>(o: Record<string, Json>, key: string, parse: (v: Json) => T): T | null {
  const v = o[key];
  return v === undefined || v === null ? null : parse(v);
}

function parseLeadFilterQuery(value: Json): LeadFilterQueryDto {
  const o = asObject(value, "struct LeadFilterQuery");
  const filters = optional(o, "filters", (v) =>
    asArrayOf(v, (f) => {
      const fo = asObject(f, "struct DynamicFieldFilter");
      if (!("field" in fo)) throw new ArgShapeError("missing field `field`");
      if (!("op" in fo)) throw new ArgShapeError("missing field `op`");
      return { field: asString(fo.field), op: asEnum(fo.op, FILTER_OPS), value: fo.value === undefined ? null : fo.value };
    }),
  );
  const sort = optional(o, "sort", (v) => {
    const so = asObject(v, "struct LeadSortInput");
    if (!("by" in so)) throw new ArgShapeError("missing field `by`");
    if (!("dir" in so)) throw new ArgShapeError("missing field `dir`");
    return { by: asString(so.by), dir: asString(so.dir) };
  });
  return {
    unread_only: optional(o, "unread_only", asBool),
    follow_up_before: optional(o, "follow_up_before", asI64),
    follow_up_after: optional(o, "follow_up_after", asI64),
    radar_id: optional(o, "radar_id", asString),
    status: optional(o, "status", (v) => asArrayOf(v, (s) => asEnum(s, LEAD_STATUSES))),
    include_weak: optional(o, "include_weak", asBool),
    since: optional(o, "since", asI64),
    filters,
    search: optional(o, "search", asString),
    sort,
    limit: optional(o, "limit", asUsize),
    cursor: optional(o, "cursor", asString),
    expired: optional(o, "expired", asBool),
  };
}

export function parseLeadExportInput(value: Json): LeadExportInput {
  const o = asObject(value, "struct LeadExportInput");
  for (const k of ["query", "format", "include_post_text"]) {
    if (!(k in o)) throw new ArgShapeError(`missing field \`${k}\``);
  }
  return {
    lead_ids: optional(o, "lead_ids", (v) => asArrayOf(v, asString)),
    query: parseLeadFilterQuery(o.query),
    format: asEnum(o.format, EXPORT_FORMATS),
    include_post_text: asBool(o.include_post_text),
    dest_path: optional(o, "dest_path", asString),
  };
}

/** `build_store_lead_query`: DTO filter -> store query (`limit` clamped to `1..=500`). */
export function buildStoreLeadQuery(q: LeadFilterQueryDto, now: number): LeadListQuery {
  return {
    unread_only: q.unread_only ?? null,
    follow_up_before: q.follow_up_before ?? null,
    follow_up_after: q.follow_up_after ?? null,
    exclude_weak: q.include_weak === false,
    radar_id: q.radar_id ?? null,
    status: q.status ?? null,
    since: q.since ?? null,
    min_score: null,
    search: q.search ?? null,
    filters: (q.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value })),
    sort: q.sort ? { by: q.sort.by, dir: q.sort.dir.toLowerCase() === "asc" ? "asc" : "desc" } : null,
    limit: Math.min(500, Math.max(1, q.limit ?? 50)),
    cursor: q.cursor ?? null,
    expiry: q.expired !== null && q.expired !== undefined ? { expired: q.expired, now_ms: now } : null,
  };
}

export function leadExport(ctx: RuntimeContext, input: LeadExportInput): LeadExportResult {
  const now = nowMs();
  if (input.format === "xlsx") {
    const license = currentLicenseStatus(ctx, now);
    if (!license.limits.allow_xlsx_export) {
      throw CoreError.licenseLimit(
        "XLSX export requires the Pro (Chuyên nghiệp) plan; CSV export is available on all plans",
      );
    }
  }

  const store = ctx.store;
  const storeQuery = buildStoreLeadQuery({ ...input.query, limit: 500, cursor: null }, now);
  let page = store.leads.list(storeQuery);
  const items: LeadListItem[] = [...page.items];
  while (page.next_cursor !== null) {
    page = store.leads.list({ ...storeQuery, cursor: page.next_cursor });
    items.push(...page.items);
  }

  let selected = items;
  if (input.lead_ids !== null) {
    const ids = new Set(input.lead_ids);
    selected = items.filter((l) => ids.has(l.lead.id));
  }

  // Field definitions: the requested radar's, or the union across all radars (first definition wins).
  let fieldDefs: FieldDef[] = [];
  if (input.query.radar_id !== null && input.query.radar_id !== undefined) {
    fieldDefs = store.radars.get(input.query.radar_id)?.current_version.fields ?? [];
  } else {
    const seen = new Set<string>();
    for (const r of store.radars.list(true, now)) {
      for (const f of r.current_version.fields) {
        if (!seen.has(f.key)) {
          seen.add(f.key);
          fieldDefs.push(f);
        }
      }
    }
  }

  const minScoreByRadar = new Map<string, number>();
  const minScore = (radarId: string): number => {
    let v = minScoreByRadar.get(radarId);
    if (v === undefined) {
      v = store.radars.get(radarId)?.radar.notify.min_score ?? 0.6;
      minScoreByRadar.set(radarId, v);
    }
    return v;
  };

  const rows: ExportLeadRow[] = [];
  for (const item of selected) {
    if (input.query.include_weak === false && item.lead.score < minScore(item.lead.radar_id)) continue;
    rows.push({
      post_created_at: item.post_created_at,
      radar_name: item.radar_name,
      status: item.lead.status,
      score: item.lead.score,
      summary: item.lead.summary,
      group_name: item.source_name,
      author_name: item.author_name ?? "Ẩn danh",
      permalink: item.permalink,
      post_text: input.include_post_text ? item.post_text : null,
      fields: extractedFieldsStoreToNotify(item.lead.fields),
    });
  }

  const options = { include_post_text: input.include_post_text };
  const bytes = input.format === "csv" ? exportCsv(options, fieldDefs, rows) : exportXlsx(options, fieldDefs, rows);

  let outPath: string;
  if (input.dest_path !== null && input.dest_path.trim() !== "") {
    outPath = input.dest_path;
  } else {
    const exportDir = path.join(ctx.config.dataDir, "exports");
    fs.mkdirSync(exportDir, { recursive: true });
    outPath = path.join(exportDir, `leads-${now}.${input.format}`);
  }
  const parent = path.dirname(outPath);
  if (parent !== "" && parent !== ".") fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(outPath, bytes);

  const result: LeadExportResult = { path: outPath, format: input.format, row_count: rows.length };
  if (input.format === "csv") result.content_preview = [...bytes.toString("utf8")].slice(0, 4096).join("");
  return result;
}

/** `lead_export`. */
export const EXPORT_HANDLERS: HandlerTable = {
  lead_export: guarded((ctx, args) => leadExport(ctx, argRequired(args, "input", parseLeadExportInput))),
};
