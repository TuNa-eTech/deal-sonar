import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiProvider, AiRequest, AiResponse, ProbeResult, ProviderId } from "../src/ai";
import { AiError, probeSmokeSchema } from "../src/ai";
import { webhookChannelKey, TELEGRAM_BOT_TOKEN_KEY } from "../src/secrets/types";
import {
  INTEGRATION_COMMAND_IDS,
  INTEGRATION_HANDLERS,
  LicenseSigner,
  aiBackoffUntil,
  computeHealthStatus,
  configureIntegrations,
  defaultSettings,
  flushDigestForRadar,
  deliverSingleOutboxItem,
  getAiBridge,
  getIntegrations,
  pollTelegramOnce,
  processDueOutboxBatch,
  routeLeadNotifications,
  runAiTask,
  startIntegrationWorkers,
  startIntegrations,
  shutdownIntegrations,
  type IntegrationHooks,
  type RouteLeadNotificationsInput,
} from "../src/services/integrations";
import { verifyWebhookSignature } from "../src/notify";
import { Store } from "../src/store/store";
import {
  T0,
  fd,
  makeCtx,
  seedLead,
  seedRadar,
  startMockServer,
  unzip,
  waitFor,
  type MockServer,
  type TestCtx,
} from "./integrations-helpers";

const DAY = 86_400_000;
const signer = new LicenseSigner(Buffer.alloc(32, 7));
const proToken = (now = Date.now()) =>
  signer.sign({ plan: "pro", licensee: "Công ty BĐS Minh Tâm", issued_at: now - DAY, expires_at: now + 30 * DAY });

let t: TestCtx;
let servers: MockServer[] = [];
beforeEach(() => {
  t = makeCtx();
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  t.cleanup();
});

const mock = async (): Promise<MockServer> => {
  const s = await startMockServer();
  servers.push(s);
  return s;
};
const call = (name: string, args: Record<string, unknown> = {}): Promise<any> =>
  Promise.resolve(INTEGRATION_HANDLERS[name]!(t.ctx, args));
const configure = (over: Parameters<typeof configureIntegrations>[1] = {}) =>
  configureIntegrations(t.ctx, { licenseVerifier: signer.verifier(), ...over });

describe("handler table", () => {
  it("covers exactly the 18 assigned backend commands", () => {
    expect(Object.keys(INTEGRATION_HANDLERS).sort()).toEqual([...INTEGRATION_COMMAND_IDS].sort());
    expect(INTEGRATION_COMMAND_IDS).toHaveLength(18);
  });

  it("refuses mutating commands while shutting down", async () => {
    t.setShuttingDown(true);
    await expect(call("settings_set", { patch: {} })).rejects.toMatchObject({ code: "shutting_down" });
    await expect(call("data_delete_all", { confirm_phrase: "xoa toan bo" })).rejects.toMatchObject({ code: "shutting_down" });
    await expect(call("webhook_add", { name: "n", url: "https://x.test" })).rejects.toMatchObject({ code: "shutting_down" });
  });
});

describe("settings and AI provider selection", () => {
  it("returns defaults, applies the max(1) floors and persists", async () => {
    configure();
    expect(await call("settings_get")).toEqual(defaultSettings());
    const updated = await call("settings_set", {
      patch: {
        daily_ai_post_cap: 0,
        digest_interval_minutes: 0,
        unmatched_retention_days: 0,
        quiet_hours_enabled: true,
        quiet_hours: { from: "21:00", to: "05:00" },
        launch_at_login: false,
        crawl_policy: { group_interval_minutes: 0, max_posts_per_visit: 10, active_hours: { from: "08:00", to: "20:00" }, only_when_idle: true },
        ai_provider: "codex_cli",
      },
    });
    expect(updated).toMatchObject({
      daily_ai_post_cap: 1,
      digest_interval_minutes: 1,
      unmatched_retention_days: 1,
      quiet_hours_enabled: true,
      quiet_hours: { from: "21:00", to: "05:00" },
      launch_at_login: false,
      ai_provider: "codex_cli",
      crawl_policy: {
        group_interval_minutes: 1,
        priority_interval_minutes: 5,
        max_posts_per_visit: 10,
        only_when_idle: true,
        active_hours: { from: "08:00", to: "20:00" },
      },
    });
    expect(await call("settings_get")).toEqual(updated);
    expect(getAiBridge(t.ctx).providerId()).toBe("codex_cli");
    expect(t.events.some((e) => e.event === "health:changed")).toBe(true);

    expect(await call("settings_set", { patch: { ai_provider: null } })).toMatchObject({ ai_provider: null });
    // model_tiers replaces the whole map, like the Rust patch
    const tiers = await call("settings_set", { patch: { model_tiers: { agy_cli: { fast: "a", smart: "b" } } } });
    expect(tiers.model_tiers).toEqual({ agy_cli: { fast: "a", smart: "b" } });
  });

  it("reports serde-style argument errors and pushes config/login-item changes through hooks", async () => {
    const calls: string[] = [];
    configure({
      hooks: {
        bumpAndPushConfig: () => calls.push("bump"),
        onLaunchAtLoginChanged: (_c, enabled) => calls.push(`login:${enabled}`),
      },
    });
    await expect(call("settings_set", { patch: { daily_ai_post_cap: "x" } })).rejects.toMatchObject({
      code: "validation_error",
      message: "tham số 'patch' không hợp lệ: invalid type: string \"x\", expected u32",
    });
    await expect(call("settings_set", {})).rejects.toMatchObject({ code: "validation_error", message: "thiếu tham số 'patch'" });
    await expect(call("settings_set", { patch: { quiet_hours: { from: "1" } } })).rejects.toMatchObject({
      message: "tham số 'patch' không hợp lệ: missing field `to`",
    });
    await expect(call("ai_set_provider", { provider: "gpt" })).rejects.toMatchObject({
      code: "validation_error",
      message: "tham số 'provider' không hợp lệ: unknown variant `gpt`, expected one of `claude_cli`, `codex_cli`, `agy_cli`",
    });
    await call("settings_set", { patch: { launch_at_login: true, crawl_policy: { group_interval_minutes: 9 } } });
    expect(calls).toEqual(["bump", "login:true"]);
    await call("settings_set", { patch: { daily_ai_post_cap: 5 } });
    expect(calls).toHaveLength(2);
  });

  it("selects a provider, resets AI error state and probes with local model rebalancing", async () => {
    const models = [
      { id: "haiku", label: "haiku", recommended_tier: "fast" as const, source: "local_cli" },
      { id: "opus", label: "opus", recommended_tier: "smart" as const, source: "local_cli" },
    ];
    const fake = fakeProvider("claude_cli", async () => {
      throw new Error("unused");
    });
    fake.probe = async (): Promise<ProbeResult> => ({
      installed: true,
      version: "claude 2.1.319",
      authenticated: true,
      flags_supported: true,
      latency_ms: 12,
      error: null,
      available_models: models,
    });
    const state = configure({ aiProvider: fake });
    state.aiHealth.lastError = "old";
    state.aiHealth.firstUnavailableAt = 5;

    const probe = await call("ai_probe", { provider: "claude_cli" });
    expect(Object.keys(probe)).toEqual(["claude_cli"]);
    expect(probe.claude_cli).toMatchObject({
      provider: "claude_cli",
      binary_name: "claude",
      installed: true,
      authenticated: true,
      latency_ms: 12,
      install_hint: "npm install -g @anthropic-ai/claude-code",
      login_command: "claude login",
      recommended_fast_model: "haiku",
      recommended_smart_model: "opus",
    });
    expect(probe.claude_cli.available_models[1]).toEqual({ id: "opus", label: "opus", recommended_tier: "smart", source: "local_cli" });
    // the default `sonnet` is not installed locally, so the saved tier moves to the discovered model
    expect((await call("settings_get")).model_tiers.claude_cli).toEqual({ fast: "haiku", smart: "opus" });

    const set = await call("ai_set_provider", { provider: "agy_cli", model_tiers: { fast: "f", smart: "s" } });
    expect(set).toMatchObject({ ai_provider: "agy_cli" });
    expect(set.model_tiers.agy_cli).toEqual({ fast: "f", smart: "s" });
    expect(state.aiHealth).toMatchObject({ lastError: null, firstUnavailableAt: null });
    expect(getAiBridge(t.ctx).providerId()).toBe("agy_cli");
  });

  it("aggregates AI usage per day with escalation percentages", async () => {
    configure();
    const now = Date.now();
    t.store.aiCalls.record({ provider: "claude_cli", task: "judge_extract", item_count: 7, input_tokens: 100, output_tokens: 20, cost_usd: 0.5, duration_ms: 10, status: "ok", now_ms: now });
    t.store.aiCalls.record({ provider: "claude_cli", task: "judge_extract", item_count: 3, duration_ms: 10, status: "error", error: "x", now_ms: now });
    const usage = await call("ai_usage_get", { days: 2 });
    expect(usage).toMatchObject({ today_items: 10, daily_cap: 2000, total_calls: 2, total_items: 10, total_input_tokens: 100, total_output_tokens: 20, total_cost_usd: 0.5 });
    expect(usage.daily).toHaveLength(2);
    expect(usage.daily[0]).toMatchObject({ calls: 0, cost_usd: null, ai_escalation_pct: 0 });
    expect(usage.daily[1]).toMatchObject({ calls: 2, items: 10, cost_usd: 0.5 });
    expect((await call("ai_usage_get")).daily).toHaveLength(7);
  });
});

