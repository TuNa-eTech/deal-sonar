//! Chrome Native Messaging host manifest generation and path resolution (`03-desktop.md §2.2`).

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ipc::{default_data_dir_with, IpcPlatform};
use crate::NATIVE_HOST_NAME;

/// Default description placed in `com.dealsonar.host.json`.
pub const NATIVE_HOST_DESCRIPTION: &str = "DealSonar native host";

/// Manifest filename registered with Chrome (`com.dealsonar.host.json`).
pub const NATIVE_HOST_MANIFEST_FILENAME: &str = "com.dealsonar.host.json";

/// Windows registry key pointing to the manifest JSON file (`03-desktop.md §2.2`).
pub const WINDOWS_CHROME_REGISTRY_KEY: &str =
    r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host";

/// Errors produced when building or installing a Native Messaging host manifest.
#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("invalid Chrome extension ID '{0}': expected non-empty ASCII alphanumeric ID")]
    InvalidExtensionId(String),

    #[error("native host binary path must be absolute, got '{0}'")]
    RelativeBinaryPath(String),

    #[error("failed to resolve home/config directory: {0}")]
    MissingDirectory(&'static str),

    #[error("I/O error handling native host manifest: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error serializing native host manifest: {0}")]
    Json(#[from] serde_json::Error),
}

/// Chrome Native Messaging host manifest (`03-desktop.md §2.2`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeHostManifest {
    pub name: String,
    pub description: String,
    pub path: String,
    #[serde(rename = "type")]
    pub host_type: String,
    pub allowed_origins: Vec<String>,
}

/// Normalize and validate a Chrome extension ID (accepts either `<id>` or
/// `chrome-extension://<id>/`) and return the canonical origin `chrome-extension://<id>/`.
pub fn format_allowed_origin(extension_id_or_origin: &str) -> Result<String, ManifestError> {
    let trimmed = extension_id_or_origin.trim();
    let without_scheme = trimmed
        .strip_prefix("chrome-extension://")
        .unwrap_or(trimmed);
    let ext_id = without_scheme.strip_suffix('/').unwrap_or(without_scheme);

    if ext_id.is_empty() || !ext_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ManifestError::InvalidExtensionId(
            extension_id_or_origin.to_owned(),
        ));
    }

    Ok(format!("chrome-extension://{ext_id}/"))
}

fn is_absolute_for_any_os(path: &Path) -> bool {
    if path.is_absolute() {
        return true;
    }
    // Allow testing Windows absolute paths (`C:\...` or `\\...`) on Unix hosts.
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || s.starts_with(r"\\")
}

impl NativeHostManifest {
    /// Create a validated `com.dealsonar.host` stdio manifest for `extension_id` and
    /// an absolute `binary_path`.
    pub fn new(extension_id: &str, binary_path: impl AsRef<Path>) -> Result<Self, ManifestError> {
        Self::new_with_origins([extension_id], binary_path)
    }

    /// Create a validated `com.dealsonar.host` stdio manifest allowing multiple
    /// deduplicated Chrome extension origins (e.g. pinned manifest key ID + local unpacked ID).
    pub fn new_with_origins<I, S>(
        extension_ids_or_origins: I,
        binary_path: impl AsRef<Path>,
    ) -> Result<Self, ManifestError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let bin = binary_path.as_ref();
        if !is_absolute_for_any_os(bin) {
            return Err(ManifestError::RelativeBinaryPath(
                bin.to_string_lossy().into_owned(),
            ));
        }

        let mut allowed_origins = Vec::new();
        for item in extension_ids_or_origins {
            let origin = format_allowed_origin(item.as_ref())?;
            if !allowed_origins.contains(&origin) {
                allowed_origins.push(origin);
            }
        }

        if allowed_origins.is_empty() {
            return Err(ManifestError::InvalidExtensionId(String::new()));
        }

        Ok(Self {
            name: NATIVE_HOST_NAME.to_owned(),
            description: NATIVE_HOST_DESCRIPTION.to_owned(),
            path: bin.to_string_lossy().into_owned(),
            host_type: "stdio".to_owned(),
            allowed_origins,
        })
    }

    /// Pretty-printed JSON content with trailing newline ready to write to disk.
    pub fn to_json_pretty(&self) -> Result<String, ManifestError> {
        let mut out = serde_json::to_string_pretty(self)?;
        out.push('\n');
        Ok(out)
    }
}

