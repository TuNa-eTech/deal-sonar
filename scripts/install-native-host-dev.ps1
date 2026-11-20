# Build the `dealsonar-native-host` Node single-executable helper (Node 24) and register Chrome's
# Native Messaging host (`com.dealsonar.host`) for local development on Windows: the manifest
# (`com.dealsonar.host.json`) and the HKCU registry key that points at it.
#
# Usage:
#   .\scripts\install-native-host-dev.ps1 <chrome-extension-id> [--release]
#
# Environment overrides:
#   CHROME_NATIVE_HOSTS_DIR        Override destination directory for com.dealsonar.host.json. While it is
#                                  set, the registry is NOT written unless DEALSONAR_CHROME_REGISTRY_KEY
#                                  names an isolated per-user key (e.g. HKCU\Software\DealSonarTest\dev).
#   DEALSONAR_CHROME_REGISTRY_KEY  Per-user registry key to write instead of the real Chrome key.
#   DEALSONAR_NATIVE_HOST_BIN      Use an already built helper instead of building one.
#
# The work is done by packages/desktop-core/src/tools/install-native-host-dev.ts, which builds the
# helper with packages/native-host/scripts/build-sea.mjs and registers it with the native-host
# provisioning code. Run `pnpm install` once first. Pass --help for the full usage text.
# Arguments are forwarded unchanged (`-Release` is accepted as an alias of `--release`).

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('Error: node not found. Node 24 is required to build the native host helper.')
    exit 1
}

& node (Join-Path $RepoRoot 'packages\desktop-core\scripts\install-native-host-dev.mjs') @args
exit $LASTEXITCODE
