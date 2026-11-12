//! Desktop application state, OS data directory resolution, Native Host binary locator,
//! startup flag helpers, and autostart synchronization (`03-desktop.md §2`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use dealsonar_core::{CoreConfig, CoreResult, CoreService, CoreServiceBuilder, OsNotificationHook};
use dealsonar_protocol::ipc::{
    default_data_dir, resolve_ipc_endpoint, IpcEndpoint, DEALSONAR_IPC_PATH_ENV,
};
use tracing_appender::non_blocking::WorkerGuard;

use crate::logging::init_logging;

/// Callback invoked when `settings_set` updates `launch_at_login` so the Tauri shell
/// can synchronize `tauri-plugin-autostart` without coupling command handlers to `AppHandle`.
pub type AutostartSyncHook = Arc<dyn Fn(bool) -> Result<(), String> + Send + Sync>;

/// Returns `true` when CLI arguments include `--minimized` or `--autostart` (`03-desktop.md §2.5`),
/// keeping the main window hidden in the system tray on boot.
pub fn is_minimized_startup<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| {
        let s = arg.as_ref();
        s == "--minimized" || s == "--autostart"
    })
}

/// Resolves the DealSonar application data directory (`03-desktop.md §2`):
/// - `DEALSONAR_DATA_DIR` environment override (when set and non-empty),
/// - `~/Library/Application Support/DealSonar` on macOS,
/// - `%APPDATA%\DealSonar` on Windows,
/// - `~/.local/share/dealsonar` on Linux.
pub fn resolve_data_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("DEALSONAR_DATA_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    default_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("dealsonar"))
}

fn native_host_exe_name() -> &'static str {
    if cfg!(windows) {
        "dealsonar-native-host.exe"
    } else {
        "dealsonar-native-host"
    }
}

/// Smartly resolves the path to the `dealsonar-native-host` binary (`03-desktop.md §2.4`):
/// 1. `DEALSONAR_NATIVE_HOST_BIN` environment override (if set),
/// 2. Sibling of `std::env::current_exe()` (app bundle `Contents/MacOS/`, Windows installer dir, or `target/{debug,release}/`),
/// 3. Parent directory of `current_exe()` (when running inside `target/debug/deps/` during `cargo test`),
/// 4. Workspace `target/{debug,release}/dealsonar-native-host` fallback,
/// 5. Standard system fallback (`/usr/local/bin/dealsonar-native-host`).
pub fn resolve_native_host_binary_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("DEALSONAR_NATIVE_HOST_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let bin_name = native_host_exe_name();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let sibling = exe_dir.join(bin_name);
            if sibling.is_file() {
                return sibling;
            }
            // During `cargo test`, test binaries live in `target/debug/deps/<test>`
            if let Some(parent_dir) = exe_dir.parent() {
                let parent_sibling = parent_dir.join(bin_name);
                if parent_sibling.is_file() {
                    return parent_sibling;
                }
            }
        }
    }

    // Check workspace build directories relative to `CARGO_MANIFEST_DIR` in dev runs
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        for profile in ["debug", "release"] {
            let candidate = workspace_root.join("target").join(profile).join(bin_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    // Default to sibling path next to `current_exe()` even if not built yet so app bundles resolve predictably
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            return exe_dir.join(bin_name);
        }
    }

    if cfg!(windows) {
        PathBuf::from(bin_name)
    } else {
        PathBuf::from("/usr/local/bin").join(bin_name)
    }
}

/// Builds the default production `CoreConfig` rooted at `data_dir`.
pub fn build_core_config(data_dir: PathBuf, native_host_binary_path: PathBuf) -> CoreConfig {
    let logs_dir = data_dir.join("logs");
    let ipc_endpoint = if std::env::var_os(DEALSONAR_IPC_PATH_ENV).is_some() {
        resolve_ipc_endpoint().unwrap_or_else(|_| IpcEndpoint::from_path(data_dir.join("ipc.sock")))
    } else if !cfg!(windows)
        && std::env::var("DEALSONAR_DATA_DIR")
            .ok()
            .is_some_and(|s| !s.trim().is_empty())
    {
        IpcEndpoint::from_path(data_dir.join("ipc.sock"))
    } else {
        resolve_ipc_endpoint().unwrap_or_else(|_| IpcEndpoint::from_path(data_dir.join("ipc.sock")))
    };

    CoreConfig {
        data_dir,
        logs_dir: Some(logs_dir),
        ipc_endpoint: Some(ipc_endpoint),
        native_host_binary_path: Some(native_host_binary_path),
        ..CoreConfig::default()
    }
}

/// Shared Tauri managed state wrapping [`CoreService`], rotating log flusher, and autostart hook.
#[derive(Clone)]
pub struct DesktopState {
    core: Arc<CoreService>,
    data_dir: PathBuf,
    native_host_binary_path: PathBuf,
    log_guard: Arc<Mutex<Option<WorkerGuard>>>,
    autostart_sync: Arc<RwLock<Option<AutostartSyncHook>>>,
}

