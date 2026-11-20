// Port of crates/store/src/contacts.rs and models/contacts.rs.

import type Database from "better-sqlite3";

import { StoreError } from "./errors";
import { type LeadListItem, mapLeadListItemRow } from "./leads";
import { foldVi, newUlid } from "./util";

export interface ContactRecord {
  id: string;
  display_name: string | null;
  phones: string[];
  author_ids: string[];
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactSummary extends ContactRecord {
  lead_count: number;
  last_lead_at: number | null;
}

export interface ContactDetail {
  contact: ContactRecord;
  leads: LeadListItem[];
}

export interface BlocklistRecord {
  id: string;
  kind: string;
  value: string;
  radar_id: string | null;
  reason: string | null;
  created_at: number;
}

type Row = Record<string, unknown>;

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function mapContact(row: Row): ContactRecord {
  return {
    id: row.id as string,
    display_name: row.display_name as string | null,
    phones: parseStringArray(row.phones),
    author_ids: parseStringArray(row.author_ids),
    note: row.note as string | null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

const mapBlocklist = (row: Row): BlocklistRecord => ({
  id: row.id as string,
  kind: row.kind as string,
  value: row.value as string,
  radar_id: row.radar_id as string | null,
  reason: row.reason as string | null,
  created_at: row.created_at as number,
});

/** `BTreeSet<String>` iteration order (byte-wise, equal to code-unit order for these ids). */
const sortedSet = (s: Set<string>): string[] => [...s].sort();

const trimmedOrNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

export class Contacts {
  constructor(private readonly db: Database.Database) {}

  /**
   * Find or create (and merge when several match) a contact by E.164 phones, then by author id.
   * Returns null when there is neither an author id nor a phone.
   */
  upsertFromLead(
    authorId: string | null,
    authorName: string | null,
    e164Phones: string[],
    nowMs: number,
  ): ContactRecord | null {
    const cleanAuthorId = trimmedOrNull(authorId);
    const cleanPhones = e164Phones.map((p) => p.trim()).filter((p) => p !== "");
    if (cleanAuthorId === null && cleanPhones.length === 0) return null;

    return this.db.transaction((): ContactRecord => {
      const matched = new Set<string>();
      for (const phone of cleanPhones) {
        const rows = this.db
          .prepare(
            `SELECT id FROM contacts WHERE phones IS NOT NULL
               AND EXISTS (SELECT 1 FROM json_each(phones) jp WHERE jp.value = ?1)`,
          )
          .all(phone) as Array<{ id: string }>;
        for (const r of rows) matched.add(r.id);
      }
      if (cleanAuthorId !== null) {
        const rows = this.db
          .prepare(
            `SELECT id FROM contacts WHERE author_ids IS NOT NULL
               AND EXISTS (SELECT 1 FROM json_each(author_ids) ja WHERE ja.value = ?1)`,
          )
          .all(cleanAuthorId) as Array<{ id: string }>;
        for (const r of rows) matched.add(r.id);
      }

      const cleanName = trimmedOrNull(authorName);
      let contactId: string;

      if (matched.size === 0) {
        contactId = newUlid(nowMs);
        const phonesJson = cleanPhones.length > 0 ? JSON.stringify(cleanPhones) : null;
        const authorsJson = cleanAuthorId !== null ? JSON.stringify([cleanAuthorId]) : null;
        this.db
          .prepare(
            `INSERT INTO contacts (id, display_name, phones, author_ids, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)`,
          )
          .run(contactId, cleanName, phonesJson, authorsJson, nowMs);
      } else {
        // Oldest contact is the stable primary.
        const contacts: ContactRecord[] = [];
        for (const cid of sortedSet(matched)) {
          const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?1").get(cid) as Row | undefined;
          if (row) contacts.push(mapContact(row));
        }
        contacts.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const primary = contacts[0];
        contactId = primary.id;

        const phones = new Set(primary.phones);
        const authors = new Set(primary.author_ids);
        let name = primary.display_name;
        const notes: string[] = primary.note !== null ? [primary.note] : [];

        for (const secondary of contacts.slice(1)) {
          for (const p of secondary.phones) phones.add(p);
          for (const a of secondary.author_ids) authors.add(a);
          if (name === null && secondary.display_name !== null) name = secondary.display_name;
          if (secondary.note !== null && secondary.note !== "" && !notes.includes(secondary.note)) {
            notes.push(secondary.note);
          }
          this.db.prepare("UPDATE leads SET contact_id = ?1 WHERE contact_id = ?2").run(contactId, secondary.id);
          this.db.prepare("DELETE FROM contacts WHERE id = ?1").run(secondary.id);
        }

        for (const p of cleanPhones) phones.add(p);
        if (cleanAuthorId !== null) authors.add(cleanAuthorId);
        if (name === null) name = cleanName;

        const phonesVec = sortedSet(phones);
        const authorsVec = sortedSet(authors);
        this.db
          .prepare(
            `UPDATE contacts SET display_name = ?1, phones = ?2, author_ids = ?3, note = ?4, updated_at = ?5
             WHERE id = ?6`,
          )
          .run(
            name,
            phonesVec.length > 0 ? JSON.stringify(phonesVec) : null,
            authorsVec.length > 0 ? JSON.stringify(authorsVec) : null,
            notes.length > 0 ? notes.join("\n") : null,
            nowMs,
            contactId,
          );
      }
      return mapContact(this.db.prepare("SELECT * FROM contacts WHERE id = ?1").get(contactId) as Row);
    })();
  }

  /** Contacts with lead count and latest lead time, optionally filtered by diacritic-folded search. */
  list(search: string | null, limit: number): ContactSummary[] {
    const lim = Math.min(500, Math.max(1, Math.trunc(limit)));
    const q = trimmedOrNull(search);
    const map = (row: Row): ContactSummary => ({
      ...mapContact(row),
      lead_count: row.lead_count as number,
      last_lead_at: row.last_lead_at as number | null,
    });
    const rows =
      q !== null
        ? (this.db
            .prepare(
              `SELECT c.*, COUNT(l.id) AS lead_count, MAX(l.created_at) AS last_lead_at
               FROM contacts c LEFT JOIN leads l ON l.contact_id = c.id
               WHERE dealsonar_fold_contains(
                 COALESCE(c.display_name, '') || ' ' || COALESCE(c.phones, '') || ' ' || COALESCE(c.note, ''),
                 ?1
               ) = 1
               GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?2`,
            )
            .all(q, lim) as Row[])
        : (this.db
            .prepare(
              `SELECT c.*, COUNT(l.id) AS lead_count, MAX(l.created_at) AS last_lead_at
               FROM contacts c LEFT JOIN leads l ON l.contact_id = c.id
               GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?1`,
            )
            .all(lim) as Row[]);
    return rows.map(map);
  }

  get(contactId: string): ContactDetail | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?1").get(contactId) as Row | undefined;
    if (!row) return null;
    const leads = (
      this.db
        .prepare(
          `SELECT l.*, r.name AS radar_name, p.source_id, s.name AS source_name, p.author_id,
                  a.name AS author_name, p.permalink, p.created_at AS post_created_at, p.text AS post_text
           FROM leads l
           JOIN radars r ON r.id = l.radar_id
           JOIN posts p ON p.id = l.post_id
           JOIN sources s ON s.id = p.source_id
           LEFT JOIN authors a ON a.id = p.author_id
           WHERE l.contact_id = ?1
           ORDER BY l.created_at DESC`,
        )
        .all(contactId) as Row[]
    ).map(mapLeadListItemRow);
    return { contact: mapContact(row), leads };
  }

  setNote(contactId: string, note: string | null, nowMs: number): ContactRecord | null {
    const changed = this.db
      .prepare("UPDATE contacts SET note = ?1, updated_at = ?2 WHERE id = ?3")
      .run(note, nowMs, contactId).changes;
    if (changed === 0) return null;
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?1").get(contactId) as Row | undefined;
    return row ? mapContact(row) : null;
  }
}

export class Blocklist {
  constructor(private readonly db: Database.Database) {}

  /** Idempotent on `(kind, value, radar_id)`. */
  add(kind: string, value: string, radarId: string | null, reason: string | null, nowMs: number): BlocklistRecord {
    if (!["author", "phone", "keyword"].includes(kind)) {
      throw StoreError.invalidArgument(`invalid blocklist kind '${kind}'`);
    }
    const trimmed = value.trim();
    if (trimmed === "") throw StoreError.invalidArgument("blocklist value cannot be empty");

    const existing =
      radarId !== null
        ? (this.db
            .prepare("SELECT * FROM blocklist WHERE kind = ?1 AND value = ?2 AND radar_id = ?3")
            .get(kind, trimmed, radarId) as Row | undefined)
        : (this.db
            .prepare("SELECT * FROM blocklist WHERE kind = ?1 AND value = ?2 AND radar_id IS NULL")
            .get(kind, trimmed) as Row | undefined);
    if (existing) return mapBlocklist(existing);

    const id = newUlid(nowMs);
    this.db
      .prepare("INSERT INTO blocklist (id, kind, value, radar_id, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(id, kind, trimmed, radarId, reason, nowMs);
    return mapBlocklist(this.db.prepare("SELECT * FROM blocklist WHERE id = ?1").get(id) as Row);
  }

  remove(blocklistId: string): boolean {
    return this.db.prepare("DELETE FROM blocklist WHERE id = ?1").run(blocklistId).changes > 0;
  }

  /** With a radar: global plus radar-specific entries; without: all entries. */
  list(radarId: string | null): BlocklistRecord[] {
    const rows =
      radarId !== null
        ? (this.db
            .prepare("SELECT * FROM blocklist WHERE radar_id IS NULL OR radar_id = ?1 ORDER BY created_at DESC")
            .all(radarId) as Row[])
        : (this.db.prepare("SELECT * FROM blocklist ORDER BY created_at DESC").all() as Row[]);
    return rows.map(mapBlocklist);
  }

  isBlocked(
    radarId: string | null,
    authorExternalIdOrId: string | null,
    phones: string[],
    textFold: string | null,
  ): boolean {
    return this.findMatching(radarId, authorExternalIdOrId, phones, textFold) !== null;
  }

  /** First matching global/radar-specific entry (`author`, `phone` or `keyword`). */
  findMatching(
    radarId: string | null,
    authorExternalIdOrId: string | null,
    phones: string[],
    textFold: string | null,
  ): BlocklistRecord | null {
    const entries = (
      radarId !== null
        ? (this.db
            .prepare("SELECT * FROM blocklist WHERE radar_id IS NULL OR radar_id = ?1")
            .all(radarId) as Row[])
        : (this.db.prepare("SELECT * FROM blocklist WHERE radar_id IS NULL").all() as Row[])
    ).map(mapBlocklist);
    if (entries.length === 0) return null;

    // Either the internal author id or the platform external id may be blocklisted.
    const authorCandidates = new Set<string>();
    const rawAuthor = trimmedOrNull(authorExternalIdOrId);
    if (rawAuthor !== null) {
      authorCandidates.add(rawAuthor);
      const rows = this.db
        .prepare("SELECT id, external_id FROM authors WHERE id = ?1 OR external_id = ?1")
        .all(rawAuthor) as Array<{ id: string; external_id: string | null }>;
      for (const r of rows) {
        authorCandidates.add(r.id);
        if (r.external_id !== null) authorCandidates.add(r.external_id);
      }
    }
    const foldedPost = textFold === null ? null : foldVi(textFold);

    for (const entry of entries) {
      switch (entry.kind) {
        case "author":
          if (authorCandidates.has(entry.value)) return entry;
          break;
        case "phone":
          if (phones.includes(entry.value)) return entry;
          break;
        case "keyword": {
          if (foldedPost !== null) {
            const kw = foldVi(entry.value);
            if (kw !== "" && foldedPost.includes(kw)) return entry;
          }
          break;
        }
        default:
          break;
      }
    }
    return null;
  }
}
