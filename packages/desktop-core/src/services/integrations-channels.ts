// Handlers: telegram_set_token, telegram_test, channel_list, channel_remove, webhook_add.
// Ports crates/core/src/service/channels.rs.

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { debugDeliveryOutcome, sendMessageHtml } from "../notify/telegram";
import { generateWebhookSecret, validateWebhookUrl } from "../notify/webhook";
import { TELEGRAM_BOT_TOKEN_KEY, webhookChannelKey } from "../secrets/types";
import type { ChannelRecord } from "../store/ops";
import { argOptional, argRequired, asString } from "./integrations-args";
import { guarded } from "./integrations-outbox";
import {
  currentLicenseStatus,
  emitHealthIfChanged,
  ensureNotShuttingDown,
  getIntegrations,
  monotonicNowMs,
  nowMs,
  removeChannelFromOutboxTracker,
  telegramChatId,
} from "./integrations-state";

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ChannelDto {
  id: string;
  kind: string;
  name: string;
  config: { chat_id?: string; bot_username?: string; chat_type?: string; url?: string };
  state: string;
  last_error: string | null;
  created_at: number;
}

export interface TelegramSetupStatus {
  bot_username: string;
  bot_link: string;
  waiting_for_start: boolean;
  channels: ChannelDto[];
}

export function channelRecordToDto(r: ChannelRecord, botUsername: string | null): ChannelDto {
  const cfg = isObject(r.config) ? r.config : {};
  let chatId: string | undefined;
  if (typeof cfg.chat_id === "string") chatId = cfg.chat_id;
  else if (typeof cfg.chat_id === "number" && Number.isInteger(cfg.chat_id)) chatId = String(cfg.chat_id);
  const config: ChannelDto["config"] = {};
  if (chatId !== undefined) config.chat_id = chatId;
  if (r.kind === "telegram" && botUsername !== null) config.bot_username = botUsername;
  if (typeof cfg.chat_type === "string") config.chat_type = cfg.chat_type;
  if (typeof cfg.url === "string") config.url = cfg.url;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config,
    state: r.state,
    last_error: r.state === "error" ? "Channel delivery failed" : null,
    created_at: r.created_at,
  };
}

export function channelList(ctx: RuntimeContext): ChannelDto[] {
  const bot = ctx.store.settings.get<string>("telegram.bot_username");
  return ctx.store.channels.list().map((r) => channelRecordToDto(r, typeof bot === "string" ? bot : null));
}

export async function telegramSetToken(ctx: RuntimeContext, token: string): Promise<TelegramSetupStatus> {
  ensureNotShuttingDown(ctx);
  const state = getIntegrations(ctx);
  const cleaned = token.trim();
  if (cleaned === "") throw CoreError.validation("Telegram bot token cannot be empty");

  const botInfo = await state.telegram.getMe(cleaned);
  await ctx.secrets.setSecret(TELEGRAM_BOT_TOKEN_KEY, cleaned);
  ctx.store.settings.set("telegram.bot_username", botInfo.username);

  const tgChannels = channelList(ctx).filter((c) => c.kind === "telegram");
  await emitHealthIfChanged(ctx, nowMs());
  return {
    bot_username: botInfo.username,
    bot_link: `https://t.me/${botInfo.username}?start=dealsonar`,
    waiting_for_start: tgChannels.length === 0,
    channels: tgChannels,
  };
}

export interface TelegramTestResult {
  ok: boolean;
  message: string;
}

