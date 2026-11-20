import { beforeEach, describe, expect, it } from "vitest";

import { CoreError } from "../src/backend/wire";
import { ProtocolHub, MessageDedupCache } from "../src/services/protocol-hub";
import { ProtocolService, ensureSourceExists, getSourceLastErrors } from "../src/services/protocol-server";
import type { Envelope } from "../src/services/protocol-types";
import { Store } from "../src/store/store";
import { FakeConnection, type HookProbe, type TestCtx, ext, groupRef, helloMsg, makeCtx, makeHooks, rawPost } from "./protocol-support";

let ctx: TestCtx;
let hooks: HookProbe;
let service: ProtocolService;

beforeEach(() => {
  ctx = makeCtx(Store.openInMemory());
  hooks = makeHooks();
  service = new ProtocolService({ hooks, desktopVersion: "9.9.9", now: () => 1_794_384_000_000 });
});

async function connect(profile = "p_7f3a", configRev = 0) {
  const conn = new FakeConnection(service.hub.connections.size + 1);
  const session = service.handleConnection(ctx, conn);
  conn.push(helloMsg(profile, configRev));
  await session.idle();
  return { conn, session };
}

const send = async (c: Awaited<ReturnType<typeof connect>>, msg: unknown) => {
  c.conn.push(msg);
  await c.session.idle();
};
const last = (conn: FakeConnection): Envelope => conn.sent[conn.sent.length - 1]!;

describe("hello / ping / config", () => {
  it("answers hello.ok with the hub revision, then pushes config.update for a stale extension", async () => {
    const { conn } = await connect("p1", 0);
    expect(conn.sent.map((e) => e.type)).toEqual(["hello.ok", "config.update"]);
    const ok = conn.sent[0]!;
    expect(ok.type === "hello.ok" && ok.payload).toEqual({ desktop_version: "9.9.9", config_rev: 1 });
    expect(ok.reply_to).toMatch(/^M\d+$/);
    const cfg = conn.sent[1]!;
    expect(cfg.type === "config.update" && cfg.payload.rev).toBe(1);
    expect(cfg.reply_to).toBeNull();
    expect(hooks.configProfiles).toEqual(["p1"]);
    expect(hooks.healthEmits).toBeGreaterThan(0);
  });

  it("skips config.update when the extension is current", async () => {
    const { conn } = await connect("p1", 1);
    expect(conn.sent.map((e) => e.type)).toEqual(["hello.ok"]);
  });

  it("replays an active pause with its reason after hello", async () => {
    service.hub.crawlPaused = true;
    service.hub.crawlPauseReason = "rate_limited";
    const { conn } = await connect("p1", 1);
    expect(conn.sent.map((e) => e.type)).toEqual(["hello.ok", "crawl.pause"]);
    expect(last(conn).payload).toEqual({ until: null, reason: "rate_limited" });
  });

  it("clears the disconnect alert flag and queues a recovery alert on hello", async () => {
    service.hub.incidents.extDisconnectedAlerted = true;
    await connect();
    expect(hooks.alerts).toEqual([{ kind: "extension_disconnected", resolved: true }]);
    expect(service.hub.incidents.extDisconnectedAlerted).toBe(false);
  });

  it("registers the connection, answers ping, and unregisters on close", async () => {
    const c = await connect("p1", 1);
    expect(service.hub.isAnyConnected()).toBe(true);
    const id = "PING1";
    await send(c, ext("ping", {}, id));
    expect(last(c.conn)).toMatchObject({ type: "pong", reply_to: id, payload: {} });

    c.conn.drop();
    expect(service.hub.isAnyConnected()).toBe(false);
    expect(service.hub.lastDisconnectedAt).toBe(1_794_384_000_000);
  });

  it("reports extension/session facts for the health snapshot", async () => {
    const c = await connect("p1", 1);
    await send(
      c,
      ext("session.status", { platform: "facebook", state: "ok", runtime: { automatic_scanning: true, paused: false, next_crawl_at: 50, last_crawl_at: null } }),
    );
    const snap = service.hub.healthSnapshot(1_794_384_000_000);
    expect(snap).toMatchObject({
      extension_connected: true,
      extension_version: "0.2.0",
      facebook_session: "ok",
      automatic_scanning: true,
      next_crawl_at: 50,
      runtime_checked_at: 1_794_384_000_000,
    });
    // Reports older than 90s are ignored.
    expect(service.hub.healthSnapshot(1_794_384_000_000 + 90_000).automatic_scanning).toBeNull();
  });
});

