// Shared fixtures for the integrations tests: a real file-backed Store behind a RuntimeContext,
// a recording in-process HTTP endpoint (Telegram Bot API / webhook receiver) and a lead seeder.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { BackendConfig } from "../src/backend/config";
import type { RuntimeContext } from "../src/backend/runtime";
import { InMemorySecretStore } from "../src/secrets/types";
import type { FieldDef, FieldType } from "../src/store/domain";
import type { FieldMap } from "../src/store/leads";
import { Store } from "../src/store/store";

export const T0 = 1_700_000_000_000;

export interface TestCtx {
  ctx: RuntimeContext;
  dir: string;
  store: Store;
  secrets: InMemorySecretStore;
  events: Array<{ event: string; payload: unknown }>;
  osNotifications: unknown[];
  setShuttingDown(v: boolean): void;
  cleanup(): void;
}

export function makeCtx(): TestCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-integrations-"));
  const config: BackendConfig = {
    channel: "candidate",
    dataDir: dir,
    dbPath: path.join(dir, "dealsonar.db"),
    backupDir: path.join(dir, "backups"),
    logsDir: path.join(dir, "logs"),
    aiWorkdir: path.join(dir, "ai-workdir"),
    ipcEndpoint: path.join(dir, "ipc.sock"),
    nativeHostBinaryPath: null,
    appVersion: "0.1.0-test",
    electronVersion: null,
    inMemorySecrets: true,
    mockAi: false,
    platform: process.platform,
  };
  fs.mkdirSync(config.backupDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
  fs.mkdirSync(config.aiWorkdir, { recursive: true });
  const store = Store.open(config.dbPath, config.backupDir);
  const secrets = new InMemorySecretStore();
  const events: TestCtx["events"] = [];
  const osNotifications: unknown[] = [];
  let shuttingDown = false;
  const ctx: RuntimeContext = {
    config,
    store,
    secrets,
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    notifyOs: (payload) => {
      osNotifications.push(payload);
    },
    isShuttingDown: () => shuttingDown,
  };
  return {
    ctx,
    dir,
    store,
    secrets,
    events,
    osNotifications,
    setShuttingDown: (v) => {
      shuttingDown = v;
    },
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- recording HTTP endpoint --------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Hold the response this long (timeout tests). */
  delayMs?: number;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  /** Responses are consumed per request in order; the last one repeats. */
  respondWith(...responses: MockResponse[]): void;
  /** Route-specific handler, evaluated first. */
  route(match: (req: RecordedRequest) => boolean, respond: (req: RecordedRequest) => MockResponse): void;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let queue: MockResponse[] = [{ status: 200, body: {} }];
  const routes: Array<{ match: (r: RecordedRequest) => boolean; respond: (r: RecordedRequest) => MockResponse }> = [];
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(rec);
      const routed = routes.find((r) => r.match(rec));
      const next = routed ? routed.respond(rec) : queue.length > 1 ? (queue.shift() as MockResponse) : queue[0];
      const send = (): void => {
        res.writeHead(next.status ?? 200, { "content-type": "application/json", ...(next.headers ?? {}) });
        res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}));
      };
      if (next.delayMs) setTimeout(send, next.delayMs).unref();
      else send();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (...responses) => {
      queue = responses.length > 0 ? responses : [{ status: 200, body: {} }];
    },
    route: (match, respond) => {
      routes.push({ match, respond });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---- lead fixtures ------------------------------------------------------------------------------

export const fd = (key: string, type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label: key,
  type,
  description: "",
  required: false,
  options: null,
  show_in_alert: true,
  order: 0,
  ...extra,
});

export interface SeededRadar {
  radarId: string;
  versionId: string;
  sourceIds: string[];
}

export function seedRadar(store: Store, fields: FieldDef[], notify?: Parameters<Store["radars"]["createDraft"]>[0]["notify"]): SeededRadar {
  const { source_ids } = store.sources.upsertDiscovered(
    [{ external_id: "g1", name: "Nhóm 1", url: "https://www.facebook.com/groups/g1" }],
    true,
    "profile-1",
    T0,
  );
  const radar = store.radars.createDraft({
    name: "Tìm nhà",
    description: "tìm nhà",
    fields,
    source_ids,
    notify,
    now_ms: T0,
  });
  store.radars.setStatus(radar.radar.id, "active", T0);
  return { radarId: radar.radar.id, versionId: radar.current_version.id, sourceIds: source_ids };
}

export function seedLead(
  store: Store,
  radar: SeededRadar,
  n: number,
  opts: {
    summary?: string;
    fields?: FieldMap;
    score?: number;
    text?: string;
    authorName?: string | null;
    capturedAt?: number;
  } = {},
) {
  const summary = opts.summary ?? `Tin ${n}`;
  const captured = opts.capturedAt ?? T0 + n;
  const [post] = store.posts.insert({
    platform: "facebook",
    external_id: `p${n}`,
    source_id: radar.sourceIds[0],
    author: opts.authorName === null ? null : { external_id: `a${n}`, name: opts.authorName ?? `Tác giả ${n}` },
    permalink: `https://www.facebook.com/groups/g1/posts/${n}`,
    text: opts.text ?? summary,
    text_fold: (opts.text ?? summary).toLowerCase(),
    content_hash: `h${n}`,
    simhash: BigInt(n) * 7919n,
    captured_at: captured,
    created_at: captured,
    strategy: "dom",
  });
  const fields: FieldMap = opts.fields ?? {};
  const ev = store.leads.upsertEvaluation({
    post_id: post.id,
    radar_version_id: radar.versionId,
    state: "done",
    decided_by: "ai",
    verdict: "match",
    score: opts.score ?? 0.9,
    fields,
    created_at: captured,
    decided_at: captured,
  });
  const [lead] = store.leads.createLead({
    radar_id: radar.radarId,
    radar_version_id: radar.versionId,
    post_id: post.id,
    evaluation_id: ev.id,
    score: opts.score ?? 0.9,
    summary,
    fields,
    now_ms: captured,
  });
  return { post, evaluation: ev, lead };
}

/** Minimal ZIP reader (stored/deflate) for assertions. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