/// Pure resolver for Chrome's `com.dealsonar.host.json` target file path (`03-desktop.md §2.2`).
///
/// - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json`
/// - Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts/com.dealsonar.host.json`
/// - Windows: `%APPDATA%\DealSonar\com.dealsonar.host.json` (pointed to by [`WINDOWS_CHROME_REGISTRY_KEY`])
pub fn chrome_manifest_path_with(
    platform: IpcPlatform,
    home_dir: Option<&Path>,
    xdg_config_home: Option<&Path>,
    appdata_dir: Option<&Path>,
) -> Result<PathBuf, ManifestError> {
    match platform {
        IpcPlatform::MacOs => {
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or(ManifestError::MissingDirectory("HOME"))?;
            Ok(home
                .join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome")
                .join("NativeMessagingHosts")
                .join(NATIVE_HOST_MANIFEST_FILENAME))
        }
        IpcPlatform::Linux => {
            let config_base =
                if let Some(xdg) = xdg_config_home.filter(|p| !p.as_os_str().is_empty()) {
                    xdg.to_path_buf()
                } else {
                    let home = home_dir
                        .filter(|p| !p.as_os_str().is_empty())
                        .ok_or(ManifestError::MissingDirectory("HOME"))?;
                    home.join(".config")
                };
            Ok(config_base
                .join("google-chrome")
                .join("NativeMessagingHosts")
                .join(NATIVE_HOST_MANIFEST_FILENAME))
        }
        IpcPlatform::Windows => {
            let data_dir = default_data_dir_with(IpcPlatform::Windows, home_dir, appdata_dir)
                .map_err(|_| ManifestError::MissingDirectory("APPDATA"))?;
            Ok(data_dir.join(NATIVE_HOST_MANIFEST_FILENAME))
        }
    }
}

/// Resolve the target Chrome `NativeMessagingHosts/com.dealsonar.host.json` file path for
/// the current OS (`03-desktop.md §2.2`).
pub fn chrome_manifest_path() -> Result<PathBuf, ManifestError> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let xdg_config = env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let appdata = env::var_os("APPDATA").map(PathBuf::from);

    chrome_manifest_path_with(
        IpcPlatform::current(),
        home.as_deref(),
        xdg_config.as_deref(),
        appdata.as_deref(),
    )
}

/// Resolve additional `NativeMessagingHosts/com.dealsonar.host.json` target paths for other
/// Chromium-based browsers that are ALREADY installed on the current macOS / Linux user account
/// (so users running DealSonar Extension in Chromium, Arc, Brave, Edge, Vivaldi, Opera, or Cốc Cốc
/// connect automatically without manual file copying).
pub fn secondary_chromium_manifest_paths() -> Vec<PathBuf> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    match IpcPlatform::current() {
        IpcPlatform::MacOs => {
            let app_support = home.join("Library").join("Application Support");
            let browser_roots: &[&[&str]] = &[
                &["Google", "Chrome Beta"],
                &["Google", "Chrome Canary"],
                &["Google", "Chrome Dev"],
                &["Google", "Chrome for Testing"],
                &["Google", "ChromeForTesting"],
                &["Chromium"],
                &["Arc", "User Data"],
                &["BraveSoftware", "Brave-Browser"],
                &["Microsoft Edge"],
                &["Vivaldi"],
                &["CocCoc", "Browser"],
                &["com.operasoftware.Opera"],
            ];
            for parts in browser_roots {
                let mut base = app_support.clone();
                for part in *parts {
                    base.push(part);
                }
                if base.is_dir() {
                    out.push(
                        base.join("NativeMessagingHosts")
                            .join(NATIVE_HOST_MANIFEST_FILENAME),
                    );
                }
            }
        }
        IpcPlatform::Linux => {
            let config_base = env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| home.join(".config"));
            for dir_name in [
                "google-chrome-beta",
                "google-chrome-unstable",
                "chromium",
                "BraveSoftware/Brave-Browser",
                "microsoft-edge",
                "vivaldi",
                "opera",
            ] {
                let base = config_base.join(dir_name);
                if base.is_dir() {
                    out.push(
                        base.join("NativeMessagingHosts")
                            .join(NATIVE_HOST_MANIFEST_FILENAME),
                    );
                }
            }
        }
        IpcPlatform::Windows => {}
    }

    out
}

/// Write `manifest` to `manifest_path`, creating parent directories as needed.
pub fn write_manifest_file(
    manifest_path: &Path,
    manifest: &NativeHostManifest,
) -> Result<(), ManifestError> {
    if let Some(parent) = manifest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let content = manifest.to_json_pretty()?;
    fs::write(manifest_path, content)?;
    Ok(())
}

/// Check if `manifest_path` already contains an identical `NativeHostManifest`; if missing,
/// unreadable, or pointing to an outdated path/origin, rewrite it (`03-desktop.md §2`).
///
/// Returns `Ok(true)` if the file was created or updated, or `Ok(false)` if already current.
pub fn verify_or_write_manifest(
    manifest_path: &Path,
    expected: &NativeHostManifest,
) -> Result<bool, ManifestError> {
    if let Ok(existing_raw) = fs::read_to_string(manifest_path) {
        if let Ok(existing) = serde_json::from_str::<NativeHostManifest>(&existing_raw) {
            if &existing == expected {
                return Ok(false);
            }
        }
    }
    write_manifest_file(manifest_path, expected)?;
    Ok(true)
}
