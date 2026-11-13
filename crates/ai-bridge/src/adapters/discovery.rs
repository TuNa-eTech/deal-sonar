//! Automatic model discovery (`claude`, `codex`, `agy`, `mock`).

use super::*;

// ============================================================================
// Automatic Model Discovery (`claude`, `codex`, `agy`, `mock`)
// ============================================================================

pub(crate) fn user_home_dir(cfg: &CliAdapterConfig) -> Option<PathBuf> {
    for (k, v) in &cfg.extra_env {
        if (k == "HOME" || k == "USERPROFILE") && !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

pub(super) fn push_unique_model(list: &mut Vec<AiModelOption>, opt: AiModelOption) {
    let trimmed = opt.id.trim();
    if trimmed.is_empty() {
        return;
    }
    if !list.iter().any(|m| m.id == trimmed) {
        list.push(opt);
    }
}

/// Discovers available models for Claude Code CLI (`claude`) from:
/// 1. `~/.claude/cache/model-catalog/*.json` (`provider_alias_targets` + `catalog.config.models`)
/// 2. `~/.claude/settings.json` (`model` / `env.ANTHROPIC_MODEL`)
/// 3. Built-in fallback catalog when no local catalog cache exists.
pub fn discover_claude_models(
    cfg: &CliAdapterConfig,
    help_text: Option<&str>,
) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if let Some(home) = user_home_dir(cfg) {
        let catalog_dir = home.join(".claude").join("cache").join("model-catalog");
        if let Ok(entries) = std::fs::read_dir(&catalog_dir) {
            let mut candidates: Vec<(bool, u64, Value)> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let Some(cat) = val.get("catalog").and_then(Value::as_object) else {
                    continue;
                };
                if cat
                    .get("config")
                    .and_then(|c| c.get("models"))
                    .and_then(Value::as_array)
                    .is_none()
                {
                    continue;
                }
                let is_cc = cat.get("surface").and_then(Value::as_str) == Some("cc");
                let fetched_at = val.get("fetchedAt").and_then(Value::as_u64).unwrap_or(0);
                candidates.push((is_cc, fetched_at, val));
            }

            candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));

            if let Some((_, _, best_val)) = candidates.first() {
                if let Some(config_obj) = best_val
                    .get("catalog")
                    .and_then(|c| c.get("config"))
                    .and_then(Value::as_object)
                {
                    if let Some(aliases) = config_obj
                        .get("provider_alias_targets")
                        .and_then(Value::as_object)
                    {
                        let preferred_order = ["haiku", "sonnet", "opus", "fable"];
                        for &alias in &preferred_order {
                            if let Some(target_info) = aliases.get(alias) {
                                let target_default = target_info
                                    .get("default")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let tier = if alias == "haiku" {
                                    Some(ModelTier::Fast)
                                } else {
                                    Some(ModelTier::Smart)
                                };
                                let label = if target_default.is_empty() {
                                    format!("{alias} — Bí danh tự động")
                                } else {
                                    format!("{alias} — Bí danh tự động ({target_default})")
                                };
                                push_unique_model(
                                    &mut models,
                                    AiModelOption {
                                        id: alias.to_string(),
                                        label,
                                        recommended_tier: tier,
                                        source: "local_cli".to_string(),
                                    },
                                );
                            }
                        }
                    }

                    if let Some(arr) = config_obj.get("models").and_then(Value::as_array) {
                        for item in arr {
                            let Some(id) = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                            else {
                                continue;
                            };
                            let name = item
                                .get("name")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(id);
                            let short_name =
                                item.get("short_name").and_then(Value::as_str).unwrap_or("");
                            let desc = item
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .unwrap_or("");
                            let combined_lc =
                                format!("{id} {name} {short_name} {desc}").to_ascii_lowercase();
                            let tier =
                                if combined_lc.contains("haiku") || combined_lc.contains("fast") {
                                    Some(ModelTier::Fast)
                                } else {
                                    Some(ModelTier::Smart)
                                };
                            let label = if !desc.is_empty() {
                                format!("{name} ({id}) — {desc}")
                            } else if !name.eq_ignore_ascii_case(id) {
                                format!("{name} ({id})")
                            } else {
                                id.to_string()
                            };
                            push_unique_model(
                                &mut models,
                                AiModelOption {
                                    id: id.to_string(),
                                    label,
                                    recommended_tier: tier,
                                    source: "local_cli".to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }

        let settings_path = home.join(".claude").join("settings.json");
        if let Ok(raw) = std::fs::read_to_string(&settings_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(m) = val
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let tier = if m.to_ascii_lowercase().contains("haiku") {
                        Some(ModelTier::Fast)
                    } else {
                        Some(ModelTier::Smart)
                    };
                    push_unique_model(
                        &mut models,
                        AiModelOption {
                            id: m.to_string(),
                            label: format!("{m} (từ ~/.claude/settings.json)"),
                            recommended_tier: tier,
                            source: "local_cli".to_string(),
                        },
                    );
                }
            }
        }
    }

    if let Some(h) = help_text {
        for alias in ["haiku", "sonnet", "opus", "fable"] {
            if h.contains(&format!("'{alias}'")) {
                let tier = if alias == "haiku" {
                    Some(ModelTier::Fast)
                } else {
                    Some(ModelTier::Smart)
                };
                push_unique_model(
                    &mut models,
                    AiModelOption {
                        id: alias.to_string(),
                        label: format!("{alias} — Bí danh Claude ({alias})"),
                        recommended_tier: tier,
                        source: "local_cli".to_string(),
                    },
                );
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "haiku",
                "haiku — Claude Haiku mới nhất (Nhanh, tiết kiệm)",
                ModelTier::Fast,
            ),
            (
                "sonnet",
                "sonnet — Claude Sonnet mới nhất (Cân bằng, thông minh)",
                ModelTier::Smart,
            ),
            (
                "opus",
                "opus — Claude Opus mới nhất (Suy luận sâu)",
                ModelTier::Smart,
            ),
            (
                "claude-haiku-4-5-20251001",
                "Claude Haiku 4.5 (claude-haiku-4-5-20251001)",
                ModelTier::Fast,
            ),
            (
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6 (claude-sonnet-4-6)",
                ModelTier::Smart,
            ),
            (
                "claude-opus-4-6",
                "Claude Opus 4.6 (claude-opus-4-6)",
                ModelTier::Smart,
            ),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

/// Discovers available models for OpenAI Codex CLI (`codex`) from:
/// 1. `~/.codex/models_cache.json` (`models` array with `visibility == "list"`)
/// 2. `~/.codex/config.toml` (`model = "..."`)
/// 3. Built-in fallback catalog when no local cache exists.
pub fn discover_codex_models(cfg: &CliAdapterConfig) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if let Some(home) = user_home_dir(cfg) {
        let cache_path = home.join(".codex").join("models_cache.json");
        if let Ok(raw) = std::fs::read_to_string(&cache_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(arr) = val.get("models").and_then(Value::as_array) {
                    let has_list_vis = arr
                        .iter()
                        .any(|m| m.get("visibility").and_then(Value::as_str) == Some("list"));

                    for item in arr {
                        let vis = item
                            .get("visibility")
                            .and_then(Value::as_str)
                            .unwrap_or("list");
                        if has_list_vis && vis != "list" {
                            continue;
                        }
                        if !has_list_vis && vis == "hide" {
                            continue;
                        }

                        let Some(slug) = item
                            .get("slug")
                            .or_else(|| item.get("id"))
                            .or_else(|| item.get("name"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        else {
                            continue;
                        };
                        let display_name = item
                            .get("display_name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(slug);
                        let desc = item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");

                        let combined_lc =
                            format!("{slug} {display_name} {desc}").to_ascii_lowercase();
                        let tier = if combined_lc.contains("mini")
                            || combined_lc.contains("luna")
                            || combined_lc.contains("fast")
                            || combined_lc.contains("flash")
                            || combined_lc.contains("nano")
                            || combined_lc.contains("efficient")
                            || combined_lc.contains("easier")
                        {
                            Some(ModelTier::Fast)
                        } else {
                            Some(ModelTier::Smart)
                        };

                        let label = if !desc.is_empty() {
                            if display_name.eq_ignore_ascii_case(slug) {
                                format!("{slug} — {desc}")
                            } else {
                                format!("{display_name} ({slug}) — {desc}")
                            }
                        } else if !display_name.eq_ignore_ascii_case(slug) {
                            format!("{display_name} ({slug})")
                        } else {
                            slug.to_string()
                        };

                        push_unique_model(
                            &mut models,
                            AiModelOption {
                                id: slug.to_string(),
                                label,
                                recommended_tier: tier,
                                source: "local_cli".to_string(),
                            },
                        );
                    }
                }
            }
        }

        let config_toml = home.join(".codex").join("config.toml");
        if let Ok(raw) = std::fs::read_to_string(&config_toml) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') {
                    break;
                }
                if let Some(rest) = trimmed.strip_prefix("model") {
                    let rest = rest.trim_start();
                    if let Some(val_part) = rest.strip_prefix('=') {
                        let cleaned = val_part.trim().trim_matches('"').trim_matches('\'').trim();
                        if !cleaned.is_empty() {
                            let lc = cleaned.to_ascii_lowercase();
                            let tier = if lc.contains("mini") || lc.contains("luna") {
                                Some(ModelTier::Fast)
                            } else {
                                Some(ModelTier::Smart)
                            };
                            push_unique_model(
                                &mut models,
                                AiModelOption {
                                    id: cleaned.to_string(),
                                    label: format!("{cleaned} (từ ~/.codex/config.toml)"),
                                    recommended_tier: tier,
                                    source: "local_cli".to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "codex-mini-latest",
                "Codex Mini Latest (codex-mini-latest) — Nhanh, tiết kiệm",
                ModelTier::Fast,
            ),
            (
                "gpt-5-codex",
                "GPT-5 Codex (gpt-5-codex) — Suy luận & tạo bộ luật",
                ModelTier::Smart,
            ),
            ("o4-mini", "o4-mini — Nhanh, suy luận gọn", ModelTier::Fast),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

pub(super) fn is_valid_agy_model_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let has_sep = bytes.contains(&b'-') || bytes.contains(&b'.');
    has_sep
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

/// Parses `agy models` stdout (handling carriage-return spinner frames) into `AiModelOption` items.
pub fn parse_agy_models_stdout(stdout: &str) -> Vec<AiModelOption> {
    let mut models = Vec::new();
    for raw_line in stdout.lines() {
        let after_cr = raw_line.rsplit('\r').next().unwrap_or(raw_line).trim();
        if after_cr.is_empty() {
            continue;
        }
        let mut parts = after_cr.split_whitespace();
        let Some(id_tok) = parts.next() else {
            continue;
        };
        if !is_valid_agy_model_slug(id_tok) {
            continue;
        }
        let rest: String = parts.collect::<Vec<_>>().join(" ");
        let combined_lc = format!("{id_tok} {rest}").to_ascii_lowercase();
        let tier = if combined_lc.contains("flash")
            || id_tok.ends_with("-low")
            || combined_lc.contains("lite")
            || combined_lc.contains("mini")
        {
            Some(ModelTier::Fast)
        } else {
            Some(ModelTier::Smart)
        };
        let label = if !rest.is_empty() && !rest.eq_ignore_ascii_case(id_tok) {
            format!("{rest} ({id_tok})")
        } else {
            id_tok.to_string()
        };
        push_unique_model(
            &mut models,
            AiModelOption {
                id: id_tok.to_string(),
                label,
                recommended_tier: tier,
                source: "local_cli".to_string(),
            },
        );
    }
    models
}

/// Discovers available models for Antigravity CLI (`agy`) by running `agy models` when supported,
/// with a built-in fallback catalog when offline or uninstalled.
pub async fn discover_agy_models(
    cfg: &CliAdapterConfig,
    workdir: &Path,
    expanded_path: &std::ffi::OsStr,
    supports_models_subcommand: bool,
) -> Vec<AiModelOption> {
    let mut models = Vec::new();

    if supports_models_subcommand
        && resolve_binary_in_path(&cfg.binary_path, expanded_path).is_some()
    {
        if let Ok(out) = run_cli_subprocess(
            &cfg.binary_path,
            &["models".to_string()],
            None,
            workdir,
            expanded_path,
            &cfg.extra_env,
            Duration::from_secs(8).min(cfg.probe_timeout),
        )
        .await
        {
            if out.exit_code == 0 {
                models = parse_agy_models_stdout(&out.stdout);
            }
        }
    }

    if models.is_empty() {
        for (id, label, tier) in [
            (
                "gemini-3.8-flash-medium",
                "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)",
                ModelTier::Fast,
            ),
            (
                "gemini-3.8-flash-low",
                "Gemini 3.8 Flash (Low) (gemini-3.8-flash-low)",
                ModelTier::Fast,
            ),
            (
                "gemini-4-carbon-medium",
                "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)",
                ModelTier::Smart,
            ),
            (
                "gemini-4-carbon-high",
                "Gemini 4 Carbon (High) (gemini-4-carbon-high)",
                ModelTier::Smart,
            ),
            (
                "gemini-4-argon-medium",
                "Gemini 4 Argon (Medium) (gemini-4-argon-medium)",
                ModelTier::Smart,
            ),
            (
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6 (Thinking) (claude-sonnet-4-6)",
                ModelTier::Smart,
            ),
            (
                "gemini-2.5-flash",
                "Gemini 2.5 Flash (gemini-2.5-flash)",
                ModelTier::Fast,
            ),
            (
                "gemini-2.5-pro",
                "Gemini 2.5 Pro (gemini-2.5-pro)",
                ModelTier::Smart,
            ),
        ] {
            push_unique_model(
                &mut models,
                AiModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    recommended_tier: Some(tier),
                    source: "builtin".to_string(),
                },
            );
        }
    }

    models
}

pub fn discover_mock_models() -> Vec<AiModelOption> {
    vec![
        AiModelOption {
            id: "mock-fast-v1".to_string(),
            label: "Mock Fast v1 (mock-fast-v1)".to_string(),
            recommended_tier: Some(ModelTier::Fast),
            source: "builtin".to_string(),
        },
        AiModelOption {
            id: "mock-smart-v1".to_string(),
            label: "Mock Smart v1 (mock-smart-v1)".to_string(),
            recommended_tier: Some(ModelTier::Smart),
            source: "builtin".to_string(),
        },
    ]
}

/// Computes the best recommended `(fast, smart)` model IDs from a discovered model list.
pub fn recommended_models_for_provider(
    provider: ProviderId,
    models: &[AiModelOption],
) -> (Option<String>, Option<String>) {
    let find_preferred = |prefs: &[&str], tier: ModelTier| -> Option<String> {
        for &p in prefs {
            if let Some(found) = models.iter().find(|m| m.id == p) {
                return Some(found.id.clone());
            }
        }
        models
            .iter()
            .find(|m| m.recommended_tier == Some(tier))
            .or_else(|| models.first())
            .map(|m| m.id.clone())
    };

    match provider {
        ProviderId::ClaudeCli => (
            find_preferred(
                &["haiku", "claude-haiku-5-5", "claude-haiku-4-5-20251001"],
                ModelTier::Fast,
            ),
            find_preferred(
                &["sonnet", "claude-sonnet-5-5", "claude-sonnet-4-6"],
                ModelTier::Smart,
            ),
        ),
        ProviderId::CodexCli => (
            find_preferred(
                &["gpt-6-luna", "codex-mini-latest", "o4-mini"],
                ModelTier::Fast,
            ),
            find_preferred(
                &["gpt-6.1-sol", "gpt-5-codex", "gpt-6-astra"],
                ModelTier::Smart,
            ),
        ),
        ProviderId::AgyCli => (
            find_preferred(
                &[
                    "gemini-3.8-flash-medium",
                    "gemini-3.8-flash-low",
                    "gemini-2.5-flash",
                ],
                ModelTier::Fast,
            ),
            find_preferred(
                &[
                    "gemini-4-carbon-medium",
                    "gemini-4-argon-medium",
                    "gemini-2.5-pro",
                ],
                ModelTier::Smart,
            ),
        ),
        ProviderId::Mock => (
            find_preferred(&["mock-fast-v1"], ModelTier::Fast),
            find_preferred(&["mock-smart-v1"], ModelTier::Smart),
        ),
    }
}
