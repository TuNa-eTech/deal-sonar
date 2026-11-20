import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BACKEND_COMMANDS, CommandError, CoreError, StoreError } from "../src";
import {
  CATALOG_COMMANDS,
  CATALOG_HANDLERS,
  RulesetValidationError,
  type EngineRulesetBody,
  type RulesEngine,
} from "../src/services/catalog";
import { addLead, addPost, addSource, harness, leadWorld } from "./catalog-fixtures";

const TEMPLATES_DIR = path.resolve(__dirname, "../../../apps/desktop/templates");
const RUST_DISPATCH = path.resolve(__dirname, "../../../apps/desktop/src/commands/dispatch.rs");

const rejection = async (promise: Promise<unknown>): Promise<any> => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
};

describe("command coverage", () => {
  it("answers exactly the assigned commands and leaves the pipeline ones unported", () => {
    const assigned = [
      "source_list", "source_follow", "source_unfollow", "source_set_priority",
      "radar_list", "radar_get", "radar_create_draft", "radar_update", "radar_stats",
      "template_list", "template_get",
      "lead_list", "lead_get", "lead_mark_read", "lead_set_status", "lead_update_field", "lead_feedback",
      "post_get", "post_list_by_source", "post_search", "evaluation_list_rejected",
      "contact_list", "contact_get", "contact_block", "contact_note",
      "blocklist_list", "blocklist_add", "blocklist_remove",
      "ruleset_list", "ruleset_save_user",
    ];
    expect([...CATALOG_COMMANDS].sort()).toEqual([...assigned].sort());
    expect(Object.keys(CATALOG_HANDLERS).sort()).toEqual([...assigned].sort());
    for (const command of assigned) expect(BACKEND_COMMANDS).toContain(command);
    for (const pipeline of ["source_crawl_now", "radar_set_status", "ruleset_compile_now"]) {
      expect(CATALOG_HANDLERS[pipeline]).toBeUndefined();
    }
  });

  it("matches the dispatch arms of the Rust oracle", () => {
    const dispatch = fs.readFileSync(RUST_DISPATCH, "utf8");
    for (const command of CATALOG_COMMANDS) expect(dispatch).toContain(`"${command}"`);
  });
});

describe("templates", () => {
  it("serves the seven embedded templates in canonical order, equal to the Rust JSON data", async () => {
    const h = harness();
    const list = await h.call("template_list");
    expect(list.map((t: any) => t.id)).toEqual([
      "bds.khach-thue",
      "bds.chinh-chu",
      "tuyen-dung.tim-viec",
      "xe-cu.duoi-gia",
      "van-tai.ghep-hang",
      "dich-vu.tim-tho",
      "order.hoi-mua",
    ]);
    for (const tpl of list) {
      const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, `${tpl.id}.json`), "utf8"));
      expect(tpl.name).toBe(raw.name);
      expect(tpl.industry).toBe(raw.industry);
      expect(tpl.description_template).toBe(raw.description_template);
      expect(tpl.fields.map((f: any) => f.key)).toEqual(raw.fields.map((f: any) => f.key));
      expect(tpl.match_policy.want_intent).toBe(raw.match_policy.want_intent);
      expect(tpl.seed_ruleset).toBe(raw.seed_ruleset ?? null);
      expect(tpl.lead_ttl_hours).toBe(raw.lead_ttl_hours ?? null);
      expect(tpl.notify_mode).toBe(raw.notify_mode ?? null);
    }
  });

  it("template_get trims the id and reports unknown templates", async () => {
    const h = harness();
    const tpl = await h.call("template_get", { id: "  bds.khach-thue " });
    expect(tpl.id).toBe("bds.khach-thue");
    expect(tpl.seed_ruleset).toBe("bds-vi-v1");
    expect(tpl.fields.length).toBeGreaterThan(0);
    const err = await rejection(h.call("template_get", { id: "nope" }));
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("không tìm thấy template: nope");
  });

  it("returns a copy so callers cannot corrupt the cache", async () => {
    const h = harness();
    const first = await h.call("template_list");
    first[0].name = "mutated";
    const second = await h.call("template_list");
    expect(second[0].name).not.toBe("mutated");
  });
});

describe("argument parsing (serde parity)", () => {
  it("reports missing and mistyped arguments like parse_arg", async () => {
    const h = harness();
    const missing = await rejection(h.call("source_follow", {}));
    expect(missing).toBeInstanceOf(CommandError);
    expect(missing.code).toBe("validation_error");
    expect(missing.message).toBe("thiếu tham số 'id'");

    const wrongType = await rejection(h.call("source_follow", { id: 5 }));
    expect(wrongType.message).toBe("tham số 'id' không hợp lệ: invalid type: integer `5`, expected a string");

    const nul = await rejection(h.call("radar_get", { id: null }));
    expect(nul.message).toBe("tham số 'id' không hợp lệ: invalid type: null, expected a string");

    const badKind = await rejection(h.call("blocklist_add", { kind: "ip", value: "x" }));
    expect(badKind.message).toBe(
      "tham số 'kind' không hợp lệ: unknown variant `ip`, expected one of `author`, `phone`, `keyword`",
    );

    const badInput = await rejection(h.call("radar_create_draft", { input: { description: "d" } }));
    expect(badInput.message).toBe("tham số 'input' không hợp lệ: missing field `name`");

    const badLimit = await rejection(h.call("post_search", { query: "a", limit: -1 }));
    expect(badLimit.message).toBe("tham số 'limit' không hợp lệ: invalid value: integer `-1`, expected usize");
  });

  it("treats null optional arguments as absent", async () => {
    const h = harness();
    expect(await h.call("blocklist_list", { radar_id: null })).toEqual([]);
    expect(await h.call("contact_list", { search: null, limit: null })).toEqual([]);
  });
});

