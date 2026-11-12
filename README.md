# DealSonar

A Chrome extension and a Rust desktop app that run on the user's machine and talk to each other locally — no backend.

## Layout

```
apps/
  desktop/        Rust desktop app (binary: dealsonar)
  extension/      Chrome extension (MV3, TypeScript, Vite)
crates/
  protocol/       Shared message types (Rust). TS mirror: apps/extension/src/protocol.ts
  native-host/    Chrome Native Messaging host (stdio <-> desktop app)
scripts/          Dev helpers (native host manifest install, etc.)
docs/             Product and technical specs (Vietnamese) — start at docs/README.md
```

## Docs

The full product and technical specification lives in [docs/](docs/README.md): PRD, radar spec, architecture and ADRs, protocol, extension, desktop, data model, pipeline and rules, AI bridge, notifications, roadmap, validation plan, and risks.

## How the two sides talk

```
extension --(Native Messaging, stdio)--> native-host --(local IPC, TODO)--> desktop app
```

Chrome extensions cannot open a channel to a local app directly; Native Messaging is the supported no-server route. Alternative to evaluate later: a localhost WebSocket served by the desktop app.

## Setup

Requires Rust (stable, pinned via `rust-toolchain.toml`), Node >= 22, pnpm 9.

```bash
pnpm install
cargo check --workspace
pnpm ext:build      # output: apps/extension/dist (load unpacked in chrome://extensions)
```
