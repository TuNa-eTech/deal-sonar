//! External URL validation & safe browser opener (`03-risks-compliance.md §4`).
//!
//! Strictly permits opening only verified HTTPS Facebook permalinks
//! (`https://www.facebook.com/...`, `https://m.facebook.com/...`, `https://web.facebook.com/...`)
//! and first-party Telegram bot setup deep-links (`https://t.me/<bot_username>`), rejecting all
//! other origins, schemes (`javascript:`, `data:`, `file:`, `http:`), credentials, and custom ports.

use std::io;
use std::process::Command;

use url::Url;

const ALLOWED_FACEBOOK_HOSTS: &[&str] = &["www.facebook.com", "m.facebook.com", "web.facebook.com"];

/// Initialization script injected into the main Tauri WebView so `window.open(url, "_blank", ...)`
/// from `security.tsx` (`openFacebookPermalink` / `openSafeSetupUrl`) routes deterministically
/// through the Rust `open_external_url` command on macOS WKWebView, Windows WebView2, and Linux WebKitGTK.
pub const WEBVIEW_WINDOW_OPEN_BRIDGE_SCRIPT: &str = r#"
(function () {
  const origOpen = window.open;
  window.open = function (url, target, features) {
    if (typeof url === "string" && (!target || target === "_blank")) {
      const internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === "function") {
        internals.invoke("open_external_url", { url }).catch(function () {});
        return null;
      }
    }
    return origOpen ? origOpen.call(window, url, target, features) : null;
  };
})();
"#;

fn is_valid_telegram_bot_path(path: &str) -> bool {
    let Some(bot) = path.strip_prefix('/') else {
        return false;
    };
    let len = bot.len();
    (3..=64).contains(&len) && bot.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Validates that `raw` is a safe external URL permitted to open in the user's default OS browser.
pub fn validate_safe_external_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Đường dẫn trống".to_string());
    }

    let parsed = Url::parse(trimmed)
        .map_err(|_| "Đã chặn mở liên kết: định dạng URL không hợp lệ".to_string())?;

    if parsed.scheme() != "https" {
        return Err("Đã chặn mở liên kết: chỉ cho phép giao thức HTTPS".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Đã chặn mở liên kết: không cho phép thông tin xác thực trong URL".to_string());
    }
    if parsed.port().is_some() {
        return Err("Đã chặn mở liên kết: không cho phép cổng tuỳ chỉnh".to_string());
    }

    let Some(host) = parsed.host_str() else {
        return Err("Đã chặn mở liên kết: thiếu tên miền".to_string());
    };

    let is_facebook = ALLOWED_FACEBOOK_HOSTS.contains(&host) && parsed.path().starts_with('/');
    let is_telegram_setup = host == "t.me" && is_valid_telegram_bot_path(parsed.path());

    if !is_facebook && !is_telegram_setup {
        return Err(
            "Đã chặn mở liên kết: đường dẫn không thuộc tên miền Facebook hợp lệ (https://www.facebook.com/)."
                .to_string(),
        );
    }

    Ok(parsed)
}

/// Checks whether a WebView navigation request is an internal DealSonar app route.
/// External navigations are always blocked inside the WebView; if the target passes
/// [`validate_safe_external_url`], it is opened in the OS default browser instead.
pub fn handle_webview_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" | "about" => return true,
        "http" | "https" => {
            if let Some(host) = url.host_str() {
                if host == "tauri.localhost" || host == "ipc.localhost" {
                    return true;
                }
                #[cfg(debug_assertions)]
                if (host == "localhost" || host == "127.0.0.1") && url.port() == Some(5173) {
                    return true;
                }
            }
        }
        _ => {}
    }

    if let Ok(safe) = validate_safe_external_url(url.as_str()) {
        let _ = open_in_default_browser(&safe);
    } else {
        tracing::warn!(
            scheme = url.scheme(),
            host = url.host_str().unwrap_or("<none>"),
            "blocked untrusted WebView navigation"
        );
    }
    false
}

/// Opens a pre-validated external URL in the user's OS default browser.
/// Re-validates `url` as defense-in-depth before spawning any OS command.
pub fn open_in_default_browser(url: &Url) -> io::Result<()> {
    let validated = validate_safe_external_url(url.as_str())
        .map_err(|msg| io::Error::new(io::ErrorKind::PermissionDenied, msg))?;

    if std::env::var("DEALSONAR_DISABLE_BROWSER_SPAWN")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "TRUE"))
    {
        return Ok(());
    }

    let clean = validated.as_str();

    #[cfg(target_os = "macos")]
    {
        let _child = Command::new("open").arg(clean).spawn()?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let _child = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", clean])
            .spawn()?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _child = Command::new("xdg-open").arg(clean).spawn()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_strict_facebook_and_telegram_bot_urls_only() {
        assert!(
            validate_safe_external_url("https://www.facebook.com/groups/123/posts/456/").is_ok()
        );
        assert!(
            validate_safe_external_url("https://m.facebook.com/groups/123/permalink/456/").is_ok()
        );
        assert!(
            validate_safe_external_url("https://web.facebook.com/groups/123/posts/456/").is_ok()
        );
        assert!(validate_safe_external_url("https://t.me/DealSonarBot?start=dealsonar").is_ok());

        // Reject spoofed / dangerous URLs
        assert!(validate_safe_external_url("javascript:alert(1)").is_err());
        assert!(validate_safe_external_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(validate_safe_external_url("file:///etc/passwd").is_err());
        assert!(validate_safe_external_url("http://www.facebook.com/groups/123").is_err());
        assert!(
            validate_safe_external_url("https://www.facebook.com.evil.example/groups/1").is_err()
        );
        assert!(validate_safe_external_url("https://facebook.com/groups/1").is_err());
        assert!(validate_safe_external_url("https://user:pass@www.facebook.com/groups/1").is_err());
        assert!(validate_safe_external_url("https://www.facebook.com:8443/groups/1").is_err());
        assert!(validate_safe_external_url("https://t.me/s/channel/123").is_err());
        assert!(validate_safe_external_url("https://evil.example/phish").is_err());
    }
}