function fakeProvider(id: ProviderId, complete: (req: AiRequest) => Promise<AiResponse>): AiProvider & { probe(): Promise<ProbeResult> } {
  return {
    id: () => id,
    probe: async () => ({ installed: true, version: null, authenticated: true, flags_supported: true, latency_ms: 1, error: null, available_models: [] }),
    complete,
  };
}

describe("AI task hooks", () => {
  const req = (): AiRequest => ({ task: "judge_extract", system: "s", prompt: "p", schema: probeSmokeSchema(), tier: "fast", timeoutMs: 1000 });

  it("accounts calls, tracks rate limits/errors in health and recovers", async () => {
    let mode: "ok" | "rate" | "fail" | "bad" = "ok";
    const provider = fakeProvider("claude_cli", async () => {
      if (mode === "rate") throw AiError.rateLimited(30_000);
      if (mode === "fail") throw AiError.process(2, "boom");
      return { output: mode === "bad" ? {} : { ok: true }, usage: { input_tokens: 4, output_tokens: 2, cost_usd: 0.25 }, model: "m", durationMs: 5 };
    });
    configure({ aiProvider: provider });
    await call("settings_set", { patch: { ai_provider: "claude_cli" } });
    getAiBridge(t.ctx).setProvider(provider); // settings_set swapped in the real CLI adapter

    const ok = await runAiTask(t.ctx, req(), { radarVersionId: "rv", itemCount: 3 });
    expect(ok.output).toEqual({ ok: true });
    expect(t.store.aiCalls.countItemsToday(Date.now())).toBe(3);
    expect((await computeHealthStatus(t.ctx, Date.now())).ai_state).toBe("ok");

    mode = "rate";
    const before = Date.now();
    await expect(runAiTask(t.ctx, req())).rejects.toMatchObject({ code: "ai_error" });
    expect((await computeHealthStatus(t.ctx, Date.now())).ai_state).toBe("rate_limited");
    const until = aiBackoffUntil(t.ctx, Date.now());
    expect(until).not.toBeNull();
    expect(until! - before).toBeGreaterThanOrEqual(29_000);
    expect(until! - before).toBeLessThan(40_000);

    getIntegrations(t.ctx).aiHealth.rateLimitResetAt = null;
    mode = "fail";
    await expect(runAiTask(t.ctx, req())).rejects.toMatchObject({ message: expect.stringContaining("lỗi AI Bridge:") });
    const failed = await computeHealthStatus(t.ctx, Date.now());
    expect(failed).toMatchObject({ ai_state: "error", ai_provider: "claude_cli" });
    expect(failed.ai_error).toContain("mã lỗi 2: boom");

    mode = "bad"; // invalid output twice: both attempts are recorded
    const calls0 = (t.store.db.prepare("SELECT COUNT(*) AS c FROM ai_calls").get() as { c: number }).c;
    await expect(runAiTask(t.ctx, req())).rejects.toMatchObject({ code: "ai_error" });
    expect((t.store.db.prepare("SELECT COUNT(*) AS c FROM ai_calls").get() as { c: number }).c).toBe(calls0 + 2);
    expect(t.store.db.prepare("SELECT status FROM ai_calls ORDER BY created_at DESC, id DESC LIMIT 1").get()).toEqual({ status: "invalid_output" });

    mode = "ok";
    await runAiTask(t.ctx, req());
    expect(await computeHealthStatus(t.ctx, Date.now())).toMatchObject({ ai_state: "ok", ai_error: null });
  });

  it("waits for in-flight AI calls at shutdown", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    configure({
      aiProvider: fakeProvider("claude_cli", async () => {
        await gate;
        return { output: { ok: true }, usage: null, model: null, durationMs: 1 };
      }),
    });
    const running = runAiTask(t.ctx, req());
    await waitFor(() => getIntegrations(t.ctx).inflightAiCalls === 1);
    let done = false;
    const shutdown = shutdownIntegrations(t.ctx).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false);
    release();
    await running;
    await shutdown;
    expect(done).toBe(true);
  });
});

