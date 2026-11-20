# @dealsonar/desktop-core

Electron-era backend: a TypeScript port of the Rust crates `store`, `notify` (secrets) and the
`apps/desktop` command/IPC layer, running as the **data owner** inside an Electron `utilityProcess`.
The Rust crates stay in the tree as the behavior oracle until the cutover task.

## Status

| Area | State |
|---|---|
| Store: better-sqlite3, migrations 0001-0003 (byte-identical copies, tested against `crates/store/migrations`), WAL, FKs, `dealsonar_fold_contains`, pre-migration backups (keep 5), online backup, staged restore, purge, delete-all, FTS | ported + tested |
| Store domain: sources/crawl runs, posts (ingest, authors, phones, exact + SimHash dedup, clusters, peer signals, search/pagination), evaluations + pending-AI queue, leads (CRM, events, follow-ups, feedback, labeled data, dynamic filter/sort/FTS list), contacts + blocklist, radars/versions/rulesets/funnel stats, jobs, channels, outbox, AI usage, settings | ported + tested |
| Credential adapters (macOS Keychain, Windows Credential Manager, Linux Secret Service) over the original `DealSonar` entries | ported + unit tested with a fake runner; **not yet exercised against a real OS keychain** |
| utilityProcess entry: `backend:ready/fatal/shutdown/toggle_crawl_paused`, `os:notification`, wire errors, candidate IPC isolation, Host integration seam, `main.cjs` bundle script | ported + tested with fake parentPort/Host |
| **Service layer (`CoreService`) and command handlers** | **not ported**: all 58 commands answer `not_implemented` (`unportedCommands()`) |
| Pipeline T0-T7, rules, preview, scheduler, workers (jobs/outbox/Telegram/health), Protocol v2 handler (`ipc_server.rs`), AI bridge (Codex/Claude/agy), notifications, license, diagnostics, exports, templates | **not ported** |

Nothing returns fabricated data: an unported command fails with `{code:"not_implemented"}`, extension
connections are refused and agent calls are rejected until their handlers exist.

## Layout

```
migrations/            retained SQL (0001-0003), copied verbatim
src/store/             Store + repositories (Rust crates/store)
src/secrets/           SecretStore + OS adapters (Rust crates/notify secrets.rs)
src/backend/           wire contract, server (handshake), runtime (data owner), config, host seam, entry
scripts/build-backend.mjs   esbuild bundle -> dist/backend/{main.cjs,migrations,node_modules/better-sqlite3}
tools/gen-tauri-fixture/    Rust program that writes fixtures + golden JSON with the real Rust store
test/                  vitest suites (see below)
```

## Compatibility notes

- **Numbered SQL parameters (`?1, ?2`)**: better-sqlite3 treats `?N` as a *named* parameter and rejects positional
  arguments. Every connection the store opens goes through `openDatabase()` (`src/store/sqlite.ts`), which rewrites
  `?N` to anonymous `?` once per statement (cached) and re-orders the arguments by placeholder number. Rules, matching
  rusqlite: repeats allowed (`?5, ?5`); holes allowed (an argument whose number is never referenced is ignored);
  the argument count must equal the highest referenced number, else
  `Wrong number of parameters passed to query. Got X, needed Y` (this is what reproduces the Rust dynamic-filter quirk
  below); `?` inside string literals, `"..."`, `` `...` ``, `[...]` and comments is left alone; statements without `?N`
  are passed through unchanged; mixing `?` and `?N` in one statement throws; `stmt.bind()` is unsupported on translated
  statements. The migration SQL files are executed with `db.exec` and are untouched.
  A test fails if any file under `src/` (other than `sqlite.ts`) calls `new Database(`, so a bypassing connection cannot
  slip in. New code that opens a connection must use `openDatabase`.
- **Schema/data dir**: `dealsonar.db`, `backups/`, `ai-workdir/`, `logs/`, `agent-access` under `DEALSONAR_DATA_DIR`.
  The migration list is the Rust one; a database written here opens in Tauri and vice versa
  (`tauri-parity.test.ts` compares `sqlite_master` and runs `integrity_check` / `foreign_key_check`).
- **64-bit SimHash**: `posts.simhash` is read with `safeIntegers` and is a `bigint` in `PostRecord`.
  IPC serialization must convert `bigint -> number` (what the Tauri webview did when parsing the Rust JSON).
- **serde parity**: `NotifyConfig`, `MatchPolicy`, `FieldDef`, `ExtractedField` are re-normalized on read/write (defaults applied,
  unknown keys dropped, struct field order). `BTreeMap` outputs have sorted keys. serde's `1.0` vs JS `1` cannot be told apart;
  tests compare numerically.
