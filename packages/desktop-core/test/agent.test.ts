import { beforeEach, describe, expect, it } from "vitest";

import { CoreError } from "../src/backend/wire";
import {
  type AgentHooks,
  type AgentLicenseLimits,
  type AgentPreviewState,
  type AgentRadarDraft,
  createAgentBackend,
  parseUlid,
} from "../src/services/agent";
import { Store } from "../src/store/store";
import { newUlid } from "../src/store/util";
import { type TestCtx, makeCtx } from "./protocol-support";

/** Matches the host's `AgentError`: the only error whose text reaches the MCP client. */
class AgentError extends Error {}

const RESTORED: AgentPreviewState = {
  preview_id: "restored",
  status: "error",
  total_posts: 0,
  evaluated_posts: 0,
  failed_posts: 0,
  items: [],
  warnings: [],
};

interface Probe extends AgentHooks {
  limits: AgentLicenseLimits;
  persisted: Array<{ draft: AgentRadarDraft; id: string }>;
  started: string[];
  previews: Map<string, AgentPreviewState>;
  /** State a started preview moves to. */
  startState: AgentPreviewState;
  startError: unknown;
}

let ctx: TestCtx;
let probe: Probe;
let backend: ReturnType<typeof createAgentBackend>;

function makeProbe(store: Store): Probe {
  const p: Probe = {
    limits: { max_fields_per_radar: 5, max_followed_groups: 3 },
    persisted: [],
    started: [],
    previews: new Map(),
    startState: { ...RESTORED, preview_id: "pv1", status: "crawling" },
    startError: null,
    licenseLimits: () => p.limits,
    persistRadarDraft(draft, id) {
      p.persisted.push({ draft, id });
      return store.radars.createDraft({
        id,
        name: draft.name.trim(),
        description: draft.description,
        language_hint: "vi",
        user_profession: draft.user_profession,
        fields: draft.fields,
        match_policy: draft.match_policy,
        source_ids: draft.source_ids,
        now_ms: Date.now(),
      });
    },
    getRadarPreview: (id) => p.previews.get(id) ?? RESTORED,
    async startRadarPreview(id) {
      if (p.startError) throw p.startError;
      p.started.push(id);
      p.previews.set(id, { ...p.startState, preview_id: `pv-${p.started.length}` });
      return p.previews.get(id)!;
    },
  };
  return p;
}

beforeEach(() => {
  ctx = makeCtx(Store.openInMemory());
  probe = makeProbe(ctx.store);
  backend = createAgentBackend(ctx, { hooks: probe, AgentError });
});

function addGroup(externalId: string, opts: { followed?: boolean; state?: string; kind?: string; platform?: string } = {}) {
  ctx.store.sources.upsertDiscovered(
    [{ platform: opts.platform ?? "facebook", kind: opts.kind ?? "group", external_id: externalId, name: `Nhóm ${externalId}`, url: `https://www.facebook.com/groups/${externalId}` }],
    opts.followed ?? false,
    null,
    1_000,
  );
  const source = ctx.store.sources.getByExternalId(opts.platform ?? "facebook", externalId)!;
  if (opts.state) ctx.store.sources.setState(source.id, opts.state);
  return source;
}

const priceField = { key: "price", label: "Giá", type: "money" };
const areaField = { key: "area", label: "Diện tích", type: "number", required: true };

function prepareArgs(sourceIds: string[], over: Record<string, unknown> = {}) {
  return {
    draft_id: newUlid(),
    name: "  Thuê nhà Cầu Giấy ",
    description: "Tìm người cần thuê nhà",
    source_ids: sourceIds,
    fields: [priceField, areaField],
    want_intent: "demand",
    ...over,
  };
}

const call = (method: Parameters<typeof backend.handle>[0], args: unknown = {}) => backend.handle(method, args);
const failure = async (method: Parameters<typeof backend.handle>[0], args: unknown): Promise<string> => {
  try {
    await call(method, args);
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError);
    return (err as Error).message;
  }
  throw new Error("expected AgentError");
};

