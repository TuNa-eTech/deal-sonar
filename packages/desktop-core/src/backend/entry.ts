import { loadBackendConfig, type Env } from "./config";
import { createDesktopServices } from "./services";
import type { ChromeProvisioning } from "../services/protocol-chrome";
import type { HostBindings } from "./host";
import { DesktopRuntime, type DesktopRuntimeDeps } from "./runtime";
import { BackendServer, type ParentPortLike } from "./server";
import { BACKEND_CONTROL, toWireError } from "./wire";

export interface StartBackendOptions {
  port: ParentPortLike;
  env: Env;
  /** Resolves the Host package bindings (dynamic import of `@dealsonar/native-host` in production). */
  loadHost: () => Promise<HostBindings>;
  loadProvisioning?: () => Promise<ChromeProvisioning>;
  platform?: NodeJS.Platform;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** Test/integration seams. */
  runtimeDeps?: Partial<Omit<DesktopRuntimeDeps, "config" | "host">>;
}

export interface StartedBackend {
  server: BackendServer;
  runtime: DesktopRuntime;
}

/**
 * Wire config -> runtime -> server and start. Any failure before the server exists (missing Host
 * module, unreadable env) is reported with `backend:fatal`, exactly like a runtime startup
 * failure, so the shell never waits out its 30 s timeout on a dead process.
 */
export async function startBackend(options: StartBackendOptions): Promise<StartedBackend | null> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const fatal = (err: unknown): null => {
    options.log?.(`backend startup failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      options.port.postMessage({ event: BACKEND_CONTROL.fatal, payload: toWireError(err) });
    } catch {
      /* parent already gone */
    }
    setTimeout(() => exit(1), 25);
    return null;
  };

  let runtime: DesktopRuntime;
  try {
    const host = await options.loadHost();
    const config = loadBackendConfig(options.env, host, options.platform);
    runtime = new DesktopRuntime({
      config,
      host,
      ...createDesktopServices(host, options.env, await options.loadProvisioning?.(), options.log),
      logger: options.log,
      ...options.runtimeDeps,
    });
  } catch (err) {
    return fatal(err);
  }

  const server = new BackendServer({ port: options.port, runtime, exit: options.exit, log: options.log });
  try {
    await server.start();
  } catch {
    // `server.start()` already pushed `backend:fatal` and scheduled the exit.
    return null;
  }
  return { server, runtime };
}
