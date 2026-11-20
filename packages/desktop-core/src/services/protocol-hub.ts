// Multi-profile connection and session registry: the TS counterpart of `IpcHub`,
// `IpcHubState`, `MessageDedupCache` and the extension half of `compute_health_status` in
// `crates/core/src/state.rs`.
//
// One `ProtocolHub` must be shared by everything that reads or changes crawl/session state: the
// connection handler, `chrome_connect`, the tray pause toggle and the health snapshot.

import type {
  CrawlPauseReason,
  CrawlRuntimeStatus,
  Envelope,
  FacebookSessionState,
} from "./protocol-types";

/** One Chrome-profile connection that has completed `hello`. */
export interface ConnectedProfile {
  connId: number;
  profileId: string;
  extVersion: string;
  browser: string;
  connectedAt: number;
  crawlRuntime: { at: number; status: CrawlRuntimeStatus } | null;
  /** Queue one envelope for this connection. Returns false when the connection is gone. */
  send(envelope: Envelope): boolean;
}

/** Bounded FIFO cache of processed message ids -> `(accepted, duplicates)` (min capacity 64). */
export class MessageDedupCache {
  private readonly capacity: number;
  private readonly entries = new Map<string, readonly [number, number]>();

  constructor(capacity: number) {
    this.capacity = Math.max(64, capacity);
  }

  get(msgId: string): readonly [number, number] | undefined {
    return this.entries.get(msgId);
  }

  insert(msgId: string, ack: readonly [number, number]): void {
    if (this.entries.has(msgId)) {
      // Overwrite in place, keeping the original eviction position (as the Rust cache does).
      this.entries.set(msgId, ack);
      return;
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(msgId, ack);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Deduplicated system-incident flags this module owns (`IncidentTracker`). */
export interface ProtocolIncidentFlags {
  fbSessionAlerted: boolean;
  /** Set by the health monitor after the grace window; cleared here on the next `hello`. */
  extDisconnectedAlerted: boolean;
  extractorBrokenAlerted: boolean;
}

/** Extension-derived part of the health snapshot. */
export interface ProtocolHealthSnapshot {
  extension_connected: boolean;
  extension_version: string | null;
  facebook_session: FacebookSessionState;
  crawl_paused: boolean;
  crawl_pause_reason: CrawlPauseReason | null;
  automatic_scanning: boolean | null;
  next_crawl_at: number | null;
  runtime_checked_at: number | null;
}

/** Runtime reports older than this are ignored (`now - at < 90_000`). */
export const RUNTIME_REPORT_MAX_AGE_MS = 90_000;

export class ProtocolHub {
  private nextConnId = 1;
  readonly connections = new Map<number, ConnectedProfile>();
  readonly dedup: MessageDedupCache;
  readonly incidents: ProtocolIncidentFlags = {
    fbSessionAlerted: false,
    extDisconnectedAlerted: false,
    extractorBrokenAlerted: false,
  };

  lastDisconnectedAt: number | null = null;
  facebookSession: FacebookSessionState = "ok";
  crawlPaused = false;
  crawlPauseReason: CrawlPauseReason | null = null;
  configRev = 1;
  /** Distinct `source_id`s from consecutive `empty` crawl runs (>= 3 trips `extractor_broken`). */
  consecutiveEmptySources: string[] = [];
  extractorBroken = false;

  constructor(dedupCapacity = 4_096) {
    this.dedup = new MessageDedupCache(dedupCapacity);
  }

  allocConnId(): number {
    return this.nextConnId++;
  }

  isAnyConnected(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Send to one Chrome `profileId`, or broadcast when it is null. Returns how many connections
   * accepted the message.
   */
  sendToProfile(profileId: string | null, envelope: Envelope): number {
    let sent = 0;
    for (const conn of [...this.connections.values()]) {
      if ((profileId === null || conn.profileId === profileId) && conn.send(envelope)) sent += 1;
    }
    return sent;
  }

  /** Extension/session view used by the health snapshot (`compute_health_status`). */
  healthSnapshot(now: number): ProtocolHealthSnapshot {
    const conns = [...this.connections.values()];
    const newest = conns.reduce<ConnectedProfile | null>(
      (best, c) => (best === null || c.connectedAt >= best.connectedAt ? c : best),
      null,
    );
    const reports = conns
      .map((c) => c.crawlRuntime)
      .filter((r): r is NonNullable<typeof r> => r !== null && now - r.at < RUNTIME_REPORT_MAX_AGE_MS);
    const complete = conns.length > 0 && reports.length === conns.length;
    const nextCrawl = reports.map((r) => r.status.next_crawl_at).filter((n): n is number => n !== null);
    return {
      extension_connected: conns.length > 0,
      extension_version: newest?.extVersion ?? null,
      facebook_session: this.facebookSession,
      crawl_paused: this.crawlPaused || reports.some((r) => r.status.paused),
      crawl_pause_reason: this.crawlPauseReason,
      automatic_scanning: complete ? reports.some((r) => r.status.automatic_scanning) : null,
      next_crawl_at: nextCrawl.length > 0 ? Math.min(...nextCrawl) : null,
      runtime_checked_at: reports.length > 0 ? Math.min(...reports.map((r) => r.at)) : null,
    };
  }
}
