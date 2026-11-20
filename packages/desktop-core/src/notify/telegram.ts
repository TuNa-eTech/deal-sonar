// Port of crates/notify/src/telegram.rs: Telegram Bot API client (`getMe`, rate-limited HTML
// sends, long-polling `getUpdates`, keyboard edits). The bot token is redacted from every error.

import { redactSecret } from "../secrets/types";
import { NotifyError } from "./errors";
import {
  type FormattedLeadAlert,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  buildAcknowledgedKeyboard,
  buildWrongReasonsKeyboard,
  escapeHtml,
  parseFeedbackCallbackData,
  validateHttpsPermalink,
} from "./format";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const DEFAULT_GET_UPDATES_TIMEOUT_S = 50;
export const MAX_TELEGRAM_NETWORK_RETRIES = 5;
/** Maximum time an outbox item may wait in queue before being dropped (2 hours). */
export const MAX_OUTBOX_QUEUE_AGE_MS = 2 * 60 * 60 * 1000;

/** Exponential backoff in seconds for `priorAttempts` (`0..5`); `null` once exhausted. */
export function telegramRetryBackoffS(priorAttempts: number): number | null {
  switch (priorAttempts) {
    case 0:
      return 10;
    case 1:
      return 30;
    case 2:
      return 120;
    case 3:
      return 300;
    case 4:
      return 600;
    default:
      return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-chat limiter: at most 1 message/second per chat and 20 messages/minute for groups
 * (`chat_id < 0`). Times are monotonic milliseconds.
 */
export class ChatRateLimiter {
  private readonly state = new Map<number, { lastSent: number | null; recentMinute: number[] }>();

  /** `null` when the send is allowed (and recorded); otherwise the milliseconds to wait. */
  checkAndRecord(chatId: number, now: number): number | null {
    const PER_CHAT_MIN_GAP = 1000;
    const GROUP_WINDOW = 60_000;
    const GROUP_MAX_PER_MIN = 20;

    let entry = this.state.get(chatId);
    if (!entry) {
      entry = { lastSent: null, recentMinute: [] };
      this.state.set(chatId, entry);
    }
    let requiredWait = 0;
    if (entry.lastSent !== null) {
      const elapsed = Math.max(0, now - entry.lastSent);
      if (elapsed < PER_CHAT_MIN_GAP) requiredWait = Math.max(requiredWait, PER_CHAT_MIN_GAP - elapsed);
    }
    if (chatId < 0) {
      while (entry.recentMinute.length > 0 && now - entry.recentMinute[0] >= GROUP_WINDOW) entry.recentMinute.shift();
      if (entry.recentMinute.length >= GROUP_MAX_PER_MIN) {
        const elapsed = now - entry.recentMinute[0];
        if (elapsed < GROUP_WINDOW) requiredWait = Math.max(requiredWait, GROUP_WINDOW - elapsed);
      }
    }
    if (requiredWait > 0) return requiredWait;
    entry.lastSent = now;
    if (chatId < 0) entry.recentMinute.push(now);
    return null;
  }

  async acquire(chatId: number, clock: () => number = () => performance.now()): Promise<void> {
    for (;;) {
      const wait = this.checkAndRecord(chatId, clock());
      if (wait === null) return;
      await sleep(Math.ceil(wait));
    }
  }
}

export interface BotInfo {
  id: number;
  username: string;
  first_name: string;
}

export interface SendMessageRequest {
  chat_id: number;
  text: string;
  parse_mode: string;
  link_preview_options: { is_disabled: boolean };
  reply_markup?: InlineKeyboardMarkup;
}

/** HTML message with link previews disabled (`SendMessageRequest::html`). */
export function sendMessageHtml(chatId: number, html: string, replyMarkup?: InlineKeyboardMarkup | null): SendMessageRequest {
  const req: SendMessageRequest = {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (replyMarkup) req.reply_markup = replyMarkup;
  return req;
}

export type TelegramDeliveryOutcome =
  | { kind: "sent"; message_id: number }
  | { kind: "rate_limited"; retry_after_s: number }
  | { kind: "auth_revoked" }
  | { kind: "retryable_network"; next_delay_s: number }
  | { kind: "dropped"; reason: string }
  | { kind: "permanent_failure"; status_code: number; description: string };

/** Rust `{:?}` rendering of an outcome, used verbatim in the `telegram_test` failure message. */
export function debugDeliveryOutcome(o: TelegramDeliveryOutcome): string {
  const q = (s: string): string => JSON.stringify(s);
  switch (o.kind) {
    case "sent":
      return `Sent { message_id: ${o.message_id} }`;
    case "rate_limited":
      return `RateLimited { retry_after_s: ${o.retry_after_s} }`;
    case "auth_revoked":
      return "AuthRevoked";
    case "retryable_network":
      return `RetryableNetwork { next_delay_s: ${o.next_delay_s} }`;
    case "dropped":
      return `Dropped { reason: ${q(o.reason)} }`;
    case "permanent_failure":
      return `PermanentFailure { status_code: ${o.status_code}, description: ${q(o.description)} }`;
  }
}

export interface BotStatusSummary {
  active_radars: number;
  leads_today: number;
  health_summary: string;
  notifications_paused: boolean;
}

export type TelegramIncomingEvent =
  | { kind: "start_command"; chat_id: number; chat_title: string; is_group: boolean }
  | { kind: "lead_feedback"; chat_id: number; lead_id: string; label: string }
  | { kind: "pause_command"; chat_id: number }
  | { kind: "resume_command"; chat_id: number }
  | { kind: "status_command"; chat_id: number };

export interface PollUpdatesOptions {
  offset: number | null;
  timeout_s: number;
  bot_username: string | null;
  registered_chat_ids: ReadonlySet<number>;
  /** Aborts the long poll (worker shutdown). */
  signal?: AbortSignal;
}

export interface PollUpdatesResult {
  events: TelegramIncomingEvent[];
  next_offset: number | null;
  rejected_unregistered_count: number;
}

export interface TelegramClientConfig {
  api_base_url: string;
  request_timeout_ms: number;
  enforce_rate_limits: boolean;
  /** HTTP transport (defaults to the global `fetch`); tests inject a controlled endpoint. */
  fetch?: typeof fetch;
}

export function defaultTelegramClientConfig(): TelegramClientConfig {
  return { api_base_url: DEFAULT_TELEGRAM_API_BASE_URL, request_timeout_ms: 15_000, enforce_rate_limits: true };
}

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asInt = (v: Json): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const asStr = (v: Json): string | null => (typeof v === "string" ? v : null);

interface TgEnvelope {
  ok: boolean;
  result: Json;
  error_code: number | null;
  description: string | null;
  retry_after: number | null;
}

/** Parse a Bot API envelope; `null` when the body is not a valid envelope. */
function parseEnvelope(body: string): TgEnvelope | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(body) as Json;
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.ok !== "boolean") return null;
  const params = isObject(parsed.parameters) ? parsed.parameters : null;
  const retryAfter = params ? asInt(params.retry_after) : null;
  return {
    ok: parsed.ok,
    result: parsed.result ?? null,
    error_code: asInt(parsed.error_code),
    description: asStr(parsed.description),
    retry_after: retryAfter !== null && retryAfter >= 0 ? retryAfter : null,
  };
}

function chatTitle(chat: JsonObject): string {
  const title = asStr(chat.title)?.trim();
  if (title) return title;
  const first = asStr(chat.first_name)?.trim() || null;
  const last = asStr(chat.last_name)?.trim() || null;
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  const username = asStr(chat.username)?.trim();
  return username ? username : String(chat.id);
}

/** `/cmd` or `/cmd@bot` from the first whitespace-delimited token. */
export function parseBotCommand(text: string): [string, string | null] | null {
  const first = text.split(/\s+/).find((t) => t !== "");
  if (!first || !first.startsWith("/")) return null;
  const at = first.indexOf("@");
  if (at >= 0) {
    const cmd = first.slice(0, at);
    const mention = first.slice(at + 1);
    return cmd.length > 1 && mention !== "" ? [cmd, mention] : null;
  }
  return first.length > 1 ? [first, null] : null;
}

export function botMentionMatches(mentioned: string | null, expectedBotUsername: string | null): boolean {
  if (mentioned === null) return true;
  const expected = expectedBotUsername?.trim().replace(/^@+/, "") ?? "";
  if (expected === "") return true;
  return mentioned.toLowerCase() === expected.toLowerCase();
}

function existingUrlButton(markup: Json): InlineKeyboardButton | null {
  if (!isObject(markup) || !Array.isArray(markup.inline_keyboard)) return null;
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (!isObject(btn) || typeof btn.url !== "string") continue;
      try {
        validateHttpsPermalink(btn.url);
      } catch {
        continue;
      }
      return {
        text: asStr(btn.text) ?? "",
        url: btn.url,
        ...(typeof btn.callback_data === "string" ? { callback_data: btn.callback_data } : {}),
      };
    }
  }
  return null;
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;
  private readonly enforceRateLimits: boolean;
  private readonly http: typeof fetch;
  readonly rateLimiter = new ChatRateLimiter();

  constructor(config: Partial<TelegramClientConfig> = {}) {
    const merged = { ...defaultTelegramClientConfig(), ...config };
    this.apiBase = merged.api_base_url.replace(/\/+$/, "");
    this.requestTimeoutMs = merged.request_timeout_ms;
    this.enforceRateLimits = merged.enforce_rate_limits;
    this.http = merged.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private endpoint(token: string, method: string): string {
    return `${this.apiBase}/bot${token}/${method}`;
  }

  /** Transport failure text with the token removed. */
  private sanitize(err: unknown, token: string): string {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    let text = e?.name === "TimeoutError" || e?.name === "AbortError" ? "request timed out" : (e?.message ?? String(err));
    const cause = e?.cause?.code ?? e?.cause?.message;
    if (cause) text = `${text}: ${cause}`;
    return redactSecret(text, token);
  }

  private async send(
    token: string,
    method: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: number; body: string; headers: Headers }> {
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const res = await this.http(this.endpoint(token, method), {
      method: init.method,
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      redirect: "error",
    });
    return { status: res.status, body: await res.text(), headers: res.headers };
  }

  /** Verify a bot token via `getMe`. */
  async getMe(token: string): Promise<BotInfo> {
    let resp: { status: number; body: string };
    try {
      resp = await this.send(token, "getMe", { method: "GET", timeoutMs: this.requestTimeoutMs });
    } catch (e) {
      throw NotifyError.telegramHttp(this.sanitize(e, token));
    }
    const env = parseEnvelope(resp.body);
    if (env) {
      if (env.ok && isObject(env.result)) {
        const id = asInt(env.result.id);
        const firstName = asStr(env.result.first_name);
        if (id !== null && firstName !== null) {
          return { id, username: asStr(env.result.username) ?? "", first_name: firstName };
        }
      }
      throw NotifyError.telegramApi(
        env.error_code ?? resp.status,
        redactSecret(env.description ?? `HTTP ${resp.status}`, token),
        env.retry_after,
      );
    }
    throw NotifyError.telegramApi(resp.status, redactSecret(resp.body, token), null);
  }

  /** Immediate lead alert (`prior_attempts = 0, queued_age_ms = 0`). */
  sendLeadAlert(token: string, chatId: number, alert: FormattedLeadAlert): Promise<TelegramDeliveryOutcome> {
    return this.deliverOutboxMessage(token, sendMessageHtml(chatId, alert.html, alert.reply_markup), 0, 0);
  }

  private classifyTransient(priorAttempts: number, reason: string): TelegramDeliveryOutcome {
    const next = telegramRetryBackoffS(priorAttempts);
    return next !== null
      ? { kind: "retryable_network", next_delay_s: next }
      : { kind: "dropped", reason: `exhausted ${MAX_TELEGRAM_NETWORK_RETRIES} retries: ${reason}` };
  }

  /**
   * Deliver a `SendMessageRequest` with per-chat rate limiting, 2h queue expiry, 5-attempt
   * exponential backoff, HTTP 429 `retry_after` and HTTP 401/403 `auth_revoked`.
   */
  async deliverOutboxMessage(
    token: string,
    req: SendMessageRequest,
    priorAttempts: number,
    queuedAgeMs: number,
  ): Promise<TelegramDeliveryOutcome> {
    if (queuedAgeMs > MAX_OUTBOX_QUEUE_AGE_MS) {
      return {
        kind: "dropped",
        reason: `queued_age_ms (${queuedAgeMs}) exceeded max queue age (${MAX_OUTBOX_QUEUE_AGE_MS})`,
      };
    }
    if (this.enforceRateLimits) await this.rateLimiter.acquire(req.chat_id);

    let resp: { status: number; body: string; headers: Headers };
    try {
      resp = await this.send(token, "sendMessage", { method: "POST", body: req, timeoutMs: this.requestTimeoutMs });
    } catch (e) {
      return this.classifyTransient(priorAttempts, this.sanitize(e, token));
    }

    const retryHeaderRaw = resp.headers.get("retry-after")?.trim() ?? "";
    const retryHeader = /^\d+$/.test(retryHeaderRaw) ? Number(retryHeaderRaw) : null;
    const env = parseEnvelope(resp.body);

    if (resp.status >= 200 && resp.status < 300 && env?.ok && isObject(env.result)) {
      const messageId = asInt(env.result.message_id);
      if (messageId !== null) return { kind: "sent", message_id: messageId };
    }

    const envCode = env?.error_code ?? null;
    const code = envCode !== null && envCode >= 0 && envCode <= 65535 ? envCode : resp.status;
    if (code === 401 || code === 403) return { kind: "auth_revoked" };
    if (code === 429) {
      return { kind: "rate_limited", retry_after_s: Math.max(1, env?.retry_after ?? retryHeader ?? 5) };
    }
    if (code >= 500 && code <= 599) {
      const desc = env?.description ?? `HTTP ${code}`;
      return this.classifyTransient(priorAttempts, redactSecret(desc, token));
    }
    const desc = env?.description ?? resp.body;
    return { kind: "permanent_failure", status_code: code, description: redactSecret(desc, token) };
  }

  /** Vietnamese onboarding message after `/start`. */
  sendWelcomeMessage(token: string, chatId: number, chatTitleText: string): Promise<TelegramDeliveryOutcome> {
    const html = `👋 <b>Đã kết nối DealSonar!</b>\n\nKênh <b>${escapeHtml(chatTitleText)}</b> đã sẵn sàng nhận thông báo tin mới. Bạn có thể dùng lệnh /status, /pause hoặc /resume bất cứ lúc nào.`;
    return this.deliverOutboxMessage(token, sendMessageHtml(chatId, html, null), 0, 0);
  }

  /** `/status` reply. */
  sendStatusReply(token: string, chatId: number, summary: BotStatusSummary): Promise<TelegramDeliveryOutcome> {
    const notifyState = summary.notifications_paused ? "Đang tạm dừng (/resume để bật lại)" : "Đang bật";
    const html = `📊 <b>Trạng thái DealSonar</b>\n\n• Radar đang chạy: ${summary.active_radars}\n• Tin khớp hôm nay: ${summary.leads_today}\n• Thông báo: ${notifyState}\n• Sức khoẻ: ${escapeHtml(summary.health_summary)}`;
    return this.deliverOutboxMessage(token, sendMessageHtml(chatId, html, null), 0, 0);
  }

  private async simpleCall(token: string, method: string, body: unknown): Promise<void> {
    let resp: { status: number; body: string };
    try {
      resp = await this.send(token, method, { method: "POST", body, timeoutMs: this.requestTimeoutMs });
    } catch (e) {
      throw NotifyError.telegramHttp(this.sanitize(e, token));
    }
    const env = parseEnvelope(resp.body);
    if (env) {
      if (env.ok) return;
      throw NotifyError.telegramApi(env.error_code ?? resp.status, redactSecret(env.description ?? "", token), env.retry_after);
    }
    if (resp.status >= 200 && resp.status < 300) return;
    throw NotifyError.telegramApi(resp.status, redactSecret(resp.body, token), null);
  }

  editMessageReplyMarkup(
    token: string,
    chatId: number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    return this.simpleCall(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(token: string, callbackQueryId: string, text: string | null): Promise<void> {
    return this.simpleCall(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text !== null ? { text } : {}),
    });
  }

  /**
   * One `getUpdates` long-poll cycle. Feedback callbacks and `/pause|/resume|/status` are rejected
   * unless the chat is registered; `/start` is accepted from any chat.
   */
  async pollUpdates(token: string, options: PollUpdatesOptions): Promise<PollUpdatesResult> {
    const httpTimeout = Math.max((options.timeout_s + 15) * 1000, this.requestTimeoutMs);
    let resp: { status: number; body: string };
    try {
      resp = await this.send(token, "getUpdates", {
        method: "POST",
        body: {
          ...(options.offset !== null ? { offset: options.offset } : {}),
          timeout: options.timeout_s,
          allowed_updates: ["message", "callback_query"],
        },
        timeoutMs: httpTimeout,
        signal: options.signal,
      });
    } catch (e) {
      throw NotifyError.telegramHttp(this.sanitize(e, token));
    }

    const env = parseEnvelope(resp.body);
    if (!env) throw NotifyError.telegramApi(resp.status, redactSecret(resp.body, token), null);
    if (!env.ok) {
      throw NotifyError.telegramApi(env.error_code ?? resp.status, redactSecret(env.description ?? "", token), env.retry_after);
    }

    const updates = Array.isArray(env.result) ? env.result : [];
    let nextOffset = options.offset;
    const events: TelegramIncomingEvent[] = [];
    let rejected = 0;

    for (const upd of updates) {
      if (!isObject(upd)) continue;
      const updateId = asInt(upd.update_id);
      if (updateId === null) continue;
      const candidate = updateId + 1;
      nextOffset = nextOffset === null ? candidate : Math.max(nextOffset, candidate);

      if (isObject(upd.message) && isObject(upd.message.chat)) {
        const msg = upd.message;
        const chat = msg.chat as JsonObject;
        const chatId = asInt(chat.id);
        const text = asStr(msg.text);
        const parsed = text !== null ? parseBotCommand(text) : null;
        if (chatId !== null && parsed) {
          const [cmd, target] = parsed;
          if (botMentionMatches(target, options.bot_username)) {
            if (cmd === "/start") {
              const kind = asStr(chat.type) ?? "";
              events.push({
                kind: "start_command",
                chat_id: chatId,
                chat_title: chatTitle(chat),
                is_group: kind === "group" || kind === "supergroup" || chatId < 0,
              });
            } else if (cmd === "/pause" || cmd === "/resume" || cmd === "/status") {
              if (options.registered_chat_ids.has(chatId)) {
                events.push({
                  kind: cmd === "/pause" ? "pause_command" : cmd === "/resume" ? "resume_command" : "status_command",
                  chat_id: chatId,
                });
              } else rejected += 1;
            }
          }
        }
      }

      if (isObject(upd.callback_query)) {
        const cb = upd.callback_query;
        const cbId = asStr(cb.id) ?? "";
        const msg = isObject(cb.message) && isObject(cb.message.chat) ? cb.message : null;
        if (!msg) {
          rejected += 1;
          continue;
        }
        const chatId = asInt((msg.chat as JsonObject).id);
        const messageId = asInt(msg.message_id);
        if (chatId === null || !options.registered_chat_ids.has(chatId)) {
          rejected += 1;
          continue;
        }
        const rawData = asStr(cb.data);
        if (rawData === null) continue;
        if (rawData === "noop") {
          await this.answerCallbackQuery(token, cbId, null).catch(() => undefined);
          continue;
        }
        const urlBtn = existingUrlButton(msg.reply_markup);
        const parsedCb = parseFeedbackCallbackData(rawData);
        if (!parsedCb) continue;
        const [leadId, action] = parsedCb;
        const edit = async (build: () => InlineKeyboardMarkup): Promise<void> => {
          // Mirrors `if let Ok(kb) = ...`: a keyboard that cannot be built is skipped.
          let kb: InlineKeyboardMarkup;
          try {
            kb = build();
          } catch {
            return;
          }
          if (messageId !== null) await this.editMessageReplyMarkup(token, chatId, messageId, kb).catch(() => undefined);
        };
        if (action === "correct") {
          await edit(() => buildAcknowledgedKeyboard("✅ Đã ghi nhận", urlBtn));
          await this.answerCallbackQuery(token, cbId, "✅ Đã ghi nhận").catch(() => undefined);
          events.push({ kind: "lead_feedback", chat_id: chatId, lead_id: leadId, label: "correct" });
        } else if (action === "wrong") {
          await edit(() => buildWrongReasonsKeyboard(leadId, urlBtn));
          await this.answerCallbackQuery(token, cbId, "Chọn lý do tin chưa đúng").catch(() => undefined);
        } else if (action === "irrelevant" || action === "peer" || action === "duplicate" || action === "spam") {
          await edit(() => buildAcknowledgedKeyboard("📝 Đã ghi nhận", urlBtn));
          await this.answerCallbackQuery(token, cbId, "📝 Đã ghi nhận").catch(() => undefined);
          events.push({ kind: "lead_feedback", chat_id: chatId, lead_id: leadId, label: action });
        }
      }
    }

    return { events, next_offset: nextOffset, rejected_unregistered_count: rejected };
  }
}
