#!/usr/bin/env node
// Offline AI quality evaluator (`06-ai-bridge.md §8`); replaces `cargo run -p dealsonar-ai-bridge --bin eval`.
//
//   node packages/desktop-core/scripts/eval.mjs [--dataset <path.jsonl>] [--radar <radar.json>]
//        [--provider mock|claude|codex|agy] [--model <name>] [--tier fast|smart] [--batch-size <n>] [--json]
//
// Example (the BĐS golden set): see `eval:bds` in the root package.json.
import { runTool } from "./run-tool.mjs";

process.exitCode = await runTool("src/tools/eval-cli.ts", process.argv.slice(2));
