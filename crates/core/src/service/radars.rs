//! Radar and radar template commands (`radar_*`, `template_*`).

use super::*;

impl CoreService {
    // ========================================================================
    // 1. Radars (`radar_*`)
    // ========================================================================

    pub fn radar_list(&self) -> CoreResult<Vec<Radar>> {
        let now = now_ms();
        let items = self.rt.store.radar_list(false, now)?;
        let flood_set = self.rt.get_flood_auto_digest_radars()?;

        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let stats = self.rt.store.radar_stats(Some(&item.radar.id), now)?;
            let is_flood = flood_set.contains(&item.radar.id);
            out.push(Radar {
                id: item.radar.id,
                name: item.radar.name,
                status: RadarStatus::from_db(&item.radar.status),
                template_id: item.radar.template_id,
                current_version: item.radar.current_version,
                source_ids: item.source_ids,
                notify: notify_from_store(&item.radar.notify),
                created_at: item.radar.created_at,
                updated_at: item.radar.updated_at,
                leads_24h: Some(item.leads_24h),
                false_positive_rate: Some(item.false_positive_rate),
                evaluated_posts_total: Some(item.evaluated_posts_total),
                rule_handled_pct: Some(stats.rule_handled_ratio * 100.0),
                auto_digest_flood: is_flood.then_some(true),
            });
        }
        Ok(out)
    }

    pub fn radar_get(&self, id: &str) -> CoreResult<RadarDetail> {
        let now = now_ms();
        let rw = self
            .rt
            .store
            .radar_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: id.to_string(),
            })?;
        self.build_radar_detail_dto(&rw, now)
    }

    pub fn radar_create_draft(&self, input: CreateRadarDraftInput) -> CoreResult<RadarDetail> {
        self.ensure_not_shutting_down()?;
        let (rw, now) = persist_radar_draft(&self.rt, input, None)?;
        self.build_radar_detail_dto(&rw, now)
    }

    pub fn radar_update(&self, input: UpdateRadarInput) -> CoreResult<RadarUpdateResult> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let existing = self
            .rt
            .store
            .radar_get(&input.id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: input.id.clone(),
            })?;

        if let Some(fields) = &input.fields {
            let license = self.rt.current_license_status(now)?;
            if fields.len() > license.limits.max_fields_per_radar {
                return Err(CoreError::LicenseLimitExceeded(format!(
                    "Current {:?} plan allows at most {} fields per radar (got {})",
                    license.plan,
                    license.limits.max_fields_per_radar,
                    fields.len()
                )));
            }
        }

        if input.fields.is_some() || input.match_policy.is_some() {
            let next_fields: Vec<_> = match &input.fields {
                Some(fs) => fs.iter().map(field_def_to_store).collect(),
                None => existing.current_version.fields.clone(),
            };
            let next_policy = match &input.match_policy {
                Some(mp) => match_policy_to_store(mp),
                None => existing.current_version.match_policy.clone(),
            };
            validate_store_match_policy(&next_policy, &next_fields)?;
        }

        // Case A: User is confirming an existing candidate version without additional field/description edits
        let no_def_edits = input.description.is_none()
            && input.user_profession.is_none()
            && input.fields.is_none()
            && input.match_policy.is_none();

        if input.confirm_version_upgrade == Some(true)
            && no_def_edits
            && existing.candidate_version.is_some()
        {
            let cand_ver = existing
                .candidate_version
                .as_ref()
                .expect("checked Some")
                .version;
            if input.name.is_some() || input.notify.is_some() || input.source_ids.is_some() {
                let next_notify = input.notify.as_ref().map(|patch| {
                    let cur = notify_from_store(&existing.radar.notify);
                    notify_to_store(&patch.apply_onto(&cur))
                });
                let _ = self.rt.store.radar_update(
                    &input.id,
                    &StoreUpdateRadarInput {
                        name: input.name.clone(),
                        notify: next_notify,
                        source_ids: input.source_ids.clone(),
                        description: None,
                        language_hint: None,
                        user_profession: None,
                        fields: None,
                        match_policy: None,
                        activate_immediately: true,
                        now_ms: now,
                    },
                )?;
            }

            let confirmed = self
                .rt
                .store
                .radar_confirm_version(&input.id, cand_ver, now)?;
            if confirmed.radar.status == "active" {
                let _ = self.rt.bump_and_push_config()?;
            }
            let detail = self.build_radar_detail_dto(&confirmed, now)?;
            return Ok(RadarUpdateResult {
                detail,
                created_new_version: false,
                requires_confirmation: false,
            });
        }

        let next_notify = input.notify.as_ref().map(|patch| {
            let cur = notify_from_store(&existing.radar.notify);
            notify_to_store(&patch.apply_onto(&cur))
        });
        let next_user_prof = match &input.user_profession {
            Some(opt) => opt.clone(),
            None => existing.current_version.user_profession.clone(),
        };
        let activate_immediately =
            existing.radar.status != "active" || input.confirm_version_upgrade == Some(true);

        let store_res = self.rt.store.radar_update(
            &input.id,
            &StoreUpdateRadarInput {
                name: input.name,
                notify: next_notify,
                source_ids: input.source_ids.clone(),
                description: input.description,
                language_hint: None,
                user_profession: input.user_profession.as_ref().map(|_| next_user_prof),
                fields: input
                    .fields
                    .as_ref()
                    .map(|fs| fs.iter().map(field_def_to_store).collect()),
                match_policy: input.match_policy.as_ref().map(match_policy_to_store),
                activate_immediately,
                now_ms: now,
            },
        )?;

        if store_res.radar.radar.status == "active" && input.source_ids.is_some() {
            let _ = self.rt.bump_and_push_config()?;
        }

        let detail = self.build_radar_detail_dto(&store_res.radar, now)?;
        Ok(RadarUpdateResult {
            detail,
            created_new_version: store_res.version_created.is_some(),
            requires_confirmation: store_res.pending_confirmation,
        })
    }

    pub async fn radar_suggest_fields(
        &self,
        input: SuggestFieldsInput,
    ) -> CoreResult<SuggestFieldsResult> {
        self.ensure_not_shutting_down()?;
        interpret_goal(&self.rt, input).await
    }

    pub async fn radar_set_status_from_desktop(
        &self,
        id: &str,
        status: RadarStatus,
        preview_id: Option<&str>,
    ) -> CoreResult<Radar> {
        if status == RadarStatus::Active {
            let radar = self.radar_get(id)?.radar;
            if radar.source_ids.is_empty() {
                return Err(CoreError::Validation("Hãy chọn ít nhất một nhóm cho radar.".into()));
            }
            if radar.status == RadarStatus::Draft {
                let preview_id = preview_id.ok_or_else(|| CoreError::Validation(
                    "Hãy xem thử bản nháp trước khi bật radar.".into()
                ))?;
                let preview = self.radar_preview_get(id, None)?;
                if preview.preview_id != preview_id
                    || preview.status != crate::dto::PreviewStatus::Done
                    || preview.total_posts == 0
                {
                    return Err(CoreError::Validation("Cần hoàn tất xem thử trên bài thật.".into()));
                }
            }
        }
        self.radar_set_status(id, status).await
    }

    pub async fn radar_set_status(&self, id: &str, status: RadarStatus) -> CoreResult<Radar> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let existing = self
            .rt
            .store
            .radar_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: id.to_string(),
            })?;

        let prev_status = RadarStatus::from_db(&existing.radar.status);
        if status == RadarStatus::Active && prev_status != RadarStatus::Active {
            let license = self.rt.current_license_status(now)?;
            if let Some(max_active) = license.limits.max_active_radars {
                let cur_active =
                    usize::try_from(self.rt.store.count_active_radars()?.max(0)).unwrap_or(0);
                if cur_active >= max_active {
                    return Err(CoreError::LicenseLimitExceeded(format!(
                        "Current {:?} plan allows at most {} active radars",
                        license.plan, max_active
                    )));
                }
            }
        }

        let _ = self.rt.store.radar_set_status(id, status.as_str(), now)?;
        if status == RadarStatus::Active {
            journey::record_first_activation(&self.rt.store, now)?;
        }
        // If transitioning `Paused -> Active` (`02-radar-spec.md §4`), backfill last 24h silently!
        if status == RadarStatus::Active && prev_status == RadarStatus::Paused {
            let refreshed = self.rt.store.radar_get(id)?.unwrap_or(existing);
            let _ = run_silent_backfill_24h(&self.rt, &refreshed, now).await?;
            self.rt.job_wake.notify_one();
        }

        let _ = self.rt.bump_and_push_config()?;
        let _ = self.rt.emit_health_if_changed(now)?;

        let detail = self.radar_get(id)?;
        Ok(detail.radar)
    }

    pub async fn radar_preview_start(
        &self,
        input: PreviewStartInput,
    ) -> CoreResult<PreviewRunState> {
        self.ensure_not_shutting_down()?;
        start_radar_preview(&self.rt, input).await
    }

    pub async fn radar_preview_cancel(
        &self,
        radar_id: &str,
        preview_id: &str,
    ) -> CoreResult<PreviewRunState> {
        cancel_radar_preview(&self.rt, radar_id, preview_id).await
    }

    pub fn radar_preview_get(
        &self,
        radar_id: &str,
        preview_id: Option<&str>,
    ) -> CoreResult<PreviewRunState> {
        get_radar_preview(&self.rt, radar_id, preview_id)
    }

    pub fn radar_stats(&self, radar_id: Option<&str>, days: u32) -> CoreResult<FunnelStats> {
        let now = now_ms();
        let s = self.rt.store.radar_stats(radar_id, now)?;
        Ok(FunnelStats {
            days: days.max(1),
            posts_captured: s.total_evaluated,
            dedup_dropped: s.dedup_rejected,
            prefilter_dropped: s.prefilter_rejected,
            rule_decided: s.rule_decided,
            rule_matched: s.rule_matched,
            ai_decided: s.ai_decided,
            ai_matched: s.ai_matched,
            leads_created: s.leads_total,
            leads_notified: s.leads_notified,
            leads_weak: s.leads_weak_match,
            false_positives: s.false_positive_count,
        })
    }

    pub(super) fn build_radar_detail_dto(
        &self,
        rw: &dealsonar_store::models::RadarWithVersion,
        now: i64,
    ) -> CoreResult<RadarDetail> {
        let stats = self.rt.store.radar_stats(Some(&rw.radar.id), now)?;
        let flood_set = self.rt.get_flood_auto_digest_radars()?;
        let is_flood = flood_set.contains(&rw.radar.id);
        let list_items = self.rt.store.radar_list(true, now)?;
        let list_meta = list_items.iter().find(|i| i.radar.id == rw.radar.id);

        let cur_ver_dto = radar_version_from_store(&rw.current_version);
        let cand_ver_dto = rw.candidate_version.as_ref().map(radar_version_from_store);

        let versions = self
            .rt
            .store
            .radar_versions(&rw.radar.id)?
            .iter()
            .map(radar_version_from_store)
            .collect();

        let radar_dto = Radar {
            id: rw.radar.id.clone(),
            name: rw.radar.name.clone(),
            status: RadarStatus::from_db(&rw.radar.status),
            template_id: rw.radar.template_id.clone(),
            current_version: rw.radar.current_version,
            source_ids: rw.source_ids.clone(),
            notify: notify_from_store(&rw.radar.notify),
            created_at: rw.radar.created_at,
            updated_at: rw.radar.updated_at,
            leads_24h: list_meta.map(|m| m.leads_24h),
            false_positive_rate: list_meta.map(|m| m.false_positive_rate),
            evaluated_posts_total: list_meta.map(|m| m.evaluated_posts_total),
            rule_handled_pct: Some(stats.rule_handled_ratio * 100.0),
            auto_digest_flood: is_flood.then_some(true),
        };

        Ok(RadarDetail {
            radar: radar_dto,
            current_version_data: cur_ver_dto,
            pending_version_data: cand_ver_dto,
            versions,
        })
    }

    // ========================================================================
    // 2. Templates (`template_*`)
    // ========================================================================

    pub fn template_list(&self) -> CoreResult<Vec<RadarTemplate>> {
        load_templates(self.rt.config.templates_dir.as_deref())
    }

    pub fn template_get(&self, id: &str) -> CoreResult<RadarTemplate> {
        get_template(id, self.rt.config.templates_dir.as_deref())
    }
}

