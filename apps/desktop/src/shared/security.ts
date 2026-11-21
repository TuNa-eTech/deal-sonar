/**
 * Port of `apps/desktop/src/security.rs` (`validate_safe_external_url`). Messages are kept
 * identical so the UI shows the same text as the Tauri build.
 *
 * Only HTTPS Facebook permalinks (www/m/web) and `https://t.me/<bot>` setup links may be opened
 * in the OS browser. No credentials, no custom ports, no other schemes or hosts.
 */

const ALLOWED_FACEBOOK_HOSTS: ReadonlySet<string> = new Set([
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
]);

const TELEGRAM_BOT_PATH = /^\/[A-Za-z0-9_]{3,64}$/;

export type UrlCheck = { ok: true; url: URL } | { ok: false; message: string };

export function validateSafeExternalUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "Đường dẫn trống" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, message: "Đã chặn mở liên kết: định dạng URL không hợp lệ" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "Đã chặn mở liên kết: chỉ cho phép giao thức HTTPS" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "Đã chặn mở liên kết: không cho phép thông tin xác thực trong URL" };
  }
  if (parsed.port !== "") {
    return { ok: false, message: "Đã chặn mở liên kết: không cho phép cổng tuỳ chỉnh" };
  }
  if (parsed.hostname === "") {
    return { ok: false, message: "Đã chặn mở liên kết: thiếu tên miền" };
  }
  const isFacebook = ALLOWED_FACEBOOK_HOSTS.has(parsed.hostname);
  const isTelegramSetup = parsed.hostname === "t.me" && TELEGRAM_BOT_PATH.test(parsed.pathname);
  if (!isFacebook && !isTelegramSetup) {
    return {
      ok: false,
      message:
        "Đã chặn mở liên kết: đường dẫn không thuộc tên miền Facebook hợp lệ (https://www.facebook.com/).",
    };
  }
  return { ok: true, url: parsed };
}

/**
 * True when `target` is a page of the app itself. Everything else must never load inside the
 * app window; the caller may hand it to `validateSafeExternalUrl` and open it externally.
 *
 * Compares `protocol//host`, not `URL.origin`: custom schemes have the opaque origin "null".
 */
export function isInternalUrl(target: string, allowedPrefixes: readonly string[]): boolean {
  if (target === "about:blank") return true;
  try {
    const u = new URL(target);
    return allowedPrefixes.includes(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}