- **Known Rust quirk kept on purpose**: a `money`/`range` filter with `op: "in"` and an empty list pushes parameters
  and then returns `0 = 1`, so SQLite rejects the statement. The port reproduces this (an error) instead of silently fixing it.
- `radar_update.language_hint: null` means "keep" (serde `Option<Option<_>>` over JSON), like Tauri.
- Backups at open time use `VACUUM INTO` (synchronous snapshot, runs before the process serves requests);
  runtime `backupDatabase` uses SQLite's online backup API.
- Errors: `CommandError` codes and Vietnamese Display strings follow `commands/error.rs` (`wire.ts`). Every store failure is
  `store_error` / `lỗi cơ sở dữ liệu: ...`. Secret failures carry a `retryable` flag on `SecretError` (locked keychain, cancelled
  prompt, missing Secret Service); the wire shape stays `{code,message}` with code `secret_error`.

## Credential adapters

| OS | Entry written/read |
|---|---|
| macOS | login Keychain generic password, service `DealSonar`, account `<key>`; via `/usr/bin/security` (secret over stdin hex, never argv) |
| Windows | Credential Manager generic credential, `TargetName = <key>.DealSonar`, `UserName = <key>`, UTF-16LE blob, persist enterprise; PowerShell script on stdin |
| Linux | Secret Service item `{service: DealSonar, username: <key>}` via `secret-tool` (lookup ignores the legacy `application=rust-keyring` attribute) |

Keys: `telegram:bot_token`, `telegram:<channel_id>`, `webhook:<channel_id>`. `DEALSONAR_IN_MEMORY_SECRETS=1` selects the in-memory
store for tests. Secrets are never logged: errors pass through `redactSecret`.
Open item: Linux needs `libsecret-tools` (`secret-tool`) on the machine; if absent the adapter reports `unavailable` (retryable).

## Backend <-> shell contract

Implemented as in `apps/desktop-electron/README.md`: `{id,command,args}` -> `{id,ok,value|error}`, pushes `{event,payload}`;
`backend:ready {protocol:1,version}`, `backend:fatal {code,message}` + exit 1, `backend:shutdown {grace_ms}` (drain in-flight up to grace,
close IPC + SQLite, reply, exit 0), `backend:toggle_crawl_paused`, `os:notification {lead_id,radar_name,summary}`.

## Host integration (`@dealsonar/native-host`)

`main.ts` loads the package dynamically and adapts it through `HostBindings` (`host.ts`):
`resolveDesktopDataDir`, `resolveDesktopIpcEndpoint`, `DesktopIpcServer.bind`, `issueAgentToken`, `AgentError`.
Candidate profiles: Protocol v2 connections are closed and agent methods rejected until the corresponding ports exist.
**Windows candidate pipe**: `\\.\pipe\dealsonar-candidate-<user>` (explicit, distinct from Tauri's `dealsonar-<user>`); an explicit
`DEALSONAR_IPC_PATH` still wins. The relay/native helper launched by Chrome does not inherit that env, so Host must make the helper
derive the same pipe for the candidate (open item for the Host task).

## Commands

```sh
pnpm --filter @dealsonar/desktop-core typecheck
pnpm --filter @dealsonar/desktop-core test

# differential fixtures from the real Rust store (needs cargo; synthetic data only):
cargo run --manifest-path packages/desktop-core/tools/gen-tauri-fixture/Cargo.toml -- packages/desktop-core/test/fixtures/tauri
pnpm --filter @dealsonar/desktop-core test -- tauri-parity
# The v1 database is seeded with the current Store API for everything except leads: schema v1 has no
# `leads.read_at`, so its 3 leads (statuses new / contacted / viewed) are inserted with plain 0001-column SQL
# (a second `rusqlite` connection). The v3 database and golden.json come entirely from the current Rust Store.
# Generated outputs (test/fixtures/tauri/*, tools/gen-tauri-fixture/target + Cargo.lock) are gitignored.

# backend bundle with a same-target better-sqlite3 Node-API binding:
pnpm --filter @dealsonar/desktop-core build:backend      # -> dist/backend (point DEALSONAR_BACKEND_BUNDLE_DIR at it)
```

The pnpm workspace needs `packages/*` in `pnpm-workspace.yaml` (root; left to the Shell/coordinator, as is the lockfile).
Tests never touch a real keychain, browser profile, network or the user's data directory.
