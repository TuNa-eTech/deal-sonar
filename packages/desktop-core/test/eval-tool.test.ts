// Offline AI quality evaluator (port of crates/ai-bridge eval.rs + bin/eval.rs): parsers, the
// deterministic scoring, the report and the CLI, driven by scripted providers behind a real
// AiBridge and the pipeline AI hooks (no CLI, no network).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { AiBridge } from "../src/ai/bridge";
import type { AiProvider, AiRequest, AiResponse, ProbeResult, ProviderId } from "../src/ai/types";
import type { RadarPromptContext } from "../src/pipeline/types";
import { createPipelineAiHooks } from "../src/services/pipeline-ai";
import type { FieldDef } from "../src/store/domain";
import {
  type EvalSummary,
  type GoldenSample,
  formatEvalReport,
  formatFixed,
  normalizeForEvidence,
  parseGoldenJsonl,
  parseRadarContextJson,
  runOfflineEval,
  valuesMatchNormalized,
  verifyRawInPost,
} from "../src/tools/eval";
import { runEvalCli } from "../src/tools/eval-cli";
import { MockAiProvider } from "../src/ai/mock";

const GOLDEN_DIR = path.resolve(__dirname, "../../../docs/eval/golden");

// ---- fakes ------------------------------------------------------------------------------------------

type Responder = (req: AiRequest) => AiResponse;

class ScriptedProvider implements AiProvider {
  constructor(private readonly responder: Responder) {}
  id(): ProviderId {
    return "mock";
  }
  async probe(): Promise<ProbeResult> {
    return { installed: true, version: "fake", authenticated: true, flags_supported: true, latency_ms: 1, error: null, available_models: [] };
  }
  async complete(req: AiRequest): Promise<AiResponse> {
    return this.responder(req);
  }
}

const hooksFor = (responder: Responder) => createPipelineAiHooks({ bridge: new AiBridge(new ScriptedProvider(responder)) });

const refsInPrompt = (req: AiRequest): number[] => [...req.prompt.matchAll(/--- Post ref=(\d+) ---/g)].map((m) => Number(m[1]));

