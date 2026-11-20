import { describe, expect, it } from "vitest";

import {
  Store,
  type FieldDef,
  type FieldMap,
  type FieldType,
  type LeadListQuery,
  validateFieldValue,
} from "../src";

const fd = (key: string, type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
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

const T = 1_700_000_000_000;

function setup() {
  const store = Store.openInMemory();
  const { source_ids } = store.sources.upsertDiscovered(
    [
      { external_id: "g1", name: "Group 1", url: "https://fb.test/g1" },
      { external_id: "g2", name: "Group 2", url: "https://fb.test/g2" },
    ],
    true,
    "profile-1",
    T,
  );
  const radar = store.radars.createDraft({
    name: "Nhà",
    description: "tìm nhà",
    fields: [fd("price", "money"), fd("type", "enum", { options: ["rent", "sale"] }), fd("area", "number")],
    source_ids,
    now_ms: T,
  });
  return { store, sourceIds: source_ids, radar, n: 0 };
}
type Ctx = ReturnType<typeof setup>;

function addLead(
  ctx: Ctx,
  o: { price: [number, number]; type: string; area: number; summary: string; authorExt?: string; phones?: string[] },
) {
  const n = ++ctx.n;
  const [post] = ctx.store.posts.insert({
    platform: "facebook",
    external_id: `p${n}`,
    source_id: ctx.sourceIds[0],
    author: o.authorExt ? { external_id: o.authorExt, name: `Author ${o.authorExt}` } : null,
    permalink: `https://fb.test/p${n}`,
    text: o.summary,
    text_fold: o.summary.toLowerCase(),
    content_hash: `h${n}`,
    simhash: BigInt(n) * 7919n,
    extracted_phones: o.phones,
    captured_at: T + n,
    strategy: "dom",
  });
  const fields: FieldMap = {
    price: { value: { min: o.price[0], max: o.price[1], currency: "VND", period: "month" }, raw: null, confidence: 0.9, source: "ai" },
    type: { value: o.type, raw: null, confidence: 1, source: "rule" },
    area: { value: o.area, raw: null, confidence: 1, source: "rule" },
  };
  const ev = ctx.store.leads.upsertEvaluation({
    post_id: post.id,
    radar_version_id: ctx.radar.current_version.id,
    state: "done",
    decided_by: "ai",
    verdict: "match",
    score: 0.9,
    fields,
    created_at: T + n,
    decided_at: T + n,
  });
  const [lead] = ctx.store.leads.createLead({
    radar_id: ctx.radar.radar.id,
    radar_version_id: ctx.radar.current_version.id,
    post_id: post.id,
    evaluation_id: ev.id,
    score: 0.9 - n / 100,
    summary: o.summary,
    fields,
    now_ms: T + n,
  });
  return { post, ev, lead };
}

describe("sources", () => {
  it("upserts discovered sources and preserves `followed` when follow is null", () => {
    const store = Store.openInMemory();
    const first = store.sources.upsertDiscovered([{ external_id: "x", name: "X", url: "u", member_count: 5 }], true, null, T);
    expect(first).toMatchObject({ inserted: 1, updated: 0 });
    const again = store.sources.upsertDiscovered(
      [{ external_id: "x", name: "X2", url: "u2", privacy: "public" }],
      null,
      "prof",
      T + 1,
    );
    expect(again).toMatchObject({ inserted: 0, updated: 1, source_ids: first.source_ids });
    const rec = store.sources.get(first.source_ids[0])!;
    expect(rec).toMatchObject({ name: "X2", followed: true, member_count: 5, privacy: "public", profile_id: "prof", platform: "facebook", kind: "group" });
    store.sources.upsertDiscovered([{ external_id: "x", name: "X2", url: "u2" }], false, null, T + 2);
    expect(store.sources.countFollowed()).toBe(0);
    expect(() => store.sources.setState(rec.id, "weird")).toThrowError(/invalid source state 'weird'/);
    expect(store.sources.setState(rec.id, "inaccessible")).toBe(true);
    store.close();
  });

  it("records crawl runs, updating last_crawl_at and 24h average", () => {
    const ctx = setup();
    const sid = ctx.sourceIds[0];
    const run = (id: string, started: number, posts_new: number) =>
      ctx.store.sources.recordCrawlRun({ id, source_id: sid, reason: "manual", status: "ok", started_at: started, ended_at: started + 10, posts_seen: 10, posts_new, page_loads: 1 });
    run("r1", T, 4);
    const rec = run("r2", T + 1000, 8);
    expect(rec.source_name).toBe("Group 1");
    expect(ctx.store.sources.get(sid)).toMatchObject({ last_crawl_at: T + 1010, avg_new_posts: 6 });
    // upsert on conflicting id replaces counters
    run("r2", T + 1000, 2);
    expect(ctx.store.sources.get(sid)!.avg_new_posts).toBe(3);
    expect(ctx.store.sources.listCrawlRuns(sid, 10).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(ctx.store.sources.listCrawlRuns(null, 1)).toHaveLength(1);
    const list = ctx.store.sources.list(T + 5000);
    expect(list[0]).toMatchObject({ stored_post_count: 0, posts_last_24h: 0 });
    ctx.store.close();
  });

  it("lists sources of active radars", () => {
    const ctx = setup();
    expect(ctx.store.sources.listForActiveRadars()).toHaveLength(0);
    ctx.store.radars.setStatus(ctx.radar.radar.id, "active", T);
    expect(ctx.store.sources.listForActiveRadars()).toHaveLength(2);
    ctx.store.sources.setState(ctx.sourceIds[0], "inaccessible");
    expect(ctx.store.sources.listForActiveRadars()).toHaveLength(1);
    expect(ctx.store.sources.listActiveFollowed()).toHaveLength(1);
    ctx.store.close();
  });
});

describe("posts: ingest, dedup, peers", () => {
  it("inserts idempotently, extracts phones, tracks author stats and keeps 64-bit simhash", () => {
    const ctx = setup();
    const input = {
      platform: "facebook",
      external_id: "p1",
      source_id: ctx.sourceIds[0],
      author: { external_id: "a1", name: "An" },
      permalink: "https://p/1",
      text: "Cho thuê 0912 345 678",
      content_hash: "h1",
      simhash: -1n,
      extracted_phones: ["+84900000001"],
      captured_at: T,
      strategy: "dom",
    };
    const [post, isNew] = ctx.store.posts.insert(input);
    expect(isNew).toBe(true);
    expect(post.extracted_phones).toEqual(["+84900000001", "+84912345678"]);
    expect(post.simhash).toBe(-1n);
    expect(post.simhash_bands).toEqual([65535, 65535, 65535, 65535]);
    expect(post.is_cluster_head).toBe(true);
    const [again, isNew2] = ctx.store.posts.insert({ ...input, text: "changed" });
    expect(isNew2).toBe(false);
    expect(again.id).toBe(post.id);
    expect(ctx.store.posts.authorGet(post.author_id!)).toMatchObject({ post_count_7d: 1, group_count_7d: 1, external_id: "a1" });
    expect(ctx.store.posts.recordPhones(post.id, ["+84911111111"])).toBe(true);
    expect(ctx.store.posts.recordPhones("missing", [])).toBe(false);
    expect(ctx.store.posts.get(post.id)).toMatchObject({ source_name: "Group 1", author_name: "An" });
    // anonymous authors are not recorded
    const [anon] = ctx.store.posts.insert({ ...input, external_id: "p2", author: { name: "Anonymous", is_anonymous: true } });
    expect(anon.author_id).toBeNull();
    ctx.store.close();
  });

  it("finds exact and SimHash duplicates", () => {
    const ctx = setup();
    const base = { platform: "facebook", source_id: ctx.sourceIds[0], permalink: "p", text: "t", strategy: "dom" };
    const [a] = ctx.store.posts.insert({ ...base, external_id: "a", content_hash: "same", simhash: -1n, captured_at: T });
    const [b] = ctx.store.posts.insert({ ...base, external_id: "b", content_hash: "same", simhash: -2n, captured_at: T + 5 });
    const [c] = ctx.store.posts.insert({ ...base, external_id: "c", content_hash: "other", simhash: 0n, captured_at: T + 6 });
    expect(ctx.store.posts.findExactDup("same", T - 1)!.id).toBe(a.id);
    expect(ctx.store.posts.findExactDup("same", T - 1, a.id)!.id).toBe(b.id);
    expect(ctx.store.posts.findExactDup("same", T + 100)).toBeNull();
    const near = ctx.store.posts.findSimhashDups(-1n, 3, T - 1, c.id);
    expect(near.map((m) => [m.post.id, m.hamming_distance])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
    // distance 64 from `c`; wide search scans all posts
    expect(ctx.store.posts.findSimhashDups(-1n, 64, T - 1).map((m) => m.post.id)).toEqual([a.id, b.id, c.id]);
    ctx.store.close();
  });

  it("clusters duplicates and annotates existing leads within 72h", () => {
    const ctx = setup();
    const { post: head, lead } = addLead(ctx, { price: [1, 2], type: "rent", area: 10, summary: "Cho thuê A" });
    const [dup] = ctx.store.posts.insert({
      platform: "facebook",
      external_id: "dup",
      source_id: ctx.sourceIds[1],
      permalink: "https://dup",
      text: "Cho thuê A",
      content_hash: "h1",
      simhash: 5n,
      captured_at: T + 3600_000,
      strategy: "dom",
    });
    expect(() => ctx.store.posts.createOrAttachDupCluster(head.id, head.id)).toThrowError(/must be distinct/);
    expect(() => ctx.store.posts.createOrAttachDupCluster("nope", dup.id)).toThrowError(/post not found: nope/);
    const res = ctx.store.posts.createOrAttachDupCluster(head.id, dup.id);
    expect(res.is_repost_after_72h).toBe(false);
    expect(res.updated_lead_ids).toEqual([lead.id]);
    expect(res.cluster).toMatchObject({ size: 2, source_count: 2, head_post_id: head.id });
    expect(ctx.store.leads.getLead(lead.id)!.also_seen_in).toEqual([
      { post_id: dup.id, source_id: ctx.sourceIds[1], source_name: "Group 2", permalink: "https://dup", captured_at: T + 3600_000 },
    ]);
    expect(ctx.store.posts.get(dup.id)!.is_cluster_head).toBe(false);
    // a repost after 72h still joins the cluster but does not touch leads
    const [late] = ctx.store.posts.insert({
      platform: "facebook", external_id: "late", source_id: ctx.sourceIds[1], permalink: "l", text: "t",
      content_hash: "h1", simhash: 6n, captured_at: T + 80 * 3600_000, strategy: "dom",
    });
    const res2 = ctx.store.posts.createOrAttachDupCluster(head.id, late.id);
    expect(res2.is_repost_after_72h).toBe(true);
    expect(res2.updated_lead_ids).toEqual([]);
    ctx.store.close();
  });

  it("computes peer signals from author volume, cluster spread and shared phones", () => {
    const ctx = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: `s${i}`, authorExt: `author${i}`, phones: ["+84912345678"] }).post.id);
    }
    expect(ctx.store.posts.countDistinctAuthorsForPhone("+84912345678")).toBe(3);
    const sig = ctx.store.posts.getPeerSignals(ids[0], [], T + 10);
    expect(sig).toMatchObject({ max_distinct_authors_for_phone: 3, cluster_source_count: 1, author_followed_posts_7d: 1, signal_count: 1, is_peer_override: false });
    expect(() => ctx.store.posts.getPeerSignals("missing", [], T)).toThrowError(/post not found/);
    ctx.store.close();
  });

  it("searches and paginates stored posts", () => {
    const ctx = setup();
    addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "Căn hộ Cầu Giấy" });
    addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "Nhà Đống Đa" });
    expect(ctx.store.posts.search("cau giay", null, 10)).toHaveLength(1);
    expect(ctx.store.posts.search("dong da", ctx.sourceIds[0], 10)).toHaveLength(1);
    expect(ctx.store.posts.search("dong da", ctx.sourceIds[1], 10)).toHaveLength(0);
    expect(ctx.store.posts.search("*&^", null, 10)).toEqual([]);
    const page1 = ctx.store.posts.listBySource(ctx.sourceIds[0], null, 1);
    expect(page1).toHaveLength(1);
    const page2 = ctx.store.posts.listBySource(ctx.sourceIds[0], [page1[0].captured_at, page1[0].id], 10);
    expect(page2).toHaveLength(1);
    expect(page2[0].id).not.toBe(page1[0].id);
    expect(ctx.store.posts.listRecentForSources(ctx.sourceIds, 10)).toHaveLength(2);
    expect(ctx.store.posts.listRecentForSources(ctx.sourceIds, 10, T + 2)).toHaveLength(1);
    expect(ctx.store.posts.listRecentForSources([], 10)).toEqual([]);
    ctx.store.close();
  });
});

