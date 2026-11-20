// Command handler registry. Each handler is a port of the matching arm of
// apps/desktop/src/commands/dispatch.rs + the `CoreService` method it calls, returning the exact
// JSON value the Tauri command returned. Commands without an entry answer `not_implemented`
// (see `unportedCommands`) so a missing port can never be mistaken for a successful no-op.

import { BACKEND_COMMANDS } from "./wire";
import type { HandlerTable } from "./runtime";

export const DEFAULT_HANDLERS: HandlerTable = {};

export function unportedCommands(handlers: HandlerTable = DEFAULT_HANDLERS): string[] {
  return BACKEND_COMMANDS.filter((c) => !handlers[c]);
}