describe("sources", () => {
  it("lists followed/priority sources first with counters and last_error", async () => {
    const h = harness();
    const a = addSource(h.store, "Group A", "ga", true);
    const b = addSource(h.store, "Group B", "gb", false);
    h.store.sources.setPriority(a, 1);
    addPost(h.store, b, "pb1", "xin chào", Date.now());
    h.store.settings.set("runtime.source_last_errors", { [b]: "đăng nhập hết hạn" });

    const list = await h.call("source_list");
    expect(list.map((s: any) => s.id)).toEqual([a, b]);
    expect(list[0]).toMatchObject({
      platform: "facebook",
      kind: "group",
      followed: true,
      priority: true,
      state: "ok",
      stored_post_count: 0,
      posts_per_day: 0,
      last_error: null,
    });
    expect(list[1]).toMatchObject({
      followed: false,
      priority: false,
      stored_post_count: 1,
      posts_per_day: 1,
      last_error: "đăng nhập hết hạn",
    });
  });

  it("enforces the Personal followed-group limit and pushes config only on change", async () => {
    let pushes = 0;
    const h = harness({ configChanged: () => void (pushes += 1) });
    const ids = Array.from({ length: 11 }, (_, i) => addSource(h.store, `G${String(i).padStart(2, "0")}`, `g${i}`));
    for (const id of ids.slice(0, 10)) {
      const dto = await h.call("source_follow", { id });
      expect(dto.followed).toBe(true);
    }
    expect(pushes).toBe(10);

    const err = await rejection(h.call("source_follow", { id: ids[10] }));
    expect(err.code).toBe("license_limit_exceeded");
    expect(err.message).toBe("đã đạt giới hạn gói bản quyền: Current Personal plan allows following at most 10 groups");

    // Re-following an already followed group is a no-op: no limit check, no config push.
    await h.call("source_follow", { id: ids[0] });
    expect(pushes).toBe(10);

    const unfollowed = await h.call("source_unfollow", { id: ids[0] });
    expect(unfollowed.followed).toBe(false);
    expect(pushes).toBe(11);
    expect((await h.call("source_follow", { id: ids[10] })).followed).toBe(true);
  });

  it("allows at most three priority groups", async () => {
    const h = harness();
    const ids = Array.from({ length: 4 }, (_, i) => addSource(h.store, `P${i}`, `p${i}`, true));
    for (const id of ids.slice(0, 3)) {
      expect((await h.call("source_set_priority", { id, priority: true })).priority).toBe(true);
    }
    const err = await rejection(h.call("source_set_priority", { id: ids[3], priority: true }));
    expect(err.code).toBe("validation_error");
    expect(err.message).toBe(
      "dữ liệu đầu vào không hợp lệ: Maximum 3 priority groups allowed (`02-extension.md §6.2`)",
    );
    // Re-pinning an already pinned group is not counted against itself.
    expect((await h.call("source_set_priority", { id: ids[0], priority: true })).priority).toBe(true);
    expect((await h.call("source_set_priority", { id: ids[0], priority: false })).priority).toBe(false);
    expect((await h.call("source_set_priority", { id: ids[3], priority: true })).priority).toBe(true);
  });

  it("reports unknown sources and refuses writes while shutting down", async () => {
    const h = harness();
    const err = await rejection(h.call("source_follow", { id: "missing" }));
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("không tìm thấy source: missing");

    const id = addSource(h.store, "G", "g");
    h.setShuttingDown(true);
    const down = await rejection(h.call("source_follow", { id }));
    expect(down.code).toBe("shutting_down");
    expect((await h.call("source_list")).length).toBe(1);
  });
});

