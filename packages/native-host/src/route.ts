/**
 * Strict per-install routing for an isolated (candidate) helper.
 *
 * Chrome starts the helper with no DealSonar environment, so a helper installed in a candidate
 * profile's private `<dataDir>/bin/` cannot know that profile's data dir or IPC endpoint (on
 * Windows the candidate pipe is `\\.\pipe\dealsonar-candidate-<user>`, which no default derives).
 * Provisioning therefore writes `<dataDir>/bin/dealsonar-native-host.route.json` beside the helper
 * and the helper reads it at startup.
 *
 * Rules:
 * - No route file next to the helper: nothing changes (production installs, development runs).
 * - The caller set a non-empty `DEALSONAR_DATA_DIR` or `DEALSONAR_IPC_PATH`: the caller's
 *   environment is used as is and the route is ignored. Both values are never mixed.
 * - Otherwise the route supplies `DEALSONAR_DATA_DIR` and `DEALSONAR_IPC_PATH` for this process.
 * - A route that exists but is unreadable, malformed, or does not belong to the directory it sits
 *   in (a copied file) is an error. The helper must not fall back to the production endpoint.
 * - A route is never written for the production data dir or the production endpoint.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEALSONAR_DATA_DIR_ENV,
  DEALSONAR_IPC_PATH_ENV,
  HELPER_ROUTE_FILENAME,
  HELPER_ROUTE_VERSION,
} from "./constants.js";
import {
  currentPlatform,
  defaultDataDir,
  defaultIpcEndpoint,
  type Env,
  type IpcPlatform,
} from "./endpoint.js";

const MAX_ROUTE_BYTES = 64 * 1024;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export interface HelperRoute {
  version: typeof HELPER_ROUTE_VERSION;
  channel: "candidate";
  /** The candidate profile's data dir (`BackendConfig.dataDir`). The helper lives in `<dataDir>/bin`. */
  dataDir: string;
  /** The candidate profile's resolved IPC endpoint (`BackendConfig.ipcEndpoint`). */
  ipcEndpoint: string;
}

export class HelperRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperRouteError";
  }
}

function pathFor(platform: IpcPlatform): path.PlatformPath {
  return platform === "windows" ? path.win32 : path.posix;
}

const nonEmpty = (v: string | undefined | null): v is string => v !== undefined && v !== null && v.trim() !== "";

/** `<dataDir>/bin/dealsonar-native-host.route.json` */
export function helperRoutePath(dataDir: string, platform: IpcPlatform = currentPlatform()): string {
  return pathFor(platform).join(dataDir, "bin", HELPER_ROUTE_FILENAME);
}

/** Absolute, symlink-resolved (when it exists on this host) and, on Windows, case-folded. */
function canonicalPath(value: string, platform: IpcPlatform): string {
  let out = pathFor(platform).resolve(value);
  if (platform === currentPlatform()) {
    try {
      out = fs.realpathSync.native(out);
    } catch {
      /* not created yet */
    }
  }
  return platform === "windows" ? out.toLowerCase() : out;
}

function sameLocation(a: string, b: string, platform: IpcPlatform): boolean {
  return canonicalPath(a, platform) === canonicalPath(b, platform);
}

function validateTarget(dataDir: unknown, ipcEndpoint: unknown, platform: IpcPlatform): asserts dataDir is string {
  if (typeof dataDir !== "string" || dataDir.includes("\0") || !pathFor(platform).isAbsolute(dataDir)) {
    throw new HelperRouteError("route dataDir must be an absolute path");
  }
  if (typeof ipcEndpoint !== "string" || ipcEndpoint === "" || ipcEndpoint.includes("\0")) {
    throw new HelperRouteError("route ipcEndpoint must be a non-empty string");
  }
  if (platform === "windows" && !ipcEndpoint.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX.toLowerCase())) {
    throw new HelperRouteError("route ipcEndpoint must be a named pipe on Windows");
  }
}

export interface CandidateRouteInputs {
  dataDir: string;
  ipcEndpoint: string;
  /** Used only to compute the production defaults the route must not collide with. */
  env?: Env;
  platform?: IpcPlatform;
}

