// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");

describe("MV3 Extension Build & Security Invariants", () => {
  beforeAll(async () => {
    if (!existsSync(resolve(distDir, "tap.js")) || !existsSync(resolve(distDir, "content.js"))) {
      await build({
        configFile: resolve(rootDir, "vite.config.ts"),
        logLevel: "warn",
      });
    }
  }, 30_000);

  it("enforces minimal MV3 permissions in `dist/manifest.json` (`02-extension.md §2` & P1–P5)", () => {
    const manifestRaw = readFileSync(resolve(distDir, "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      manifest_version: number;
      minimum_chrome_version: string;
      permissions: string[];
      host_permissions: string[];
      content_scripts: Array<{
        matches: string[];
        js: string[];
        world?: string;
        run_at: string;
      }>;
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("116");
    expect(manifest.permissions).toEqual([
      "nativeMessaging",
      "storage",
      "alarms",
      "tabs",
      "scripting",
      "idle",
    ]);
    expect(manifest.host_permissions).toEqual(["https://www.facebook.com/groups/*"]);

    // Forbidden invasive permissions MUST NEVER appear
    for (const forbidden of ["<all_urls>", "cookies", "webRequest", "webRequestBlocking", "debugger"]) {
      expect(manifest.permissions).not.toContain(forbidden);
      expect(manifest.host_permissions).not.toContain(forbidden);
    }

    expect(manifest.content_scripts).toEqual([
      {
        matches: ["https://www.facebook.com/groups/*"],
        js: ["tap.js"],
        world: "MAIN",
        run_at: "document_start",
      },
      {
        matches: ["https://www.facebook.com/groups/*"],
        js: ["content.js"],
        run_at: "document_idle",
      },
    ]);
  });

  it("bundles `dist/tap.js` and `dist/content.js` inline with ZERO ES module `import` or `export` statements", () => {
    const tapCode = readFileSync(resolve(distDir, "tap.js"), "utf-8");
    const contentCode = readFileSync(resolve(distDir, "content.js"), "utf-8");
    const bgCode = readFileSync(resolve(distDir, "background.js"), "utf-8");

    expect(tapCode.length).toBeGreaterThan(200);
    expect(contentCode.length).toBeGreaterThan(500);
    expect(bgCode.length).toBeGreaterThan(500);

    // Match top-level or bundled ESM import/export statements
    const esmImportRegex = /(?:^|[;\n\r])\s*import\s*(?:[\w*{]|["'(])/;
    const dynamicImportRegex = /\bimport\s*\(/;
    const esmExportRegex = /(?:^|[;\n\r])\s*export\s*(?:\{|default|const|let|var|function|class|\*)/;

    expect(tapCode).not.toMatch(esmImportRegex);
    expect(tapCode).not.toMatch(dynamicImportRegex);
    expect(tapCode).not.toMatch(esmExportRegex);

    expect(contentCode).not.toMatch(esmImportRegex);
    expect(contentCode).not.toMatch(dynamicImportRegex);
    expect(contentCode).not.toMatch(esmExportRegex);
  });
});
