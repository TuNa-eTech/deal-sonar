import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import {
  BACKEND_CONTROL,
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  isRendererEvent,
  type InvokeEnvelope,
  type OsNotificationPayload,
} from "../shared/contract";
import { isInternalUrl } from "../shared/security";
import { APP_INDEX_URL, APP_PREFIX } from "./app-files";
import { AUTOSTART_ARG, createAutostartSync } from "./autostart";
import { BackendClient, BackendError, BackendSupervisor, type BackendChild } from "./backend-client";
import { ExitCoordinator } from "./lifecycle";
import { createLogger } from "./logger";
import { buildBackendEnv, identity, resolveDataDir, resolveResources, resolveUserDataDir } from "./paths";
import { routeInvoke } from "./router";
import { SmokeRecorder, smokeReportPath, type ShutdownInfo } from "./smoke";
import { createTray, type DesktopTray } from "./tray";
import { isMinimizedStartup, type HealthLike } from "./tray-label";
import { createMainWindow, installHardening, registerAppProtocol, registerAppScheme, showAndFocus } from "./window";

const SHUTDOWN_GRACE_MS = 10_000;

// ---- identity & profile isolation (must happen before the single-instance lock) -------------------
registerAppScheme();
app.setName(identity.productName);
app.setPath("userData", resolveUserDataDir(app.getPath("appData")));
if (process.platform === "win32") app.setAppUserModelId(identity.appId);

if (!app.requestSingleInstanceLock()) {
  // `03-desktop.md §2` Step 1: a second launch exits 0 before touching SQLite or the IPC socket.
  app.exit(0);
} else {
  boot().catch((err: unknown) => {
    dialog.showErrorBox("DealSonar không thể khởi động", err instanceof Error ? err.message : String(err));
    app.exit(1);
  });
}

