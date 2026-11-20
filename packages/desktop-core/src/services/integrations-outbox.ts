// Notification engine: outbox delivery (Telegram + signed webhooks), lead routing, digests, the
// Telegram long-poll worker and its command/feedback handling.
//
// Ports crates/core/src/workers/{outbox,telegram_poller}.rs, pipeline/notify.rs and the
// `flush_digest` / `notify_lead` job bodies. `routeLeadNotifications` is the hook PipelineService
// calls after it creates a lead.

import type { CommandHandler, RuntimeContext } from "../backend/runtime";
import { CoreError, type Args } from "../backend/wire";
import { AiError } from "../ai/types";
import { NotifyError, aiToCoreError, notifyToCoreError } from "../notify/errors";
import {
  type DigestLeadItem,
  type NotifyDecision,
  escapeHtml,
  evaluateNotifyPolicy,
  extractedFieldsStoreToNotify,
  formatDigestHtml,
  formatLeadAlert,
} from "../notify/format";
import {
  MAX_OUTBOX_QUEUE_AGE_MS,
  type SendMessageRequest,
  type TelegramIncomingEvent,
  sendMessageHtml,
} from "../notify/telegram";
import { type WebhookLeadCreatedPayload, newLeadCreatedPayload } from "../notify/webhook";
import { TELEGRAM_BOT_TOKEN_KEY, webhookChannelKey } from "../secrets/types";
import { type NotifyConfig, notifySendsToChannel } from "../store/domain";
import type { LeadRecord } from "../store/leads";
import type { OutboxRecord } from "../store/ops";
import type { PostRecord } from "../store/posts";
import type { RadarVersionRecord } from "../store/radars";
import {
  enqueueOutboxTracked,
  emitHealthIfChanged,
  computeHealthStatus,
  getIntegrations,
  loadSettings,
  nowMs,
  queueSystemIncidentAlert,
  startOfLocalDayMs,
  telegramChatId,
  tryGetSecret,
  updateOutboxTrackedState,
} from "./integrations-state";

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Convert provider-layer errors to the `CoreError` the wire layer expects (`From<NotifyError>`...). */
export function asCoreError(err: unknown): unknown {
  if (err instanceof NotifyError) return notifyToCoreError(err);
  if (err instanceof AiError) return aiToCoreError(err.message);
  return err;
}

/** Wrap a handler so `NotifyError`/`AiError` surface as `notify_error`/`ai_error` wire errors. */
export function guarded(fn: (ctx: RuntimeContext, args: Args) => Promise<unknown> | unknown): CommandHandler {
  return async (ctx, args) => {
    try {
      return await fn(ctx, args);
    } catch (err) {
      throw asCoreError(err);
    }
  };
}

// ---- runtime settings used by routing ----------------------------------------------------------

const FLOOD_SET_KEY = "runtime.flood_auto_digest_radars";
const FEEDBACK_BY_EVAL_KEY = "runtime.feedback_by_eval";
const NEGATIVE_LABELS = new Set(["irrelevant", "peer", "duplicate", "spam"]);

