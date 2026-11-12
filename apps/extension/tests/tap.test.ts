import { afterEach, describe, expect, it, vi } from "vitest";
import { installNetworkTap, type TapController } from "../src/content/tap-core";
import { TAP_CONFIG_SOURCE, TAP_MESSAGE_SOURCE, type TapWindowMessage } from "../src/messages";

describe("MAIN world passive network tap (P1 safety)", () => {
  let controller: TapController | null = null;

  afterEach(() => {
    controller?.uninstall();
    controller = null;
  });

  it("passively clones matching fetch responses without mutating request/response or initiating extra requests", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ url, method: init?.method ?? "GET", data: { ok: true } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const originalFetch = window.fetch;
    window.fetch = fetchSpy as unknown as typeof fetch;

    const captured: TapWindowMessage[] = [];
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.source === TAP_MESSAGE_SOURCE) {
        captured.push(ev.data as TapWindowMessage);
      }
    };
    window.addEventListener("message", onMsg);

    try {
      controller = installNetworkTap(window);
      // Zero network calls initiated on install
      expect(fetchSpy).toHaveBeenCalledTimes(0);

      // 1. Matching GraphQL URL -> cloned and forwarded, caller still reads full response body untouched
      const res1 = await window.fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        body: "fb_dtsg=redacted",
      });
      const callerJson = await res1.json();
      expect(callerJson.data.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2. Non-matching URL -> NOT cloned or forwarded
      const res2 = await window.fetch("https://www.facebook.com/images/logo.png");
      await res2.text();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Wait for async postMessage dispatch in JSDOM
      await new Promise((r) => setTimeout(r, 30));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("https://www.facebook.com/api/graphql/");
      expect(captured[0]?.body).toContain('"ok":true');

      // 3. Dynamic URL pattern update via same-window MessageEvent (`event.source === window`)
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { source: TAP_CONFIG_SOURCE, url_patterns: ["/custom/feed_endpoint"] },
        }),
      );
      expect(controller.getPatterns()).toEqual(["/custom/feed_endpoint"]);

      // Cross-frame MessageEvent (`source: null`) MUST be ignored
      window.dispatchEvent(
        new MessageEvent("message", {
          source: null,
          data: { source: TAP_CONFIG_SOURCE, url_patterns: ["/evil"] },
        }),
      );
      expect(controller.getPatterns()).toEqual(["/custom/feed_endpoint"]);
    } finally {
      window.removeEventListener("message", onMsg);
      controller?.uninstall();
      controller = null;
      window.fetch = originalFetch;
    }
  });

  it("passively clones matching XMLHttpRequest text responses without adding instance properties", async () => {
    const captured: TapWindowMessage[] = [];
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.source === TAP_MESSAGE_SOURCE) {
        captured.push(ev.data as TapWindowMessage);
      }
    };
    window.addEventListener("message", onMsg);

    const OriginalOpen = XMLHttpRequest.prototype.open;
    const OriginalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () {};
    XMLHttpRequest.prototype.send = function () {
      Object.defineProperty(this, "responseText", {
        configurable: true,
        value: '{"data":{"__typename":"Story"}}',
      });
      this.dispatchEvent(new Event("load"));
    };

    try {
      controller = installNetworkTap(window);

      const xhr = new XMLHttpRequest();
      expect(Object.keys(xhr)).toEqual([]); // WeakMap used; zero enumerable mutations!
      xhr.open("POST", "https://www.facebook.com/ajax/bz");
      expect(Object.keys(xhr)).toEqual([]);
      xhr.send("payload=1");

      const nonMatchingXhr = new XMLHttpRequest();
      nonMatchingXhr.open("GET", "https://www.facebook.com/favicon.ico");
      nonMatchingXhr.send();

      await new Promise((r) => setTimeout(r, 25));
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("https://www.facebook.com/ajax/bz");
      expect(captured[0]?.body).toContain('"__typename":"Story"');
    } finally {
      window.removeEventListener("message", onMsg);
      controller?.uninstall();
      controller = null;
      XMLHttpRequest.prototype.open = OriginalOpen;
      XMLHttpRequest.prototype.send = OriginalSend;
    }
  });
});