describe("license", () => {
  it("verifies Ed25519 tokens, rejects tampering and reports expiry as personal", async () => {
    configure();
    expect(await call("license_get")).toEqual({
      plan: "personal",
      licensee: null,
      issued_at: null,
      expires_at: null,
      is_valid: true,
      key_preview: null,
      limits: { max_active_radars: 2, max_followed_groups: 10, max_fields_per_radar: 12, allow_xlsx_export: false, allow_webhooks: false, allow_auto_rulesets: false },
    });

    const token = proToken();
    const status = await call("license_set", { license_key: `  ${token}\n` });
    expect(status).toMatchObject({ plan: "pro", licensee: "Công ty BĐS Minh Tâm", is_valid: true });
    expect(status.limits).toEqual({ max_active_radars: null, max_followed_groups: 50, max_fields_per_radar: 20, allow_xlsx_export: true, allow_webhooks: true, allow_auto_rulesets: true });
    expect(status.key_preview).toBe(`${token.slice(0, 8)}…${token.slice(-4)}`);
    expect(status.key_preview).not.toContain(token.slice(20, 60));
    expect(await call("license_get")).toEqual(status);

    const chars = [...token];
    chars[10] = chars[10] === "A" ? "B" : "A";
    await expect(call("license_set", { license_key: chars.join("") })).rejects.toMatchObject({ code: "license_invalid" });
    await expect(call("license_set", { license_key: "not-a-token" })).rejects.toMatchObject({
      code: "license_invalid",
      message: "mã bản quyền không hợp lệ: mã bản quyền phải có định dạng DS1.<payload>.<signature>",
    });
    const other = new LicenseSigner(Buffer.alloc(32, 9)).sign({ plan: "pro", licensee: "X", issued_at: 1, expires_at: null });
    await expect(call("license_set", { license_key: other })).rejects.toMatchObject({
      message: "mã bản quyền không hợp lệ: chữ ký số Ed25519 không khớp",
    });
    const reversed = signer.sign({ plan: "pro", licensee: "X", issued_at: 10, expires_at: 5 });
    await expect(call("license_set", { license_key: reversed })).rejects.toMatchObject({ message: expect.stringContaining("expires_at <= issued_at") });
    // a failed install leaves the previous license untouched
    expect(await call("license_get")).toEqual(status);

    const now = Date.now();
    const expired = signer.sign({ plan: "pro", licensee: "Hết hạn", issued_at: now - 10 * DAY, expires_at: now - DAY });
    expect(await call("license_set", { license_key: expired })).toMatchObject({ plan: "personal", licensee: "Hết hạn", is_valid: false });
  });

  it("pauses the newest excess radars when the license is cleared, without deleting data", async () => {
    let bumps = 0;
    configure({ hooks: { bumpAndPushConfig: () => void (bumps += 1) } });
    await call("license_set", { license_key: proToken() });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const radar = t.store.radars.createDraft({ name: `R${i}`, description: "d", fields: [fd("price", "money")], now_ms: T0 + i });
      t.store.radars.setStatus(radar.radar.id, "active", T0 + i);
      ids.push(radar.radar.id);
    }
    expect(bumps).toBe(0);
    const personal = await call("license_set", { license_key: "  " });
    expect(personal.plan).toBe("personal");
    expect(ids.map((id) => t.store.radars.get(id)!.radar.status)).toEqual(["active", "active", "paused"]);
    expect(bumps).toBe(1);
    expect(t.store.radars.list(true, Date.now())).toHaveLength(3);
  });

  it("re-enforces limits at boot (expired license while closed)", async () => {
    const now = Date.now();
    t.store.settings.set(
      "license.token",
      signer.sign({ plan: "pro", licensee: "L", issued_at: now - 10 * DAY, expires_at: now - DAY }),
    );
    for (let i = 0; i < 4; i += 1) {
      const radar = t.store.radars.createDraft({ name: `R${i}`, description: "d", fields: [fd("price", "money")], now_ms: T0 + i });
      t.store.radars.setStatus(radar.radar.id, "active", T0 + i);
    }
    let bumps = 0;
    startIntegrations(t.ctx, { licenseVerifier: signer.verifier(), startWorkers: false, hooks: { bumpAndPushConfig: () => void (bumps += 1) } });
    const statuses = t.store.radars.list(true, now).map((r) => r.radar.status).sort();
    expect(statuses).toEqual(["active", "active", "paused", "paused"]);
    expect(bumps).toBe(1);
  });
});

describe("webhook channels", () => {
  it("requires Pro, validates input and keeps the secret out of every response", async () => {
    const hook = await mock();
    configure();
    await expect(call("webhook_add", { name: "Hook", url: `${hook.url}/in` })).rejects.toMatchObject({
      code: "license_limit_exceeded",
      message: "đã đạt giới hạn gói bản quyền: Webhook channels require the Pro (Chuyên nghiệp) plan",
    });
    await call("license_set", { license_key: proToken() });

    await expect(call("webhook_add", { name: "   ", url: `${hook.url}/in` })).rejects.toMatchObject({
      code: "validation_error",
      message: "dữ liệu đầu vào không hợp lệ: Webhook channel name cannot be empty",
    });
    await expect(call("webhook_add", { name: "Hook", url: "http://evil.example/in" })).rejects.toMatchObject({ code: "notify_error" });
    expect(t.store.channels.list()).toHaveLength(0);

    const generated = await call("webhook_add", { name: "  Hook  ", url: `${hook.url}/in` });
    expect(generated).toMatchObject({ kind: "webhook", name: "Hook", state: "ok", last_error: null, config: { url: `${hook.url}/in` } });
    const secret = await t.secrets.getSecret(webhookChannelKey(generated.id));
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(JSON.stringify(generated)).not.toContain(secret!);
    expect(t.store.channels.get(generated.id)!.config).toEqual({ url: `${hook.url}/in`, include_post_text: false });

    const explicit = await call("webhook_add", { name: "Mine", url: `${hook.url}/in`, secret: "  mine  " });
    expect(await t.secrets.getSecret(webhookChannelKey(explicit.id))).toBe("mine");

    const listed = await call("channel_list");
    expect(listed.map((c: { name: string }) => c.name)).toEqual(["Hook", "Mine"]);
    expect(JSON.stringify(listed)).not.toContain("whsec_");
  });

  it("removes a channel with its secret, outbox rows and radar references", async () => {
    const hook = await mock();
    configure();
    await call("license_set", { license_key: proToken() });
    const ch = await call("webhook_add", { name: "Hook", url: `${hook.url}/in` });
    const radar = seedRadar(t.store, [fd("price", "money")], { channel_ids: [ch.id], mode: "instant", min_score: 0.6, quiet_hours: null });
    t.store.outbox.enqueue({ channel_id: ch.id, kind: "lead", payload: {}, next_try_at: T0, now_ms: T0 });
    expect(await call("channel_remove", { id: "missing" })).toEqual({ removed: false });
    expect(await call("channel_remove", { id: ch.id })).toEqual({ removed: true });
    expect(await t.secrets.getSecret(webhookChannelKey(ch.id))).toBeNull();
    expect(t.store.channels.get(ch.id)).toBeNull();
    expect((t.store.db.prepare("SELECT COUNT(*) AS c FROM outbox").get() as { c: number }).c).toBe(0);
    // removing the only selected channel must not broaden delivery to every channel
    expect(t.store.radars.get(radar.radarId)!.radar.notify).toMatchObject({ channel_ids: [], inherit_channels: false });
  });
});