export function getFloodAutoDigestRadars(ctx: RuntimeContext): Set<string> {
  const v = ctx.store.settings.get<string[]>(FLOOD_SET_KEY);
  return new Set(Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
}

export function markRadarFloodAutoDigest(ctx: RuntimeContext, radarId: string, active: boolean): void {
  const set = getFloodAutoDigestRadars(ctx);
  if (active) set.add(radarId);
  else set.delete(radarId);
  ctx.store.settings.set(FLOOD_SET_KEY, [...set].sort());
}

export function setEvalFeedbackLabel(ctx: RuntimeContext, evaluationId: string, label: string): void {
  const map = ctx.store.settings.get<Record<string, string>>(FEEDBACK_BY_EVAL_KEY) ?? {};
  map[evaluationId] = label;
  ctx.store.settings.set(FEEDBACK_BY_EVAL_KEY, map);
}

/** `enqueue_digest_lead`: remember the lead and schedule one `flush_digest` job per radar. */
export function enqueueDigestLead(ctx: RuntimeContext, radarId: string, leadId: string, now: number): void {
  const key = `runtime.digest_pending.${radarId}`;
  const pending = ctx.store.settings.get<string[]>(key) ?? [];
  if (!pending.includes(leadId)) {
    pending.push(leadId);
    ctx.store.settings.set(key, pending);
  }
  const settings = loadSettings(ctx.store);
  const delayMs = Math.max(1, settings.digest_interval_minutes) * 60_000;
  ctx.store.jobs.enqueue("flush_digest", `flush_digest:${radarId}`, { radar_id: radarId }, now + delayMs, now);
}

function wakeJobs(ctx: RuntimeContext): void {
  getIntegrations(ctx).hooks.wakeJobs?.(ctx);
}

// ---- outbox delivery ----------------------------------------------------------------------------

/** `parse_telegram_send_request`. */
export function parseTelegramSendRequest(payload: Json): SendMessageRequest {
  if (!isObject(payload)) throw CoreError.validation("telegram outbox missing chat_id");
  const rawChat = payload.chat_id;
  let chatId: number | null = null;
  if (typeof rawChat === "number" && Number.isSafeInteger(rawChat)) chatId = rawChat;
  else if (typeof rawChat === "string" && /^[+-]?\d+$/.test(rawChat) && Number.isSafeInteger(Number(rawChat))) {
    chatId = Number(rawChat);
  }
  if (chatId === null) throw CoreError.validation("telegram outbox missing chat_id");
  if (typeof payload.text !== "string") throw CoreError.validation("telegram outbox missing text");
  const markup = payload.reply_markup;
  if (markup !== undefined && markup !== null) {
    if (!isObject(markup) || !Array.isArray(markup.inline_keyboard)) {
      throw new CoreError("json", "lỗi dữ liệu JSON: invalid reply_markup");
    }
    return sendMessageHtml(chatId, payload.text, markup as unknown as SendMessageRequest["reply_markup"]);
  }
  return sendMessageHtml(chatId, payload.text, null);
}

function parseWebhookPayload(payload: Json): WebhookLeadCreatedPayload {
  const bad = (): CoreError => new CoreError("json", "lỗi dữ liệu JSON: invalid webhook outbox payload");
  if (!isObject(payload)) throw bad();
  const { event, id, created_at: createdAt, radar, lead } = payload;
  if (typeof event !== "string" || typeof id !== "string" || typeof createdAt !== "string") throw bad();
  if (!isObject(radar) || typeof radar.id !== "string" || typeof radar.name !== "string") throw bad();
  if (!isObject(lead) || typeof lead.id !== "string" || typeof lead.score !== "number") throw bad();
  if (typeof lead.summary !== "string" || !isObject(lead.fields) || !isObject(lead.post)) throw bad();
  return payload as unknown as WebhookLeadCreatedPayload;
}

const OUTBOX_MAX_ATTEMPTS = 6;

/** Deliver one claimed outbox row and record the outcome (state transition + health). */
export async function deliverSingleOutboxItem(ctx: RuntimeContext, item: OutboxRecord, now: number): Promise<void> {
  const state = getIntegrations(ctx);
  const store = ctx.store;
  const track = (updatedState: string): void => updateOutboxTrackedState(ctx, item.id, item.channel_id, updatedState);
  const retry = (error: string, nextTryAt: number | null, maxAgeMs: number, at: number, maxAttempts = OUTBOX_MAX_ATTEMPTS): void => {
    const updated = store.outbox.retryOrDrop(item.id, error, nextTryAt, maxAttempts, maxAgeMs, at);
    track(updated.state);
  };

  const channel = store.channels.get(item.channel_id);
  if (!channel) {
    const updated = store.outbox.retryOrDrop(item.id, "channel_deleted", null, 1, -1, now);
    track(updated.state);
    return;
  }

  const priorAttempts = Math.max(0, item.attempts - 1);
  const queuedAgeMs = Math.max(0, now - item.created_at);
  const emitLeadUpdated = (): void => {
    if (!item.lead_id) return;
    const dto = state.hooks.loadLeadDto?.(ctx, item.lead_id);
    if (dto !== null && dto !== undefined) ctx.emit("lead:updated", dto);
  };

  switch (channel.kind) {
    case "telegram": {
      const token = await ctx.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY);
      if (token === null) {
        retry("missing_telegram_bot_token", now + 30_000, MAX_OUTBOX_QUEUE_AGE_MS, now);
        return;
      }
      const req = parseTelegramSendRequest(item.payload);
      const outcome = await state.telegram.deliverOutboxMessage(token, req, priorAttempts, queuedAgeMs);
      const finished = nowMs();
      switch (outcome.kind) {
        case "sent":
          store.outbox.markSent(item.id, String(outcome.message_id), finished);
          track("sent");
          emitLeadUpdated();
          break;
        case "rate_limited":
          retry("telegram_rate_limited", finished + outcome.retry_after_s * 1000, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          break;
        case "retryable_network":
          retry("telegram_network_error", finished + outcome.next_delay_s * 1000, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          break;
        case "auth_revoked":
          store.channels.setState(channel.id, "error");
          retry("telegram_auth_revoked", null, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          await emitHealthIfChanged(ctx, finished);
          break;
        case "dropped":
          // Force the `dropped` state: max age -1 makes every row older than the limit.
          retry(outcome.reason, null, -1, finished, 0);
          break;
        case "permanent_failure":
          retry(`HTTP ${outcome.status_code}: ${outcome.description}`, null, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          break;
      }
      return;
    }

    case "webhook": {
      const url = isObject(channel.config) && typeof channel.config.url === "string" ? channel.config.url : "";
      const secret = await ctx.secrets.getSecret(webhookChannelKey(channel.id));
      if (secret === null) {
        store.channels.setState(channel.id, "error");
        retry("missing_webhook_secret", null, MAX_OUTBOX_QUEUE_AGE_MS, now);
        return;
      }
      const payload = parseWebhookPayload(item.payload);
      const outcome = await state.webhook.sendOnce(url, secret, payload, priorAttempts);
      const finished = nowMs();
      switch (outcome.kind) {
        case "sent":
          store.outbox.markSent(item.id, `http:${outcome.status_code}`, finished);
          track("sent");
          emitLeadUpdated();
          break;
        case "retryable":
          retry(outcome.reason, finished + outcome.next_delay_s * 1000, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          break;
        case "exhausted":
          retry(outcome.reason, null, MAX_OUTBOX_QUEUE_AGE_MS, finished);
          break;
      }
      return;
    }

    default:
      retry(`unsupported channel kind '${channel.kind}'`, null, MAX_OUTBOX_QUEUE_AGE_MS, now, 1);
  }
}

/** Drain every currently due outbox row on healthy channels. Returns the number handled. */
export async function processDueOutboxBatch(ctx: RuntimeContext): Promise<number> {
  let handled = 0;
  try {
    while (!ctx.isShuttingDown()) {
      const now = nowMs();
      const item = ctx.store.outbox.claimDue(now);
      if (!item) break;
      await deliverSingleOutboxItem(ctx, item, now);
      handled += 1;
    }
  } catch (err) {
    throw asCoreError(err);
  }
  return handled;
}

/** Body of the durable `notify_lead` job. */
export async function runNotifyLeadJob(ctx: RuntimeContext): Promise<void> {
  await processDueOutboxBatch(ctx);
}

// ---- digest -------------------------------------------------------------------------------------

/** Body of the durable `flush_digest` job. */
export function flushDigestForRadar(ctx: RuntimeContext, radarId: string): void {
  const key = `runtime.digest_pending.${radarId}`;
  const pendingIds = ctx.store.settings.get<string[]>(key) ?? [];
  if (pendingIds.length === 0) return;
  ctx.store.settings.delete(key);

  const rw = ctx.store.radars.get(radarId);
  if (!rw || rw.radar.status !== "active") return;

  const items: DigestLeadItem[] = [];
  for (const lid of pendingIds) {
    const detail = ctx.store.leads.leadGet(lid);
    if (detail) {
      items.push({
        lead_id: detail.lead.id,
        summary: detail.lead.summary,
        score: detail.lead.score,
        source_name: detail.source_name,
        permalink: detail.permalink,
      });
    }
  }
  if (items.length === 0) return;

  items.sort((a, b) => b.score - a.score);
  const total = items.length;
  const shown = items.slice(0, Math.min(total, 10));
  const html = formatDigestHtml(rw.radar.name, shown, total - shown.length);

  const now = nowMs();
  for (const ch of ctx.store.channels.list()) {
    if (ch.kind !== "telegram" || ch.state !== "ok" || !notifySendsToChannel(rw.radar.notify, ch.id)) continue;
    const chatId = telegramChatId(ch.config);
    if (chatId === null) continue;
    enqueueOutboxTracked(ctx, {
      channel_id: ch.id,
      lead_id: null,
      kind: "digest",
      payload: sendMessageHtml(chatId, html, null),
      next_try_at: now,
      now_ms: now,
    });
  }
}

// ---- lead routing (PipelineService hook) ---------------------------------------------------------

export interface RouteLeadNotificationsInput {
  lead: LeadRecord;
  post: PostRecord;
  sourceName: string;
  authorName: string;
  radarId: string;
  radarName: string;
  radarStatus: string;
  radarNotify: NotifyConfig;
  radarVersion: RadarVersionRecord;
  /** `EvalMode::is_silent_or_preview()` / `EvalMode::repost_after_72h()`. */
  isSilentOrPreview: boolean;
  repostAfter72h: boolean;
  now: number;
}

/**
 * Route a freshly created lead: OS notification fallback, then Telegram/webhook outbox rows or the
 * digest queue per the notification policy. Mirrors `route_lead_notifications`; call it from the
 * pipeline right after `leads.createLead` (inside the same tick, before emitting `lead:new`).
 *
 * Throws on invalid permalinks / callback data exactly where the Rust version returned `Err`.
 */
export async function routeLeadNotifications(ctx: RuntimeContext, input: RouteLeadNotificationsInput): Promise<void> {
  try {
    await routeLeadNotificationsInner(ctx, input);
  } catch (err) {
    throw asCoreError(err);
  }
}

async function routeLeadNotificationsInner(ctx: RuntimeContext, input: RouteLeadNotificationsInput): Promise<void> {
  const state = getIntegrations(ctx);
  const store = ctx.store;
  const { lead, post, now } = input;
  const settings = loadSettings(store);
  const globalPaused = store.settings.get<boolean>("telegram.notifications_paused") ?? false;

  const allChannels = store.channels.list();
  const targetChannels = allChannels.filter((c) => c.state === "ok" && notifySendsToChannel(input.radarNotify, c.id));
  const hasTelegramConfigured =
    allChannels.some((c) => c.kind === "telegram") && (await tryGetSecret(ctx.secrets, TELEGRAM_BOT_TOKEN_KEY)) !== null;

  // OS desktop notification fallback when Telegram is not configured (`07-notifications-export.md §4`).
  const sixHoursMs = 6 * 3_600_000;
  const localOnly = input.radarNotify.inherit_channels === false && input.radarNotify.channel_ids.length === 0;
  if (
    (localOnly || !hasTelegramConfigured) &&
    settings.os_notifications_enabled &&
    !input.isSilentOrPreview &&
    input.radarStatus === "active" &&
    now - post.captured_at <= sixHoursMs
  ) {
    ctx.notifyOs({ lead_id: lead.id, radar_name: input.radarName, summary: lead.summary });
  }

  if (globalPaused || targetChannels.length === 0) return;

  const local = new Date(now);
  const localHour = Number.isNaN(local.getTime()) ? 12 : local.getHours();
  const localMinute = Number.isNaN(local.getTime()) ? 0 : local.getMinutes();
  const effectiveQuiet =
    input.radarNotify.quiet_hours !== null
      ? { from: input.radarNotify.quiet_hours.from, to: input.radarNotify.quiet_hours.to }
      : settings.quiet_hours_enabled
        ? { from: settings.quiet_hours.from, to: settings.quiet_hours.to }
        : null;

  const leadsInLastHour = store.leads.countLeadsInLastHour(input.radarId, now);
  const floodSet = getFloodAutoDigestRadars(ctx);
  const isDigestMode = input.radarNotify.mode === "digest" || floodSet.has(input.radarId);

  const decision: NotifyDecision = evaluateNotifyPolicy({
    radarActive: input.radarStatus === "active",
    hasChannels: targetChannels.length > 0,
    digestMode: isDigestMode,
    score: lead.score,
    minScore: input.radarNotify.min_score,
    isClusterHead: post.is_cluster_head,
    repostAfter72h: input.repostAfter72h,
    capturedAtMs: post.captured_at,
    decidedAtMs: now,
    quietHours: effectiveQuiet,
    localHour,
    localMinute,
    isPreviewOrBackfill: input.isSilentOrPreview,
    leadsInLastHour,
  });

  if (decision.kind === "skip") return;

  if (decision.kind === "queue_digest") {
    if (decision.triggerFloodAutoDigest) {
      markRadarFloodAutoDigest(ctx, input.radarId, true);
      if (!state.incidents.floodAlertedRadars.has(input.radarId)) {
        state.incidents.floodAlertedRadars.add(input.radarId);
        try {
          queueSystemIncidentAlert(
            ctx,
            { kind: "radar_flood_auto_digest", radar_name: input.radarName, leads_last_hour: leadsInLastHour },
            false,
            now,
          );
        } catch {
          // `let _ =` in Rust: an alert failure must not block the lead
        }
      }
    }
    enqueueDigestLead(ctx, input.radarId, lead.id, now);
    return;
  }

  // send_instant
  const fieldDefs = input.radarVersion.fields;
  const extracted = extractedFieldsStoreToNotify(lead.fields);
  let queuedAny = false;
  for (const ch of targetChannels) {
    if (ch.kind === "telegram") {
      const chatId = telegramChatId(ch.config);
      if (chatId === null) continue;
      const alert = formatLeadAlert({
        lead_id: lead.id,
        radar_name: input.radarName,
        summary: lead.summary,
        field_defs: fieldDefs,
        extracted_fields: extracted,
        group_name: input.sourceName,
        author_name: input.authorName,
        post_created_at_ms: post.created_at,
        now_ms: now,
        other_group_count: lead.also_seen_in.length,
        permalink: post.permalink,
      });
      enqueueOutboxTracked(ctx, {
        channel_id: ch.id,
        lead_id: lead.id,
        kind: "lead",
        payload: sendMessageHtml(chatId, alert.html, alert.reply_markup),
        next_try_at: now,
        now_ms: now,
      });
      queuedAny = true;
    } else if (ch.kind === "webhook") {
      const includeText = isObject(ch.config) && ch.config.include_post_text === true;
      const payload = newLeadCreatedPayload({
        eventCreatedAtMs: now,
        radarId: input.radarId,
        radarName: input.radarName,
        leadId: lead.id,
        score: lead.score,
        summary: lead.summary,
        extractedFields: extracted,
        permalink: post.permalink,
        postCreatedAtMs: post.created_at,
        sourceName: input.sourceName,
        authorName: input.authorName,
        postText: includeText ? post.text : null,
      });
      enqueueOutboxTracked(ctx, {
        channel_id: ch.id,
        lead_id: lead.id,
        kind: "lead",
        payload,
        next_try_at: now,
        now_ms: now,
      });
      queuedAny = true;
    }
  }

  if (queuedAny) {
    store.jobs.enqueue("notify_lead", `notify_lead:${lead.id}`, { lead_id: lead.id }, now, now);
    state.outboxWake?.();
    wakeJobs(ctx);
  }
}

// ---- Telegram poller ----------------------------------------------------------------------------

const FB_SESSION_DEBUG: Record<string, string> = {
  ok: "Ok",
  logged_out: "LoggedOut",
  checkpoint: "Checkpoint",
  rate_limited: "RateLimited",
};

/** One `getUpdates` cycle plus handling of every resulting event. Returns the event count. */
export async function pollTelegramOnce(ctx: RuntimeContext, signal?: AbortSignal): Promise<number> {
  const state = getIntegrations(ctx);
  try {
    const token = await ctx.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY);
    if (token === null) return 0;

    const registered = new Set<number>();
    for (const c of ctx.store.channels.list()) {
      if (c.kind !== "telegram") continue;
      const id = telegramChatId(c.config);
      if (id !== null) registered.add(id);
    }
    const offset = ctx.store.settings.get<number>("telegram.update_offset");
    const botUsername = ctx.store.settings.get<string>("telegram.bot_username");

    const res = await state.telegram.pollUpdates(token, {
      offset: typeof offset === "number" ? offset : null,
      timeout_s: state.telegramPollTimeoutS,
      bot_username: botUsername,
      registered_chat_ids: registered,
      signal,
    });
    if (res.next_offset !== null) ctx.store.settings.set("telegram.update_offset", res.next_offset);

    for (const ev of res.events) await handleTelegramIncomingEvent(ctx, token, ev);
    return res.events.length;
  } catch (err) {
    throw asCoreError(err);
  }
}

export async function handleTelegramIncomingEvent(
  ctx: RuntimeContext,
  token: string,
  event: TelegramIncomingEvent,
): Promise<void> {
  const state = getIntegrations(ctx);
  const store = ctx.store;
  const now = nowMs();

  switch (event.kind) {
    case "start_command": {
      const chatIdStr = String(event.chat_id);
      const existing = store.channels.list().find((c) => {
        if (c.kind !== "telegram" || !isObject(c.config)) return false;
        const v = c.config.chat_id;
        const asText = typeof v === "string" ? v : typeof v === "number" && Number.isInteger(v) ? String(v) : null;
        return asText === chatIdStr;
      });
      const cfg = { chat_id: chatIdStr, chat_title: event.chat_title };
      const displayName = event.chat_title.trim() === "" ? `Telegram ${event.chat_id}` : event.chat_title;
      if (existing) store.channels.upsert(existing.id, "telegram", displayName, cfg, "ok", now);
      else store.channels.create("telegram", displayName, cfg, now);
      await state.telegram.sendWelcomeMessage(token, event.chat_id, displayName).catch(() => undefined);
      await emitHealthIfChanged(ctx, now);
      return;
    }

    case "lead_feedback": {
      if (!["correct", "irrelevant", "wrong_fields", "peer", "duplicate", "spam", "missed"].includes(event.label)) return;
      const detail = store.leads.leadGet(event.lead_id);
      if (!detail) return;
      store.leads.recordFeedback({
        evaluation_id: detail.lead.evaluation_id,
        label: event.label,
        corrected_fields: null,
        post_text: detail.post_text,
        origin: "telegram",
        now_ms: now,
      });
      setEvalFeedbackLabel(ctx, detail.lead.evaluation_id, event.label);
      if (NEGATIVE_LABELS.has(event.label)) {
        const evaluation = store.leads.getEvaluation(detail.lead.evaluation_id);
        if (evaluation) await state.hooks.onNegativeFeedback?.(ctx, evaluation, now);
      }
      const dto = state.hooks.loadLeadDto?.(ctx, event.lead_id);
      if (dto !== null && dto !== undefined) ctx.emit("lead:updated", dto);
      return;
    }

    case "pause_command": {
      store.settings.set("telegram.notifications_paused", true);
      const req = sendMessageHtml(
        event.chat_id,
        "⏸ <b>Đã tạm dừng thông báo Telegram.</b> Gửi /resume bất cứ lúc nào để bật lại.",
        null,
      );
      await state.telegram.deliverOutboxMessage(token, req, 0, 0).catch(() => undefined);
      return;
    }

    case "resume_command": {
      store.settings.set("telegram.notifications_paused", false);
      // Also resume crawling if it was paused (`02-extension.md §7`).
      const resumedCrawl = state.hooks.resumeCrawl?.(ctx) ?? false;
      if (resumedCrawl) await emitHealthIfChanged(ctx, now);
      const req = sendMessageHtml(
        event.chat_id,
        `▶️ <b>Đã bật lại thông báo Telegram${escapeHtml(resumedCrawl ? " và tiếp tục quét nhóm" : "")}</b>.`,
        null,
      );
      await state.telegram.deliverOutboxMessage(token, req, 0, 0).catch(() => undefined);
      return;
    }

    case "status_command": {
      const health = await computeHealthStatus(ctx, now);
      const activeRadars = store.radars.list(false, now).filter((r) => r.radar.status === "active").length;
      const page = store.leads.list({ since: startOfLocalDayMs(now), limit: 500 });
      const paused = store.settings.get<boolean>("telegram.notifications_paused") ?? false;
      const extDesc = health.extension_connected ? "Extension OK" : "Extension ngắt kết nối";
      const healthSummary = `${extDesc}, FB ${FB_SESSION_DEBUG[health.facebook_session] ?? health.facebook_session}`;
      await state.telegram
        .sendStatusReply(token, event.chat_id, {
          active_radars: activeRadars,
          leads_today: page.items.length,
          health_summary: healthSummary,
          notifications_paused: paused,
        })
        .catch(() => undefined);
      return;
    }
  }
}

// ---- workers ------------------------------------------------------------------------------------

export interface IntegrationWorkers {
  /** Wake the outbox loop immediately (after enqueueing a due row). */
  wakeOutbox(): void;
  /** Stop both loops and wait for in-flight work (bounded). */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleep that ends early on `signal` and leaves no timer or listener behind. */
function sleepOrAbort(ms: number, signal: AbortSignal, onWake?: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    onWake?.(done);
  });
}

/**
 * Start the outbox delivery loop and the Telegram long-poll loop. Idempotent per context: a second
 * call returns the running controller. Errors are logged through `log` and never stop the loops.
 */
export function startIntegrationWorkers(
  ctx: RuntimeContext,
  options: { log?: (message: string) => void } = {},
): IntegrationWorkers {
  const state = getIntegrations(ctx);
  if (state.workersStop) {
    return { wakeOutbox: () => state.outboxWake?.(), stop: state.workersStop };
  }
  const log = options.log ?? (() => undefined);
  const stopController = new AbortController();
  let wake: (() => void) | null = null;
  let wakePending = false;

  state.outboxWake = () => {
    wakePending = true;
    wake?.();
  };

  const outboxLoop = (async () => {
    while (!stopController.signal.aborted && !ctx.isShuttingDown()) {
      wakePending = false;
      try {
        await processDueOutboxBatch(ctx);
      } catch (err) {
        log(`outbox worker tick error: ${(err as Error).message}`);
      }
      if (wakePending) continue;
      await sleepOrAbort(state.outboxPollMs, stopController.signal, (w) => {
        wake = w;
      });
      wake = null;
    }
  })();

  const pollerLoop = (async () => {
    while (!stopController.signal.aborted && !ctx.isShuttingDown()) {
      const token = await tryGetSecret(ctx.secrets, TELEGRAM_BOT_TOKEN_KEY);
      if (token === null) {
        await sleepOrAbort(state.telegramIdleSleepMs, stopController.signal);
        continue;
      }
      try {
        await pollTelegramOnce(ctx, stopController.signal);
      } catch (err) {
        if (stopController.signal.aborted) break;
        log(`telegram poll_updates cycle error: ${(err as Error).message}`);
        await sleepOrAbort(state.telegramIdleSleepMs, stopController.signal);
      }
    }
  })();

  const stop = async (): Promise<void> => {
    stopController.abort();
    wake?.();
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
    });
    await Promise.race([Promise.allSettled([outboxLoop, pollerLoop]), bound]);
    clearTimeout(timer);
    state.workersStop = null;
    state.outboxWake = null;
  };
  state.workersStop = stop;
  return { wakeOutbox: () => state.outboxWake?.(), stop };
}
