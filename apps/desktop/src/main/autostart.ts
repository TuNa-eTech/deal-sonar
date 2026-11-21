import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUTOSTART_ARG = "--autostart";

export interface AutostartTarget {
  platform: NodeJS.Platform;
  home: string;
  /** Executable to launch at login. For AppImage this is `$APPIMAGE`, not the mounted binary. */
  exePath: string;
  appId: string;
  appName: string;
  /** Windows only: wraps `app.setLoginItemSettings`. */
  setWindowsLoginItem?: (enabled: boolean) => void;
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** macOS LaunchAgent, same mechanism as `tauri-plugin-autostart` `MacosLauncher::LaunchAgent`. */
export function launchAgentPlist(t: Pick<AutostartTarget, "appId" | "exePath">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(t.appId)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(t.exePath)}</string>
    <string>${AUTOSTART_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

const desktopQuote = (s: string): string => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

/** XDG autostart entry. */
export function xdgAutostartEntry(t: Pick<AutostartTarget, "appName" | "exePath">): string {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${t.appName}
Exec=${desktopQuote(t.exePath)} ${AUTOSTART_ARG}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

export function autostartFilePath(t: Pick<AutostartTarget, "platform" | "home" | "appId">): string | null {
  if (t.platform === "darwin") return join(t.home, "Library", "LaunchAgents", `${t.appId}.plist`);
  if (t.platform === "linux") return join(t.home, ".config", "autostart", `${t.appId}.desktop`);
  return null;
}

/** Enables or disables launch-at-login for the current platform. Throws on I/O errors. */
export function applyAutostart(enabled: boolean, t: AutostartTarget): void {
  if (t.platform === "win32") {
    t.setWindowsLoginItem?.(enabled);
    return;
  }
  const file = autostartFilePath(t);
  if (!file) return;
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, t.platform === "darwin" ? launchAgentPlist(t) : xdgAutostartEntry(t), { mode: 0o644 });
}

/** Skips redundant writes: only acts when the requested value changes. */
export function createAutostartSync(
  target: AutostartTarget,
  log: (level: "info" | "warn", message: string) => void,
  disabled = false
): (enabled: boolean) => void {
  let last: boolean | null = null;
  return (enabled) => {
    if (disabled || last === enabled) return;
    try {
      applyAutostart(enabled, target);
      last = enabled;
      log("info", `autostart ${enabled ? "enabled" : "disabled"}`);
    } catch (err) {
      log("warn", `autostart sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