pub(super) fn persist_radar_draft(
    rt: &CoreRuntime,
    input: CreateRadarDraftInput,
    id: Option<String>,
) -> CoreResult<(dealsonar_store::models::RadarWithVersion, i64)> {
    if input.name.trim().is_empty() {
        return Err(CoreError::Validation(
            "Radar name cannot be empty".to_string(),
        ));
    }
    if input.description.trim().is_empty() {
        return Err(CoreError::Validation(
            "Radar description cannot be empty".to_string(),
        ));
    }

    let now = monotonic_radar_now_ms();
    let license = rt.current_license_status(now)?;
    if input.fields.len() > license.limits.max_fields_per_radar {
        return Err(CoreError::LicenseLimitExceeded(format!(
            "Current {:?} plan allows at most {} fields per radar (got {})",
            license.plan,
            license.limits.max_fields_per_radar,
            input.fields.len()
        )));
    }

    let settings = rt.load_settings()?;
    let mut base_notify = RadarNotifyConfig {
        channel_ids: Vec::new(),
        inherit_channels: None,
        mode: settings.default_notify_mode,
        min_score: 0.6,
        quiet_hours: None,
        lead_ttl_hours: None,
    };
    if let Some(patch) = &input.notify {
        base_notify = patch.apply_onto(&base_notify);
    }

    // If `channel_ids` wasn't explicitly specified, default to all healthy channels so out-of-the-box alerts work seamlessly
    if input
        .notify
        .as_ref()
        .and_then(|n| n.channel_ids.as_ref())
        .is_none()
        && base_notify.inherit_channels.is_none()
    {
        let channels = rt.store.channel_list()?;
        base_notify.channel_ids = channels
            .into_iter()
            .filter(|c| c.state == "ok")
            .map(|c| c.id)
            .collect();
    }

    let store_fields: Vec<_> = input.fields.iter().map(field_def_to_store).collect();
    let store_policy = match_policy_to_store(&input.match_policy);
    validate_store_match_policy(&store_policy, &store_fields)?;
    let rw = rt.store.radar_create_draft(&StoreCreateRadarDraftInput {
        id,
        name: input.name.trim().to_string(),
        template_id: input.template_id.clone(),
        description: input.description,
        language_hint: input.language_hint.or_else(|| Some("vi".to_string())),
        user_profession: input.user_profession,
        fields: store_fields,
        match_policy: store_policy,
        source_ids: input.source_ids,
        notify: notify_to_store(&base_notify),
        now_ms: now,
    })?;

    // Auto-attach seed ruleset (`bds-vi-v1`) when creating from a template specifying it (`05-pipeline-rules.md §6.3`)
    if let Some(tid) = &input.template_id {
        if let Ok(tpl) = get_template(tid, rt.config.templates_dir.as_deref()) {
            if let Some(seed_name) = &tpl.seed_ruleset {
                if let Some(seed_body) = dealsonar_rules::seed_ruleset(seed_name) {
                    let _ = rt.store.insert_ruleset(&NewRulesetInput {
                        id: None,
                        radar_version_id: rw.current_version.id.clone(),
                        state: "active".to_string(),
                        origin: "seed".to_string(),
                        body: serde_json::to_value(&seed_body)?,
                        metrics: None,
                        now_ms: now,
                    })?;
                }
            }
        }
    }

    Ok((rw, now))
}
