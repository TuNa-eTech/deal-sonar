#!/usr/bin/env node
// Developer installer for the Chrome Native Messaging host. Entry of `scripts/install-native-host-dev.sh`
// and `scripts/install-native-host-dev.ps1`; see `src/tools/install-native-host-dev.ts`.
import path from "node:path";
import { packageRoot, runTool } from "./run-tool.mjs";

const repoRoot = path.resolve(packageRoot, "..", "..");
process.exitCode = await runTool("src/tools/install-native-host-dev.ts", process.argv.slice(2), { repoRoot });
