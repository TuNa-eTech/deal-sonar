import legacyCommands from "../../../packages/desktop-core/test/fixtures/desktop-commands.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKEND_COMMANDS, RENDERER_EVENTS, SHELL_COMMANDS } from "../src/shared/contract";

const repo = join(__dirname, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

describe("command contract", () => {

  it("preserves the legacy desktop command names", () => {
    const ours = [...BACKEND_COMMANDS, ...SHELL_COMMANDS].sort();
    expect(ours).toEqual(legacyCommands);
    expect(new Set(ours).size).toBe(ours.length);
  });

  it("covers every command api.ts invokes", () => {
    const api = read("apps/desktop/ui/src/lib/api.ts");
    const used = new Set([...api.matchAll(/callCommand<[^>]*(?:<[^>]*>[^>]*)*>\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    const known = new Set<string>([...BACKEND_COMMANDS, ...SHELL_COMMANDS]);
    expect(used.size).toBeGreaterThan(40);
    for (const cmd of used) expect(known.has(cmd), cmd).toBe(true);
  });

  it("covers every push event in DesktopEventMap", () => {
    const types = read("apps/desktop/ui/src/types/ipc.ts");
    const body = types.slice(types.indexOf("export interface DesktopEventMap"));
    const events = [...body.slice(0, body.indexOf("}")).matchAll(/"([a-z:-]+)":/g)].map((m) => m[1]!);
    expect([...RENDERER_EVENTS].sort()).toEqual(events.sort());
  });
});
