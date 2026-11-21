// In-memory Tauri event bus used by the mock backend.

import type { DesktopEventMap } from "../../types/ipc";

type EventListenerFn<K extends keyof DesktopEventMap> = (payload: DesktopEventMap[K]) => void;

const listeners = new Map<keyof DesktopEventMap, Set<(payload: unknown) => void>>();

export function subscribeMockEvent<K extends keyof DesktopEventMap>(
  event: K,
  cb: EventListenerFn<K>
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const wrapped = (payload: unknown) => cb(payload as DesktopEventMap[K]);
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}

export function emitMockEvent<K extends keyof DesktopEventMap>(
  event: K,
  payload: DesktopEventMap[K]
): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    fn(payload);
  }
}
