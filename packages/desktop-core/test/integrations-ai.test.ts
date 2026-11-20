import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgyCliProvider,
  AiBridge,
  AiError,
  ClaudeCliProvider,
  CodexCliProvider,
  classifyCliFailure,
  decodeStrictOutput,
  discoverCodexModels,
  encodeBatArg,
  expandedPathEnv,
  extractJsonValue,
  extractUsageFromObj,
  newCliAdapterConfig,
  parseAgyModelsStdout,
  parseCodexJsonlStdout,
  parseRetryAfter,
  probeSmokeSchema,
  recommendedModelsForProvider,
  recommendedTierDefaults,
  strictOutputSchema,
  unwrapCliJsonEnvelope,
  validateJsonSchemaError,
  windowsBatchCommandLine,
  type AiRequest,
  type CliAdapterConfig,
} from "../src/ai";

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dealsonar-ai-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("schema validation and JSON extraction", () => {
  const schema = {
    type: "object",
    required: ["a"],
    additionalProperties: false,
    properties: { a: { type: "integer", minimum: 1 }, b: { type: "array", items: { enum: ["x", "y"] } } },
  };

  it("accepts valid values and names the failing path otherwise", () => {
    expect(validateJsonSchemaError(schema, { a: 2, b: ["x"] })).toBeNull();
    expect(validateJsonSchemaError(schema, {})).toBe("$: missing required property 'a'");
    expect(validateJsonSchemaError(schema, { a: 0 })).toBe("$.a: number 0 is less than minimum 1");
    expect(validateJsonSchemaError(schema, { a: 1, b: ["z"] })).toMatch(/^\$\.b\[0\]: value "z" is not in allowed enum/);
    expect(validateJsonSchemaError(schema, { a: 1, c: 1 })).toBe("$: unexpected additional property 'c'");
    expect(validateJsonSchemaError(schema, { a: 1.5 })).toBe("$.a: expected type \"integer\", got number");
  });

  it("extracts JSON from fenced blocks and prose-wrapped balanced objects", () => {
    expect(extractJsonValue('{"ok":true}')).toEqual({ ok: true });
    expect(extractJsonValue('here:\n```json\n{"ok":true}\n```\nbye')).toEqual({ ok: true });
    expect(extractJsonValue('Sure! {"a":"}{","b":{"c":1}} thanks')).toEqual({ a: "}{", b: { c: 1 } });
    expect(() => extractJsonValue("no json here")).toThrowError(/could not parse valid JSON/);
    expect(() => extractJsonValue("   ")).toThrowError(/empty CLI output/);
  });
});

describe("failure classification", () => {
  it("classifies rate limits with retry hints, auth failures and refusals", () => {
    const rl = classifyCliFailure("claude_cli", 1, "Error 429: rate limit. retry-after: 30 seconds", "");
    expect(rl).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
    expect(rl.message).toBe("Đã chạm giới hạn hạn mức AI (thử lại sau: Some(30s))");
    expect(classifyCliFailure("codex_cli", 1, "", "usage limit reached").kind).toBe("rate_limited");
    expect(classifyCliFailure("claude_cli", 1, "Not logged in · run `claude login`", "").kind).toBe("not_authenticated");
    expect(classifyCliFailure("agy_cli", 1, "model refused to answer", "").kind).toBe("refused");
    const generic = classifyCliFailure("agy_cli", 7, "x".repeat(1200), "");
    expect(generic).toMatchObject({ kind: "process", exitCode: 7 });
    expect(generic.detail).toBe(`${"x".repeat(1000)}...`);
  });

  it("parses retry-after in JSON and prose forms", () => {
    expect(parseRetryAfter('{"retry_after_ms": 1500}')).toBe(1500);
    expect(parseRetryAfter('{"retry_after": 7}')).toBe(7000);
    expect(parseRetryAfter("please try again in 2 minutes")).toBe(120_000);
    expect(parseRetryAfter("resets in 1h")).toBe(3_600_000);
    expect(parseRetryAfter("nothing")).toBeNull();
  });
});

