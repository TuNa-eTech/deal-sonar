//! Contact and blocklist commands (`contact_*`, `blocklist_*`).

use super::*;

impl CoreService {
    // ========================================================================
    // 6. Contacts & Blocklist (`contact_*`, `blocklist_*`)
    // ========================================================================

    pub fn contact_list(&self, search: Option<&str>, limit: usize) -> CoreResult<Vec<Contact>> {
        let summaries = self.rt.store.contact_list(search, limit)?;
        let blocklist = self.rt.store.blocklist_list(None)?;

        Ok(summaries
            .into_iter()
            .map(|cs| contact_record_to_dto(&cs.contact, cs.lead_count, &blocklist))
            .collect())
    }

    pub fn contact_get(&self, id: &str) -> CoreResult<ContactDetail> {
        let detail = self
            .rt
            .store
            .contact_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;
        let blocklist = self.rt.store.blocklist_list(None)?;
        let contact_dto =
            contact_record_to_dto(&detail.contact, detail.leads.len() as i64, &blocklist);

        let mut leads = Vec::with_capacity(detail.leads.len());
        for item in &detail.leads {
            if let Some(dto) = load_lead_dto(&self.rt, &item.lead.id)? {
                leads.push(dto);
            }
        }

        Ok(ContactDetail {
            contact: contact_dto,
            leads,
        })
    }

    pub fn contact_block(
        &self,
        id: &str,
        reason: Option<&str>,
        radar_id: Option<&str>,
    ) -> CoreResult<ContactBlockResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let detail = self
            .rt
            .store
            .contact_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;

        let mut blocked_entries = Vec::new();
        for phone in &detail.contact.phones {
            let rec = self
                .rt
                .store
                .blocklist_add("phone", phone, radar_id, reason, now)?;
            blocked_entries.push(blocklist_record_to_dto(
                &rec,
                detail.contact.display_name.clone(),
            ));
        }
        for aid in &detail.contact.author_ids {
            let rec = self
                .rt
                .store
                .blocklist_add("author", aid, radar_id, reason, now)?;
            blocked_entries.push(blocklist_record_to_dto(
                &rec,
                detail.contact.display_name.clone(),
            ));
        }

        Ok(ContactBlockResult { blocked_entries })
    }

    pub fn contact_note(&self, id: &str, note: &str) -> CoreResult<Contact> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let note_opt = (!note.trim().is_empty()).then_some(note);
        let updated = self
            .rt
            .store
            .contact_note(id, note_opt, now)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "contact",
                id: id.to_string(),
            })?;
        let detail = self.rt.store.contact_get(id)?;
        let lead_count = detail.map(|d| d.leads.len() as i64).unwrap_or(0);
        let blocklist = self.rt.store.blocklist_list(None)?;
        Ok(contact_record_to_dto(&updated, lead_count, &blocklist))
    }

    pub fn blocklist_list(&self, radar_id: Option<&str>) -> CoreResult<Vec<BlocklistEntry>> {
        let entries = self.rt.store.blocklist_list(radar_id)?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let label = if e.kind == "author" {
                    self.rt
                        .store
                        .author_get(&e.value)
                        .ok()
                        .flatten()
                        .map(|a| a.name)
                } else {
                    None
                };
                blocklist_record_to_dto(&e, label)
            })
            .collect())
    }

    pub fn blocklist_add(
        &self,
        kind: BlocklistKind,
        value: &str,
        reason: Option<&str>,
        radar_id: Option<&str>,
    ) -> CoreResult<BlocklistEntry> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let rec = self
            .rt
            .store
            .blocklist_add(kind.as_str(), value, radar_id, reason, now)?;
        let label = if rec.kind == "author" {
            self.rt
                .store
                .author_get(&rec.value)
                .ok()
                .flatten()
                .map(|a| a.name)
        } else {
            None
        };
        Ok(blocklist_record_to_dto(&rec, label))
    }

    pub fn blocklist_remove(&self, id: &str) -> CoreResult<BlocklistRemoveResult> {
        self.ensure_not_shutting_down()?;
        let removed = self.rt.store.blocklist_remove(id)?;
        Ok(BlocklistRemoveResult { removed })
    }
}

pub(super) fn contact_record_to_dto(
    c: &dealsonar_store::models::ContactRecord,
    lead_count: i64,
    blocklist: &[dealsonar_store::models::BlocklistRecord],
) -> Contact {
    let is_blocked = blocklist.iter().any(|b| match b.kind.as_str() {
        "phone" => c.phones.iter().any(|p| p == &b.value),
        "author" => c.author_ids.iter().any(|a| a == &b.value),
        _ => false,
    });

    Contact {
        id: c.id.clone(),
        display_name: c
            .display_name
            .clone()
            .unwrap_or_else(|| "Liên hệ chưa rõ tên".to_string()),
        phones: c.phones.clone(),
        author_ids: c.author_ids.clone(),
        note: c.note.clone(),
        lead_count,
        is_blocked,
        created_at: c.created_at,
        updated_at: c.updated_at,
    }
}

pub(super) fn blocklist_record_to_dto(
    b: &dealsonar_store::models::BlocklistRecord,
    display_label: Option<String>,
) -> BlocklistEntry {
    BlocklistEntry {
        id: b.id.clone(),
        kind: BlocklistKind::from_db(&b.kind),
        value: b.value.clone(),
        display_label,
        radar_id: b.radar_id.clone(),
        reason: b.reason.clone(),
        created_at: b.created_at,
    }
}