describe("posts.push", () => {
  it("creates a placeholder source pinned to the hello profile and counts accepted vs duplicate posts", async () => {
    const c = await connect("p_pinned", 1);
    await send(c, ext("posts.push", { run_id: "r1", source_ref: groupRef(), posts: [rawPost("1"), rawPost("2"), rawPost("1")] }, "PUSH1"));
    expect(last(c.conn)).toMatchObject({ type: "ack", reply_to: "PUSH1", payload: { accepted: 2, duplicates: 1 } });
    const source = ctx.store.sources.getByExternalId("facebook", "123456789")!;
    expect(source).toMatchObject({ name: "Group 123456789", url: "https://www.facebook.com/groups/123456789", profile_id: "p_pinned", followed: false });
    expect(hooks.ingested.map((i) => i.post.post_id)).toEqual(["1", "2", "1"]);
  });

  it("replays the stored ACK for a repeated message id without ingesting again", async () => {
    const c = await connect("p1", 1);
    const msg = ext("posts.push", { run_id: "r1", source_ref: groupRef(), posts: [rawPost("1")] }, "PUSH1");
    await send(c, msg);
    await send(c, msg);
    expect(c.conn.ofType("ack").map((a) => a.payload)).toEqual([
      { accepted: 1, duplicates: 0 },
      { accepted: 1, duplicates: 0 },
    ]);
    expect(hooks.ingested).toHaveLength(1);
  });

  it("routes a post of another group through its own source", async () => {
    const c = await connect("p1", 1);
    await send(c, ext("posts.push", { run_id: "r", source_ref: groupRef("111"), posts: [rawPost("1", "111"), rawPost("2", "222")] }));
    expect(hooks.ingested.map((i) => i.source.external_id)).toEqual(["111", "222"]);
    expect(ctx.store.sources.getByExternalId("facebook", "222")).not.toBeNull();
  });

  it("does not record a dedup entry when ingestion fails, so a retry is processed", async () => {
    const c = await connect("p1", 1);
    hooks.failIngestWith = new Error("disk full");
    await send(c, ext("posts.push", { run_id: "r", source_ref: groupRef(), posts: [rawPost("1")] }, "PUSH1"));
    expect(last(c.conn)).toMatchObject({
      type: "error",
      reply_to: "PUSH1",
      payload: { code: "internal", retryable: true, message: "lỗi nội bộ hệ thống: disk full" },
    });
    hooks.failIngestWith = null;
    await send(c, ext("posts.push", { run_id: "r", source_ref: groupRef(), posts: [rawPost("1")] }, "PUSH1"));
    expect(last(c.conn)).toMatchObject({ type: "ack", payload: { accepted: 1, duplicates: 0 } });
  });
});

