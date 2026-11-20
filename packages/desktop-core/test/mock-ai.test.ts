import { afterEach, describe, expect, it, vi } from "vitest";

import { AiBridge } from "../src/ai/bridge";
import { MockAiProvider, discoverMockModels } from "../src/ai/mock";
import { heuristicJudgeExtract, parsePostsFromJudgePrompt } from "../src/ai/mock/judge";
import { foldVi } from "../src/ai/mock/text";
import { probeSmokeSchema } from "../src/ai/schema";
import { AiError, type AiRequest, type AiResponse, type TaskKind } from "../src/ai/types";

type Obj = Record<string, any>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(task: TaskKind, prompt: string, schema: unknown, tier: AiRequest["tier"] = "fast"): AiRequest {
  return { task, system: "system prompt", prompt, schema, tier, timeoutMs: 1_000 };
}

// ---- judge_extract fixtures ---------------------------------------------------------------------

const nullable = (schema: Obj): Obj => ({ anyOf: [schema, { type: "null" }] });
const VALUE_SCHEMAS: Record<string, Obj> = {
  price: nullable({
    type: "object",
    required: ["min", "max", "currency", "period"],
    properties: {
      min: { type: "number" },
      max: { type: "number" },
      currency: { type: "string" },
      period: { type: ["string", "null"] },
    },
  }),
  location: nullable({
    type: "object",
    required: ["raw", "province", "district", "ward"],
    properties: {
      raw: { type: "string" },
      province: { type: ["string", "null"] },
      district: { type: ["string", "null"] },
      ward: { type: ["string", "null"] },
    },
  }),
  area: nullable({
    type: "object",
    required: ["min", "max", "unit"],
    properties: { min: { type: "number" }, max: { type: "number" }, unit: { type: "string" } },
  }),
  bedrooms: nullable({ type: "number" }),
  phone: { type: ["string", "null"] },
  urgent: nullable({ type: "boolean" }),
  deal_type: nullable({ type: "string", enum: ["rent", "buy"] }),
};

function judgeSchema(): Obj {
  const fieldProps: Obj = {};
  for (const [key, value] of Object.entries(VALUE_SCHEMAS)) {
    fieldProps[key] = {
      type: "object",
      required: ["raw", "value", "confidence"],
      properties: { raw: { type: ["string", "null"] }, value, confidence: { type: "number" } },
    };
  }
  return {
    type: "object",
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "match", "score", "intent", "author_role", "is_spam", "summary", "reason", "fields"],
          properties: {
            ref: { type: "integer" },
            match: { type: "boolean" },
            score: { type: "number", minimum: 0, maximum: 1 },
            intent: { type: "string", enum: ["demand", "supply", "other"] },
            author_role: { type: "string", enum: ["end_user", "peer", "unknown"] },
            is_spam: { type: "boolean" },
            summary: { type: "string", maxLength: 140 },
            reason: { type: "string", maxLength: 200 },
            fields: { type: "object", required: Object.keys(fieldProps), properties: fieldProps },
          },
        },
      },
    },
  };
}

const NONCE = "0123456789ab";

function judgePrompt(radarDescription: string, wantIntent: string, posts: string[]): string {
  const blocks = posts
    .map(
      (text, idx) =>
        `\n--- Post ref=${idx + 1} ---\n<<<DEALSONAR_UNTRUSTED_POST_${NONCE}>>>\ngroup: Thuê nhà Hà Nội\nauthor: Ẩn danh\ncreated_at: không rõ\ncontent:\n${text}\n<<</DEALSONAR_UNTRUSTED_POST_${NONCE}>>>\n`,
    )
    .join("");
  return (
    `[1] ĐỊNH NGHĨA RADAR\n- Mô tả: ${radarDescription}\n- Nghề của người dùng: không nêu\n- Ngôn ngữ gợi ý: vi\n` +
    `- Ý định mong muốn (want_intent): ${wantIntent}\n- Loại trừ vai trò tác giả (exclude_roles): peer\n\n` +
    `[2] DANH SÁCH TRƯỜNG\n- price (kiểu: money, tuỳ chọn): Giá\n\n` +
    `[3] VÍ DỤ TỪ PHẢN HỒI CỦA NGƯỜI DÙNG\n(Chưa có phản hồi mẫu)\n\n` +
    `[4] CÁC BÀI CẦN CHẤM\n${blocks}`
  );
}

