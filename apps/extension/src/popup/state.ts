// Shared popup state and small DOM helpers.

import type { SourceInfo, SourceRef } from "../protocol";
import type { PopupStatusSnapshot } from "../messages";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing popup element #${id}`);
  return el as T;
}

/** Mutable popup state shared by the popup modules. */
export const popupState: {
  currentGroupCandidate: SourceInfo | null;
  latestStatus: PopupStatusSnapshot | null;
  scanPending: boolean;
  optionsLoaded: boolean;
  optionsSaving: boolean;
  optionsUnsaved: boolean;
  selectedSources: SourceRef[];
  cleanupPanel: (() => void) | null;
} = {
  currentGroupCandidate: null,
  latestStatus: null,
  scanPending: false,
  optionsLoaded: false,
  optionsSaving: false,
  optionsUnsaved: false,
  selectedSources: [],
  cleanupPanel: null,
};

export function showError(error: unknown): void {
  const el = byId("panel-error");
  el.textContent = error instanceof Error ? error.message : String(error);
  el.classList.remove("hidden");
}
