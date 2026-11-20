/**
 * Stateless bidirectional frame relay between Chrome Native Messaging (stdio) and the
 * DealSonar desktop over local IPC (`01-protocol.md §1, §7`). Port of
 * `crates/native-host/src/lib.rs`.
 *
 * - Frames are forwarded verbatim in both directions (stdin -> IPC up to 64 MiB,
 *   IPC -> stdout up to 1 MiB).
 * - If IPC cannot connect at startup or drops mid-stream, every incoming stdin frame is
 *   answered immediately with a v2 `error` envelope (`desktop_unavailable`, retryable,
 *   `reply_to` = incoming id) and a reconnect is attempted every `reconnectIntervalMs`.
 * - Clean stdin EOF closes IPC cleanly, flushes stdout and resolves.
 * - Backpressure: stdin is paused while either the IPC socket or stdout has a full write
 *   buffer; IPC reads are paused while stdout is full.
 */
import type * as net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_RECONNECT_INTERVAL_MS,
  MAX_EXT_TO_HOST_BYTES,
  MAX_HOST_TO_EXT_BYTES,
} from "./constants.js";
import { buildDesktopUnavailableBytes } from "./envelope.js";
import { resolveIpcEndpoint, type Env } from "./endpoint.js";
import { FrameDecoder, FrameIoError, encodeFrame } from "./framing.js";
import { connectIpc } from "./ipc.js";

export interface RelayConfig {
  endpoint: string;
  reconnectIntervalMs: number;
  /** Test seam; defaults to the real same-user-checked IPC connector. */
  connect?: (endpoint: string) => Promise<net.Socket>;
}

export function relayConfigFromEnv(env: Env = process.env): RelayConfig {
  return {
    endpoint: resolveIpcEndpoint(env),
    reconnectIntervalMs: DEFAULT_RECONNECT_INTERVAL_MS,
  };
}

const IPC_CLOSE_GRACE_MS = 2_000;

export function runRelay(stdin: Readable, stdout: Writable, config: RelayConfig): Promise<void> {
  const connect = config.connect ?? connectIpc;
  const interval = config.reconnectIntervalMs;

  return new Promise<void>((resolve, reject) => {
    const stdinDecoder = new FrameDecoder(MAX_EXT_TO_HOST_BYTES);
    let ipc: { socket: net.Socket; decoder: FrameDecoder } | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let finished = false;

    const refreshFlow = (): void => {
      if (finished) return;
      const outBusy = stdout.writableNeedDrain;
      const inBusy = ipc ? ipc.socket.writableNeedDrain : false;
      if (outBusy || inBusy) stdin.pause();
      else stdin.resume();
      if (ipc) {
        if (outBusy) ipc.socket.pause();
        else ipc.socket.resume();
      }
    };

    const cleanup = (): void => {
      finished = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stdin.off("data", onStdinData);
      stdin.off("end", onStdinEnd);
      stdin.off("error", onStdinError);
      stdout.off("drain", refreshFlow);
      stdout.off("error", onStdoutError);
      stdin.pause();
    };

    const fail = (error: Error): void => {
      if (finished) return;
      const link = ipc;
      ipc = null;
      cleanup();
      link?.socket.destroy();
      reject(error);
    };

    const onStdoutError = (error: Error): void => fail(new FrameIoError(error.message));
    const onStdinError = (error: Error): void => fail(new FrameIoError(error.message));

    const writeStdout = (payload: Buffer): void => {
      if (finished) return;
      let framed: Buffer;
      try {
        framed = encodeFrame(payload, MAX_HOST_TO_EXT_BYTES);
      } catch (error) {
        fail(error as Error);
        return;
      }
      stdout.write(framed, (error) => {
        if (error) onStdoutError(error);
      });
      refreshFlow();
    };

    const replyUnavailable = (incoming: Buffer): void => {
      writeStdout(buildDesktopUnavailableBytes(incoming));
    };

    const scheduleReconnect = (): void => {
      if (finished || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attemptConnect();
      }, interval);
    };

    const dropIpc = (link: { socket: net.Socket }): void => {
      if (ipc !== link) return;
      ipc = null;
      link.socket.destroy();
      if (!finished) {
        scheduleReconnect();
        refreshFlow();
      }
    };

    const adoptIpc = (socket: net.Socket): void => {
      if (finished) {
        socket.destroy();
        return;
      }
      const link = { socket, decoder: new FrameDecoder(MAX_HOST_TO_EXT_BYTES) };
      ipc = link;
      socket.on("error", () => {
        /* surfaced through 'close' */
      });
      socket.on("close", () => dropIpc(link));
      socket.on("drain", refreshFlow);
      socket.on("data", (chunk: Buffer) => {
        if (ipc !== link) return;
        try {
          link.decoder.push(chunk, (frame) => {
            if (ipc === link) writeStdout(frame);
          });
        } catch {
          // Oversized/corrupt desktop frame: treat as a disconnect and reconnect later.
          dropIpc(link);
        }
      });
      refreshFlow();
    };

    const attemptConnect = async (): Promise<void> => {
      try {
        const socket = await connect(config.endpoint);
        adoptIpc(socket);
      } catch {
        scheduleReconnect();
      }
    };

    const forwardToIpc = (frame: Buffer): void => {
      const link = ipc;
      if (!link) {
        replyUnavailable(frame);
        return;
      }
      let framed: Buffer;
      try {
        framed = encodeFrame(frame, MAX_EXT_TO_HOST_BYTES);
      } catch (error) {
        fail(error as Error);
        return;
      }
      link.socket.write(framed, (error) => {
        if (!error || finished) return;
        dropIpc(link);
        replyUnavailable(frame);
      });
      refreshFlow();
    };

    const onStdinData = (chunk: Buffer): void => {
      try {
        stdinDecoder.push(chunk, (frame) => {
          if (!finished) forwardToIpc(frame);
        });
      } catch (error) {
        fail(error as Error);
      }
    };

    const onStdinEnd = (): void => {
      if (finished) return;
      try {
        stdinDecoder.finish();
      } catch (error) {
        fail(error as Error);
        return;
      }
      const link = ipc;
      ipc = null;
      cleanup();
      void (async () => {
        if (link) {
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              link.socket.destroy();
              done();
            }, IPC_CLOSE_GRACE_MS);
            link.socket.once("close", () => {
              clearTimeout(timer);
              done();
            });
            link.socket.end();
          });
        }
        await new Promise<void>((done, bad) => {
          stdout.on("error", bad);
          stdout.write(Buffer.alloc(0), (error) => (error ? bad(error) : done()));
        });
        resolve();
      })().catch((error: Error) => reject(error));
    };

    stdin.on("data", onStdinData);
    stdin.once("end", onStdinEnd);
    stdin.once("error", onStdinError);
    stdout.on("drain", refreshFlow);
    stdout.on("error", onStdoutError);

    // Hold stdin until the first connection attempt settles so early frames are not
    // answered "unavailable" while the initial connect is still in flight.
    stdin.pause();
    connect(config.endpoint).then(
      (socket) => {
        adoptIpc(socket);
        refreshFlow();
      },
      () => {
        scheduleReconnect();
        refreshFlow();
      },
    );
  });
}
