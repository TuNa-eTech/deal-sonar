# @dealsonar/native-host

Standalone Native Messaging relay for the Electron app. It preserves Protocol v2, framing limits (64 MiB ext->host, 1 MiB host->ext),
`desktop_unavailable` replies, 5 s reconnect, `DEALSONAR_IPC_PATH` / `DEALSONAR_DATA_DIR`
overrides, the pinned extension id and `allowed_origins` merge rules are unchanged.

## What is in here

| Area | Module |
| --- | --- |
| Frame codec (bounded, incremental) | `src/framing.ts` |
| Relay (stdio <-> IPC, reconnect, backpressure) | `src/relay.ts` |
| Client/server local socket / named pipe | `src/ipc.ts` (`DesktopIpcServer`, `connectIpc`) |
| MCP stdio server (4 tools) | `src/mcp.ts`, `src/agent-client.ts` |
| Agent token + request validation | `src/agent-protocol.ts` |
| Manifest, allowed origins, Windows registry | `src/manifest.ts`, `src/registry.ts`, `src/provision.ts` |
| Stable per-user helper install | `src/install-helper.ts` |
| Executable entry | `src/main.ts` -> `scripts/build-sea.mjs` (Node 24 SEA) |

## Interfaces for the backend (business logic stays there)

- `DesktopIpcServer.bind({ endpoint, agentToken, agentBackend, onExtensionConnection })`
  - `onExtensionConnection(conn)`: `conn.onFrame(buf)`, `conn.sendEnvelope(obj)`, `conn.sendFrame(buf)`,
    `pause()/resume()`, `onClose()`. Parse/dispatch Protocol v2 envelopes in the backend.
  - `agentBackend.handle(method, args)`: implement the four agent methods; throw `AgentError(message)` for
    user-facing errors (use `validationMessage()` for the Rust `Validation` prefix).
- `issueAgentToken(dataDir)` creates `<dataDir>/agent-access` (0600, atomic) at desktop startup.
- `connectChrome()` / `refreshChromeIfPaired()` return `extensionIdToStore` for the `chrome.extension_id` setting.
- `installHelper({ sourcePath, destPath: stableHelperPath(dataDir) })` copies the packaged SEA binary
  (shipped outside ASAR, path from `DEALSONAR_NATIVE_HOST_SRC` in the shell stage) to
  `<dataDir>/bin/dealsonar-native-host[.exe]`; the resulting path is what the manifest and MCP client config use
  (`DEALSONAR_NATIVE_HOST_BIN`). `mcpClientConfig(path)` returns `{ command, args: ["--mcp"] }`.

## Same-user safeguards

Unix: socket dir forced to 0700 and must be owned by the user, socket and lock 0600, clients refuse sockets not
owned by the current user, active listeners are never replaced, agent token file must be a 0600 regular file owned
by the user, token compared in constant time. Windows: per-user pipe name, libuv first-instance/no-remote pipe
creation; the agent token is the authorization layer. Limitation: Node cannot read pipe peer credentials.

Upgrade compatibility (Unix): the legacy Tauri app holds `<endpoint>.lock` as a Unix datagram socket, which Node
cannot probe safely. Electron therefore uses its own stream lock at `<endpoint>.e`, rejects a live (or non-socket)
endpoint before creating or removing anything, never touches a legacy `.lock`, and on close removes only the
endpoint/lock inodes it created. Both the endpoint and `<endpoint>.e` are checked against the OS socket path limit.

## Isolation rules for tests / development

Never register against a live Chrome profile. Tests use temp HOME/data dirs and endpoints. Chrome smoke registers
only in a throwaway `--user-data-dir` (macOS/Linux). Windows registry tests only use `HKCU\Software\DealSonarTest\...`;
`removeNativeHostRegistration` refuses the real key. `pnpm --filter @dealsonar/native-host smoke:chrome` needs
`CHROME_BIN` (Chrome for Testing/Chromium) and a built `apps/extension/dist`.

## Commands (run under Node >= 22; SEA build needs Node 24)

```sh
pnpm --filter @dealsonar/native-host typecheck
pnpm --filter @dealsonar/native-host test
node packages/native-host/scripts/build-sea.mjs --target darwin-arm64 [--base-node <node24 of target>]
DEALSONAR_NATIVE_HOST_TEST_BIN=<built binary> pnpm --filter @dealsonar/native-host test -- binary
```

The workspace file needs `packages/*` added (root, left to the shell/coordinator). Fixture tests read
`crates/protocol/tests/fixtures/protocol_v2_examples.json` and skip if it is gone after cutover.
