// Shared synthetic fixtures for the protocol/agent tests. No sockets, no real Chrome, no network.

import type { HostExtensionConnection } from "../src/backend/host";
import type { BackendConfig } from "../src/backend/config";
import { Store } from "../src/store/store";
import type { SourceRecord } from "../src/store/sources";
import type { SystemIncidentKind, ProtocolPipelineHooks } from "../src/services/protocol-server";
import type { Envelope, RawPost } from "../src/services/protocol-types";
import { newUlid } from "../src/store/util";

/** In-memory stand-in for one relay connection (`ExtensionConnection`). */
export class FakeConnection implements HostExtensionConnection {
  readonly id: number;
  readonly sent: Envelope[] = [];
  private frameHandler: ((frame: Buffer) => void) | null = null;
  private closeHandlers: Array<() => void> = [];
  closed = false;
  paused = false;
  bufferedBytes = 0;
  failSends = false;

  constructor(id = 1) {
    this.id = id;
  }

  onFrame(handler: (frame: Buffer) => void): void {
    this.frameHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  sendFrame(): Promise<void> {
    return Promise.resolve();
  }
  sendEnvelope(envelope: unknown): Promise<void> {
    if (this.failSends) return Promise.reject(new Error("socket closed"));
    this.sent.push(envelope as Envelope);
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  close(): void {
    this.drop();
  }

  /** Deliver one extension -> desktop frame. */
  push(message: unknown): void {
    const bytes = Buffer.isBuffer(message)
      ? message
      : Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8");
    this.frameHandler?.(bytes);
  }

  drop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }

  /** Messages of one type, in send order. */
  ofType(type: string): Envelope[] {
    return this.sent.filter((e) => e.type === type);
  }
}

let seq = 0;
/** Protocol v2 envelope as the extension would send it. */
export function ext(type: string, payload: unknown, id?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { v: 2, id: id ?? `M${seq}`, ts: 1_794_384_000_000, reply_to: null, type, payload, ...extra };
}

export const helloMsg = (profile = "p_7f3a", configRev = 0, id?: string) =>
  ext("hello", { profile_id: profile, ext_version: "0.2.0", browser: "chrome/142", config_rev: configRev }, id);

export const groupRef = (externalId = "123456789") => ({ platform: "facebook", kind: "group", external_id: externalId });

export function rawPost(postId: string, sourceExternalId = "123456789"): RawPost {
  return {
    platform: "facebook",
    post_id: postId,
    source_external_id: sourceExternalId,
    permalink: `https://www.facebook.com/groups/${sourceExternalId}/posts/${postId}/`,
    author: { name: "Nguyễn Văn A", is_anonymous: false },
    text: "E cần thuê chung cư 2pn khu Cầu Giấy, tầm 12-15tr. Lh 0912.345.678",
    text_truncated: false,
    created_at: 1_794_384_600_000,
    captured_at: 1_794_384_900_000,
    attachments: [],
    extraction: { strategy: "network", profile_rev: 4 },
  };
}

export const defaultConfigBody = () => ({
  plan: { entries: [] },
  policy: {
    max_loads_per_hour: 60,
    max_loads_per_day: 600,
    active_hours: { from: "07:00", to: "23:00" },
    jitter: 0.3,
    max_scroll_steps: 3,
    only_when_idle: false,
  },
  extractor: { rev: 1, strategies: ["network", "embedded", "dom"] as Array<"network" | "embedded" | "dom">, network: {}, dom: {}, session_markers: {} },
});

export interface HookProbe extends ProtocolPipelineHooks {
  ingested: Array<{ source: SourceRecord; post: RawPost }>;
  alerts: Array<{ kind: SystemIncidentKind; resolved: boolean }>;
  healthEmits: number;
  configProfiles: Array<string | null>;
  maxGroups: number;
  failIngestWith: unknown;
}

/** Synthetic pipeline: a post is a duplicate when its `post_id` was ingested before. */
export function makeHooks(): HookProbe {
  const seen = new Set<string>();
  const probe: HookProbe = {
    ingested: [],
    alerts: [],
    healthEmits: 0,
    configProfiles: [],
    maxGroups: 100,
    failIngestWith: null,
    ingestRawPost(source, post) {
      if (probe.failIngestWith) throw probe.failIngestWith;
      probe.ingested.push({ source, post });
      const inserted = !seen.has(post.post_id);
      seen.add(post.post_id);
      return { inserted };
    },
    buildConfig(profileId) {
      probe.configProfiles.push(profileId);
      return defaultConfigBody();
    },
    maxFollowedGroups: () => probe.maxGroups,
    emitHealthIfChanged() {
      probe.healthEmits += 1;
      return {};
    },
    queueSystemIncidentAlert(kind, resolved) {
      probe.alerts.push({ kind, resolved });
    },
  };
  return probe;
}

export interface TestCtx {
  store: Store;
  events: Array<{ event: string; payload: unknown }>;
  shuttingDown: boolean;
  emit(event: string, payload: unknown): void;
  isShuttingDown(): boolean;
}

export function makeCtx(store: Store = Store.openInMemory()): TestCtx {
  const ctx: TestCtx = {
    store,
    events: [],
    shuttingDown: false,
    emit: (event, payload) => ctx.events.push({ event, payload }),
    isShuttingDown: () => ctx.shuttingDown,
  };
  return ctx;
}

export function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  const dataDir = overrides.dataDir ?? "/tmp/dealsonar-test";
  return {
    channel: "production",
    dataDir,
    dbPath: `${dataDir}/dealsonar.db`,
    backupDir: `${dataDir}/backups`,
    logsDir: `${dataDir}/logs`,
    aiWorkdir: `${dataDir}/ai-workdir`,
    ipcEndpoint: `${dataDir}/ipc.sock`,
    nativeHostBinaryPath: null,
    appVersion: "0.2.0",
    electronVersion: null,
    inMemorySecrets: true,
    mockAi: true,
    platform: "darwin",
    ...overrides,
  };
}

export const newId = (): string => newUlid();
