// Durable IndexedDB Outbound Queue (`01-protocol.md §5`, `02-extension.md §8`):
// - Persists `posts.push`, `crawl.report`, `sources.discovered` until matching `ack(reply_to)`
// - Splits `posts.push` into chunks of `<= 100` posts AND `<= 512 KB` UTF-8 bytes
// - Retries unacked messages after 30s with exponential backoff (`5s` -> `5m`), keeping the same `id`
// - Enforces max `5,000` queued posts or `7 days` TTL, dropping oldest & recording dropped count

import {
  createEnvelope,
  MAX_PUSH_BYTES,
  MAX_PUSH_POSTS,
  utf8ByteLength,
  type CrawlReportPayload,
  type DurableEnvelope,
  type EnvelopeOf,
  type RawPost,
  type SourceRef,
  type SourcesDiscoveredPayload,
} from "../protocol";

export const ACK_TIMEOUT_MS = 30_000; // 30 seconds
export const MIN_RETRY_BACKOFF_MS = 5_000; // 5 seconds
export const MAX_RETRY_BACKOFF_MS = 300_000; // 5 minutes
export const MAX_QUEUED_POSTS = 5_000;
export const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const DEFAULT_DB_NAME = "dealsonar_outbound_v2";
const DB_VERSION = 1;
const STORE_ITEMS = "items";
const STORE_META = "meta";
const META_DROPPED_KEY = "dropped_posts";

export type QueueRecord = {
  seq?: number;
  id: string;
  envelope: DurableEnvelope;
  created_at: number;
  in_flight: boolean;
  last_sent_at: number | null;
  ack_deadline_at: number | null;
  retry_count: number;
  next_retry_at: number;
};

type DroppedMetaRecord = {
  key: string;
  count: number;
};

/** Exponential backoff `5s -> 10s -> 20s -> 40s -> 80s -> 160s -> 300s (5m)`. */
export function computeRetryBackoffMs(retryCount: number): number {
  const exp = Math.max(0, retryCount - 1);
  const delay = MIN_RETRY_BACKOFF_MS * Math.pow(2, Math.min(exp, 10));
  return Math.min(delay, MAX_RETRY_BACKOFF_MS);
}