describe("crawl.report", () => {
  const report = (status: string, over: Record<string, unknown> = {}, id?: string) =>
    ext(
      "crawl.report",
      {
        run_id: `run-${Math.random().toString(36).slice(2)}`,
        source_ref: groupRef(String(over.ext ?? "123456789")),
        reason: "scheduled",
        status,
        started_at: 1_794_384_890_000,
        ended_at: 1_794_384_909_500,
        posts_seen: 12,
        posts_new: 1,
        page_loads: 1,
        strategy: "network",
        ...over,
      },
      id,
    );

  it("records the run, resets source state, emits crawl:finished and acks (1, 0)", async () => {
    const c = await connect("p1", 1);
    await send(c, report("ok", { run_id: "r_01" }, "REP1"));
    expect(last(c.conn)).toMatchObject({ type: "ack", reply_to: "REP1", payload: { accepted: 1, duplicates: 0 } });
    const source = ctx.store.sources.getByExternalId("facebook", "123456789")!;
    expect(source.state).toBe("ok");
    const runs = ctx.store.sources.listCrawlRuns(source.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "r_01", status: "ok", posts_seen: 12, strategy: "network", ended_at: 1_794_384_909_500 });
    expect(ctx.events.find((e) => e.event === "crawl:finished")?.payload).toMatchObject({ id: "r_01", source_name: "Group 123456789", status: "ok" });
  });

  it("maps blocked and error to source state and last-error text", async () => {
    const c = await connect("p1", 1);
    await send(c, report("blocked", { ext: "1" }));
    await send(c, report("error", { ext: "2", error: "boom " }));
    const s1 = ctx.store.sources.getByExternalId("facebook", "1")!;
    const s2 = ctx.store.sources.getByExternalId("facebook", "2")!;
    expect([s1.state, s2.state]).toEqual(["inaccessible", "error"]);
    expect(getSourceLastErrors(ctx)).toEqual({ [s1.id]: "group blocked or inaccessible", [s2.id]: "boom" });

    await send(c, report("ok", { ext: "2" }));
    expect(ctx.store.sources.getByExternalId("facebook", "2")!.state).toBe("ok");
    expect(getSourceLastErrors(ctx)).toEqual({ [s1.id]: "group blocked or inaccessible" });
  });

  it("replays the ACK for a repeated report id", async () => {
    const c = await connect("p1", 1);
    const msg = report("ok", { run_id: "r_dup" }, "REP");
    await send(c, msg);
    await send(c, msg);
    expect(c.conn.ofType("ack")).toHaveLength(2);
    expect(ctx.events.filter((e) => e.event === "crawl:finished")).toHaveLength(1);
  });

  it("alerts once after 3 empty crawls of distinct sources, then recovers on a productive crawl", async () => {
    const c = await connect("p1", 1);
    await send(c, report("empty", { ext: "1", posts_seen: 0 }));
    await send(c, report("empty", { ext: "1", posts_seen: 0 }));
    await send(c, report("empty", { ext: "2", posts_seen: 0 }));
    expect(hooks.alerts).toEqual([]);
    await send(c, report("empty", { ext: "3", posts_seen: 0 }));
    await send(c, report("empty", { ext: "4", posts_seen: 0 }));
    expect(hooks.alerts).toEqual([{ kind: "extractor_broken", resolved: false }]);
    expect(service.hub.extractorBroken).toBe(true);

    await send(c, report("ok", { ext: "1", posts_seen: 5 }));
    expect(hooks.alerts.at(-1)).toEqual({ kind: "extractor_broken", resolved: true });
    expect(service.hub.extractorBroken).toBe(false);
    expect(service.hub.consecutiveEmptySources).toEqual([]);
  });

  it("does not count empty crawls while the Facebook session is not ok", async () => {
    const c = await connect("p1", 1);
    service.hub.facebookSession = "logged_out";
    for (const id of ["1", "2", "3"]) await send(c, report("empty", { ext: id, posts_seen: 0 }));
    expect(service.hub.extractorBroken).toBe(false);
  });
});

