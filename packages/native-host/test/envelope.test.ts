import { describe, expect, it } from "vitest";
import {
  buildDesktopUnavailableBytes,
  extractEnvelopeId,
  newUlid,
} from "../src/envelope.js";
import { MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";

const b = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));

describe("envelope helpers", () => {
  it("extracts only a non-empty top-level string id", () => {
    expect(extractEnvelopeId(b({ id: "01ABC", v: 2 }))).toBe("01ABC");
    expect(extractEnvelopeId(b({ id: "" }))).toBeNull();
    expect(extractEnvelopeId(b({ id: 5 }))).toBeNull();
    expect(extractEnvelopeId(b({ nested: { id: "x" } }))).toBeNull();
    expect(extractEnvelopeId(b("[1,2]"))).toBeNull();
    expect(extractEnvelopeId(b("not json"))).toBeNull();
    expect(extractEnvelopeId(Buffer.from([0xff, 0xfe, 0x7b]))).toBeNull();
  });

  it("builds a retryable desktop_unavailable v2 error replying to the incoming id", () => {
    const bytes = buildDesktopUnavailableBytes(b({ v: 2, id: "REQ1", type: "ping", payload: {} }));
    const env = JSON.parse(bytes.toString("utf8"));
    expect(env.v).toBe(2);
    expect(env.reply_to).toBe("REQ1");
    expect(env.type).toBe("error");
    expect(env.payload).toEqual({
      code: "desktop_unavailable",
      message: "DealSonar desktop app is not running or local IPC is unavailable",
      retryable: true,
    });
    expect(env.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number.isInteger(env.ts)).toBe(true);
    // Field order matches the Rust serializer.
    expect(Object.keys(env)).toEqual(["v", "id", "ts", "reply_to", "type", "payload"]);
  });

  it("uses reply_to null for unparseable input", () => {
    const env = JSON.parse(buildDesktopUnavailableBytes(b("garbage")).toString("utf8"));
    expect(env.reply_to).toBeNull();
  });

  it("falls back to a null reply_to when the id would overflow 1 MiB", () => {
    const huge = b({ id: "x".repeat(MAX_HOST_TO_EXT_BYTES + 10) });
    const bytes = buildDesktopUnavailableBytes(huge);
    expect(bytes.length).toBeLessThanOrEqual(MAX_HOST_TO_EXT_BYTES);
    expect(JSON.parse(bytes.toString("utf8")).reply_to).toBeNull();
  });

  it("generates sortable 26-char ULIDs", () => {
    const a = newUlid(1_700_000_000_000);
    const c = newUlid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < c.slice(0, 10)).toBe(true);
  });
});
