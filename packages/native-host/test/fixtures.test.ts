/**
 * Runs the canonical Protocol v2 fixtures (shared with the Rust oracle and the extension) through
 * the relay in both directions: every message must cross byte-for-byte and the unavailable path
 * must reply to each fixture id.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import { DesktopIpcServer, type ExtensionConnection } from "../src/ipc.js";
import { runRelay } from "../src/relay.js";
import { FrameCollector, cleanupTmpDirs, frameOf, testEndpoint, tmpDir, waitFor } from "./helpers.js";

afterAll(cleanupTmpDirs);

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../fixtures/protocol-v2-examples.json");
const present = fs.existsSync(fixturePath);

const EXT_TO_DESKTOP = new Set(["hello", "posts.push", "crawl.report", "sources.discovered", "session.status", "ping"]);

const servers: DesktopIpcServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe.skipIf(!present)("Protocol v2 fixtures through the relay", () => {
  const data = present ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : { spec_section_6_session: [], additional_catalog_messages: [] };
  const messages: any[] = [...data.spec_section_6_session, ...data.additional_catalog_messages];

  it("covers all 14 message types", () => {
    expect(new Set(messages.map((m) => m.type)).size).toBe(14);
  });

  it("extension->desktop messages arrive byte-identical; desktop->extension messages return byte-identical", async () => {
    const endpoint = testEndpoint(tmpDir());
    const received: Buffer[] = [];
    let conn = null as ExtensionConnection | null;
    servers.push(
      await DesktopIpcServer.bind({
        endpoint,
        onExtensionConnection: (c) => {
          conn = c;
          c.onFrame((f) => received.push(f));
        },
      }),
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = new FrameCollector(stdout, MAX_HOST_TO_EXT_BYTES);
    const done = runRelay(stdin, stdout, { endpoint, reconnectIntervalMs: 50 });

    const up = messages.filter((m) => EXT_TO_DESKTOP.has(m.type));
    const down = messages.filter((m) => !EXT_TO_DESKTOP.has(m.type));
    const upBytes = up.map((m) => Buffer.from(JSON.stringify(m)));
    for (const b of upBytes) stdin.write(frameOf(b.toString("utf8")));
    await waitFor(() => received.length === up.length, 10_000);
    received.forEach((r, i) => expect(r.equals(upBytes[i]!)).toBe(true));

    const downBytes = down.map((m) => Buffer.from(JSON.stringify(m)));
    for (const b of downBytes) await conn!.sendFrame(b);
    await out.waitForCount(down.length, 10_000);
    out.frames.forEach((f, i) => expect(f.equals(downBytes[i]!)).toBe(true));

    stdin.end();
    await done;
  });

  it("every extension->desktop fixture gets a desktop_unavailable reply carrying its id when the desktop is down", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = new FrameCollector(stdout, MAX_HOST_TO_EXT_BYTES);
    const done = runRelay(stdin, stdout, { endpoint: testEndpoint(tmpDir()), reconnectIntervalMs: 1_000 });
    const up = messages.filter((m) => EXT_TO_DESKTOP.has(m.type));
    for (const m of up) stdin.write(frameOf(JSON.stringify(m)));
    await out.waitForCount(up.length, 10_000);
    up.forEach((m, i) => {
      const reply = JSON.parse(out.frames[i]!.toString("utf8"));
      expect(reply.reply_to).toBe(m.id);
      expect(reply.payload.code).toBe("desktop_unavailable");
    });
    stdin.end();
    await done;
  });
});
