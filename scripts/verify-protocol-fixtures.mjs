#!/usr/bin/env node
/**
 * Verifies the canonical Protocol v2 JSON fixtures against `docs/specs/01-protocol.md`
 * (§2, §4.1, §4.2, §4.3, §6) so both the Chrome extension (TypeScript) and the Rust
 * crates (`dealsonar-protocol` / `dealsonar-native-host`) stay 100% wire-compatible.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixturesPath = path.join(
  repoRoot,
  "crates/protocol/tests/fixtures/protocol_v2_examples.json"
);

const ALL_MESSAGE_TYPES = new Set([
  "hello",
  "posts.push",
  "crawl.report",
  "sources.discovered",
  "session.status",
  "ping",
  "hello.ok",
  "config.update",
  "crawl.request",
  "crawl.pause",
  "crawl.resume",
  "ack",
  "pong",
  "error",
]);

const ERROR_CODES = new Set([
  "protocol_mismatch",
  "unknown_type",
  "invalid_payload",
  "desktop_unavailable",
  "busy",
  "internal",
]);

const EXTRACTION_STRATEGIES = new Set(["network", "embedded", "dom"]);
const SESSION_STATES = new Set([
  "ok",
  "logged_out",
  "checkpoint",
  "rate_limited",
  "unknown",
]);
const CRAWL_STATUSES = new Set(["ok", "empty", "blocked", "error"]);
const CRAWL_REASONS = new Set(["scheduled", "manual", "preview", "passive"]);

function assertPlainObject(val, label) {
  assert.equal(
    typeof val === "object" && val !== null && !Array.isArray(val),
    true,
    `${label} must be a plain JSON object`
  );
}

function validateEnvelope(env, indexLabel) {
  assertPlainObject(env, indexLabel);
  assert.equal(env.v, 2, `${indexLabel}: expected v === 2`);
  assert.equal(
    typeof env.id === "string" && env.id.length > 0,
    true,
    `${indexLabel}: expected non-empty string id`
  );
  assert.equal(
    Number.isInteger(env.ts),
    true,
    `${indexLabel}: expected integer Unix ms ts`
  );
  assert.equal(
    env.reply_to === null ||
      (typeof env.reply_to === "string" && env.reply_to.length > 0),
    true,
    `${indexLabel}: expected reply_to to be null or non-empty string`
  );
  assert.equal(
    ALL_MESSAGE_TYPES.has(env.type),
    true,
    `${indexLabel}: unexpected message type '${env.type}'`
  );
  assertPlainObject(env.payload, `${indexLabel}.payload`);

  const p = env.payload;
  switch (env.type) {
    case "hello":
      assert.equal(typeof p.profile_id, "string");
      assert.equal(typeof p.ext_version, "string");
      assert.equal(typeof p.browser, "string");
      assert.equal(Number.isInteger(p.config_rev), true);
      break;
    case "hello.ok":
      assert.equal(typeof p.desktop_version, "string");
      assert.equal(Number.isInteger(p.config_rev), true);
      break;
    case "config.update":
      assert.equal(Number.isInteger(p.rev), true);
      assert.equal(Array.isArray(p.plan?.entries), true);
      assertPlainObject(p.policy, `${indexLabel}.payload.policy`);
      assert.equal(typeof p.policy.jitter, "number");
      assertPlainObject(p.extractor, `${indexLabel}.payload.extractor`);
      for (const s of p.extractor.strategies) {
        assert.equal(EXTRACTION_STRATEGIES.has(s), true);
      }
      break;
    case "posts.push":
      assert.equal(typeof p.run_id, "string");
      assertPlainObject(p.source_ref, `${indexLabel}.payload.source_ref`);
      assert.equal(Array.isArray(p.posts), true);
      for (const post of p.posts) {
        assert.equal(post.platform, "facebook");
        assert.equal(typeof post.post_id, "string");
        assert.equal(typeof post.permalink, "string");
        assert.equal(typeof post.author?.name, "string");
        assert.equal(typeof post.author?.is_anonymous, "boolean");
        assert.equal(typeof post.text, "string");
        assert.equal(typeof post.text_truncated, "boolean");
        assert.equal(Number.isInteger(post.captured_at), true);
        assert.equal(Array.isArray(post.attachments), true);
        assert.equal(EXTRACTION_STRATEGIES.has(post.extraction?.strategy), true);
      }
      break;
    case "crawl.report":
      assert.equal(typeof p.run_id, "string");
      assert.equal(CRAWL_REASONS.has(p.reason), true);
      assert.equal(CRAWL_STATUSES.has(p.status), true);
      assert.equal(Number.isInteger(p.started_at), true);
      assert.equal(Number.isInteger(p.ended_at), true);
      break;
    case "sources.discovered":
      assert.equal(Array.isArray(p.sources), true);
      break;
    case "session.status":
      assert.equal(typeof p.platform, "string");
      assert.equal(SESSION_STATES.has(p.state), true);
      break;
    case "crawl.request":
      assert.equal(typeof p.request_id, "string");
      assert.equal(p.reason === "manual" || p.reason === "preview", true);
      assert.equal(Number.isInteger(p.max_posts), true);
      break;
    case "crawl.pause":
      assert.equal(p.until === null || Number.isInteger(p.until), true);
      assert.equal(typeof p.reason, "string");
      break;
    case "ack":
      assert.equal(Number.isInteger(p.accepted), true);
      assert.equal(Number.isInteger(p.duplicates), true);
      break;
    case "error":
      assert.equal(ERROR_CODES.has(p.code), true);
      assert.equal(typeof p.message, "string");
      assert.equal(typeof p.retryable, "boolean");
      break;
    case "ping":
    case "pong":
    case "crawl.resume":
      assert.deepEqual(p, {}, `${indexLabel}: empty payload must be {}`);
      break;
  }
}

const raw = fs.readFileSync(fixturesPath, "utf8");
const data = JSON.parse(raw);

assert.equal(
  data.spec_section_6_session.length,
  5,
  "01-protocol.md §6 must contain 5 session messages"
);

const seenTypes = new Set();
for (const [idx, msg] of data.spec_section_6_session.entries()) {
  validateEnvelope(msg, `spec_section_6_session[${idx}]`);
  seenTypes.add(msg.type);
}
for (const [idx, msg] of data.additional_catalog_messages.entries()) {
  validateEnvelope(msg, `additional_catalog_messages[${idx}]`);
  seenTypes.add(msg.type);
}

assert.deepEqual(
  seenTypes,
  ALL_MESSAGE_TYPES,
  `Fixtures must cover all 14 v2 message types; missing: ${[
    ...ALL_MESSAGE_TYPES,
  ].filter((t) => !seenTypes.has(t))}`
);

// Verify exact 01-protocol.md §6 sequence IDs and reply_to chain.
assert.deepEqual(
  data.spec_section_6_session.map((m) => [m.id, m.type, m.reply_to]),
  [
    ["01A", "hello", null],
    ["01B", "hello.ok", "01A"],
    ["01C", "config.update", null],
    ["01D", "posts.push", null],
    ["01E", "ack", "01D"],
  ]
);

console.log(
  `Verified ${
    data.spec_section_6_session.length + data.additional_catalog_messages.length
  } Protocol v2 fixtures covering all ${seenTypes.size} message types.`
);
