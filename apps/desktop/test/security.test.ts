import { describe, expect, it } from "vitest";
import { isInternalUrl, validateSafeExternalUrl } from "../src/shared/security";

// Same cases as the Rust unit test in apps/desktop/src/security.rs.
describe("validateSafeExternalUrl (port of security.rs)", () => {
  it.each([
    "https://www.facebook.com/groups/123/posts/456/",
    "https://m.facebook.com/groups/123/permalink/456/",
    "https://web.facebook.com/groups/123/posts/456/",
    "https://t.me/DealSonarBot?start=dealsonar",
    "  https://www.facebook.com/groups/1/  ",
  ])("allows %s", (url) => {
    expect(validateSafeExternalUrl(url).ok).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "http://www.facebook.com/groups/123",
    "https://www.facebook.com.evil.example/groups/1",
    "https://facebook.com/groups/1",
    "https://user:pass@www.facebook.com/groups/1",
    "https://www.facebook.com:8443/groups/1",
    "https://t.me/s/channel/123",
    "https://t.me/ab",
    "https://evil.example/phish",
    "",
    "   ",
    "not a url",
  ])("blocks %j", (url) => {
    expect(validateSafeExternalUrl(url).ok).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(validateSafeExternalUrl(undefined).ok).toBe(false);
    expect(validateSafeExternalUrl({ toString: () => "https://www.facebook.com/" }).ok).toBe(false);
  });

  it("keeps the Vietnamese messages used by the Tauri build", () => {
    const r = validateSafeExternalUrl("http://www.facebook.com/x");
    expect(r).toEqual({ ok: false, message: "Đã chặn mở liên kết: chỉ cho phép giao thức HTTPS" });
    expect(validateSafeExternalUrl("")).toEqual({ ok: false, message: "Đường dẫn trống" });
  });
});

describe("isInternalUrl", () => {
  const prefixes = ["dealsonar-app://app", "http://localhost:1420"];
  it("accepts the app origin and dev server", () => {
    expect(isInternalUrl("dealsonar-app://app/index.html#inbox", prefixes)).toBe(true);
    expect(isInternalUrl("http://localhost:1420/", prefixes)).toBe(true);
    expect(isInternalUrl("about:blank", prefixes)).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isInternalUrl("https://evil.example/", prefixes)).toBe(false);
    expect(isInternalUrl("dealsonar-app://other/index.html", prefixes)).toBe(false);
    expect(isInternalUrl("http://localhost:9999/", prefixes)).toBe(false);
    expect(isInternalUrl("file:///etc/passwd", prefixes)).toBe(false);
    expect(isInternalUrl("javascript:alert(1)", prefixes)).toBe(false);
    expect(isInternalUrl("not a url", prefixes)).toBe(false);
  });
});