describe("CLI envelope parsing", () => {
  const schema = probeSmokeSchema();

  it("prefers structured_output and sums cache tokens", () => {
    const out = unwrapCliJsonEnvelope(
      JSON.stringify({
        structured_output: { ok: true },
        usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 },
        total_cost_usd: 0.5,
        modelUsage: { "claude-b": {}, "claude-a": {} },
      }),
      schema,
      "fallback",
    );
    expect(out.output).toEqual({ ok: true });
    expect(out.usage).toEqual({ input_tokens: 15, output_tokens: 4, cost_usd: 0.5 });
    expect(out.model).toBe("claude-a");
  });

  it("reads JSON text in `result`, surfaces is_error and refusals", () => {
    expect(unwrapCliJsonEnvelope(JSON.stringify({ result: '```json\n{"ok":false}\n```' }), schema, null).output).toEqual({ ok: false });
    expect(() => unwrapCliJsonEnvelope(JSON.stringify({ is_error: true, result: "Not logged in" }), schema, null)).toThrowError(
      /chưa đăng nhập/,
    );
    expect(() => unwrapCliJsonEnvelope(JSON.stringify({ stop_reason: "refusal", refusal: "no" }), schema, null)).toThrowError(
      /từ chối/,
    );
    expect(() => unwrapCliJsonEnvelope(JSON.stringify({ result: "{}" }), schema, null)).toThrowError(/Đầu ra AI không hợp lệ/);
    expect(extractUsageFromObj({ cost_usd: 1.5 })).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 1.5 });
    expect(extractUsageFromObj({})).toBeNull();
  });
});

describe("codex strict schema transport", () => {
  const schema = {
    type: "object",
    required: ["name", "extra"],
    properties: {
      name: { type: "string" },
      limit: { type: "integer" },
      extra: { type: "object" },
      tags: { type: "array", items: { type: "object", required: ["k"], properties: { k: { type: "string" }, v: { type: "object" } } } },
    },
  };

  it("closes objects, makes optionals nullable and ships dynamic maps as strings", () => {
    const wire = strictOutputSchema(schema) as any;
    expect(wire.additionalProperties).toBe(false);
    expect(wire.required).toEqual(["name", "limit", "extra", "tags"]);
    expect(wire.properties.limit).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(wire.properties.extra.type).toBe("string");
    expect(wire.properties.tags.anyOf[0].items.properties.v.anyOf[0].type).toBe("string");
  });

  it("decodes wire output back to the domain shape", () => {
    const decoded = decodeStrictOutput(schema, {
      name: "n",
      limit: null,
      extra: '{"free":{"form":1}}',
      tags: [{ k: "a", v: '{"x":2}' }, { k: "b", v: null }],
    });
    expect(decoded).toEqual({ name: "n", extra: { free: { form: 1 } }, tags: [{ k: "a", v: { x: 2 } }, { k: "b" }] });
    expect(() => decodeStrictOutput(schema, { name: "n", limit: null, extra: "not json", tags: null })).toThrowError(
      /invalid JSON-encoded value/,
    );
  });
});

