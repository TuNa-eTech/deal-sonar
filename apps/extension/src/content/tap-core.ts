// Strictly passive, read-only network response tap (`02-extension.md §4.1` & P1 safety).
// NEVER modifies requests or responses, and NEVER initiates network calls.

import {
  TAP_CONFIG_SOURCE,
  TAP_MESSAGE_SOURCE,
  type TapWindowMessage,
} from "../messages";

export const DEFAULT_TAP_URL_PATTERNS: readonly string[] = [
  "/api/graphql/",
  "/ajax/bz",
];

const MAX_TAPPED_BODY_CHARS = 16 * 1024 * 1024;
const installedWindows = new WeakSet< object >();

export function matchesTapUrl(url: string, patterns: readonly string[]): boolean {
  if (!url) return false;
  for (const pattern of patterns) {
    if (pattern && url.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function resolveTargetOrigin(win: Window): string {
  try {
    const origin = win.location?.origin;
    if (origin && origin !== "null" && origin.startsWith("http")) {
      return origin;
    }
  } catch {
    // Ignore cross-origin / sandbox edge cases
  }
  return "*";
}

function extractRequestUrl(input: unknown): string {
  try {
    if (typeof input === "string") return input;
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    if (typeof input === "object" && input !== null && "url" in input) {
      const maybeUrl = (input as { url?: unknown }).url;
      if (typeof maybeUrl === "string") return maybeUrl;
    }
  } catch {
    // Ignore
  }
  return "";
}

export type TapController = {
  getPatterns: () => string[];
  uninstall: () => void;
};

export function installNetworkTap(
  win: Window & typeof globalThis,
  initialPatterns: readonly string[] = DEFAULT_TAP_URL_PATTERNS,
): TapController {
  let urlPatterns = initialPatterns.filter((p) => typeof p === "string" && p.length > 0);
  if (urlPatterns.length === 0) {
    urlPatterns = [...DEFAULT_TAP_URL_PATTERNS];
  }

  if (installedWindows.has(win)) {
    return {
      getPatterns: () => [...urlPatterns],
      uninstall: () => {},
    };
  }
  installedWindows.add(win);

  const onConfigMessage = (event: MessageEvent): void => {
    try {
      if (event.source !== win) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== TAP_CONFIG_SOURCE) return;
      if (!Array.isArray(data.url_patterns)) return;
      const cleaned = data.url_patterns.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      if (cleaned.length > 0) {
        urlPatterns = cleaned;
      }
    } catch {
      // Ignore malformed window messages
    }
  };

  win.addEventListener("message", onConfigMessage);

  const originalFetch = win.fetch;
  if (typeof originalFetch === "function") {
    const wrappedFetch = function (
      this: unknown,
      ...args: Parameters<typeof fetch>
    ): Promise<Response> {
      const responsePromise = Reflect.apply(originalFetch, this, args) as Promise<Response>;
      try {
        const reqUrl = extractRequestUrl(args[0]);
        if (matchesTapUrl(reqUrl, urlPatterns)) {
          responsePromise.then(
            (response) => {
              try {
                if (!response || typeof response.clone !== "function") return;
                const cloned = response.clone();
                cloned
                  .text()
                  .then((body) => {
                    if (!body || body.length > MAX_TAPPED_BODY_CHARS) return;
                    const payload: TapWindowMessage = {
                      source: TAP_MESSAGE_SOURCE,
                      url: reqUrl,
                      body,
                      ts: Date.now(),
                    };
                    win.postMessage(payload, resolveTargetOrigin(win));
                  })
                  .catch(() => {
                    // Never surface tap stream read errors to host page
                  });
              } catch {
                // Never surface clone errors to host page
              }
            },
            () => {
              // Caller handles original fetch rejection
            },
          );
        }
      } catch {
        // Never interfere with host fetch
      }
      return responsePromise;
    };

    win.fetch = wrappedFetch as typeof fetch;
  }

  const XhrProto = win.XMLHttpRequest?.prototype;
  const originalXhrOpen = XhrProto?.open;
  const originalXhrSend = XhrProto?.send;
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();

  if (XhrProto && typeof originalXhrOpen === "function" && typeof originalXhrSend === "function") {
    XhrProto.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      try {
        const urlStr = typeof url === "string" ? url : String(url);
        xhrUrls.set(this, urlStr);
      } catch {
        // Ignore
      }
      return Reflect.apply(originalXhrOpen, this, [method, url, ...rest]) as void;
    } as typeof XMLHttpRequest.prototype.open;

    XhrProto.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      try {
        const trackedUrl = xhrUrls.get(this);
        if (trackedUrl && matchesTapUrl(trackedUrl, urlPatterns)) {
          this.addEventListener(
            "load",
            () => {
              try {
                if (this.responseType !== "" && this.responseType !== "text") return;
                const responseText = this.responseText;
                if (!responseText || responseText.length > MAX_TAPPED_BODY_CHARS) return;
                const payload: TapWindowMessage = {
                  source: TAP_MESSAGE_SOURCE,
                  url: trackedUrl,
                  body: responseText,
                  ts: Date.now(),
                };
                win.postMessage(payload, resolveTargetOrigin(win));
              } catch {
                // Never interfere with host XHR listeners
              }
            },
            { passive: true },
          );
        }
      } catch {
        // Never interfere with host XHR send
      }
      return Reflect.apply(originalXhrSend, this, [body]) as void;
    };
  }

  return {
    getPatterns: () => [...urlPatterns],
    uninstall: () => {
      win.removeEventListener("message", onConfigMessage);
      if (typeof originalFetch === "function") {
        win.fetch = originalFetch;
      }
      if (XhrProto && typeof originalXhrOpen === "function" && typeof originalXhrSend === "function") {
        XhrProto.open = originalXhrOpen;
        XhrProto.send = originalXhrSend;
      }
      installedWindows.delete(win);
    },
  };
}
