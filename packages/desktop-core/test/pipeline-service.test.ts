// Behavior tests for the pipeline service on a real in-memory SQLite store: golden ingest ->
// evaluate -> lead flow, AI batch retry/idempotency, preview lifecycle + activation gate,
// cancellation, IPC peer protocol, scheduler and the 10 command handlers.

import { describe, expect, it } from "vitest";

import { InMemorySecretStore } from "../src/secrets/types";
import { Store } from "../src/store/store";
import { defaultMatchPolicy, defaultNotifyConfig, type FieldDef } from "../src/store/domain";
import type { BackendConfig } from "../src/backend/config";
import { CoreError, type OsNotificationPayload } from "../src/backend/wire";
import type { RuntimeContext } from "../src/backend/runtime";
import { seedRuleset } from "../src/rules/seed";
import { rulesetBodyToJson } from "../src/rules/engine";
import { computeCrawlPlan } from "../src/pipeline/scheduler";
import type { ProtocolEnvelope } from "../src/pipeline/runtime";
import type { RawPost } from "../src/pipeline/ingest";
import {
  AiHookError,
  type AiHooks,
  type JudgeBatchReport,
  type JudgeItemResult,
  type LeadNotificationInput,
  type PipelineHooks,
} from "../src/pipeline/types";
import { PipelineService } from "../src/services/pipeline";
import { PIPELINE_COMMANDS, PIPELINE_HANDLERS } from "../src/services/pipeline-handlers";

const T = 1_794_366_000_000;
const DEMAND = "vc tre can thue chung cu 2pn kv cau giay tai chinh tam 12tr/th lh o912 345 678";

const fd = (key: string, type: FieldDef["type"], required = false): FieldDef => ({
  key,
  label: key,
  type,
  description: "",
  required,
  options: null,
  show_in_alert: true,
  order: 0,
});

function rawPost(id: string, text: string, author = "a1", capturedAt = T): RawPost {
  return {
    platform: "facebook",
    post_id: id,
    source_external_id: "g1",
    permalink: `https://fb.test/${id}`,
    author: { external_id: author, name: `Author ${author}`, is_anonymous: false },
    text,
    text_truncated: false,
    created_at: T - 60_000,
    captured_at: capturedAt,
    attachments: [],
    extraction: { strategy: "dom", profile_rev: 1 },
  };
}

function judge(match: boolean, extra: Partial<JudgeItemResult> = {}): JudgeItemResult {
  return {
    ref: 1,
    match,
    score: match ? 0.9 : 0.1,
    intent: "demand",
    author_role: "end_user",
    is_spam: false,
    summary: "Cần thuê căn hộ",
    reason: "AI",
    fields: {},
    ...extra,
  };
}

interface FakeAi extends AiHooks {
  judgeCalls: Array<{ posts: Array<Record<string, unknown>>; preview: boolean }>;
}

function fakeAi(onJudge: (posts: Array<{ post_id: string; ref: number }>) => Promise<JudgeBatchReport> | JudgeBatchReport): FakeAi {
  const judgeCalls: FakeAi["judgeCalls"] = [];
  return {
    judgeCalls,
    providerId: () => "mock",
    async judgeExtractAll(_radar, posts, config) {
      judgeCalls.push({ posts: posts.map((p) => ({ ...p })), preview: config.preview });
      return onJudge(posts);
    },
    async suggestFields(input) {
      return {
        output: {
          suggested_name: "Thuê nhà",
          want_intent: "demand",
          fields: [
            { key: "price", label: "Giá", type: "money", description: "", required: false },
            { key: "area", label: "Diện tích", type: "range", description: "", required: false, options: null },
          ],
          hard_filters: [
            { field: "price", op: "lte", value: 15_000_000, when_missing: "fail" },
            { field: "ghost", op: "eq", value: 1, when_missing: "pass" },
          ],
          clarifying_questions: ["Khu vực nào?"],
          prefilter_hint: { any: ["thue"], none: ["cho thue"] },
          suggested_source_ids: input.source_candidates.map((c) => c.id),
        },
        calls: [
          {
            provider: "mock",
            model: null,
            task: "suggest_fields",
            radar_version_id: null,
            item_count: 1,
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: null,
            duration_ms: 3,
            status: "ok",
            error: null,
          },
        ],
      };
    },
    async compileRules() {
      throw new AiHookError("process", "not used");
    },
  };
}

