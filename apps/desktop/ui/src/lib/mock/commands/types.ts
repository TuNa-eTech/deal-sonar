// Shared handler types for mock Tauri commands.

type MockCommandHandler = (args: Record<string, unknown>) => Promise<unknown>;
export type MockCommandTable = Record<string, MockCommandHandler>;
