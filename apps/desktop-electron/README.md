# @dealsonar/desktop-electron

Electron shell for DealSonar (candidate identity). It owns the window, tray, dialogs, notifications,
autostart, single-instance lock, URL/IPC allowlisting and the lifecycle of the Backend `utilityProcess`.
The Rust/Tauri shell in `apps/desktop` stays as the behavior oracle until cutover; nothing here edits it.

## Layout

| Path | Role |
|---|---|
| `src/shared/contract.ts` | Command IDs, push events, channel names, backend protocol types. Tested against `apps/desktop/src/lib.rs` and `ui/src/lib/api.ts`. |
| `src/shared/security.ts` | Port of `security.rs` (`validate_safe_external_url`), same messages. |
| `src/main/main.ts` | Boot order, wiring, quit paths. |
| `src/main/backend-client.ts` | `BackendClient` (one child: handshake, request/reply, pushes, shutdown) and `BackendSupervisor` (restart, crash-loop give-up). |
| `src/main/router.ts` | Renderer command routing, args validation, error mapping. |
| `src/main/window.ts` | `dealsonar-app://app/` protocol, CSP, window and navigation/permission hardening. |
| `src/main/{tray,autostart,lifecycle,logger,paths,smoke}.ts` | Tray, launch-at-login, graceful exit, logs, profile/resource paths, installer smoke self-test. |
| `src/preload/index.ts` | `window.dealsonarDesktop` = `{shell, invoke, onEvent}` only. |
| `scripts/stub-backend.cjs` | Marked stand-in backend that speaks the protocol. For shell/installer tests only. |
| `scripts/stage.mjs` | Builds `stage/` (ui, backend, native-host, icons) for `extraResources`. |
| `scripts/smoke/run-smoke.mjs` | Install-and-launch smoke for one target on the current OS. |

## Compatibility contracts kept

- 58 backend command IDs + `backup_pick_file`, `open_external_url` (shell-owned). Args are one JSON object, results are the Tauri result values.
- Errors: Tauri rejected with a plain string. The Electron transport rejects with `DesktopCommandError` whose `String(err)` and `.message` are that string and `.code` is the `CommandError` code (`unknown_command`, `validation_error`, `blocked_external_url`, `browser_open_failed`, `file_picker_failed`, `shutting_down`, `not_found`, ...). Shell-level codes: `forbidden_sender`, `backend_unavailable`, `backend_exited`, `backend_timeout`.
- Push events: `lead:new lead:reminder lead:updated preview:progress radar:draft-created health:changed crawl:finished job:failed`.
- Env names from Rust: `DEALSONAR_DATA_DIR`, `DEALSONAR_NATIVE_HOST_BIN`, `DEALSONAR_DISABLE_BROWSER_SPAWN`. SQLite schema and Browser Protocol v2 are untouched (shell does not read either).

## Backend handshake (needs Backend task to implement)

Entry: `<resources>/backend/main.cjs` (outside ASAR), started with `utilityProcess.fork(entry, [], {env, stdio: "pipe"})`.
Messages use `process.parentPort`:

```
shell -> backend   { id: number, command: string, args: object }
backend -> shell   { id, ok: true, value } | { id, ok: false, error: { code, message } }
backend -> shell   { event: string, payload: any }          // push
```

Startup: env carries `DEALSONAR_DATA_DIR`, `DEALSONAR_NATIVE_HOST_BIN`, `DEALSONAR_SHELL=electron`, `DEALSONAR_APP_VERSION`, `DEALSONAR_ELECTRON_VERSION`, `DEALSONAR_CHANNEL=candidate`.
Backend opens SQLite, binds its IPC socket/pipe, starts workers, then pushes `backend:ready` `{protocol: 1, version?}`.
On unrecoverable startup failure it pushes `backend:fatal` `{code, message}` and exits non-zero. Shell waits 30s, then kills.

