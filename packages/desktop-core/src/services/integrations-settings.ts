// Handlers: settings_get, settings_set, ai_probe, ai_set_provider, ai_usage_get.
// Ports crates/core/src/service/settings.rs and `ai_usage_get` from service/system.rs.

import { newCliAdapterConfig } from "../ai/cli-util";
import { discoverClaudeModels, discoverCodexModels, recommendedModelsForProvider } from "../ai/discovery";
import type { AiModelOption, ProbeResult } from "../ai/types";
import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import {
  ArgShapeError,
  argOptional,
  argRequired,
  asBool,
  asEnum,
  asObject,
  asString,
  asU32,
} from "./integrations-args";
import { guarded } from "./integrations-outbox";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_META,
  type AiProviderId,
  type CrawlPolicySettings,
  type ModelTierPair,
  type NotifyMode,
  type QuietHoursDto,
  type Settings,
  cliProviderForSettings,
  defaultSettings,
  emitHealthIfChanged,
  ensureNotShuttingDown,
  getIntegrations,
  loadSettings,
  nowMs,
  saveSettings,
} from "./integrations-state";

type Json = unknown;

// ---- patch parsing (`SettingsPatch`, serde semantics) --------------------------------------------

export interface CrawlPolicySettingsPatch {
  group_interval_minutes?: number;
  priority_interval_minutes?: number;
  hourly_page_load_budget?: number;
  daily_page_load_budget?: number;
  active_hours?: QuietHoursDto;
  max_scroll_steps?: number;
  max_posts_per_visit?: number;
  only_when_idle?: boolean;
}

export interface SettingsPatch {
  privacy_consent_accepted?: boolean;
  onboarding_completed?: boolean;
  launch_at_login?: boolean;
  /** Present with `null` clears the provider; absent leaves it unchanged. */
  ai_provider?: AiProviderId | null;
  model_tiers?: Partial<Record<AiProviderId, ModelTierPair>>;
  daily_ai_post_cap?: number;
  default_notify_mode?: NotifyMode;
  digest_interval_minutes?: number;
  quiet_hours_enabled?: boolean;
  quiet_hours?: QuietHoursDto;
  os_notifications_enabled?: boolean;
  crawl_policy?: CrawlPolicySettingsPatch;
  unmatched_retention_days?: number;
  debug_keep_ai_io?: boolean;
}

const field = (o: Record<string, Json>, key: string): Json => (o[key] === null ? undefined : o[key]);

function parseQuietHours(v: Json): QuietHoursDto {
  const o = asObject(v, "struct QuietHours");
  if (!("from" in o)) throw new ArgShapeError("missing field `from`");
  if (!("to" in o)) throw new ArgShapeError("missing field `to`");
  return { from: asString(o.from), to: asString(o.to) };
}

export function parseModelTierPair(v: Json): ModelTierPair {
  const o = asObject(v, "struct ModelTierMap");
  if (!("fast" in o)) throw new ArgShapeError("missing field `fast`");
  if (!("smart" in o)) throw new ArgShapeError("missing field `smart`");
  return { fast: asString(o.fast), smart: asString(o.smart) };
}

function parseModelTiers(v: Json): Partial<Record<AiProviderId, ModelTierPair>> {
  const o = asObject(v, "a map");
  const out: Partial<Record<AiProviderId, ModelTierPair>> = {};
  for (const [k, val] of Object.entries(o)) {
    const pid = asEnum(k, AI_PROVIDER_IDS);
    out[pid] = parseModelTierPair(val);
  }
  return out;
}

function parseCrawlPolicyPatch(v: Json): CrawlPolicySettingsPatch {
  const o = asObject(v, "struct CrawlPolicySettingsPatch");
  const out: CrawlPolicySettingsPatch = {};
  const u32s = [
    "group_interval_minutes",
    "priority_interval_minutes",
    "hourly_page_load_budget",
    "daily_page_load_budget",
    "max_scroll_steps",
    "max_posts_per_visit",
  ] as const;
  for (const k of u32s) {
    const f = field(o, k);
    if (f !== undefined) out[k] = asU32(f);
  }
  const hours = field(o, "active_hours");
  if (hours !== undefined) out.active_hours = parseQuietHours(hours);
  const idle = field(o, "only_when_idle");
  if (idle !== undefined) out.only_when_idle = asBool(idle);
  return out;
}