const field = (key: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
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

const RADAR: RadarPromptContext = {
  radar_version_id: "rv-eval",
  description: "Tìm nhà thuê",
  user_profession: null,
  language_hint: null,
  want_intent: "demand",
  exclude_roles: ["peer"],
  fields: [field("phone", "phone"), field("bedrooms", "number", { required: true })],
  feedback_examples: [],
};

const sample = (over: Partial<GoldenSample> & Pick<GoldenSample, "id" | "text">): GoldenSample => ({
  group_name: "Nhóm",
  author_name: null,
  created_at_ms: null,
  expected_match: false,
  expected_author_role: null,
  expected_fields: {},
  ...over,
});

// ---- parsers ----------------------------------------------------------------------------------------

describe("golden dataset and radar parsers", () => {
  it("skips blank lines and comments and applies the serde defaults", () => {
    const content = [
      "# comment",
      "",
      '{"id":"a","text":"hi","expected_match":true}',
      '  {"id":"b","group_name":"G","author_name":"N","created_at_ms":5,"text":"t","expected_match":false,"expected_author_role":"peer","expected_fields":{"x":1}}',
    ].join("\n");
    const samples = parseGoldenJsonl(content);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({
      id: "a",
      group_name: "Group thử nghiệm",
      author_name: null,
      created_at_ms: null,
      text: "hi",
      expected_match: true,
      expected_author_role: null,
      expected_fields: {},
    });
    expect(samples[1]?.expected_author_role).toBe("peer");
    expect(samples[1]?.expected_fields).toEqual({ x: 1 });
  });

  it("reports the failing line number", () => {
    expect(() => parseGoldenJsonl('# c\n{"id":"a"}')).toThrow(/invalid JSONL on line 2/);
    expect(() => parseGoldenJsonl("{not json}")).toThrow(/invalid JSONL on line 1/);
    expect(() => parseGoldenJsonl('{"id":"a","text":"t","expected_match":true,"expected_author_role":"alien"}')).toThrow(/line 1/);
  });

  it("parses a direct RadarPromptContext", () => {
    const radar = parseRadarContextJson(
      JSON.stringify({
        radar_version_id: "rv",
        description: "d",
        want_intent: "supply",
        fields: [{ key: "k", label: "K", type: "text", description: "desc" }],
        unknown_key: 1,
      }),
    );
    expect(radar.radar_version_id).toBe("rv");
    expect(radar.want_intent).toBe("supply");
    expect(radar.exclude_roles).toEqual([]);
    expect(radar.fields[0]).toEqual({ key: "k", label: "K", type: "text", description: "desc", required: false, options: null, show_in_alert: true, order: 0 });
  });

  it("falls back to the radar version layout", () => {
    const radar = parseRadarContextJson(
      JSON.stringify({ id: "v1", description_template: "tpl", user_profession: "p", match_policy: { want_intent: "any" }, fields: [] }),
    );
    expect(radar).toMatchObject({
      radar_version_id: "v1",
      description: "tpl",
      user_profession: "p",
      language_hint: null,
      want_intent: "any",
      exclude_roles: ["peer"],
      fields: [],
      feedback_examples: [],
    });
    const defaults = parseRadarContextJson(JSON.stringify({ description: "d", want_intent: "bogus" }));
    expect(defaults.radar_version_id).toBe("eval-radar-v1");
    expect(defaults.want_intent).toBe("demand");
  });

  it("rejects malformed radar JSON with the Rust messages", () => {
    expect(() => parseRadarContextJson("not json")).toThrow(/invalid radar JSON/);
    expect(() => parseRadarContextJson("[]")).toThrow("radar JSON must be an object");
    expect(() => parseRadarContextJson('{"fields":[]}')).toThrow("radar JSON missing 'description'");
    expect(() => parseRadarContextJson('{"description":"d","fields":[{"key":"k"}]}')).toThrow(/invalid radar 'fields' array/);
  });

  it.each(["bds", "dich-vu", "multilingual", "xe-cu"])("parses the %s golden files", (name) => {
    const samples = parseGoldenJsonl(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.jsonl`), "utf8"));
    const radar = parseRadarContextJson(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.radar.json`), "utf8"));
    expect(samples.length).toBeGreaterThan(0);
    expect(radar.fields.length).toBeGreaterThan(0);
  });
});

// ---- scoring primitives -----------------------------------------------------------------------------

