# DealSonar

**DealSonar** is a 100% local-first lead discovery & CRM desktop system for Vietnamese and multilingual Facebook Groups — combining a Manifest V3 Chrome Extension, a stateless Native Messaging relay, and a Rust + Tauri v2 Desktop App with local SQLite FTS5 storage, deterministic Vietnamese rule engines, CLI-based AI extraction (`claude`, `codex`, `agy`), and instant Telegram / Webhook / OS notifications. No cloud backend is required.

---

## Architecture Overview

```text
┌───────────────────────────┐   4-byte LE JSON frames    ┌───────────────────────────┐
│     Chrome Extension      │ ◄─────── stdio ──────────► │   dealsonar-native-host   │
│  (MV3: Network + DOM +    │   com.dealsonar.host       │  (Stateless Frame Relay)  │
│   Safety Rate Limiter)    │                            └─────────────┬─────────────┘
└───────────────────────────┘                                          │
                                                           Unix Socket / Named Pipe
                                                             (0700 / Per-User ACL)
                                                                       │
┌──────────────────────────────────────────────────────────────────────▼─────────────┐
│                        DealSonar Desktop App (`dealsonar`)                         │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ Tauri v2 Shell (`apps/desktop`): React 18 UI, System Tray, Single-Instance,  │  │
│  │ Autostart, Strict CSP, Safe Permalink Opener, 55 IPC Commands & Push Events  │  │
│  └──────────────────────────────────────┬───────────────────────────────────────┘  │
│                                         ▼                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ `dealsonar-core`: Multi-Profile IPC Server, Pipeline T0–T7, Crawl Scheduler, │  │
│  │ Streaming Preview, Shadow/Active Ruleset Lifecycle, Ed25519 Plan Limits      │  │
│  └──────┬──────────────────────┬───────────────────────┬────────────────────────┘  │
│         ▼                      ▼                       ▼                           │
│  `dealsonar-store`      `dealsonar-rules`      `dealsonar-ai-bridge`               │
│  SQLite WAL + FTS5 +    VN Text Folding,       Isolated CLI Subprocesses           │
│  SimHash + Contacts     Phones, Money, DSL     (`claude` / `codex` / `agy` / mock) │
│                                                        │                           │
│                                                        ▼                           │
│                                                `dealsonar-notify`                  │
│                                                OS Keychain, Telegram HTML Bot,     │
│                                                Signed HMAC Webhooks, CSV & XLSX    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Repository Layout

```text
apps/
  desktop/               Tauri v2 Rust desktop shell (`dealsonar` binary + `dealsonar_desktop` lib)
    capabilities/        Minimal Tauri v2 capability permissions (`core`, `notification`, `autostart`)
    icons/               RGBA PNG, macOS `.icns`, and Windows `.ico` bundle & tray icons
    src/                 Lifecycle, Vietnamese system tray, logging, URL security, 55 IPC commands
    templates/           7 built-in Radar JSON templates (BĐS, Tuyển dụng, Dịch vụ, Xe cũ, B2B, ...)
    tests/               UI <-> Desktop contract suite & real binary-to-binary E2E suite
    ui/                  React 18 + TypeScript + Vite Vietnamese desktop interface
  extension/             Chrome Manifest V3 extension (GraphQL/Comet network tap, DOM fallback, native side panel)
crates/
  protocol/              Protocol v2 envelopes, 4-byte LE framing, Unix/NamedPipe IPC, Native Host manifest
  native-host/           `dealsonar-native-host` stdio <-> local IPC relay binary
  rules/                 Vietnamese normalization, phone/price/area/location extractors & DSL v1 engine
  store/                 SQLite (WAL + FTS5) storage, migrations, SimHash dedup, CRM leads, jobs & outbox
  ai-bridge/             Sandboxed CLI adapters (`claude`, `codex`, `agy`), PII redaction & `eval` runner
  notify/                OS Keyring secret store, Telegram Bot client, HMAC-SHA256 webhooks, CSV/XLSX export
  core/                  Central `CoreService` orchestrating T0–T7 pipeline, scheduler, licensing & health
