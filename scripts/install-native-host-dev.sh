#!/usr/bin/env bash
# Build `dealsonar-native-host` and install Chrome's NativeMessagingHosts
# manifest (`com.dealsonar.host.json`) for local development on macOS or Linux.
#
# Usage:
#   ./scripts/install-native-host-dev.sh <chrome-extension-id> [--release]
#
# Environment overrides:
#   CHROME_NATIVE_HOSTS_DIR  Override destination directory for com.dealsonar.host.json

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/install-native-host-dev.sh <chrome-extension-id> [--release]

Builds `dealsonar-native-host` and writes `com.dealsonar.host.json` to Chrome's
user-level NativeMessagingHosts directory on macOS or Linux.

Arguments:
  <chrome-extension-id>  Extension ID from chrome://extensions (e.g. abcdefghijklmnopabcdefghijklmnop)
  --release              Build release binary instead of debug binary

Environment:
  CHROME_NATIVE_HOSTS_DIR  Optional custom output directory override
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

EXT_ID=""
PROFILE="debug"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --release)
      PROFILE="release"
      ;;
    -*)
      echo "Error: unknown flag '$arg'" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$EXT_ID" ]]; then
        echo "Error: unexpected positional argument '$arg'" >&2
        usage >&2
        exit 1
      fi
      EXT_ID="$arg"
      ;;
  esac
done

# Strip optional chrome-extension:// prefix and trailing slash if pasted directly.
EXT_ID="${EXT_ID#chrome-extension://}"
EXT_ID="${EXT_ID%/}"

if [[ -z "$EXT_ID" || ! "$EXT_ID" =~ ^[a-zA-Z0-9]+$ ]]; then
  echo "Error: invalid Chrome extension ID '$EXT_ID' (expected alphanumeric ID)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${CHROME_NATIVE_HOSTS_DIR:-}" ]]; then
  TARGET_DIR="$CHROME_NATIVE_HOSTS_DIR"
else
  case "$(uname -s)" in
    Darwin)
      TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      ;;
    Linux)
      CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
      TARGET_DIR="$CONFIG_BASE/google-chrome/NativeMessagingHosts"
      ;;
    *)
      echo "Error: unsupported OS '$(uname -s)'. This script supports macOS and Linux." >&2
      exit 1
      ;;
  esac
fi

echo "Building dealsonar-native-host ($PROFILE)..."
if [[ "$PROFILE" == "release" ]]; then
  cargo build --manifest-path "$REPO_ROOT/Cargo.toml" -p dealsonar-native-host --release
else
  cargo build --manifest-path "$REPO_ROOT/Cargo.toml" -p dealsonar-native-host
fi

TARGET_TRIPLE_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
BIN_PATH="$TARGET_TRIPLE_DIR/$PROFILE/dealsonar-native-host"

if [[ ! -x "$BIN_PATH" ]]; then
  echo "Error: expected executable not found at '$BIN_PATH'" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
MANIFEST_PATH="$TARGET_DIR/com.dealsonar.host.json"

cat >"$MANIFEST_PATH" <<EOF
{
  "name": "com.dealsonar.host",
  "description": "DealSonar native host",
  "path": "$BIN_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "Installed Native Messaging manifest:"
echo "  Manifest: $MANIFEST_PATH"
echo "  Binary:   $BIN_PATH"
echo "  Origin:   chrome-extension://$EXT_ID/"
