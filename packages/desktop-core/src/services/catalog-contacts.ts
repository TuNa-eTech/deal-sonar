// `contact_list/get/block/note` and `blocklist_list/add/remove`
// (crates/core/src/service/contacts.rs).

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { nowMs } from "../store/util";
import type { BlocklistRecord } from "../store/contacts";
import { blocklistRecordToDto, contactRecordToDto, loadLeadDto } from "./catalog-convert";
import { ensureNotShuttingDown } from "./catalog-runtime";
import { dString, dUsize, parseArg, parseOptArg } from "./catalog-serde";
import {
  type BlocklistEntryDto,
  type BlocklistKind,
  type BlocklistRemoveResultDto,
  type ContactBlockResultDto,
  type ContactDetailDto,
  type ContactDto,
  type LeadDto,
  dBlocklistKind,
} from "./catalog-types";

export function contactList(ctx: RuntimeContext, search: string | null, limit: number): ContactDto[] {
  const summaries = ctx.store.contacts.list(search, limit);
  const blocklist = ctx.store.blocklist.list(null);
  return summaries.map((c) => contactRecordToDto(c, c.lead_count, blocklist));
}

export function contactGet(ctx: RuntimeContext, id: string): ContactDetailDto {
  const detail = ctx.store.contacts.get(id);
  if (!detail) throw CoreError.notFound("contact", id);
  const blocklist = ctx.store.blocklist.list(null);
  const contact = contactRecordToDto(detail.contact, detail.leads.length, blocklist);
  const leads: LeadDto[] = [];
  for (const item of detail.leads) {
    const dto = loadLeadDto(ctx, item.lead.id);
    if (dto) leads.push(dto);
  }
  return { contact, leads };
}

export function contactBlock(
  ctx: RuntimeContext,
  id: string,
  reason: string | null,
  radarId: string | null,
): ContactBlockResultDto {
  ensureNotShuttingDown(ctx);
  const now = nowMs();
  const detail = ctx.store.contacts.get(id);
  if (!detail) throw CoreError.notFound("contact", id);
  const blocked: BlocklistEntryDto[] = [];
  for (const phone of detail.contact.phones) {
    const rec = ctx.store.blocklist.add("phone", phone, radarId, reason, now);
    blocked.push(blocklistRecordToDto(rec, detail.contact.display_name));
  }
  for (const authorId of detail.contact.author_ids) {
    const rec = ctx.store.blocklist.add("author", authorId, radarId, reason, now);
    blocked.push(blocklistRecordToDto(rec, detail.contact.display_name));
  }
  return { blocked_entries: blocked };
}

export function contactNote(ctx: RuntimeContext, id: string, note: string): ContactDto {
  ensureNotShuttingDown(ctx);
  const now = nowMs();
  const updated = ctx.store.contacts.setNote(id, note.trim() === "" ? null : note, now);
  if (!updated) throw CoreError.notFound("contact", id);
  const detail = ctx.store.contacts.get(id);
  const leadCount = detail ? detail.leads.length : 0;
  return contactRecordToDto(updated, leadCount, ctx.store.blocklist.list(null));
}

/** Author display name for `author` blocklist entries; lookup failures are ignored (`.ok().flatten()`). */
function authorLabel(ctx: RuntimeContext, rec: BlocklistRecord): string | null {
  if (rec.kind !== "author") return null;
  try {
    return ctx.store.posts.authorGet(rec.value)?.name ?? null;
  } catch {
    return null;
  }
}

export function blocklistList(ctx: RuntimeContext, radarId: string | null): BlocklistEntryDto[] {
  return ctx.store.blocklist.list(radarId).map((rec) => blocklistRecordToDto(rec, authorLabel(ctx, rec)));
}

export function blocklistAdd(
  ctx: RuntimeContext,
  kind: BlocklistKind,
  value: string,
  reason: string | null,
  radarId: string | null,
): BlocklistEntryDto {
  ensureNotShuttingDown(ctx);
  const rec = ctx.store.blocklist.add(kind, value, radarId, reason, nowMs());
  return blocklistRecordToDto(rec, authorLabel(ctx, rec));
}

export function blocklistRemove(ctx: RuntimeContext, id: string): BlocklistRemoveResultDto {
  ensureNotShuttingDown(ctx);
  return { removed: ctx.store.blocklist.remove(id) };
}

export function createContactHandlers(): HandlerTable {
  return {
    contact_list: (ctx, args) => {
      const search = parseOptArg(args, "search", dString);
      const limit = parseOptArg(args, "limit", dUsize);
      return contactList(ctx, search, limit ?? 100);
    },
    contact_get: (ctx, args) => contactGet(ctx, parseArg(args, "id", dString)),
    contact_block: (ctx, args) => {
      const id = parseArg(args, "id", dString);
      const reason = parseOptArg(args, "reason", dString);
      const radarId = parseOptArg(args, "radar_id", dString);
      return contactBlock(ctx, id, reason, radarId);
    },
    contact_note: (ctx, args) => contactNote(ctx, parseArg(args, "id", dString), parseArg(args, "note", dString)),
    blocklist_list: (ctx, args) => blocklistList(ctx, parseOptArg(args, "radar_id", dString)),
    blocklist_add: (ctx, args) => {
      const kind = parseArg(args, "kind", dBlocklistKind);
      const value = parseArg(args, "value", dString);
      const reason = parseOptArg(args, "reason", dString);
      const radarId = parseOptArg(args, "radar_id", dString);
      return blocklistAdd(ctx, kind, value, reason, radarId);
    },
    blocklist_remove: (ctx, args) => blocklistRemove(ctx, parseArg(args, "id", dString)),
  };
}