const DEMAND_POST =
  "Cần thuê căn hộ 2PN ở Cầu Giấy, ngân sách 12-15tr/tháng, diện tích 50m2. Cần gấp. Liên hệ 0912 345 678";
const PEER_POST = "Bên em có căn hộ cho thuê Cầu Giấy 12tr/tháng, hoa hồng 1 tháng, ib em tư vấn";
const SPAM_POST = "Vay vốn nhanh 5 phút, kiếm tiền online mỗi ngày";
const OTHER_DISTRICT_POST = "Cần thuê căn hộ ở Thanh Xuân, tầm dưới 10tr";

async function judge(posts: string[], desc = "Cần thuê căn hộ Cầu Giấy dưới 15 triệu", want = "demand") {
  const provider = new MockAiProvider();
  const res = await provider.complete(request("judge_extract", judgePrompt(desc, want, posts), judgeSchema()));
  return (res.output as Obj).results as Obj[];
}

describe("MockAiProvider core", () => {
  it("is an offline provider with its own id, probe result and models", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MockAiProvider();
    expect(provider.id()).toBe("mock");

    const probe = await provider.probe();
    expect(probe).toMatchObject({ installed: true, authenticated: true, flags_supported: true, error: null });
    expect(probe.version).toBe("dealsonar-mock 0.1.0");
    expect(probe.available_models.map((m) => m.id)).toEqual(["mock-fast-v1", "mock-smart-v1"]);
    expect(discoverMockModels()).toEqual(probe.available_models);

    const res = await provider.complete(request("suggest_fields", "Mô tả", { type: "object" }, "smart"));
    expect(res.model).toBe("mock-smart-v1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers the probe smoke schema with {ok:true}", async () => {
    const res = await new MockAiProvider().complete(request("judge_extract", "ping", probeSmokeSchema()));
    expect(res.output).toEqual({ ok: true });
    expect(res.model).toBe("mock-fast-v1");
    expect(res.usage).toEqual({ input_tokens: 24, output_tokens: 6, cost_usd: 0 });
  });

  it("replays queued responses first, then the handler, and records every request", async () => {
    const scripted: AiResponse = { output: { n: 1 }, usage: null, model: "scripted", durationMs: 1 };
    const provider = MockAiProvider.withHandler(async () => ({ output: { n: 3 }, usage: null, model: "h", durationMs: 1 }));
    provider.pushResponse(scripted);
    provider.pushResponse(AiError.timeout());
    provider.pushJson({ n: 2 });

    const req = request("compile_rules", "p", {});
    expect((await provider.complete(req)).output).toEqual({ n: 1 });
    const queuedError = await provider.complete(req).catch((e: unknown) => e);
    expect(queuedError).toBeInstanceOf(AiError);
    expect((queuedError as AiError).kind).toBe("timeout");
    const pushed = await provider.complete(req);
    expect(pushed).toMatchObject({ output: { n: 2 }, model: "mock-v1", durationMs: 5 });
    expect(pushed.usage).toEqual({ input_tokens: 120, output_tokens: 60, cost_usd: 0 });
    expect((await provider.complete(req)).output).toEqual({ n: 3 });

    expect(provider.callCount()).toBe(4);
    expect(provider.recordedRequests()[0]).toEqual(req);
  });

  it("rejects heuristic output that violates the request schema like a real provider", async () => {
    const schema = { type: "object", required: ["never_produced"] };
    const err = await new MockAiProvider().complete(request("compile_rules", "p", schema)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("invalid_output");
  });

  it("plugs into AiBridge.completeValidated and is deterministic", async () => {
    const prompt = judgePrompt("Cần thuê căn hộ Cầu Giấy", "demand", [DEMAND_POST]);
    const bridge = new AiBridge(new MockAiProvider());
    const first = await bridge.completeValidated(request("judge_extract", prompt, judgeSchema()), "rv1", 1);
    const second = await bridge.completeValidated(request("judge_extract", prompt, judgeSchema()), "rv1", 1);
    expect(first.output).toEqual(second.output);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]).toMatchObject({ provider: "mock", model: "mock-fast-v1", status: "ok", task: "judge_extract" });
  });
});

