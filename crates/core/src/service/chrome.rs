//! Chrome extension pairing, native host manifest refresh, and crawl pause control.

use super::*;

pub(super) fn strip_origin_wrapper(id_or_origin: &str) -> &str {
    let trimmed = id_or_origin.trim();
    let no_scheme = trimmed
        .strip_prefix("chrome-extension://")
        .unwrap_or(trimmed);
    no_scheme.strip_suffix('/').unwrap_or(no_scheme)
}

pub(super) fn is_legacy_placeholder_ext_id(id_or_origin: &str) -> bool {
    strip_origin_wrapper(id_or_origin).eq_ignore_ascii_case(LEGACY_PLACEHOLDER_EXTENSION_ID)
}

/// Computes Chrome's deterministic path-based unpacked Extension ID for `dir`
/// (`crx_file::id_util::GenerateIdForPath`: SHA-256 of canonical path, first 16 bytes -> `'a'..'p'`),
/// allowing pre-reload unpacked installs from `apps/extension/dist` to connect seamlessly.
pub(super) fn compute_chrome_unpacked_extension_id(dir: &std::path::Path) -> Option<String> {
    let canonical = fs::canonicalize(dir).ok()?;
    let mut hasher = Sha256::new();

    #[cfg(not(windows))]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(canonical.as_os_str().as_bytes());
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let raw = canonical.to_string_lossy();
        let cleaned = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
        for unit in std::ffi::OsStr::new(cleaned).encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
    }

    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push(char::from(b'a' + (byte >> 4)));
        out.push(char::from(b'a' + (byte & 0x0f)));
    }
    Some(out)
}

