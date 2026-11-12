import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Chrome MV3 content scripts (`tap.js` in MAIN world and `content.js` in isolated world)
 * execute as classic scripts, NOT ES modules. Any shared Rollup chunk `import` statement
 * in a content script crashes at load time with SyntaxError.
 *
 * This plugin builds each content script in its own self-contained IIFE Rollup pass
 * with all imports inlined into `dist/tap.js` and `dist/content.js`.
 */
function buildSelfContainedContentScripts(): Plugin {
  const entries = [
    { name: "DealSonarTap", entry: "src/content/tap.ts", outFile: "tap.js" },
    { name: "DealSonarContent", entry: "src/content/index.ts", outFile: "content.js" },
  ];

  return {
    name: "dealsonar-mv3-content-scripts",
    apply: "build",
    async closeBundle() {
      for (const item of entries) {
        await build({
          root: rootDir,
          configFile: false,
          publicDir: false,
          logLevel: "warn",
          build: {
            outDir: resolve(rootDir, "dist"),
            emptyOutDir: false,
            target: "es2022",
            sourcemap: false,
            lib: {
              entry: resolve(rootDir, item.entry),
              name: item.name,
              formats: ["iife"],
              fileName: () => item.outFile,
            },
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          },
        });
      }
    },
  };
}

export default defineConfig({
  root: rootDir,
  plugins: [buildSelfContainedContentScripts()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        background: resolve(rootDir, "src/background/index.ts"),
        popup: resolve(rootDir, "src/popup/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
