// Structural view of `@dealsonar/native-host` (electron-host worker). The backend depends on
// these shapes, not on the package, so desktop-core typechecks and tests without the host
// workspace and the real module is injected at the entry point (`main.ts`).

export type HostPlatform = "macos" | "linux" | "windows";

/** One Chrome-profile relay connection (`ExtensionConnection` in native-host/src/ipc.ts). */
export interface HostExtensionConnection {
  readonly id: number;
  onFrame(handler: (frame: Buffer) => void): void;
  onClose(handler: () => void): void;
  sendFrame(frame: Uint8Array): Promise<void>;
  sendEnvelope(envelope: unknown): Promise<void>;
  pause(): void;
  resume(): void;
  readonly bufferedBytes: number;
  close(): void;
}

export type AgentMethodName =
  | "list_radar_sources"
  | "prepare_radar"
  | "check_radar_preview"
  | "retry_radar_preview";

export interface HostAgentBackend {
  handle(method: AgentMethodName, args: unknown): Promise<unknown>;
}

export interface HostIpcServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface HostIpcServerOptions {
  endpoint: string;
  agentToken?: Buffer | null;
  agentBackend?: HostAgentBackend | null;
  onExtensionConnection: (connection: HostExtensionConnection) => void;
  logger?: (message: string) => void;
}

export interface HostBindings {
  resolveDesktopDataDir(env: Readonly<Record<string, string | undefined>>, platform?: HostPlatform): string;
  resolveDesktopIpcEndpoint(
    dataDir: string,
    env: Readonly<Record<string, string | undefined>>,
    platform?: HostPlatform,
  ): string;
  bindIpcServer(options: HostIpcServerOptions): Promise<HostIpcServer>;
  /** Creates `<dataDir>/agent-access` (0600) and returns the 32-byte token. */
  issueAgentToken(dataDir: string): Buffer;
  /** Throws an error whose `message` is shown to the agent client. */
  AgentError: new (message: string) => Error;
}

/** Builds `HostBindings` from the real package export surface. */
export function hostBindingsFrom(mod: {
  resolveDesktopDataDir: HostBindings["resolveDesktopDataDir"];
  resolveDesktopIpcEndpoint: HostBindings["resolveDesktopIpcEndpoint"];
  DesktopIpcServer: { bind(options: HostIpcServerOptions): Promise<HostIpcServer> };
  issueAgentToken: HostBindings["issueAgentToken"];
  AgentError: HostBindings["AgentError"];
}): HostBindings {
  return {
    resolveDesktopDataDir: mod.resolveDesktopDataDir,
    resolveDesktopIpcEndpoint: mod.resolveDesktopIpcEndpoint,
    bindIpcServer: (options) => mod.DesktopIpcServer.bind(options),
    issueAgentToken: mod.issueAgentToken,
    AgentError: mod.AgentError,
  };
}
