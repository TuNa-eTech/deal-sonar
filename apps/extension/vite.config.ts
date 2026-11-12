import { defineConfig } from "vite";

// Multi-entry build: each entry becomes a stable, un-hashed file that
// manifest.json (copied from public/) can reference directly.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        popup: "src/popup/index.html",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