export function parseSettingsPatch(value: Json): SettingsPatch {
  const o = asObject(value, "struct SettingsPatch");
  const out: SettingsPatch = {};
  for (const k of ["privacy_consent_accepted", "onboarding_completed", "launch_at_login", "quiet_hours_enabled", "os_notifications_enabled", "debug_keep_ai_io"] as const) {
    const f = field(o, k);
    if (f !== undefined) out[k] = asBool(f);
  }
  if ("ai_provider" in o && o.ai_provider !== undefined) {
    out.ai_provider = o.ai_provider === null ? null : asEnum(o.ai_provider, AI_PROVIDER_IDS);
  }
  const tiers = field(o, "model_tiers");
  if (tiers !== undefined) out.model_tiers = parseModelTiers(tiers);
  for (const k of ["daily_ai_post_cap", "digest_interval_minutes", "unmatched_retention_days"] as const) {
    const f = field(o, k);
    if (f !== undefined) out[k] = asU32(f);
  }
  const mode = field(o, "default_notify_mode");
  if (mode !== undefined) out.default_notify_mode = asEnum(mode, ["instant", "digest"] as const);
  const qh = field(o, "quiet_hours");
  if (qh !== undefined) out.quiet_hours = parseQuietHours(qh);
  const cp = field(o, "crawl_policy");
  if (cp !== undefined) out.crawl_policy = parseCrawlPolicyPatch(cp);
  return out;
}

// ---- settings_get / settings_set -----------------------------------------------------------------

export function settingsGet(ctx: RuntimeContext): Settings {
  return loadSettings(ctx.store);
}

/** Apply a patch exactly as `CoreService::settings_set` does (including the `max(1)` floors). */
export async function settingsSet(ctx: RuntimeContext, patch: SettingsPatch): Promise<Settings> {
  ensureNotShuttingDown(ctx);
  const state = getIntegrations(ctx);
  const settings = loadSettings(ctx.store);
  let crawlChanged = false;

  if (patch.privacy_consent_accepted !== undefined) settings.privacy_consent_accepted = patch.privacy_consent_accepted;
  if (patch.onboarding_completed !== undefined) settings.onboarding_completed = patch.onboarding_completed;
  if (patch.launch_at_login !== undefined) settings.launch_at_login = patch.launch_at_login;
  const aiConfigChanged = patch.ai_provider !== undefined || patch.model_tiers !== undefined;
  if (patch.ai_provider !== undefined) settings.ai_provider = patch.ai_provider;
  if (patch.model_tiers !== undefined) settings.model_tiers = patch.model_tiers;
  if (patch.daily_ai_post_cap !== undefined) settings.daily_ai_post_cap = Math.max(1, patch.daily_ai_post_cap);
  if (patch.default_notify_mode !== undefined) settings.default_notify_mode = patch.default_notify_mode;
  if (patch.digest_interval_minutes !== undefined) settings.digest_interval_minutes = Math.max(1, patch.digest_interval_minutes);
  if (patch.quiet_hours_enabled !== undefined) settings.quiet_hours_enabled = patch.quiet_hours_enabled;
  if (patch.quiet_hours !== undefined) settings.quiet_hours = patch.quiet_hours;
  if (patch.os_notifications_enabled !== undefined) settings.os_notifications_enabled = patch.os_notifications_enabled;

  if (patch.crawl_policy) {
    const cp = patch.crawl_policy;
    const target: CrawlPolicySettings = settings.crawl_policy;
    for (const k of [
      "group_interval_minutes",
      "priority_interval_minutes",
      "hourly_page_load_budget",
      "daily_page_load_budget",
      "max_scroll_steps",
      "max_posts_per_visit",
    ] as const) {
      const v = cp[k];
      if (v !== undefined) {
        target[k] = Math.max(1, v);
        crawlChanged = true;
      }
    }
    if (cp.active_hours !== undefined) {
      target.active_hours = cp.active_hours;
      crawlChanged = true;
    }
    if (cp.only_when_idle !== undefined) {
      target.only_when_idle = cp.only_when_idle;
      crawlChanged = true;
    }
  }
  if (patch.unmatched_retention_days !== undefined) settings.unmatched_retention_days = Math.max(1, patch.unmatched_retention_days);
  if (patch.debug_keep_ai_io !== undefined) settings.debug_keep_ai_io = patch.debug_keep_ai_io;

  saveSettings(ctx.store, settings);
  if (aiConfigChanged && state.bridge.providerId() !== "mock" && settings.ai_provider !== null) {
    state.bridge.setProvider(cliProviderForSettings(settings.ai_provider, settings, ctx));
  }
  if (crawlChanged) state.hooks.bumpAndPushConfig?.(ctx);
  if (patch.launch_at_login !== undefined) state.hooks.onLaunchAtLoginChanged?.(ctx, patch.launch_at_login);
  await emitHealthIfChanged(ctx, nowMs());
  return settings;
}