describe("list_radar_sources", () => {
  it("lists only healthy Facebook groups, with counts and limits but no post content", async () => {
    const ok = addGroup("1", { followed: true });
    addGroup("2", { state: "error" });
    addGroup("3", { state: "inaccessible" });
    addGroup("4", { kind: "page" });
    const result = (await call("list_radar_sources")) as { draft_id: string; sources: unknown[]; max_fields: number; max_groups: number };
    expect(result.sources).toEqual([{ id: ok.id, name: "Nhóm 1", followed: true, stored_post_count: 0, recent_post_count: 0 }]);
    expect([result.max_fields, result.max_groups]).toEqual([5, 3]);
    expect(parseUlid(result.draft_id)).toBe(result.draft_id);
    expect(Object.keys(result).sort()).toEqual(["draft_id", "max_fields", "max_groups", "sources"]);
  });

  it("hands out a fresh draft id each time", async () => {
    const a = (await call("list_radar_sources")) as { draft_id: string };
    const b = (await call("list_radar_sources")) as { draft_id: string };
    expect(a.draft_id).not.toBe(b.draft_id);
  });
});

describe("prepare_radar", () => {
  it("creates a normalized DRAFT radar and starts its preview; activation stays with the user", async () => {
    const s1 = addGroup("1");
    const s2 = addGroup("2");
    const args = prepareArgs([s2.id, s1.id, s2.id], { user_profession: "  Môi giới  " });
    const result = (await call("prepare_radar", args)) as Record<string, unknown>;

    expect(probe.persisted).toHaveLength(1);
    const { draft, id } = probe.persisted[0]!;
    expect(id).toBe(parseUlid(args.draft_id));
    expect(draft).toMatchObject({
      name: "  Thuê nhà Cầu Giấy ",
      user_profession: "Môi giới",
      source_ids: [s1.id, s2.id].sort(),
      match_policy: { want_intent: "demand", exclude_roles: ["peer"], hard_filters: [] },
    });
    expect(draft.fields.map((f) => [f.key, f.order, f.show_in_alert, f.required])).toEqual([
      ["price", 1, true, false],
      ["area", 2, true, true],
    ]);

    const radar = ctx.store.radars.get(id)!;
    expect(radar.radar.status).toBe("draft");
    expect(radar.radar.name).toBe("Thuê nhà Cầu Giấy");
    expect(ctx.events).toContainEqual({ event: "radar:draft-created", payload: id });
    expect(probe.started).toEqual([id]);
    expect(result).toEqual({
      radar_id: id,
      name: "Thuê nhà Cầu Giấy",
      source_ids: [s1.id, s2.id].sort(),
      status: "crawling",
      total_posts: 0,
      evaluated_posts: 0,
      matched_posts: 0,
      failed_posts: 0,
      warnings: [],
      error: null,
      review_in: "DealSonar → Radar → Xem kết quả",
    });
  });

  it("honours exclude_peers=false and hard filters", async () => {
    const s = addGroup("1");
    await call(
      "prepare_radar",
      prepareArgs([s.id], { exclude_peers: false, want_intent: "any", hard_filters: [{ field: "price", op: "lte", value: 15_000_000 }] }),
    );
    expect(probe.persisted[0]!.draft.match_policy).toEqual({
      want_intent: "any",
      exclude_roles: [],
      hard_filters: [{ field: "price", op: "lte", value: 15_000_000, when_missing: "pass" }],
    });
  });

  it("is idempotent for the same draft id and arguments", async () => {
    const s = addGroup("1");
    const args = prepareArgs([s.id]);
    const first = (await call("prepare_radar", args)) as { radar_id: string; status: string };
    const second = (await call("prepare_radar", { ...args, source_ids: [s.id, s.id] })) as { radar_id: string; status: string };
    expect(probe.persisted).toHaveLength(1);
    expect(probe.started).toHaveLength(1);
    expect(second.radar_id).toBe(first.radar_id);
    expect(second.status).toBe("crawling");
  });

  it("restarts the preview of an existing draft whose preview was never started in this session", async () => {
    const s = addGroup("1");
    const args = prepareArgs([s.id]);
    await call("prepare_radar", args);
    probe.previews.clear();
    await call("prepare_radar", args);
    expect(probe.persisted).toHaveLength(1);
    expect(probe.started).toHaveLength(2);
  });

  it("rejects a reused draft id with different content", async () => {
    const s = addGroup("1");
    const args = prepareArgs([s.id]);
    await call("prepare_radar", args);
    for (const change of [{ name: "Khác" }, { description: "Mô tả khác" }, { want_intent: "supply" }, { fields: [priceField] }, { user_profession: "x" }, { exclude_peers: false }]) {
      expect(await failure("prepare_radar", { ...args, ...change })).toBe(
        "dữ liệu đầu vào không hợp lệ: Radar này đã thay đổi hoặc mã nháp đã được dùng cho yêu cầu khác.",
      );
    }
    expect(probe.persisted).toHaveLength(1);
  });

  it("rejects a draft id that was activated or archived since", async () => {
    const s = addGroup("1");
    const args = prepareArgs([s.id]);
    await call("prepare_radar", args);
    ctx.store.db.prepare("UPDATE radars SET status = 'active'").run();
    expect(await failure("prepare_radar", args)).toMatch(/Radar này đã thay đổi/);
  });

  it("validates arguments like serde", async () => {
    const s = addGroup("1");
    const ok = prepareArgs([s.id]);
    const v = (detail: string) => `dữ liệu đầu vào không hợp lệ: ${detail}`;
    expect(await failure("prepare_radar", null)).toBe(v("invalid type: null, expected struct PrepareInput"));
    expect(await failure("prepare_radar", { ...ok, extra: 1 })).toMatch(/^dữ liệu đầu vào không hợp lệ: unknown field `extra`, expected one of `draft_id`/);
    expect(await failure("prepare_radar", { ...ok, name: undefined })).toBe(v("missing field `name`"));
    expect(await failure("prepare_radar", { ...ok, want_intent: undefined })).toBe(v("missing field `want_intent`"));
    expect(await failure("prepare_radar", { ...ok, want_intent: "both" })).toMatch(/^dữ liệu đầu vào không hợp lệ: unknown variant `both`/);
    expect(await failure("prepare_radar", { ...ok, fields: [{ key: "x", label: "X", type: "bogus" }] })).toMatch(/unknown variant `bogus`/);
    expect(await failure("prepare_radar", { ...ok, hard_filters: [{ field: "price", op: "eq", when_missing: "maybe" }] })).toMatch(/unknown variant `maybe`/);
    expect(await failure("prepare_radar", { ...ok, exclude_peers: "yes" })).toMatch(/expected a boolean/);
    expect(probe.persisted).toHaveLength(0);
  });

  it("enforces draft id, fields, filters and sources", async () => {
    const s = addGroup("1");
    const v = (detail: string) => `dữ liệu đầu vào không hợp lệ: ${detail}`;
    expect(await failure("prepare_radar", prepareArgs([s.id], { draft_id: "not-a-ulid" }))).toBe(v("Hãy dùng draft_id từ list_radar_sources."));
    expect(await failure("prepare_radar", prepareArgs([s.id], { fields: [] }))).toBe(v("Chọn ít nhất một thông tin cần trích xuất."));
    expect(await failure("prepare_radar", prepareArgs([s.id], { hard_filters: [{ field: "nope", op: "eq", value: 1 }] }))).toBe(
      v("Mỗi điều kiện bắt buộc phải dùng một key trong fields."),
    );
    expect(await failure("prepare_radar", prepareArgs([]))).toBe(v("Chọn ít nhất một group phù hợp từ list_radar_sources."));
    expect(await failure("prepare_radar", prepareArgs(["missing-id"]))).toBe(v("Group missing-id không còn sẵn sàng. Hãy lấy lại danh sách nguồn."));
    const broken = addGroup("2", { state: "error" });
    expect(await failure("prepare_radar", prepareArgs([broken.id]))).toMatch(/không còn sẵn sàng/);
    expect(probe.persisted).toHaveLength(0);
  });

  it("applies the plan's followed-group limit to followed plus requested groups", async () => {
    addGroup("f1", { followed: true });
    addGroup("f2", { followed: true });
    const a = addGroup("a");
    const b = addGroup("b");
    expect(await failure("prepare_radar", prepareArgs([a.id, b.id]))).toBe("đã đạt giới hạn gói bản quyền: Gói hiện tại cho phép tối đa 3 group theo dõi.");
    // One new group fits (2 followed + 1).
    await call("prepare_radar", prepareArgs([a.id]));
    expect(probe.persisted).toHaveLength(1);
  });

  it("passes persistence failures (license field cap) through as the agent error text", async () => {
    const s = addGroup("1");
    probe.persistRadarDraft = () => {
      throw CoreError.licenseLimit("Current Personal plan allows at most 5 fields per radar (got 6)");
    };
    expect(await failure("prepare_radar", prepareArgs([s.id]))).toBe(
      "đã đạt giới hạn gói bản quyền: Current Personal plan allows at most 5 fields per radar (got 6)",
    );
  });

  it("reports a failed preview start inside the summary instead of failing the call", async () => {
    const s = addGroup("1");
    probe.startError = CoreError.internal("extension offline");
    const result = (await call("prepare_radar", prepareArgs([s.id]))) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "error", error: "lỗi nội bộ hệ thống: extension offline", review_in: "DealSonar → Radar" });
    expect(ctx.store.radars.get(result.radar_id as string)!.radar.status).toBe("draft");
  });
});