const okCall = {
  provider: "mock",
  model: null,
  task: "judge_extract" as const,
  radar_version_id: null,
  item_count: 1,
  input_tokens: 1,
  output_tokens: 1,
  cost_usd: null,
  duration_ms: 1,
  status: "ok" as const,
  error: null,
};

function setup(hooks: PipelineHooks = {}, clock = { now: T }) {
  const store = Store.openInMemory();
  const events: Array<{ event: string; payload: unknown }> = [];
  const osNotifications: OsNotificationPayload[] = [];
  const ctx: RuntimeContext = {
    config: { appVersion: "9.9.9" } as unknown as BackendConfig,
    store,
    secrets: new InMemorySecretStore(),
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    notifyOs: (p) => {
      osNotifications.push(p);
    },
    isShuttingDown: () => false,
  };
  const service = PipelineService.for(ctx, {
    hooks: { now: () => clock.now, ...hooks },
    config: { spawnBackgroundWorkers: false, previewPollMs: 5, previewCrawlWaitMs: 50 },
  });
  const { source_ids } = store.sources.upsertDiscovered(
    [{ external_id: "g1", name: "Group 1", url: "https://www.facebook.com/groups/g1" }],
    true,
    "profile-1",
    T,
  );
  const makeRadar = (name: string, status: "draft" | "active", withSeed: boolean) => {
    const rw = store.radars.createDraft({
      name,
      description: "tìm thuê căn hộ",
      fields: [fd("location", "location"), fd("phone", "phone")],
      match_policy: defaultMatchPolicy(),
      notify: defaultNotifyConfig(),
      source_ids,
      now_ms: T,
    });
    if (withSeed) {
      store.radars.insertRuleset({
        radar_version_id: rw.current_version.id,
        state: "active",
        origin: "seed",
        body: rulesetBodyToJson(seedRuleset("bds-vi-v1")!),
        now_ms: T,
      });
    }
    if (status === "active") store.radars.setStatus(rw.radar.id, "active", T + 1);
    return store.radars.get(rw.radar.id)!;
  };
  const dbAll = <R = Record<string, unknown>>(sql: string): R[] => store.db.prepare(sql).all() as R[];
  return { store, ctx, service, events, osNotifications, sourceId: source_ids[0], makeRadar, dbAll, clock };
}