describe("radars and rulesets", () => {
  it("creates drafts with serde defaults and rejects bad fields", () => {
    const ctx = setup();
    expect(ctx.radar.radar).toMatchObject({ status: "draft", current_version: 1 });
    expect(ctx.radar.radar.notify).toEqual({ channel_ids: [], mode: "instant", min_score: 0.6, quiet_hours: null });
    expect(ctx.radar.current_version.match_policy).toEqual({ want_intent: "any", exclude_roles: ["peer"], hard_filters: [] });
    expect(ctx.radar.source_ids).toEqual([...ctx.sourceIds].sort());
    expect(() => ctx.store.radars.createDraft({ name: "x", description: "d", fields: [fd("Bad", "text")], now_ms: T })).toThrowError(/invalid dynamic field key 'Bad'/);
    expect(() => ctx.store.radars.createDraft({ name: "x", description: "d", fields: [fd("a", "text"), fd("a", "text")], now_ms: T })).toThrowError(/duplicate field key 'a'/);
    ctx.store.close();
  });

  it("versions definition edits and keeps a candidate until confirmed on active radars", () => {
    const { store, radar } = setup();
    const id = radar.radar.id;
    expect(() => store.radars.setStatus(id, "bogus", T)).toThrowError(/invalid radar status/);
    store.radars.setStatus(id, "active", T + 1);

    const nameOnly = store.radars.update(id, { name: "Renamed", now_ms: T + 2 });
    expect(nameOnly.version_created).toBeNull();
    expect(nameOnly.radar.radar.name).toBe("Renamed");

    const edit = store.radars.update(id, { description: "tìm căn hộ", now_ms: T + 3 });
    expect(edit.pending_confirmation).toBe(true);
    expect(edit.version_created!.version).toBe(2);
    expect(edit.radar.radar.current_version).toBe(1);
    expect(edit.radar.candidate_version!.version).toBe(2);
    expect(store.radars.versions(id).map((v) => v.version)).toEqual([2, 1]);

    // preview snapshots reuse an identical definition instead of creating a new version
    const snap = store.radars.previewSnapshot({ ...edit.radar.candidate_version! });
    expect(snap.id).toBe(edit.radar.candidate_version!.id);

    const confirmed = store.radars.confirmVersion(id, 2, T + 4);
    expect(confirmed.radar.current_version).toBe(2);
    expect(confirmed.candidate_version).toBeNull();
    expect(() => store.radars.confirmVersion(id, 9, T)).toThrowError(/radar_version not found: .*@v9/);

    const immediate = store.radars.update(id, { description: "again", activate_immediately: true, now_ms: T + 5 });
    expect(immediate.pending_confirmation).toBe(false);
    expect(immediate.radar.radar.current_version).toBe(3);
    store.close();
  });

  it("manages ruleset lifecycles", () => {
    const { store, radar } = setup();
    const vid = radar.current_version.id;
    const a = store.radars.insertRuleset({ radar_version_id: vid, state: "active", origin: "seed", body: { rules: [] }, now_ms: T });
    expect(a).toMatchObject({ revision: 1, state: "active", activated_at: T });
    const b = store.radars.insertRuleset({ radar_version_id: vid, state: "active", origin: "compiled", body: {}, metrics: { f1: 0.9 }, now_ms: T + 1 });
    expect(b.revision).toBe(2);
    expect(store.radars.getActiveRuleset(vid)!.id).toBe(b.id);
    const shadow = store.radars.insertRuleset({ radar_version_id: vid, state: "shadow", origin: "compiled", body: {}, now_ms: T + 2 });
    expect(store.radars.getShadowRuleset(vid)!.id).toBe(shadow.id);
    const promoted = store.radars.updateRulesetState(shadow.id, "active", { gate: "ok" }, T + 3);
    expect(promoted).toMatchObject({ state: "active", metrics: { gate: "ok" }, activated_at: T + 3 });
    expect(store.radars.listRulesets(vid).map((r) => [r.revision, r.state])).toEqual([
      [3, "active"],
      [2, "retired"],
      [1, "retired"],
    ]);
    expect(() => store.radars.insertRuleset({ radar_version_id: vid, state: "x", origin: "seed", body: {}, now_ms: T })).toThrowError(/invalid ruleset state/);
    expect(() => store.radars.updateRulesetState("none", "active", null, T)).toThrowError(/ruleset not found: none/);
    store.close();
  });

  it("reports funnel stats", () => {
    const ctx = setup();
    addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "x" });
    const stats = ctx.store.radars.stats(ctx.radar.radar.id, T + 100);
    expect(stats).toMatchObject({ total_evaluated: 1, ai_decided: 1, ai_matched: 1, leads_total: 1, leads_weak_match: 0, rule_handled_ratio: 0 });
    expect(Object.keys(stats)[0]).toBe("total_evaluated");
    expect(ctx.store.radars.stats(null, T + 100).total_evaluated).toBe(1);
    const list = ctx.store.radars.list(false, T + 100);
    expect(list[0]).toMatchObject({ leads_24h: 1, evaluated_posts_total: 1, false_positive_rate: 0 });
    ctx.store.close();
  });
});