// ---- ai_probe ------------------------------------------------------------------------------------

export interface AiModelOptionDto {
  id: string;
  label: string;
  recommended_tier?: string;
  source: string;
}

export interface ProbeResultDto {
  provider: AiProviderId;
  binary_name: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  flags_supported: boolean;
  latency_ms: number | null;
  error: string | null;
  install_hint: string;
  login_command: string;
  available_models: AiModelOptionDto[];
  recommended_fast_model?: string;
  recommended_smart_model?: string;
}

/** Probe the requested CLI(s). Rebalances default tier models onto locally discovered ones. */
export async function aiProbe(ctx: RuntimeContext, provider: AiProviderId | null): Promise<Record<string, ProbeResultDto>> {
  const state = getIntegrations(ctx);
  const settings = loadSettings(ctx.store);
  const defaults = defaultSettings();
  let settingsUpdated = false;
  const targets: AiProviderId[] = provider !== null ? [provider] : [...AI_PROVIDER_IDS];
  const out: Record<string, ProbeResultDto> = {};
  const isMock = (): boolean => state.bridge.providerId() === "mock";

  for (const pid of targets) {
    const meta = AI_PROVIDER_META[pid];
    let rawProbe: ProbeResult;
    if (isMock() || state.bridge.providerId() === pid) rawProbe = await state.bridge.probe();
    else rawProbe = await cliProviderForSettings(pid, settings, ctx).probe();

    let bridgeModels: AiModelOption[];
    if (isMock()) {
      const cfg = newCliAdapterConfig(meta.binary);
      bridgeModels =
        pid === "claude_cli" ? discoverClaudeModels(cfg, null) : pid === "codex_cli" ? discoverCodexModels(cfg) : rawProbe.available_models;
    } else {
      bridgeModels = rawProbe.available_models;
    }

    const [recFast, recSmart] = recommendedModelsForProvider(pid, bridgeModels);

    if (bridgeModels.some((m) => m.source === "local_cli")) {
      const cur = settings.model_tiers[pid];
      const def = defaults.model_tiers[pid];
      if (cur && def) {
        if (cur.fast === def.fast && !bridgeModels.some((m) => m.id === cur.fast) && recFast !== null) {
          cur.fast = recFast;
          settingsUpdated = true;
        }
        if (cur.smart === def.smart && !bridgeModels.some((m) => m.id === cur.smart) && recSmart !== null) {
          cur.smart = recSmart;
          settingsUpdated = true;
        }
      }
    }

    const dto: ProbeResultDto = {
      provider: pid,
      binary_name: meta.binary,
      installed: rawProbe.installed,
      version: rawProbe.version,
      authenticated: rawProbe.authenticated,
      flags_supported: rawProbe.flags_supported,
      latency_ms: rawProbe.latency_ms,
      error: rawProbe.error,
      install_hint: meta.installHint,
      login_command: meta.loginCommand,
      available_models: bridgeModels.map((m) => ({
        id: m.id,
        label: m.label,
        ...(m.recommended_tier !== undefined ? { recommended_tier: m.recommended_tier } : {}),
        source: m.source,
      })),
      ...(recFast !== null ? { recommended_fast_model: recFast } : {}),
      ...(recSmart !== null ? { recommended_smart_model: recSmart } : {}),
    };
    out[pid] = dto;
  }

  if (settingsUpdated) {
    try {
      saveSettings(ctx.store, settings);
    } catch {
      // `let _ = save_settings(..)`
    }
    if (!isMock() && settings.ai_provider !== null) {
      state.bridge.setProvider(cliProviderForSettings(settings.ai_provider, settings, ctx));
    }
  }
  return out;
}

