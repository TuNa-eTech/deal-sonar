// Toolbar action badge reflecting connection, session, and pause state.

import type { ExtensionStorageState } from "./storage";
import { storage } from "./context";

export async function updateActionBadge(state?: ExtensionStorageState): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action?.setBadgeText) return;
  try {
    const s = state ?? (await storage.read());
    if (!s.connection.connected || !s.connection.desktop_available) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
      return;
    }
    if (s.session.state !== "ok") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
      return;
    }
    if (s.pause.paused) {
      await chrome.action.setBadgeText({ text: "II" });
      await chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
      return;
    }
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Ignore badge API errors in headless/test contexts
  }
}
