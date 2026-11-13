// Mock handlers: contacts and blocklist.

import { removeVietnameseDiacritics } from "../../format";
import type { ContactDetail, BlocklistEntry, BlocklistKind } from "../../../types/ipc";
import type { MockCommandTable } from "./types";
import { nextId } from "../ids";
import { state } from "../store";

export const contactCommands: MockCommandTable = {
  contact_list: async (args) => {
    const q = removeVietnameseDiacritics(String(args.search ?? "").trim()).toLowerCase();
    let items = [...state.contacts];
    if (q) {
      items = items.filter((c) =>
        removeVietnameseDiacritics(
          `${c.display_name} ${c.phones.join(" ")} ${c.note ?? ""}`
        )
          .toLowerCase()
          .includes(q)
      );
    }
    return structuredClone(items);
  },

  contact_get: async (args) => {
    const id = String(args.id ?? "");
    const contact = state.contacts.find((c) => c.id === id);
    if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
    const leads = state.leads.filter((l) => l.contact_id === id);
    return structuredClone({ contact, leads } satisfies ContactDetail);
  },

  contact_block: async (args) => {
    const id = String(args.id ?? "");
    const contact = state.contacts.find((c) => c.id === id);
    if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
    contact.is_blocked = true;
    const created: BlocklistEntry[] = [];
    for (const phone of contact.phones) {
      const entry: BlocklistEntry = {
        id: nextId("01JCFB"),
        kind: "phone",
        value: phone,
        display_label: `${contact.display_name} (${phone})`,
        radar_id: (args.radar_id as string | null) ?? null,
        reason: (args.reason as string | null) ?? "Chặn từ Danh bạ",
        created_at: Date.now(),
      };
      state.blocklist.unshift(entry);
      created.push(entry);
    }
    return { blocked_entries: structuredClone(created) };
  },

  contact_note: async (args) => {
    const id = String(args.id ?? "");
    const contact = state.contacts.find((c) => c.id === id);
    if (!contact) throw new Error(`Không tìm thấy liên hệ: ${id}`);
    contact.note = String(args.note ?? "");
    contact.updated_at = Date.now();
    return structuredClone(contact);
  },

  blocklist_list: async () => {
    return structuredClone(state.blocklist);
  },

  blocklist_add: async (args) => {
    const entry: BlocklistEntry = {
      id: nextId("01JCFB"),
      kind: args.kind as BlocklistKind,
      value: String(args.value ?? "").trim(),
      display_label: String(args.value ?? "").trim(),
      radar_id: (args.radar_id as string | null) ?? null,
      reason: (args.reason as string | null) ?? null,
      created_at: Date.now(),
    };
    state.blocklist.unshift(entry);
    return structuredClone(entry);
  },

  blocklist_remove: async (args) => {
    const id = String(args.id ?? "");
    const before = state.blocklist.length;
    state.blocklist = state.blocklist.filter((b) => b.id !== id);
    return { removed: state.blocklist.length < before };
  },
};