describe("sources.discovered", () => {
  const source = (id: string) => ({ platform: "facebook", kind: "group", external_id: id, name: `G${id}`, url: `https://www.facebook.com/groups/${id}/`, privacy: "private", member_count: 10 });

  it("upserts sources, pins the profile and acks the changed count", async () => {
    const c = await connect("p_a", 1);
    await send(c, ext("sources.discovered", { sources: [source("1"), source("2")] }, "DISC1"));
    expect(last(c.conn)).toMatchObject({ type: "ack", reply_to: "DISC1", payload: { accepted: 2, duplicates: 0 } });
    expect(ctx.store.sources.getByExternalId("facebook", "1")).toMatchObject({ name: "G1", privacy: "private", followed: false, profile_id: "p_a" });
    // No follow flag: the config revision is untouched.
    expect(service.hub.configRev).toBe(1);
  });

  it("caps follow=true at the plan limit, keeping already-followed sources", async () => {
    const c = await connect("p1", 1);
    hooks.maxGroups = 2;
    ctx.store.sources.upsertDiscovered([{ external_id: "1", name: "G1", url: "u" }], true, null, 1);
    await send(c, ext("sources.discovered", { sources: [source("1"), source("2"), source("3")], follow: true }));
    const followed = (id: string) => ctx.store.sources.getByExternalId("facebook", id)!.followed;
    expect([followed("1"), followed("2"), followed("3")]).toEqual([true, true, false]);
    expect(last(c.conn)).toMatchObject({ type: "ack", payload: { accepted: 3, duplicates: 0 } });
  });

  it("bumps and pushes config when follow is present and something changed", async () => {
    const c = await connect("p1", 1);
    await send(c, ext("sources.discovered", { sources: [source("1")], follow: false }));
    expect(service.hub.configRev).toBe(2);
    const cfgs = c.conn.ofType("config.update");
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]!.type === "config.update" && cfgs[0]!.payload.rev).toBe(2);
    // An empty list never bumps.
    await send(c, ext("sources.discovered", { sources: [], follow: true }));
    expect(service.hub.configRev).toBe(2);
  });

  it("replays the ACK for a repeated message id", async () => {
    const c = await connect("p1", 1);
    const msg = ext("sources.discovered", { sources: [source("1")], follow: true }, "D");
    await send(c, msg);
    await send(c, msg);
    expect(service.hub.configRev).toBe(2);
    expect(c.conn.ofType("ack")).toHaveLength(2);
  });
});

describe("session.status", () => {
  const status = (state: string) => ext("session.status", { platform: "facebook", state });

  it("halts crawling on logged_out, alerts once and tells every profile", async () => {
    const a = await connect("pa", 1);
    const b = await connect("pb", 1);
    await send(a, status("logged_out"));
    await send(a, status("logged_out"));
    expect(service.hub.crawlPaused).toBe(true);
    expect(service.hub.crawlPauseReason).toBe("logged_out");
    expect(b.conn.ofType("crawl.pause")[0]!.payload).toEqual({ until: null, reason: "facebook_logged_out" });
    expect(hooks.alerts).toEqual([{ kind: "facebook_session_issue", resolved: false }]);
    expect(last(a.conn)).toMatchObject({ type: "ack", payload: { accepted: 1, duplicates: 0 } });
  });

  it("maps unknown to logged_out and rate_limited to its own pause reason", async () => {
    const a = await connect("pa", 1);
    await send(a, status("unknown"));
    expect([service.hub.facebookSession, service.hub.crawlPauseReason]).toEqual(["logged_out", "logged_out"]);
    await send(a, status("rate_limited"));
    expect([service.hub.facebookSession, service.hub.crawlPauseReason]).toEqual(["rate_limited", "rate_limited"]);
  });

  it("auto-resumes after ok when the pause was logged_out, and sends the recovery alert", async () => {
    const a = await connect("pa", 1);
    await send(a, status("logged_out"));
    await send(a, status("ok"));
    expect([service.hub.crawlPaused, service.hub.crawlPauseReason, service.hub.facebookSession]).toEqual([false, null, "ok"]);
    expect(hooks.alerts.at(-1)).toEqual({ kind: "facebook_session_issue", resolved: true });
  });

  it("stays paused as checkpoint_awaiting_resume after a checkpoint clears", async () => {
    const a = await connect("pa", 1);
    await send(a, status("checkpoint"));
    await send(a, status("ok"));
    expect([service.hub.crawlPaused, service.hub.crawlPauseReason, service.hub.facebookSession]).toEqual([true, "checkpoint_awaiting_resume", "ok"]);
  });

  it("keeps a manual pause across an ok report", async () => {
    const a = await connect("pa", 1);
    service.setCrawlPaused(true);
    await send(a, status("ok"));
    expect(service.hub.crawlPauseReason).toBe("manual");
    expect(service.hub.crawlPaused).toBe(true);
  });
});

