/**
 * Chrome native-host provisioning (port of `chrome_connect` / `refresh_native_host_manifest_if_paired`
 * minus persistence: the backend owns the settings table and passes/receives the stored extension id).
 *
 * macOS/Linux: manifest file(s). Windows: manifest file + HKCU registry key.
 *
 * Isolation for tests/dev: pass `manifestPath` (never touches the default Chrome location and
 * skips secondary browsers), and on Windows an isolated `registry.keyPath` under
 * `HKCU\Software\DealSonarTest\…`. Provisioning must never be run from development against the
 * real default Chrome profile locations.
 */
import { currentPlatform, type Env, type IpcPlatform } from "./endpoint.js";
import {
  buildManifest,
  chromeManifestPath,
  computeAllowedOrigins,
  readManifestFile,
  secondaryChromiumManifestPaths,
  stripOriginWrapper,
  verifyOrWriteManifest,
  type NativeHostManifest,
} from "./manifest.js";
import { ensureNativeHostRegistration, type RegistryOptions } from "./registry.js";

export interface ProvisionOptions {
  /** Absolute path of the stable installed helper (`stableHelperPath`). */
  helperPath: string;
  /** Override manifest location (`chrome_manifest_path` config). Disables secondary browsers. */
  manifestPath?: string | null;
  explicitExtensionId?: string | null;
  /** Current `chrome.extension_id` setting. */
  storedExtensionId?: string | null;
  discoveredDevIds?: readonly string[];
  env?: Env;
  platform?: IpcPlatform;
  /** Windows registry options; pass `null` to skip registry writes. */
  registry?: RegistryOptions | null;
}

export interface ProvisionResult {
  /** True when the primary manifest is present and current after the call. */
  nativeHostInstalled: boolean;
  manifestPath: string;
  manifest: NativeHostManifest;
  /** True when the primary manifest file was created/updated. */
  manifestChanged: boolean;
  /** Clean extension id the backend should persist as `chrome.extension_id`. */
  extensionIdToStore: string | null;
  registryUpdated: boolean;
  secondaryManifestPaths: string[];
}

export class NotPairedError extends Error {
  constructor() {
    super("Chrome has not been paired yet");
    this.name = "NotPairedError";
  }
}

async function provision(options: ProvisionOptions, mode: "connect" | "refresh"): Promise<ProvisionResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const manifestPath = options.manifestPath ?? chromeManifestPath(env, platform);
  const existing = readManifestFile(manifestPath);
  const stored = options.storedExtensionId?.trim() ? options.storedExtensionId : null;

  if (mode === "refresh" && stored === null && existing === null) throw new NotPairedError();

  const origins = computeAllowedOrigins({
    explicitExtensionId: mode === "connect" ? options.explicitExtensionId : null,
    storedExtensionId: stored,
    existingManifest: existing,
    discoveredDevIds: options.discoveredDevIds,
  });
  const manifest = buildManifest(origins, options.helperPath);

  let manifestChanged = false;
  let nativeHostInstalled = true;
  try {
    manifestChanged = verifyOrWriteManifest(manifestPath, manifest);
  } catch (error) {
    if (mode === "refresh") throw error;
    nativeHostInstalled = false;
  }

  const secondaryManifestPaths: string[] = [];
  if (!options.manifestPath) {
    for (const extra of secondaryChromiumManifestPaths(env, platform)) {
      try {
        verifyOrWriteManifest(extra, manifest);
        secondaryManifestPaths.push(extra);
      } catch {
        /* best effort, as in Rust */
      }
    }
  }

  let registryUpdated = false;
  if (platform === "windows" && options.registry !== null && nativeHostInstalled) {
    try {
      registryUpdated = await ensureNativeHostRegistration(manifestPath, options.registry ?? {});
    } catch (error) {
      if (mode === "refresh") throw error;
      nativeHostInstalled = false;
    }
  }

  const first = manifest.allowed_origins[0];
  return {
    nativeHostInstalled,
    manifestPath,
    manifest,
    manifestChanged,
    extensionIdToStore: first ? stripOriginWrapper(first) : null,
    registryUpdated,
    secondaryManifestPaths,
  };
}

/** `chrome_connect`: always provisions; write failures report `nativeHostInstalled: false`. */
export function connectChrome(options: ProvisionOptions): Promise<ProvisionResult> {
  return provision(options, "connect");
}

/**
 * Startup refresh after an app update/move: rewrites the manifest when Chrome was previously
 * paired (stored id or existing manifest). Throws `NotPairedError` otherwise; callers map that
 * to "unchanged".
 */
export function refreshChromeIfPaired(options: ProvisionOptions): Promise<ProvisionResult> {
  return provision(options, "refresh");
}
