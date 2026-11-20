// Integrations service entry point (AI CLI bridge, Telegram, signed webhooks/outbox, license,
// diagnostics, backup, export, workspace actions, data lifecycle).
//
// Composition (done by the coordinator, not here):
//
//   import { INTEGRATION_HANDLERS, startIntegrations, shutdownIntegrations } from "./services/integrations";
//   const handlers = { ...DEFAULT_HANDLERS, ...INTEGRATION_HANDLERS, ...otherWorkers };
//   // after DesktopRuntime.start(): startIntegrations(runtime.context, { hooks, log })
//   // in DesktopRuntime.shutdown(): await shutdownIntegrations(runtime.context)

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CHANNEL_HANDLERS } from "./integrations-channels";
import { EXPORT_HANDLERS } from "./integrations-export";
import { enforcePlanLimitsOnStore } from "./integrations-license";
import { type IntegrationWorkers, startIntegrationWorkers } from "./integrations-outbox";
import { SETTINGS_HANDLERS } from "./integrations-settings";
import {
  type IntegrationDeps,
  type IntegrationState,
  configureIntegrations,
  currentLicenseStatus,
  getIntegrations,
} from "./integrations-state";
import { SYSTEM_HANDLERS } from "./integrations-system";

export { CHANNEL_HANDLERS, EXPORT_HANDLERS, SETTINGS_HANDLERS, SYSTEM_HANDLERS };

/**
 * All handler ids this port serves (18 of the 58 backend commands):
 * lead_export, settings_get, settings_set, ai_probe, ai_set_provider, telegram_set_token,
 * telegram_test, channel_list, channel_remove, webhook_add, license_get, license_set,
 * ai_usage_get, diagnostic_bundle_create, data_backup, workspace_action, data_purge, data_delete_all.
 */
export const INTEGRATION_HANDLERS: HandlerTable = {
  ...EXPORT_HANDLERS,
  ...SETTINGS_HANDLERS,
  ...CHANNEL_HANDLERS,
  ...SYSTEM_HANDLERS,
};

export const INTEGRATION_COMMAND_IDS: readonly string[] = [
  "lead_export",
  "settings_get",
  "settings_set",
  "ai_probe",
  "ai_set_provider",
  "telegram_set_token",
  "telegram_test",
  "channel_list",
  "channel_remove",
  "webhook_add",
  "license_get",
  "license_set",
  "ai_usage_get",
  "diagnostic_bundle_create",
  "data_backup",
  "workspace_action",
  "data_purge",
  "data_delete_all",
];

export interface StartIntegrationsOptions extends IntegrationDeps {
  /** Spawn the outbox + Telegram poller loops (default true). */
  startWorkers?: boolean;
  log?: (message: string) => void;
}

export interface StartedIntegrations {
  state: IntegrationState;
  workers: IntegrationWorkers | null;
}

/**
 * Boot the integrations (`CoreServiceBuilder::start`): apply injected deps, restore the AI
 * provider selection and outbox tracker, enforce plan limits (a Pro license may have expired while
 * the app was closed) and start the delivery workers.
 */
export function startIntegrations(ctx: RuntimeContext, options: StartIntegrationsOptions = {}): StartedIntegrations {
  const { startWorkers = true, log, ...deps } = options;
  const state = Object.keys(deps).length > 0 ? configureIntegrations(ctx, deps) : getIntegrations(ctx);

  const now = Date.now();
  const paused = enforcePlanLimitsOnStore(ctx.store, currentLicenseStatus(ctx, now).limits, now);
  if (paused.length > 0) state.hooks.bumpAndPushConfig?.(ctx);

  const workers = startWorkers ? startIntegrationWorkers(ctx, { log }) : null;
  return { state, workers };
}

/** Wait (<= 10 s) for in-flight AI calls, then stop the workers. Call before closing the store. */
export async function shutdownIntegrations(ctx: RuntimeContext): Promise<void> {
  const state = getIntegrations(ctx);
  await state.waitForInflightAi(10_000);
  await state.workersStop?.();
}

export * from "./integrations-ai";
export * from "./integrations-channels";
export * from "./integrations-diagnostics";
export * from "./integrations-export";
export * from "./integrations-license";
export {
  asCoreError,
  deliverSingleOutboxItem,
  enqueueDigestLead,
  flushDigestForRadar,
  getFloodAutoDigestRadars,
  guarded,
  handleTelegramIncomingEvent,
  markRadarFloodAutoDigest,
  parseTelegramSendRequest,
  pollTelegramOnce,
  processDueOutboxBatch,
  routeLeadNotifications,
  runNotifyLeadJob,
  setEvalFeedbackLabel,
  startIntegrationWorkers,
  type IntegrationWorkers,
  type RouteLeadNotificationsInput,
} from "./integrations-outbox";
export * from "./integrations-settings";
export {
  type AiProviderId,
  type HealthStatus,
  type IntegrationDeps,
  type IntegrationHooks,
  type IpcHealthSnapshot,
  type Settings,
  computeHealthStatus,
  configureIntegrations,
  currentLicenseStatus,
  defaultSettings,
  emitHealthIfChanged,
  enqueueOutboxTracked,
  getIntegrations,
  loadSettings,
  normalizeSettings,
  queueSystemIncidentAlert,
  resetIntegrations,
  saveSettings,
} from "./integrations-state";
export * from "./integrations-system";