describe("malformed and offline behavior", () => {
  it("answers malformed JSON with invalid_payload and keeps the connection usable", async () => {
    const c = await connect("p1", 1);
    await send(c, "{broken");
    expect(last(c.conn)).toMatchObject({ type: "error", reply_to: null, payload: { code: "invalid_payload", retryable: false } });
    expect(c.conn.closed).toBe(false);
    await send(c, ext("ping", {}, "P"));
    expect(last(c.conn)).toMatchObject({ type: "pong", reply_to: "P" });
  });

  it("answers wrong protocol versions and unknown types with the incoming id", async () => {
    const c = await connect("p1", 1);
    await send(c, ext("ping", {}, "V3", { v: 3 }));
    expect(last(c.conn)).toMatchObject({ reply_to: "V3", payload: { code: "protocol_mismatch" } });
    await send(c, ext("telemetry.push", {}, "T1"));
    expect(last(c.conn)).toMatchObject({ reply_to: "T1", payload: { code: "unknown_type" } });
    await send(c, ext("posts.push", { run_id: "r" }, "BAD"));
    expect(last(c.conn)).toMatchObject({ reply_to: "BAD", payload: { code: "invalid_payload", message: "invalid payload: missing field `source_ref`" } });
  });

  it("rejects desktop-to-extension messages sent by the extension as unknown_type", async () => {
    const c = await connect("p1", 1);
    await send(c, ext("hello.ok", { desktop_version: "1", config_rev: 1 }, "WRONG"));
    expect(last(c.conn)).toMatchObject({
      reply_to: "WRONG",
      payload: { code: "unknown_type", retryable: false, message: "unexpected message direction for type 'hello.ok'" },
    });
  });

  it("maps validation errors to non-retryable invalid_payload and shutdown to retryable busy", async () => {
    const c = await connect("p1", 1);
    hooks.failIngestWith = CoreError.validation("bad post");
    await send(c, ext("posts.push", { run_id: "r", source_ref: groupRef(), posts: [rawPost("1")] }, "V"));
    expect(last(c.conn)).toMatchObject({
      reply_to: "V",
      payload: { code: "invalid_payload", retryable: false, message: "dữ liệu đầu vào không hợp lệ: bad post" },
    });

    ctx.shuttingDown = true;
    await send(c, ext("ping", {}, "S"));
    expect(last(c.conn)).toMatchObject({ reply_to: "S", payload: { code: "busy", retryable: true, message: "hệ thống đang tắt" } });
  });

  it("processes frames in order and pauses reads under a backlog", async () => {
    const conn = new FakeConnection(1);
    const session = service.handleConnection(ctx, conn);
    conn.push(helloMsg("p1", 1));
    for (let i = 0; i < 20; i += 1) conn.push(ext("ping", {}, `PING${i}`));
    expect(conn.paused).toBe(true);
    await session.idle();
    expect(conn.paused).toBe(false);
    expect(conn.ofType("pong").map((p) => p.reply_to)).toEqual(Array.from({ length: 20 }, (_v, i) => `PING${i}`));
  });

  it("survives a failing socket write", async () => {
    const c = await connect("p1", 1);
    c.conn.failSends = true;
    await send(c, ext("ping", {}, "P"));
    c.conn.failSends = false;
    await send(c, ext("ping", {}, "P2"));
    expect(last(c.conn)).toMatchObject({ type: "pong", reply_to: "P2" });
  });
});

