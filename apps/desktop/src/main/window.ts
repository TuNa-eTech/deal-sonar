import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, net, protocol, session, type WebContents } from "electron";
import { isInternalUrl, validateSafeExternalUrl } from "../shared/security";
import { APP_SCHEME, resolveAppFile } from "./app-files";

/** Same policy as `tauri.conf.json`, minus the Tauri `ipc:` endpoints the Electron bridge does not use. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function registerAppProtocol(uiDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(uiDir, request.url);
    if (!file) return new Response("Not found", { status: 404 });
    const upstream = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers();
    headers.set("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    headers.set("Content-Security-Policy", CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

export interface HardeningOptions {
  /** `protocol//host` prefixes that count as the app itself. */
  allowedPrefixes: readonly string[];
  openExternal: (url: URL) => void;
  log: (level: "info" | "warn", message: string) => void;
}

/**
 * Applies to every WebContents ever created: no window.open, no off-app navigation, no <webview>,
 * no permission grants. Safe Facebook/Telegram links are routed to the OS browser instead.
 */
export function installHardening(opts: HardeningOptions): void {
  const routeExternal = (url: string): void => {
    const check = validateSafeExternalUrl(url);
    if (check.ok) opts.openExternal(check.url);
    else opts.log("warn", `blocked untrusted navigation (${safeHost(url)})`);
  };

  const deny = session.defaultSession;
  deny.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  deny.setPermissionCheckHandler(() => false);
  deny.setDevicePermissionHandler(() => false);

  app.on("web-contents-created", (_e, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      routeExternal(url);
      return { action: "deny" };
    });
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isInternalUrl(url, opts.allowedPrefixes)) return;
      event.preventDefault();
      routeExternal(url);
    };
    contents.on("will-navigate", (event, url) => guard(event, url));
    contents.on("will-redirect", (event, url) => guard(event, url));
    contents.on("will-frame-navigate", (event) => guard(event, event.url));
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || "<none>";
  } catch {
    return "<invalid>";
  }
}

export interface MainWindowOptions {
  preloadPath: string;
  url: string;
  startMinimized: boolean;
  devTools: boolean;
  /** Return true to let the close proceed (quitting); otherwise the window hides to tray. */
  allowClose: () => boolean;
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    title: "DealSonar",
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    center: true,
    resizable: true,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: opts.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: opts.devTools,
    },
  });
  win.once("ready-to-show", () => {
    if (!opts.startMinimized) {
      win.show();
      win.focus();
    }
  });
  // Hide-on-close (`03-desktop.md §2`): closing the window hides to tray instead of quitting.
  win.on("close", (event) => {
    if (opts.allowClose()) return;
    event.preventDefault();
    win.hide();
  });
  void win.loadURL(opts.url);
  return win;
}

export function showAndFocus(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