describe("telegram setup, polling and commands", () => {
  const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ_01234567";
  const update = (id: number, chat: number, text: string, type = "private") => ({
    update_id: id,
    message: { message_id: id, chat: { id: chat, type, title: type === "private" ? undefined : "Nhóm G" }, text },
  });

  async function setup(hooks: IntegrationHooks = {}) {
    const tg = await mock();
    const state = configure({ telegramConfig: { api_base_url: tg.url, enforce_rate_limits: false }, hooks });
    tg.route(
      (r) => r.url.endsWith("/getMe"),
      () => ({ body: { ok: true, result: { id: 1, username: "deal_bot", first_name: "Deal" } } }),
    );
    return { tg, state };
  }
  const sent = (tg: MockServer) => tg.requests.filter((r) => r.url.endsWith("/sendMessage")).map((r) => JSON.parse(r.body) as { chat_id: number; text: string });

  it("stores the token only after getMe succeeds and returns the onboarding link", async () => {
    const { tg } = await setup();
    await expect(call("telegram_set_token", { token: "   " })).rejects.toMatchObject({
      code: "validation_error",
      message: "dữ liệu đầu vào không hợp lệ: Telegram bot token cannot be empty",
    });
    expect(tg.requests).toHaveLength(0);

    const status = await call("telegram_set_token", { token: `  ${TOKEN} ` });
    expect(status).toEqual({ bot_username: "deal_bot", bot_link: "https://t.me/deal_bot?start=dealsonar", waiting_for_start: true, channels: [] });
    expect(await t.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY)).toBe(TOKEN);
    expect(t.store.settings.get("telegram.bot_username")).toBe("deal_bot");

    // a rejected token never replaces the stored one and is redacted from the error
    const bad = await mock();
    bad.respondWith({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized 999:bad" } });
    configureIntegrations(t.ctx, { licenseVerifier: signer.verifier(), telegramConfig: { api_base_url: bad.url, enforce_rate_limits: false } });
    await expect(call("telegram_set_token", { token: "999:bad" })).rejects.toMatchObject({
      code: "notify_error",
      message: "lỗi thông báo / xuất dữ liệu: telegram API error (code 401): Unauthorized [REDACTED]",
    });
    expect(await t.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY)).toBe(TOKEN);
  });

  it("registers a chat on /start, enforces registration for control commands and answers /status", async () => {
    let resumed = false;
    const { tg } = await setup({ resumeCrawl: () => (resumed = true) });
    await call("telegram_set_token", { token: TOKEN });
    expect(await call("telegram_test")).toEqual({ ok: false, message: "Chưa có kênh Telegram nào gửi /start tới bot" });

    let batch = [update(10, 777, "/start", "supergroup"), update(11, 999, "/pause")];
    tg.route(
      (r) => r.url.endsWith("/getUpdates"),
      () => ({ body: { ok: true, result: batch } }),
    );
    tg.route(
      (r) => r.url.endsWith("/sendMessage"),
      () => ({ body: { ok: true, result: { message_id: 5 } } }),
    );
    expect(await pollTelegramOnce(t.ctx)).toBe(1);
    expect(t.store.settings.get("telegram.update_offset")).toBe(12);
    expect(t.store.settings.get("telegram.notifications_paused")).toBeNull(); // unregistered /pause rejected

    const channels = await call("channel_list");
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ kind: "telegram", name: "Nhóm G", state: "ok", config: { chat_id: "777", bot_username: "deal_bot" } });
    expect(sent(tg)[0]).toMatchObject({ chat_id: 777 });
    expect(sent(tg)[0].text).toContain("<b>Nhóm G</b>");

    // a second /start refreshes the same channel instead of duplicating it
    batch = [update(12, 777, "/start", "supergroup")];
    await pollTelegramOnce(t.ctx);
    expect(await call("channel_list")).toHaveLength(1);

    const radar = seedRadar(t.store, [fd("price", "money")]);
    seedLead(t.store, radar, 1, { capturedAt: Date.now() });
    batch = [update(13, 777, "/pause", "supergroup")];
    await pollTelegramOnce(t.ctx);
    expect(t.store.settings.get("telegram.notifications_paused")).toBe(true);
    batch = [update(14, 777, "/resume", "supergroup")];
    await pollTelegramOnce(t.ctx);
    expect(t.store.settings.get("telegram.notifications_paused")).toBe(false);
    expect(resumed).toBe(true);
    batch = [update(15, 777, "/status", "supergroup")];
    await pollTelegramOnce(t.ctx);
    const texts = sent(tg).map((m) => m.text);
    expect(texts.some((x) => x.includes("Đã tạm dừng thông báo Telegram"))).toBe(true);
    expect(texts.some((x) => x.includes("Đã bật lại thông báo Telegram và tiếp tục quét nhóm"))).toBe(true);
    const status = texts.find((x) => x.includes("Trạng thái DealSonar"))!;
    expect(status).toContain("• Radar đang chạy: 1");
    expect(status).toContain("• Tin khớp hôm nay: 1");
    expect(status).toContain("• Thông báo: Đang bật");
    expect(status).toContain("• Sức khoẻ: Extension ngắt kết nối, FB Ok");
    expect(t.store.settings.get("telegram.update_offset")).toBe(16);
  });

  it("tests a channel and tracks auth revocation in channel state and health", async () => {
    const { tg } = await setup();
    await call("telegram_set_token", { token: TOKEN });
    expect(await call("telegram_test")).toEqual({ ok: false, message: "Chưa có kênh Telegram nào gửi /start tới bot" });
    const ch = t.store.channels.create("telegram", "Chat", { chat_id: 42 }, Date.now());
    const noChat = t.store.channels.create("telegram", "NoChat", {}, Date.now());
    expect(await call("telegram_test", { channel_id: noChat.id })).toEqual({ ok: false, message: "Cấu hình kênh Telegram thiếu chat_id" });
    expect(await call("telegram_test", { channel_id: "nope" })).toEqual({ ok: false, message: "Chưa có kênh Telegram nào gửi /start tới bot" });

    tg.route(
      (r) => r.url.endsWith("/sendMessage"),
      () => ({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden" } }),
    );
    expect(await call("telegram_test", { channel_id: ch.id })).toEqual({ ok: false, message: "Bot bị chặn hoặc token đã bị thu hồi (401/403)" });
    expect(t.store.channels.get(ch.id)!.state).toBe("error");
    expect((await call("channel_list")).find((c: { id: string }) => c.id === ch.id).last_error).toBe("Channel delivery failed");
    expect((await computeHealthStatus(t.ctx, Date.now())).telegram_state).toBe("error");

    const ok = await mock();
    configureIntegrations(t.ctx, { licenseVerifier: signer.verifier(), telegramConfig: { api_base_url: ok.url, enforce_rate_limits: false } });
    ok.respondWith({ body: { ok: true, result: { message_id: 77 } } });
    expect(await call("telegram_test", { channel_id: ch.id })).toEqual({ ok: true, message: "Đã gửi thành công (message_id=77)" });
    expect(t.store.channels.get(ch.id)!.state).toBe("ok");

    ok.respondWith({ status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 4 } } });
    expect(await call("telegram_test", { channel_id: ch.id })).toEqual({ ok: false, message: "Gửi thử thất bại: RateLimited { retry_after_s: 4 }" });
  });

  it("records inline-button feedback and notifies the pipeline hooks", async () => {
    const negatives: string[] = [];
    const { tg } = await setup({
      loadLeadDto: (_c, id) => ({ id }),
      onNegativeFeedback: (_c, evaluation) => void negatives.push(evaluation.id),
    });
    await call("telegram_set_token", { token: TOKEN });
    t.store.channels.create("telegram", "Chat", { chat_id: "42" }, Date.now());
    const radar = seedRadar(t.store, [fd("price", "money")]);
    const { lead, evaluation } = seedLead(t.store, radar, 1, { capturedAt: Date.now() });
    const cb = (id: number, data: string) => ({
      update_id: id,
      callback_query: { id: `c${id}`, data, message: { message_id: id, chat: { id: 42, type: "private" } } },
    });
    tg.route(
      (r) => r.url.endsWith("/getUpdates"),
      () => ({ body: { ok: true, result: [cb(1, `fb:${lead.id}:correct`), cb(2, `fb:${lead.id}:spam`)] } }),
    );
    tg.route(
      (r) => !r.url.endsWith("/getUpdates") && !r.url.endsWith("/getMe"),
      () => ({ body: { ok: true, result: true } }),
    );
    expect(await pollTelegramOnce(t.ctx)).toBe(2);
    const rows = t.store.db.prepare("SELECT label, origin FROM feedback ORDER BY created_at, id").all();
    expect(rows).toEqual([
      { label: "correct", origin: "telegram" },
      { label: "spam", origin: "telegram" },
    ]);
    expect(t.store.settings.get("runtime.feedback_by_eval")).toEqual({ [evaluation.id]: "spam" });
    expect(negatives).toEqual([evaluation.id]);
    expect(t.events.filter((e) => e.event === "lead:updated")).toHaveLength(2);
  });
});

