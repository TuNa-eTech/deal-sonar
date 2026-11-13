// Mock handlers: settings, AI, Telegram, webhook, Chrome, and license.

import type {
  Settings,
  AiProviderId,
  TelegramSetupStatus,
  Channel,
  ChromeConnectResult,
  PlanTier,
} from "../../../types/ipc";
import type { MockCommandTable } from "./types";
import { nextId } from "../ids";
import { buildPlanLimits } from "../seed";
import { state } from "../store";

export const settingsCommands: MockCommandTable = {
  settings_get: async () => {
    return structuredClone(state.settings);
  },

  settings_set: async (args) => {
    const patch = (args.patch ?? args) as Partial<Settings>;
    state.settings = {
      ...state.settings,
      ...patch,
      crawl_policy: patch.crawl_policy
        ? { ...state.settings.crawl_policy, ...patch.crawl_policy }
        : state.settings.crawl_policy,
      model_tiers: patch.model_tiers
        ? { ...state.settings.model_tiers, ...patch.model_tiers }
        : state.settings.model_tiers,
    };
    return structuredClone(state.settings);
  },

  ai_probe: async () => {
    return structuredClone(state.probes);
  },

  ai_set_provider: async (args) => {
    const provider = args.provider as AiProviderId;
    state.settings.ai_provider = provider;
    if (args.model_tiers) {
      state.settings.model_tiers[provider] = args.model_tiers as Settings["model_tiers"][AiProviderId];
    }
    state.health.ai_provider = provider;
    state.health.ai_state = state.probes[provider]?.authenticated ? "ok" : "error";
    return structuredClone(state.settings);
  },

  telegram_set_token: async (args) => {
    const token = String(args.token ?? "").trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new Error("Định dạng Bot Token không hợp lệ (ví dụ: 123456789:AAHxyz...).");
    }
    const existingTg = state.channels.find((c) => c.kind === "telegram");
    if (!existingTg) {
      state.channels.push({
        id: nextId("01JCF9"),
        kind: "telegram",
        name: "Telegram Cá nhân (@dealsonar_alert_bot)",
        config: {
          chat_id: "581920311",
          bot_username: "dealsonar_alert_bot",
          chat_type: "private",
        },
        state: "ok",
        created_at: Date.now(),
      });
    }
    state.health.telegram_state = "ok";
    state.health.telegram_channel_count = state.channels.filter(
      (c) => c.kind === "telegram"
    ).length;
    const status: TelegramSetupStatus = {
      bot_username: "dealsonar_alert_bot",
      bot_link: "https://t.me/dealsonar_alert_bot",
      waiting_for_start: false,
      channels: structuredClone(state.channels.filter((c) => c.kind === "telegram")),
    };
    return status;
  },

  telegram_test: async () => {
    return {
      ok: true,
      message: "Đã gửi tin thử thành công tới Telegram!",
    };
  },

  channel_list: async () => {
    return structuredClone(state.channels);
  },

  channel_remove: async (args) => {
    const id = String(args.id ?? "");
    state.channels = state.channels.filter((c) => c.id !== id);
    state.health.telegram_channel_count = state.channels.filter(
      (c) => c.kind === "telegram"
    ).length;
    return { removed: true };
  },

  webhook_add: async (args) => {
    const url = String(args.url ?? "").trim();
    const name = String(args.name ?? "Webhook CRM").trim();
    if (!url.startsWith("https://") && !url.startsWith("http://localhost")) {
      throw new Error("Webhook chỉ chấp nhận địa chỉ https:// (hoặc http://localhost khi thử nghiệm tại máy).");
    }
    const ch: Channel = {
      id: nextId("01JCF9"),
      kind: "webhook",
      name,
      config: { url },
      state: "ok",
      created_at: Date.now(),
    };
    state.channels.push(ch);
    return structuredClone(ch);
  },

  chrome_connect: async (args) => {
    if (args.resume_crawl && state.health.facebook_session === "ok") {
      state.health.crawl_paused = false;
      state.health.crawl_pause_reason = null;
    }
    state.health.extension_connected = true;
    const res: ChromeConnectResult = {
      native_host_installed: true,
      manifest_path:
        "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json",
      extension_connected: state.health.extension_connected,
      facebook_session: state.health.facebook_session,
      message: "Đã ghi file khai báo Native Host và kết nối thành công với Chrome Extension.",
    };
    return res;
  },

  license_get: async () => {
    return structuredClone(state.license);
  },

  license_set: async (args) => {
    const key = String(args.license_key ?? "").trim();
    if (!key) {
      state.license = {
        plan: "personal",
        licensee: null,
        issued_at: null,
        expires_at: null,
        is_valid: true,
        key_preview: null,
        limits: buildPlanLimits("personal"),
      };
      return structuredClone(state.license);
    }
    const isPro = key.toUpperCase().startsWith("DS-PRO-") || key.length >= 16;
    const plan: PlanTier = isPro ? "pro" : "personal";
    const now = Date.now();
    state.license = {
      plan,
      licensee: isPro ? " Gói Chuyên nghiệp (Đã xác thực Ed25519)" : null,
      issued_at: now,
      expires_at: now + 365 * 86_400_000,
      is_valid: isPro,
      key_preview: `${key.slice(0, 8)}…${key.slice(-4)}`,
      limits: buildPlanLimits(plan),
    };
    return structuredClone(state.license);
  },
};