describe("radars", () => {
  const fields = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" }));

  it("validates drafts and applies the license field limit", async () => {
    const h = harness();
    const blank = await rejection(h.call("radar_create_draft", { input: { name: "  ", description: "d" } }));
    expect(blank.code).toBe("validation_error");
    expect(blank.message).toBe("dữ liệu đầu vào không hợp lệ: Radar name cannot be empty");
    const noDesc = await rejection(h.call("radar_create_draft", { input: { name: "n", description: " " } }));
    expect(noDesc.message).toBe("dữ liệu đầu vào không hợp lệ: Radar description cannot be empty");

    const many = await rejection(
      h.call("radar_create_draft", { input: { name: "n", description: "d", fields: fields(13) } }),
    );
    expect(many.code).toBe("license_limit_exceeded");
    expect(many.message).toBe(
      "đã đạt giới hạn gói bản quyền: Current Personal plan allows at most 12 fields per radar (got 13)",
    );
    expect((await h.call("radar_list")).length).toBe(0);
  });

  it("creates a draft with defaults, healthy channels and the DTO shape", async () => {
    const h = harness();
    const sourceId = addSource(h.store, "G", "g");
    const ok = h.store.channels.create("telegram", "Bot", { chat_id: "1" }, Date.now());
    const broken = h.store.channels.create("telegram", "Bot 2", { chat_id: "2" }, Date.now());
    h.store.channels.setState(broken.id, "error");

    const detail = await h.call("radar_create_draft", {
      input: { name: "  Thuê nhà ", description: "Cần thuê", source_ids: [sourceId], fields: fields(2) },
    });
    expect(detail.radar).toMatchObject({
      name: "Thuê nhà",
      status: "draft",
      template_id: null,
      current_version: 1,
      source_ids: [sourceId],
      rule_handled_pct: 0,
      leads_24h: 0,
      evaluated_posts_total: 0,
      false_positive_rate: 0,
    });
    expect(detail.radar.notify).toEqual({
      channel_ids: [ok.id],
      mode: "instant",
      min_score: 0.6,
      quiet_hours: null,
      lead_ttl_hours: null,
    });
    expect("inherit_channels" in detail.radar.notify).toBe(false);
    expect("auto_digest_flood" in detail.radar).toBe(false);
    expect(detail.current_version_data).toMatchObject({
      version: 1,
      language_hint: "vi",
      user_profession: null,
      match_policy: { want_intent: "any", exclude_roles: ["peer"], hard_filters: [] },
    });
    expect(detail.current_version_data.fields[0]).toEqual({
      key: "f0",
      label: "F0",
      type: "text",
      description: "",
      required: false,
      options: null,
      show_in_alert: true,
      order: 0,
    });
    expect(detail.pending_version_data).toBeNull();
    expect(detail.versions.length).toBe(1);
    expect(await h.call("radar_get", { id: detail.radar.id })).toEqual(detail);
    expect((await h.call("radar_list")).map((r: any) => r.id)).toEqual([detail.radar.id]);
  });

  it("honours explicit channel selection and notify patch semantics", async () => {
    const h = harness();
    h.store.channels.create("telegram", "Bot", { chat_id: "1" }, Date.now());
    const created = await h.call("radar_create_draft", {
      input: {
        name: "R",
        description: "d",
        notify: { channel_ids: [], mode: "digest", min_score: 0.7, lead_ttl_hours: 24 },
      },
    });
    expect(created.radar.notify).toMatchObject({
      channel_ids: [],
      mode: "digest",
      min_score: 0.7,
      lead_ttl_hours: 24,
    });

    const id = created.radar.id;
    const kept = await h.call("radar_update", { input: { id, notify: { min_score: 0.8 } } });
    expect(kept.detail.radar.notify).toMatchObject({ mode: "digest", min_score: 0.8, lead_ttl_hours: 24 });

    const cleared = await h.call("radar_update", { input: { id, notify: { lead_ttl_hours: null } } });
    expect(cleared.detail.radar.notify.lead_ttl_hours).toBeNull();

    const reset = await h.call("radar_update", { input: { id, notify: { lead_ttl_hours: 6 } } });
    expect(reset.detail.radar.notify.lead_ttl_hours).toBe(6);
    const zero = await h.call("radar_update", { input: { id, notify: { lead_ttl_hours: 0 } } });
    expect(zero.detail.radar.notify.lead_ttl_hours).toBeNull();
  });

  it("attaches the template's seed ruleset and exposes it in UI form", async () => {
    const h = harness();
    const tpl = await h.call("template_get", { id: "bds.khach-thue" });
    const detail = await h.call("radar_create_draft", {
      input: {
        name: "BĐS",
        template_id: tpl.id,
        description: "Cần thuê căn hộ",
        fields: tpl.fields,
        match_policy: tpl.match_policy,
      },
    });
    const rulesets = await h.call("ruleset_list", { radar_id: detail.radar.id });
    expect(rulesets.length).toBe(1);
    const seed = rulesets[0];
    expect(seed).toMatchObject({
      radar_version_id: detail.current_version_data.id,
      revision: 1,
      state: "active",
      origin: "seed",
      metrics: null,
    });
    expect(typeof seed.activated_at).toBe("number");
    expect(seed.body.dsl).toBe(1);
    expect(seed.body.thresholds).toEqual({ accept: 0.9, reject: 0.9 });
    expect(seed.body.prefilter.min_len).toBe(15);
    expect(seed.body.classify.map((r: any) => r.id)).toEqual([
      "reject_broker_inventory",
      "accept_clear_tenant_demand",
    ]);
    const accept = seed.body.classify[1];
    expect(accept).toMatchObject({ verdict: "match", confidence: 0.92, has_field: "location" });
    expect(accept.kw_any).toContain("can thue");
    expect(accept.kw_none).toContain("hoa hong");
    expect(accept.set).toEqual({ author_role: "end_user", intent: "demand" });
    expect("description" in accept).toBe(false);
    expect(seed.body.extract.map((e: any) => e.extractor)).toEqual([
      "enum_kw",
      "enum_kw",
      "gazetteer",
      "vn_money",
      "vn_area",
      "regex",
      "vn_phone",
    ]);
    expect(seed.body.extract[3]).toMatchObject({ field: "price", window: 50 });
    expect(seed.body.extract[5]).toMatchObject({ pattern: String.raw`(\d+)\s*(?:pn|phong ngu|p\.ngu)\b`, group: 1, cast: "int" });
    expect("near" in seed.body.extract[4]).toBe(false);
    // Unknown template ids never block draft creation.
    const plain = await h.call("radar_create_draft", { input: { name: "x", description: "y", template_id: "unknown.template" } });
    expect(plain.radar.template_id).toBe("unknown.template");
    expect(await h.call("ruleset_list", { radar_id: plain.radar.id })).toEqual([]);
  });

  it("updates metadata in place and versions definition edits", async () => {
    const pushes: string[] = [];
    const h = harness({ configChanged: () => void pushes.push("push") });
    const sourceId = addSource(h.store, "G", "g");
    const draft = await h.call("radar_create_draft", { input: { name: "R", description: "v1" } });
    const id = draft.radar.id;

    const renamed = await h.call("radar_update", { input: { id, name: "Renamed" } });
    expect(renamed).toMatchObject({ created_new_version: false, requires_confirmation: false });
    expect(renamed.detail.radar.name).toBe("Renamed");
    expect(renamed.detail.versions.length).toBe(1);

    // A draft activates its new version immediately.
    const edited = await h.call("radar_update", { input: { id, description: "v2" } });
    expect(edited).toMatchObject({ created_new_version: true, requires_confirmation: false });
    expect(edited.detail.radar.current_version).toBe(2);
    expect(edited.detail.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(pushes.length).toBe(0);

    // An active radar keeps the old version until the user confirms the candidate.
    h.store.radars.setStatus(id, "active", Date.now());
    const candidate = await h.call("radar_update", { input: { id, description: "v3" } });
    expect(candidate).toMatchObject({ created_new_version: true, requires_confirmation: true });
    expect(candidate.detail.radar.current_version).toBe(2);
    expect(candidate.detail.pending_version_data).toMatchObject({ version: 3, description: "v3" });

    const confirmed = await h.call("radar_update", { input: { id, confirm_version_upgrade: true } });
    expect(confirmed).toMatchObject({ created_new_version: false, requires_confirmation: false });
    expect(confirmed.detail.radar.current_version).toBe(3);
    expect(confirmed.detail.pending_version_data).toBeNull();
    expect(pushes.length).toBe(1);

    // Source changes on an active radar re-plan crawling.
    await h.call("radar_update", { input: { id, source_ids: [sourceId] } });
    expect(pushes.length).toBe(2);
  });

  it("applies the license field limit on update and reports unknown radars", async () => {
    const h = harness();
    const draft = await h.call("radar_create_draft", { input: { name: "R", description: "d" } });
    const err = await rejection(h.call("radar_update", { input: { id: draft.radar.id, fields: fields(13) } }));
    expect(err.code).toBe("license_limit_exceeded");
    const missing = await rejection(h.call("radar_get", { id: "nope" }));
    expect(missing.message).toBe("không tìm thấy radar: nope");
    const missingUpdate = await rejection(h.call("radar_update", { input: { id: "nope" } }));
    expect(missingUpdate.code).toBe("not_found");
  });

  it("flags flood radars and reports funnel stats", async () => {
    const h = harness();
    const created = await h.call("radar_create_draft", { input: { name: "R", description: "d" } });
    h.store.settings.set("runtime.flood_auto_digest_radars", [created.radar.id]);
    expect((await h.call("radar_list"))[0].auto_digest_flood).toBe(true);
    expect((await h.call("radar_get", { id: created.radar.id })).radar.auto_digest_flood).toBe(true);

    expect(await h.call("radar_stats", {})).toEqual({
      days: 7,
      posts_captured: 0,
      dedup_dropped: 0,
      prefilter_dropped: 0,
      rule_decided: 0,
      rule_matched: 0,
      ai_decided: 0,
      ai_matched: 0,
      leads_created: 0,
      leads_notified: 0,
      leads_weak: 0,
      false_positives: 0,
    });
    expect((await h.call("radar_stats", { radar_id: created.radar.id, days: 0 })).days).toBe(1);
  });
});

describe("leads", () => {
  it("lists, details and marks leads read with push events", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const weakPost = addPost(h.store, w.sourceId, "p2", "Tin yếu", Date.now());
    const weak = addLead(h.store, w.radarId, w.versionId, weakPost.id, 0.3);

    const all = await h.call("lead_list", { query: {} });
    expect(all.total).toBe(2);
    expect(all.next_cursor).toBeNull();
    expect(all.items.find((l: any) => l.id === weak.leadId).is_weak_match).toBe(true);

    const strong = await h.call("lead_list", { query: { include_weak: false } });
    expect(strong.total).toBe(1);
    expect(strong.items.map((l: any) => l.id)).toEqual([w.leadId]);

    const detail = await h.call("lead_get", { id: w.leadId });
    expect(detail.lead).toMatchObject({
      id: w.leadId,
      radar_name: "Khách thuê",
      radar_version: 1,
      status: "new",
      read_at: null,
      score: 0.9,
      is_weak_match: false,
      decided_by: "ai",
      author_name: "Author p1",
      expires_at: null,
      feedback_label: null,
      tags: [],
    });
    expect(detail.lead.fields.price).toEqual({ value: 10, raw: "10tr", confidence: 0.9, source: "ai" });
    expect(detail.post).toMatchObject({ id: w.postId, source_name: "Hà Nội Thuê Nhà", author_name: "Author p1" });
    expect(detail.radar_fields.map((f: any) => f.key)).toEqual(["price", "phone"]);
    expect(detail.events.map((e: any) => e.kind)).toEqual(["created"]);
    expect(detail.events[0].data).toEqual({ score: 0.9 });
    expect(detail.poster).toEqual({
      posts_7d: 1,
      groups_7d: 1,
      same_post_groups: 1,
      phone_shared_by_authors: 0,
      looks_like_peer: false,
    });

    const read = await h.call("lead_mark_read", { id: w.leadId });
    expect(typeof read.lead.read_at).toBe("number");
    expect(h.events.map((e) => e.event)).toEqual(["lead:updated"]);
    expect(h.events[0].payload.id).toBe(w.leadId);
    expect(h.events[0].payload.read_at).toBe(read.lead.read_at);

    const missing = await rejection(h.call("lead_get", { id: "nope" }));
    expect(missing.message).toBe("không tìm thấy lead: nope");
  });

  it("computes expires_at from the radar lead lifetime", async () => {
    const h = harness();
    const w = await leadWorld(h);
    await h.call("radar_update", { input: { id: w.radarId, notify: { lead_ttl_hours: 2 } } });
    const detail = await h.call("lead_get", { id: w.leadId });
    const post = await h.call("post_get", { id: w.postId });
    expect(detail.lead.expires_at).toBe((post.created_at ?? post.captured_at) + 2 * 3_600_000);
    const expired = await h.call("lead_list", { query: { expired: true } });
    expect(expired.total).toBe(0);
    const live = await h.call("lead_list", { query: { expired: false } });
    expect(live.total).toBe(1);
  });

  it("distinguishes omitted, null and set CRM fields in lead_set_status", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const followUp = Date.now() + 86_400_000;

    const first = await h.call("lead_set_status", {
      id: w.leadId,
      status: "contacted",
      note: "Gọi chiều nay",
      tags: ["vip"],
      follow_up_at: followUp,
    });
    expect(first.lead).toMatchObject({ status: "contacted", note: "Gọi chiều nay", tags: ["vip"], follow_up_at: followUp });

    const keep = await h.call("lead_set_status", { id: w.leadId, status: "negotiating" });
    expect(keep.lead).toMatchObject({ status: "negotiating", note: "Gọi chiều nay", tags: ["vip"], follow_up_at: followUp });

    const clearFollowUp = await h.call("lead_set_status", { id: w.leadId, status: "negotiating", follow_up_at: null });
    expect(clearFollowUp.lead).toMatchObject({ note: "Gọi chiều nay", tags: ["vip"], follow_up_at: null });

    const clearNote = await h.call("lead_set_status", { id: w.leadId, status: "won", note: null, tags: [] });
    expect(clearNote.lead).toMatchObject({ status: "won", note: null, tags: [] });
    expect(h.events.filter((e) => e.event === "lead:updated").length).toBe(4);

    const invalid = await rejection(h.call("lead_set_status", { id: w.leadId, status: "bogus" }));
    expect(invalid.code).toBe("validation_error");
    expect(invalid.message).toBe(
      "status không hợp lệ: unknown variant `bogus`, expected one of `new`, `viewed`, `contacted`, `negotiating`, `won`, `lost`, `ignored`",
    );
    const badNote = await rejection(h.call("lead_set_status", { id: w.leadId, status: "won", note: 5 }));
    expect(badNote.message).toBe("note không hợp lệ: invalid type: integer `5`, expected a string");
    const noStatus = await rejection(h.call("lead_set_status", { id: w.leadId }));
    expect(noStatus.message).toBe("thiếu tham số 'status'");
    const noLead = await rejection(h.call("lead_set_status", { id: "nope", status: "won" }));
    expect(noLead.message).toBe("không tìm thấy lead: nope");
  });

  it("edits extracted fields as the user and validates the value", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const detail = await h.call("lead_update_field", { id: w.leadId, field_key: "price", value: 12, raw: "12 triệu" });
    expect(detail.lead.fields.price).toEqual({ value: 12, raw: "12 triệu", confidence: 1, source: "user" });
    expect(detail.events.map((e: any) => e.kind)).toEqual(["created", "field_edited"]);
    expect(detail.events[1].data).toEqual({ field: "price", new: 12, old: 10 });
    expect(h.events.at(-1)?.event).toBe("lead:updated");

    const wrongType = await rejection(h.call("lead_update_field", { id: w.leadId, field_key: "price", value: "abc" }));
    expect(wrongType).toBeInstanceOf(StoreError);
    const unknown = await rejection(h.call("lead_update_field", { id: w.leadId, field_key: "nope", value: 1 }));
    expect(unknown).toBeInstanceOf(StoreError);
    // A missing `value` is JSON null, which clears the field value.
    const cleared = await h.call("lead_update_field", { id: w.leadId, field_key: "price" });
    expect(cleared.lead.fields.price.value).toBeNull();
  });

  it("hides negatively rated leads, remembers the label and blocks the author", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const result = await h.call("lead_feedback", {
      input: { evaluation_id: w.evaluationId, lead_id: w.leadId, label: "spam", block_author: true, origin: "app" },
    });
    expect(result.updated_lead).toMatchObject({ id: w.leadId, status: "ignored", feedback_label: "spam" });
    expect(result.blocked_entry).toMatchObject({
      kind: "author",
      display_label: "Author p1",
      reason: "blocked_from_feedback",
      radar_id: null,
    });
    expect(h.events.at(-1)).toMatchObject({ event: "lead:updated" });
    expect(h.store.settings.get("runtime.feedback_by_eval")).toEqual({ [w.evaluationId]: "spam" });
    const blocklist = await h.call("blocklist_list", {});
    expect(blocklist.map((b: any) => b.value)).toEqual([result.blocked_entry.value]);
    expect((await h.call("lead_get", { id: w.leadId })).lead.feedback_label).toBe("spam");
  });

  it("applies corrected fields to the lead and validates them against the radar", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const result = await h.call("lead_feedback", {
      input: {
        evaluation_id: w.evaluationId,
        lead_id: w.leadId,
        label: "wrong_fields",
        corrected_fields: { price: 15 },
        origin: "app",
      },
    });
    expect(result.updated_lead.fields.price).toMatchObject({ value: 15, source: "user", confidence: 1 });
    expect(result.updated_lead.feedback_label).toBe("wrong_fields");

    const unknownField = await rejection(
      h.call("lead_feedback", {
        input: { evaluation_id: w.evaluationId, label: "wrong_fields", corrected_fields: { nope: 1 }, origin: "app" },
      }),
    );
    expect(unknownField.message).toBe("dữ liệu đầu vào không hợp lệ: Trường không tồn tại: nope");
    const noEval = await rejection(
      h.call("lead_feedback", {
        input: { evaluation_id: "nope", label: "wrong_fields", corrected_fields: { price: 1 }, origin: "app" },
      }),
    );
    expect(noEval.message).toBe("dữ liệu đầu vào không hợp lệ: Không tìm thấy đánh giá");
    const telegram = await rejection(
      h.call("lead_feedback", { input: { evaluation_id: w.evaluationId, label: "correct", origin: "telegram" } }),
    );
    expect(telegram.message).toBe(
      "tham số 'input' không hợp lệ: unknown variant `telegram`, expected one of `app`, `preview`",
    );
  });

  it("promotes a missed rejected post to a new lead", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const post = addPost(h.store, w.sourceId, "p-missed", "Cần thuê gấp ".repeat(20), Date.now());
    const now = Date.now();
    const evaluation = h.store.leads.upsertEvaluation({
      post_id: post.id,
      radar_version_id: w.versionId,
      state: "done",
      decided_by: "ai",
      verdict: "no_match",
      reject_reason: "irrelevant",
      score: 0.2,
      reason: "Không liên quan",
      created_at: now,
      decided_at: now,
    });

    const rejected = await h.call("evaluation_list_rejected", { radar_id: w.radarId });
    expect(rejected.length).toBe(1);
    expect(rejected[0]).toMatchObject({
      evaluation_id: evaluation.id,
      radar_id: w.radarId,
      radar_version_id: w.versionId,
      decided_by: "ai",
      reject_reason: "irrelevant",
      score: 0.2,
      reason: "Không liên quan",
      source_name: "Hà Nội Thuê Nhà",
      author_name: "Author p-missed",
    });
    expect("marked_missed" in rejected[0]).toBe(false);

    const result = await h.call("lead_feedback", {
      input: { evaluation_id: evaluation.id, label: "missed", origin: "app" },
    });
    expect(result.updated_lead).toMatchObject({ post_id: post.id, score: 0.75, status: "new", fields: {} });
    expect(Array.from(result.updated_lead.summary).length).toBe(120);
    expect(h.events.at(-1)).toMatchObject({ event: "lead:new" });
    expect(h.events.at(-1)?.payload.id).toBe(result.updated_lead.id);

    const after = await h.call("evaluation_list_rejected", { radar_id: w.radarId });
    expect(after[0].marked_missed).toBe(true);

    // Marking the same evaluation again is idempotent: the lead already exists, so it is an update.
    const again = await h.call("lead_feedback", {
      input: { evaluation_id: evaluation.id, label: "missed", origin: "app" },
    });
    expect(again.updated_lead.id).toBe(result.updated_lead.id);
    expect(h.events.at(-1)).toMatchObject({ event: "lead:updated" });
  });

  describe("rule-decided evaluations", () => {
    async function ruleWorld(h: ReturnType<typeof harness>) {
      const sourceId = addSource(h.store, "G", "g1", true);
      const tpl = await h.call("template_get", { id: "bds.khach-thue" });
      const detail = await h.call("radar_create_draft", {
        input: {
          name: "BĐS",
          template_id: tpl.id,
          description: "Cần thuê",
          fields: tpl.fields,
          match_policy: tpl.match_policy,
          source_ids: [sourceId],
        },
      });
      const versionId = detail.current_version_data.id;
      const rulesetId = h.store.radars.getActiveRuleset(versionId)!.id;
      const post = addPost(h.store, sourceId, "rp1", "Cần thuê căn hộ", Date.now());
      const lead = addLead(h.store, detail.radar.id, versionId, post.id, 0.95, { decidedBy: "rule", rulesetId });
      return { versionId, rulesetId, ...lead };
    }

    const jobs = (h: ReturnType<typeof harness>) =>
      h.store.db.prepare("SELECT kind, dedup_key FROM jobs ORDER BY kind").all() as Array<{ kind: string; dedup_key: string }>;

    it("queues an immediate audit of the ruleset", async () => {
      let wakes = 0;
      const h = harness({ wakeJobs: () => void (wakes += 1) });
      const w = await ruleWorld(h);
      await h.call("lead_feedback", {
        input: { evaluation_id: w.evaluationId, lead_id: w.leadId, label: "irrelevant", origin: "app" },
      });
      expect(jobs(h)).toEqual([{ kind: "audit_ruleset", dedup_key: `audit_ruleset:${w.rulesetId}` }]);
      expect(wakes).toBe(1);
      const history = h.store.settings.get<any[]>(`runtime.audit_history.${w.rulesetId}`)!;
      expect(history.length).toBe(1);
      expect(history[0].disagreed).toBe(true);
      expect(h.store.radars.getActiveRuleset(w.versionId)?.id).toBe(w.rulesetId);
    });

    it("demotes the active ruleset to shadow once disagreement exceeds 8% over ten samples", async () => {
      let wakes = 0;
      const h = harness({ wakeJobs: () => void (wakes += 1) });
      const w = await ruleWorld(h);
      const nowTs = Date.now();
      h.store.settings.set(
        `runtime.audit_history.${w.rulesetId}`,
        Array.from({ length: 9 }, () => ({ ts_ms: nowTs, disagreed: true })),
      );
      await h.call("lead_feedback", {
        input: { evaluation_id: w.evaluationId, lead_id: w.leadId, label: "peer", origin: "app" },
      });
      expect(h.store.radars.getActiveRuleset(w.versionId)).toBeNull();
      expect(h.store.radars.getShadowRuleset(w.versionId)?.id).toBe(w.rulesetId);
      expect(jobs(h)).toEqual([{ kind: "compile_ruleset", dedup_key: `compile_ruleset:${w.versionId}` }]);
      expect(wakes).toBe(1);
    });

    it("ignores stale audit entries and AI-decided evaluations", async () => {
      const h = harness();
      const w = await ruleWorld(h);
      const old = Date.now() - 8 * 86_400_000;
      h.store.settings.set(
        `runtime.audit_history.${w.rulesetId}`,
        Array.from({ length: 20 }, () => ({ ts_ms: old, disagreed: true })),
      );
      await h.call("lead_feedback", {
        input: { evaluation_id: w.evaluationId, lead_id: w.leadId, label: "duplicate", origin: "app" },
      });
      expect(h.store.radars.getActiveRuleset(w.versionId)?.id).toBe(w.rulesetId);
      expect(h.store.settings.get<any[]>(`runtime.audit_history.${w.rulesetId}`)!.length).toBe(1);

      const world = await leadWorld(h);
      await h.call("lead_feedback", {
        input: { evaluation_id: world.evaluationId, lead_id: world.leadId, label: "irrelevant", origin: "app" },
      });
      expect(jobs(h)).toEqual([{ kind: "audit_ruleset", dedup_key: `audit_ruleset:${w.rulesetId}` }]);
    });
  });
});

