/**
 * Helper executable entry logic (`com.dealsonar.host`): relay by default, MCP with `--mcp`.
 * Chrome launches the helper with the caller origin as its first argument
 * (`chrome-extension://<id>/`, plus `--parent-window=…` on Windows); only a first argument of
 * exactly `--mcp` selects MCP mode, as in the Rust binary. Nothing but protocol frames / MCP
 * JSON may ever be written to stdout; diagnostics go to stderr.
 */
import type { Readable, Writable } from "node:stream";
import { relayConfigFromEnv, runRelay } from "./relay.js";
import { runMcp } from "./mcp.js";
import type { Env } from "./endpoint.js";

export interface CliIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: Env;
}

/**
 * `args` are the user-supplied arguments (without the executable and script/SEA entries).
 * Resolves to the process exit code.
 */
export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  const log = (message: string) => io.stderr.write(`dealsonar-native-host: ${message}\n`);

  if (args[0] === "--mcp") {
    try {
      await runMcp(io.stdin, io.stdout);
      return 0;
    } catch (error) {
      log(`MCP terminated with error: ${(error as Error).message}`);
      return 1;
    }
  }

  let config;
  try {
    config = relayConfigFromEnv(io.env);
  } catch (error) {
    log(`failed to resolve IPC endpoint: ${(error as Error).message}`);
    return 1;
  }
  try {
    await runRelay(io.stdin, io.stdout, config);
    return 0;
  } catch (error) {
    log(`relay terminated with error: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Extract user arguments from `process.argv` for plain Node and Node SEA launches.
 * Plain node: [node, script, ...args]. SEA: [exe, exe, ...args] (Node inserts the executable
 * path as argv[1]); tolerate a runtime that omits it by checking the entry's basename.
 */
export function userArgs(argv: readonly string[], execPath: string, sea: boolean = isSea()): string[] {
  if (!sea) return argv.slice(2);
  const second = argv[1];
  if (second !== undefined && sameExecutableName(second, execPath)) return argv.slice(2);
  return argv.slice(1);
}

/** True when running inside a Node single-executable application. */
export function isSea(): boolean {
  try {
    const sea = process.getBuiltinModule("node:sea") as { isSea(): boolean } | undefined;
    return sea?.isSea() ?? false;
  } catch {
    return false;
  }
}

function sameExecutableName(a: string, b: string): boolean {
  const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();
  return base(a) === base(b);
}
