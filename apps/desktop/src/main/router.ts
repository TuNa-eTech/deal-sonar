import { isBackendCommand, isShellCommand, type InvokeEnvelope, type WireError } from "../shared/contract";
import { validateSafeExternalUrl } from "../shared/security";
import { BackendError } from "./backend-client";

export interface RouterDeps {
  backend: { request(command: string, args: Record<string, unknown>): Promise<unknown> };
  /** Native open-file dialog filtered to SQLite backups. Resolves null when cancelled. */
  pickBackupFile(): Promise<string | null>;
  /** Hands an already validated URL to the OS browser. */
  openExternal(url: URL): Promise<void>;
  /** Called with the result of settings_get / settings_set so the shell can sync autostart. */
  onSettings?(settings: unknown): void;
}

const fail = (code: string, message: string): InvokeEnvelope => ({ ok: false, error: { code, message } });

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Single entry for every renderer command. Mirrors `commands/dispatch.rs`: the command must be a
 * known ID, args must be a JSON object, unknown commands fail with `unknown_command`.
 */
export async function routeInvoke(deps: RouterDeps, cmd: unknown, args: unknown): Promise<InvokeEnvelope> {
  if (typeof cmd !== "string" || !(isBackendCommand(cmd) || isShellCommand(cmd))) {
    return fail("unknown_command", `lệnh IPC không tồn tại: ${typeof cmd === "string" ? cmd.slice(0, 80) : String(typeof cmd)}`);
  }
  const argObject = args === undefined || args === null ? {} : args;
  if (!isPlainObject(argObject)) {
    return fail("validation_error", "tham số lệnh IPC phải là đối tượng JSON");
  }

  try {
    if (isShellCommand(cmd)) {
      return await routeShell(deps, cmd, argObject);
    }
    const value = await deps.backend.request(cmd, argObject);
    if (cmd === "settings_get" || cmd === "settings_set") {
      try {
        deps.onSettings?.(value);
      } catch {
        // Autostart sync is best effort (Rust logged and continued); never fail the command.
      }
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: toWire(err) };
  }
}

async function routeShell(
  deps: RouterDeps,
  cmd: "backup_pick_file" | "open_external_url",
  args: Record<string, unknown>
): Promise<InvokeEnvelope> {
  if (cmd === "backup_pick_file") {
    try {
      return { ok: true, value: await deps.pickBackupFile() };
    } catch (err) {
      return fail("file_picker_failed", err instanceof Error ? err.message : String(err));
    }
  }
  if (typeof args.url !== "string") {
    return fail("validation_error", args.url === undefined ? "thiếu tham số 'url'" : "tham số 'url' không hợp lệ");
  }
  const check = validateSafeExternalUrl(args.url);
  if (!check.ok) return fail("blocked_external_url", check.message);
  try {
    await deps.openExternal(check.url);
  } catch (err) {
    return fail("browser_open_failed", err instanceof Error ? err.message : String(err));
  }
  return { ok: true, value: { opened: true } };
}

function toWire(err: unknown): WireError {
  if (err instanceof BackendError) return err.toWire();
  return { code: "internal_error", message: err instanceof Error ? err.message : String(err) };
}
