import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MSG_UNAVAILABLE, DesktopCallError, createDesktopCaller, type DesktopCaller } from "../src/agent-client.js";
import { AgentError, issueAgentToken, type AgentBackend } from "../src/agent-protocol.js";
import { DesktopIpcServer } from "../src/ipc.js";
import { McpInputTooLargeError, handleMcpLine, runMcp, stripPostBodies, toolDefinitions } from "../src/mcp.js";
import { cleanupTmpDirs, testEndpoint, tmpDir } from "./helpers.js";

afterAll(cleanupTmpDirs);

const servers: DesktopIpcServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const line = (v: unknown) => Buffer.from(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
const noDesktop: DesktopCaller = async () => {
  throw new DesktopCallError(MSG_UNAVAILABLE);
};

describe("MCP JSON-RPC surface (parity with crates/native-host mcp.rs)", () => {
  it("initialize negotiates known protocol versions and falls back to the latest", async () => {
    for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      const res = await handleMcpLine(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } }), noDesktop);
      expect((res as any).result.protocolVersion).toBe(v);
    }
    const res: any = await handleMcpLine(line({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01" } }), noDesktop);
    expect(res.id).toBe("a");
    expect(res.result.protocolVersion).toBe("2025-11-25");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo).toEqual({ name: "dealsonar", version: "0.1.0" });
    expect(res.result.instructions).toContain("call list_radar_sources first");
    expect(res.result.instructions).toContain("Keep the Radar as a draft.");
    const bare: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 2, method: "initialize" }), noDesktop);
    expect(bare.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists exactly the four Radar tools with their schemas and hints", async () => {
    const res: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 3, method: "tools/list" }), noDesktop);
    const tools = res.result.tools as Array<any>;
    expect(tools.map((t) => t.name)).toEqual(["list_radar_sources", "prepare_radar", "check_radar_preview", "retry_radar_preview"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(tools[1].annotations).toEqual({ destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tools[1].inputSchema.required).toEqual(["draft_id", "name", "description", "source_ids", "fields", "want_intent"]);
    expect(tools[1].inputSchema.properties.fields.items.properties.type.enum).toHaveLength(11);
    expect(tools[2].inputSchema.required).toEqual(["radar_id"]);
    expect(tools[3].annotations).toEqual({ destructiveHint: false, openWorldHint: true });
    expect(toolDefinitions()).toHaveLength(4);
  });

  it("answers ping and ignores notifications", async () => {
    expect(await handleMcpLine(line({ jsonrpc: "2.0", id: 9, method: "ping" }), noDesktop)).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
    expect(await handleMcpLine(line({ jsonrpc: "2.0", method: "notifications/initialized" }), noDesktop)).toBeNull();
  });

  it("returns JSON-RPC errors for malformed input", async () => {
    expect(await handleMcpLine(line("{nope"), noDesktop)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const invalid = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    expect(await handleMcpLine(line([1, 2]), noDesktop)).toEqual(invalid);
    expect(await handleMcpLine(line({ jsonrpc: "1.0", id: 1, method: "ping" }), noDesktop)).toEqual(invalid);
    expect(await handleMcpLine(line({ jsonrpc: "2.0", id: 1 }), noDesktop)).toEqual(invalid);
    expect(await handleMcpLine(line({ jsonrpc: "2.0", id: null, method: "ping" }), noDesktop)).toEqual(invalid);
    expect(await handleMcpLine(line({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }), noDesktop)).toEqual(invalid);
    expect(await handleMcpLine(line({ jsonrpc: "2.0", id: 4, method: "resources/list" }), noDesktop)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Method not found" },
    });
    expect(await handleMcpLine(Buffer.from([0xff, 0xfe, 0x0a]), noDesktop)).toMatchObject({ error: { code: -32700 } });
  });

  it("validates tools/call name and arguments", async () => {
    const call = (params: unknown) => handleMcpLine(line({ jsonrpc: "2.0", id: 5, method: "tools/call", params }), noDesktop);
    expect(await call({ name: "delete_everything" })).toMatchObject({ error: { code: -32602, message: "Unknown Radar tool" } });
    expect(await call({ name: "constructor" })).toMatchObject({ error: { code: -32602, message: "Unknown Radar tool" } });
    expect(await call({})).toMatchObject({ error: { code: -32602, message: "Unknown Radar tool" } });
    expect(await call({ name: "list_radar_sources", arguments: [] })).toMatchObject({ error: { code: -32602, message: "Expected an arguments object" } });
    expect(await call({ name: "list_radar_sources", arguments: null })).toMatchObject({ error: { code: -32602, message: "Expected an arguments object" } });
  });

  it("forwards tools/call to the desktop and wraps results as text content", async () => {
    const seen: Array<[string, unknown]> = [];
    const caller: DesktopCaller = async (method, args) => {
      seen.push([method, args]);
      return { radar_id: "r1", status: "done" };
    };
    const res: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "check_radar_preview", arguments: { radar_id: "r1" } } }), caller);
    expect(seen).toEqual([["check_radar_preview", { radar_id: "r1" }]]);
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toEqual({ radar_id: "r1", status: "done" });
    // Omitted arguments default to {}.
    await handleMcpLine(line({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_radar_sources" } }), caller);
    expect(seen[1]).toEqual(["list_radar_sources", {}]);
  });

  it("maps desktop errors to isError content and hides unexpected failures", async () => {
    const failing: DesktopCaller = async () => {
      throw new DesktopCallError("Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp.");
    };
    const a: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "retry_radar_preview", arguments: { radar_id: "x" } } }), failing);
    expect(a.result).toEqual({ isError: true, content: [{ type: "text", text: "Chỉ có thể xem hoặc chạy thử Radar ở trạng thái nháp." }] });
    const boom: DesktopCaller = async () => {
      throw new Error("ENOENT /Users/secret/agent-access");
    };
    const b: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "list_radar_sources" } }), boom);
    expect(b.result.content[0].text).toBe(MSG_UNAVAILABLE);
  });
});