/** Validates and builds the route. Refuses the production data dir and the production endpoint. */
export function buildCandidateRoute(inputs: CandidateRouteInputs): HelperRoute {
  const platform = inputs.platform ?? currentPlatform();
  const env = inputs.env ?? process.env;
  validateTarget(inputs.dataDir, inputs.ipcEndpoint, platform);

  let productionDataDir: string | null = null;
  try {
    productionDataDir = defaultDataDir(env, platform);
  } catch {
    /* cannot resolve the production location: nothing to collide with */
  }
  if (productionDataDir !== null && sameLocation(inputs.dataDir, productionDataDir, platform)) {
    throw new HelperRouteError("refusing to route a helper to the production data dir");
  }
  let productionEndpoint: string | null = null;
  try {
    productionEndpoint = defaultIpcEndpoint(env, platform);
  } catch {
    /* as above */
  }
  const fold = (s: string) => (platform === "windows" ? s.toLowerCase() : s);
  if (productionEndpoint !== null && fold(inputs.ipcEndpoint) === fold(productionEndpoint)) {
    throw new HelperRouteError("refusing to route a helper to the production IPC endpoint");
  }
  return { version: HELPER_ROUTE_VERSION, channel: "candidate", dataDir: inputs.dataDir, ipcEndpoint: inputs.ipcEndpoint };
}

/** Strict parser for the route file contents. */
export function parseHelperRoute(text: string, platform: IpcPlatform = currentPlatform()): HelperRoute {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HelperRouteError("route file is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HelperRouteError("route file must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== HELPER_ROUTE_VERSION) throw new HelperRouteError("unsupported route version");
  if (obj.channel !== "candidate") throw new HelperRouteError("unsupported route channel");
  validateTarget(obj.dataDir, obj.ipcEndpoint, platform);
  return {
    version: HELPER_ROUTE_VERSION,
    channel: "candidate",
    dataDir: obj.dataDir,
    ipcEndpoint: obj.ipcEndpoint as string,
  };
}

export interface WriteRouteResult {
  path: string;
  /** True when the file was created or its content changed. */
  changed: boolean;
}

/** Writes the route into `<dataDir>/bin/` (0600, atomic). Call before installing the helper. */
export function writeCandidateRoute(inputs: CandidateRouteInputs): WriteRouteResult {
  const platform = inputs.platform ?? currentPlatform();
  const route = buildCandidateRoute(inputs);
  const target = helperRoutePath(route.dataDir, platform);
  const content = `${JSON.stringify(route, null, 2)}\n`;
  try {
    if (fs.readFileSync(target, "utf8") === content) return { path: target, changed: false };
  } catch {
    /* absent or unreadable: rewrite */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return { path: target, changed: true };
}

/**
 * Removes a route from `<dataDir>/bin/`. Production provisioning calls this so a leftover
 * candidate route can never redirect a production helper. Returns true when a file was removed.
 */
export function clearHelperRoute(dataDir: string, platform: IpcPlatform = currentPlatform()): boolean {
  const target = helperRoutePath(dataDir, platform);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

export interface ResolveHelperRouteOptions {
  /** The running helper: the SEA executable, or the bundled script in development. */
  helperLocation: string | null | undefined;
  env: Env;
  platform?: IpcPlatform;
}

/**
 * Environment the helper must resolve its endpoint and data dir from. Returns `env` itself (same
 * object) when no route applies. Throws `HelperRouteError` when a route exists but is not valid
 * for the directory it sits in.
 */
export function resolveHelperRoute(options: ResolveHelperRouteOptions): Env {
  const { env, helperLocation } = options;
  const platform = options.platform ?? currentPlatform();
  if (nonEmpty(env[DEALSONAR_DATA_DIR_ENV]) || nonEmpty(env[DEALSONAR_IPC_PATH_ENV])) return env;
  if (!helperLocation) return env;

  const binDir = pathFor(platform).dirname(helperLocation);
  const routeFile = pathFor(platform).join(binDir, HELPER_ROUTE_FILENAME);
  let text: string;
  try {
    const size = fs.statSync(routeFile).size;
    if (size > MAX_ROUTE_BYTES) throw new HelperRouteError("route file is too large");
    text = fs.readFileSync(routeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env;
    if (error instanceof HelperRouteError) throw error;
    throw new HelperRouteError(`route file is unreadable: ${(error as Error).message}`);
  }

  const route = parseHelperRoute(text, platform);
  if (!sameLocation(pathFor(platform).join(route.dataDir, "bin"), binDir, platform)) {
    throw new HelperRouteError("route file does not belong to this helper's directory");
  }
  return { ...env, [DEALSONAR_DATA_DIR_ENV]: route.dataDir, [DEALSONAR_IPC_PATH_ENV]: route.ipcEndpoint };
}
