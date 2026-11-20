// Bundled entry of the Electron backend (`dist/backend/main.cjs`), forked by the shell with
// `utilityProcess.fork`. Keep this file thin: everything testable lives in `entry.ts`.

import { hostBindingsFrom } from "./host";
import { startBackend } from "./entry";
import type { ParentPortLike } from "./server";

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (!parentPort) {
  process.stderr.write("dealsonar backend must run inside an Electron utilityProcess\n");
  process.exit(2);
} else {
  void startBackend({
    port: parentPort,
    env: process.env,
    loadHost: async () => {
      const mod = await import("@dealsonar/native-host");
      return hostBindingsFrom(mod as unknown as Parameters<typeof hostBindingsFrom>[0]);
    },
    // stderr is piped to the shell's log; never log secrets or request bodies here.
    log: (message) => process.stderr.write(`[backend] ${message}\n`),
  });
}