/// Discovers local workspace unpacked extension IDs (`apps/extension/dist` and `apps/extension`)
/// when running from a developer checkout.
pub(super) fn discover_workspace_unpacked_extension_ids() -> Vec<String> {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(workspace_root) = manifest_dir.parent().and_then(std::path::Path::parent) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for rel in ["apps/extension/dist", "apps/extension"] {
        let candidate = workspace_root.join(rel);
        if candidate.is_dir() {
            if let Some(id) = compute_chrome_unpacked_extension_id(&candidate) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

impl CoreService {
    pub fn chrome_connect(
        &self,
        opts: Option<ChromeConnectOptions>,
    ) -> CoreResult<ChromeConnectResult> {
        self.ensure_not_shutting_down()?;
        let opts = opts.unwrap_or_default();
        let now = now_ms();

        if opts.resume_crawl {
            let resumed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if hub.crawl_paused {
                    hub.crawl_paused = false;
                    hub.crawl_pause_reason = None;
                    hub.facebook_session = FacebookSessionState::Ok;
                    true
                } else {
                    false
                }
            };
            if resumed {
                self.rt
                    .ipc_hub
                    .send_to_profile(None, &Envelope::new(Body::CrawlResume {}));
            }
        }

        let target_manifest_path = match &self.rt.config.chrome_manifest_path {
            Some(p) => p.clone(),
            None => chrome_manifest_path().map_err(|e| CoreError::Internal(e.to_string()))?,
        };

        let explicit_ext_id = opts
            .extension_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let existing_manifest = fs::read_to_string(&target_manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<NativeHostManifest>(&raw).ok());

        let stored_or_existing_ext_id = if explicit_ext_id.is_none() {
            self.rt
                .store
                .get_setting::<String>(CHROME_EXTENSION_ID_SETTING_KEY)?
                .filter(|s| !s.trim().is_empty() && !is_legacy_placeholder_ext_id(s))
                .or_else(|| {
                    existing_manifest.as_ref().and_then(|m| {
                        m.allowed_origins
                            .iter()
                            .find(|o| !is_legacy_placeholder_ext_id(o))
                            .cloned()
                    })
                })
        } else {
            None
        };

        let primary_ext_id = explicit_ext_id
            .or(stored_or_existing_ext_id.as_deref())
            .unwrap_or(DEFAULT_CHROME_EXTENSION_ID);

        let mut origins_to_allow: Vec<String> = vec![primary_ext_id.to_string()];
        if strip_origin_wrapper(primary_ext_id) != DEFAULT_CHROME_EXTENSION_ID {
            origins_to_allow.push(DEFAULT_CHROME_EXTENSION_ID.to_string());
        }
        if let Some(ref existing) = existing_manifest {
            for origin in &existing.allowed_origins {
                if !is_legacy_placeholder_ext_id(origin) {
                    origins_to_allow.push(origin.clone());
                }
            }
        }
        for dev_id in discover_workspace_unpacked_extension_ids() {
            origins_to_allow.push(dev_id);
        }

        let bin_path = self
            .rt
            .config
            .native_host_binary_path
            .clone()
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("/usr/local/bin/dealsonar-native-host"));

        let manifest = NativeHostManifest::new_with_origins(&origins_to_allow, &bin_path)
            .map_err(|e| CoreError::Validation(e.to_string()))?;
        let native_host_installed = verify_or_write_manifest(&target_manifest_path, &manifest)
            .map(|_| true)
            .unwrap_or(false);

        if self.rt.config.chrome_manifest_path.is_none() {
            for extra_path in secondary_chromium_manifest_paths() {
                let _ = verify_or_write_manifest(&extra_path, &manifest);
            }
        }

        if let Some(origin) = manifest.allowed_origins.first() {
            let clean_id = strip_origin_wrapper(origin);
            let _ = self
                .rt
                .store
                .set_setting(CHROME_EXTENSION_ID_SETTING_KEY, &clean_id.to_string());
        }

        let health = self.rt.emit_health_if_changed(now)?;
        let message = if health.extension_connected {
            "Đã kết nối thành công với DealSonar Chrome Extension".to_string()
        } else {
            "Đã cài đặt cấu hình Native Messaging cho Chrome; vui lòng mở tiện ích DealSonar trên trình duyệt".to_string()
        };

        Ok(ChromeConnectResult {
            native_host_installed,
            manifest_path: target_manifest_path.to_string_lossy().into_owned(),
            extension_connected: health.extension_connected,
            facebook_session: health.facebook_session,
            message,
        })
    }

    /// Startup check (`03-desktop.md §2`): if Chrome was previously paired (saved `chrome.extension_id`
    /// or existing `com.dealsonar.host.json`) and the manifest is missing or points to a stale
    /// `dealsonar-native-host` binary path after an app update/move, rewrite it automatically.
    ///
    /// Returns `Ok(true)` if the manifest file was created or updated, or `Ok(false)` if unchanged
    /// or if Chrome has never been paired yet.
    pub fn refresh_native_host_manifest_if_paired(&self) -> CoreResult<bool> {
        let target_manifest_path = match &self.rt.config.chrome_manifest_path {
            Some(p) => p.clone(),
            None => match chrome_manifest_path() {
                Ok(p) => p,
                Err(_) => return Ok(false),
            },
        };

        let existing_manifest = fs::read_to_string(&target_manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<NativeHostManifest>(&raw).ok());

        let raw_saved = self
            .rt
            .store
            .get_setting::<String>(CHROME_EXTENSION_ID_SETTING_KEY)?
            .filter(|s| !s.trim().is_empty());

        let was_paired = raw_saved.is_some() || existing_manifest.is_some();
        if !was_paired {
            return Ok(false);
        }

        let primary_ext_id = raw_saved
            .filter(|s| !is_legacy_placeholder_ext_id(s))
            .or_else(|| {
                existing_manifest.as_ref().and_then(|m| {
                    m.allowed_origins
                        .iter()
                        .find(|o| !is_legacy_placeholder_ext_id(o))
                        .cloned()
                })
            })
            .unwrap_or_else(|| DEFAULT_CHROME_EXTENSION_ID.to_string());

        let Some(bin_path) = self
            .rt
            .config
            .native_host_binary_path
            .clone()
            .or_else(|| std::env::current_exe().ok())
        else {
            return Ok(false);
        };

        let mut origins_to_allow: Vec<String> = vec![primary_ext_id.clone()];
        if strip_origin_wrapper(&primary_ext_id) != DEFAULT_CHROME_EXTENSION_ID {
            origins_to_allow.push(DEFAULT_CHROME_EXTENSION_ID.to_string());
        }
        if let Some(ref existing) = existing_manifest {
            for origin in &existing.allowed_origins {
                if !is_legacy_placeholder_ext_id(origin) {
                    origins_to_allow.push(origin.clone());
                }
            }
        }
        for dev_id in discover_workspace_unpacked_extension_ids() {
            origins_to_allow.push(dev_id);
        }

        let expected = NativeHostManifest::new_with_origins(&origins_to_allow, &bin_path)
            .map_err(|e| CoreError::Validation(e.to_string()))?;
        let updated = verify_or_write_manifest(&target_manifest_path, &expected)
            .map_err(|e| CoreError::Internal(e.to_string()))?;

        if self.rt.config.chrome_manifest_path.is_none() {
            for extra_path in secondary_chromium_manifest_paths() {
                let _ = verify_or_write_manifest(&extra_path, &expected);
            }
        }

        if let Some(origin) = expected.allowed_origins.first() {
            let clean_id = strip_origin_wrapper(origin);
            let _ = self
                .rt
                .store
                .set_setting(CHROME_EXTENSION_ID_SETTING_KEY, &clean_id.to_string());
        }

        Ok(updated)
    }

    /// Manually pause or resume extension crawling (`03-desktop.md §2` System Tray).
    /// Resuming is refused if `facebook_session` is not `Ok` (`02-extension.md §7`).
    pub fn set_crawl_paused(&self, paused: bool) -> CoreResult<HealthStatus> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();

        if paused {
            let changed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if !hub.crawl_paused {
                    hub.crawl_paused = true;
                    hub.crawl_pause_reason = Some(crate::dto::CrawlPauseReason::Manual);
                    true
                } else {
                    false
                }
            };
            if changed {
                self.rt.ipc_hub.send_to_profile(
                    None,
                    &Envelope::new(Body::CrawlPause {
                        until: None,
                        reason: "manual".to_string(),
                    }),
                );
            }
        } else {
            let changed = {
                let mut hub = self.rt.ipc_hub.state.lock().expect("ipc state lock");
                if hub.facebook_session != FacebookSessionState::Ok {
                    return Err(CoreError::Validation(
                        "Không thể tiếp tục quét khi phiên Facebook đang có sự cố".to_string(),
                    ));
                }
                if hub.crawl_paused {
                    hub.crawl_paused = false;
                    hub.crawl_pause_reason = None;
                    true
                } else {
                    false
                }
            };
            if changed {
                self.rt
                    .ipc_hub
                    .send_to_profile(None, &Envelope::new(Body::CrawlResume {}));
            }
        }

        self.rt.emit_health_if_changed(now)
    }

    /// Toggle manual crawl pause/resume (`03-desktop.md §2` System Tray).
    pub fn toggle_crawl_paused(&self) -> CoreResult<HealthStatus> {
        let currently_paused = self
            .rt
            .ipc_hub
            .state
            .lock()
            .expect("ipc state lock")
            .crawl_paused;
        self.set_crawl_paused(!currently_paused)
    }
}
