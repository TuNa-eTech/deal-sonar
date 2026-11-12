// Durable Service Worker state persisted in `chrome.storage.local` (`02-extension.md §8–9`).
// Never relies solely on in-memory globals so SW termination/restart is seamless.

import { DEFAULT_EXTRACTOR_PROFILE } from "../content/extract";
import {
  generateUlid,
  type ConfigUpdatePayload,
  type CrawlPolicy,
  type SessionState,
} from "../protocol";

export const MAX_SEEN_POST_IDS_PER_SOURCE = 200;
const STORAGE_KEY = "dealsonar_sw_state_v2";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CRAWL_POLICY: CrawlPolicy = {
  max_loads_per_hour: 60,
  max_loads_per_day: 600,
  active_hours: { from: "07:00", to: "23:00" },
  jitter: 0.3,
  max_scroll_steps: 3,
  only_when_idle: false,
};

export type SourceRuntimeState = {
  last_crawl_at: number | null;
  next_due_at: number;
  inaccessible: boolean;
  last_error?: string;
};

export type PauseState = {
  paused: boolean;
  until: number | null;
  reason: string | null;
  requires_desktop_resume: boolean;
};

export type StoredSessionState = {
  state: SessionState;
  detail?: string;
  updated_at: number;
};

export type AnomalyState = {
  consecutive_network_errors: number;
  network_backoff_until: number | null;
  rate_limit_recovery_until: number | null;
  empty_streak_count: number;
  empty_streak_sources: string[];
  extractor_broken: boolean;
};

export type ConnectionState = {
  connected: boolean;
  desktop_available: boolean;
  desktop_version?: string;
  last_seen_at?: number;
  last_error?: string;
};

export type ActiveCrawlRecord = {
  run_id: string;
  source_external_id: string;
  tab_id: number | null;
  owned_tab: boolean;
  opened_at: number;
};

export type ExtensionStorageState = {
  profile_id: string;
  config: ConfigUpdatePayload;
  load_timestamps: number[];
  seen_post_ids: Record<string, string[]>;
  source_states: Record<string, SourceRuntimeState>;
  pause: PauseState;
  session: StoredSessionState;
  anomalies: AnomalyState;
  connection: ConnectionState;
  active_crawl: ActiveCrawlRecord | null;
  last_crawl_at: number | null;
  optimistic_followed_ids: string[];
};

export function createInitialStorageState(now: number = Date.now()): ExtensionStorageState {
  const ulidSuffix = generateUlid(now).slice(-8).toLowerCase();
  return {
    profile_id: `p_${ulidSuffix}`,
    config: {
      rev: 0,
      plan: { entries: [] },
      policy: { ...DEFAULT_CRAWL_POLICY, active_hours: { ...DEFAULT_CRAWL_POLICY.active_hours } },
      extractor: DEFAULT_EXTRACTOR_PROFILE,
    },
    load_timestamps: [],
    seen_post_ids: {},
    source_states: {},
    pause: {
      paused: false,
      until: null,
      reason: null,
      requires_desktop_resume: false,
    },
    session: {
      state: "ok",
      updated_at: now,
    },
    anomalies: {
      consecutive_network_errors: 0,
      network_backoff_until: null,
      rate_limit_recovery_until: null,
      empty_streak_count: 0,
      empty_streak_sources: [],
      extractor_broken: false,
    },
    connection: {
      connected: false,
      desktop_available: false,
    },
    active_crawl: null,
    last_crawl_at: null,
    optimistic_followed_ids: [],
  };
}

export interface KeyValueBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function createChromeLocalBackend(): KeyValueBackend {
  return {
    async get(key: string): Promise<unknown> {
      const result = await chrome.storage.local.get(key);
      return result[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}

export function createMemoryBackend(): KeyValueBackend {
  const map = new Map<string, string>();
  return {
    async get(key: string): Promise<unknown> {
      const raw = map.get(key);
      return raw !== undefined ? JSON.parse(raw) : undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, JSON.stringify(value));
    },
  };
}

export function pruneLoadTimestamps(timestamps: readonly number[], now: number): number[] {
  const cutoff = now - ONE_DAY_MS;
  return timestamps.filter((ts) => typeof ts === "number" && ts > cutoff);
}

export function appendSeenPostIds(
  existing: readonly string[] | undefined,
  newIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const id of newIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      combined.push(id);
    }
  }
  if (existing) {
    for (const id of existing) {
      if (id && !seen.has(id)) {
        seen.add(id);
        combined.push(id);
      }
    }
  }
  return combined.slice(0, MAX_SEEN_POST_IDS_PER_SOURCE);
}

export class StorageManager {
  private readonly backend: KeyValueBackend;
  private chain: Promise<void> = Promise.resolve();

  constructor(backend?: KeyValueBackend) {
    this.backend =
      backend ??
      (typeof chrome !== "undefined" && chrome.storage?.local
        ? createChromeLocalBackend()
        : createMemoryBackend());
  }

  async read(now: number = Date.now()): Promise<ExtensionStorageState> {
    const raw = await this.backend.get(STORAGE_KEY);
    if (!raw || typeof raw !== "object") {
      const initial = createInitialStorageState(now);
      await this.backend.set(STORAGE_KEY, initial);
      return initial;
    }
    const base = createInitialStorageState(now);
    const partial = raw as Partial<ExtensionStorageState>;
    return {
      ...base,
      ...partial,
      config: partial.config ?? base.config,
      pause: { ...base.pause, ...(partial.pause ?? {}) },
      session: { ...base.session, ...(partial.session ?? {}) },
      anomalies: { ...base.anomalies, ...(partial.anomalies ?? {}) },
      connection: { ...base.connection, ...(partial.connection ?? {}) },
      load_timestamps: pruneLoadTimestamps(partial.load_timestamps ?? [], now),
      seen_post_ids: partial.seen_post_ids ?? {},
      source_states: partial.source_states ?? {},
      optimistic_followed_ids: partial.optimistic_followed_ids ?? [],
    };
  }

  async update<R>(
    mutator: (state: ExtensionStorageState) => R | Promise<R>,
    now: number = Date.now(),
  ): Promise<R> {
    let result!: R;
    const op = this.chain.then(async () => {
      const state = await this.read(now);
      result = await mutator(state);
      state.load_timestamps = pruneLoadTimestamps(state.load_timestamps, now);
      await this.backend.set(STORAGE_KEY, state);
    });
    // Keep queue alive even if one mutator rejects
    this.chain = op.catch(() => {});
    await op;
    return result;
  }
}
