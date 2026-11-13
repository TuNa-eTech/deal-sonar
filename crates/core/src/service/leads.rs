//! Lead commands (`lead_*`).

use super::*;

impl CoreService {
    // ========================================================================
    // 4. Leads (`lead_*`)
    // ========================================================================

    pub fn lead_list(&self, query: LeadFilterQuery) -> CoreResult<LeadListResponse> {
        let store_query = self.build_store_lead_query(&query)?;
        let page = self.rt.store.lead_list(&store_query)?;

        let mut items = Vec::with_capacity(page.items.len());
        for item in &page.items {
            if let Some(dto) = load_lead_dto(&self.rt, &item.lead.id)? {
                if query.include_weak == Some(false) && dto.is_weak_match {
                    continue;
                }
                items.push(dto);
            }
        }

        let total = page.total;
        Ok(LeadListResponse {
            items,
            total,
            next_cursor: page.next_cursor,
        })
    }

    pub fn lead_mark_read(&self, id: &str) -> CoreResult<LeadDetail> {
        self.rt.store.lead_mark_read(id, now_ms())?;
        let detail = self.lead_get(id)?;
        self.rt.emit(CoreEvent::LeadUpdated(detail.lead.clone()));
        Ok(detail)
    }

    pub fn lead_get(&self, id: &str) -> CoreResult<LeadDetail> {
        let detail = self
            .rt
            .store
            .lead_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "lead",
                id: id.to_string(),
            })?;

        let rw = self.rt.store.radar_get(&detail.lead.radar_id)?;
        let min_score = rw.as_ref().map(|r| r.radar.notify.min_score).unwrap_or(0.6);
        let ver = self
            .rt
            .store
            .radar_get_version(&detail.lead.radar_version_id)?;
        let radar_fields: Vec<_> = ver
            .as_ref()
            .map(|v| v.fields.iter().map(field_def_from_store).collect())
            .unwrap_or_default();

        let fb_map = self.rt.get_eval_feedback_labels()?;
        let feedback_label = fb_map
            .get(&detail.lead.evaluation_id)
            .and_then(|s| FeedbackLabel::from_db(s));

        let lead_dto = lead_detail_to_lead_dto(&detail, min_score, feedback_label);

        let post_rec = self
            .rt
            .store
            .post_get(&detail.lead.post_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "post",
                id: detail.lead.post_id.clone(),
            })?;
        let post_dto = post_detail_to_dto(&post_rec);

        let events = detail
            .events
            .iter()
            .map(|ev| LeadEvent {
                id: ev.id.clone(),
                lead_id: ev.lead_id.clone(),
                kind: ev.kind.clone(),
                data: ev.data.as_ref().and_then(|v| {
                    v.as_object()
                        .map(|m| m.iter().map(|(k, val)| (k.clone(), val.clone())).collect())
                }),
                created_at: ev.created_at,
            })
            .collect();

        Ok(LeadDetail {
            lead: lead_dto,
            post: post_dto,
            radar_fields,
            events,
        })
    }

    pub fn lead_set_status(
        &self,
        id: &str,
        status: LeadStatus,
        crm_patch: Option<LeadCrmPatch>,
    ) -> CoreResult<LeadDetail> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let existing = self
            .rt
            .store
            .lead_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "lead",
                id: id.to_string(),
            })?;

        self.rt.store.lead_set_status(id, status.as_str(), now)?;

        if let Some(patch) = crm_patch {
            if patch.note.is_some() || patch.tags.is_some() || patch.follow_up_at.is_some() {
                let next_note = match patch.note {
                    Some(n) => n,
                    None => existing.lead.note,
                };
                let next_tags = match patch.tags {
                    Some(t) => t,
                    None => Some(existing.lead.tags),
                };
                let next_followup = match patch.follow_up_at {
                    Some(f) => f,
                    None => existing.lead.follow_up_at,
                };
                self.rt.store.lead_set_note_tags_followup(
                    id,
                    next_note,
                    next_tags,
                    next_followup,
                    now,
                )?;
            }
        }

        let detail = self.lead_get(id)?;
        self.rt.emit(CoreEvent::LeadUpdated(detail.lead.clone()));
        Ok(detail)
    }

    pub fn lead_update_field(
        &self,
        id: &str,
        field_key: &str,
        value: Value,
        raw: Option<String>,
    ) -> CoreResult<LeadDetail> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        self.rt
            .store
            .lead_update_field(id, field_key, value, raw, now)?;
        let detail = self.lead_get(id)?;
        self.rt.emit(CoreEvent::LeadUpdated(detail.lead.clone()));
        Ok(detail)
    }

    pub fn lead_feedback(&self, input: LeadFeedbackInput) -> CoreResult<LeadFeedbackResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();

        if let Some(corrections) = &input.corrected_fields {
            let evaluation = self
                .rt
                .store
                .get_evaluation(&input.evaluation_id)?
                .ok_or_else(|| CoreError::Validation("Không tìm thấy đánh giá".into()))?;
            let version = self
                .rt
                .store
                .radar_get_version(&evaluation.radar_version_id)?
                .ok_or_else(|| CoreError::Validation("Không tìm thấy phiên bản radar".into()))?;
            for (key, value) in corrections {
                let field = version
                    .fields
                    .iter()
                    .find(|f| &f.key == key)
                    .ok_or_else(|| CoreError::Validation(format!("Trường không tồn tại: {key}")))?;
                dealsonar_store::field_values::validate_field_value(field, value)?;
            }
        }

        // Optional corrected_fields conversion
        let corrected_store = input.corrected_fields.as_ref().map(|map| {
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        StoreExtractedField {
                            value: v.clone(),
                            raw: None,
                            confidence: 1.0,
                            source: StoreFieldSource::User,
                        },
                    )
                })
                .collect::<BTreeMap<String, StoreExtractedField>>()
        });

        let fb_rec = self.rt.store.record_feedback(&RecordFeedbackInput {
            evaluation_id: input.evaluation_id.clone(),
            label: input.label.as_str().to_string(),
            corrected_fields: corrected_store,
            post_text: None,
            origin: input.origin.as_str().to_string(),
            now_ms: now,
        })?;
        self.rt
            .set_eval_feedback_label(&input.evaluation_id, input.label.as_str())?;

        // Apply `corrected_fields` onto the lead as `source = user` if `lead_id` is given
        if let (Some(lid), Some(corr)) = (&input.lead_id, &input.corrected_fields) {
            for (fkey, fval) in corr {
                let _ = self
                    .rt
                    .store
                    .lead_update_field(lid, fkey, fval.clone(), None, now);
            }
        }

        // Check immediate demote if negative feedback on rule-decided evaluation
        if input.label.is_negative() {
            if let Some(eval_rec) = self.rt.store.get_evaluation(&input.evaluation_id)? {
                let _ = handle_negative_feedback_on_rule_eval(&self.rt, &eval_rec, now)?;
            }
        }

        // If `label == Missed` on a rejected evaluation (`origin == App`), promote to Inbox lead silently
        let mut target_lead_id = input.lead_id.clone();
        let mut created_new_lead = false;
        if input.label == FeedbackLabel::Missed
            && input.origin == crate::dto::FeedbackOrigin::App
            && target_lead_id.is_none()
        {
            if let Some(ver) = self.rt.store.radar_get_version(&fb_rec.radar_version_id)? {
                let (created_lead, was_created) = self.rt.store.create_lead(&CreateLeadInput {
                    id: None,
                    radar_id: ver.radar_id,
                    radar_version_id: ver.id,
                    post_id: fb_rec.post_id.clone(),
                    evaluation_id: fb_rec.evaluation_id.clone(),
                    contact_id: None,
                    status: "new".to_string(),
                    score: 0.75,
                    summary: fb_rec.post_text.chars().take(120).collect::<String>(),
                    fields: BTreeMap::new(),
                    also_seen_in: None,
                    notified_at: None,
                    follow_up_at: None,
                    note: None,
                    tags: Some(Vec::new()),
                    now_ms: now,
                })?;
                target_lead_id = Some(created_lead.id);
                created_new_lead = was_created;
            }
        }

        // Optional `block_author` shortcut (`03-ux-flows.md §3`)
        let mut blocked_entry = None;
        if input.block_author == Some(true) {
            if let Some(post_detail) = self.rt.store.post_get(&fb_rec.post_id)? {
                if let Some(aid) = &post_detail.post.author_id {
                    let blk = self.rt.store.blocklist_add(
                        "author",
                        aid,
                        None,
                        Some("blocked_from_feedback"),
                        now,
                    )?;
                    blocked_entry = Some(blocklist_record_to_dto(&blk, post_detail.author_name));
                }
            }
        }

        let updated_lead = match &target_lead_id {
            Some(lid) => load_lead_dto(&self.rt, lid)?,
            None => None,
        };
        if let Some(l) = &updated_lead {
            if created_new_lead {
                self.rt.emit(CoreEvent::LeadNew(l.clone()));
            } else {
                self.rt.emit(CoreEvent::LeadUpdated(l.clone()));
            }
        }

        Ok(LeadFeedbackResult {
            feedback_id: fb_rec.id,
            updated_lead,
            blocked_entry,
        })
    }

    pub fn lead_export(&self, input: LeadExportInput) -> CoreResult<LeadExportResult> {
        let now = now_ms();
        if input.format == ExportFormat::Xlsx {
            let license = self.rt.current_license_status(now)?;
            if !license.limits.allow_xlsx_export {
                return Err(CoreError::LicenseLimitExceeded(
                    "XLSX export requires the Pro (Chuyên nghiệp) plan; CSV export is available on all plans".to_string(),
                ));
            }
        }

        let mut export_query = input.query.clone();
        export_query.limit = Some(500);
        export_query.cursor = None;
        let mut store_query = self.build_store_lead_query(&export_query)?;
        let mut page = self.rt.store.lead_list(&store_query)?;
        while let Some(cursor) = page.next_cursor.take() {
            store_query.cursor = Some(cursor);
            let next = self.rt.store.lead_list(&store_query)?;
            page.items.extend(next.items);
            page.next_cursor = next.next_cursor;
        }

        // Collect union of field definitions across matching radars (or specific radar)
        let notify_fields: Vec<dealsonar_notify::FieldDef> =
            if let Some(rid) = &input.query.radar_id {
                self.rt
                    .store
                    .radar_get(rid)?
                    .map(|rw| {
                        rw.current_version
                            .fields
                            .iter()
                            .map(field_def_store_to_notify)
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                let mut seen = HashSet::new();
                let mut defs = Vec::new();
                for r in self.rt.store.radar_list(true, now)? {
                    for f in &r.current_version.fields {
                        if seen.insert(f.key.clone()) {
                            defs.push(field_def_store_to_notify(f));
                        }
                    }
                }
                defs
            };

        let mut rows = Vec::with_capacity(page.items.len());
        for item in &page.items {
            if input.query.include_weak == Some(false) {
                let min_s = self
                    .rt
                    .store
                    .radar_get(&item.lead.radar_id)?
                    .map(|rw| rw.radar.notify.min_score)
                    .unwrap_or(0.6);
                if item.lead.score < min_s {
                    continue;
                }
            }
            rows.push(ExportLeadRow {
                post_created_at: item.post_created_at,
                radar_name: item.radar_name.clone(),
                status: item.lead.status.clone(),
                score: item.lead.score,
                summary: item.lead.summary.clone(),
                group_name: item.source_name.clone(),
                author_name: item
                    .author_name
                    .clone()
                    .unwrap_or_else(|| "Ẩn danh".to_string()),
                permalink: item.permalink.clone(),
                post_text: input
                    .include_post_text
                    .then(|| item.post_text.clone())
                    .flatten(),
                fields: extracted_fields_store_to_notify(&item.lead.fields),
            });
        }

        let export_opts = ExportOptions {
            include_post_text: input.include_post_text,
        };
        let bytes = match input.format {
            ExportFormat::Csv => export_csv(&export_opts, &notify_fields, &rows)?,
            ExportFormat::Xlsx => export_xlsx(&export_opts, &notify_fields, &rows)?,
        };

        let out_path = match &input.dest_path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => {
                let export_dir = self.rt.config.data_dir.join("exports");
                fs::create_dir_all(&export_dir)?;
                export_dir.join(format!("leads-{now}.{}", input.format.as_str()))
            }
        };
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(&out_path, &bytes)?;

        let content_preview = (input.format == ExportFormat::Csv).then(|| {
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(4_096)
                .collect()
        });

        Ok(LeadExportResult {
            path: out_path.to_string_lossy().into_owned(),
            format: input.format,
            row_count: rows.len(),
            content_preview,
        })
    }

    pub(super) fn build_store_lead_query(&self, q: &LeadFilterQuery) -> CoreResult<LeadListQuery> {
        let min_score = None;

        let filters = q
            .filters
            .as_ref()
            .map(|fs| {
                fs.iter()
                    .map(|f| StoreDynamicFilter {
                        field: f.field.clone(),
                        op: filter_op_to_store(f.op),
                        value: f.value.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let sort = q.sort.as_ref().map(|s| LeadSort {
            by: s.by.clone(),
            dir: if s.dir.eq_ignore_ascii_case("asc") {
                SortDir::Asc
            } else {
                SortDir::Desc
            },
        });

        Ok(LeadListQuery {
            unread_only: q.unread_only,
            follow_up_before: q.follow_up_before,
            exclude_weak: Some(q.include_weak == Some(false)),
            radar_id: q.radar_id.clone(),
            status: q
                .status
                .as_ref()
                .map(|sts| sts.iter().map(|st| st.as_str().to_string()).collect()),
            since: q.since,
            min_score,
            search: q.search.clone(),
            filters,
            sort,
            limit: q.limit.unwrap_or(50).clamp(1, 500),
            cursor: q.cursor.clone(),
        })
    }
}