describe("codex JSONL and model discovery", () => {
  it("accumulates usage and keeps the last assistant text and error", () => {
    const summary = parseCodexJsonlStdout(
      [
        '{"type":"item.completed","item":{"text":"first"}}',
        "not json",
        '{"type":"turn.completed","model":"gpt-x","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"cost_usd":0.25}}',
        '{"type":"item.completed","item":{"content":[{"text":"last"}]}}',
        '{"type":"error","message":"boom"}',
      ].join("\n"),
    );
    expect(summary).toEqual({
      usage: { input_tokens: 15, output_tokens: 2, cost_usd: 0.25 },
      model: "gpt-x",
      lastAssistantText: "last",
      errorMessage: "boom",
    });
  });

  it("discovers codex models from the local cache and config.toml, with tier recommendations", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-6-luna", display_name: "GPT 6 Luna", visibility: "list", description: "fast" },
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
        ],
      }),
    );
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "my-mini"\n[profiles]\nmodel = "ignored"\n');
    const cfg = newCliAdapterConfig("codex", { extraEnv: [["HOME", home]] });
    const models = discoverCodexModels(cfg);
    expect(models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "my-mini"]);
    expect(models.every((m) => m.source === "local_cli")).toBe(true);
    expect(models[0]).toMatchObject({ label: "GPT 6 Luna (gpt-6-luna) — fast", recommended_tier: "fast" });
    expect(recommendedModelsForProvider("codex_cli", models)).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
  });

  it("falls back to the built-in catalog and parses `agy models` spinner output", () => {
    const empty = discoverCodexModels(newCliAdapterConfig("codex", { extraEnv: [["HOME", path.join(tmp, "none")]] }));
    expect(empty.map((m) => [m.id, m.source])).toEqual([
      ["codex-mini-latest", "builtin"],
      ["gpt-5-codex", "builtin"],
      ["o4-mini", "builtin"],
    ]);
    const parsed = parseAgyModelsStdout("⠋ loading\rgemini-2.5-flash Gemini Flash\n\ngemini-4-carbon-high Carbon High\nnot a model\n");
    expect(parsed.map((m) => [m.id, m.recommended_tier])).toEqual([
      ["gemini-2.5-flash", "fast"],
      ["gemini-4-carbon-high", "smart"],
    ]);
  });
});

describe("PATH and Windows launcher helpers", () => {
  it("keeps explicit PATH entries first and appends unique CLI directories", () => {
    const home = path.join(tmp, "h");
    fs.mkdirSync(path.join(home, ".nvm", "versions", "node", "v18.0.0", "bin"), { recursive: true });
    fs.mkdirSync(path.join(home, ".nvm", "versions", "node", "v20.0.0", "bin"), { recursive: true });
    const joined = expandedPathEnv(`/custom/bin${path.delimiter}/custom/bin`, home).split(path.delimiter);
    expect(joined[0]).toBe("/custom/bin");
    expect(joined.filter((p) => p === "/custom/bin")).toHaveLength(1);
    expect(joined).toContain(path.join(home, ".local/bin"));
    expect(joined.indexOf(path.join(home, ".nvm/versions/node/v20.0.0/bin"))).toBeLessThan(
      joined.indexOf(path.join(home, ".nvm/versions/node/v18.0.0/bin")),
    );
  });

  it("encodes .cmd arguments like the Rust standard library and rejects newlines", () => {
    expect(encodeBatArg("simple-arg_1")).toBe("simple-arg_1");
    expect(encodeBatArg("")).toBe('""');
    expect(encodeBatArg("a b")).toBe('"a b"');
    expect(encodeBatArg('{"k":"v"}')).toBe('"{""k"":""v""}"');
    expect(encodeBatArg("50%")).toBe('"50%%cd:~,%"');
    expect(encodeBatArg("dir\\")).toBe('"dir\\\\"');
    expect(() => encodeBatArg("two\nlines")).toThrowError(/newline/);
    expect(windowsBatchCommandLine("C:\\npm\\claude.cmd", ["--print", "a b"])).toBe('""C:\\npm\\claude.cmd" --print "a b""');
  });
});

// ---- real subprocess behaviour against fake CLIs (POSIX launchers) --------------------------------

const posix = process.platform === "win32" ? describe.skip : describe;

function writeCli(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
}

