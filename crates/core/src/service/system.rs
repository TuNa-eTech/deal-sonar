//! License, health, diagnostics, workspace actions, and data lifecycle commands.

use super::*;

impl CoreService {
    pub fn license_get(&self) -> CoreResult<LicenseStatus> {
        self.rt.current_license_status(now_ms())
    }

    pub fn license_set(&self, license_key: &str) -> CoreResult<LicenseStatus> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let trimmed = license_key.trim();

        if trimmed.is_empty() {
            // Clear license -> revert to Personal plan and auto-pause excess active radars (`03-desktop.md §5`)
            self.rt.store.delete_setting(LICENSE_TOKEN_SETTING_KEY)?;
            let status = self.rt.current_license_status(now)?;
            let paused = enforce_plan_limits_on_store(&self.rt.store, &status.limits, now)?;
            if !paused.is_empty() {
                let _ = self.rt.bump_and_push_config()?;
            }
            return Ok(status);
        }

        // Verify cryptographic Ed25519 signature before storing
        let payload = self.rt.license_verifier.verify_token(trimmed)?;
        self.rt
            .store
            .set_setting(LICENSE_TOKEN_SETTING_KEY, &trimmed.to_string())?;

        let status = self.rt.current_license_status(now)?;
        let paused = enforce_plan_limits_on_store(&self.rt.store, &status.limits, now)?;
        if !paused.is_empty() || payload.expires_at.is_some_and(|exp| exp <= now) {
            let _ = self.rt.bump_and_push_config()?;
        }

