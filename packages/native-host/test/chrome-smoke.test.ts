/**
 * Installed-Chrome smoke test (opt-in: `pnpm --filter @dealsonar/native-host smoke:chrome`).
 *
 * Launches a real Chromium-family browser with a THROWAWAY `--user-data-dir`, loads the built
 * DealSonar extension unpacked (its manifest `key` pins the production extension id), registers the
 * native host ONLY inside that throwaway profile and expects the browser to start the helper and
 * deliver the extension's `hello` to a synthetic desktop. It never touches the user's default
 * Chrome profile, default NativeMessagingHosts directory, or (on Windows) the real HKCU key.
 *
 * Requirements: Chrome for Testing / Chromium (branded Chrome >= 137 ignores --load-extension),
 * `CHROME_BIN` pointing at it, a built extension (`pnpm ext:build` -> apps/extension/dist), and
 * macOS or Linux (Windows native-host lookup is registry-only, so it cannot be isolated; use the
 * isolated-key registry test instead).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bundleHost } from "../scripts/build-bundle.mjs";
import { DEFAULT_CHROME_EXTENSION_ID, HELPER_BASENAME } from "../src/constants.js";
import { installHelper } from "../src/install-helper.js";
import { DesktopIpcServer, type ExtensionConnection } from "../src/ipc.js";
import { connectChrome } from "../src/provision.js";
import { cleanupTmpDirs, isWindows, testEndpoint, tmpDir, waitFor } from "./helpers.js";

afterAll(cleanupTmpDirs);

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDist = path.resolve(here, "../../../apps/extension/dist");
const chromeBin = process.env.CHROME_BIN;
const enabled =
  process.env.DEALSONAR_CHROME_SMOKE === "1" &&
  !isWindows &&
  !!chromeBin &&
  fs.existsSync(chromeBin) &&
  fs.existsSync(path.join(extensionDist, "manifest.json"));

describe.skipIf(!enabled)("installed Chrome starts the helper through native messaging", () => {
  it("delivers the extension hello to the synthetic desktop", async () => {
    const root = tmpDir("dschrome");
    const profile = path.join(root, "profile");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(profile, { recursive: true });
    const endpoint = testEndpoint(root);

    // Helper: SEA binary when provided, otherwise a wrapper that runs the bundle with this node.
    const bundle = await bundleHost(path.join(root, "host.cjs"));
    const source = path.join(root, HELPER_BASENAME);
    const seaBin = process.env.DEALSONAR_NATIVE_HOST_TEST_BIN;
    if (seaBin) fs.copyFileSync(seaBin, source);
    else fs.writeFileSync(source, `#!/bin/sh\nexec "${process.execPath}" "${bundle}" "$@"\n`);
    const helper = installHelper({ sourcePath: source, destPath: path.join(dataDir, "bin", HELPER_BASENAME) }).path;

    // Register ONLY inside the throwaway profile (Chrome reads <user-data-dir>/NativeMessagingHosts).
    const manifestPath = path.join(profile, "NativeMessagingHosts", "com.dealsonar.host.json");
    const provisioned = await connectChrome({ helperPath: helper, manifestPath });
    expect(provisioned.manifest.allowed_origins).toContain(`chrome-extension://${DEFAULT_CHROME_EXTENSION_ID}/`);

    const received: Buffer[] = [];
    const connections: ExtensionConnection[] = [];
    const server = await DesktopIpcServer.bind({
      endpoint,
      onExtensionConnection: (c) => {
        connections.push(c);
        c.onFrame((f) => {
          received.push(f);
          const env = JSON.parse(f.toString("utf8"));
          if (env.type === "hello") {
            void c.sendEnvelope({
              v: 2,
              id: "01SMOKEHELLOOK00000000000",
              ts: Date.now(),
              reply_to: env.id,
              type: "hello.ok",
              payload: { desktop_version: "0.0.0-smoke", config_rev: 0 },
            });
          }
        });
      },
    });

    let browser: ChildProcess | null = null;
    try {
      browser = spawn(
        chromeBin!,
        [
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          "--disable-gpu",
          `--disable-extensions-except=${extensionDist}`,
          `--load-extension=${extensionDist}`,
          "about:blank",
        ],
        { env: { ...process.env, DEALSONAR_IPC_PATH: endpoint }, stdio: "ignore" },
      );
      await waitFor(
        () => received.some((f) => JSON.parse(f.toString("utf8")).type === "hello"),
        45_000,
        100,
      );
      const hello = received.map((f) => JSON.parse(f.toString("utf8"))).find((e) => e.type === "hello");
      expect(hello.v).toBe(2);
      expect(typeof hello.payload.profile_id).toBe("string");
    } finally {
      browser?.kill("SIGKILL");
      await server.close();
    }
  }, 90_000);
});
