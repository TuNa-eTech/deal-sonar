import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKEND_COMMANDS, RENDERER_EVENTS, SHELL_COMMANDS } from "../src/shared/contract";

const repo = join(__dirname, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

/**
 * The Rust shell is the behavior oracle until cutover: the allowlist must equal its
 * `tauri::generate_handler!` list, and cover every command the UI client can send.
 */
describe("command contract", () => {
  const rustHandlers = (() => {
    const src = read("apps/desktop/src/lib.rs");
    const block = src.slice(src.indexOf("generate_handler!["), src.indexOf("]);", src.indexOf("generate_handler![")));
    return [...block.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]!);
  })();

  it("equals the Tauri invoke_handler set", () => {
    const ours = [...BACKEND_COMMANDS, ...SHELL_COMMANDS].sort();
    expect(ours).toEqual([...rustHandlers].sort());
    expect(new Set(ours).size).toBe(ours.length);
  });

  it("covers every command api.ts invokes", () => {
    const api = read("apps/desktop/ui/src/lib/api.ts");
    const used = new Set([...api.matchAll(/callCommand<[^>]*(?:<[^>]*>[^>]*)*>\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    const known = new Set<string>([...BACKEND_COMMANDS, ...SHELL_COMMANDS]);
    expect(used.size).toBeGreaterThan(40);
    for (const cmd of used) expect(known.has(cmd), cmd).toBe(true);
  });

  it("covers every push event in TauriEventMap", () => {
    const types = read("apps/desktop/ui/src/types/ipc.ts");
    const body = types.slice(types.indexOf("export interface TauriEventMap"));
    const events = [...body.slice(0, body.indexOf("}")).matchAll(/"([a-z:-]+)":/g)].map((m) => m[1]!);
    expect([...RENDERER_EVENTS].sort()).toEqual(events.sort());
  });
});
