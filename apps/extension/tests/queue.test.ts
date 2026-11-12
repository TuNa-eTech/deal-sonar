import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACK_TIMEOUT_MS,
  MAX_QUEUE_AGE_MS,
  MAX_QUEUED_POSTS,
  MAX_RETRY_BACKOFF_MS,
  MIN_RETRY_BACKOFF_MS,
  OutboundQueue,
} from "../src/background/queue";
import {
  MAX_PUSH_BYTES,
  MAX_PUSH_POSTS,
  utf8ByteLength,
  type RawPost,
  type SourceRef,
} from "../src/protocol";

const SOURCE_REF: SourceRef = {
  platform: "facebook",
  kind: "group",
  external_id: "123456789",
};

function makePost(idx: number, textBody?: string): RawPost {
  return {
    platform: "facebook",
    post_id: `post_${idx}`,
    source_external_id: "123456789",
    permalink: `https://www.facebook.com/groups/123456789/posts/post_${idx}/`,
    author: { external_id: `u_${idx}`, name: `Người đăng ${idx}`, is_anonymous: false },
    text: textBody ?? `Nội dung bài đăng số ${idx} cần tìm thuê nhà khu Cầu Giấy.`,
    text_truncated: false,
    created_at: 1_794_384_600_000 + idx * 1000,
    captured_at: 1_794_384_900_000 + idx * 1000,
    attachments: [],
    extraction: { strategy: "network", profile_rev: 1 },
  };
}

