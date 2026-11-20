/**
 * Local agent (MCP) request protocol shared by the MCP adapter (client) and the desktop
 * backend (server). Port of `crates/protocol/src/agent.rs` and the request validation half
 * of `crates/core/src/service/agent.rs`. The backend owns what each method DOES; this
 * module owns the wire format, size bound and constant-time token check.
 *
 * Wire: IPC frame payload = `DealSonarAgent/1\n` + JSON
 *   { "token": [32 bytes as ints], "method": "<snake_case>", "arguments": <any> }
 * Response frame: serde externally tagged `{"Ok": <value>}` | `{"Error": "<message>"}`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGENT_MAX_FRAME_BYTES,
  AGENT_TOKEN_BYTES,
  AGENT_TOKEN_FILE,
} from "./constants.js";
import { newUlid } from "./envelope.js";

export type AgentMethod =
  | "list_radar_sources"
  | "prepare_radar"
  | "check_radar_preview"
  | "retry_radar_preview";

export const AGENT_METHODS: readonly AgentMethod[] = [
  "list_radar_sources",
  "prepare_radar",
  "check_radar_preview",
  "retry_radar_preview",
];

export type AgentResponse = { Ok: unknown } | { Error: string };

/** Callback interface the desktop backend implements for the four agent methods. */
export interface AgentBackend {
  /**
   * Execute one agent method. Throw `AgentError` (message is returned verbatim to the MCP
   * client as `{"Error": message}`); any other thrown value becomes a generic internal error
   * so internals never leak.
   */
  handle(method: AgentMethod, args: unknown): Promise<unknown>;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** `CoreError::Validation` display form. */
export const VALIDATION_PREFIX = "dữ liệu đầu vào không hợp lệ: ";
export const INTERNAL_PREFIX = "lỗi nội bộ hệ thống: ";
export const validationMessage = (detail: string): string => `${VALIDATION_PREFIX}${detail}`;

const MSG_TOO_LARGE = "Yêu cầu agent quá lớn.";
const MSG_INVALID = "Yêu cầu agent không hợp lệ.";
const MSG_REFUSED =
  "DealSonar từ chối kết nối agent. Hãy kiểm tra đường dẫn ứng dụng và phiên desktop đang mở.";

interface ParsedAgentRequest {
  token: Buffer;
  method: AgentMethod;
  arguments: unknown;
}

function parseAgentRequest(payload: Uint8Array): ParsedAgentRequest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new AgentError(validationMessage(MSG_INVALID));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(validationMessage(MSG_INVALID));
  }
  const obj = value as Record<string, unknown>;
  const { token, method } = obj;
  const tokenOk =
    Array.isArray(token) &&
    token.length === AGENT_TOKEN_BYTES &&
    token.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255);
  if (
    !tokenOk ||
    typeof method !== "string" ||
    !(AGENT_METHODS as readonly string[]).includes(method) ||
    !Object.hasOwn(obj, "arguments")
  ) {
    throw new AgentError(validationMessage(MSG_INVALID));
  }
  return {
    token: Buffer.from(token as number[]),
    method: method as AgentMethod,
    arguments: obj.arguments,
  };
}

/** Constant-time comparison of two equal-length tokens. */
export function tokenMatches(expected: Uint8Array, presented: Uint8Array): boolean {
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * Validate and dispatch one agent frame payload (the bytes after `FRAME_PREFIX`).
 * Order matches Rust: size bound, parse, token check, then the backend callback
 * (which is responsible for its own shutdown check).
 */
export async function handleAgentFrame(
  payload: Uint8Array,
  expectedToken: Uint8Array | null | undefined,
  backend: AgentBackend | null | undefined,
): Promise<AgentResponse> {
  try {
    if (payload.length > AGENT_MAX_FRAME_BYTES) {
      throw new AgentError(validationMessage(MSG_TOO_LARGE));
    }
    const request = parseAgentRequest(payload);
    if (!expectedToken || !tokenMatches(expectedToken, request.token)) {
      throw new AgentError(validationMessage(MSG_REFUSED));
    }
    if (!backend) throw new AgentError(`${INTERNAL_PREFIX}agent backend unavailable`);
    const result = await backend.handle(request.method, request.arguments);
    return { Ok: result === undefined ? null : result };
  } catch (error) {
    if (error instanceof AgentError) return { Error: error.message };
    return { Error: `${INTERNAL_PREFIX}lỗi không xác định` };
  }
}

/**
 * Create a fresh 32-byte agent token at `<dataDir>/agent-access` (mode 0600 on Unix) via a
 * temp file + atomic rename (port of `issue_agent_token`). The desktop calls this at startup.
 */
export function issueAgentToken(dataDir: string): Buffer {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(AGENT_TOKEN_BYTES);
  const temporary = path.join(dataDir, `.agent-access-${newUlid()}`);
  try {
    fs.writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(dataDir, AGENT_TOKEN_FILE));
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return token;
}

/**
 * Read the agent token for the MCP adapter. On Unix the file must be a regular (non-symlink)
 * file owned by the current user and not accessible to group/others; anything else is
 * treated as unavailable. Returns null on any failure (callers map to a generic message).
 */
export function readAgentToken(dataDir: string): Buffer | null {
  const file = path.join(dataDir, AGENT_TOKEN_FILE);
  try {
    if (process.platform !== "win32") {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return null;
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
      if ((st.mode & 0o077) !== 0) return null;
    }
    const data = fs.readFileSync(file);
    return data.length === AGENT_TOKEN_BYTES ? data : null;
  } catch {
    return null;
  }
}
