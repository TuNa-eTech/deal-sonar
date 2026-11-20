/**
 * Length-prefixed framing (`01-protocol.md §1`): 4-byte little-endian u32 length + UTF-8 JSON.
 * Port of `crates/protocol/src/framing.rs`. Declared lengths are checked against the
 * per-direction maximum BEFORE any payload memory is accumulated.
 */

export class FrameTooLargeError extends Error {
  readonly size: number;
  readonly max: number;
  constructor(size: number, max: number) {
    super(`frame size ${size} bytes exceeds maximum allowed ${max} bytes`);
    this.name = "FrameTooLargeError";
    this.size = size;
    this.max = max;
  }
}

/** I/O level framing failure (truncated header/payload, socket error). */
export class FrameIoError extends Error {
  constructor(detail: string) {
    super(`I/O error during framing: ${detail}`);
    this.name = "FrameIoError";
  }
}

export type FrameError = FrameTooLargeError | FrameIoError;

/** Serialize `payload` as one frame; throws `FrameTooLargeError` when over `maxBytes`. */
export function encodeFrame(payload: Uint8Array, maxBytes: number): Buffer {
  if (payload.length > maxBytes || payload.length > 0xffff_ffff) {
    throw new FrameTooLargeError(payload.length, maxBytes);
  }
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32LE(payload.length, 0);
  out.set(payload, 4);
  return out;
}

/**
 * Incremental frame parser. Feed arbitrary stream chunks to `push`; complete frames are
 * delivered through the callback in order (frames preceding a framing error are still
 * delivered before `push` throws). After a throw the decoder must not be reused.
 */
export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerFilled = 0;
  private expected: number | null = null;
  private chunks: Buffer[] = [];
  private received = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.expected === null) {
        const take = Math.min(4 - this.headerFilled, chunk.length - offset);
        chunk.copy(this.header, this.headerFilled, offset, offset + take);
        this.headerFilled += take;
        offset += take;
        if (this.headerFilled < 4) break;
        this.headerFilled = 0;
        const size = this.header.readUInt32LE(0);
        if (size > this.maxBytes) throw new FrameTooLargeError(size, this.maxBytes);
        if (size === 0) {
          onFrame(Buffer.alloc(0));
          continue;
        }
        this.expected = size;
        this.chunks = [];
        this.received = 0;
      } else {
        const take = Math.min(this.expected - this.received, chunk.length - offset);
        this.chunks.push(chunk.subarray(offset, offset + take));
        this.received += take;
        offset += take;
        if (this.received === this.expected) {
          const frame = Buffer.concat(this.chunks, this.expected);
          this.expected = null;
          this.chunks = [];
          this.received = 0;
          onFrame(frame);
        }
      }
    }
  }

  /** True when no partial header/payload is buffered. */
  get idle(): boolean {
    return this.expected === null && this.headerFilled === 0;
  }

  /** Call at stream EOF: throws when EOF arrived mid-frame. */
  finish(): void {
    if (this.expected !== null) throw new FrameIoError("failed to fill whole buffer");
    if (this.headerFilled > 0) {
      throw new FrameIoError(
        `truncated 4-byte frame header after ${this.headerFilled} byte(s)`,
      );
    }
  }
}