describe("leads", () => {
  it("creates leads idempotently with a created event and CRM updates", () => {
    const ctx = setup();
    const { lead, ev, post } = addLead(ctx, { price: [10, 12], type: "rent", area: 40, summary: "Cho thuê căn hộ" });
    const [same, created] = ctx.store.leads.createLead({
      radar_id: lead.radar_id, radar_version_id: lead.radar_version_id, post_id: post.id, evaluation_id: ev.id,
      score: 0.1, summary: "ignored", fields: {}, now_ms: T + 99,
    });
    expect(created).toBe(false);
    expect(same.id).toBe(lead.id);

    expect(() => ctx.store.leads.setStatus(lead.id, "bogus", T)).toThrowError(/invalid lead status/);
    expect(ctx.store.leads.setStatus(lead.id, "contacted", T + 10).status).toBe("contacted");
    const updated = ctx.store.leads.setNoteTagsFollowUp(lead.id, "gọi lại", ["vip"], T + 500, T + 11);
    expect(updated).toMatchObject({ note: "gọi lại", tags: ["vip"], follow_up_at: T + 500 });

    const detail = ctx.store.leads.leadGet(lead.id)!;
    expect(detail.events.map((e) => e.kind)).toEqual(["created", "status_changed", "noted"]);
    expect(detail.events[1].data).toEqual({ from: "new", to: "contacted" });
    expect(detail.evaluation).toMatchObject({ radar_version: 1, decided_by: "ai", verdict: "match" });
    expect(detail.radar_name).toBe("Nhà");

    expect(() => ctx.store.leads.setStatus("nope", "new", T)).toThrowError(/lead not found: nope/);
    ctx.store.leads.markRead(lead.id, T + 20);
    ctx.store.leads.markRead(lead.id, T + 99);
    expect(ctx.store.leads.getLead(lead.id)!.read_at).toBe(T + 20);
    ctx.store.close();
  });

  it("claims due follow-ups exactly once per scheduled time", () => {
    const ctx = setup();
    const { lead } = addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "s" });
    ctx.store.leads.setNoteTagsFollowUp(lead.id, null, null, T + 500, T + 5);
    expect(ctx.store.leads.claimDueFollowUps(T + 499)).toEqual([]);
    expect(ctx.store.leads.claimDueFollowUps(T + 600)).toEqual([lead.id]);
    expect(ctx.store.leads.claimDueFollowUps(T + 700)).toEqual([]);
    ctx.store.leads.setNoteTagsFollowUp(lead.id, null, null, T + 900, T + 701); // rescheduled
    expect(ctx.store.leads.claimDueFollowUps(T + 1000)).toEqual([lead.id]);
    ctx.store.leads.setStatus(lead.id, "won", T + 1001);
    ctx.store.leads.setNoteTagsFollowUp(lead.id, null, null, T + 1100, T + 1002);
    expect(ctx.store.leads.claimDueFollowUps(T + 2000)).toEqual([]); // closed leads do not remind
    ctx.store.close();
  });

  it("validates and records manual field edits as user-sourced", () => {
    const ctx = setup();
    const { lead } = addLead(ctx, { price: [10, 12], type: "rent", area: 40, summary: "s" });
    expect(() => ctx.store.leads.updateField(lead.id, "Price", 1, null, T)).toThrowError(/invalid dynamic field key/);
    expect(() => ctx.store.leads.updateField(lead.id, "nope", 1, null, T)).toThrowError(/unknown field 'nope' for radar Some\(/);
    expect(() => ctx.store.leads.updateField(lead.id, "price", 15, null, T)).toThrowError(/Giá trị không đúng kiểu dữ liệu của trường ‘price’/);
    const updated = ctx.store.leads.updateField(lead.id, "area", 55, "55m2", T + 1);
    expect(updated.fields.area).toEqual({ value: 55, raw: "55m2", confidence: 1, source: "user" });
    const ev = ctx.store.leads.leadGet(lead.id)!.events.find((e) => e.kind === "field_edited")!;
    expect(ev.data).toEqual({ field: "area", old: 40, new: 55 });
    expect(Object.keys(updated.fields)).toEqual(["area", "price", "type"]);
    ctx.store.close();
  });

  it("derives feedback expectations and hides negatively-labelled leads", () => {
    const ctx = setup();
    const { lead, ev } = addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "s" });
    expect(() => ctx.store.leads.recordFeedback({ evaluation_id: ev.id, label: "bogus", origin: "app", now_ms: T })).toThrowError(/invalid feedback label/);
    expect(() => ctx.store.leads.recordFeedback({ evaluation_id: ev.id, label: "spam", origin: "mail", now_ms: T })).toThrowError(/invalid feedback origin/);
    expect(() => ctx.store.leads.recordFeedback({ evaluation_id: "zzz", label: "spam", origin: "app", now_ms: T })).toThrowError(/evaluation not found: zzz/);

    const ok = ctx.store.leads.recordFeedback({ evaluation_id: ev.id, label: "correct", origin: "app", now_ms: T + 1 });
    expect(ok).toMatchObject({ expected_match: true, post_text: "s", radar_version_id: ev.radar_version_id });
    expect(ctx.store.leads.getLead(lead.id)!.status).toBe("new");
    const bad = ctx.store.leads.recordFeedback({ evaluation_id: ev.id, label: "peer", origin: "app", now_ms: T + 2 });
    expect(bad.expected_match).toBe(false);
    expect(ctx.store.leads.getLead(lead.id)!.status).toBe("ignored");

    const examples = ctx.store.leads.getPromptFeedbackExamples(ev.radar_version_id, 8);
    expect(examples.map((e) => e.label)).toEqual(["correct", "peer"]);
    const dataset = ctx.store.leads.getLabeledDataset(ev.radar_version_id);
    expect(dataset).toHaveLength(1); // one sample per post, feedback wins over AI-confidence
    expect(dataset[0]).toMatchObject({ is_match: false, author_role: "peer", origin: { feedback: "peer" } });
    ctx.store.close();
  });

  it("queues pending AI evaluations and marks them done or failed", () => {
    const ctx = setup();
    const mk = (n: number, preview = false) => {
      const [post] = ctx.store.posts.insert({ platform: "facebook", external_id: `q${n}`, source_id: ctx.sourceIds[0], permalink: "p", text: "t", content_hash: `q${n}`, simhash: BigInt(n), captured_at: T + n, strategy: "dom" });
      return ctx.store.leads.upsertEvaluation({ post_id: post.id, radar_version_id: ctx.radar.current_version.id, state: "pending_ai", is_preview: preview, created_at: T + n });
    };
    const e1 = mk(1);
    mk(2);
    mk(3, true);
    const groups = ctx.store.leads.listPendingAiBatches();
    expect(groups.map((g) => [g.is_preview, g.count, g.oldest_created_at])).toEqual([
      [false, 2, T + 1],
      [true, 1, T + 3],
    ]);
    expect(groups[0].items[0].evaluation.radar_version_id).toBe(ctx.radar.current_version.id);
    expect(groups[0].items[0].post.simhash).toBe(1n);
    expect(() => ctx.store.leads.upsertEvaluation({ post_id: "x", radar_version_id: "y", state: "weird", created_at: 0 })).toThrowError(/invalid evaluation state/);

    const done = ctx.store.leads.markEvaluationDone(e1.id, { decided_by: "ai", verdict: "no_match", reject_reason: "irrelevant", score: 0.1, decided_at: T + 10 });
    expect(done).toMatchObject({ state: "done", verdict: "no_match" });
    expect(ctx.store.leads.listPendingAiForVersion(ctx.radar.current_version.id, false, 10)).toHaveLength(1);
    expect(ctx.store.posts.listRejectedEvaluations(ctx.radar.radar.id, 10).map((r) => r.evaluation_id)).toEqual([e1.id]);
    expect(() => ctx.store.leads.markEvaluationDone("none", { decided_by: "ai", verdict: "match", decided_at: 1 })).toThrowError(/evaluation not found: none/);

    const pending = ctx.store.leads.listPendingAiForVersion(ctx.radar.current_version.id, false, 10)[0];
    expect(ctx.store.leads.markEvaluationAiFailed(pending.evaluation.id, null, "timeout", T + 11)).toBe(true);
    expect(ctx.store.leads.requeueAiFailedEvaluations()).toBe(1);
    expect(ctx.store.leads.cleanupPreviewEvaluations(null, null)).toBe(1);
    expect(ctx.store.leads.countAiEvaluationsForVersion(ctx.radar.current_version.id)).toEqual([1, 0]);
    ctx.store.close();
  });

  describe("dynamic list query", () => {
    function seedThree() {
      const ctx = setup();
      const a = addLead(ctx, { price: [10, 12], type: "rent", area: 40, summary: "Cho thuê căn hộ Cầu Giấy" });
      const b = addLead(ctx, { price: [20, 25], type: "sale", area: 60, summary: "Bán nhà Đống Đa" });
      const c = addLead(ctx, { price: [30, 40], type: "rent", area: 80, summary: "Thuê phòng trọ" });
      return { ctx, a: a.lead.id, b: b.lead.id, c: c.lead.id };
    }
    const ids = (page: { items: Array<{ lead: { id: string } }> }) => page.items.map((i) => i.lead.id);
    const rid = (s: ReturnType<typeof seedThree>) => s.ctx.radar.radar.id;
    const q = (s: ReturnType<typeof seedThree>, extra: Partial<LeadListQuery>) =>
      s.ctx.store.leads.list({ radar_id: rid(s), ...extra });

    it("sorts newest first and paginates with offset cursors", () => {
      const s = seedThree();
      const p1 = q(s, { limit: 2 });
      expect(ids(p1)).toEqual([s.c, s.b]);
      expect(p1).toMatchObject({ total: 3, next_cursor: "off:2" });
      const p2 = q(s, { limit: 2, cursor: p1.next_cursor });
      expect(ids(p2)).toEqual([s.a]);
      expect(p2.next_cursor).toBeNull();
      expect(() => q(s, { cursor: "off:xyz" })).toThrowError(/invalid pagination cursor 'off:xyz'/);
      expect(ids(q(s, { sort: { by: "score", dir: "desc" } }))).toEqual([s.a, s.b, s.c]);
    });

    it("filters money/range fields by interval semantics", () => {
      const s = seedThree();
      expect(ids(q(s, { filters: [{ field: "price", op: "lte", value: 25 }] })).sort()).toEqual([s.a, s.b].sort());
      expect(ids(q(s, { filters: [{ field: "price", op: "gte", value: 20 }] })).sort()).toEqual([s.b, s.c].sort());
      expect(ids(q(s, { filters: [{ field: "price", op: "eq", value: 22 }] }))).toEqual([s.b]);
      expect(ids(q(s, { filters: [{ field: "price", op: "between", value: [15, 45] }] })).sort()).toEqual([s.b, s.c].sort());
      expect(ids(q(s, { filters: [{ field: "price", op: "between", value: { min: "5", max: "13" } }] }))).toEqual([s.a]);
      // Rust pushes the JSON-path parameters before returning "0 = 1" for an empty `in` list, so the
      // statement is prepared with more parameters than it references and SQLite rejects it. The port
      // keeps that behaviour (an error) rather than silently "fixing" it.
      expect(() => q(s, { filters: [{ field: "price", op: "in", value: [] }] })).toThrow();
    });

    it("filters enum, number and sorts by dynamic fields", () => {
      const s = seedThree();
      expect(ids(q(s, { filters: [{ field: "type", op: "in", value: ["rent"] }] })).sort()).toEqual([s.a, s.c].sort());
      expect(ids(q(s, { filters: [{ field: "type", op: "ne", value: "rent" }] }))).toEqual([s.b]);
      expect(ids(q(s, { filters: [{ field: "area", op: "gt", value: "50" }] })).sort()).toEqual([s.b, s.c].sort());
      expect(ids(q(s, { filters: [{ field: "type", op: "is_empty", value: false }] }))).toHaveLength(3);
      expect(ids(q(s, { sort: { by: "price", dir: "asc" } }))).toEqual([s.a, s.b, s.c]);
      expect(ids(q(s, { sort: { by: "area", dir: "desc" } }))).toEqual([s.c, s.b, s.a]);
      expect(ids(q(s, { filters: [{ field: "area", op: "gte", value: 40 }, { field: "type", op: "eq", value: "rent" }] })).sort()).toEqual([s.a, s.c].sort());
    });

    it("validates filter/sort fields against the radar whitelist", () => {
      const s = seedThree();
      expect(() => q(s, { filters: [{ field: "Bad;--", op: "eq", value: 1 }] })).toThrowError(/invalid dynamic field key 'Bad;--'/);
      expect(() => q(s, { filters: [{ field: "nope", op: "eq", value: 1 }] })).toThrowError(/unknown field 'nope' for radar Some\(/);
      expect(() => q(s, { sort: { by: "nope" } })).toThrowError(/unknown field 'nope'/);
      expect(() => q(s, { filters: [{ field: "area", op: "gt", value: "abc" }] })).toThrowError(/invalid filter value for field 'area' \(Gt\): expected numeric value/);
      expect(() => q(s, { filters: [{ field: "area", op: "between", value: [1] }] })).toThrowError(/\(Between\): expected \[min, max\]/);
      expect(() => s.ctx.store.leads.list({ radar_id: "missing" })).toThrowError(/radar not found: missing/);
    });

    it("applies status, read, score, search and expiry filters", () => {
      const s = seedThree();
      s.ctx.store.leads.setStatus(s.a, "won", T + 100);
      s.ctx.store.leads.markRead(s.b, T + 101);
      expect(ids(q(s, { status: ["won"] }))).toEqual([s.a]);
      expect(ids(q(s, { unread_only: true })).sort()).toEqual([s.a, s.c].sort());
      expect(ids(q(s, { min_score: 0.885 }))).toEqual([s.a]);
      expect(ids(q(s, { since: T + 3 }))).toEqual([s.c]);
      expect(ids(q(s, { search: "thue" })).sort()).toEqual([s.a, s.c].sort());
      expect(ids(q(s, { search: "dong da" }))).toEqual([s.b]);
      expect(ids(q(s, { search: "*" }))).toEqual([]);
      expect(ids(q(s, { search: "   " }))).toHaveLength(3);
      // lead lifetime counts from the post time and needs `lead_ttl_hours`
      s.ctx.store.radars.update(rid(s), { notify: { channel_ids: [], mode: "instant", min_score: 0.6, quiet_hours: null, lead_ttl_hours: 1 }, now_ms: T + 200 });
      const later = T + 2 * 3_600_000;
      expect(ids(q(s, { expiry: { expired: true, now_ms: later } }))).toHaveLength(3);
      expect(ids(q(s, { expiry: { expired: false, now_ms: later } }))).toHaveLength(0);
      expect(ids(q(s, { expiry: { expired: false, now_ms: T + 10 } }))).toHaveLength(3);
    });

    it("lists across radars without a radar id using current-version fields", () => {
      const s = seedThree();
      expect(s.ctx.store.leads.list({ filters: [{ field: "area", op: "lt", value: 50 }] }).items).toHaveLength(1);
    });
  });
});