describe("ingest -> evaluate -> lead (golden)", () => {
  it("creates exactly one lead through the seed ruleset, notifies once and is idempotent", async () => {
    const routed: LeadNotificationInput[] = [];
    const t = setup({ notify: { routeLead: (i) => void routed.push(i), runJob: async () => undefined } });
    const radar = t.makeRadar("Thuê nhà", "active", true);

    const first = t.service.ingestRawPost(t.sourceId, rawPost("p1", DEMAND));
    expect(first.kind).toBe("processed");
    await t.service.runtime.drainBackground();

    const leads = t.dbAll<{ id: string; radar_id: string; score: number; summary: string; fields: string }>("SELECT * FROM leads");
    expect(leads).toHaveLength(1);
    expect(leads[0].radar_id).toBe(radar.radar.id);
    expect(leads[0].score).toBeCloseTo(0.92, 9);
    const fields = JSON.parse(leads[0].fields) as Record<string, { value: unknown }>;
    expect(fields.phone.value).toBe("+84912345678");
    expect((fields.location.value as { district: string }).district).toBe("Cầu Giấy");
    expect(Object.keys(fields)).toEqual([...Object.keys(fields)].sort());

    const evals = t.dbAll<{ decided_by: string; verdict: string; state: string; intent: string; author_role: string }>("SELECT * FROM evaluations");
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({ decided_by: "rule", verdict: "match", state: "done", intent: "demand", author_role: "end_user" });

    expect(t.events.filter((e) => e.event === "lead:new")).toHaveLength(1);
    expect(routed).toHaveLength(1);
    expect(routed[0].mode).toEqual({ kind: "live", repostAfter72h: false });
    expect(t.osNotifications).toEqual([{ lead_id: leads[0].id, radar_name: "Thuê nhà", summary: expect.any(String) }]);

    // Same (platform, post_id) again: stored once, no second lead/notification.
    const again = t.service.ingestRawPost(t.sourceId, rawPost("p1", DEMAND));
    expect(again.kind).toBe("duplicate_stored");
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(1);
    expect(routed).toHaveLength(1);
  });

  it("attaches a < 72h repost to the dup cluster with a `dedup/duplicate` evaluation", () => {
    const t = setup();
    t.makeRadar("Thuê nhà", "active", true);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", DEMAND, "a1"));
    const repost = t.service.ingestRawPost(t.sourceId, rawPost("p2", DEMAND, "a2", T + 1_000));
    expect(repost.kind).toBe("cluster_duplicate");
    const dedup = t.dbAll<{ reject_reason: string; verdict: string }>("SELECT * FROM evaluations WHERE decided_by = 'dedup'");
    expect(dedup).toEqual([expect.objectContaining({ reject_reason: "duplicate", verdict: "no_match" })]);
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(1);
  });

  it("rejects short and URL-only posts at T3 without queueing AI", () => {
    const t = setup();
    t.makeRadar("Thuê nhà", "active", true);
    t.service.ingestRawPost(t.sourceId, rawPost("s1", "Alo cần thuê"));
    t.service.ingestRawPost(t.sourceId, rawPost("s2", "https://www.facebook.com/groups/123/posts/789/"));
    const rows = t.dbAll<{ reject_reason: string; decided_by: string }>("SELECT * FROM evaluations ORDER BY created_at, id");
    expect(rows.map((r) => [r.decided_by, r.reject_reason])).toEqual([
      ["prefilter", "prefilter"],
      ["prefilter", "prefilter"],
    ]);
    expect(t.dbAll("SELECT id FROM jobs")).toHaveLength(0);
  });
});

describe("T5 AI batch jobs", () => {
  it("batches pending posts, sends sanitized prompts, retries with backoff and then recovers", async () => {
    let fail = true;
    const ai = fakeAi((posts) => {
      if (fail) throw new AiHookError("process", "CLI exited 1");
      return {
        outcomes: posts.map((p) => ({
          state: "done" as const,
          post_id: p.post_id,
          result: judge(true, {
            ref: p.ref,
            fields: { phone: { raw: "0912 345 678", value: "+84912345678", confidence: 0.9 } },
          }),
        })),
        calls: [{ ...okCall, radar_version_id: null }],
      };
    });
    const clock = { now: T };
    const t = setup({ ai }, clock);
    t.makeRadar("Thuê nhà", "active", false);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", "Cần thuê căn hộ gần Mỹ Đình, LH 0912 345 678 anh chị nào có nhắn em"));
    expect(t.dbAll<{ state: string }>("SELECT state FROM evaluations")).toEqual([{ state: "pending_ai" }]);
    expect(t.dbAll<{ run_at: number }>("SELECT run_at FROM jobs WHERE kind = 'evaluate_batch'")).toEqual([{ run_at: T + 45_000 }]);

    // Before the 45 s window nothing runs.
    expect(await t.service.tickJobs()).toBe(0);
    expect(ai.judgeCalls).toHaveLength(0);

    // Window elapsed: the AI call fails -> job re-queued with the 60 s backoff, evaluation stays pending.
    clock.now = T + 46_000;
    await t.service.tickJobs();
    expect(ai.judgeCalls).toHaveLength(1);
    expect(Object.keys(ai.judgeCalls[0].posts[0]).sort()).toEqual(
      ["author_name", "created_at_ms", "group_name", "post_id", "ref", "rule_hints", "text"].sort(),
    );
    const job = t.dbAll<{ state: string; attempts: number; run_at: number; error: string }>("SELECT * FROM jobs WHERE kind = 'evaluate_batch'")[0];
    expect(job).toMatchObject({ state: "queued", attempts: 1, run_at: T + 46_000 + 60_000 });
    expect(job.error).toContain("CLI exited 1");
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(0);
    expect((await t.service.healthGet()).ai_state).toBe("error");
    expect(t.dbAll<{ status: string }>("SELECT status FROM ai_calls")).toEqual([{ status: "error" }]);

    // Backoff elapsed and the provider recovered: exactly one lead, job done.
    fail = false;
    clock.now = T + 120_000;
    await t.service.tickJobs();
    await t.service.runtime.drainBackground();
    expect(t.dbAll<{ state: string }>("SELECT state FROM jobs WHERE kind = 'evaluate_batch'")).toEqual([{ state: "done" }]);
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(1);
    expect(t.dbAll<{ decided_by: string; verdict: string }>("SELECT * FROM evaluations")[0]).toMatchObject({ decided_by: "ai", verdict: "match" });
    expect((await t.service.healthGet()).ai_state).toBe("ok");

    // Re-running the loop is idempotent.
    await t.service.tickJobs();
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(1);
    expect(ai.judgeCalls).toHaveLength(2);
  });

  it("fails durable jobs explicitly when the AI hook is missing", async () => {
    const clock = { now: T };
    const t = setup({}, clock);
    t.makeRadar("Thuê nhà", "active", false);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", "Cần thuê căn hộ gần Mỹ Đình, anh chị nào có nhắn em nhé"));
    clock.now = T + 46_000;
    await t.service.tickJobs();
    const job = t.dbAll<{ state: string; error: string }>("SELECT * FROM jobs WHERE kind = 'evaluate_batch'")[0];
    expect(job.state).toBe("queued");
    expect(job.error).toContain("AI bridge chưa được cấu hình");
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(0);
  });
});