describe("notification routing and outbox delivery", () => {
  const FIELDS = [fd("price", "money", { label: "Giá" }), fd("phone", "phone", { label: "SĐT", order: 1 })];
  const fields = {
    price: { value: { min: 12_000_000, max: 15_000_000, period: "month" }, raw: "12-15tr", confidence: 1, source: "ai" as const },
    phone: { value: "+84912345678", raw: "0912345678", confidence: 1, source: "rule" as const },
  };

  async function routed(mode: "instant" | "digest" = "instant") {
    const tg = await mock();
    const hook = await mock();
    const state = configure({ telegramConfig: { api_base_url: tg.url, enforce_rate_limits: false }, hooks: { loadLeadDto: (_c, id) => ({ id }) } });
    await call("license_set", { license_key: proToken() });
    await t.secrets.setSecret(TELEGRAM_BOT_TOKEN_KEY, "555:token_value_for_tests_0123456789");
    const now = Date.now();
    const tgCh = t.store.channels.create("telegram", "Chat", { chat_id: "42" }, now);
    const whCh = await call("webhook_add", { name: "Hook", url: `${hook.url}/in`, secret: "whsec_known" });
    const radar = seedRadar(t.store, FIELDS, { channel_ids: [], mode, min_score: 0.6, quiet_hours: null });
    const { lead, post } = seedLead(t.store, radar, 1, { summary: "Cần thuê căn hộ", fields, capturedAt: now - 1000, text: "nội dung gốc" });
    const rw = t.store.radars.get(radar.radarId)!;
    const input = (over: Partial<RouteLeadNotificationsInput> = {}): RouteLeadNotificationsInput => ({
      lead,
      post,
      sourceName: "Nhóm 1",
      authorName: "Tác giả 1",
      radarId: radar.radarId,
      radarName: rw.radar.name,
      radarStatus: "active",
      radarNotify: rw.radar.notify,
      radarVersion: rw.current_version,
      isSilentOrPreview: false,
      repostAfter72h: false,
      now,
      ...over,
    });
    return { tg, hook, state, tgCh, whCh, radar, lead, post, now, input };
  }
  const outboxRows = () =>
    t.store.db.prepare("SELECT channel_id, kind, state, attempts, remote_id, error, lead_id FROM outbox ORDER BY created_at, id").all() as Array<Record<string, unknown>>;

  it("queues one row per channel, delivers a signed webhook and a Telegram alert, and settles the tracker", async () => {
    const r = await routed();
    r.tg.respondWith({ body: { ok: true, result: { message_id: 1234 } } });
    r.hook.respondWith({ status: 200 });
    await routeLeadNotifications(t.ctx, r.input());

    expect(outboxRows().map((o) => [o.channel_id, o.kind, o.state])).toEqual([
      [r.tgCh.id, "lead", "pending"],
      [r.whCh.id, "lead", "pending"],
    ]);
    expect(t.store.db.prepare("SELECT kind, dedup_key FROM jobs").all()).toEqual([{ kind: "notify_lead", dedup_key: `notify_lead:${r.lead.id}` }]);
    expect(r.state.outboxPending).toBe(2);
    expect(t.store.settings.get("runtime.outbox_tracker")).toBeTruthy();
    expect((await computeHealthStatus(t.ctx, Date.now())).outbox_pending).toBe(2);
    expect(t.osNotifications).toHaveLength(0); // Telegram is configured

    expect(await processDueOutboxBatch(t.ctx)).toBe(2);

    const alert = JSON.parse(r.tg.requests.find((q) => q.url.endsWith("/sendMessage"))!.body);
    expect(alert.chat_id).toBe(42);
    expect(alert.text).toContain("🎯 <b>Tìm nhà</b>\n\nCần thuê căn hộ");
    expect(alert.text).toContain("• Giá: 12–15 triệu/tháng");
    expect(alert.text).toContain("• SĐT: 0912 345 678");
    expect(alert.reply_markup.inline_keyboard[0][1].callback_data).toBe(`fb:${r.lead.id}:correct`);

    const req = r.hook.requests[0];
    expect(req.url).toBe("/in");
    expect(verifyWebhookSignature("whsec_known", req.body, String(req.headers["x-dealsonar-signature"]))).toBe(true);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({
      event: "lead.created",
      radar: { id: r.radar.radarId, name: "Tìm nhà" },
      lead: {
        id: r.lead.id,
        summary: "Cần thuê căn hộ",
        fields: { price: { raw: "12-15tr" }, phone: { value: "+84912345678", raw: "0912345678" } },
        post: { permalink: "https://www.facebook.com/groups/g1/posts/1", source: "Nhóm 1", author: "Tác giả 1" },
      },
    });
    expect(body.lead.post.text).toBeUndefined(); // include_post_text defaults to false

    expect(outboxRows().map((o) => [o.state, o.remote_id])).toEqual([
      ["sent", "1234"],
      ["sent", "http:200"],
    ]);
    expect(t.store.leads.getLead(r.lead.id)!.notified_at).not.toBeNull();
    expect(t.events.filter((e) => e.event === "lead:updated")).toHaveLength(2);
    expect(r.state.outboxPending).toBe(0);
    expect(t.store.settings.get("runtime.outbox_tracker")).toBeNull();
  });

  it("retries webhook failures with backoff and marks revoked Telegram channels as failed", async () => {
    const r = await routed();
    r.tg.respondWith({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    r.hook.respondWith({ status: 503 });
    await routeLeadNotifications(t.ctx, r.input());
    const before = Date.now();
    await processDueOutboxBatch(t.ctx);

    const rows = outboxRows();
    expect(rows[0]).toMatchObject({ channel_id: r.tgCh.id, state: "failed", error: "telegram_auth_revoked" });
    expect(rows[1]).toMatchObject({ channel_id: r.whCh.id, state: "pending", error: "HTTP 503", attempts: 1 });
    const next = (t.store.db.prepare("SELECT next_try_at FROM outbox WHERE channel_id = ?").get(r.whCh.id) as { next_try_at: number }).next_try_at;
    expect(next).toBeGreaterThanOrEqual(before + 9_000);
    expect(next).toBeLessThan(before + 20_000);
    expect(t.store.channels.get(r.tgCh.id)!.state).toBe("error");

    const health = await computeHealthStatus(t.ctx, Date.now());
    expect(health).toMatchObject({ outbox_pending: 1, outbox_failed: 1, telegram_state: "error" });
    expect(t.events.some((e) => e.event === "health:changed")).toBe(true);
    // a failed lead is not marked notified
    expect(t.store.leads.getLead(r.lead.id)!.notified_at).toBeNull();
    // persisted tracker survives a restart and prunes rows of removed channels
    await call("channel_remove", { id: r.whCh.id });
    expect((await computeHealthStatus(t.ctx, Date.now())).outbox_pending).toBe(0);
  });

  it("drops rows whose channel vanished and parks rows without a bot token", async () => {
    const r = await routed();
    await routeLeadNotifications(t.ctx, r.input());
    await t.secrets.deleteSecret(TELEGRAM_BOT_TOKEN_KEY);
    r.hook.respondWith({ status: 200 });
    const before = Date.now();
    await processDueOutboxBatch(t.ctx);
    const rows = outboxRows();
    expect(rows.find((o) => o.channel_id === r.tgCh.id)).toMatchObject({ state: "pending", error: "missing_telegram_bot_token", attempts: 1 });
    expect(rows.find((o) => o.channel_id === r.whCh.id)).toMatchObject({ state: "sent" });
    const next = (t.store.db.prepare("SELECT next_try_at FROM outbox WHERE channel_id = ?").get(r.tgCh.id) as { next_try_at: number }).next_try_at;
    expect(next).toBeGreaterThanOrEqual(before + 29_000);

    // a claimed row whose channel disappeared meanwhile is dropped, not retried
    const orphan = t.store.outbox.enqueue({ channel_id: r.whCh.id, kind: "lead", payload: {}, next_try_at: Date.now(), now_ms: Date.now() });
    t.store.db.pragma("foreign_keys = OFF");
    t.store.db.prepare("DELETE FROM channels WHERE id = ?").run(r.whCh.id);
    await deliverSingleOutboxItem(t.ctx, orphan, Date.now());
    expect(outboxRows().find((o) => o.channel_id === r.whCh.id && o.state === "dropped")).toMatchObject({ error: "channel_deleted" });
  });

  it("queues digests per radar and flushes them as one message to selected channels", async () => {
    const r = await routed("digest");
    await routeLeadNotifications(t.ctx, r.input());
    expect(outboxRows()).toHaveLength(0);
    expect(t.store.settings.get(`runtime.digest_pending.${r.radar.radarId}`)).toEqual([r.lead.id]);
    expect(t.store.db.prepare("SELECT kind, dedup_key FROM jobs").all()).toEqual([{ kind: "flush_digest", dedup_key: `flush_digest:${r.radar.radarId}` }]);

    flushDigestForRadar(t.ctx, r.radar.radarId);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: r.tgCh.id, kind: "digest", lead_id: null });
    const payload = t.store.db.prepare("SELECT payload FROM outbox").get() as { payload: string };
    expect(JSON.parse(payload.payload).text).toContain("📋 <b>Gộp tin: Tìm nhà</b>");
    expect(t.store.settings.get(`runtime.digest_pending.${r.radar.radarId}`)).toBeNull();
    flushDigestForRadar(t.ctx, r.radar.radarId); // idempotent once drained
    expect(outboxRows()).toHaveLength(1);
  });

  it("falls back to an OS notification without Telegram, and honours the global pause", async () => {
    configure();
    const radar = seedRadar(t.store, FIELDS);
    const now = Date.now();
    const { lead, post } = seedLead(t.store, radar, 1, { summary: "Tin OS", capturedAt: now - 1000 });
    const rw = t.store.radars.get(radar.radarId)!;
    const input: RouteLeadNotificationsInput = {
      lead,
      post,
      sourceName: "Nhóm",
      authorName: "A",
      radarId: radar.radarId,
      radarName: "Tìm nhà",
      radarStatus: "active",
      radarNotify: rw.radar.notify,
      radarVersion: rw.current_version,
      isSilentOrPreview: false,
      repostAfter72h: false,
      now,
    };
    await routeLeadNotifications(t.ctx, input);
    expect(t.osNotifications).toEqual([{ lead_id: lead.id, radar_name: "Tìm nhà", summary: "Tin OS" }]);
    await routeLeadNotifications(t.ctx, { ...input, isSilentOrPreview: true });
    expect(t.osNotifications).toHaveLength(1);
    await call("settings_set", { patch: { os_notifications_enabled: false } });
    await routeLeadNotifications(t.ctx, input);
    expect(t.osNotifications).toHaveLength(1);

    t.store.channels.create("telegram", "Chat", { chat_id: "1" }, now);
    t.store.settings.set("telegram.notifications_paused", true);
    await routeLeadNotifications(t.ctx, input);
    expect(outboxRows()).toHaveLength(0);
  });

  it("runs the outbox worker loop and stops promptly even during a long poll", async () => {
    const tg = await mock();
    const hook = await mock();
    configure({
      telegramConfig: { api_base_url: tg.url, enforce_rate_limits: false },
      outboxPollMs: 20,
      telegramIdleSleepMs: 20,
    });
    await call("license_set", { license_key: proToken() });
    await t.secrets.setSecret(TELEGRAM_BOT_TOKEN_KEY, "555:token_value_for_tests_0123456789");
    tg.respondWith({ body: { ok: true, result: [] }, delayMs: 10_000 }); // long poll that never returns
    hook.respondWith({ status: 200 });
    const ch = await call("webhook_add", { name: "Hook", url: `${hook.url}/in`, secret: "s" });
    const workers = startIntegrationWorkers(t.ctx);

    const radar = seedRadar(t.store, FIELDS);
    const { lead, post } = seedLead(t.store, radar, 1, { fields, capturedAt: Date.now() - 1000 });
    const rw = t.store.radars.get(radar.radarId)!;
    await routeLeadNotifications(t.ctx, {
      lead,
      post,
      sourceName: "Nhóm",
      authorName: "A",
      radarId: radar.radarId,
      radarName: rw.radar.name,
      radarStatus: "active",
      radarNotify: { ...rw.radar.notify, channel_ids: [ch.id], inherit_channels: false },
      radarVersion: rw.current_version,
      isSilentOrPreview: false,
      repostAfter72h: false,
      now: Date.now(),
    });
    await waitFor(() => hook.requests.length === 1);
    await waitFor(() => (t.store.db.prepare("SELECT state FROM outbox").get() as { state: string }).state === "sent");
    await waitFor(() => tg.requests.some((q) => q.url.endsWith("/getUpdates")));

    const started = Date.now();
    await workers.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
    const countAfterStop = hook.requests.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(hook.requests.length).toBe(countAfterStop);
  });
});