describe("contacts and blocklist", () => {
  it("creates, merges and notes contacts", () => {
    const store = Store.openInMemory();
    expect(store.contacts.upsertFromLead(null, "x", [" "], T)).toBeNull();
    const c1 = store.contacts.upsertFromLead("a1", " An ", ["+84912345678", "+84912345678"], T)!;
    expect(c1).toMatchObject({ display_name: "An", phones: ["+84912345678", "+84912345678"], author_ids: ["a1"] });
    const c1b = store.contacts.upsertFromLead("a2", null, ["+84912345678"], T + 1)!;
    expect(c1b.id).toBe(c1.id);
    expect(c1b).toMatchObject({ phones: ["+84912345678"], author_ids: ["a1", "a2"], updated_at: T + 1 });
    const c2 = store.contacts.upsertFromLead("a3", "Binh", ["+84900000000"], T + 2)!;
    expect(c2.id).not.toBe(c1.id);
    store.contacts.setNote(c2.id, "ghi chú 2", T + 3);
    store.contacts.setNote(c1.id, "ghi chú 1", T + 3);
    const merged = store.contacts.upsertFromLead("a3", null, ["+84912345678"], T + 4)!;
    expect(merged.id).toBe(c1.id); // oldest wins
    expect(merged.phones).toEqual(["+84900000000", "+84912345678"]);
    expect(merged.author_ids).toEqual(["a1", "a2", "a3"]);
    expect(merged.note).toBe("ghi chú 1\nghi chú 2");
    expect(store.contacts.list(null, 10)).toHaveLength(1);
    expect(store.contacts.list("ghi chu 2", 10)).toHaveLength(1);
    expect(store.contacts.list("zzz", 10)).toHaveLength(0);
    expect(store.contacts.get(c1.id)!.leads).toEqual([]);
    expect(store.contacts.get("none")).toBeNull();
    expect(store.contacts.setNote("none", null, T)).toBeNull();
    store.close();
  });

  it("matches blocklist entries by author id/external id, phone and folded keyword", () => {
    const ctx = setup();
    const { post } = addLead(ctx, { price: [1, 2], type: "rent", area: 1, summary: "s", authorExt: "ext9" });
    const bl = ctx.store.blocklist;
    expect(() => bl.add("bogus", "x", null, null, T)).toThrowError(/invalid blocklist kind/);
    expect(() => bl.add("phone", "  ", null, null, T)).toThrowError(/cannot be empty/);
    const k = bl.add("keyword", " Môi giới ", null, "spam", T);
    expect(k.value).toBe("Môi giới");
    expect(bl.add("keyword", "Môi giới", null, null, T + 1).id).toBe(k.id);
    bl.add("phone", "+84911111111", null, null, T);
    bl.add("author", "ext9", ctx.radar.radar.id, null, T);

    expect(bl.findMatching(null, null, [], "tin cua moi gioi nha dat")!.id).toBe(k.id);
    expect(bl.isBlocked(null, null, ["+84911111111"], null)).toBe(true);
    expect(bl.isBlocked(null, null, ["+84922222222"], "sach")).toBe(false);
    // radar-scoped author entry only applies for that radar, via either id form
    expect(bl.isBlocked(null, "ext9", [], null)).toBe(false);
    expect(bl.isBlocked(ctx.radar.radar.id, "ext9", [], null)).toBe(true);
    expect(bl.isBlocked(ctx.radar.radar.id, post.author_id, [], null)).toBe(true);
    expect(bl.list(null)).toHaveLength(3);
    expect(bl.list("other")).toHaveLength(2);
    expect(bl.remove(k.id)).toBe(true);
    expect(bl.remove(k.id)).toBe(false);
    ctx.store.close();
  });
});