describe("posts", () => {
  it("returns posts with the anonymous author fallback", async () => {
    const h = harness();
    const sourceId = addSource(h.store, "G", "g");
    const anonymous = addPost(h.store, sourceId, "anon", "Tin ẩn danh", Date.now(), null);
    const dto = await h.call("post_get", { id: anonymous.id });
    expect(dto).toMatchObject({
      id: anonymous.id,
      platform: "facebook",
      source_id: sourceId,
      source_name: "G",
      author_id: null,
      author_name: "Ẩn danh",
      text: "Tin ẩn danh",
      text_truncated: false,
      strategy: "dom",
      purged_at: null,
    });
    const missing = await rejection(h.call("post_get", { id: "nope" }));
    expect(missing.message).toBe("không tìm thấy post: nope");
  });

  it("paginates a source newest-first with a keyset cursor", async () => {
    const h = harness();
    const sourceId = addSource(h.store, "G", "g");
    const base = Date.now() - 100_000;
    for (let i = 0; i < 31; i += 1) addPost(h.store, sourceId, `q${i}`, `bài ${i}`, base + i * 1_000);

    const first = await h.call("post_list_by_source", { source_id: sourceId });
    expect(first.items.length).toBe(30);
    expect(first.items[0].external_id).toBe("q30");
    expect(first.items[29].external_id).toBe("q1");
    expect(first.next_cursor).toEqual({ at: first.items[29].created_at, id: first.items[29].id });

    const second = await h.call("post_list_by_source", { source_id: sourceId, before: first.next_cursor });
    expect(second.items.map((p: any) => p.external_id)).toEqual(["q0"]);
    expect(second.next_cursor).toBeNull();
  });

  it("searches stored posts, optionally within one source", async () => {
    const h = harness();
    const a = addSource(h.store, "A", "ga");
    const b = addSource(h.store, "B", "gb");
    addPost(h.store, a, "s1", "Cần thuê căn hộ Cầu Giấy", Date.now());
    addPost(h.store, b, "s2", "Cần thuê phòng trọ", Date.now());
    addPost(h.store, b, "s3", "Bán xe máy", Date.now());

    const all = await h.call("post_search", { query: "thuê" });
    expect(all.map((p: any) => p.external_id).sort()).toEqual(["s1", "s2"]);
    const scoped = await h.call("post_search", { query: "thue", source_id: b });
    expect(scoped.map((p: any) => p.external_id)).toEqual(["s2"]);
    expect(await h.call("post_search", { query: "thue", limit: 1 })).toHaveLength(1);
    expect(await h.call("post_search", { query: "!!!" })).toEqual([]);
  });
});

