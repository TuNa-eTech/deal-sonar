//! DealSonar Tauri v2 Desktop Shell (`apps/desktop`).
//!
//! Wires single-instance lock, structured rotating file logs, `CoreService` lifecycle,
//! Chrome Native Host auto-refresh, OS notifications, autostart sync, Vietnamese system tray,
//! hide-on-close window behavior, strict external URL opener, all 54+ Tauri IPC commands,
//! and real-time push events (`lead:new`, `lead:updated`, `preview:progress`,
//! `health:changed`, `crawl:finished`, `job:failed`).

pub mod commands;
pub mod logging;
pub mod security;
pub mod state;
pub mod tray;

use std::sync::Arc;

use dealsonar_core::{CoreEvent, OsNotification, OsNotificationHook};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::broadcast::error::RecvError;

use crate::security::{handle_webview_navigation, WEBVIEW_WINDOW_OPEN_BRIDGE_SCRIPT};
use crate::state::{
    is_minimized_startup, resolve_data_dir, resolve_native_host_binary_path, AutostartSyncHook,
    DesktopState,
};
use crate::tray::{
    format_tray_status_label, setup_system_tray, show_and_focus_main_window, ExitCoordinator,
    MAIN_WINDOW_LABEL,
};

/// Launches the Tauri v2 DealSonar desktop application (`03-desktop.md`).
pub fn run() {
    // Ensure Tauri's Tokio runtime context is entered on the main thread so any
    // background worker spawn, socket listener bind, or async primitives invoked
    // during startup or UI event loops have an active reactor context.
    let _runtime_guard = tauri::async_runtime::handle().inner().enter();

    let start_minimized = is_minimized_startup(std::env::args());
    let exit_coord = ExitCoordinator::new();
    let exit_coord_for_setup = exit_coord.clone();

    let builder = tauri::Builder::default()
        // 1. Single-instance lock (`03-desktop.md §2` Step 1): runs BEFORE `.setup(...)`,
        //    so a 2nd launch focuses the existing window and exits `0` before touching SQLite or `ipc.sock`.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_and_focus_main_window(app);
        }))
        // 2. Autostart (`--autostart` keeps window minimized to tray on OS login)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // 3. Native OS notifications (`07-notifications-export.md §4`)
        .plugin(tauri_plugin_notification::init())
        .on_page_load(|webview, payload| {
            tracing::info!(
                label = webview.label(),
                url = %payload.url(),
                event = ?payload.event(),
                "webview page load"
            );
        })
        .setup(move |app| {
            let _runtime_guard = tauri::async_runtime::handle().inner().enter();
            let app_handle = app.handle().clone();

            // Wire native OS notification hook (`07-notifications-export.md §4`)
            let notify_app = app_handle.clone();
            let os_hook: OsNotificationHook = Arc::new(move |notif: OsNotification| {
                let title = format!("DealSonar — {}", notif.radar_name);
                if let Err(err) = notify_app
                    .notification()
                    .builder()
                    .title(&title)
                    .body(&notif.summary)
                    .show()
                {
                    tracing::warn!(
                        lead_id = %notif.lead_id,
                        error = %err,
                        "failed to display native OS notification"
                    );
                }
            });

            // Initialize `DesktopState` (`CoreService`, rotating logs, SQLite WAL, IPC socket, manifest refresh)
            // inside `.setup(...)` so secondary instances never contend on `dealsonar.db` or `ipc.sock`.
            let data_dir = resolve_data_dir();
            let native_host_bin = resolve_native_host_binary_path();
            let state = DesktopState::open_production(data_dir, native_host_bin, Some(os_hook))
                .map_err(|err| Box::<dyn std::error::Error>::from(err.to_string()))?;
            app.manage(state.clone());

            // Wire autostart sync hook (`03-desktop.md §2.5`)
            let autostart_app = app_handle.clone();
            let autostart_hook: AutostartSyncHook = Arc::new(move |enabled: bool| {
                let mgr = autostart_app.autolaunch();
                if enabled {
                    mgr.enable().map_err(|e| e.to_string())
                } else {
                    mgr.disable().map_err(|e| e.to_string())
                }
            });
            state.set_autostart_sync_hook(Some(autostart_hook));

            if let Ok(settings) = state.core().settings_get() {
                state.sync_autostart(settings.launch_at_login);
            }

            // Build main WebView window with strict navigation & window.open guards (`03-risks-compliance.md §4`)
            let main_window = if let Some(win_cfg) = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW_LABEL)
                .or_else(|| app.config().app.windows.first())
            {
                WebviewWindowBuilder::from_config(&app_handle, win_cfg)?
            } else {
                WebviewWindowBuilder::new(
                    &app_handle,
                    MAIN_WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("DealSonar")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .center()
            }
            .visible(!start_minimized)
            .initialization_script(WEBVIEW_WINDOW_OPEN_BRIDGE_SCRIPT)
            .on_navigation(handle_webview_navigation)
            .build()?;

            if !start_minimized {
                let _ = main_window.set_focus();
            }

            // Set up Vietnamese System Tray (`03-desktop.md §2`)
            let status_menu_item =
                setup_system_tray(&app_handle, state.clone(), exit_coord_for_setup)?;

            // Forward all 6 `CoreEvent` variants to WebView & update tray status on `HealthChanged`
            let mut event_rx = state.core().subscribe_events();
            let emit_app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match event_rx.recv().await {
                        Ok(event) => {
                            if let CoreEvent::HealthChanged(ref health) = event {
                                let _ = status_menu_item.set_text(format_tray_status_label(health));
                            }
                            let _ = emit_app.emit(event.event_name(), event.to_payload_value());
                        }
                        Err(RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "desktop CoreEvent listener lagged");
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        // Hide-on-close (`03-desktop.md §2`): closing main window hides to tray instead of quitting
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::radar_list,
            commands::radar_get,
            commands::radar_create_draft,
            commands::radar_update,
            commands::radar_suggest_fields,
            commands::radar_set_status,
            commands::radar_preview_start,
            commands::radar_preview_get,
            commands::radar_stats,
            commands::template_list,
            commands::template_get,
            commands::source_list,
            commands::source_follow,
            commands::source_unfollow,
            commands::source_set_priority,
            commands::source_crawl_now,
            commands::lead_list,
            commands::lead_get,
            commands::lead_set_status,
            commands::lead_update_field,
            commands::lead_feedback,
            commands::lead_export,
            commands::post_get,
            commands::post_search,
            commands::evaluation_list_rejected,
            commands::contact_list,
            commands::contact_get,
            commands::contact_block,
            commands::contact_note,
            commands::blocklist_list,
            commands::blocklist_add,
            commands::blocklist_remove,
            commands::ruleset_list,
            commands::ruleset_save_user,
            commands::ruleset_compile_now,
            commands::settings_get,
            commands::settings_set,
            commands::ai_probe,
            commands::ai_set_provider,
            commands::telegram_set_token,
            commands::telegram_test,
            commands::channel_list,
            commands::channel_remove,
            commands::webhook_add,
            commands::chrome_connect,
            commands::license_get,
            commands::license_set,
            commands::health_get,
            commands::crawl_run_list,
            commands::ai_usage_get,
            commands::diagnostic_bundle_create,
            commands::data_backup,
            commands::data_purge,
            commands::data_delete_all,
            commands::open_external_url,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building DealSonar Tauri application");

    app.run(move |app_handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none()
                && !exit_coord.should_allow_exit()
                && app_handle.try_state::<DesktopState>().is_some()
            {
                api.prevent_exit();
                exit_coord.trigger_graceful_exit(app_handle.clone());
            }
        }
    });
}
