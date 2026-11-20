// Data-owner runtime of the Electron backend (`CoreServiceBuilder::open_production` + `start`).
//
// Startup order matches the Rust builder: prepare directories (data dir 0700, backups/, ai-workdir/,
// logs/), apply a staged restore *before* opening SQLite, open `dealsonar.db` (WAL, migrations,
// automatic pre-migration backup), wire the OS credential store, issue the agent token, then bind
// the local IPC endpoint through the Host package. Only after all that does the server push
// `backend:ready`.
//
import * as fs from "node:fs";

import { Store } from "../store/store";
import { type SecretStore, InMemorySecretStore, KEYRING_SERVICE } from "../secrets/types";
import { createOsSecretStore } from "../secrets/os-store";
import type { BackendConfig } from "./config";
import type {
  AgentMethodName,
  HostAgentBackend,
  HostBindings,
  HostExtensionConnection,
  HostIpcServer,
} from "./host";
import type { BackendRuntime, Emit } from "./server";
import { type Args, CoreError, type OsNotificationPayload, BACKEND_CONTROL } from "./wire";

/** Everything a command handler may touch. */
export interface RuntimeContext {
  readonly config: BackendConfig;
  readonly store: Store;
  readonly secrets: SecretStore;
  readonly emit: Emit;
  /** Show an OS notification through the shell (replaces Rust `OsNotificationHook`). */
  notifyOs(payload: OsNotificationPayload): void;
  isShuttingDown(): boolean;
}

export type CommandHandler = (ctx: RuntimeContext, args: Args) => Promise<unknown> | unknown;
export type HandlerTable = Partial<Record<string, CommandHandler>>;

export interface DesktopRuntimeDeps {
  config: BackendConfig;
  host: HostBindings;
  handlers?: HandlerTable;
  secrets?: SecretStore;
  /** Protocol v2 connection handler (ipc_server port). Default: refuse. */
  onExtensionConnection?: (ctx: RuntimeContext, connection: HostExtensionConnection) => void;
  /** Agent methods (list_radar_sources, prepare_radar, ...). Default: refuse. */
  agentBackend?: (ctx: RuntimeContext) => HostAgentBackend;
  onStarted?: (ctx: RuntimeContext) => void | Promise<void>;
  onStopping?: (ctx: RuntimeContext) => void | Promise<void>;
  logger?: (message: string) => void;
}

export class DesktopRuntime implements BackendRuntime {
  readonly version: string | undefined;
  private store: Store | null = null;
  private ipc: HostIpcServer | null = null;
  private emitFn: Emit = () => undefined;
  private shuttingDown = false;
  private ctx: RuntimeContext | null = null;

  constructor(private readonly deps: DesktopRuntimeDeps) {
    this.version = deps.config.appVersion ?? undefined;
  }

  private log(message: string): void {
    this.deps.logger?.(message);
  }

  get context(): RuntimeContext {
    if (!this.ctx) throw CoreError.internal("backend chưa khởi động");
    return this.ctx;
  }

  async start(emit: Emit): Promise<void> {
    const { config, host } = this.deps;
    this.emitFn = emit;

    prepareDataDirectories(config);
    // A staged restore replaces the database offline, before anything opens it.
    Store.applyPendingRestore(config.dbPath, config.backupDir);
    const store = Store.open(config.dbPath, config.backupDir);
    this.store = store;

    const secrets = this.deps.secrets ?? (config.inMemorySecrets
      ? new InMemorySecretStore()
      : createOsSecretStore({
        platform: config.platform,
        service: config.channel === "candidate" ? `${KEYRING_SERVICE} Candidate` : KEYRING_SERVICE,
      }));

    const ctx: RuntimeContext = {
      config,
      store,
      secrets,
      emit: (event, payload) => this.emitFn(event, payload),
      notifyOs: (payload) => this.emitFn(BACKEND_CONTROL.osNotification, payload),
      isShuttingDown: () => this.shuttingDown,
    };
    this.ctx = ctx;

    try {
      const agentToken = host.issueAgentToken(config.dataDir);
      const agentBackend = this.deps.agentBackend?.(ctx) ?? refusingAgentBackend(host);
      this.ipc = await host.bindIpcServer({
        endpoint: config.ipcEndpoint,
        agentToken,
        agentBackend,
        onExtensionConnection: (connection) => {
          if (this.deps.onExtensionConnection) this.deps.onExtensionConnection(ctx, connection);
          else {
            this.log("extension connection refused: protocol handler not available");
            connection.close();
          }
        },
        logger: (m) => this.log(m),
      });
      await this.deps.onStarted?.(ctx);
    } catch (err) {
      await this.shutdown().catch((cleanupError: unknown) => this.log(String(cleanupError)));
      throw err;
    }
  }

  async invoke(command: string, args: Args): Promise<unknown> {
    if (this.shuttingDown) throw CoreError.shuttingDown();
    const handler = this.deps.handlers?.[command];
    if (!handler) throw CoreError.notImplemented(command);
    return handler(this.context, args);
  }

  async toggleCrawlPaused(): Promise<unknown> {
    if (this.shuttingDown) throw CoreError.shuttingDown();
    const handler = this.deps.handlers?.["backend:toggle_crawl_paused"];
    if (!handler) throw CoreError.notImplemented(BACKEND_CONTROL.toggleCrawlPaused);
    return handler(this.context, {});
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const errors: unknown[] = [];
    try {
      await this.ipc?.close();
    } catch (err) {
      errors.push(err);
    }
    this.ipc = null;
    try {
      if (this.ctx) await this.deps.onStopping?.(this.ctx);
    } catch (err) {
      errors.push(err);
    }
    try {
      this.store?.close();
    } catch (err) {
      errors.push(err);
    }
    this.store = null;
    if (errors.length > 0) throw errors[0];
  }
}

function prepareDataDirectories(config: BackendConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(config.dataDir, 0o700);
  fs.mkdirSync(config.backupDir, { recursive: true });
  fs.mkdirSync(config.aiWorkdir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
}

function refusingAgentBackend(host: HostBindings): HostAgentBackend {
  return {
    handle: async (_method: AgentMethodName) => {
      throw new host.AgentError(CoreError.notImplemented("agent").message);
    },
  };
}