export async function telegramTest(ctx: RuntimeContext, channelId: string | null): Promise<TelegramTestResult> {
  const state = getIntegrations(ctx);
  const token = await ctx.secrets.getSecret(TELEGRAM_BOT_TOKEN_KEY);
  if (token === null) return { ok: false, message: "Chưa cấu hình Telegram Bot Token" };

  const all = ctx.store.channels.list();
  const target =
    channelId !== null ? all.find((c) => c.id === channelId && c.kind === "telegram") : all.find((c) => c.kind === "telegram");
  if (!target) return { ok: false, message: "Chưa có kênh Telegram nào gửi /start tới bot" };

  const chatId = telegramChatId(target.config);
  if (chatId === null) return { ok: false, message: "Cấu hình kênh Telegram thiếu chat_id" };

  const req = sendMessageHtml(chatId, "✅ <b>DealSonar</b>: Tin nhắn kiểm tra kết nối Telegram thành công!", null);
  const outcome = await state.telegram.deliverOutboxMessage(token, req, 0, 0);
  switch (outcome.kind) {
    case "sent":
      if (target.state !== "ok") {
        try {
          ctx.store.channels.setState(target.id, "ok");
          await emitHealthIfChanged(ctx, nowMs());
        } catch {
          // `let _ =`
        }
      }
      return { ok: true, message: `Đã gửi thành công (message_id=${outcome.message_id})` };
    case "auth_revoked":
      try {
        ctx.store.channels.setState(target.id, "error");
        await emitHealthIfChanged(ctx, nowMs());
      } catch {
        // `let _ =`
      }
      return { ok: false, message: "Bot bị chặn hoặc token đã bị thu hồi (401/403)" };
    default:
      return { ok: false, message: `Gửi thử thất bại: ${debugDeliveryOutcome(outcome)}` };
  }
}

export async function channelRemove(ctx: RuntimeContext, id: string): Promise<{ removed: boolean }> {
  ensureNotShuttingDown(ctx);
  const existing = ctx.store.channels.get(id);
  const removed = ctx.store.channels.delete(id);
  if (removed) removeChannelFromOutboxTracker(ctx, id);
  if (existing && existing.kind === "webhook") {
    try {
      await ctx.secrets.deleteSecret(webhookChannelKey(existing.id));
    } catch {
      // `let _ =`: a stale secret must not fail the removal
    }
  }
  await emitHealthIfChanged(ctx, nowMs());
  return { removed };
}

export async function webhookAdd(ctx: RuntimeContext, name: string, url: string, secret: string | null): Promise<ChannelDto> {
  ensureNotShuttingDown(ctx);
  const now = monotonicNowMs();
  const license = currentLicenseStatus(ctx, now);
  if (!license.limits.allow_webhooks) {
    throw CoreError.licenseLimit("Webhook channels require the Pro (Chuyên nghiệp) plan");
  }
  if (name.trim() === "") throw CoreError.validation("Webhook channel name cannot be empty");

  const validated = validateWebhookUrl(url);
  const effectiveSecret = secret !== null && secret.trim() !== "" ? secret.trim() : generateWebhookSecret();

  const created = ctx.store.channels.create("webhook", name.trim(), { url: validated.href, include_post_text: false }, now);
  try {
    await ctx.secrets.setSecret(webhookChannelKey(created.id), effectiveSecret);
  } catch (err) {
    // Do not leave a channel that can never sign a delivery.
    ctx.store.channels.delete(created.id);
    throw err;
  }
  const bot = ctx.store.settings.get<string>("telegram.bot_username");
  return channelRecordToDto(created, typeof bot === "string" ? bot : null);
}

/** `telegram_set_token`, `telegram_test`, `channel_list`, `channel_remove`, `webhook_add`. */
export const CHANNEL_HANDLERS: HandlerTable = {
  telegram_set_token: guarded((ctx, args) => telegramSetToken(ctx, argRequired(args, "token", asString))),
  telegram_test: guarded((ctx, args) => telegramTest(ctx, argOptional(args, "channel_id", asString))),
  channel_list: guarded((ctx) => channelList(ctx)),
  channel_remove: guarded((ctx, args) => channelRemove(ctx, argRequired(args, "id", asString))),
  webhook_add: guarded((ctx, args) =>
    webhookAdd(
      ctx,
      argRequired(args, "name", asString),
      argRequired(args, "url", asString),
      argOptional(args, "secret", asString),
    ),
  ),
};