describe("check_radar_preview / retry_radar_preview", () => {
  async function draftRadar() {
    const s = addGroup("1");
    const { radar_id } = (await call("prepare_radar", prepareArgs([s.id]))) as { radar_id: string };
    return { radarId: radar_id, source: s };
  }

  it("check summarizes without starting anything", async () => {
    const { radarId } = await draftRadar();
    probe.previews.set(radarId, {
      preview_id: "pv-x",
      status: "done",
      total_posts: 4,
      evaluated_posts: 4,
      failed_posts: 1,
      items: [{ verdict: "match" }, { verdict: "reject" }, { verdict: "match" }],
      warnings: [{ code: "too_broad", message: "Quá rộng" }],
    });
    const started = probe.started.length;
    const result = await call("check_radar_preview", { radar_id: radarId });
    expect(result).toMatchObject({ radar_id: radarId, status: "done", total_posts: 4, evaluated_posts: 4, matched_posts: 2, failed_posts: 1, error: null });
    expect((result as { warnings: unknown[] }).warnings).toEqual([{ code: "too_broad", message: "Quá rộng" }]);
    expect(probe.started).toHaveLength(started);
  });

  it("reports not_started for a restored preview and explains an empty failure", async () => {
    const { radarId } = await draftRadar();
    probe.previews.clear();
    expect(await call("check_radar_preview", { radar_id: radarId })).toMatchObject({ status: "not_started" });
    probe.previews.set(radarId, { ...RESTORED, preview_id: "pv-e" });
    expect(await call("check_radar_preview", { radar_id: radarId })).toMatchObject({
      status: "error",
      error: "Chưa có bài để xem thử. Kiểm tra nhóm nguồn và Chrome Extension trong DealSonar.",
    });
    probe.previews.set(radarId, { ...RESTORED, preview_id: "pv-e", total_posts: 3 });
    expect(await call("check_radar_preview", { radar_id: radarId })).toMatchObject({
      error: "Xem thử chưa hoàn tất. Mở Radar trong DealSonar để xem chi tiết.",
    });
  });

  it("retry restarts a finished preview but not one that is still running", async () => {
    const { radarId } = await draftRadar();
    const before = probe.started.length;
    probe.previews.set(radarId, { ...RESTORED, preview_id: "pv-run", status: "evaluating" });
    await call("retry_radar_preview", { radar_id: radarId });
    expect(probe.started).toHaveLength(before);

    probe.previews.set(radarId, { ...RESTORED, preview_id: "pv-done", status: "done", total_posts: 2 });
    await call("retry_radar_preview", { radar_id: radarId });
    expect(probe.started).toHaveLength(before + 1);
  });

  it("retry revalidates the sources and returns the reason as a summary error", async () => {
    const { radarId, source } = await draftRadar();
    probe.previews.set(radarId, { ...RESTORED, preview_id: "pv-done", status: "done" });
    ctx.store.sources.setState(source.id, "inaccessible");
    expect(await call("retry_radar_preview", { radar_id: radarId })).toMatchObject({
      status: "error",
      error: `dữ liệu đầu vào không hợp lệ: Group ${source.id} không còn sẵn sàng. Hãy lấy lại danh sách nguồn.`,
    });
  });

  it("only works on draft radars", async () => {
    const { radarId } = await draftRadar();
    const msg = "dữ liệu đầu vào không hợp lệ: Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.";
    expect(await failure("check_radar_preview", { radar_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe(msg);
    ctx.store.db.prepare("UPDATE radars SET status = 'active' WHERE id = ?1").run(radarId);
    expect(await failure("check_radar_preview", { radar_id: radarId })).toBe(msg);
    expect(await failure("retry_radar_preview", { radar_id: radarId })).toBe(msg);
  });

  it("rejects malformed arguments", async () => {
    expect(await failure("check_radar_preview", {})).toBe("dữ liệu đầu vào không hợp lệ: missing field `radar_id`");
    expect(await failure("check_radar_preview", { radar_id: "x", extra: 1 })).toMatch(/unknown field `extra`, expected one of `radar_id`/);
    expect(await failure("retry_radar_preview", "x")).toMatch(/expected struct PreviewInput/);
  });
});

describe("agent safety", () => {
  it("never exposes post bodies, authors or permalinks in any response", async () => {
    const s = addGroup("1");
    const secret = "SECRET-POST-BODY";
    probe.startState = {
      ...RESTORED,
      preview_id: "pv",
      status: "done",
      total_posts: 1,
      evaluated_posts: 1,
      items: [{ verdict: "match", post_text: secret, author_name: "Ai Đó", permalink: "https://fb/p/1", summary: secret } as { verdict: string }],
    };
    const responses = [
      await call("list_radar_sources"),
      await call("prepare_radar", prepareArgs([s.id])),
    ];
    const radarId = (responses[1] as { radar_id: string }).radar_id;
    responses.push(await call("check_radar_preview", { radar_id: radarId }), await call("retry_radar_preview", { radar_id: radarId }));
    const text = JSON.stringify(responses);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Ai Đó");
    expect(text).not.toContain("https://fb/p/1");
    expect(responses[1]).toMatchObject({ matched_posts: 1 });
  });

  it("refuses everything while shutting down", async () => {
    ctx.shuttingDown = true;
    expect(await failure("list_radar_sources", {})).toBe("hệ thống đang tắt");
  });

  it("turns unexpected failures into an agent error with the CoreError text, never a stack", async () => {
    probe.licenseLimits = () => {
      throw new Error("boom at /secret/path");
    };
    const message = await failure("list_radar_sources", {});
    expect(message).toBe("lỗi nội bộ hệ thống: boom at /secret/path");
    expect(message).not.toContain("\n");
  });

  it("passes an AgentError from a hook through untouched", async () => {
    probe.licenseLimits = () => {
      throw new AgentError("custom");
    };
    expect(await failure("list_radar_sources", {})).toBe("custom");
  });
});

describe("parseUlid", () => {
  it("accepts canonical and lower-case ULIDs and canonicalizes them", () => {
    expect(parseUlid("01arz3ndektsv4rrffq69g5fav")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
  it("rejects wrong length, bad characters and overflow", () => {
    expect(parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBeNull();
    expect(parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBeNull(); // U is not Crockford
    expect(parseUlid("81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(parseUlid("")).toBeNull();
  });
});