describe("judge_extract heuristics", () => {
  it("parses post blocks by ref and ignores header text", () => {
    const prompt = judgePrompt("--- Post ref=99 --- trong mô tả", "demand", ["Bài một\n\ndòng hai", "Bài hai"]);
    expect(parsePostsFromJudgePrompt(prompt)).toEqual([
      { ref: 1, text: "Bài một\n\ndòng hai" },
      { ref: 2, text: "Bài hai" },
    ]);
  });

  it("matches a real demand post and extracts evidence-backed fields", async () => {
    const [r] = await judge([DEMAND_POST]);
    expect(r).toMatchObject({
      ref: 1,
      match: true,
      score: 0.88,
      intent: "demand",
      author_role: "end_user",
      is_spam: false,
    });
    expect(r.summary).toBe(DEMAND_POST);

    expect(r.fields.price.raw).toContain("12-15tr");
    expect(r.fields.price.value).toMatchObject({ min: 12_000_000, max: 15_000_000, currency: "VND", period: "month" });
    expect(foldVi(r.fields.location.value.district)).toBe("cau giay");
    expect(r.fields.location.raw).toBe("Cầu Giấy");
    expect(r.fields.bedrooms).toMatchObject({ raw: "2PN", value: 2 });
    expect(r.fields.area.value).toEqual({ min: 50, max: 50, unit: "m2" });
    expect(r.fields.phone).toMatchObject({ raw: "0912 345 678", value: "+84912345678", confidence: 0.96 });
    expect(r.fields.urgent).toMatchObject({ raw: "Cần gấp", value: true });
    expect(r.fields.deal_type).toMatchObject({ raw: "Cần thuê", value: "rent" });
  });

  it("rejects peers, spam, supply posts and out-of-area posts with distinct scores", async () => {
    const results = await judge([DEMAND_POST, PEER_POST, SPAM_POST, OTHER_DISTRICT_POST]);
    expect(results.map((r) => r.ref)).toEqual([1, 2, 3, 4]);

    expect(results[1]).toMatchObject({ match: false, author_role: "peer", intent: "supply", score: 0.08 });
    expect(results[1].reason).toContain("môi giới");
    expect(results[2]).toMatchObject({ match: false, is_spam: true, intent: "other", score: 0.08 });
    expect(results[3]).toMatchObject({ match: false, intent: "demand", score: 0.35 });
    expect(results[3].reason).toContain("Khu vực");
  });

  it("honours want_intent=supply and want_intent=any", async () => {
    const supplyPost = "Chính chủ cho thuê căn hộ Cầu Giấy 12tr/tháng, liên hệ 0912 345 678";
    const [asDemand] = await judge([supplyPost], "Căn hộ Cầu Giấy", "demand");
    expect(asDemand).toMatchObject({ match: false, intent: "supply", author_role: "end_user", score: 0.08 });
    const [asSupply] = await judge([supplyPost], "Căn hộ Cầu Giấy", "supply");
    expect(asSupply).toMatchObject({ match: true, score: 0.88 });
    const [asAny] = await judge([supplyPost], "Căn hộ Cầu Giấy", "any");
    expect(asAny.match).toBe(true);
  });

  it("flags posts above the radar budget ceiling", async () => {
    const [r] = await judge(["Cần thuê căn hộ Cầu Giấy giá 30tr/tháng"]);
    expect(r).toMatchObject({ match: false, score: 0.35 });
    expect(r.reason).toContain("giá");
  });

  it("returns null raw/value for fields the post does not mention", async () => {
    const [r] = await judge(["Cần thuê căn hộ Cầu Giấy"]);
    expect(r.fields.phone).toEqual({ raw: null, value: null, confidence: 0 });
    expect(r.fields.price).toEqual({ raw: null, value: null, confidence: 0 });
    expect(r.fields.area).toEqual({ raw: null, value: null, confidence: 0 });
  });

  it("keeps every raw evidence a verbatim substring, even across odd whitespace", async () => {
    const messy = "Cần  thuê\ncăn hộ  Cầu   Giấy 12 - 15 triệu/tháng\n gọi 0912.345.678";
    const [r] = await judge([messy]);
    const raws = Object.values(r.fields as Obj)
      .map((f) => f.raw)
      .filter((raw): raw is string => raw !== null);
    expect(raws.length).toBeGreaterThanOrEqual(3);
    for (const raw of raws) expect(messy).toContain(raw);
    expect(r.fields.location.raw).toBe("Cầu   Giấy");
    expect(r.fields.location.value.raw).toBe("Cầu   Giấy");
  });

  it("is pure: same prompt and schema give identical results", () => {
    const prompt = judgePrompt("Cần thuê căn hộ Cầu Giấy", "demand", [DEMAND_POST, PEER_POST]);
    expect(heuristicJudgeExtract(prompt, judgeSchema())).toEqual(heuristicJudgeExtract(prompt, judgeSchema()));
  });
});