describe("outbound helpers", () => {
  const sourceFor = (profile: string | null) => {
    ctx.store.sources.upsertDiscovered([{ external_id: "777", name: "G", url: "u" }], null, profile, 1);
    return ctx.store.sources.getByExternalId("facebook", "777")!;
  };

  it("pushCrawlRequest reaches only the pinned profile", async () => {
    const a = await connect("pa", 1);
    const b = await connect("pb", 1);
    const sent = service.pushCrawlRequest(sourceFor("pa"), "preview", 30, "req-1");
    expect(sent).toBe(1);
    expect(a.conn.ofType("crawl.request")[0]!.payload).toEqual({
      request_id: "req-1",
      source_ref: { platform: "facebook", kind: "group", external_id: "777" },
      reason: "preview",
      max_posts: 30,
    });
    expect(b.conn.ofType("crawl.request")).toHaveLength(0);
  });

  it("falls back to any profile when the pinned one is offline, and reports 0 when nobody is connected", async () => {
    const source = sourceFor("pa");
    expect(service.pushCrawlRequest(source, "manual", 10, "r0")).toBe(0);
    const b = await connect("pb", 1);
    expect(service.pushCrawlRequest(source, "manual", 10, "r1")).toBe(1);
    expect(b.conn.ofType("crawl.request")).toHaveLength(1);
  });

  it("broadcasts to an unpinned source", async () => {
    const a = await connect("pa", 1);
    const b = await connect("pb", 1);
    expect(service.pushCrawlRequest(sourceFor(null), "manual", 5, "r")).toBe(2);
    expect([a.conn.ofType("crawl.request").length, b.conn.ofType("crawl.request").length]).toEqual([1, 1]);
  });

  it("bumpAndPushConfig sends a per-profile plan at the new revision", async () => {
    await connect("pa", 1);
    await connect("pb", 1);
    hooks.configProfiles.length = 0;
    expect(service.bumpAndPushConfig()).toBe(2);
    expect(hooks.configProfiles.sort()).toEqual(["pa", "pb"]);
  });

  it("manual pause/resume broadcast once per transition and refuse resume during a session problem", async () => {
    const a = await connect("pa", 1);
    expect(service.setCrawlPaused(true)).toBe(true);
    expect(service.setCrawlPaused(true)).toBe(false);
    expect(a.conn.ofType("crawl.pause")).toHaveLength(1);
    expect(a.conn.ofType("crawl.pause")[0]!.payload).toEqual({ until: null, reason: "manual" });

    service.hub.facebookSession = "checkpoint";
    expect(() => service.setCrawlPaused(false)).toThrow(/phiên Facebook đang có sự cố/);
    service.hub.facebookSession = "ok";
    expect(service.setCrawlPaused(false)).toBe(true);
    expect(service.setCrawlPaused(false)).toBe(false);
    expect(a.conn.ofType("crawl.resume")).toHaveLength(1);
  });
});

describe("support pieces", () => {
  it("ensureSourceExists reuses a known source", () => {
    const first = ensureSourceExists(ctx, groupRef("5"), "p", 1);
    const again = ensureSourceExists(ctx, groupRef("5"), "other", 2);
    expect(again.id).toBe(first.id);
    expect(again.profile_id).toBe("p");
  });

  it("the dedup cache evicts the oldest entry and keeps a minimum capacity of 64", () => {
    const cache = new MessageDedupCache(1);
    for (let i = 0; i < 70; i += 1) cache.insert(`m${i}`, [i, 0]);
    expect(cache.size).toBe(64);
    expect(cache.get("m0")).toBeUndefined();
    expect(cache.get("m69")).toEqual([69, 0]);
    cache.insert("m69", [1, 1]);
    expect(cache.get("m69")).toEqual([1, 1]);
  });

  it("a hub is shareable between services", () => {
    const hub = new ProtocolHub();
    const a = new ProtocolService({ hooks, desktopVersion: "1", hub });
    const b = new ProtocolService({ hooks, desktopVersion: "1", hub });
    a.setCrawlPaused(true);
    expect(b.hub.crawlPaused).toBe(true);
  });
});
