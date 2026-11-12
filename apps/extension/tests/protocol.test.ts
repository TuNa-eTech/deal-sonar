import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  generateUlid,
  isValidUlid,
  NATIVE_HOST,
  parseDesktopEnvelope,
  PROTOCOL_VERSION,
  replyEnvelope,
  resetUlidState,
} from "../src/protocol";

describe("Protocol v2 wire contract", () => {
  it("exposes PROTOCOL_VERSION = 2 and NATIVE_HOST = com.dealsonar.host", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(NATIVE_HOST).toBe("com.dealsonar.host");
  });

  it("generates monotonic 26-char Crockford Base32 ULIDs", () => {
    resetUlidState();
    const fixedTs = 1794384000000;
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = generateUlid(fixedTs);
      expect(isValidUlid(id)).toBe(true);
      expect(id).toHaveLength(26);
      ids.push(id);
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(25);
  });

  it("emits exact Envelope wire shape matching 01-protocol.md §2 & §6", () => {
    const pushEnv = createEnvelope(
      "posts.push",
      {
        run_id: "r_01",
        source_ref: { platform: "facebook", kind: "group", external_id: "123456789" },
        posts: [
          {
            platform: "facebook",
            post_id: "987654321",
            source_external_id: "123456789",
            permalink: "https://www.facebook.com/groups/123456789/posts/987654321/",
            author: { name: "Nguyễn Văn A", is_anonymous: false },
            text: "E cần thuê chung cư 2pn khu Cầu Giấy, tầm 12-15tr",
            text_truncated: false,
            created_at: 1794384600000,
            captured_at: 1794384900000,
            attachments: [],
            extraction: { strategy: "network", profile_rev: 4 },
          },
        ],
      },
      { id: "01D", ts: 1794384905000, reply_to: null },
    );

    const parsedWire = JSON.parse(JSON.stringify(pushEnv));
    expect(parsedWire).toEqual({
      v: 2,
      id: "01D",
      ts: 1794384905000,
      reply_to: null,
      type: "posts.push",
      payload: {
        run_id: "r_01",
        source_ref: { platform: "facebook", kind: "group", external_id: "123456789" },
        posts: [
          {
            platform: "facebook",
            post_id: "987654321",
            source_external_id: "123456789",
            permalink: "https://www.facebook.com/groups/123456789/posts/987654321/",
            author: { name: "Nguyễn Văn A", is_anonymous: false },
            text: "E cần thuê chung cư 2pn khu Cầu Giấy, tầm 12-15tr",
            text_truncated: false,
            created_at: 1794384600000,
            captured_at: 1794384900000,
            attachments: [],
            extraction: { strategy: "network", profile_rev: 4 },
          },
        ],
      },
    });

    const pingEnv = createEnvelope("ping", {}, { id: "01PING", ts: 1794384905000 });
    expect(pingEnv.payload).toEqual({});

    const replyErr = replyEnvelope(
      "01REQ",
      "error",
      { code: "busy", message: "Busy", retryable: true },
      { id: "01ERR", ts: 1794384905100 },
    );
    expect(replyErr.reply_to).toBe("01REQ");
    expect(replyErr.type).toBe("error");
  });

  it("parses all Desktop -> Extension messages from 01-protocol.md §6 and tolerates unknown extra payload fields", () => {
    const helloOkRaw = JSON.stringify({
      v: 2,
      id: "01B",
      type: "hello.ok",
      ts: 1794384000050,
      reply_to: "01A",
      payload: {
        desktop_version: "0.2.0",
        config_rev: 12,
        future_extra_field: "ignored-safely",
      },
    });
    const helloRes = parseDesktopEnvelope(helloOkRaw);
    expect(helloRes.ok).toBe(true);
    if (helloRes.ok && helloRes.envelope.type === "hello.ok") {
      expect(helloRes.envelope.reply_to).toBe("01A");
      expect(helloRes.envelope.payload.config_rev).toBe(12);
    }

    const configUpdateRaw = {
      v: 2,
      id: "01C",
      type: "config.update",
      ts: 1794384000060,
      reply_to: null,
      payload: {
        rev: 12,
        plan: {
          entries: [
            {
              source_ref: { platform: "facebook", kind: "group", external_id: "123456789" },
              interval_s: 900,
              priority: 0,
              max_posts_per_visit: 30,
            },
          ],
        },
        policy: {
          max_loads_per_hour: 60,
          max_loads_per_day: 600,
          active_hours: { from: "07:00", to: "23:00" },
          jitter: 0.3,
          max_scroll_steps: 3,
          only_when_idle: false,
        },
        extractor: {
          rev: 4,
          strategies: ["network", "embedded", "dom"],
          network: {},
          dom: {},
          session_markers: {},
        },
      },
    };
    const cfgRes = parseDesktopEnvelope(configUpdateRaw);
    expect(cfgRes.ok).toBe(true);

    const ackRes = parseDesktopEnvelope({
      v: 2,
      id: "01E",
      type: "ack",
      ts: 1794384905020,
      reply_to: "01D",
      payload: { accepted: 1, duplicates: 0 },
    });
    expect(ackRes.ok).toBe(true);
  });

  it("classifies protocol_mismatch, unknown_type, and invalid_payload while preserving incoming id", () => {
    const mismatch = parseDesktopEnvelope({
      v: 99,
      id: "01MISMATCH",
      ts: 1794384000000,
      reply_to: null,
      type: "pong",
      payload: {},
    });
    expect(mismatch).toEqual({
      ok: false,
      code: "protocol_mismatch",
      message: expect.stringContaining("99"),
      id: "01MISMATCH",
    });

    const unknownType = parseDesktopEnvelope({
      v: 2,
      id: "01UNKNOWN",
      ts: 1794384000000,
      reply_to: null,
      type: "radar.magic_future",
      payload: {},
    });
    expect(unknownType).toEqual({
      ok: false,
      code: "unknown_type",
      message: expect.stringContaining("radar.magic_future"),
      id: "01UNKNOWN",
    });

    const badPayload = parseDesktopEnvelope({
      v: 2,
      id: "01BAD",
      ts: 1794384000000,
      reply_to: null,
      type: "ack",
      payload: { accepted: "not-a-number" },
    });
    expect(badPayload.ok).toBe(false);
    if (!badPayload.ok) {
      expect(badPayload.code).toBe("invalid_payload");
      expect(badPayload.id).toBe("01BAD");
    }
  });
});