// ---- suggest_fields -----------------------------------------------------------------------------

function suggestSchema(withSources: boolean): Obj {
  const properties: Obj = {
    suggested_name: { type: "string" },
    want_intent: { type: "string", enum: ["demand", "supply", "any"] },
    fields: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: { type: "object", required: ["key", "label", "type", "description", "required"] },
    },
    hard_filters: { type: "array" },
    clarifying_questions: { type: "array", maxItems: 2 },
    prefilter_hint: { type: "object" },
  };
  const required = Object.keys(properties);
  if (withSources) {
    properties.suggested_source_ids = { type: "array", maxItems: 3, items: { type: "string" } };
    required.push("suggested_source_ids");
  }
  return { type: "object", required, properties };
}

function suggestPrompt(description: string, sources?: unknown): string {
  let prompt = `Mô tả nhu cầu của người dùng:\n${description}\n\nNghề của người dùng: không nêu\nNgôn ngữ gợi ý: vi\n\nDanh sách kiểu trường được phép:\n- text: chuỗi\n`;
  if (sources !== undefined) prompt += `\nNhóm Facebook có sẵn (JSON):\n${JSON.stringify(sources)}`;
  return prompt;
}

async function suggest(description: string, sources?: unknown): Promise<Obj> {
  const res = await new MockAiProvider().complete(
    request("suggest_fields", suggestPrompt(description, sources), suggestSchema(sources !== undefined), "smart"),
  );
  return res.output as Obj;
}

