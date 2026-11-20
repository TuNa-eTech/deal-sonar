import { useEffect, useRef } from "react";

/** Single-letter shortcuts must never fire while the user is typing or a dialog owns the keyboard. */
export function shouldIgnoreHotkey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  return typeof document !== "undefined" && document.querySelector('[role="dialog"]') !== null;
}

/**
 * Binds a key → action map to the window. The map is read through a ref, so callers can
 * rebuild it every render without re-subscribing.
 */
export function useHotkeys(enabled: boolean, keys: Record<string, () => void>) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreHotkey(e)) return;
      const action = ref.current[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