describe("contacts and blocklist", () => {
  async function contactWorld() {
    const h = harness();
    const w = await leadWorld(h);
    const post = h.store.posts.get(w.postId)!;
    const contact = h.store.contacts.upsertFromLead(post.author_id, "Nguyễn An", ["+84912345678"], Date.now())!;
    h.store.leads.setContactId(w.leadId, contact.id, Date.now());
    return { h, w, post, contact };
  }

  it("lists contacts with lead counts and blocked state", async () => {
    const { h, w, contact } = await contactWorld();
    const list = await h.call("contact_list", {});
    expect(list).toEqual([
      expect.objectContaining({
        id: contact.id,
        display_name: "Nguyễn An",
        phones: ["+84912345678"],
        lead_count: 1,
        is_blocked: false,
        note: null,
      }),
    ]);
    expect(await h.call("contact_list", { search: "nguyen" })).toHaveLength(1);
    expect(await h.call("contact_list", { search: "zzz" })).toHaveLength(0);

    const detail = await h.call("contact_get", { id: contact.id });
    expect(detail.contact.lead_count).toBe(1);
    expect(detail.leads.map((l: any) => l.id)).toEqual([w.leadId]);
    expect(detail.leads[0].contact_id).toBe(contact.id);

    const missing = await rejection(h.call("contact_get", { id: "nope" }));
    expect(missing.message).toBe("không tìm thấy contact: nope");
  });

  it("blocks every phone and author of a contact", async () => {
    const { h, post, contact } = await contactWorld();
    const result = await h.call("contact_block", { id: contact.id, reason: "spam" });
    expect(result.blocked_entries.map((b: any) => [b.kind, b.value, b.display_label, b.reason])).toEqual([
      ["phone", "+84912345678", "Nguyễn An", "spam"],
      ["author", post.author_id, "Nguyễn An", "spam"],
    ]);
    expect((await h.call("contact_get", { id: contact.id })).contact.is_blocked).toBe(true);

    const entries = await h.call("blocklist_list", {});
    expect(entries.length).toBe(2);
    expect(entries.find((b: any) => b.kind === "author").display_label).toBe("Author p1");
    expect(entries.find((b: any) => b.kind === "phone").display_label).toBeNull();

    // Blocking again is idempotent.
    await h.call("contact_block", { id: contact.id, reason: "other" });
    expect((await h.call("blocklist_list", {})).length).toBe(2);
  });

  it("stores and clears contact notes", async () => {
    const { h, contact } = await contactWorld();
    const noted = await h.call("contact_note", { id: contact.id, note: "Khách VIP" });
    expect(noted).toMatchObject({ note: "Khách VIP", lead_count: 1 });
    const cleared = await h.call("contact_note", { id: contact.id, note: "   " });
    expect(cleared.note).toBeNull();
    const missing = await rejection(h.call("contact_note", { id: "nope", note: "x" }));
    expect(missing.message).toBe("không tìm thấy contact: nope");
  });

  it("adds, scopes and removes blocklist entries", async () => {
    const h = harness();
    const w = await leadWorld(h);
    const global = await h.call("blocklist_add", { kind: "keyword", value: "  môi giới ", reason: "peer" });
    expect(global).toMatchObject({ kind: "keyword", value: "môi giới", display_label: null, radar_id: null, reason: "peer" });
    const again = await h.call("blocklist_add", { kind: "keyword", value: "môi giới" });
    expect(again.id).toBe(global.id);
    const scoped = await h.call("blocklist_add", { kind: "phone", value: "+84900000000", radar_id: w.radarId });
    expect(scoped.radar_id).toBe(w.radarId);

    expect((await h.call("blocklist_list", {})).length).toBe(2);
    expect((await h.call("blocklist_list", { radar_id: "other" })).map((b: any) => b.id)).toEqual([global.id]);

    const empty = await rejection(h.call("blocklist_add", { kind: "keyword", value: "   " }));
    expect(empty).toBeInstanceOf(StoreError);

    expect(await h.call("blocklist_remove", { id: global.id })).toEqual({ removed: true });
    expect(await h.call("blocklist_remove", { id: global.id })).toEqual({ removed: false });
    h.setShuttingDown(true);
    expect((await rejection(h.call("blocklist_remove", { id: scoped.id }))).code).toBe("shutting_down");
  });
});

