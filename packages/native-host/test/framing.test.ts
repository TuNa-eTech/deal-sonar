import { describe, expect, it } from "vitest";
import { MAX_HOST_TO_EXT_BYTES } from "../src/constants.js";
import {
  FrameDecoder,
  FrameIoError,
  FrameTooLargeError,
  encodeFrame,
} from "../src/framing.js";

function decodeAll(chunks: Buffer[], max = 1024): Buffer[] {
  const d = new FrameDecoder(max);
  const out: Buffer[] = [];
  for (const c of chunks) d.push(c, (f) => out.push(f));
  d.finish();
  return out;
}

describe("framing", () => {
  it("encodes a 4-byte little-endian length prefix", () => {
    const framed = encodeFrame(Buffer.from("abc"), 10);
    expect([...framed]).toEqual([3, 0, 0, 0, 0x61, 0x62, 0x63]);
  });

  it("round-trips frames split at every byte boundary", () => {
    const payloads = [Buffer.from('{"a":1}'), Buffer.from("x".repeat(300))];
    const wire = Buffer.concat(payloads.map((p) => encodeFrame(p, 1024)));
    const bytewise = [...wire].map((b) => Buffer.from([b]));
    expect(decodeAll(bytewise).map(String)).toEqual(payloads.map(String));
  });

  it("delivers several frames from one chunk and keeps zero-length frames", () => {
    const wire = Buffer.concat([
      encodeFrame(Buffer.from("a"), 10),
      encodeFrame(Buffer.alloc(0), 10),
      encodeFrame(Buffer.from("b"), 10),
    ]);
    expect(decodeAll([wire]).map((f) => f.toString())).toEqual(["a", "", "b"]);
  });

  it("rejects a declared length over the limit before buffering payload", () => {
    const d = new FrameDecoder(MAX_HOST_TO_EXT_BYTES);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffff_fff0, 0);
    expect(() => d.push(header, () => undefined)).toThrow(FrameTooLargeError);
  });

  it("accepts exactly the maximum and rejects max+1 on encode", () => {
    expect(() => encodeFrame(Buffer.alloc(8), 8)).not.toThrow();
    expect(() => encodeFrame(Buffer.alloc(9), 8)).toThrow(FrameTooLargeError);
  });

  it("delivers frames preceding an oversized header before throwing", () => {
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(2048, 0);
    const d = new FrameDecoder(1024);
    const got: string[] = [];
    expect(() => d.push(Buffer.concat([encodeFrame(Buffer.from("ok"), 1024), bad]), (f) => got.push(f.toString()))).toThrow(
      FrameTooLargeError,
    );
    expect(got).toEqual(["ok"]);
  });

  it("reports truncated header and truncated payload at EOF", () => {
    const a = new FrameDecoder(1024);
    a.push(Buffer.from([1, 0]), () => undefined);
    expect(() => a.finish()).toThrow(/truncated 4-byte frame header after 2 byte/);

    const b = new FrameDecoder(1024);
    b.push(Buffer.from([5, 0, 0, 0, 0x61]), () => undefined);
    expect(() => b.finish()).toThrow(FrameIoError);
  });

  it("is idle at EOF on a frame boundary", () => {
    const d = new FrameDecoder(1024);
    d.push(encodeFrame(Buffer.from("z"), 1024), () => undefined);
    expect(d.idle).toBe(true);
    expect(() => d.finish()).not.toThrow();
  });
});
