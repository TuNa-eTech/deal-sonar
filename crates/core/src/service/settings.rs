//! Settings and AI provider commands.

use super::*;

impl CoreService {
    // ========================================================================
    // 8. Settings, AI, Telegram, Channels, Webhook, Chrome, License
    // ========================================================================

    pub fn settings_get(&self) -> CoreResult<Settings> {
        self.rt.load_settings()
    }

    pub fn settings_set(&self, patch: SettingsPatch) -> CoreResult<Settings> {
        self.ensure_not_shutting_down()?;
        let mut settings = self.rt.load_settings()?;
        let mut crawl_changed = false;

        if let Some(v) = patch.privacy_consent_accepted {
            settings.privacy_consent_accepted = v;
        }
        if let Some(v) = patch.onboarding_completed {
            settings.onboarding_completed = v;
        }
        if let Some(v) = patch.launch_at_login {
            settings.launch_at_login = v;
        }
        let ai_config_changed = patch.ai_provider.is_some() || patch.model_tiers.is_some();
        if let Some(v) = patch.ai_provider {
            settings.ai_provider = v;
        }
        if let Some(v) = patch.model_tiers {
            settings.model_tiers = v;
        }
        if let Some(v) = patch.daily_ai_post_cap {
            settings.daily_ai_post_cap = v.max(1);
        }
        if let Some(v) = patch.default_notify_mode {
            settings.default_notify_mode = v;
        }
        if let Some(v) = patch.digest_interval_minutes {
            settings.digest_interval_minutes = v.max(1);
        }
        if let Some(v) = patch.quiet_hours_enabled {
            settings.quiet_hours_enabled = v;
        }
        if let Some(v) = patch.quiet_hours {
            settings.quiet_hours = v;
        }
        if let Some(v) = patch.os_notifications_enabled {
            settings.os_notifications_enabled = v;
        }
        if let Some(cp) = patch.crawl_policy {
            if let Some(v) = cp.group_interval_minutes {
                settings.crawl_policy.group_interval_minutes = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.priority_interval_minutes {
                settings.crawl_policy.priority_interval_minutes = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.hourly_page_load_budget {
                settings.crawl_policy.hourly_page_load_budget = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.daily_page_load_budget {
                settings.crawl_policy.daily_page_load_budget = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.active_hours {
                settings.crawl_policy.active_hours = v;
                crawl_changed = true;
            }
            if let Some(v) = cp.max_scroll_steps {
                settings.crawl_policy.max_scroll_steps = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.max_posts_per_visit {
                settings.crawl_policy.max_posts_per_visit = v.max(1);
                crawl_changed = true;
            }
            if let Some(v) = cp.only_when_idle {
                settings.crawl_policy.only_when_idle = v;
                crawl_changed = true;
            }
        }
        if let Some(v) = patch.unmatched_retention_days {
            settings.unmatched_retention_days = v.max(1);
        }
        if let Some(v) = patch.debug_keep_ai_io {
            settings.debug_keep_ai_io = v;
        }

        self.rt.save_settings(&settings)?;
        if ai_config_changed
            && self.rt.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock
        {
            if let Some(active_pid) = settings.ai_provider {
                let adapter =
                    build_cli_provider_for_settings(active_pid, &settings, &self.rt.config);
                self.rt.ai_bridge.set_provider(adapter);
            }
        }
        if crawl_changed {
            let _ = self.rt.bump_and_push_config()?;
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(settings)
    }

    pub async fn ai_probe(
        &self,
        provider: Option<AiProviderId>,
    ) -> CoreResult<BTreeMap<AiProviderId, ProbeResult>> {
        let mut settings = self.rt.load_settings()?;
        let default_settings = Settings::default();
        let mut settings_updated = false;
        let targets = match provider {
            Some(p) => vec![p],
            None => vec![
                AiProviderId::ClaudeCli,
                AiProviderId::CodexCli,
                AiProviderId::AgyCli,
            ],
        };

        let mut out = BTreeMap::new();
        for pid in targets {
            let raw_probe = if self.rt.ai_bridge.provider_id()
                == dealsonar_ai_bridge::ProviderId::Mock
                || self.rt.ai_bridge.provider_id() == pid.to_bridge_id()
            {
                self.rt.ai_bridge.probe().await
            } else {
                let adapter = build_cli_provider_for_settings(pid, &settings, &self.rt.config);
                adapter.probe().await
            };

            let bridge_models =
                if self.rt.ai_bridge.provider_id() == dealsonar_ai_bridge::ProviderId::Mock {
                    let cfg = CliAdapterConfig::new(pid.binary_name());
                    match pid {
                        AiProviderId::ClaudeCli => {
                            dealsonar_ai_bridge::discover_claude_models(&cfg, None)
                        }
                        AiProviderId::CodexCli => dealsonar_ai_bridge::discover_codex_models(&cfg),
                        AiProviderId::AgyCli => raw_probe.available_models.clone(),
                    }
                } else {
                    raw_probe.available_models.clone()
                };

            let (recommended_fast_model, recommended_smart_model) =
                dealsonar_ai_bridge::recommended_models_for_provider(
                    pid.to_bridge_id(),
                    &bridge_models,
                );

            let has_local_cli_models = bridge_models.iter().any(|m| m.source == "local_cli");
            if has_local_cli_models {
                if let (Some(cur_tier), Some(def_tier)) = (
                    settings.model_tiers.get_mut(&pid),
                    default_settings.model_tiers.get(&pid),
                ) {
                    if cur_tier.fast == def_tier.fast
                        && !bridge_models.iter().any(|m| m.id == cur_tier.fast)
                    {
                        if let Some(ref rec_f) = recommended_fast_model {
                            cur_tier.fast = rec_f.clone();
                            settings_updated = true;
                        }
                    }
                    if cur_tier.smart == def_tier.smart
                        && !bridge_models.iter().any(|m| m.id == cur_tier.smart)
                    {
                        if let Some(ref rec_s) = recommended_smart_model {
                            cur_tier.smart = rec_s.clone();
                            settings_updated = true;
                        }
                    }
                }
            }

            let available_models = bridge_models
                .into_iter()
                .map(|m| crate::dto::AiModelOption {
                    id: m.id,
                    label: m.label,
                    recommended_tier: m.recommended_tier.map(|t| match t {
                        BridgeModelTier::Fast => "fast".to_string(),
                        BridgeModelTier::Smart => "smart".to_string(),
                    }),
                    source: m.source,
                })
                .collect();

            out.insert(
                pid,
                ProbeResult {
                    provider: pid,
                    binary_name: pid.binary_name().to_string(),
                    installed: raw_probe.installed,
                    version: raw_probe.version,
                    authenticated: raw_probe.authenticated,
                    flags_supported: raw_probe.flags_supported,
                    latency_ms: raw_probe.latency_ms,
                    error: raw_probe.error,
                    install_hint: pid.install_hint().to_string(),
                    login_command: pid.login_command().to_string(),
                    available_models,
                    recommended_fast_model,
                    recommended_smart_model,
                },
            );
        }

        if settings_updated {
            let _ = self.rt.save_settings(&settings);
            if self.rt.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock {
                if let Some(active_pid) = settings.ai_provider {
                    let adapter =
                        build_cli_provider_for_settings(active_pid, &settings, &self.rt.config);
                    self.rt.ai_bridge.set_provider(adapter);
                }
            }
        }

        Ok(out)
    }

    pub fn ai_set_provider(
        &self,
        provider: AiProviderId,
        model_tiers: Option<ModelTierMap>,
    ) -> CoreResult<Settings> {
        self.ensure_not_shutting_down()?;
        let mut settings = self.rt.load_settings()?;
        settings.ai_provider = Some(provider);
        if let Some(tiers) = model_tiers {
            settings.model_tiers.insert(provider, tiers);
        }
        self.rt.save_settings(&settings)?;

        if self.rt.ai_bridge.provider_id() != dealsonar_ai_bridge::ProviderId::Mock {
            let adapter = build_cli_provider_for_settings(provider, &settings, &self.rt.config);
            self.rt.ai_bridge.set_provider(adapter);
        }

        {
            let mut ai_guard = self.rt.ai_health.lock().expect("ai health lock");
            ai_guard.last_error = None;
            ai_guard.first_unavailable_at = None;
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(settings)
    }
}

pub(super) fn build_cli_provider_for_settings(
    provider: AiProviderId,
    settings: &Settings,
    config: &CoreConfig,
) -> Arc<dyn AiProvider> {
    let mut bridge_tiers = BridgeModelTierMap::recommended_defaults();
    for (pid, tier_map) in &settings.model_tiers {
        let bpid = pid.to_bridge_id();
        bridge_tiers.set(bpid, BridgeModelTier::Fast, Some(tier_map.fast.clone()));
        bridge_tiers.set(bpid, BridgeModelTier::Smart, Some(tier_map.smart.clone()));
    }

    let workdir = config.data_dir.join("ai-workdir");
    let _ = fs::create_dir_all(&workdir);

    let cli_cfg = CliAdapterConfig::new(provider.binary_name())
        .with_model_tiers(bridge_tiers)
        .with_workdir(workdir);

    match provider {
        AiProviderId::ClaudeCli => Arc::new(ClaudeCliProvider::new(cli_cfg)),
        AiProviderId::CodexCli => Arc::new(CodexCliProvider::new(cli_cfg)),
        AiProviderId::AgyCli => Arc::new(AgyCliProvider::new(cli_cfg)),
    }
}