function cliConfig(binary: string, binDir: string, rec: string, extra: Array<[string, string]> = []): CliAdapterConfig {
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir, { recursive: true });
  return newCliAdapterConfig(binary, {
    workdir,
    modelTiers: recommendedTierDefaults(),
    pathOverride: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`,
    expandSystemPaths: false,
    extraEnv: [["REC_DIR", rec], ...extra],
    probeTimeoutMs: 15_000,
  });
}

const request = (timeoutMs = 20_000): AiRequest => ({
  task: "judge_extract",
  system: "system rules",
  prompt: "post body",
  schema: probeSmokeSchema(),
  tier: "fast",
  timeoutMs,
});

const CLAUDE_FLAGS =
  "--print --output-format --json-schema --system-prompt --tools --strict-mcp-config --no-session-persistence";

const claudeScript = `
const fs = require("fs");
const args = process.argv.slice(2);
const rec = process.env.REC_DIR;
const mode = process.env.MODE || "ok";
if (args[0] === "--version") { console.log("claude 2.1.319"); process.exit(0); }
if (args[0] === "--help") { console.log("${CLAUDE_FLAGS}"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(rec + "/call.json", JSON.stringify({ args, input, cwd: process.cwd(), files: fs.readdirSync(".") }));
  if (mode === "unauth") { console.error("Not logged in"); process.exit(1); }
  if (mode === "hang") {
    const { spawn } = require("child_process");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(rec + "/child.pid", String(c.pid));
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({ structured_output: { ok: true }, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 }, total_cost_usd: 0.01, model: "haiku" }));
});
`;

posix("Claude CLI adapter", () => {
  it("runs with exact hardened arguments, stdin prompt and an empty workdir", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "claude", claudeScript);
    const cfg = cliConfig("claude", bin, rec);
    fs.writeFileSync(path.join(cfg.workdir as string, "CLAUDE.md"), "must be removed");

    const res = await new ClaudeCliProvider(cfg).complete(request());
    expect(res.output).toEqual({ ok: true });
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 5, cost_usd: 0.01 });
    expect(res.model).toBe("haiku");

    const call = JSON.parse(fs.readFileSync(path.join(rec, "call.json"), "utf8"));
    expect(call.args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(probeSmokeSchema()),
      "--system-prompt",
      "system rules",
      "--model",
      "haiku",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
    expect(call.input).toBe("post body");
    expect(call.cwd).toBe(fs.realpathSync(cfg.workdir as string));
    expect(call.files).toEqual([]);
  });

  it("probes quick/full, maps auth failure and reports a missing binary", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "claude", claudeScript);

    const quick = await new ClaudeCliProvider(cliConfig("claude", bin, rec)).probeQuick();
    expect(quick).toMatchObject({ installed: true, version: "claude 2.1.319", flags_supported: true, authenticated: false, error: null });
    expect(quick.available_models.length).toBeGreaterThan(0);

    const full = await new ClaudeCliProvider(cliConfig("claude", bin, rec)).probeFull();
    expect(full).toMatchObject({ installed: true, flags_supported: true, authenticated: true, error: null });

    const unauth = await new ClaudeCliProvider(cliConfig("claude", bin, rec, [["MODE", "unauth"]])).probeFull();
    expect(unauth).toMatchObject({
      installed: true,
      flags_supported: true,
      authenticated: false,
      error: "CLI AI chưa đăng nhập hoặc phiên đăng nhập đã hết hạn",
    });

    const missing = new ClaudeCliProvider(cliConfig("dealsonar-no-such-cli", bin, rec));
    expect(await missing.probe()).toMatchObject({ installed: false, error: "CLI AI chưa được cài đặt trên máy" });
    await expect(missing.complete(request())).rejects.toMatchObject({ kind: "not_installed" });
  });

  it("kills the whole process group on timeout", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "claude", claudeScript);
    const provider = new ClaudeCliProvider(cliConfig("claude", bin, rec, [["MODE", "hang"]]));
    const started = Date.now();
    await expect(provider.complete(request(1_500))).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);

    const pid = Number(fs.readFileSync(path.join(rec, "child.pid"), "utf8"));
    const deadline = Date.now() + 3_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

posix("Codex CLI adapter", () => {
  const script = `
const fs = require("fs");
const args = process.argv.slice(2);
const rec = process.env.REC_DIR;
if (args[0] === "--version") { console.log("codex 0.150.1"); process.exit(0); }
if (args[0] === "exec" && args[1] === "--help") {
  console.log("--json --output-schema --output-last-message --sandbox --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const schemaPath = args[args.indexOf("--output-schema") + 1];
  const outPath = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(rec + "/call.json", JSON.stringify({ args, input, schema: JSON.parse(fs.readFileSync(schemaPath, "utf8")), schemaPath, outPath }));
  fs.writeFileSync(outPath, JSON.stringify({ ok: true }));
  console.log(JSON.stringify({ type: "turn.completed", model: "gpt-x", usage: { input_tokens: 7, output_tokens: 3 } }));
});
`;

  it("sends a strict schema, system+prompt on stdin and removes per-call temp files", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "codex", script);
    const cfg = cliConfig("codex", bin, rec);
    const res = await new CodexCliProvider(cfg).complete(request());
    expect(res).toMatchObject({ output: { ok: true }, usage: { input_tokens: 7, output_tokens: 3 }, model: "gpt-x" });

    const call = JSON.parse(fs.readFileSync(path.join(rec, "call.json"), "utf8"));
    expect(call.args).toEqual([
      "exec",
      "--json",
      "--output-schema",
      call.schemaPath,
      "--output-last-message",
      call.outPath,
      "--model",
      "codex-mini-latest",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      "mcp_servers.dealsonar.enabled=false",
      "--ignore-user-config",
      "--ignore-rules",
      "-",
    ]);
    expect(call.input).toBe("<SYSTEM_INSTRUCTIONS>\nsystem rules\n</SYSTEM_INSTRUCTIONS>\n\npost body");
    expect(call.schema).toMatchObject({ additionalProperties: false, required: ["ok"] });
    expect(fs.existsSync(call.schemaPath)).toBe(false);
    expect(fs.existsSync(call.outPath)).toBe(false);
  });
});

posix("Agy CLI adapter and bridge", () => {
  const script = `
const fs = require("fs");
const args = process.argv.slice(2);
const rec = process.env.REC_DIR;
if (args[0] === "--version") { console.log("agy 1.5.4"); process.exit(0); }
if (args[0] === "--help") { console.log("models --print --output-format --json-schema --print-timeout --sandbox --disable-slash-commands"); process.exit(0); }
if (args[0] === "models") { console.log("gemini-3.8-flash-medium Gemini Flash"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const schemaPath = args[args.indexOf("--json-schema") + 1];
  fs.writeFileSync(rec + "/call.json", JSON.stringify({ args, input, schemaPath, schemaExists: fs.existsSync(schemaPath) }));
  const out = process.env.MODE === "bad" ? { result: "{}" } : { result: JSON.stringify({ ok: true }), model: "gemini-x" };
  console.log(JSON.stringify(out));
});
`;

  it("passes sandbox flags and a schema file, discovering models via `agy models`", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "agy", script);
    const provider = new AgyCliProvider(cliConfig("agy", bin, rec));
    const res = await provider.complete(request(12_000));
    expect(res.output).toEqual({ ok: true });
    const call = JSON.parse(fs.readFileSync(path.join(rec, "call.json"), "utf8"));
    expect(call.args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      call.schemaPath,
      "--model",
      "gemini-2.5-flash",
      "--print-timeout",
      "12s",
      "--sandbox",
      "--disable-slash-commands",
    ]);
    expect(call.schemaExists).toBe(true);
    expect(fs.existsSync(call.schemaPath)).toBe(false);

    const probe = await provider.probeQuick();
    expect(probe.available_models.map((m) => m.id)).toEqual(["gemini-3.8-flash-medium"]);
  });

  it("retries once on invalid output, records both calls and then fails", async () => {
    const bin = path.join(tmp, "bin");
    const rec = path.join(tmp, "rec");
    fs.mkdirSync(rec);
    writeCli(bin, "agy", script);
    const bridge = new AiBridge(new AgyCliProvider(cliConfig("agy", bin, rec, [["MODE", "bad"]])));
    let caught: unknown;
    try {
      await bridge.completeValidated(request(), "rv1", 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AiError);
    const err = caught as AiError & { calls: Array<{ status: string; item_count: number; radar_version_id: string | null }> };
    expect(err.kind).toBe("invalid_output");
    expect(err.calls.map((c) => c.status)).toEqual(["invalid_output", "invalid_output"]);
    expect(err.calls[0]).toMatchObject({ item_count: 3, radar_version_id: "rv1" });
  });
});
