// Wire contract between the Electron shell (main) and this utilityProcess, plus the error types
// that mirror `CoreError` / `CommandError` (apps/desktop/src/commands/error.rs). The shell's
// copy of these types lives in `apps/desktop-electron/src/shared/contract.ts`; keep both equal.

import { StoreError, toStoreError } from "../store/errors";
import { SecretError } from "../secrets/types";

export const BACKEND_PROTOCOL_VERSION = 1;

/** Control commands; never reachable from the renderer. */
export const BACKEND_CONTROL = {
  ready: "backend:ready",
  fatal: "backend:fatal",
  shutdown: "backend:shutdown",
  toggleCrawlPaused: "backend:toggle_crawl_paused",
  osNotification: "os:notification",
} as const;

export interface BackendRequest {
  id: number;
  command: string;
  args: Record<string, unknown> | null;
}
export interface WireError {
  code: string;
  message: string;
}
export type BackendReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError };
export interface BackendPush {
  event: string;
  payload: unknown;
}
export interface OsNotificationPayload {
  lead_id: string;
  radar_name: string;
  summary: string;
}

/** The 58 backend commands: exactly the `match cmd` arms of `commands/dispatch.rs`. */
export const BACKEND_COMMANDS = [
  "radar_list",
  "radar_get",
  "radar_create_draft",
  "radar_update",
  "radar_suggest_fields",
  "radar_set_status",
  "radar_preview_start",
  "radar_preview_get",
  "radar_preview_cancel",
  "radar_stats",
  "template_list",
  "template_get",
  "source_list",
  "source_follow",
  "source_unfollow",
  "source_set_priority",
  "source_crawl_now",
  "lead_list",
  "lead_get",
  "lead_mark_read",
  "lead_set_status",
  "lead_update_field",
  "lead_feedback",
  "lead_export",
  "post_get",
  "post_list_by_source",
  "post_search",
  "evaluation_list_rejected",
  "contact_list",
  "contact_get",
  "contact_block",
  "contact_note",
  "blocklist_list",
  "blocklist_add",
  "blocklist_remove",
  "ruleset_list",
  "ruleset_save_user",
  "ruleset_compile_now",
  "settings_get",
  "settings_set",
  "ai_probe",
  "ai_set_provider",
  "telegram_set_token",
  "telegram_test",
  "channel_list",
  "channel_remove",
  "webhook_add",
  "chrome_connect",
  "license_get",
  "license_set",
  "health_get",
  "crawl_run_list",
  "ai_usage_get",
  "diagnostic_bundle_create",
  "data_backup",
  "workspace_action",
  "data_purge",
  "data_delete_all",
] as const;
export type BackendCommandId = (typeof BACKEND_COMMANDS)[number];
const COMMAND_SET: ReadonlySet<string> = new Set(BACKEND_COMMANDS);
export const isBackendCommand = (cmd: string): cmd is BackendCommandId => COMMAND_SET.has(cmd);

// ---- errors ------------------------------------------------------------------------------------

export type CoreErrorKind =
  | "store"
  | "secret"
  | "validation"
  | "not_found"
  | "license_invalid"
  | "license_limit_exceeded"
  | "shutting_down"
  | "ai"
  | "notify"
  | "internal"
  | "json"
  | "io"
  | "not_implemented";

const PREFIX: Record<CoreErrorKind, string> = {
  store: "lỗi cơ sở dữ liệu: ",
  secret: "lỗi khoá bí mật hệ điều hành: ",
  validation: "dữ liệu đầu vào không hợp lệ: ",
  not_found: "",
  license_invalid: "mã bản quyền không hợp lệ: ",
  license_limit_exceeded: "đã đạt giới hạn gói bản quyền: ",
  shutting_down: "",
  ai: "lỗi AI Bridge: ",
  notify: "lỗi thông báo / xuất dữ liệu: ",
  internal: "lỗi nội bộ hệ thống: ",
  json: "lỗi dữ liệu JSON: ",
  io: "lỗi I/O: ",
  not_implemented: "",
};

/** `CommandError` code of each `CoreError` variant (`impl From<CoreError> for CommandError`). */
const CODE: Record<CoreErrorKind, string> = {
  store: "store_error",
  secret: "secret_error",
  validation: "validation_error",
  not_found: "not_found",
  license_invalid: "license_invalid",
  license_limit_exceeded: "license_limit_exceeded",
  shutting_down: "shutting_down",
  ai: "ai_error",
  notify: "notify_error",
  internal: "internal_error",
  json: "internal_error",
  io: "internal_error",
  not_implemented: "not_implemented",
};

/** TS counterpart of Rust `CommandError::new(code, message)` for errors raised at the command layer. */
export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

/** TS counterpart of the Rust `CoreError`; `message` is the Display string shown in the UI. */
export class CoreError extends Error {
  readonly kind: CoreErrorKind;
  readonly code: string;
  constructor(kind: CoreErrorKind, message: string) {
    super(message);
    this.name = "CoreError";
    this.kind = kind;
    this.code = CODE[kind];
  }
  static validation(detail: string): CoreError {
    return new CoreError("validation", `${PREFIX.validation}${detail}`);
  }
  static notFound(entity: string, id: string): CoreError {
    return new CoreError("not_found", `không tìm thấy ${entity}: ${id}`);
  }
  static shuttingDown(): CoreError {
    return new CoreError("shutting_down", "hệ thống đang tắt");
  }
  static internal(detail: string): CoreError {
    return new CoreError("internal", `${PREFIX.internal}${detail}`);
  }
  static licenseInvalid(detail: string): CoreError {
    return new CoreError("license_invalid", `${PREFIX.license_invalid}${detail}`);
  }
  static licenseLimit(detail: string): CoreError {
    return new CoreError("license_limit_exceeded", `${PREFIX.license_limit_exceeded}${detail}`);
  }
  /** A command whose Rust behaviour has not been ported yet. Distinct code so it is never mistaken for a real failure. */
  static notImplemented(command: string): CoreError {
    return new CoreError("not_implemented", `lệnh chưa được hỗ trợ trong bản Electron: ${command}`);
  }
}

/** Convert any thrown value to the `{code, message}` the shell expects. Never includes stack traces. */
export function toWireError(err: unknown): WireError {
  if (err instanceof CommandError) return { code: err.code, message: err.message };
  if (err instanceof CoreError) return { code: err.code, message: err.message };
  if (err instanceof SecretError) {
    return { code: CODE.secret, message: `${PREFIX.secret}${err.message}` };
  }
  const storeError = err instanceof StoreError ? err : toStoreErrorIfNative(err);
  if (storeError) {
    // Every store-origin failure is `CoreError::Store` in Rust, whatever its inner kind.
    return { code: CODE.store, message: `${PREFIX.store}${storeError.message}` };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { code: CODE.internal, message: `${PREFIX.internal}${detail}` };
}

function toStoreErrorIfNative(err: unknown): StoreError | null {
  const e = err as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string" && e.code.startsWith("SQLITE_")) return toStoreError(err);
  if (e?.name === "DomainShapeError" || err instanceof SyntaxError) return toStoreError(err);
  return null;
}

// ---- argument parsing (`parse_arg` / `parse_opt_arg`) ------------------------------------------

export type Args = Record<string, unknown>;

export function requireArg<T = unknown>(args: Args, key: string): T {
  if (!(key in args) || args[key] === undefined) {
    throw new CommandError("validation_error", `thiếu tham số '${key}'`);
  }
  return args[key] as T;
}

export function optArg<T = unknown>(args: Args, key: string): T | null {
  const v = args[key];
  return v === undefined || v === null ? null : (v as T);
}