describe("IndexedDB Durable Outbound Queue (`01-protocol.md §5`, `02-extension.md §8`)", () => {
  let queue: OutboundQueue | null = null;
  let dbCounter = 0;

  function createQueue(): OutboundQueue {
    dbCounter += 1;
    queue = new OutboundQueue({ dbName: `dealsonar_test_queue_${dbCounter}` });
    return queue;
  }

  afterEach(async () => {
    await queue?.close();
    queue = null;
  });

  it("splits `posts.push` into chunks of <= 100 posts AND <= 512 KB UTF-8 bytes", async () => {
    const q = createQueue();
    const t0 = 1_794_384_000_000;

    // 1. Count limit: 235 small posts -> 3 chunks (100 + 100 + 35)
    const smallPosts = Array.from({ length: 235 }, (_, i) => makePost(i));
    const countRes = await q.enqueuePostsPush("run_count", SOURCE_REF, smallPosts, t0);
    expect(countRes.envelopes).toHaveLength(3);
    expect(countRes.envelopes[0]!.payload.posts).toHaveLength(100);
    expect(countRes.envelopes[1]!.payload.posts).toHaveLength(100);
    expect(countRes.envelopes[2]!.payload.posts).toHaveLength(35);

    // 2. UTF-8 byte limit: 20 multi-byte Vietnamese posts (~45 KB UTF-8 each -> ~900 KB total)
    const heavyViText = "Căn hộ chính chủ Cầu Giấy giá tốt ".repeat(1_000); // ~48 KB UTF-8
    const heavyPosts = Array.from({ length: 20 }, (_, i) => makePost(1000 + i, heavyViText));
    const byteRes = await q.enqueuePostsPush("run_bytes", SOURCE_REF, heavyPosts, t0);

    expect(byteRes.envelopes.length).toBeGreaterThan(1);
    let totalHeavy = 0;
    for (const env of byteRes.envelopes) {
      expect(env.payload.posts.length).toBeLessThanOrEqual(MAX_PUSH_POSTS);
      expect(utf8ByteLength(env)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
      totalHeavy += env.payload.posts.length;
    }
    expect(totalHeavy).toBe(20);

    // 3. Single oversized post (> 700 KB) is safely truncated to fit <= 512 KB
    const monsterPost = makePost(9999, "A".repeat(700 * 1024));
    const singleRes = await q.enqueuePostsPush("run_monster", SOURCE_REF, [monsterPost], t0);
    expect(singleRes.envelopes).toHaveLength(1);
    expect(utf8ByteLength(singleRes.envelopes[0]!)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    expect(singleRes.envelopes[0]!.payload.posts[0]!.text_truncated).toBe(true);
  });

  it("removes acknowledged messages via `ack(reply_to)` and retries unacked ones after 30s with exponential backoff (5s -> 5m) keeping the same id", async () => {
    const q = createQueue();
    const t0 = 1_794_384_000_000;

    const { envelopes } = await q.enqueuePostsPush(
      "run_ack",
      SOURCE_REF,
      [makePost(1)],
      t0,
    );
    const msgId = envelopes[0]!.id;

    const reportEnv = await q.enqueueCrawlReport(
      {
        run_id: "run_ack",
        source_ref: SOURCE_REF,
        reason: "scheduled",
        status: "ok",
        started_at: t0,
        ended_at: t0 + 1_000,
        posts_seen: 1,
        posts_new: 1,
        page_loads: 1,
        strategy: "network",
      },
      t0 + 1_000,
    );

    // Send both at t0 + 1_000
    const ready0 = await q.getReadyRecords(t0 + 1_000);
    expect(ready0).toHaveLength(2);
    await q.markSent(msgId, t0 + 1_000);
    await q.markSent(reportEnv.id, t0 + 1_000);

    // Ack `crawl.report` -> removed permanently
    expect(await q.ack(reportEnv.id)).toBe(true);
    expect((await q.getAllRecords()).map((r) => r.id)).toEqual([msgId]);

    // Before 30s ack timeout (at +29s): still in-flight, NOT ready for retry
    expect(await q.getReadyRecords(t0 + 1_000 + ACK_TIMEOUT_MS - 1_000)).toHaveLength(0);

    // At +30s timeout: swept and scheduled with initial 5s backoff (ready at +30s + 5s)
    expect(await q.getReadyRecords(t0 + 1_000 + ACK_TIMEOUT_MS)).toHaveLength(0);
    const retry1At = t0 + 1_000 + ACK_TIMEOUT_MS + MIN_RETRY_BACKOFF_MS;
    const ready1 = await q.getReadyRecords(retry1At);
    expect(ready1).toHaveLength(1);
    expect(ready1[0]!.envelope.id).toBe(msgId); // Exact same ID preserved!

    // Simulate repeated retryable `error` replies backing off: 10s -> 20s -> 40s -> 80s -> 160s -> 300s (5m cap)
    let cursor = retry1At;
    const expectedBackoffs = [10_000, 20_000, 40_000, 80_000, 160_000, MAX_RETRY_BACKOFF_MS, MAX_RETRY_BACKOFF_MS];
    for (const expectedDelay of expectedBackoffs) {
      await q.markSent(msgId, cursor);
      await q.markErrorReply(msgId, true, cursor);
      expect(await q.getReadyRecords(cursor + expectedDelay - 1)).toHaveLength(0);
      const due = await q.getReadyRecords(cursor + expectedDelay);
      expect(due).toHaveLength(1);
      expect(due[0]!.envelope.id).toBe(msgId);
      cursor += expectedDelay;
    }

    // Finally ack -> queue becomes completely empty
    expect(await q.ack(msgId)).toBe(true);
    expect(await q.getAllRecords()).toHaveLength(0);
  });

  it("enforces max 5,000 queued posts and 7-day TTL, dropping oldest posts and attaching dropped count to next `crawl.report`", async () => {
    const q = createQueue();
    const t0 = 1_794_384_000_000;

    // Enqueue 5,150 posts across two runs (3,000 + 2,150) -> oldest 150 posts (`post_0`..`post_149`) dropped!
    const batchA = Array.from({ length: 3_000 }, (_, i) => makePost(i));
    const batchB = Array.from({ length: 2_150 }, (_, i) => makePost(3_000 + i));

    await q.enqueuePostsPush("run_A", SOURCE_REF, batchA, t0);
    const resB = await q.enqueuePostsPush("run_B", SOURCE_REF, batchB, t0 + 1_000);

    expect(resB.droppedPosts).toBe(150);
    expect(await q.countQueuedPosts()).toBe(MAX_QUEUED_POSTS);
    expect(await q.peekDroppedPostsCount()).toBe(150);

    const records = await q.getAllRecords();
    const firstRemainingPost =
      records[0]!.envelope.type === "posts.push"
        ? records[0]!.envelope.payload.posts[0]
        : undefined;
    expect(firstRemainingPost?.post_id).toBe("post_150");

    // Next `crawl.report` consumes and records `dropped_posts: 150`
    const report = await q.enqueueCrawlReport(
      {
        run_id: "run_report",
        source_ref: SOURCE_REF,
        reason: "scheduled",
        status: "ok",
        started_at: t0 + 2_000,
        ended_at: t0 + 3_000,
        posts_seen: 10,
        posts_new: 10,
        page_loads: 1,
        strategy: "network",
      },
      t0 + 3_000,
    );
    expect(report.payload.dropped_posts).toBe(150);
    expect(await q.peekDroppedPostsCount()).toBe(0);

    // Advance past 7-day TTL -> all old items evicted
    const after7Days = t0 + MAX_QUEUE_AGE_MS + 10_000;
    await q.getReadyRecords(after7Days);
    expect(await q.countQueuedPosts()).toBe(0);
    expect(await q.peekDroppedPostsCount()).toBe(5_000);
  });
});