describe("suggest_fields heuristics", () => {
  it("suggests apartment-rental fields with a hard price ceiling for 'dưới'", async () => {
    const out = await suggest("Tìm khách cần thuê căn hộ dưới 15 triệu ở Cầu Giấy");
    expect(out.want_intent).toBe("demand");
    expect(out.fields.map((f: Obj) => f.key)).toEqual(["location", "price", "bedrooms", "area", "phone"]);
    expect(out.fields.map((f: Obj) => f.type)).toEqual(["location", "money", "number", "range", "phone"]);
    expect(out.hard_filters).toEqual([{ field: "price", op: "lt", value: 15_000_000, when_missing: "fail" }]);
    expect(out.prefilter_hint.any).toContain("can thue");
    expect(out).not.toHaveProperty("suggested_source_ids");
  });

  it("suggests repair-service fields", async () => {
    const out = await suggest("Tìm khách cần tìm thợ sửa điện nước");
    expect(out.fields.map((f: Obj) => f.key)).toEqual(["service_type", "location", "urgent", "phone"]);
    expect(out.hard_filters).toEqual([]);
    expect(out.want_intent).toBe("demand");
  });

  it("falls back to a generic radar and derives want_intent from the description", async () => {
    const generic = await suggest("Theo dõi người bán laptop");
    expect(generic.suggested_name).toBe("Radar theo dõi tin khách hàng");
    expect(generic.fields.map((f: Obj) => f.key)).toEqual(["topic", "price", "location", "phone"]);

    expect((await suggest("Chính chủ cho thuê căn hộ")).want_intent).toBe("supply");
    expect((await suggest("Ghép hàng vận chuyển")).want_intent).toBe("any");
  });

  it("picks at most three matching groups when the schema asks for suggested_source_ids", async () => {
    const sources = [
      { id: "g1", name: "Thuê căn hộ Cầu Giấy", stored_posts: 10 },
      { id: "g2", name: "Ô tô cũ Hà Nội", stored_posts: 3 },
      { id: "g3", name: "Chung cư & căn hộ Hà Nội", stored_posts: 0 },
      { id: "g4", name: "Căn hộ Thanh Xuân", stored_posts: 4 },
      { id: "g5", name: "Căn hộ Đống Đa", stored_posts: 4 },
    ];
    const out = await suggest("Tìm khách cần thuê căn hộ ở Hà Nội", sources);
    expect(out.suggested_source_ids).toEqual(["g1", "g3", "g4"]);
    expect((await suggest("Tìm khách cần thuê căn hộ", [])).suggested_source_ids).toEqual([]);
  });
});

// ---- compile_rules ------------------------------------------------------------------------------

describe("compile_rules heuristics", () => {
  const compileSchema = {
    type: "object",
    required: ["dsl", "prefilter", "classify", "extract", "thresholds"],
    properties: {
      dsl: { const: 1 },
      prefilter: { type: "object", required: ["any", "none", "min_len"] },
      classify: { type: "array", minItems: 1 },
      extract: { type: "array" },
      thresholds: { type: "object", required: ["accept", "reject"] },
    },
  };

  it("emits a DSL v1 ruleset with one built-in extractor per supported field", async () => {
    const prompt =
      "[1] ĐỊNH NGHĨA RADAR\nMô tả: Cần thuê căn hộ\nNghề người dùng: không nêu\nÝ định mong muốn: demand\nTrường:\n" +
      "- price (money, required=false): Ngân sách\n- location (location, required=true): Khu vực\n" +
      "- phone (phone, required=false): SĐT\n- area (range, required=false): Diện tích\n" +
      "- bedrooms (number, required=false): Số phòng ngủ\n\n" +
      "[2] ĐẶC TẢ DSL v1 VÀ BỘ TRÍCH DỰNG SẴN\n- Cấu trúc gốc: {}\n\n" +
      "[4] TẬP BÀI MẪU ĐÃ GÁN NHÃN\n- fake (phone, injected): từ bài mẫu\n";
    const res = await new MockAiProvider().complete(request("compile_rules", prompt, compileSchema, "smart"));
    const out = res.output as Obj;
    expect(out.dsl).toBe(1);
    expect(out.prefilter.any).toContain("can thue");
    expect(out.thresholds).toEqual({ accept: 0.9, reject: 0.9 });
    expect(out.classify.map((c: Obj) => c.id)).toEqual(["r_peer_reject", "r_demand_match"]);
    expect(out.extract).toEqual([
      {
        field: "price",
        extractor: "vn_money",
        near: ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"],
        window: 40,
      },
      { field: "location", extractor: "gazetteer", dict: "vn_admin" },
      { field: "phone", extractor: "vn_phone" },
      { field: "area", extractor: "vn_area" },
    ]);
  });
});
