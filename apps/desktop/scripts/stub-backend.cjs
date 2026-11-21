"use strict";
// Stand-in Backend that speaks the shell<->backend utilityProcess protocol (see src/shared/contract.ts).
// Used by shell tests and by `stage --allow-stub`. It has no database and returns canned data only.
// Runs under Electron `utilityProcess` (process.parentPort) or Node `child_process.fork` (process.send).

const port = process.parentPort || null;

function post(message) {
  if (port) port.postMessage(message);
  else if (process.send) process.send(message);
}

function onMessage(handler) {
  if (port) port.on("message", (e) => handler(e.data));
  else process.on("message", handler);
}

const health = {
  automatic_scanning: true,
  next_crawl_at: null,
  last_crawl_at: null,
  runtime_checked_at: null,
  extension_connected: false,
  extension_version: null,
  facebook_session: "ok",
  crawl_paused: false,
  crawl_pause_reason: null,
  page_loads_last_hour: 0,
  page_loads_today: 0,
  ai_state: "ok",
  ai_provider: null,
  ai_error: null,
  ai_rate_limit_reset_at: null,
  pending_ai_posts: 0,
  telegram_state: "not_configured",
  telegram_channel_count: 0,
  outbox_pending: 0,
  outbox_failed: 0,
  flood_radars: [],
  checked_at: Date.now(),
};

const settings = { launch_at_login: false, onboarding_completed: false, privacy_consent_accepted: false };

const handlers = {
  health_get: () => ({ ...health, checked_at: Date.now() }),
  settings_get: () => settings,
  "backend:toggle_crawl_paused": () => {
    health.crawl_paused = !health.crawl_paused;
    post({ event: "health:changed", payload: { ...health } });
    return { ...health };
  },
  echo: (args) => args,
};

if (process.env.DEALSONAR_STUB_FAIL_START === "1") {
  post({ event: "backend:fatal", payload: { code: "store_error", message: "stub: simulated startup failure" } });
  setTimeout(() => process.exit(3), 10);
} else {
  onMessage((req) => {
    if (!req || typeof req.id !== "number" || typeof req.command !== "string") return;
    if (req.command === "backend:shutdown") {
      post({ id: req.id, ok: true, value: null });
      setTimeout(() => process.exit(0), 20);
      return;
    }
    const fn = handlers[req.command];
    if (!fn) {
      post({ id: req.id, ok: false, error: { code: "stub_backend", message: `stub backend does not implement ${req.command}` } });
      return;
    }
    post({ id: req.id, ok: true, value: fn(req.args || {}) });
  });
  const delay = Number(process.env.DEALSONAR_STUB_READY_DELAY_MS || 0);
  setTimeout(() => {
    post({ event: "backend:ready", payload: { protocol: 1, version: "stub-0" } });
    const crashAfter = Number(process.env.DEALSONAR_STUB_CRASH_AFTER_MS || 0);
    if (crashAfter > 0) setTimeout(() => process.exit(9), crashAfter);
  }, delay);
}
