import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

export const APP_SCHEME = "dealsonar-app";
export const APP_HOST = "app";
export const APP_PREFIX = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_PREFIX}/index.html`;

/**
 * Maps `dealsonar-app://app/<path>` to a file under `uiDir`. Rejects other hosts/schemes and
 * traversal; extension-less paths fall back to `index.html` so a reload on `/` works.
 */
export function resolveAppFile(uiDir: string, requestUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const root = resolve(uiDir);
  const file = resolve(root, normalize(rel).replace(/^([/\\])+/, "") || "index.html");
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (extname(file) === "") return join(root, "index.html");
  return null;
}
