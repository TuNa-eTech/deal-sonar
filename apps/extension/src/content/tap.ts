// MAIN world entry point (`manifest.json` -> `tap.js`, `run_at: "document_start"`).
// Intentionally exports nothing so Rollup emits a pure anonymous IIFE without globals.

import { installNetworkTap } from "./tap-core";

if (typeof window !== "undefined") {
  installNetworkTap(window);
}
