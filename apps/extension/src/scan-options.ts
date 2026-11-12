// Shared bounds for the sidebar, durable preferences and manual crawl admission.
export const MAX_QUICK_SCAN_POSTS = 100;
export const MAX_QUICK_SCAN_SCROLLS = 5;

export type QuickScanOptions = {
  mode: "current_tab" | "background";
  maxPosts: number;
  maxScrollSteps: number;
};

export const DEFAULT_QUICK_SCAN_OPTIONS: Readonly<QuickScanOptions> = {
  mode: "current_tab", maxPosts: 30, maxScrollSteps: 3,
};

export function isQuickScanOptions(value: unknown): value is QuickScanOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as QuickScanOptions;
  return (options.mode === "current_tab" || options.mode === "background") &&
    Number.isInteger(options.maxPosts) && options.maxPosts >= 1 && options.maxPosts <= MAX_QUICK_SCAN_POSTS &&
    Number.isInteger(options.maxScrollSteps) && options.maxScrollSteps >= 0 && options.maxScrollSteps <= MAX_QUICK_SCAN_SCROLLS;
}

export function restoreQuickScanOptions(value: unknown): QuickScanOptions {
  return isQuickScanOptions(value) ? {
    mode: value.mode, maxPosts: value.maxPosts, maxScrollSteps: value.maxScrollSteps,
  } : { ...DEFAULT_QUICK_SCAN_OPTIONS };
}