describe("lead export", () => {
  const FIELDS = [fd("price", "money", { label: "Giá" })];
  const price = { value: { min: 5_000_000, max: 6_000_000, currency: "VND", period: "month" }, raw: "5tr", confidence: 1, source: "ai" as const };

  function seed() {
    configure();
    const radar = seedRadar(t.store, FIELDS);
    const a = seedLead(t.store, radar, 1, { summary: "Tin một", fields: { price }, score: 0.95, text: "gốc 1" });
    const b = seedLead(t.store, radar, 2, { summary: "=cmd|' /C calc'!A0", fields: { price }, score: 0.9, authorName: null, text: "gốc 2" });
    const weak = seedLead(t.store, radar, 3, { summary: "Tin yếu", fields: {}, score: 0.4 });
    return { radar, a, b, weak };
  }

  it("exports CSV with the requested filters, selection and post text", async () => {
    const { radar, a, b } = seed();
    const dest = path.join(t.dir, "out", "leads.csv");
    const res = await call("lead_export", { input: { query: { radar_id: radar.radarId, sort: { by: "score", dir: "desc" } }, format: "csv", include_post_text: true, dest_path: dest } });
    expect(res).toMatchObject({ path: dest, format: "csv", row_count: 3 });
    const bytes = fs.readFileSync(dest);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8").slice(1);
    expect(res.content_preview).toBe(bytes.toString("utf8"));
    expect(text).toContain("Giá (từ),Giá (đến),Giá (đơn vị)");
    expect(text).toContain(",5000000,6000000,VND/month\r\n");
    expect(text).toContain("'=cmd|' /C calc'!A0"); // formula neutralised
    expect(text).toContain("Ẩn danh"); // anonymous author

    const strong = await call("lead_export", { input: { query: { radar_id: radar.radarId, include_weak: false }, format: "csv", include_post_text: false } });
    expect(strong.row_count).toBe(2);
    expect(strong.path.startsWith(path.join(t.dir, "exports", "leads-"))).toBe(true);
    expect(fs.readFileSync(strong.path, "utf8")).not.toContain("gốc 1");

    const picked = await call("lead_export", { input: { lead_ids: [b.lead.id], query: { radar_id: radar.radarId }, format: "csv", include_post_text: false } });
    expect(picked.row_count).toBe(1);
    expect(fs.readFileSync(picked.path, "utf8")).toContain("=cmd");
    expect(fs.readFileSync(picked.path, "utf8")).not.toContain("Tin một");
    expect(a.lead.id).not.toBe(b.lead.id);
  });

  it("gates XLSX behind Pro and validates the input shape", async () => {
    const { radar } = seed();
    const input = { query: { radar_id: radar.radarId }, format: "xlsx", include_post_text: false };
    await expect(call("lead_export", { input })).rejects.toMatchObject({
      code: "license_limit_exceeded",
      message: "đã đạt giới hạn gói bản quyền: XLSX export requires the Pro (Chuyên nghiệp) plan; CSV export is available on all plans",
    });
    await call("license_set", { license_key: proToken() });
    const res = await call("lead_export", { input });
    expect(res).toMatchObject({ format: "xlsx", row_count: 3 });
    expect(res.content_preview).toBeUndefined();
    const parts = unzip(fs.readFileSync(res.path));
    expect(parts.get("xl/worksheets/sheet1.xml")!.toString()).toContain("Tin một");

    await expect(call("lead_export", { input: { query: {}, format: "pdf", include_post_text: false } })).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("unknown variant `pdf`, expected one of `csv`, `xlsx`"),
    });
    await expect(call("lead_export", { input: { query: {}, format: "csv" } })).rejects.toMatchObject({ message: expect.stringContaining("missing field `include_post_text`") });
    await expect(call("lead_export", {})).rejects.toMatchObject({ message: "thiếu tham số 'input'" });
  });
});

