import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  isRendererEvent,
  type InvokeEnvelope,
  type RendererEventMessage,
} from "../shared/contract";

/**
 * The only surface the renderer gets. No `ipcRenderer`, no Node, no generic channel access.
 *
 * `invoke` resolves with the envelope instead of throwing: errors thrown across `contextBridge`
 * lose their custom fields, so the renderer transport (`apps/desktop/ui/src/lib/electronBridge.ts`)
 * rebuilds the error from `{code, message}`.
 */
const bridge = {
  shell: "electron" as const,

  invoke(cmd: string, args?: Record<string, unknown>): Promise<InvokeEnvelope> {
    return ipcRenderer.invoke(IPC_INVOKE_CHANNEL, String(cmd), args ?? {}) as Promise<InvokeEnvelope>;
  },

  /** Subscribes to one push event; returns the unsubscribe function. Unknown events are rejected. */
  onEvent(event: string, handler: (payload: unknown) => void): () => void {
    if (!isRendererEvent(event) || typeof handler !== "function") {
      throw new Error(`event not allowed: ${String(event).slice(0, 80)}`);
    }
    const listener = (_e: IpcRendererEvent, msg: RendererEventMessage): void => {
      if (msg && msg.event === event) handler(msg.payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener);
    };
  },
};

contextBridge.exposeInMainWorld("dealsonarDesktop", bridge);