        Ok(status)
    }

    // ========================================================================
    // 9. Health, Diagnostics & Data Lifecycle
    // ========================================================================

    pub fn health_get(&self) -> CoreResult<HealthStatus> {
        self.rt.compute_health_status(now_ms())
    }

    pub fn crawl_run_list(
        &self,
        source_id: Option<&str>,
        limit: usize,
    ) -> CoreResult<Vec<CrawlRun>> {
        let runs = self.rt.store.crawl_run_list(source_id, limit)?;
        Ok(runs.iter().map(|r| self.rt.crawl_run_to_dto(r)).collect())
    }

    pub fn ai_usage_get(&self, days: u32) -> CoreResult<AiUsageStats> {
        let now = now_ms();
        let settings = self.rt.load_settings()?;
        let today_items = self.rt.store.count_ai_items_today(now)?;
        let report = self.rt.store.ai_usage_get(days.max(1), now)?;

        let daily = report
            .days
            .into_iter()
            .map(|d| AiDailyUsageRow {
                date: d.date,
                calls: d.calls,
                items: d.items,
                input_tokens: d.input_tokens,
                output_tokens: d.output_tokens,
                cost_usd: (d.cost_usd > 0.0).then_some(d.cost_usd),
                ai_escalation_pct: d.ai_escalation_rate * 100.0,
            })
            .collect();

        Ok(AiUsageStats {
            today_items,
            daily_cap: settings.daily_ai_post_cap,
            total_calls: report.total_calls,
            total_items: report.total_items,
            total_input_tokens: report.total_input_tokens,
            total_output_tokens: report.total_output_tokens,
            total_cost_usd: report.total_cost_usd,
            avg_ai_escalation_pct: report.overall_ai_escalation_rate * 100.0,
            daily,
        })
    }

    pub fn diagnostic_bundle_create(&self) -> CoreResult<DiagnosticBundleResult> {
        let now = now_ms();
        let settings = self.rt.load_settings()?;
        let health = self.rt.compute_health_status(now)?;
        let diag_dir = self.rt.config.data_dir.join("diagnostics");
        fs::create_dir_all(&diag_dir)?;
        let dest_path = diag_dir.join(format!("dealsonar-diagnostics-{now}.zip"));

        // Gather active secrets in memory ONLY to scrub any accidental appearance in `.log` files
        let mut extra_secrets = Vec::new();
        if let Ok(Some(bot_tok)) = self.rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY) {
            extra_secrets.push(bot_tok);
        }
        if let Ok(Some(lic_tok)) = self
            .rt
            .store
            .get_setting::<String>(LICENSE_TOKEN_SETTING_KEY)
        {
            extra_secrets.push(lic_tok);
        }
        if let Ok(channels) = self.rt.store.channel_list() {
            for ch in channels {
                if ch.kind == "webhook" {
                    if let Ok(Some(sec)) = self.rt.secrets.get_secret(&webhook_channel_key(&ch.id))
                    {
                        extra_secrets.push(sec);
                    }
                }
            }
        }

        create_diagnostic_bundle(
            &self.rt.store,
            &health,
            &settings,
            self.rt.config.logs_dir.as_deref(),
            &dest_path,
            &extra_secrets,
            now,
        )
    }

    /// Workspace operations use the same domain boundary in WebView and contract tests.
    pub fn workspace_action(&self, action: &str, input: Value) -> CoreResult<Value> {
        self.ensure_not_shutting_down()?;
        match action {
            "backups" => {
                let dir = self.rt.config.data_dir.join("backups");
                let mut files = Vec::new();
                if dir.exists() {
                    for entry in fs::read_dir(dir)? {
                        let path = entry?.path();
                        if path.is_file()
                            && matches!(
                                path.extension().and_then(|s| s.to_str()),
                                Some("sqlite3" | "db")
                            )
                        {
                            files.push(path.to_string_lossy().into_owned());
                        }
                    }
                }
                files.sort();
                files.reverse();
                Ok(
                    serde_json::json!({"paths":files,"pending":self.rt.config.data_dir.join("restore-pending.sqlite3").exists()}),
                )
            }
            "restore" => {
                if input["confirm"].as_str() != Some("KHOI PHUC") {
                    return Err(CoreError::Validation("Nhập KHOI PHUC để xác nhận".into()));
                }
                let path = input["path"]
                    .as_str()
                    .ok_or_else(|| CoreError::Validation("Chọn tệp sao lưu".into()))?;
                Store::stage_restore(std::path::Path::new(path), &self.rt.config.data_dir)?;
                Ok(serde_json::json!({"restart_required":true}))
            }
            "restore_cancel" => {
                let path = self.rt.config.data_dir.join("restore-pending.sqlite3");
                if path.exists() {
                    fs::remove_file(path)?;
                }
                Ok(serde_json::json!({"cancelled":true}))
            }
            "rollback" => {
                let id = input["radar_id"]
                    .as_str()
                    .ok_or_else(|| CoreError::Validation("Thiếu radar".into()))?;
                let expected = input["expected_version"]
                    .as_i64()
                    .ok_or_else(|| CoreError::Validation("Thiếu phiên bản hiện tại".into()))?;
                let target = input["version"]
                    .as_i64()
                    .ok_or_else(|| CoreError::Validation("Chọn phiên bản".into()))?;
                let current = self.radar_get(id)?;
                if i64::from(current.radar.current_version) != expected {
                    return Err(CoreError::Validation(
                        "Radar đã thay đổi. Tải lại trước khi áp dụng.".into(),
                    ));
                }
                let version = current
                    .versions
                    .iter()
                    .find(|v| i64::from(v.version) == target)
                    .ok_or_else(|| CoreError::Validation("Phiên bản không thuộc radar".into()))?;
                // Publish the old definition as a new immutable version, keeping all history.
                let update: UpdateRadarInput = serde_json::from_value(
                    serde_json::json!({"id":id,"description":version.description,"user_profession":version.user_profession,"fields":version.fields,"match_policy":version.match_policy,"confirm_version_upgrade":true}),
                )?;
                let result = self.radar_update(update)?;
                let _ = self.rt.bump_and_push_config()?;
                Ok(serde_json::to_value(result.detail)?)
            }
            _ => Err(CoreError::Validation(
                "Thao tác workspace không được hỗ trợ".into(),
            )),
        }
    }

    pub fn data_backup(&self) -> CoreResult<DataBackupResult> {
        let now = now_ms();
        let backup_dir = self.rt.config.data_dir.join("backups");
        fs::create_dir_all(&backup_dir)?;
        let dest = backup_dir.join(format!("dealsonar-backup-{now}.sqlite3"));
        self.rt.store.backup_database(&dest)?;
        Ok(DataBackupResult {
            path: dest.to_string_lossy().into_owned(),
            created_at: now,
        })
    }

    pub fn data_purge(&self, unmatched_retention_days: Option<u32>) -> CoreResult<DataPurgeResult> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let days = match unmatched_retention_days {
            Some(d) => d,
            None => self.rt.load_settings()?.unmatched_retention_days,
        };
        let report = self.rt.store.purge_expired(now, days)?;
        let prev_cleaned = self
            .rt
            .store
            .cleanup_preview_evaluations(None, Some(now.saturating_sub(86_400_000)))?;
        Ok(DataPurgeResult {
            posts_purged: report.posts_purged,
            evaluations_cleaned: report.evaluations_scrubbed + prev_cleaned,
        })
    }

    pub fn data_delete_all(&self, confirm_phrase: &str) -> CoreResult<DataDeleteAllResult> {
        self.ensure_not_shutting_down()?;
        let normalized = dealsonar_store::models::fold_vi(confirm_phrase);
        if !matches!(normalized.trim(), "xoa toan bo" | "xoa tat ca") {
            return Err(CoreError::Validation(
                "Cụm xác nhận không khớp; vui lòng nhập đúng 'XOA TOAN BO'".to_string(),
            ));
        }

        // Collect webhook secret keys before wiping DB
        let existing_channels = self.rt.store.channel_list().unwrap_or_default();
        let pending_restore = self.rt.config.data_dir.join("restore-pending.sqlite3");
        if pending_restore.exists() {
            fs::remove_file(pending_restore)?;
        }
        self.rt.store.delete_all_data()?;

        let _ = self.rt.secrets.delete_secret(TELEGRAM_BOT_TOKEN_KEY);
        for ch in existing_channels {
            if ch.kind == "webhook" {
                let _ = self.rt.secrets.delete_secret(&webhook_channel_key(&ch.id));
            }
        }

        self.rt.clear_outbox_tracker_in_memory();
        self.rt.previews.lock().expect("previews lock").clear();
        self.rt
            .latest_preview_by_radar
            .lock()
            .expect("latest preview lock")
            .clear();

        let _ = self.rt.bump_and_push_config()?;
        let _ = self.rt.emit_health_if_changed(now_ms())?;

        Ok(DataDeleteAllResult { deleted: true })
    }
}
