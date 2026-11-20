/**
 * MCP adapter -> desktop agent request (port of `call_desktop` in `crates/native-host/src/mcp.rs`).
 * Reads the per-session token from `<dataDir>/agent-access`, sends one `DealSonarAgent/1\n`
 * frame over local IPC and waits (max 15 s) for `{"Ok": …}` / `{"Error": "…"}`.
 */
import {
  AGENT_FRAME_PREFIX,
  AGENT_MAX_FRAME_BYTES,
  AGENT_TIMEOUT_MS,
} from "./constants.js";
import {
  resolveMcpDataDir,
  resolveMcpEndpoint,
  type Env,
} from "./endpoint.js";
import { connectIpc, readOneFrame, writeFrame } from "./ipc.js";
import { readAgentToken, type AgentMethod } from "./agent-protocol.js";

export const MSG_UNAVAILABLE =
  "Không kết nối được với DealSonar. Hãy mở bản desktop có hỗ trợ MCP rồi thử lại.";
export const MSG_PACK_FAILED = "Không đóng gói được yêu cầu Radar.";
export const MSG_TOO_LARGE = "Yêu cầu Radar quá lớn.";
export const MSG_TIMEOUT =
  "DealSonar không phản hồi trong 15 giây. Kiểm tra Radar trước khi thử lại.";

/** Error whose message is safe to show to the MCP client verbatim. */
export class DesktopCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopCallError";
  }
}

export type DesktopCaller = (method: AgentMethod, args: unknown) => Promise<unknown>;

export interface DesktopCallerOptions {
  env?: Env;
  timeoutMs?: number;
}

export function createDesktopCaller(options: DesktopCallerOptions = {}): DesktopCaller {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;

  return async (method, args) => {
    let dataDir: { dataDir: string; custom: boolean };
    let endpoint: string;
    try {
      dataDir = resolveMcpDataDir(env);
      endpoint = resolveMcpEndpoint(dataDir, env);
    } catch {
      throw new DesktopCallError(MSG_UNAVAILABLE);
    }
    const token = readAgentToken(dataDir.dataDir);
    if (!token) throw new DesktopCallError(MSG_UNAVAILABLE);

    let frame: Buffer;
    try {
      frame = Buffer.concat([
        AGENT_FRAME_PREFIX,
        Buffer.from(JSON.stringify({ token: Array.from(token), method, arguments: args }), "utf8"),
      ]);
    } catch {
      throw new DesktopCallError(MSG_PACK_FAILED);
    }
    if (frame.length > AGENT_MAX_FRAME_BYTES) throw new DesktopCallError(MSG_TOO_LARGE);

    let timer: NodeJS.Timeout | undefined;
    let socketRef: import("node:net").Socket | null = null;
    const exchange = (async (): Promise<unknown> => {
      try {
        const socket = await connectIpc(endpoint);
        socketRef = socket;
        socket.on("error", () => {
          /* reported via the pending read */
        });
        await writeFrame(socket, frame, AGENT_MAX_FRAME_BYTES);
        const response = await readOneFrame(socket, AGENT_MAX_FRAME_BYTES);
        if (response === null) throw new Error("eof");
        return JSON.parse(response.toString("utf8"));
      } catch {
        throw new DesktopCallError(MSG_UNAVAILABLE);
      }
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DesktopCallError(MSG_TIMEOUT)), timeoutMs);
    });
    let parsed: unknown;
    try {
      parsed = await Promise.race([exchange, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      (socketRef as import("node:net").Socket | null)?.destroy();
      exchange.catch(() => undefined);
    }

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Object.keys(obj).length === 1) {
        if ("Ok" in obj) return obj.Ok;
        if ("Error" in obj && typeof obj.Error === "string") throw new DesktopCallError(obj.Error);
      }
    }
    throw new DesktopCallError(MSG_UNAVAILABLE);
  };
}
