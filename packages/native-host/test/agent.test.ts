import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AgentError,
  handleAgentFrame,
  issueAgentToken,
  readAgentToken,
  tokenMatches,
  validationMessage,
  type AgentBackend,
} from "../src/agent-protocol.js";
import { cleanupTmpDirs, isWindows, tmpDir } from "./helpers.js";

afterAll(cleanupTmpDirs);

const token = Buffer.alloc(32, 7);
const req = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({ token: [...token], method: "list_radar_sources", arguments: {}, ...over }),
  );

const okBackend: AgentBackend = {
  handle: async (method, args) => ({ method, args }),
};

describe("handleAgentFrame", () => {
  it("dispatches to the backend with a valid token and returns {Ok}", async () => {
    const res = await handleAgentFrame(req({ method: "check_radar_preview", arguments: { radar_id: "r1" } }), token, okBackend);
    expect(res).toEqual({ Ok: { method: "check_radar_preview", args: { radar_id: "r1" } } });
  });

  it("rejects a wrong token and a missing expected token with the refusal message", async () => {
    const wrong = await handleAgentFrame(req({ token: [...Buffer.alloc(32, 8)] }), token, okBackend);
    expect(wrong).toEqual({
      Error: validationMessage(
        "DealSonar từ chối kết nối agent. Hãy kiểm tra đường dẫn ứng dụng và phiên desktop đang mở.",
      ),
    });
    expect(await handleAgentFrame(req(), null, okBackend)).toEqual(wrong);
  });

  it("never calls the backend on auth or parse failure", async () => {
    let called = 0;
    const spy: AgentBackend = { handle: async () => (called += 1) };
    await handleAgentFrame(req({ token: [...Buffer.alloc(32, 9)] }), token, spy);
    await handleAgentFrame(Buffer.from("not json"), token, spy);
    await handleAgentFrame(req({ method: "delete_everything" }), token, spy);
    expect(called).toBe(0);
  });

  it("rejects malformed requests", async () => {
    const invalid = { Error: validationMessage("Yêu cầu agent không hợp lệ.") };
    expect(await handleAgentFrame(Buffer.from("not json"), token, okBackend)).toEqual(invalid);
    expect(await handleAgentFrame(Buffer.from("[]"), token, okBackend)).toEqual(invalid);
    expect(await handleAgentFrame(req({ method: "nope" }), token, okBackend)).toEqual(invalid);
    expect(await handleAgentFrame(req({ token: [1, 2, 3] }), token, okBackend)).toEqual(invalid);
    expect(await handleAgentFrame(req({ token: [...token].map(() => 300) }), token, okBackend)).toEqual(invalid);
    expect(
      await handleAgentFrame(Buffer.from(JSON.stringify({ token: [...token], method: "prepare_radar" })), token, okBackend),
    ).toEqual(invalid);
  });

  it("enforces the 1 MiB request bound", async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
    expect(await handleAgentFrame(big, token, okBackend)).toEqual({ Error: validationMessage("Yêu cầu agent quá lớn.") });
  });

  it("passes AgentError messages through verbatim and hides other errors", async () => {
    const throwing: AgentBackend = {
      handle: async (method) => {
        if (method === "list_radar_sources") throw new AgentError("hệ thống đang tắt");
        throw new Error("secret stack detail /Users/x");
      },
    };
    expect(await handleAgentFrame(req(), token, throwing)).toEqual({ Error: "hệ thống đang tắt" });
    const hidden = await handleAgentFrame(req({ method: "prepare_radar" }), token, throwing);
    expect(JSON.stringify(hidden)).not.toContain("secret");
    expect(hidden).toHaveProperty("Error");
  });

  it("tokenMatches is exact and length-safe", () => {
    expect(tokenMatches(token, Buffer.alloc(32, 7))).toBe(true);
    expect(tokenMatches(token, Buffer.alloc(32, 6))).toBe(false);
    expect(tokenMatches(token, Buffer.alloc(31, 7))).toBe(false);
  });
});

describe("agent token file", () => {
  it("issues a 32-byte token with owner-only permissions and no leftover temp files", () => {
    const dir = tmpDir();
    const issued = issueAgentToken(dir);
    expect(issued.length).toBe(32);
    const file = path.join(dir, "agent-access");
    expect(fs.readFileSync(file).equals(issued)).toBe(true);
    if (!isWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["agent-access"]);
    expect(readAgentToken(dir)?.equals(issued)).toBe(true);
    const second = issueAgentToken(dir);
    expect(second.equals(issued)).toBe(false);
    expect(readAgentToken(dir)?.equals(second)).toBe(true);
  });

  it("refuses a missing, short, or group/world-readable token file", () => {
    const dir = tmpDir();
    expect(readAgentToken(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "agent-access"), Buffer.alloc(16), { mode: 0o600 });
    expect(readAgentToken(dir)).toBeNull();
    if (!isWindows) {
      fs.writeFileSync(path.join(dir, "agent-access"), Buffer.alloc(32, 1));
      fs.chmodSync(path.join(dir, "agent-access"), 0o644);
      expect(readAgentToken(dir)).toBeNull();
      fs.chmodSync(path.join(dir, "agent-access"), 0o600);
      expect(readAgentToken(dir)).not.toBeNull();
      fs.rmSync(path.join(dir, "agent-access"));
      fs.symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "agent-access"));
      expect(readAgentToken(dir)).toBeNull();
    }
  });
});
