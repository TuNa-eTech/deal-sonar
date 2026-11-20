/** Registered Chrome Native Messaging host identifier (`crates/protocol` NATIVE_HOST_NAME). */
export const NATIVE_HOST_NAME = "com.dealsonar.host";
export const NATIVE_HOST_DESCRIPTION = "DealSonar native host";
export const NATIVE_HOST_MANIFEST_FILENAME = "com.dealsonar.host.json";
/** Windows registry key whose default value is the manifest path (`03-desktop.md §2.2`). */
export const WINDOWS_CHROME_REGISTRY_KEY =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dealsonar.host";

/** Executable file base name of the standalone helper. */
export const HELPER_BASENAME = "dealsonar-native-host";

/** Protocol v2 (`docs/specs/01-protocol.md`). */
export const PROTOCOL_VERSION = 2;
/** Max frame host/desktop -> extension: 1 MiB. */
export const MAX_HOST_TO_EXT_BYTES = 1_048_576;
/** Max frame extension -> host/desktop: 64 MiB. */
export const MAX_EXT_TO_HOST_BYTES = 67_108_864;
export const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;

export const DESKTOP_UNAVAILABLE_MESSAGE =
  "DealSonar desktop app is not running or local IPC is unavailable";

/** Deterministic MV3 `manifest.json` "key" extension ID. Must never change. */
export const DEFAULT_CHROME_EXTENSION_ID = "hkmjpcenjjebhpjicnbpmogidfcbmbjn";
export const LEGACY_PLACEHOLDER_EXTENSION_ID = "dealsonarchromeextensionid000001";
/** Settings table key storing the paired Chrome extension ID. */
export const CHROME_EXTENSION_ID_SETTING_KEY = "chrome.extension_id";

export const DEALSONAR_IPC_PATH_ENV = "DEALSONAR_IPC_PATH";
export const DEALSONAR_DATA_DIR_ENV = "DEALSONAR_DATA_DIR";

/**
 * Per-install routing file written next to an isolated (candidate) helper, in
 * `<dataDir>/bin/`. Chrome launches the helper without backend env, so this is the only way an
 * isolated install can reach its own data dir and IPC endpoint. Production installs have none.
 */
export const HELPER_ROUTE_FILENAME = "dealsonar-native-host.route.json";
export const HELPER_ROUTE_VERSION = 1;

/** Local agent (MCP) request format shared with the desktop backend. */
export const AGENT_FRAME_PREFIX = Buffer.from("DealSonarAgent/1\n", "utf8");
export const AGENT_MAX_FRAME_BYTES = 1024 * 1024;
export const AGENT_TOKEN_FILE = "agent-access";
export const AGENT_TOKEN_BYTES = 32;
export const AGENT_TIMEOUT_MS = 15_000;

/** Reported by the MCP `initialize` response (`serverInfo.version`). */
export const HOST_VERSION = "0.1.0";