describe("preview lifecycle and activation gate", () => {
  it("streams a preview, restores it, and gates draft activation on the finished run", async () => {
    const ai = fakeAi(
      (posts) =>
        new Promise<JudgeBatchReport>((resolve) =>
          setTimeout(
            () =>
              resolve({
                outcomes: posts.map((p) => ({ state: "done" as const, post_id: p.post_id, result: judge(true, { ref: p.ref }) })),
                calls: [{ ...okCall }],
              }),
            40,
          ),
        ),
    );
    const t = setup({ ai });
    const radar = t.makeRadar("Thuê nhà", "draft", false);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", "Cần thuê căn hộ gần Mỹ Đình, anh chị nào có nhắn em nhé"));
    expect(t.dbAll("SELECT id FROM evaluations")).toHaveLength(0); // draft radars never evaluate live

    await expect(t.service.radarSetStatusFromDesktop(radar.radar.id, "active", null)).rejects.toThrow("Hãy xem thử bản nháp");

    const initial = await t.service.radarPreviewStart({ radar_id: radar.radar.id });
    expect(initial).toMatchObject({ status: "evaluating", total_posts: 1, evaluated_posts: 0, failed_posts: 0, items: [], error: null });
    await expect(t.service.radarPreviewStart({ radar_id: radar.radar.id })).rejects.toThrow("Radar đang xem thử");
    await t.service.runtime.drainBackground();

    const done = t.service.radarPreviewGet(radar.radar.id, null);
    expect(done.preview_id).toBe(initial.preview_id);
    expect(done.status).toBe("done");
    expect(done.evaluated_posts).toBe(1);
    expect(done.items[0]).toMatchObject({ verdict: "match", decided_by: "ai" });
    expect(done.warnings.map((w) => w.code)).toEqual(["too_broad"]);
    expect(ai.judgeCalls[0].preview).toBe(true);
    const progress = t.events.filter((e) => e.event === "preview:progress").map((e) => (e.payload as { status: string }).status);
    expect(progress[0]).toBe("evaluating");
    expect(progress.at(-1)).toBe("done");
    expect(t.dbAll("SELECT id FROM leads")).toHaveLength(0); // previews never create leads

    await expect(t.service.radarSetStatusFromDesktop(radar.radar.id, "active", "wrong-id")).rejects.toThrow("Cần hoàn tất xem thử");
    const active = await t.service.radarSetStatusFromDesktop(radar.radar.id, "active", initial.preview_id);
    expect(active.status).toBe("active");
    expect(active.source_ids).toEqual(radar.source_ids);
    expect(t.events.some((e) => e.event === "health:changed")).toBe(true);
  });

  it("cancel settles the run immediately even while the AI call is in flight", async () => {
    let release: (r: JudgeBatchReport) => void = () => undefined;
    const ai = fakeAi(() => new Promise<JudgeBatchReport>((resolve) => { release = resolve; }));
    const t = setup({ ai });
    const radar = t.makeRadar("Thuê nhà", "draft", false);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", "Cần thuê căn hộ gần Mỹ Đình, anh chị nào có nhắn em nhé"));
    const started = await t.service.radarPreviewStart({ radar_id: radar.radar.id });
    for (let i = 0; i < 200 && ai.judgeCalls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(ai.judgeCalls).toHaveLength(1);

    const cancelled = await t.service.radarPreviewCancel(radar.radar.id, started.preview_id);
    expect(cancelled.status).toBe("error");
    expect(cancelled.error).toContain("Đã dừng xem thử");
    release({ outcomes: [], calls: [] });
    await t.service.runtime.drainBackground();
    expect(t.service.radarPreviewGet(radar.radar.id, started.preview_id).status).toBe("error");
  });

  it("surfaces an AI failure as an errored preview with failed posts", async () => {
    const ai = fakeAi(() => {
      throw new AiHookError("timeout", "timeout");
    });
    const t = setup({ ai });
    const radar = t.makeRadar("Thuê nhà", "draft", false);
    t.service.ingestRawPost(t.sourceId, rawPost("p1", "Cần thuê căn hộ gần Mỹ Đình, anh chị nào có nhắn em nhé"));
    await t.service.radarPreviewStart({ radar_id: radar.radar.id });
    await t.service.runtime.drainBackground();
    const st = t.service.radarPreviewGet(radar.radar.id, null);
    expect(st.status).toBe("error");
    expect(st.failed_posts).toBe(1);
    expect(st.error).toContain("lỗi AI Bridge");
    expect(t.dbAll<{ state: string }>("SELECT state FROM evaluations")).toEqual([{ state: "ai_failed" }]);
  });
});

describe("radar_suggest_fields and license limits", () => {
  it("maps bridge output, keeps filters on known fields and records AI calls", async () => {
    const ai = fakeAi(() => ({ outcomes: [], calls: [] }));
    const t = setup({ ai });
    const out = await t.service.radarSuggestFields({ description: "tìm thuê căn hộ", suggest_sources: true });
    expect(out.fields.map((f) => [f.key, f.order, f.show_in_alert])).toEqual([["price", 0, true], ["area", 1, true]]);
    expect(out.hard_filters).toEqual([{ field: "price", op: "lte", value: 15_000_000, when_missing: "fail" }]);
    expect(out.suggested_source_ids).toEqual([t.sourceId]);
    expect(t.dbAll<{ task: string; item_count: number }>("SELECT task, item_count FROM ai_calls")).toEqual([{ task: "suggest_fields", item_count: 1 }]);
    await expect(t.service.radarSuggestFields({ description: "  " })).rejects.toThrow("Description cannot be empty");
  });

  it("enforces max active radars and gates compile on the Pro plan", async () => {
    const t = setup();
    const a = t.makeRadar("A", "draft", false);
    const b = t.makeRadar("B", "draft", false);
    const c = t.makeRadar("C", "draft", false);
    await t.service.radarSetStatus(a.radar.id, "active");
    await t.service.radarSetStatus(b.radar.id, "active");
    await expect(t.service.radarSetStatus(c.radar.id, "active")).rejects.toThrow("allows at most 2 active radars");
    await expect(t.service.rulesetCompileNow(a.radar.id)).rejects.toMatchObject({ code: "license_limit_exceeded" });
  });

  it("compiles inline on Pro and reports no ruleset without enough labeled samples", async () => {
    const t = setup({
      ai: fakeAi(() => ({ outcomes: [], calls: [] })),
      license: {
        limits: () => ({ max_active_radars: null, max_followed_groups: 50, max_fields_per_radar: 20, allow_xlsx_export: true, allow_webhooks: true, allow_auto_rulesets: true }),
      },
    });
    const a = t.makeRadar("A", "draft", false);
    const res = await t.service.rulesetCompileNow(a.radar.id);
    expect(res.ruleset).toBeNull();
    expect(t.dbAll<{ id: string; state: string }>("SELECT id, state FROM jobs WHERE kind = 'compile_ruleset'")).toEqual([{ id: res.job_id, state: "done" }]);
  });
});

describe("IPC peers, health and crawl pause", () => {
  it("handles hello/posts/crawl.report/session.status with dedup acks and pause control", async () => {
    const t = setup();
    const sent: ProtocolEnvelope[] = [];
    const peer = t.service.attachPeer({ send: (e) => void sent.push(e) });
    const env = (id: string, type: string, payload: Record<string, unknown>): ProtocolEnvelope => ({ v: 2, id, ts: T, reply_to: null, type, payload });

    peer.consume(env("m1", "hello", { profile_id: "profile-1", ext_version: "1.2.3", browser: "chrome", config_rev: 0 }));
    expect(sent.map((e) => e.type)).toEqual(["hello.ok", "config.update"]);
    expect(sent[0]).toMatchObject({ reply_to: "m1", payload: { desktop_version: "9.9.9", config_rev: 1 } });

    const push = (id: string, post: string) =>
      peer.consume(env(id, "posts.push", { run_id: "r1", source_ref: { platform: "facebook", kind: "group", external_id: "g1" }, posts: [rawPost(post, DEMAND)] }));
    push("m2", "p1");
    expect(sent.at(-1)).toMatchObject({ type: "ack", reply_to: "m2", payload: { accepted: 1, duplicates: 0 } });
    push("m2", "p1"); // replayed message id -> cached ack, no reprocessing
    expect(sent.at(-1)).toMatchObject({ type: "ack", payload: { accepted: 1, duplicates: 0 } });
    push("m3", "p1"); // new message, same post -> duplicate
    expect(sent.at(-1)).toMatchObject({ type: "ack", payload: { accepted: 0, duplicates: 1 } });

    peer.consume(
      env("m4", "crawl.report", {
        run_id: "run-1",
        source_ref: { platform: "facebook", kind: "group", external_id: "g1" },
        reason: "scheduled",
        status: "ok",
        started_at: T - 1000,
        ended_at: T,
        posts_seen: 3,
        posts_new: 1,
        page_loads: 2,
        strategy: "dom",
      }),
    );
    expect(sent.at(-1)).toMatchObject({ type: "ack", payload: { accepted: 1, duplicates: 0 } });
    expect(t.events.some((e) => e.event === "crawl:finished")).toBe(true);
    const runs = (await PIPELINE_HANDLERS.crawl_run_list!(t.ctx, {})) as Array<{ id: string; source_name: string; page_loads: number }>;
    expect(runs).toEqual([expect.objectContaining({ id: "run-1", source_name: "Group 1", page_loads: 2 })]);

    peer.consume(env("m5", "ping", {}));
    expect(sent.at(-1)).toMatchObject({ type: "pong", reply_to: "m5" });
    peer.consume(env("m6", "nope", {}));
    expect(sent.at(-1)).toMatchObject({ type: "error", reply_to: "m6", payload: { code: "invalid_payload", retryable: false } });

    // Facebook logs out: broadcast pause, health reflects it, resume is refused until the session is ok.
    peer.consume(env("m7", "session.status", { platform: "facebook", state: "logged_out", runtime: { paused: false, automatic_scanning: true } }));
    expect(sent.find((e) => e.type === "crawl.pause")).toMatchObject({ payload: { reason: "facebook_logged_out" } });
    let health = await t.service.healthGet();
    expect(health).toMatchObject({
      extension_connected: true,
      extension_version: "1.2.3",
      facebook_session: "logged_out",
      crawl_paused: true,
      crawl_pause_reason: "logged_out",
      automatic_scanning: true,
      page_loads_last_hour: 2,
    });
    await expect(t.service.toggleCrawlPaused()).rejects.toThrow("Không thể tiếp tục quét");
    peer.consume(env("m8", "session.status", { platform: "facebook", state: "ok" }));
    health = await t.service.healthGet();
    expect(health).toMatchObject({ facebook_session: "ok", crawl_paused: false, crawl_pause_reason: null });

    const before = sent.length;
    expect(await t.service.toggleCrawlPaused()).toMatchObject({ crawl_paused: true, crawl_pause_reason: "manual" });
    expect(sent[before]).toMatchObject({ type: "crawl.pause", payload: { reason: "manual" } });
    expect(await PIPELINE_HANDLERS["backend:toggle_crawl_paused"]!(t.ctx, {})).toMatchObject({ crawl_paused: false });
    expect(sent.at(-1)?.type).toBe("crawl.resume");

    peer.detach();
    expect((await t.service.healthGet()).extension_connected).toBe(false);
  });

  it("source_crawl_now pushes a crawl.request and reports whether any profile accepted it", async () => {
    const t = setup();
    expect(await PIPELINE_HANDLERS.source_crawl_now!(t.ctx, { id: t.sourceId })).toMatchObject({ queued: false });
    const sent: ProtocolEnvelope[] = [];
    const peer = t.service.attachPeer({ send: (e) => void sent.push(e) });
    peer.consume({ v: 2, id: "h", ts: T, reply_to: null, type: "hello", payload: { profile_id: "profile-1", ext_version: "1", browser: "chrome", config_rev: 1 } });
    const res = (await PIPELINE_HANDLERS.source_crawl_now!(t.ctx, { id: t.sourceId, reason: "preview" })) as { queued: boolean; run_id: string };
    expect(res.queued).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: "crawl.request",
      payload: { request_id: res.run_id, reason: "preview", max_posts: 25, source_ref: { platform: "facebook", kind: "group", external_id: "g1" } },
    });
    await expect(PIPELINE_HANDLERS.source_crawl_now!(t.ctx, { id: "missing" })).rejects.toBeInstanceOf(CoreError);
    await expect(PIPELINE_HANDLERS.source_crawl_now!(t.ctx, {})).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("handler table and scheduler", () => {
  it("exports exactly the assigned commands", () => {
    expect(Object.keys(PIPELINE_HANDLERS).sort()).toEqual([...PIPELINE_COMMANDS].sort());
    expect(PIPELINE_COMMANDS).toHaveLength(10);
  });

  it("validates handler arguments like Tauri parse_arg", async () => {
    const t = setup();
    await expect(PIPELINE_HANDLERS.radar_set_status!(t.ctx, { id: "x", status: "bogus" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(PIPELINE_HANDLERS.radar_preview_start!(t.ctx, { input: { radar_id: 5 } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(PIPELINE_HANDLERS.radar_preview_get!(t.ctx, { radar_id: "none" })).rejects.toMatchObject({ code: "not_found" });
    expect(await PIPELINE_HANDLERS.crawl_run_list!(t.ctx, { limit: 5 })).toEqual([]);
  });

  it("computes the crawl plan like the Rust scheduler (priority cap, velocity, hourly budget)", () => {
    const base = {
      platform: "facebook",
      kind: "group",
      privacy: "public",
      member_count: 10_000,
      profile_id: null,
      followed: true,
      state: "ok",
      created_at: 1,
    };
    const src = (id: string, priority: number, avg: number, crawled: boolean) => ({
      ...base,
      id,
      external_id: `ext_${id}`,
      name: id,
      url: "",
      priority,
      avg_new_posts: avg,
      last_crawl_at: crawled ? T : null,
    });
    const sources = [src("p1", 1, 5, true), src("p2", 1, 5, true), src("p3", 1, 5, true), src("p4", 1, 5, true), src("fast", 0, 15, true), src("quiet", 0, 0.1, true)];
    const settings = {
      group_interval_minutes: 15,
      priority_interval_minutes: 5,
      hourly_page_load_budget: 30,
      daily_page_load_budget: 300,
      active_hours: { from: "07:00", to: "23:00" },
      max_scroll_steps: 3,
      max_posts_per_visit: 25,
      only_when_idle: false,
    };
    const plan = computeCrawlPlan(sources, settings);
    expect(plan.entries).toHaveLength(6);
    expect(plan.entries.filter((e) => e.priority === 1)).toHaveLength(3);
    expect(plan.entries.find((e) => e.source_ref.external_id === "ext_quiet")!.interval_s).toBeGreaterThanOrEqual(3600);
    const scaled = computeCrawlPlan(sources, { ...settings, hourly_page_load_budget: 10 });
    expect(scaled.entries.reduce((n, e) => n + 3600 / e.interval_s, 0)).toBeLessThanOrEqual(10.0001);
  });
});