describe("no post bodies via MCP", () => {
  it("strips post-content keys recursively", () => {
    expect(
      stripPostBodies({ radar_id: "r", warnings: ["w"], items: [{ text: "secret" }], nested: { posts: [1], body: "b", keep: 1 } }),
    ).toEqual({ radar_id: "r", warnings: ["w"], nested: { keep: 1 } });
  });

  it("scrubs a misbehaving desktop reply before it reaches the client", async () => {
    const leaky: DesktopCaller = async () => ({ radar_id: "r", items: [{ text: "SECRET POST BODY" }], text: "SECRET POST BODY" });
    const res: any = await handleMcpLine(line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_radar_preview", arguments: { radar_id: "r" } } }), leaky);
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.parse(res.result.content[0].text)).toEqual({ radar_id: "r" });
  });

  it("tool descriptions expose no tool that returns raw posts", () => {
    const names = toolDefinitions().map((t: any) => t.name);
    expect(names.some((n: string) => /post|lead|message|export/i.test(n.replace("radar", "")))).toBe(false);
  });
});

describe("runMcp over streams", () => {
  const run = async (input: Buffer[], caller: DesktopCaller = noDesktop) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c));
    const done = runMcp(stdin, stdout, { callDesktop: caller });
    for (const part of input) stdin.write(part);
    stdin.end();
    await done;
    return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };

  it("responds line by line in order, one JSON object per line", async () => {
    const out = await run([
      line({ jsonrpc: "2.0", id: 1, method: "ping" }),
      line({ jsonrpc: "2.0", method: "notifications/initialized" }),
      line({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);
    expect(out.map((o) => o.id)).toEqual([1, 2]);
  });

  it("handles lines split across chunks and a final line without newline", async () => {
    const whole = line({ jsonrpc: "2.0", id: 1, method: "ping" });
    const out = await run([whole.subarray(0, 5), whole.subarray(5), Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }))]);
    expect(out.map((o) => o.id)).toEqual([1, 2]);
  });

  it("answers malformed lines without terminating", async () => {
    const out = await run([line("garbage"), line({ jsonrpc: "2.0", id: 1, method: "ping" })]);
    expect(out[0].error.code).toBe(-32700);
    expect(out[1].id).toBe(1);
  });

  it("fails with McpInputTooLargeError for lines over 1 MiB", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runMcp(stdin, stdout, { callDesktop: noDesktop });
    const failure = expect(done).rejects.toBeInstanceOf(McpInputTooLargeError);
    stdin.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
    await failure;
  });
});

describe("MCP -> desktop over the real local transport", () => {
  async function desktop(backend: AgentBackend) {
    const dir = tmpDir();
    const endpoint = testEndpoint(dir);
    const token = issueAgentToken(dir);
    servers.push(await DesktopIpcServer.bind({ endpoint, agentToken: token, agentBackend: backend, onExtensionConnection: () => undefined }));
    return { env: { DEALSONAR_DATA_DIR: dir, DEALSONAR_IPC_PATH: endpoint, HOME: dir, USERPROFILE: dir, APPDATA: dir } };
  }

  it("serves the list -> prepare -> check flow with token auth", async () => {
    const calls: string[] = [];
    const { env } = await desktop({
      handle: async (method, args) => {
        calls.push(method);
        if (method === "list_radar_sources") return { draft_id: "01HZ", sources: [{ id: "s1", name: "G", followed: true, stored_post_count: 3, recent_post_count: 1 }], max_fields: 5, max_groups: 3 };
        return { method, args, status: "crawling", text: "must never reach MCP" };
      },
    });
    const caller = createDesktopCaller({ env });
    const rpc = (id: number, name: string, args: unknown) =>
      handleMcpLine(line({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), caller) as Promise<any>;

    const list = await rpc(1, "list_radar_sources", {});
    expect(JSON.parse(list.result.content[0].text).draft_id).toBe("01HZ");
    const prepared = await rpc(2, "prepare_radar", { draft_id: "01HZ", name: "n" });
    const payload = JSON.parse(prepared.result.content[0].text);
    expect(payload.method).toBe("prepare_radar");
    expect(payload.args).toEqual({ draft_id: "01HZ", name: "n" });
    expect(payload.text).toBeUndefined();
    expect(calls).toEqual(["list_radar_sources", "prepare_radar"]);
  });

  it("surfaces backend AgentError text as an MCP tool error", async () => {
    const { env } = await desktop({ handle: async () => { throw new AgentError("hệ thống đang tắt"); } });
    const res: any = await handleMcpLine(
      line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_radar_sources" } }),
      createDesktopCaller({ env }),
    );
    expect(res.result).toEqual({ isError: true, content: [{ type: "text", text: "hệ thống đang tắt" }] });
  });
});