/** Ensure even an oversized single post fits inside `MAX_PUSH_BYTES` (512 KB UTF-8). */
function fitSinglePostToByteCap(
  runId: string,
  sourceRef: SourceRef,
  post: RawPost,
  ts: number,
): RawPost {
  const probe = createEnvelope(
    "posts.push",
    { run_id: runId, source_ref: sourceRef, posts: [post] },
    { ts },
  );
  if (utf8ByteLength(probe) <= MAX_PUSH_BYTES) {
    return post;
  }

  // Binary search maximum text slice that keeps the envelope <= 512 KB
  let trimmedAttachments = post.attachments;
  let low = 0;
  let high = post.text.length;
  let best = "";

  // First try keeping attachments while shrinking text; if empty text still exceeds, drop attachments
  const emptyTextProbe = createEnvelope(
    "posts.push",
    {
      run_id: runId,
      source_ref: sourceRef,
      posts: [{ ...post, text: "", text_truncated: true }],
    },
    { ts },
  );
  if (utf8ByteLength(emptyTextProbe) > MAX_PUSH_BYTES) {
    trimmedAttachments = [];
  }

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateText = post.text.slice(0, mid);
    const candidateEnv = createEnvelope(
      "posts.push",
      {
        run_id: runId,
        source_ref: sourceRef,
        posts: [
          {
            ...post,
            text: candidateText,
            text_truncated: true,
            attachments: trimmedAttachments,
          },
        ],
      },
      { ts },
    );
    if (utf8ByteLength(candidateEnv) <= MAX_PUSH_BYTES) {
      best = candidateText;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return {
    ...post,
    text: best,
    text_truncated: true,
    attachments: trimmedAttachments,
  };
}

/**
 * Split `posts` into `posts.push` envelopes respecting BOTH:
 * - `posts.length <= 100` (`MAX_PUSH_POSTS`)
 * - `utf8ByteLength(JSON.stringify(envelope)) <= 512 KB` (`MAX_PUSH_BYTES`)
 */
export function splitPostsIntoPushEnvelopes(
  runId: string,
  sourceRef: SourceRef,
  posts: readonly RawPost[],
  nowMs: number = Date.now(),
): EnvelopeOf<"posts.push">[] {
  if (posts.length === 0) return [];

  const chunks: EnvelopeOf<"posts.push">[] = [];
  let currentBatch: RawPost[] = [];

  for (const rawPost of posts) {
    const safePost = fitSinglePostToByteCap(runId, sourceRef, rawPost, nowMs);

    if (currentBatch.length >= MAX_PUSH_POSTS) {
      chunks.push(
        createEnvelope(
          "posts.push",
          { run_id: runId, source_ref: sourceRef, posts: currentBatch },
          { ts: nowMs },
        ),
      );
      currentBatch = [safePost];
      continue;
    }

    const candidateBatch = [...currentBatch, safePost];
    const candidateEnv = createEnvelope(
      "posts.push",
      { run_id: runId, source_ref: sourceRef, posts: candidateBatch },
      { ts: nowMs },
    );

    if (currentBatch.length > 0 && utf8ByteLength(candidateEnv) > MAX_PUSH_BYTES) {
      chunks.push(
        createEnvelope(
          "posts.push",
          { run_id: runId, source_ref: sourceRef, posts: currentBatch },
          { ts: nowMs },
        ),
      );
      currentBatch = [safePost];
    } else {
      currentBatch = candidateBatch;
    }
  }

  if (currentBatch.length > 0) {
    chunks.push(
      createEnvelope(
        "posts.push",
        { run_id: runId, source_ref: sourceRef, posts: currentBatch },
        { ts: nowMs },
      ),
    );
  }

  return chunks;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class OutboundQueue {
  private readonly dbName: string;
  private readonly idbFactory: IDBFactory;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(options?: { dbName?: string; indexedDB?: IDBFactory }) {
    this.dbName = options?.dbName ?? DEFAULT_DB_NAME;
    const factory = options?.indexedDB ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error("IndexedDB is not available in this environment");
    }
    this.idbFactory = factory;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const openReq = this.idbFactory.open(this.dbName, DB_VERSION);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        if (!db.objectStoreNames.contains(STORE_ITEMS)) {
          const items = db.createObjectStore(STORE_ITEMS, {
            keyPath: "seq",
            autoIncrement: true,
          });
          items.createIndex("by_id", "id", { unique: true });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      openReq.onsuccess = () => resolve(openReq.result);
      openReq.onerror = () =>
        reject(openReq.error ?? new Error("Failed to open OutboundQueue IndexedDB"));
    });
    return this.dbPromise;
  }

  private runExclusive<R>(fn: () => Promise<R>): Promise<R> {
    let result!: R;
    const next = this.mutex.then(async () => {
      result = await fn();
    });
    this.mutex = next.catch(() => {});
    return next.then(() => result);
  }

  private async enforceLimitsInternal(
    db: IDBDatabase,
    now: number,
  ): Promise<number> {
    const tx = db.transaction([STORE_ITEMS, STORE_META], "readwrite");
    const itemsStore = tx.objectStore(STORE_ITEMS);
    const metaStore = tx.objectStore(STORE_META);

    const allRecords = (await reqToPromise(itemsStore.getAll())) as QueueRecord[];
    // Ordered oldest-first by autoIncrement `seq`
    allRecords.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    let newlyDroppedPosts = 0;
    const cutoffTs = now - MAX_QUEUE_AGE_MS;
    const surviving: QueueRecord[] = [];

    // 1. Evict items older than 7 days (`01-protocol.md §5`)
    for (const rec of allRecords) {
      if (rec.created_at < cutoffTs) {
        if (rec.seq !== undefined) {
          itemsStore.delete(rec.seq);
        }
        if (rec.envelope.type === "posts.push") {
          newlyDroppedPosts += rec.envelope.payload.posts.length;
        }
      } else {
        surviving.push(rec);
      }
    }

    // 2. Enforce max 5,000 queued posts (`01-protocol.md §5`)
    let totalPosts = 0;
    for (const rec of surviving) {
      if (rec.envelope.type === "posts.push") {
        totalPosts += rec.envelope.payload.posts.length;
      }
    }

    if (totalPosts > MAX_QUEUED_POSTS) {
      let excess = totalPosts - MAX_QUEUED_POSTS;
      for (const rec of surviving) {
        if (excess <= 0) break;
        if (rec.envelope.type !== "posts.push") continue;

        const chunkPosts = rec.envelope.payload.posts;
        if (chunkPosts.length <= excess) {
          // Drop the entire oldest chunk
          if (rec.seq !== undefined) {
            itemsStore.delete(rec.seq);
          }
          newlyDroppedPosts += chunkPosts.length;
          excess -= chunkPosts.length;
        } else {
          // Trim the oldest `excess` posts from the front of this chunk
          const remainingPosts = chunkPosts.slice(excess);
          const updatedEnvelope = createEnvelope(
            "posts.push",
            {
              run_id: rec.envelope.payload.run_id,
              source_ref: rec.envelope.payload.source_ref,
              posts: remainingPosts,
            },
            {
              // Keep ID if never sent; assign fresh ID if previously sent so desktop dedup stays exact
              id: rec.last_sent_at === null ? rec.id : undefined,
              ts: rec.envelope.ts,
            },
          );
          const updatedRec: QueueRecord = {
            ...rec,
            id: updatedEnvelope.id,
            envelope: updatedEnvelope,
            in_flight: false,
            ack_deadline_at: null,
          };
          itemsStore.put(updatedRec);
          newlyDroppedPosts += excess;
          excess = 0;
        }
      }
    }

    if (newlyDroppedPosts > 0) {
      const prevMeta = (await reqToPromise(
        metaStore.get(META_DROPPED_KEY),
      )) as DroppedMetaRecord | undefined;
      const nextCount = (prevMeta?.count ?? 0) + newlyDroppedPosts;
      metaStore.put({ key: META_DROPPED_KEY, count: nextCount });
    }

    await txDone(tx);
    return newlyDroppedPosts;
  }

  async enqueueEnvelope(
    envelope: DurableEnvelope,
    now: number = Date.now(),
  ): Promise<{ record: QueueRecord; droppedPosts: number }> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);

      const record: QueueRecord = {
        id: envelope.id,
        envelope,
        created_at: now,
        in_flight: false,
        last_sent_at: null,
        ack_deadline_at: null,
        retry_count: 0,
        next_retry_at: now,
      };
      const seq = await reqToPromise(store.add(record));
      record.seq = Number(seq);
      await txDone(tx);

      const droppedPosts = await this.enforceLimitsInternal(db, now);
      return { record, droppedPosts };
    });
  }

  async enqueuePostsPush(
    runId: string,
    sourceRef: SourceRef,
    posts: readonly RawPost[],
    now: number = Date.now(),
  ): Promise<{ envelopes: EnvelopeOf<"posts.push">[]; droppedPosts: number }> {
    const envelopes = splitPostsIntoPushEnvelopes(runId, sourceRef, posts, now);
    if (envelopes.length === 0) {
      return { envelopes: [], droppedPosts: 0 };
    }

    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);

      for (const env of envelopes) {
        const record: QueueRecord = {
          id: env.id,
          envelope: env,
          created_at: now,
          in_flight: false,
          last_sent_at: null,
          ack_deadline_at: null,
          retry_count: 0,
          next_retry_at: now,
        };
        store.add(record);
      }
      await txDone(tx);

      const droppedPosts = await this.enforceLimitsInternal(db, now);
      return { envelopes, droppedPosts };
    });
  }

  async enqueueCrawlReport(
    payload: CrawlReportPayload,
    now: number = Date.now(),
  ): Promise<EnvelopeOf<"crawl.report">> {
    const pendingDropped = await this.consumeDroppedPostsCount();
    const finalPayload: CrawlReportPayload =
      pendingDropped > 0 && payload.dropped_posts === undefined
        ? { ...payload, dropped_posts: pendingDropped }
        : payload;
    const env = createEnvelope("crawl.report", finalPayload, { ts: now });
    await this.enqueueEnvelope(env, now);
    return env;
  }

  async enqueueSourcesDiscovered(
    payload: SourcesDiscoveredPayload,
    now: number = Date.now(),
  ): Promise<EnvelopeOf<"sources.discovered">> {
    const env = createEnvelope("sources.discovered", payload, { ts: now });
    await this.enqueueEnvelope(env, now);
    return env;
  }

  /** Acknowledge and remove message matching `ack.reply_to`. */
  async ack(replyToId: string | null | undefined): Promise<boolean> {
    if (!replyToId) return false;
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);
      const idx = store.index("by_id");
      const rec = (await reqToPromise(idx.get(replyToId))) as QueueRecord | undefined;
      if (!rec || rec.seq === undefined) {
        await txDone(tx);
        return false;
      }
      store.delete(rec.seq);
      await txDone(tx);
      return true;
    });
  }

  /** Mark message as sent over native port, starting its 30s ack timer. */
  async markSent(id: string, now: number = Date.now()): Promise<void> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);
      const idx = store.index("by_id");
      const rec = (await reqToPromise(idx.get(id))) as QueueRecord | undefined;
      if (rec && rec.seq !== undefined) {
        rec.in_flight = true;
        rec.last_sent_at = now;
        rec.ack_deadline_at = now + ACK_TIMEOUT_MS;
        store.put(rec);
      }
      await txDone(tx);
    });
  }

  /** Handle an `error` reply for a queued message (`retryable: true` backs off `5s -> 5m`). */
  async markErrorReply(
    replyToId: string | null | undefined,
    retryable: boolean,
    now: number = Date.now(),
  ): Promise<void> {
    if (!replyToId) return;
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);
      const idx = store.index("by_id");
      const rec = (await reqToPromise(idx.get(replyToId))) as QueueRecord | undefined;
      if (rec && rec.seq !== undefined) {
        if (!retryable) {
          store.delete(rec.seq);
        } else {
          rec.in_flight = false;
          rec.ack_deadline_at = null;
          rec.retry_count += 1;
          rec.next_retry_at = now + computeRetryBackoffMs(rec.retry_count);
          store.put(rec);
        }
      }
      await txDone(tx);
    });
  }

  /** Reset in-flight items with exponential backoff when native port disconnects. */
  async releaseInFlightOnDisconnect(now: number = Date.now()): Promise<void> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);
      const all = (await reqToPromise(store.getAll())) as QueueRecord[];
      for (const rec of all) {
        if (rec.in_flight && rec.seq !== undefined) {
          rec.in_flight = false;
          rec.ack_deadline_at = null;
          rec.retry_count += 1;
          rec.next_retry_at = now + computeRetryBackoffMs(rec.retry_count);
          store.put(rec);
        }
      }
      await txDone(tx);
    });
  }

  /**
   * Sweep expired items & 30s unacked timeouts (scheduling `5s -> 5m` exponential backoff
   * with the exact same `envelope.id`), then return items ready to transmit at `now`.
   */
  async getReadyRecords(now: number = Date.now()): Promise<QueueRecord[]> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      await this.enforceLimitsInternal(db, now);

      const tx = db.transaction(STORE_ITEMS, "readwrite");
      const store = tx.objectStore(STORE_ITEMS);
      const all = (await reqToPromise(store.getAll())) as QueueRecord[];
      all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

      const ready: QueueRecord[] = [];
      for (const rec of all) {
        if (
          rec.in_flight &&
          rec.ack_deadline_at !== null &&
          now >= rec.ack_deadline_at
        ) {
          rec.in_flight = false;
          rec.retry_count += 1;
          rec.next_retry_at =
            rec.ack_deadline_at + computeRetryBackoffMs(rec.retry_count);
          rec.ack_deadline_at = null;
          store.put(rec);
        }

        if (!rec.in_flight && now >= rec.next_retry_at) {
          ready.push(rec);
        }
      }

      await txDone(tx);
      return ready;
    });
  }

  async getAllRecords(): Promise<QueueRecord[]> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_ITEMS, "readonly");
      const store = tx.objectStore(STORE_ITEMS);
      const all = (await reqToPromise(store.getAll())) as QueueRecord[];
      all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      await txDone(tx);
      return all;
    });
  }

  async countQueuedPosts(): Promise<number> {
    const records = await this.getAllRecords();
    let total = 0;
    for (const rec of records) {
      if (rec.envelope.type === "posts.push") {
        total += rec.envelope.payload.posts.length;
      }
    }
    return total;
  }

  async peekDroppedPostsCount(): Promise<number> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_META, "readonly");
      const store = tx.objectStore(STORE_META);
      const meta = (await reqToPromise(
        store.get(META_DROPPED_KEY),
      )) as DroppedMetaRecord | undefined;
      await txDone(tx);
      return meta?.count ?? 0;
    });
  }

  async consumeDroppedPostsCount(): Promise<number> {
    return this.runExclusive(async () => {
      const db = await this.openDb();
      const tx = db.transaction(STORE_META, "readwrite");
      const store = tx.objectStore(STORE_META);
      const meta = (await reqToPromise(
        store.get(META_DROPPED_KEY),
      )) as DroppedMetaRecord | undefined;
      const count = meta?.count ?? 0;
      if (count > 0) {
        store.put({ key: META_DROPPED_KEY, count: 0 });
      }
      await txDone(tx);
      return count;
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
