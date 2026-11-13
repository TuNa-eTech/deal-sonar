// Mock Tauri command dispatcher used in browser dev mode and Vitest.

import { contactCommands } from "./commands/contacts";
import { dataCommands } from "./commands/data";
import { healthCommands } from "./commands/health";
import { leadCommands } from "./commands/leads";
import { postCommands } from "./commands/posts";
import { radarCommands } from "./commands/radars";
import { rulesetCommands } from "./commands/rulesets";
import { settingsCommands } from "./commands/settings";
import { sourceCommands } from "./commands/sources";
import { templateCommands } from "./commands/templates";
import type { MockCommandTable } from "./commands/types";
import { state } from "./store";

const MOCK_COMMANDS: MockCommandTable = {
  ...templateCommands,
  ...radarCommands,
  ...sourceCommands,
  ...leadCommands,
  ...postCommands,
  ...contactCommands,
  ...rulesetCommands,
  ...settingsCommands,
  ...healthCommands,
  ...dataCommands,
};

export async function invokeMockCommand<T>(
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  state.calls.push({ cmd, args: structuredClone(args), ts: Date.now() });

  if (!Object.hasOwn(MOCK_COMMANDS, cmd)) {
    throw new Error(`Lệnh Tauri chưa được hỗ trợ trong mockBackend: ${cmd}`);
  }
  return (await MOCK_COMMANDS[cmd]!(args)) as T;
}