async function boot(): Promise<void> {
  const smokePath = smokeReportPath(process.argv, process.env);
  const smokeHoldMs = Number(process.env.DEALSONAR_SMOKE_HOLD_MS ?? 0) || 0;
  const startMinimized = isMinimizedStartup(process.argv);
  const devUrl = !app.isPackaged ? process.env.DEALSONAR_RENDERER_URL?.trim() || null : null;

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const logger = createLogger(join(dataDir, "logs"));
  const log = (level: "info" | "warn" | "error", m: string): void => logger.log(level, m);
  log("info", `starting ${identity.productName} ${app.getVersion()} (electron ${process.versions.electron}, ${process.platform}/${process.arch}, packaged=${app.isPackaged})`);

  const layout = resolveResources({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectDir: join(__dirname, ".."),
  });

  let mainWindow: BrowserWindow | null = null;
  let tray: DesktopTray | null = null;
  let trayState: { created: boolean; error?: string } = { created: false, error: "not created" };
  let secondInstances = 0;
  let externalOpens = 0;
  let backendVersion: string | undefined;
  let exitCodeOverride: number | null = null;
  let smoke: SmokeRecorder | null = null;

  const allowedPrefixes = [APP_PREFIX, ...(devUrl ? [new URL(devUrl).protocol + "//" + new URL(devUrl).host] : [])];

  // ---- autostart --------------------------------------------------------------------------------
  const smokeOrTest = smokePath !== null || process.env.DEALSONAR_DISABLE_AUTOSTART_SYNC === "1";
  const exePath = process.env.APPIMAGE || process.execPath;
  const syncAutostart = createAutostartSync(
    {
      platform: process.platform,
      home: homedir(),
      exePath,
      appId: identity.appId,
      appName: identity.productName,
      setWindowsLoginItem: (enabled) =>
        app.setLoginItemSettings({ openAtLogin: enabled, path: exePath, args: [AUTOSTART_ARG] }),
    },
    log,
    smokeOrTest
  );

  // ---- external URLs ----------------------------------------------------------------------------
  const openExternal = async (url: URL): Promise<void> => {
    externalOpens += 1;
    if (["1", "true", "TRUE"].includes((process.env.DEALSONAR_DISABLE_BROWSER_SPAWN ?? "").trim())) return;
    await shell.openExternal(url.href);
  };

  // ---- backend ----------------------------------------------------------------------------------
  const recentBackendOutput: string[] = [];
  const remember = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line) recentBackendOutput.push(line.slice(0, 500));
    }
    if (recentBackendOutput.length > 50) recentBackendOutput.splice(0, recentBackendOutput.length - 50);
  };
  const supervisor = new BackendSupervisor({
    log,
    createClient: () =>
      new BackendClient({
        log,
        spawn: (): BackendChild => {
          const child = utilityProcess.fork(layout.backendEntry, [], {
            serviceName: "dealsonar-backend",
            stdio: "pipe",
            env: buildBackendEnv(process.env, {
              dataDir,
              nativeHostBinary: layout.nativeHostBinary,
              appVersion: app.getVersion(),
              electronVersion: process.versions.electron ?? "",
            }),
          });
          child.stdout?.on("data", remember);
          child.stderr?.on("data", remember);
          return {
            postMessage: (m) => child.postMessage(m),
            kill: () => void child.kill(),
            onMessage: (l) => child.on("message", l),
            onExit: (l) => child.on("exit", (code) => l(code)),
          };
        },
      }),
  });

  const sendToRenderer = (event: string, payload: unknown): void => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC_EVENT_CHANNEL, { event, payload });
  };

  const liveNotifications = new Set<Notification>();
  const showOsNotification = (raw: unknown): void => {
    const p = raw as Partial<OsNotificationPayload> | null;
    if (!p || typeof p.radar_name !== "string" || typeof p.summary !== "string") return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `DealSonar — ${p.radar_name}`, body: p.summary });
    liveNotifications.add(n);
    n.on("click", () => showAndFocus(mainWindow));
    n.on("close", () => liveNotifications.delete(n));
    n.show();
  };

  supervisor.onPush((event, payload) => {
    if (event === BACKEND_CONTROL.osNotification) return showOsNotification(payload);
    if (!isRendererEvent(event)) {
      log("warn", `dropped unknown backend event ${event.slice(0, 60)}`);
      return;
    }
    if (event === "health:changed") tray?.setHealth(payload as HealthLike);
    sendToRenderer(event, payload);
  });

  /** After every (re)start: sync autostart with persisted settings and refresh the tray label. */
  const syncFromBackend = async (): Promise<void> => {
    try {
      const settings = (await supervisor.request("settings_get")) as { launch_at_login?: unknown } | null;
      if (typeof settings?.launch_at_login === "boolean") syncAutostart(settings.launch_at_login);
      tray?.setHealth((await supervisor.request("health_get")) as HealthLike);
    } catch (err) {
      log("warn", `post-start sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  supervisor.onReady(() => void syncFromBackend());
  supervisor.onGiveUp((err) => {
    log("error", `${err.code}: ${err.message}`);
    if (smoke) return;
    dialog.showErrorBox("DealSonar dừng hoạt động", `${err.message}\n\nVui lòng mở lại ứng dụng.`);
    void exit.requestQuit(1);
  });

  // ---- shutdown ---------------------------------------------------------------------------------
  const shutdownAll = async (): Promise<void> => {
    const t0 = Date.now();
    tray?.destroy();
    tray = null;
    const r = await supervisor.shutdown(SHUTDOWN_GRACE_MS);
    const info: ShutdownInfo = { ms: Date.now() - t0, clean: r.clean, code: r.code };
    log(r.clean ? "info" : "warn", `backend shutdown clean=${r.clean} code=${String(r.code)} in ${info.ms}ms`);
    if (smoke) exitCodeOverride = smoke.finish(info);
  };
  const exit = new ExitCoordinator(
    shutdownAll,
    (code) => app.exit(exitCodeOverride ?? code),
    SHUTDOWN_GRACE_MS + 5_000,
    (m) => log("warn", m)
  );

  app.on("before-quit", (event) => {
    if (exit.allowExit) return;
    event.preventDefault();
    void exit.requestQuit();
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void exit.requestQuit());
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });
  app.on("activate", () => showAndFocus(mainWindow));
  app.on("second-instance", () => {
    secondInstances += 1;
    showAndFocus(mainWindow);
  });

  // ---- IPC --------------------------------------------------------------------------------------
  const trusted = (e: IpcMainInvokeEvent): boolean => {
    const win = mainWindow;
    const frame = e.senderFrame;
    return (
      !!win &&
      !win.isDestroyed() &&
      e.sender === win.webContents &&
      !!frame &&
      frame === e.sender.mainFrame &&
      isInternalUrl(frame.url, allowedPrefixes)
    );
  };
  ipcMain.handle(IPC_INVOKE_CHANNEL, async (e, cmd: unknown, args: unknown): Promise<InvokeEnvelope> => {
    if (!trusted(e)) {
      log("warn", "rejected IPC from untrusted sender");
      return { ok: false, error: { code: "forbidden_sender", message: "Nguồn gửi lệnh không hợp lệ" } };
    }
    return routeInvoke(
      {
        backend: supervisor,
        openExternal,
        onSettings: (s) => {
          const v = (s as { launch_at_login?: unknown } | null)?.launch_at_login;
          if (typeof v === "boolean") syncAutostart(v);
        },
        pickBackupFile: async () => {
          const opts = {
            properties: ["openFile" as const],
            filters: [{ name: "Bản sao SQLite", extensions: ["sqlite3", "sqlite", "db"] }],
          };
          const r = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
          return r.canceled ? null : (r.filePaths[0] ?? null);
        },
      },
      cmd,
      args
    );
  });

  // ---- startup ----------------------------------------------------------------------------------
  await app.whenReady();
  installHardening({ allowedPrefixes, openExternal: (u) => void openExternal(u).catch((err: unknown) => log("warn", `openExternal failed: ${String(err)}`)), log });
  if (!devUrl) registerAppProtocol(layout.uiDir);
  if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate()));
  else Menu.setApplicationMenu(null);

  if (smokePath) {
    smoke = new SmokeRecorder({
      reportPath: smokePath,
      layout,
      identity,
      runtime: {
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        electron: process.versions.electron ?? "",
        node: process.versions.node,
        execPath: process.execPath,
        dataDir,
        userDataDir: app.getPath("userData"),
      },
      tray: { get created() { return trayState.created; }, get error() { return trayState.error; } },
      secondInstanceCount: () => secondInstances,
      externalOpenAttempts: () => externalOpens,
    });
    // Watchdog: a hung smoke run must fail, not block CI.
    setTimeout(() => {
      if (!exit.shuttingDown) {
        exitCodeOverride = smoke?.fail("smoke timed out") ?? 1;
        void exit.requestQuit(1);
      }
    }, 120_000).unref();
  }

  if (!existsSync(layout.backendEntry)) {
    return failStartup(`Không tìm thấy dịch vụ nền: ${layout.backendEntry}`);
  }
  try {
    const ready = await supervisor.start();
    backendVersion = ready.version;
    log("info", `backend ready protocol=${ready.protocol} version=${ready.version ?? "?"}`);
  } catch (err) {
    const be = err instanceof BackendError ? err : new BackendError("backend_spawn_failed", String(err));
    log("error", `backend failed to start: ${be.code}: ${be.message}`);
    for (const line of recentBackendOutput.slice(-10)) log("warn", `[backend] ${line}`);
    return failStartup(`${be.message} (${be.code})`);
  }

  mainWindow = createMainWindow({
    preloadPath: join(__dirname, "preload.cjs"),
    url: devUrl ?? APP_INDEX_URL,
    startMinimized,
    devTools: !app.isPackaged || process.env.DEALSONAR_DEVTOOLS === "1",
    allowClose: () => exit.shuttingDown,
  });
  mainWindow.on("session-end", () => void exit.requestQuit());

  try {
    tray = createTray(layout.trayIcon, null, {
      open: () => showAndFocus(mainWindow),
      togglePause: () => supervisor.request<HealthLike>(BACKEND_CONTROL.toggleCrawlPaused),
      quit: () => void exit.requestQuit(),
      log,
    });
    trayState = { created: true };
    void syncFromBackend();
  } catch (err) {
    trayState = { created: false, error: err instanceof Error ? err.message : String(err) };
    log("warn", `tray unavailable: ${trayState.error}`);
  }

  const rec = smoke;
  if (rec) {
    rec.attach(mainWindow, backendVersion);
    mainWindow.webContents.once("did-finish-load", () => {
      void (async () => {
        await rec.runChecks();
        rec.markReady();
        if (smokeHoldMs > 0) await new Promise((r) => setTimeout(r, smokeHoldMs));
        await exit.requestQuit();
      })().catch((err: unknown) => {
        exitCodeOverride = rec.fail(err instanceof Error ? err.message : String(err));
        void exit.requestQuit(1);
      });
    });
  }

  async function failStartup(message: string): Promise<void> {
    if (smoke) {
      exitCodeOverride = smoke.fail(message);
    } else {
      dialog.showErrorBox("DealSonar không thể khởi động", message);
    }
    void exit.requestQuit(1);
  }
}

function macMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