docs/                    Complete product & technical specifications (`docs/README.md`) + golden eval suite
scripts/                 Developer helpers (`install-native-host-dev.sh`, `verify-protocol-fixtures.mjs`)
```

---

## Prerequisites & Setup

- **Rust**: Toolchain pinned via [`rust-toolchain.toml`](rust-toolchain.toml) (`1.83.0` compatible)
- **Node.js**: `>= 22`
- **pnpm**: `9.12.3` (`corepack enable`)
- **Optional AI CLI** (for live AI extraction): Claude Code (`claude`), OpenAI Codex (`codex`), or Antigravity (`agy`)

Install workspace dependencies and build the UI + Extension bundles:

```bash
pnpm install --frozen-lockfile
pnpm ui:build
pnpm ext:build
cargo build --workspace
```

---

## Running & Pairing DealSonar Locally

### 1. Start the Desktop App

```bash
# Build frontend assets and launch the Tauri v2 desktop shell
pnpm ui:build
pnpm desktop
```

For hot-reload UI development in a browser (backed by deterministic mock state) or alongside Tauri:

```bash
pnpm ui:dev
```

Startup flags supported by the `dealsonar` binary:
- `--minimized` / `--autostart`: boots silently into the system tray without opening the main window.
- `DEALSONAR_DATA_DIR=/custom/path`: overrides the OS data directory (`~/Library/Application Support/DealSonar` on macOS, `%APPDATA%\DealSonar` on Windows, `~/.local/share/dealsonar` on Linux).

### 2. Load & Pair the Chrome Extension + Native Messaging Host

1. Build the extension (`pnpm ext:build`) and open `chrome://extensions` in Google Chrome / Brave / Edge.
2. Enable **Developer mode**, click **Load unpacked**, and select `apps/extension/dist`.
3. Copy the 32-character **Extension ID** shown on the card and register the Native Messaging Host manifest for that unpacked ID:
   ```bash
   ./scripts/install-native-host-dev.sh <YOUR_32_CHAR_EXTENSION_ID>
   ```
4. In the DealSonar Desktop App, click **Kiểm tra lại** in **Onboarding — Bước 1: Kết nối Chrome Extension** (or verify connection status in **Sức khoẻ**).
   - DealSonar preserves your paired `chrome-extension://<ID>/` origin in `com.dealsonar.host.json` and automatically refreshes the `dealsonar-native-host` binary path on future app updates (`refresh_native_host_manifest_if_paired`).

5. Click the DealSonar toolbar icon to open the **side panel** beside Facebook. After updating an unpacked install, click **Reload** on its `chrome://extensions` card first.
   - Select the current Facebook group or a group from the Desktop crawl plan, then click **Quét ngay**. Each click scans one group. Expand **Tùy chọn quét** to set **1–100 posts** (default 30), **0–5 scroll steps** (default 3), and choose **Đọc tab hiện tại** or **Quét bằng tab nền**. Preferences save automatically in this browser profile and persist across panel/browser restarts. Current-tab mode requires the selected group in the active tab and never scrolls; background mode always opens its own temporary tab, scrolls up to the chosen limit, then closes it. Scans can stop early when encountering known posts, session issues, or the execution deadline.
   - Automatic scanning is **off by default**, including the first upgrade to the side panel. Turn on **Quét tự động** to use the Desktop plan. This preference persists across browser restarts; Facebook session checks, safety pauses, and load limits apply to manual scans too.
   - The panel updates when you switch tabs and shows scan progress, the latest result, queued posts, and connection status. DealSonar Desktop must be running and connected for scanning.

---

## Scripts & Quality Gates

| Command | Description |
|---|---|
| `pnpm ui:dev` | Start Vite dev server for `apps/desktop/ui` (`http://localhost:5173`) |
| `pnpm ui:build` | Typecheck and build production UI bundle into `apps/desktop/ui/dist` |
| `pnpm ui:test` | Run Vitest unit, flow, template, and XSS/permalink security tests for UI |
| `pnpm ext:build` | Build Chrome MV3 extension into `apps/extension/dist` |
| `pnpm ext:test` | Run Vitest extractor, scheduler, budget, and protocol tests for Extension |
| `pnpm protocol:verify` | Verify cross-language Rust ↔ TypeScript Protocol v2 golden fixtures |
| `pnpm eval:bds` | Run Golden Evaluation benchmark on Vietnamese Real Estate (`bds.jsonl`) |
| `pnpm lint` | Run TypeScript typechecks (`extension` + `desktop-ui`), `cargo clippy -D warnings`, and `cargo fmt --check` |
| `pnpm test` | Run all Extension tests, Desktop UI tests, protocol fixture checks, and `cargo test --workspace` |

### Full Verification Checklist

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --filter @dealsonar/extension typecheck && pnpm --filter @dealsonar/extension test && pnpm --filter @dealsonar/extension build
pnpm --filter @dealsonar/desktop-ui typecheck && pnpm --filter @dealsonar/desktop-ui test && pnpm --filter @dealsonar/desktop-ui build
```

---

## Security & Privacy Highlights

- **Strict WebView Isolation**: Content Security Policy blocks all remote scripts, frames, and network origins (`connect-src ipc: http://ipc.localhost`). Post text is rendered exclusively as plain text + `<mark>` slices (`dangerouslySetInnerHTML` is banned by automated tests).
- **Safe Permalink Opener**: Both UI and Rust WebView navigation/command guards strictly allow opening only `https://www.facebook.com/`, `https://m.facebook.com/`, `https://web.facebook.com/`, and `https://t.me/<bot>` in the OS default browser.
- **Zero Plaintext Secrets**: Telegram bot tokens and HMAC webhook secrets are stored in the OS Keychain (`KeyringSecretStore`), never in SQLite or logs. Diagnostic `.zip` bundles scrub tokens, secrets, phone numbers, and post bodies before export.
- **Data Retention & Logs**: Rotating JSON logs in `<data_dir>/logs/` are automatically pruned after 7 days, and unmatched posts are purged per configurable retention (`unmatched_retention_days`).
