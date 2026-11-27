import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rustCompat = read("crates/protocol/src/compat.rs");
const tsCompat = read("apps/extension/src/compat.ts");

test("extension and Desktop declare the same minimum Desktop version", () => {
  const rust = /pub const MIN_DESKTOP_VERSION: &str = "([^"]+)";/.exec(rustCompat)?.[1];
  const ts = /export const MIN_DESKTOP_VERSION = "([^"]+)";/.exec(tsCompat)?.[1];
  assert.ok(rust && ts, "both constants must exist");
  assert.equal(ts, rust);
});

test("the wire protocol number is the same in Rust and TypeScript", () => {
  const rust = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(read("crates/protocol/src/lib.rs"))?.[1];
  const ts = /export const PROTOCOL_VERSION = (\d+);/.exec(read("apps/extension/src/protocol.ts"))?.[1];
  assert.ok(rust && ts);
  assert.equal(ts, rust);
});

test("the minimum versions are plain MAJOR.MINOR.PATCH", () => {
  for (const v of [/MIN_EXTENSION_VERSION: &str = "([^"]+)"/.exec(rustCompat)?.[1], /MIN_DESKTOP_VERSION: &str = "([^"]+)"/.exec(rustCompat)?.[1]]) {
    assert.match(v, /^\d+\.\d+\.\d+$/);
  }
});
