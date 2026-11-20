#!/usr/bin/env bash
# Build the `dealsonar-native-host` Node single-executable helper (Node 24) and install Chrome's
# NativeMessagingHosts manifest (`com.dealsonar.host.json`) for local development on macOS or Linux.
#
# Usage:
#   ./scripts/install-native-host-dev.sh <chrome-extension-id> [--release]
#
# Environment overrides:
#   CHROME_NATIVE_HOSTS_DIR     Override destination directory for com.dealsonar.host.json
#                               (nothing outside it is written; no other browser is registered)
#   DEALSONAR_NATIVE_HOST_BIN   Use an already built helper instead of building one
#
# The work is done by packages/desktop-core/src/tools/install-native-host-dev.ts, which builds the
# helper with packages/native-host/scripts/build-sea.mjs and registers it with the native-host
# provisioning code. Run `pnpm install` once first. Run `./scripts/install-native-host-dev.sh --help`
# for the full usage text.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found. Node 24 is required to build the native host helper." >&2
  exit 1
fi

exec node "$REPO_ROOT/packages/desktop-core/scripts/install-native-host-dev.mjs" "$@"
