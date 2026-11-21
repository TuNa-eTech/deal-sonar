import { Menu, Tray, nativeImage } from "electron";
import { formatTrayStatusLabel, type HealthLike } from "./tray-label";

export interface TrayHandlers {
  open(): void;
  /** Resolves with the new health so the label updates immediately. */
  togglePause(): Promise<HealthLike | null>;
  quit(): void;
  log(level: "info" | "warn", message: string): void;
}

export interface DesktopTray {
  setHealth(health: HealthLike | null): void;
  destroy(): void;
}

/** Vietnamese tray menu, ported from `tray.rs::setup_system_tray`. */
export function createTray(iconPath: string, initialHealth: HealthLike | null, handlers: TrayHandlers): DesktopTray {
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`tray icon missing or unreadable: ${iconPath}`);
  if (process.platform === "darwin") icon = icon.resize({ width: 18, height: 18 });
  const tray = new Tray(icon);
  tray.setToolTip("DealSonar");

  let statusLabel = formatTrayStatusLabel(initialHealth);
  const rebuild = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Mở DealSonar", click: () => handlers.open() },
        {
          label: "Tạm dừng / Tiếp tục quét",
          click: () => {
            handlers
              .togglePause()
              .then((h) => {
                if (h) setHealth(h);
              })
              .catch((err: unknown) => handlers.log("warn", `tray toggle_crawl_paused rejected: ${String(err)}`));
          },
        },
        { label: statusLabel, enabled: false },
        { type: "separator" },
        { label: "Thoát DealSonar", click: () => handlers.quit() },
      ])
    );
  };
  const setHealth = (health: HealthLike | null): void => {
    statusLabel = formatTrayStatusLabel(health);
    rebuild();
  };
  rebuild();
  // Left click opens the window; the menu stays on right click (Tauri `show_menu_on_left_click(false)`).
  tray.on("click", () => handlers.open());

  return {
    setHealth,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