describe("valuesMatchNormalized", () => {
  it("treats null as equal only to null", () => {
    expect(valuesMatchNormalized("text", null, null)).toBe(true);
    expect(valuesMatchNormalized("text", null, "x")).toBe(false);
    expect(valuesMatchNormalized("number", 1, null)).toBe(false);
  });

  it("compares numbers with a 1e-4 tolerance", () => {
    expect(valuesMatchNormalized("number", 2, 2.00001)).toBe(true);
    expect(valuesMatchNormalized("number", 2, 2.001)).toBe(false);
    expect(valuesMatchNormalized("number", 2, "2")).toBe(false);
  });

  it("compares money within 1 unit and ignores currency case", () => {
    const expected = { min: 12_000_000, max: 15_000_000, currency: "VND" };
    expect(valuesMatchNormalized("money", expected, { min: 12_000_001, max: 15_000_000, currency: "vnd" })).toBe(true);
    expect(valuesMatchNormalized("money", expected, { min: 12_000_002, max: 15_000_000, currency: "VND" })).toBe(false);
    expect(valuesMatchNormalized("money", expected, { min: 12_000_000, max: 15_000_000, currency: "USD" })).toBe(false);
    expect(valuesMatchNormalized("money", expected, { min: 12_000_000, max: 15_000_000 })).toBe(true);
    expect(valuesMatchNormalized("money", expected, { min: 12_000_000 })).toBe(false);
  });

  it("compares ranges within 0.1", () => {
    expect(valuesMatchNormalized("range", { min: 65, max: 75 }, { min: 65.05, max: 75 })).toBe(true);
    expect(valuesMatchNormalized("range", { min: 65, max: 75 }, { min: 65.2, max: 75 })).toBe(false);
  });

  it("compares location province/district case-insensitively and ignores unlabeled parts", () => {
    const expected = { province: "Hà Nội", district: "Cầu Giấy" };
    expect(valuesMatchNormalized("location", expected, { province: " hà nội ", district: "cầu giấy", ward: "x" })).toBe(true);
    expect(valuesMatchNormalized("location", { province: "Hà Nội" }, { province: "Hà Nội" })).toBe(true);
    expect(valuesMatchNormalized("location", { district: "A" }, {})).toBe(false);
  });

  it("compares text-like fields trimmed and case-insensitively, others structurally", () => {
    expect(valuesMatchNormalized("text", "Abc ", "abc")).toBe(true);
    expect(valuesMatchNormalized("enum", "rent", "buy")).toBe(false);
    expect(valuesMatchNormalized("phone", "+84912345678", "+84912345678")).toBe(true);
    expect(valuesMatchNormalized("text", 5, 5)).toBe(true);
    expect(valuesMatchNormalized("boolean", true, true)).toBe(true);
    expect(valuesMatchNormalized("boolean", true, false)).toBe(false);
    expect(valuesMatchNormalized("multi_enum", ["a", "b"], ["a", "b"])).toBe(true);
    expect(valuesMatchNormalized("multi_enum", ["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("evidence check", () => {
  it("normalizes like the Rust version (control characters are dropped, not spaced)", () => {
    expect(normalizeForEvidence("  A   B  ")).toBe("a b");
    expect(normalizeForEvidence("a\nb")).toBe("ab");
    expect(normalizeForEvidence("a\u200Bb")).toBe("ab");
  });

  it("verifies raw as a case and whitespace insensitive substring", () => {
    expect(verifyRawInPost("Gọi 0912 345 678 nhé", "0912   345 678")).toBe(true);
    expect(verifyRawInPost("Hello World", "hello world")).toBe(true);
    expect(verifyRawInPost("abc", "")).toBe(false);
    expect(verifyRawInPost("abc", "xyz")).toBe(false);
  });
});

describe("formatFixed", () => {
  it("rounds exact ties to even like Rust and everything else like toFixed", () => {
    expect(formatFixed(0.125, 2)).toBe("0.12");
    expect(formatFixed(0.375, 2)).toBe("0.38");
    expect(formatFixed(87.125, 2)).toBe("87.12");
    expect(formatFixed(2.5, 0)).toBe("2");
    expect(formatFixed(3.5, 0)).toBe("4");
    expect(formatFixed(1.005, 2)).toBe("1.00");
    expect(formatFixed(100, 2)).toBe("100.00");
    expect(formatFixed(33.3333333, 1)).toBe("33.3");
  });
});

// ---- runOfflineEval ---------------------------------------------------------------------------------

describe("runOfflineEval", () => {
  const nullField = { raw: null, value: null, confidence: 0 };
  const item = (ref: number, over: Record<string, unknown>): Record<string, unknown> => ({
    ref,
    match: false,
    score: 0.1,
    intent: "other",
    author_role: "unknown",
    is_spam: false,
    summary: "s",
    reason: "r",
    fields: { phone: nullField, bedrooms: nullField },
    ...over,
  });
  const answers: Record<number, Record<string, unknown>> = {
    1: {
      match: true,
      score: 0.9,
      intent: "demand",
      author_role: "end_user",
      fields: {
        phone: { raw: "0912345678", value: "+84912345678", confidence: 0.9 },
        bedrooms: { raw: "2pn", value: 2, confidence: 0.9 },
      },
    },
    2: { match: true, score: 0.8, intent: "demand", author_role: "end_user" },
    3: {
      match: false,
      fields: {
        phone: { raw: "không có trong bài", value: "+84900000000", confidence: 0.5 },
        bedrooms: { raw: null, value: 4, confidence: 0.5 },
      },
    },
  };
  const samples: GoldenSample[] = [
    sample({ id: "s1", text: "Cần thuê 2pn, sdt 0912345678", expected_match: true, expected_author_role: "end_user", expected_fields: { phone: "+84912345678", bedrooms: 2 } }),
    sample({ id: "s2", text: "Môi giới nhận ký gửi", expected_match: false, expected_author_role: "peer" }),
    sample({ id: "s3", text: "Tìm nhà", expected_match: true, expected_author_role: "end_user", expected_fields: { bedrooms: 3 } }),
  ];

  const scripted: Responder = (req) => ({
    output: { results: refsInPrompt(req).map((ref) => item(ref, answers[ref] ?? {})) },
    usage: { input_tokens: 90, output_tokens: 30, cost_usd: 0.003 },
    model: "fake",
    durationMs: 5,
  });

  it("scores matches, peers, fields and hallucinated raw values", async () => {
    const summary = await runOfflineEval(hooksFor(scripted), RADAR, samples, 20);

    expect(summary).toMatchObject({
      provider: "mock",
      batch_size: 20,
      total_posts: 3,
      evaluated_ok: 3,
      ai_failed_count: 0,
      match_tp: 1,
      match_fp: 1,
      match_fn: 1,
      match_tn: 0,
      match_precision: 0.5,
      match_recall: 0.5,
      match_f1: 0.5,
      peer_precision: 1,
      peer_recall: 0,
      total_non_null_extractions: 4,
      hallucinated_raw_count: 2,
      hallucinated_raw_rate: 0.5,
      total_calls: 1,
      avg_input_tokens_per_post: 30,
      avg_output_tokens_per_post: 10,
      total_cost_usd: 0.003,
    });
    expect(summary.avg_duration_ms_per_post).toBeGreaterThanOrEqual(5 / 3);
    expect(Object.keys(summary.field_stats)).toEqual(["bedrooms", "phone"]);
    expect(summary.field_stats.bedrooms).toEqual({ field_key: "bedrooms", required: true, total_labeled: 2, exact_matches: 1, accuracy: 0.5 });
    expect(summary.field_stats.phone).toEqual({ field_key: "phone", required: false, total_labeled: 1, exact_matches: 1, accuracy: 1 });

    const report = formatEvalReport(summary);
    expect(report).toContain("Provider       : mock");
    expect(report).toContain("Precision :  50.00%  [CHƯA ĐẠT]  (TP=1, FP=1)");
    expect(report).toMatch(/bedrooms\s+\(bắt buộc\) :\s+50\.00% \(1\/2\)  \[CHƯA ĐẠT\]/);
    expect(report).toContain("50.00% (2/4)  [CHƯA ĐẠT]");
    expect(report).toContain("Input tokens / bài  : 30.0");
    expect(report).toContain("Tổng chi phí (USD)  : $0.003000");
  });

  it("is deterministic apart from timing", async () => {
    const strip = (s: EvalSummary): Omit<EvalSummary, "avg_duration_ms_per_post"> => {
      const { avg_duration_ms_per_post: _timing, ...rest } = s;
      return rest;
    };
    const a = await runOfflineEval(hooksFor(scripted), RADAR, samples, 2);
    const b = await runOfflineEval(hooksFor(scripted), RADAR, samples, 2);
    expect(strip(a)).toEqual(strip(b));
    expect(a.total_calls).toBe(2); // batch size 2 over 3 posts
  });

  it("counts a post the AI cannot answer as ai_failed (a miss when a match was expected)", async () => {
    const empty: Responder = () => ({ output: { results: [] }, usage: null, model: null, durationMs: 1 });
    const summary = await runOfflineEval(hooksFor(empty), RADAR, [sample({ id: "x", text: "t", expected_match: true })], 20);
    expect(summary).toMatchObject({
      total_posts: 1,
      evaluated_ok: 0,
      ai_failed_count: 1,
      match_fn: 1,
      match_precision: 1,
      match_recall: 0,
      match_f1: 0,
      total_calls: 2,
      total_cost_usd: null,
    });
  });
});

// ---- CLI --------------------------------------------------------------------------------------------

describe("eval CLI", () => {
  async function run(args: string[], files: Record<string, string> = {}, deps: Parameters<typeof runEvalCli>[2] = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEvalCli(
      args,
      {
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        readFile: (p) => {
          const content = files[p];
          if (content === undefined) throw new Error(`ENOENT: ${p}`);
          return content;
        },
      },
      deps,
    );
    return { code, out: out.join(""), err: err.join("") };
  }
  const jsonOf = (out: string): EvalSummary => JSON.parse(out.slice(out.indexOf("\n{\n") + 1)) as EvalSummary;

  it("prints help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE:");
    expect(r.out).toContain("--batch-size <n>");
  });

  it("runs the built-in suite on the mock provider", async () => {
    const r = await run(["--json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Provider       : mock");
    expect(r.out).toContain("Tổng số bài    : 8 (thành công: 8, ai_failed: 0)");
    expect(r.out).toContain("Số lời gọi CLI : 1");
    const summary = jsonOf(r.out);
    expect(summary.total_posts).toBe(8);
    expect(Object.keys(summary.field_stats)).toEqual(["bedrooms", "location", "phone", "price"]);
  });

  it("gives the same scores on every run and honours --batch-size", async () => {
    const strip = (s: EvalSummary) => {
      const { avg_duration_ms_per_post: _timing, ...rest } = s;
      return rest;
    };
    const a = jsonOf((await run(["--json", "--batch-size", "3"])).out);
    const b = jsonOf((await run(["--json", "--batch-size", "3"])).out);
    expect(strip(a)).toEqual(strip(b));
    expect(a.batch_size).toBe(3);
    expect(a.total_calls).toBe(3);
  });

  it("reads --dataset and --radar", async () => {
    const files = {
      "d.jsonl": '{"id":"p1","text":"Cần thuê nhà ở Cầu Giấy","expected_match":true}\n',
      "r.json": JSON.stringify({ radar_version_id: "rv", description: "d", want_intent: "demand", fields: [] }),
    };
    const r = await run(["--dataset", "d.jsonl", "--radar", "r.json", "--json"], files);
    expect(r.code).toBe(0);
    const summary = jsonOf(r.out);
    expect(summary).toMatchObject({ total_posts: 1, evaluated_ok: 1 });
    expect(summary.field_stats).toEqual({});
  });

  it("passes --model/--tier/--provider to the provider factory", async () => {
    let seen: { id: ProviderId; tiers: unknown } | null = null;
    const r = await run(["--provider", "Claude", "--model", "m1", "--tier", "smart"], {}, {
      createProvider: (id, tiers) => {
        seen = { id, tiers };
        return new MockAiProvider();
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual({ id: "claude_cli", tiers: { claude_cli: { smart: "m1" } } });
  });

  it.each([
    [["--bogus"], "Error: unknown argument '--bogus'. Pass --help for usage."],
    [["--dataset"], "Error: --dataset requires a file path"],
    [["--radar"], "Error: --radar requires a file path"],
    [["--provider"], "Error: --provider requires mock|claude|codex|agy"],
    [["--provider", "nope"], "Error: unknown provider 'nope' (expected claude_cli, codex_cli, agy_cli, or mock)"],
    [["--model"], "Error: --model requires a model name"],
    [["--tier"], "Error: --tier requires fast or smart"],
    [["--tier", "big"], "Error: unknown model tier 'big' (expected fast or smart)"],
    [["--batch-size"], "Error: --batch-size requires a positive integer"],
    [["--batch-size", "0"], "Error: invalid --batch-size '0'"],
    [["--batch-size", "x"], "Error: invalid --batch-size 'x'"],
  ])("rejects %j", async (args, message) => {
    const r = await run(args);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${message}\n`);
    expect(r.out).toBe("");
  });

  it("reports unreadable and invalid input files", async () => {
    const missing = await run(["--dataset", "nope.jsonl"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Error reading dataset 'nope.jsonl'");

    const bad = await run(["--dataset", "bad.jsonl"], { "bad.jsonl": "{oops" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Error parsing dataset 'bad.jsonl': invalid JSONL on line 1");

    const radar = await run(["--radar", "r.json"], { "r.json": "[]" });
    expect(radar.code).toBe(1);
    expect(radar.err).toContain("Error parsing radar 'r.json': radar JSON must be an object");
  });
});
