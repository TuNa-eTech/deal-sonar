/**
 * Compatibility contracts shared by main, preload and tests.
 *
 * - Command IDs, argument objects and result shapes are the Tauri `invoke_handler` set from
 *   `apps/desktop/src/lib.rs` and `apps/desktop/ui/src/lib/api.ts`. Do not rename.
 * - Push event names are `TauriEventMap` in `apps/desktop/ui/src/types/ipc.ts`.
 */

/** Commands forwarded to the Backend utilityProcess unchanged. */
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

/** Commands the shell answers itself because they need OS UI (`commands/system.rs`). */
export const SHELL_COMMANDS = ["backup_pick_file", "open_external_url"] as const;

export type BackendCommandId = (typeof BACKEND_COMMANDS)[number];
export type ShellCommandId = (typeof SHELL_COMMANDS)[number];

const BACKEND_COMMAND_SET: ReadonlySet<string> = new Set(BACKEND_COMMANDS);
const SHELL_COMMAND_SET: ReadonlySet<string> = new Set(SHELL_COMMANDS);

export const isBackendCommand = (cmd: string): cmd is BackendCommandId => BACKEND_COMMAND_SET.has(cmd);
export const isShellCommand = (cmd: string): cmd is ShellCommandId => SHELL_COMMAND_SET.has(cmd);

/** Push events forwarded to the renderer (`TauriEventMap`). */
export const RENDERER_EVENTS = [
  "lead:new",
  "lead:reminder",
  "lead:updated",
  "preview:progress",
  "radar:draft-created",
  "health:changed",
  "crawl:finished",
  "job:failed",
] as const;
export type RendererEvent = (typeof RENDERER_EVENTS)[number];
const RENDERER_EVENT_SET: ReadonlySet<string> = new Set(RENDERER_EVENTS);
export const isRendererEvent = (name: string): name is RendererEvent => RENDERER_EVENT_SET.has(name);

/** Renderer <-> main channels (only these are exposed by the preload). */
export const IPC_INVOKE_CHANNEL = "dealsonar:invoke";
export const IPC_EVENT_CHANNEL = "dealsonar:event";

export interface WireError {
  code: string;
  message: string;
}

/** What `ipcMain.handle` returns; the preload turns `ok:false` into a thrown error. */
export type InvokeEnvelope = { ok: true; value: unknown } | { ok: false; error: WireError };

export interface RendererEventMessage {
  event: RendererEvent;
  payload: unknown;
}

// ---------------------------------------------------------------------------------------------
// Backend utilityProcess protocol (main <-> Backend bundled entry), over `postMessage`.
// ---------------------------------------------------------------------------------------------

export const BACKEND_PROTOCOL_VERSION = 1;

/** main -> backend */
export interface BackendRequest {
  id: number;
  command: string;
  args: Record<string, unknown>;
}

/** backend -> main, answers exactly one request */
export type BackendReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError };

/** backend -> main, unsolicited */
export interface BackendPush {
  event: string;
  payload: unknown;
}

/**
 * Control commands. They never come from the renderer and are not in `BACKEND_COMMANDS`.
 *
 * Startup handshake: shell forks the entry with env (see `backend-env.ts`); backend pushes
 * `backend:ready` once SQLite is open, the IPC socket is listening and workers are running.
 * If it cannot start it pushes `backend:fatal` {code,message} and exits non-zero.
 *
 * Shutdown handshake: shell sends request `backend:shutdown` {grace_ms}. Backend stops accepting
 * work, drains in-flight AI calls up to grace_ms, closes IPC and flushes logs, replies ok, exits 0.
 * Shell force-kills after grace_ms + 2s.
 */
export const BACKEND_CONTROL = {
  ready: "backend:ready",
  fatal: "backend:fatal",
  shutdown: "backend:shutdown",
  /** request with no args; replies with the new HealthStatus (tray menu "Tạm dừng / Tiếp tục quét"). */
  toggleCrawlPaused: "backend:toggle_crawl_paused",
  /** push, payload {lead_id, radar_name, summary}: replaces Rust `OsNotificationHook`. Not forwarded to renderer. */
  osNotification: "os:notification",
} as const;

export interface BackendReadyPayload {
  protocol: number;
  version?: string;
}

export interface OsNotificationPayload {
  lead_id: string;
  radar_name: string;
  summary: string;
}
