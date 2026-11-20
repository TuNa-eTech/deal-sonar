/**
 * Electron renderer transport. The preload (`apps/desktop-electron/src/preload/index.ts`) exposes
 * `window.dealsonarDesktop`; this module adapts it to the same call/reject/event semantics the UI
 * already gets from Tauri:
 *  - success resolves with the command result,
 *  - failure rejects with something whose `String(err)` is the Vietnamese message (Tauri rejected
 *    with a plain string), plus `.code` carrying the Rust `CommandError` code.
 */

export interface DesktopWireError {
  code: string;
  message: string;
}

export type DesktopInvokeEnvelope = { ok: true; value: unknown } | { ok: false; error: DesktopWireError };

export interface DesktopBridge {
  shell: "electron";
  invoke(cmd: string, args?: Record<string, unknown>): Promise<DesktopInvokeEnvelope>;
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    dealsonarDesktop?: DesktopBridge;
  }
}

/** Rejection value for failed commands. `String(err)` and `err.message` are both the plain message. */
export class DesktopCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopCommandError";
    this.code = code;
  }
  toString(): string {
    return this.message;
  }
}

export function getElectronBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.dealsonarDesktop;
  return bridge && bridge.shell === "electron" && typeof bridge.invoke === "function" ? bridge : null;
}

export function isElectronRuntime(): boolean {
  return getElectronBridge() !== null;
}

export async function invokeElectron<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const bridge = getElectronBridge();
  if (!bridge) throw new DesktopCommandError("bridge_unavailable", "Cầu nối Electron chưa sẵn sàng");
  const envelope = await bridge.invoke(cmd, args);
  if (envelope.ok) return envelope.value as T;
  throw new DesktopCommandError(envelope.error.code, envelope.error.message);
}

export function listenElectron<T>(event: string, handler: (payload: T) => void): () => void {
  const bridge = getElectronBridge();
  if (!bridge) throw new DesktopCommandError("bridge_unavailable", "Cầu nối Electron chưa sẵn sàng");
  return bridge.onEvent(event, (payload) => handler(payload as T));
}
