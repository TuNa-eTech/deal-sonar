import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EnvelopeParseError,
  errorEnvelope,
  extractEnvelopeId,
  newEnvelope,
  parseEnvelope,
  replyEnvelope,
} from "../src/services/protocol-envelope";
import { KNOWN_MESSAGE_TYPES, isExtensionToDesktop } from "../src/services/protocol-types";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/protocol-v2-examples.json");
const fixtures = JSON.parse(fs.readFileSync(FIXTURES, "utf8")) as {
  spec_section_6_session: Array<Record<string, any>>;
  additional_catalog_messages: Array<Record<string, any>>;
};
const allFixtures = [...fixtures.spec_section_6_session, ...fixtures.additional_catalog_messages];

const parse = (v: unknown) => parseEnvelope(Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8"));
const failure = (v: unknown): EnvelopeParseError => {
  try {
    parse(v);
  } catch (err) {
    if (err instanceof EnvelopeParseError) return err;
    throw err;
  }
  throw new Error("expected parse failure");
};
const valid = (over: Record<string, unknown> = {}) => ({ v: 2, id: "X1", ts: 1, reply_to: null, type: "ping", payload: {}, ...over });

describe("protocol v2 fixtures (Rust oracle)", () => {
  it("covers all 14 message types", () => {
    expect(new Set(allFixtures.map((m) => m.type))).toEqual(new Set(KNOWN_MESSAGE_TYPES));
  });

  it.each(allFixtures.map((m) => [`${m.type} (${m.id})`, m] as const))("parses %s and keeps every field", (_name, msg) => {
    const env = parse(msg);
    expect(env).toEqual(msg);
    expect(Object.keys(env).slice(0, 5)).toEqual(["v", "id", "ts", "reply_to", "type"]);
  });

  it("classifies message direction", () => {
    const ext = allFixtures.filter((m) => isExtensionToDesktop(m.type)).map((m) => m.type);
    expect(new Set(ext)).toEqual(new Set(["hello", "posts.push", "crawl.report", "sources.discovered", "session.status", "ping"]));
  });
});

describe("parseEnvelope error classification", () => {
  it("rejects malformed JSON without an id", () => {
    const e = failure("{not json");
    expect([e.code, e.id]).toEqual(["invalid_payload", null]);
    expect(e.message).toMatch(/^malformed JSON frame: /);
  });

  it("rejects invalid UTF-8", () => {
    expect(() => parseEnvelope(Buffer.from([0x7b, 0xff, 0x7d]))).toThrow(/malformed JSON frame/);
  });

  it("rejects non-object envelopes", () => {
    const e = failure("[1,2]");
    expect([e.code, e.message]).toEqual(["invalid_payload", "envelope must be a JSON object"]);
  });

  it("reports protocol_mismatch for another version and keeps the id", () => {
    const e = failure(valid({ v: 3 }));
    expect([e.code, e.id, e.message]).toEqual(["protocol_mismatch", "X1", "unsupported protocol version 3, expected 2"]);
    expect(failure(valid({ v: -1 })).code).toBe("protocol_mismatch");
  });

  it("reports legacy v1 frames as protocol_mismatch before any v2 field check", () => {
    const e = failure({ type: "ping", version: 1 });
    expect([e.code, e.id]).toEqual(["protocol_mismatch", null]);
    expect(e.message).toBe("unsupported legacy protocol version 1, expected 2");
  });

  it("requires v, id, ts, type and a clean reply_to", () => {
    expect(failure({ id: "X", ts: 1, type: "ping", payload: {} }).message).toBe("missing integer field 'v'");
    expect(failure(valid({ v: "2" })).message).toBe("field 'v' must be an integer");
    expect(failure(valid({ v: 2.5 })).message).toBe("field 'v' must be an integer");
    expect(failure(valid({ id: "" })).message).toBe("missing or invalid non-empty string field 'id'");
    expect(failure(valid({ ts: 1.5 })).message).toBe("missing or invalid integer field 'ts'");
    expect(failure(valid({ reply_to: "" })).message).toBe("field 'reply_to' must be null or a non-empty string");
    expect(failure(valid({ reply_to: 5 })).message).toBe("field 'reply_to' must be null or a string");
    expect(failure(valid({ type: "" })).message).toBe("missing or invalid string field 'type'");
    // The id is retained for every failure after it was valid.
    expect(failure(valid({ ts: "x" })).id).toBe("X1");
  });

  it("reports unknown_type with the id", () => {
    const e = failure(valid({ type: "posts.delete" }));
    expect([e.code, e.id, e.message]).toEqual(["unknown_type", "X1", "unknown message type 'posts.delete'"]);
  });

  it("requires an object payload", () => {
    for (const payload of [null, [], "x", 3]) {
      const e = failure(valid({ payload }));
      expect([e.code, e.message]).toEqual(["invalid_payload", "expected object 'payload' for message type 'ping'"]);
    }
    expect(failure({ v: 2, id: "X1", ts: 1, type: "ping" }).code).toBe("invalid_payload");
  });

  it("validates typed payloads like serde", () => {
    const hello = (payload: Record<string, unknown>) => valid({ type: "hello", payload });
    const good = { profile_id: "p", ext_version: "1", browser: "chrome/1", config_rev: 0 };
    expect(failure(hello({ ...good, profile_id: undefined })).message).toBe("invalid payload: missing field `profile_id`");
    expect(failure(hello({ ...good, config_rev: -1 })).message).toMatch(/^invalid payload: invalid value: integer `-1`/);
    expect(failure(hello({ ...good, config_rev: 1.5 })).message).toMatch(/^invalid payload: invalid type: floating point/);
    expect(failure(hello({ ...good, browser: 7 })).message).toBe("invalid payload: invalid type: integer `7`, expected a string");
    expect(failure(hello({ ...good, profile_id: undefined })).id).toBe("X1");

    const status = (state: unknown) => valid({ type: "session.status", payload: { platform: "facebook", state } });
    expect(failure(status("banned")).message).toMatch(/^invalid payload: unknown variant `banned`, expected one of `ok`, `logged_out`/);
  });

  it("ignores unknown payload fields and defaults optional ones", () => {
    const env = parse(
      valid({
        type: "session.status",
        payload: { platform: "facebook", state: "ok", detail: null, future_field: { a: 1 }, runtime: { automatic_scanning: true, paused: false } },
      }),
    );
    expect(env.type === "session.status" && env.payload).toEqual({
      platform: "facebook",
      state: "ok",
      runtime: { automatic_scanning: true, paused: false, next_crawl_at: null, last_crawl_at: null },
    });
  });

  it("defaults attachments and enforces u32 counters", () => {
    const post = {
      platform: "facebook",
      post_id: "1",
      source_external_id: "9",
      permalink: "u",
      author: { name: "n", is_anonymous: true },
      text: "t",
      text_truncated: false,
      captured_at: 1,
      extraction: { strategy: "dom", profile_rev: 1 },
    };
    const env = parse(valid({ type: "posts.push", payload: { run_id: "r", source_ref: { platform: "facebook", kind: "group", external_id: "9" }, posts: [post] } }));
    expect(env.type === "posts.push" && env.payload.posts[0]!.attachments).toEqual([]);

    const report = (over: Record<string, unknown>) =>
      valid({
        type: "crawl.report",
        payload: {
          run_id: "r",
          source_ref: { platform: "facebook", kind: "group", external_id: "9" },
          reason: "scheduled",
          status: "ok",
          started_at: 1,
          ended_at: 2,
          posts_seen: 1,
          posts_new: 1,
          page_loads: 1,
          ...over,
        },
      });
    expect(failure(report({ posts_seen: 4_294_967_296 })).code).toBe("invalid_payload");
    expect(failure(report({ status: "weird" })).code).toBe("invalid_payload");
    expect(parse(report({ posts_seen: 4_294_967_295 })).type).toBe("crawl.report");
  });

  it("validates desktop-to-extension types too (direction is checked later)", () => {
    expect(failure(valid({ type: "ack", payload: { accepted: 1 } })).message).toBe("invalid payload: missing field `duplicates`");
    expect(parse(valid({ type: "pong", payload: { junk: 1 } })).type).toBe("pong");
  });

  it("converts a parse failure into a non-retryable error envelope replying to the id", () => {
    const env = failure(valid({ type: "nope" })).toErrorEnvelope();
    expect(env).toMatchObject({ v: 2, reply_to: "X1", type: "error", payload: { code: "unknown_type", retryable: false } });
  });
});

describe("builders", () => {
  it("serialize in Rust field order", () => {
    const env = replyEnvelope("A", { type: "ack", payload: { accepted: 1, duplicates: 0 } }, 1_700_000_000_000);
    expect(Object.keys(env)).toEqual(["v", "id", "ts", "reply_to", "type", "payload"]);
    expect(env).toMatchObject({ v: 2, ts: 1_700_000_000_000, reply_to: "A" });
    expect(env.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("newEnvelope has a null reply_to and errorEnvelope carries code/retryable", () => {
    expect(newEnvelope({ type: "pong", payload: {} }).reply_to).toBeNull();
    expect(errorEnvelope(null, "busy", "m", true).payload).toEqual({ code: "busy", message: "m", retryable: true });
  });

  it("extractEnvelopeId mirrors the Rust best-effort extractor", () => {
    expect(extractEnvelopeId(Buffer.from('{"id":"abc","x":1}'))).toBe("abc");
    expect(extractEnvelopeId(Buffer.from('{"id":""}'))).toBeNull();
    expect(extractEnvelopeId(Buffer.from('{"id":5}'))).toBeNull();
    expect(extractEnvelopeId(Buffer.from("nope"))).toBeNull();
  });
});