impl DesktopState {
    /// Opens a full production `DesktopState` (`03-desktop.md §2`):
    /// - Initializes structured rotating file logs in `<data_dir>/logs/` (pruning >7d logs),
    /// - Starts `CoreService` (SQLite WAL, IPC listener, background workers, OS notification hook),
    /// - Auto-refreshes Chrome Native Messaging Host manifest if previously paired and binary path changed.
    pub fn open_production(
        data_dir: PathBuf,
        native_host_binary_path: PathBuf,
        os_notify_hook: Option<OsNotificationHook>,
    ) -> CoreResult<Self> {
        let _runtime_guard = tauri::async_runtime::handle().inner().enter();
        let config = build_core_config(data_dir.clone(), native_host_binary_path.clone());
        let logs_dir = config
            .logs_dir
            .clone()
            .unwrap_or_else(|| data_dir.join("logs"));
        let guard = init_logging(&logs_dir).ok();

        let mut builder = CoreServiceBuilder::open_production(config)?;
        if let Some(hook) = os_notify_hook {
            builder = builder.with_os_notification_hook(hook);
        }
        let core = Arc::new(builder.start()?);

        match core.chrome_connect(None) {
            Ok(res) if res.native_host_installed => {
                tracing::info!(
                    manifest_path = %res.manifest_path,
                    "ensured Chrome Native Messaging Host manifest on startup"
                );
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "failed to ensure Chrome Native Messaging Host manifest on startup"
                );
            }
        }

        Ok(Self {
            core,
            data_dir,
            native_host_binary_path,
            log_guard: Arc::new(Mutex::new(guard)),
            autostart_sync: Arc::new(RwLock::new(None)),
        })
    }

    /// Opens a deterministic file-backed `DesktopState` for integration & E2E tests
    /// (`InMemorySecretStore` + `MockAiProvider`).
    pub fn open_for_test(
        config: CoreConfig,
        telegram_api_base_url: Option<String>,
        os_notify_hook: Option<OsNotificationHook>,
    ) -> CoreResult<Self> {
        let _runtime_guard = tauri::async_runtime::handle().inner().enter();
        let data_dir = config.data_dir.clone();
        let native_host_bin = config
            .native_host_binary_path
            .clone()
            .unwrap_or_else(resolve_native_host_binary_path);
        let logs_dir = config
            .logs_dir
            .clone()
            .unwrap_or_else(|| data_dir.join("logs"));
        let guard = init_logging(&logs_dir).ok();

        let mut builder = CoreServiceBuilder::open_for_test(config)?;
        if let Some(url) = telegram_api_base_url {
            builder = builder.with_telegram_api_base_url(url)?;
        }
        if let Some(hook) = os_notify_hook {
            builder = builder.with_os_notification_hook(hook);
        }
        let core = Arc::new(builder.start()?);

        let _ = core.refresh_native_host_manifest_if_paired();

        Ok(Self {
            core,
            data_dir,
            native_host_binary_path: native_host_bin,
            log_guard: Arc::new(Mutex::new(guard)),
            autostart_sync: Arc::new(RwLock::new(None)),
        })
    }

    /// Wraps an already-constructed [`CoreService`].
    pub fn from_core(
        core: Arc<CoreService>,
        data_dir: PathBuf,
        native_host_binary_path: PathBuf,
    ) -> Self {
        Self {
            core,
            data_dir,
            native_host_binary_path,
            log_guard: Arc::new(Mutex::new(None)),
            autostart_sync: Arc::new(RwLock::new(None)),
        }
    }

    pub fn core(&self) -> &Arc<CoreService> {
        &self.core
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn native_host_binary_path(&self) -> &Path {
        &self.native_host_binary_path
    }

    pub fn set_autostart_sync_hook(&self, hook: Option<AutostartSyncHook>) {
        *self.autostart_sync.write().expect("autostart hook lock") = hook;
    }

    /// Synchronizes `launch_at_login` with OS autostart (`tauri-plugin-autostart`),
    /// logging non-fatal errors (such as unbundled dev binaries) without failing `settings_set`.
    pub fn sync_autostart(&self, enabled: bool) {
        let hook = self
            .autostart_sync
            .read()
            .expect("autostart hook lock")
            .clone();
        if let Some(cb) = hook {
            if let Err(err) = cb(enabled) {
                tracing::warn!(
                    enabled,
                    error = %err,
                    "autostart synchronization skipped or unsupported in current environment"
                );
            }
        }
    }

    /// Gracefully shuts down `CoreService` (stops new jobs, waits up to 10s for AI,
    /// closes IPC & SQLite) and flushes rotating file logs.
    pub async fn shutdown(&self) -> CoreResult<()> {
        let res = self.core.shutdown().await;
        if let Ok(mut guard) = self.log_guard.lock() {
            let _ = guard.take();
        }
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimized_and_autostart_flags() {
        assert!(!is_minimized_startup(["dealsonar"]));
        assert!(is_minimized_startup(["dealsonar", "--minimized"]));
        assert!(is_minimized_startup(["dealsonar", "--autostart"]));
        assert!(!is_minimized_startup(["dealsonar", "--other"]));
    }
}