describe("validateFieldValue", () => {
  const ok = (type: FieldType, value: unknown, extra: Partial<FieldDef> = {}) =>
    expect(() => validateFieldValue(fd("f", type, extra), value)).not.toThrow();
  const bad = (type: FieldType, value: unknown, extra: Partial<FieldDef> = {}) =>
    expect(() => validateFieldValue(fd("f", type, extra), value)).toThrowError(/Giá trị không đúng kiểu dữ liệu/);

  it("accepts null for every type", () => {
    for (const t of ["text", "number", "money", "enum", "date", "url"] as FieldType[]) ok(t, null);
  });
  it("validates scalars", () => {
    ok("number", 3.5);
    bad("number", "3");
    ok("boolean", false);
    bad("boolean", 0);
    ok("text", "x");
    bad("phone", 5);
    ok("enum", "a", { options: ["a", "b"] });
    bad("enum", "c", { options: ["a", "b"] });
    ok("enum", "anything", { options: [] });
    ok("multi_enum", ["a"], { options: ["a", "b"] });
    bad("multi_enum", ["a", "z"], { options: ["a", "b"] });
  });
  it("validates money and range intervals", () => {
    ok("money", { min: 1, max: 2, currency: "VND", period: "month" });
    ok("money", { min: 1, max: 1, currency: "USD", period: null });
    bad("money", 15);
    bad("money", { min: 20, max: 10, currency: "VND", period: null });
    bad("money", { min: -1, max: 10, currency: "VND", period: null });
    bad("money", { min: 1, max: 2, currency: "vnd", period: null });
    bad("money", { min: 1, max: 2, currency: "VND", period: "week" });
    ok("range", { min: 1, max: 2, unit: "m2" });
    bad("range", { min: 1, max: 2 });
  });
  it("validates location, dates and urls", () => {
    ok("location", { raw: "Cầu Giấy", province: "Hà Nội", district: null });
    bad("location", { raw: 1 });
    bad("location", { raw: "x", ward: 3 });
    ok("date", "2024-02-29");
    bad("date", "2023-02-29");
    bad("date", "2024-13-01");
    bad("date", "24-01-01");
    bad("date", "2024-1-01");
    ok("url", "https://example.com/a");
    bad("url", "ftp://example.com");
    bad("url", "https://exa mple.com");
    bad("url", "https://");
  });
});
