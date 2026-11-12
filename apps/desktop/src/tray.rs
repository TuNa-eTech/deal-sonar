//! Vietnamese System Tray menu, live status item & window visibility helpers (`03-desktop.md §2`).

use dealsonar_core::dto::{AiHealthState, FacebookSessionState, HealthStatus};
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::state::DesktopState;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const TRAY_ID: &str = "dealsonar-tray";

pub const MENU_ID_OPEN: &str = "open";
pub const MENU_ID_TOGGLE_PAUSE: &str = "toggle_pause";
pub const MENU_ID_STATUS: &str = "status";
pub const MENU_ID_QUIT: &str = "quit";

/// Formats the Vietnamese system tray status line from the current [`HealthStatus`].
pub fn format_tray_status_label(health: &HealthStatus) -> String {
    if health.crawl_paused {
        return "Trạng thái: Đang tạm dừng quét".to_string();
    }
    match health.facebook_session {
        FacebookSessionState::Checkpoint => {
            return "Trạng thái: Cần xác minh phiên Facebook".to_string();
        }
        FacebookSessionState::LoggedOut => {
            return "Trạng thái: Facebook đã đăng xuất".to_string();
        }
        FacebookSessionState::RateLimited => {
            return "Trạng thái: Đang giãn nhịp Facebook".to_string();
        }
        FacebookSessionState::Ok => {}
    }
    if matches!(health.ai_state, AiHealthState::Error) {
        return "Trạng thái: Lỗi kết nối AI CLI".to_string();
    }
    if !health.extension_connected {
        return "Trạng thái: Chờ kết nối tiện ích Chrome".to_string();
    }
    "Trạng thái: Sẵn sàng".to_string()
}

/// Un-minimizes, shows, and focuses the main DealSonar window (`03-desktop.md §2`).
pub fn show_and_focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Builds and registers the Vietnamese system tray icon and menu (`03-desktop.md §2`),
/// returning the live status [`MenuItem`] so `HealthChanged` events can update its text.
pub fn setup_system_tray<R: Runtime>(
    app: &AppHandle<R>,
    state: DesktopState,
) -> tauri::Result<MenuItem<R>> {
    let initial_status = state
        .core()
        .health_get()
        .map(|h| format_tray_status_label(&h))
        .unwrap_or_else(|_| "Trạng thái: Sẵn sàng".to_string());

    let open_item = MenuItem::with_id(app, MENU_ID_OPEN, "Mở DealSonar", true, None::<&str>)?;
    let toggle_pause_item = MenuItem::with_id(
        app,
        MENU_ID_TOGGLE_PAUSE,
        "Tạm dừng / Tiếp tục quét",
        true,
        None::<&str>,
    )?;
    let status_item = MenuItem::with_id(app, MENU_ID_STATUS, &initial_status, false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, "Thoát DealSonar", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open_item,
            &toggle_pause_item,
            &status_item,
            &separator,
            &quit_item,
        ])
        .build()?;

    let status_for_menu = status_item.clone();
    let state_for_menu = state.clone();

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("DealSonar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            MENU_ID_OPEN => {
                show_and_focus_main_window(app_handle);
            }
            MENU_ID_TOGGLE_PAUSE => match state_for_menu.core().toggle_crawl_paused() {
                Ok(health) => {
                    let _ = status_for_menu.set_text(format_tray_status_label(&health));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "tray toggle_crawl_paused rejected");
                }
            },
            MENU_ID_QUIT => {
                let app_for_quit = app_handle.clone();
                let state_for_quit = state_for_menu.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = state_for_quit.shutdown().await {
                        tracing::warn!(error = %err, "error during graceful shutdown");
                    }
                    app_for_quit.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    let _tray = tray_builder.build(app)?;
    Ok(status_item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dealsonar_core::dto::{CrawlPauseReason, TelegramHealthState};

    fn sample_health() -> HealthStatus {
        HealthStatus {
            extension_connected: true,
            extension_version: Some("0.1.0".to_string()),
            facebook_session: FacebookSessionState::Ok,
            crawl_paused: false,
            crawl_pause_reason: None,
            page_loads_last_hour: 2,
            page_loads_today: 10,
            ai_state: AiHealthState::Ok,
            ai_provider: None,
            ai_error: None,
            ai_rate_limit_reset_at: None,
            pending_ai_posts: 0,
            telegram_state: TelegramHealthState::NotConfigured,
            telegram_channel_count: 0,
            outbox_pending: 0,
            outbox_failed: 0,
            flood_radars: Vec::new(),
            checked_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn formats_vietnamese_tray_status_for_each_health_condition() {
        let mut h = sample_health();
        assert_eq!(format_tray_status_label(&h), "Trạng thái: Sẵn sàng");

        h.extension_connected = false;
        assert_eq!(
            format_tray_status_label(&h),
            "Trạng thái: Chờ kết nối tiện ích Chrome"
        );

        h.facebook_session = FacebookSessionState::Checkpoint;
        assert_eq!(
            format_tray_status_label(&h),
            "Trạng thái: Cần xác minh phiên Facebook"
        );

        h.crawl_paused = true;
        h.crawl_pause_reason = Some(CrawlPauseReason::Manual);
        assert_eq!(
            format_tray_status_label(&h),
            "Trạng thái: Đang tạm dừng quét"
        );
    }
}