Shutdown: shell sends request `backend:shutdown` `{grace_ms: 10000}`. Backend stops accepting work, drains in-flight AI calls up to `grace_ms`, closes IPC, flushes logs, replies `ok`, exits 0. Shell force-kills after `grace_ms + 2s`. Requests during shutdown are rejected with `shutting_down`.

Control commands the backend must implement besides the 58: `backend:shutdown`, `backend:toggle_crawl_paused` (tray; replies with `HealthStatus`).
Pushes the shell consumes: the 8 renderer events above (forwarded), and `os:notification` `{lead_id, radar_name, summary}` (replaces Rust `OsNotificationHook`; shell shows the OS notification, not forwarded to the renderer).
The shell syncs launch-at-login from `settings_get` / `settings_set` results (`launch_at_login`) and refreshes the tray from `health_get` / `health:changed`.

Crash policy: unexpected exit after ready restarts the backend (500ms x n backoff); more than 3 exits in 60s shows an error and quits.

## Native helper

`<resources>/native-host/dealsonar-native-host[.exe]`, a real executable outside ASAR (`extraResources`). The shell passes the path as `DEALSONAR_NATIVE_HOST_BIN`; the backend uses it for the Chrome Native Messaging manifest exactly like `state.rs::resolve_native_host_binary_path` did. Staged from `DEALSONAR_NATIVE_HOST_SRC`.

## Identity and isolation

`config/identity.json`: app id `com.dealsonar.desktop.electron-candidate`, product `DealSonar Candidate`, data dir `DealSonar Candidate` (mac/win) or `dealsonar-candidate` (linux), Chromium profile `<appData>/<appId>`. It does not touch production data, login item, tray or single-instance lock. Production release config is not edited.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm electron:test                 # unit + integration tests (stub backend over real child processes)
pnpm electron:typecheck
pnpm ui:build && pnpm electron:build
pnpm --filter @dealsonar/desktop-electron stage:stub   # or stage with DEALSONAR_BACKEND_BUNDLE_DIR / DEALSONAR_NATIVE_HOST_SRC
pnpm --filter @dealsonar/desktop-electron start        # dev run; DEALSONAR_RENDERER_URL=http://localhost:1420 to use Vite

# one target per OS:
pnpm --filter @dealsonar/desktop-electron dist:mac-arm64   # macOS arm64 DMG (ad-hoc)
pnpm --filter @dealsonar/desktop-electron dist:mac-x64     # macOS x64 DMG   (build on Intel or arm64+Rosetta)
pnpm --filter @dealsonar/desktop-electron dist:win-x64     # Windows NSIS (unsigned)
pnpm --filter @dealsonar/desktop-electron dist:linux-x64   # DEB + AppImage

node scripts/smoke/run-smoke.mjs --mode installed --artifact release/<file> [--system-install]
```

Smoke runs with a temporary home, data directory and Chromium profile. It uses in-memory credentials and disables autostart sync and browser launch. It
records: resources outside ASAR, native helper executable, backend handshake, renderer isolation (no `require`/`process`),
IPC round trip, unknown-command and external-URL rejection, `window.open`/navigation guards, tray, single-instance
second launch, graceful shutdown (SIGTERM; in-app hold timer on Windows), and for macOS the ad-hoc signature.
The result is written to `release/smoke/smoke-<platform>-<arch>-<mode>.json`. Stub-backed runs report `backend_kind: "stub"`. The manual GitHub Actions workflow builds the SQLite backend and the Node 24 native helper on each target by default.

## Known limits

- macOS tray: with a context menu set, a left click opens the menu (the Tauri build showed the window on left click).
- Linux tray needs a StatusNotifier host; headless CI reports it but does not require it.
- `deb` smoke without `--system-install` extracts and runs with `--no-sandbox`; AppImage smoke needs `--no-sandbox` on CI.
- Gatekeeper first-launch and SmartScreen prompts are not exercised by automation.