describe("rulesets", () => {
  async function seededRadar(h: ReturnType<typeof harness>) {
    const tpl = await h.call("template_get", { id: "bds.khach-thue" });
    const detail = await h.call("radar_create_draft", {
      input: {
        name: "BĐS",
        template_id: tpl.id,
        description: "Cần thuê",
        fields: tpl.fields,
        match_policy: tpl.match_policy,
      },
    });
    return { radarId: detail.radar.id as string, versionId: detail.current_version_data.id as string };
  }

  const fakeRules = (opts: { reject?: string; gate?: Partial<ReturnType<RulesEngine["evaluateGate"]>> } = {}) => {
    const validated: EngineRulesetBody[] = [];
    const gated: Array<{ samples: number; fields: number }> = [];
    const engine: RulesEngine = {
      validateRuleset(body) {
        validated.push(body);
        if (opts.reject) throw new RulesetValidationError(opts.reject);
      },
      evaluateGate(body, fields, samples) {
        gated.push({ samples: samples.length, fields: fields.length });
        return {
          passed: false,
          self_handled_rate: 0,
          accept_precision: 1,
          false_negative_rate: 0,
          total_samples: samples.length,
          pruned_ruleset: body,
          ...opts.gate,
        };
      },
    };
    return { engine, validated, gated };
  };

  it("lists rulesets of the current or an explicit version", async () => {
    const h = harness();
    const { radarId, versionId } = await seededRadar(h);
    expect((await h.call("ruleset_list", { radar_id: radarId })).length).toBe(1);
    expect((await h.call("ruleset_list", { radar_id: radarId, radar_version_id: versionId })).length).toBe(1);
    expect(await h.call("ruleset_list", { radar_id: radarId, radar_version_id: "other-version" })).toEqual([]);
    expect((await h.call("ruleset_list", { radar_id: radarId, radar_version_id: "  " })).length).toBe(1);
    const missing = await rejection(h.call("ruleset_list", { radar_id: "nope" }));
    expect(missing.message).toBe("không tìm thấy radar: nope");
  });

  it("round-trips the UI body without clobbering complex rule conditions", async () => {
    const rules = fakeRules();
    const h = harness({ rules: rules.engine });
    const { radarId, versionId } = await seededRadar(h);
    const seed = h.store.radars.getActiveRuleset(versionId)!;
    const [listed] = await h.call("ruleset_list", { radar_id: radarId });

    const saved = await h.call("ruleset_save_user", { radar_id: radarId, radar_version_id: versionId, body: listed.body });
    expect(saved).toMatchObject({ state: "active", origin: "user", revision: 2, metrics: null });
    expect(saved.body).toEqual(listed.body);
    expect(rules.validated.length).toBe(1);
    expect(rules.gated).toEqual([]);

    const stored = h.store.radars.getActiveRuleset(versionId)!;
    expect(stored.id).toBe(saved.id);
    expect(JSON.stringify(stored.body)).toBe(JSON.stringify(seed.body));
    expect(h.store.radars.listRulesets(versionId).find((r) => r.id === seed.id)?.state).toBe("retired");
  });

  it("rebuilds flat hints into conditions and keeps unrelated trees", async () => {
    const rules = fakeRules();
    const h = harness({ rules: rules.engine });
    const { radarId, versionId } = await seededRadar(h);
    const saved = await h.call("ruleset_save_user", {
      radar_id: radarId,
      radar_version_id: versionId,
      body: {
        classify: [
          { id: "flat", kw_any: ["thue"], kw_none: ["ban"], has_field: " price ", verdict: "match", confidence: 0.9 },
          { id: "tree", when: { not: { re: "abc" } }, verdict: "no_match", confidence: 0.95 },
          { id: "tree-edited", when: { kw_any: ["a"] }, kw_any: ["b"], verdict: "match", confidence: 0.8 },
          { id: "empty", verdict: "match", confidence: 0.8 },
        ],
        extract: [{ field: "price", extractor: "vn_money" }, { field: "x", extractor: "bogus" }],
      },
    });
    const engineBody = rules.validated[0];
    expect(engineBody.prefilter).toBeNull();
    expect(engineBody.classify.map((c) => c.when)).toEqual([
      { all: [{ kw_any: ["thue"] }, { kw_none: ["ban"] }, { has_field: "price" }] },
      { not: { re: "abc" } },
      { kw_any: ["b"] },
      { len_gt: 0 },
    ]);
    expect(engineBody.classify.map((c) => c.verdict)).toEqual(["match", "no_match", "match", "match"]);
    expect(engineBody.extract).toEqual([
      { field: "price", extractor: "vn_money", near: [], window: 40 },
      { field: "x", extractor: "vn_phone" },
    ]);
    expect(saved.body.thresholds).toEqual({ accept: 0.9, reject: 0.9 });
    expect(saved.body.classify[0]).toMatchObject({ kw_any: ["thue"], kw_none: ["ban"], has_field: "price" });
  });

  it("reports validation failures and refuses to save without a rules engine", async () => {
    const noEngine = harness();
    const { radarId, versionId } = await seededRadar(noEngine);
    const unported = await rejection(
      noEngine.call("ruleset_save_user", { radar_id: radarId, radar_version_id: versionId, body: {} }),
    );
    expect(unported.code).toBe("not_implemented");
    expect(noEngine.store.radars.listRulesets(versionId).length).toBe(1);

    const rules = fakeRules({ reject: "unsupported DSL version 2 (expected 1)" });
    const h = harness({ rules: rules.engine });
    const world = await seededRadar(h);
    const invalid = await rejection(
      h.call("ruleset_save_user", { radar_id: world.radarId, radar_version_id: world.versionId, body: { dsl: 2 } }),
    );
    expect(invalid).toBeInstanceOf(CommandError);
    expect(invalid.code).toBe("validation_error");
    expect(invalid.message).toBe("bộ quy tắc không hợp lệ: unsupported DSL version 2 (expected 1)");
    expect(h.store.radars.listRulesets(world.versionId).length).toBe(1);

    const foreign = await rejection(
      h.call("ruleset_save_user", { radar_id: world.radarId, radar_version_id: "other", body: {} }),
    );
    expect(foreign.message).toBe(
      `dữ liệu đầu vào không hợp lệ: radar_version_id 'other' does not belong to radar '${world.radarId}'`,
    );
    const noRadar = await rejection(h.call("ruleset_save_user", { radar_id: "nope", radar_version_id: "x", body: {} }));
    expect(noRadar.message).toBe("không tìm thấy radar: nope");
    const badBody = await rejection(
      h.call("ruleset_save_user", { radar_id: world.radarId, radar_version_id: world.versionId, body: { thresholds: {} } }),
    );
    expect(badBody.message).toBe("tham số 'body' không hợp lệ: missing field `accept`");
  });

  it("runs the holdout gate when ten labeled samples exist", async () => {
    const rules = fakeRules({ gate: { self_handled_rate: 0.456, passed: false } });
    const h = harness({ rules: rules.engine });
    const { radarId, versionId } = await seededRadar(h);
    const sourceId = addSource(h.store, "G", "g1", true);
    for (let i = 0; i < 10; i += 1) {
      const post = addPost(h.store, sourceId, `lab${i}`, `Cần thuê căn hộ số ${i}`, Date.now());
      addLead(h.store, radarId, versionId, post.id, 0.95);
    }
    expect(h.store.leads.getLabeledDataset(versionId).length).toBe(10);

    const saved = await h.call("ruleset_save_user", { radar_id: radarId, radar_version_id: versionId, body: {} });
    expect(rules.gated).toEqual([{ samples: 10, fields: 7 }]);
    expect(saved.state).toBe("shadow");
    expect(saved.metrics).toEqual({
      rule_handled_pct: 46,
      ai_handled_pct: 54,
      accept_precision: 1,
      false_negative_rate: 0,
      sample_size: 10,
    });
    // A shadow candidate does not replace the active seed ruleset.
    expect(h.store.radars.getActiveRuleset(versionId)?.origin).toBe("seed");
    expect(h.store.radars.getShadowRuleset(versionId)?.id).toBe(saved.id);
  });
});
