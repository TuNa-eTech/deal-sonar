import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopConfig } from "./release-config.mjs";

test("without certificates the build stays ad-hoc/unsigned", () => {
  const c = buildDesktopConfig("1.2.3", {});
  assert.equal(c.version, "1.2.3");
  assert.equal(c.bundle.macOS.signingIdentity, "-");
  assert.equal(c.bundle.windows.certificateThumbprint, null);
  assert.deepEqual(c.bundle.externalBin, ["binaries/dealsonar-native-host"]);
});

test("a cloud/HSM signing command is passed through to Tauri", () => {
  const c = buildDesktopConfig("1.2.3", { WINDOWS_SIGN_COMMAND: 'trusted-signing-cli -e https://example "%1"' });
  assert.equal(c.bundle.windows.signCommand, 'trusted-signing-cli -e https://example "%1"');
  assert.equal(c.bundle.windows.certificateThumbprint, null);
});

test("certificates from the environment switch signing on", () => {
  const c = buildDesktopConfig("1.2.3", {
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example Co (ABCDE12345)",
    WINDOWS_CERTIFICATE_THUMBPRINT: "AB12CD34",
    WINDOWS_TIMESTAMP_URL: "https://ts.example.com",
  });
  assert.equal(c.bundle.macOS.signingIdentity, "Developer ID Application: Example Co (ABCDE12345)");
  assert.equal(c.bundle.windows.certificateThumbprint, "AB12CD34");
  assert.equal(c.bundle.windows.timestampUrl, "https://ts.example.com");
});