// ---- ai_set_provider -----------------------------------------------------------------------------

export async function aiSetProvider(
  ctx: RuntimeContext,
  provider: AiProviderId,
  modelTiers: ModelTierPair | null,
): Promise<Settings> {
  ensureNotShuttingDown(ctx);
  const state = getIntegrations(ctx);
  const settings = loadSettings(ctx.store);
  settings.ai_provider = provider;
  if (modelTiers !== null) settings.model_tiers[provider] = modelTiers;
  saveSettings(ctx.store, settings);

  if (state.bridge.providerId() !== "mock") {
    state.bridge.setProvider(cliProviderForSettings(provider, settings, ctx));
  }
  state.aiHealth.lastError = null;
  state.aiHealth.firstUnavailableAt = null;
  await emitHealthIfChanged(ctx, nowMs());
  return settings;
}

// ---- ai_usage_get --------------------------------------------------------------------------------

export interface AiUsageStats {
  today_items: number;
  daily_cap: number;
  total_calls: number;
  total_items: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_ai_escalation_pct: number;
  daily: Array<{
    date: string;
    calls: number;
    items: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    ai_escalation_pct: number;
  }>;
}

export function aiUsageGet(ctx: RuntimeContext, days: number): AiUsageStats {
  const now = nowMs();
  const settings = loadSettings(ctx.store);
  const todayItems = ctx.store.aiCalls.countItemsToday(now);
  const report = ctx.store.aiCalls.usage(Math.max(1, days), now);
  return {
    today_items: todayItems,
    daily_cap: settings.daily_ai_post_cap,
    total_calls: report.total_calls,
    total_items: report.total_items,
    total_input_tokens: report.total_input_tokens,
    total_output_tokens: report.total_output_tokens,
    total_cost_usd: report.total_cost_usd,
    avg_ai_escalation_pct: report.overall_ai_escalation_rate * 100,
    daily: report.days.map((d) => ({
      date: d.date,
      calls: d.calls,
      items: d.items,
      input_tokens: d.input_tokens,
      output_tokens: d.output_tokens,
      cost_usd: d.cost_usd > 0 ? d.cost_usd : null,
      ai_escalation_pct: d.ai_escalation_rate * 100,
    })),
  };
}

// ---- handler table -------------------------------------------------------------------------------

const wrap = guarded;

/** `settings_get`, `settings_set`, `ai_probe`, `ai_set_provider`, `ai_usage_get`. */
export const SETTINGS_HANDLERS: HandlerTable = {
  settings_get: wrap((ctx) => settingsGet(ctx)),
  settings_set: wrap((ctx, args) => settingsSet(ctx, argRequired(args, "patch", parseSettingsPatch))),
  ai_probe: wrap((ctx, args) =>
    aiProbe(
      ctx,
      argOptional(args, "provider", (v) => asEnum(v, AI_PROVIDER_IDS)),
    ),
  ),
  ai_set_provider: wrap((ctx, args) =>
    aiSetProvider(
      ctx,
      argRequired(args, "provider", (v) => asEnum(v, AI_PROVIDER_IDS)),
      argOptional(args, "model_tiers", parseModelTierPair),
    ),
  ),
  ai_usage_get: wrap((ctx, args) => aiUsageGet(ctx, argOptional(args, "days", asU32) ?? 7)),
};