describe("backup, restore staging, diagnostics and data lifecycle", () => {
  it("creates an online backup that opens as a valid database", async () => {
    configure();
    const radar = seedRadar(t.store, [fd("price", "money")]);
    const res = await call("data_backup");
    expect(res.path).toBe(path.join(t.dir, "backups", `dealsonar-backup-${res.created_at}.sqlite3`));
    const copy = Store.open(res.path, path.join(t.dir, "other-backups"));
    try {
      expect(copy.radars.get(radar.radarId)?.radar.name).toBe("Tìm nhà");
    } finally {
      copy.close();
    }
  });

  it("lists backups, stages a confirmed restore and cancels it", async () => {
    configure();
    const first = await call("data_backup");
    await new Promise((r) => setTimeout(r, 5));
    const second = await call("data_backup");
    fs.writeFileSync(path.join(t.dir, "backups", "notes.txt"), "ignored");
    const listed = await call("workspace_action", { action: "backups", input: null });
    expect(listed).toEqual({ paths: [second.path, first.path], pending: false });

    await expect(call("workspace_action", { action: "restore", input: { confirm: "nope", path: first.path } })).rejects.toMatchObject({
      code: "validation_error",
      message: "dữ liệu đầu vào không hợp lệ: Nhập KHOI PHUC để xác nhận",
    });
    await expect(call("workspace_action", { action: "restore", input: { confirm: "KHOI PHUC" } })).rejects.toMatchObject({
      message: "dữ liệu đầu vào không hợp lệ: Chọn tệp sao lưu",
    });
    const junk = path.join(t.dir, "junk.sqlite3");
    fs.writeFileSync(junk, "not a database");
    await expect(call("workspace_action", { action: "restore", input: { confirm: "KHOI PHUC", path: junk } })).rejects.toBeDefined();
    expect(fs.existsSync(path.join(t.dir, "restore-pending.sqlite3"))).toBe(false);

    expect(await call("workspace_action", { action: "restore", input: { confirm: "KHOI PHUC", path: first.path } })).toEqual({ restart_required: true });
    expect(fs.existsSync(path.join(t.dir, "restore-pending.sqlite3"))).toBe(true);
    expect((await call("workspace_action", { action: "backups", input: {} })).pending).toBe(true);
    expect(await call("workspace_action", { action: "restore_cancel", input: {} })).toEqual({ cancelled: true });
    expect(fs.existsSync(path.join(t.dir, "restore-pending.sqlite3"))).toBe(false);
    expect(await call("workspace_action", { action: "restore_cancel", input: {} })).toEqual({ cancelled: true });
    await expect(call("workspace_action", { action: "explode", input: {} })).rejects.toMatchObject({
      message: "dữ liệu đầu vào không hợp lệ: Thao tác workspace không được hỗ trợ",
    });
  });

  it("rolls a radar back through the radar service hooks", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let bumps = 0;
    configure({
      hooks: {
        bumpAndPushConfig: () => void (bumps += 1),
        radar: {
          get: () => ({
            radar: { current_version: 3 },
            versions: [
              { version: 2, description: "v2", user_profession: "p", fields: [{ key: "a" }], match_policy: { want_intent: "any" } },
              { version: 3, description: "v3", user_profession: null, fields: [], match_policy: {} },
            ],
          }),
          update: (_c, input) => {
            updates.push(input);
            return { detail: { rolled: true } };
          },
        },
      },
    });
    const run = (input: Record<string, unknown>) => call("workspace_action", { action: "rollback", input });
    await expect(run({ expected_version: 3, version: 2 })).rejects.toMatchObject({ message: "dữ liệu đầu vào không hợp lệ: Thiếu radar" });
    await expect(run({ radar_id: "r", version: 2 })).rejects.toMatchObject({ message: "dữ liệu đầu vào không hợp lệ: Thiếu phiên bản hiện tại" });
    await expect(run({ radar_id: "r", expected_version: 3 })).rejects.toMatchObject({ message: "dữ liệu đầu vào không hợp lệ: Chọn phiên bản" });
    await expect(run({ radar_id: "r", expected_version: 2, version: 2 })).rejects.toMatchObject({
      message: "dữ liệu đầu vào không hợp lệ: Radar đã thay đổi. Tải lại trước khi áp dụng.",
    });
    await expect(run({ radar_id: "r", expected_version: 3, version: 9 })).rejects.toMatchObject({
      message: "dữ liệu đầu vào không hợp lệ: Phiên bản không thuộc radar",
    });
    expect(await run({ radar_id: "r", expected_version: 3, version: 2 })).toEqual({ rolled: true });
    expect(updates).toEqual([
      { id: "r", description: "v2", user_profession: "p", fields: [{ key: "a" }], match_policy: { want_intent: "any" }, confirm_version_upgrade: true },
    ]);
    expect(bumps).toBe(1);
  });

  it("reports rollback as not implemented when no radar service is wired", async () => {
    configure();
    await expect(call("workspace_action", { action: "rollback", input: { radar_id: "r", expected_version: 1, version: 1 } })).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("writes a diagnostic bundle that contains no secrets or post content", async () => {
    const hook = await mock();
    configure();
    await call("license_set", { license_key: proToken() });
    const ch = await call("webhook_add", { name: "Hook", url: `${hook.url}/in`, secret: "whsec_super_secret_value" });
    const botToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789";
    await t.secrets.setSecret(TELEGRAM_BOT_TOKEN_KEY, botToken);
    const license = t.store.settings.get<string>("license.token")!;
    const radar = seedRadar(t.store, [fd("price", "money")]);
    seedLead(t.store, radar, 1, { summary: "SĐT khách hàng 0912345678", text: "nội dung bài viết riêng tư" });
    t.store.aiCalls.record({ provider: "claude_cli", task: "judge_extract", item_count: 1, duration_ms: 1, status: "error", error: `bad ${botToken}`, now_ms: Date.now() });
    const state = getIntegrations(t.ctx);
    state.aiHealth.lastError = `auth failed for ${botToken}`;

    fs.writeFileSync(path.join(t.dir, "logs", "app.log"), [`token=${botToken}`, `license ${license}`, "Authorization: Bearer abc.def", "secret whsec_super_secret_value", "plain line"].join("\n"));
    fs.writeFileSync(path.join(t.dir, "logs", "ignored.json"), "{}");

    const res = await call("diagnostic_bundle_create");
    expect(res.path).toBe(path.join(t.dir, "diagnostics", `dealsonar-diagnostics-${res.created_at}.zip`));
    expect(res.size_bytes).toBe(fs.statSync(res.path).size);
    const parts = unzip(fs.readFileSync(res.path));
    expect([...parts.keys()].sort()).toEqual(["health.json", "logs/app.log", "schema_migrations.json", "settings_redacted.json", "table_counts.json", "version.json"]);

    const everything = [...parts.values()].map((b) => b.toString("utf8")).join("\n");
    for (const secret of [botToken, license, "whsec_super_secret_value", "Bearer abc.def", "0912345678", "nội dung bài viết riêng tư"]) {
      expect(everything).not.toContain(secret);
    }
    const log = parts.get("logs/app.log")!.toString("utf8");
    expect(log).toContain("[REDACTED]");
    expect(log).toContain("plain line");
    expect(JSON.parse(parts.get("health.json")!.toString()).ai_error).toBe("auth failed for [REDACTED]");
    expect(JSON.parse(parts.get("version.json")!.toString())).toMatchObject({ app_name: "DealSonar", app_version: "0.1.0-test", protocol_version: 2, created_at: res.created_at });
    const counts = JSON.parse(parts.get("table_counts.json")!.toString());
    expect(counts).toMatchObject({ leads: 1, posts: 1, channels: 1 });
    expect(JSON.parse(parts.get("settings_redacted.json")!.toString())).toEqual(defaultSettings());
    expect(JSON.parse(parts.get("schema_migrations.json")!.toString()).map((m: { version: number }) => m.version)).toEqual([1, 2, 3]);
  });

  it("purges expired unmatched posts but keeps lead posts", async () => {
    configure();
    const radar = seedRadar(t.store, [fd("price", "money")]);
    const { post: kept } = seedLead(t.store, radar, 1);
    const [orphan] = t.store.posts.insert({
      platform: "facebook",
      external_id: "orphan",
      source_id: radar.sourceIds[0],
      permalink: "https://www.facebook.com/groups/g1/posts/orphan",
      text: "tin không khớp",
      content_hash: "orphan",
      simhash: 1,
      captured_at: T0,
      strategy: "dom",
    });
    const res = await call("data_purge", { unmatched_retention_days: 1 });
    expect(res).toMatchObject({ posts_purged: 1 });
    expect(t.store.posts.get(orphan.id)?.text ?? null).toBeNull();
    expect(t.store.posts.get(kept.id)?.text).toBe("Tin 1");
    // default retention (90 days) leaves everything alone
    expect((await call("data_purge")).posts_purged).toBe(0);
    await expect(call("data_purge", { unmatched_retention_days: -1 })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("deletes everything after the folded confirmation phrase, secrets included", async () => {
    const hook = await mock();
    let wiped = 0;
    let bumps = 0;
    const state = configure({ hooks: { onDataDeleted: () => void (wiped += 1), bumpAndPushConfig: () => void (bumps += 1) } });
    await call("license_set", { license_key: proToken() });
    const ch = await call("webhook_add", { name: "Hook", url: `${hook.url}/in` });
    await t.secrets.setSecret(TELEGRAM_BOT_TOKEN_KEY, "123:token");
    seedLead(t.store, seedRadar(t.store, [fd("price", "money")]), 1);
    t.store.outbox.enqueue({ channel_id: ch.id, kind: "lead", payload: {}, next_try_at: T0, now_ms: Date.now() });
    await call("data_backup");
    fs.writeFileSync(path.join(t.dir, "restore-pending.sqlite3"), "x");
    state.outboxTracker.set("o1", { channel_id: ch.id, state: "pending" });

    await expect(call("data_delete_all", { confirm_phrase: "xoa" })).rejects.toMatchObject({
      code: "validation_error",
      message: "dữ liệu đầu vào không hợp lệ: Cụm xác nhận không khớp; vui lòng nhập đúng 'XOA TOAN BO'",
    });
    expect(t.store.channels.list()).toHaveLength(1);

    expect(await call("data_delete_all", { confirm_phrase: "  Xóa Toàn Bộ " })).toEqual({ deleted: true });
    for (const table of ["leads", "posts", "radars", "sources", "channels", "outbox", "settings"]) {
      expect((t.store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c, table).toBe(0);
    }
    expect(await t.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY)).toBeNull();
    expect(await t.secrets.getSecret(webhookChannelKey(ch.id))).toBeNull();
    expect(fs.readdirSync(path.join(t.dir, "backups"))).toEqual([]);
    expect(fs.existsSync(path.join(t.dir, "restore-pending.sqlite3"))).toBe(false);
    expect(state.outboxTracker.size).toBe(0);
    expect(wiped).toBe(1);
    expect(bumps).toBe(1);
    expect(await call("data_delete_all", { confirm_phrase: "xoa tat ca" })).toEqual({ deleted: true });
  });
});
