// Console diagnostics, visible in the service worker, side panel and Facebook tab consoles.
export function dsLog(...args: unknown[]): void {
  try { console.info("[DealSonar]", ...args); } catch { /* console unavailable */ }
}
export function dsWarn(...args: unknown[]): void {
  try { console.warn("[DealSonar]", ...args); } catch { /* console unavailable */ }
}
