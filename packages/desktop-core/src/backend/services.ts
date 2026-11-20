import type { Env } from "./config";
import type { HostBindings } from "./host";
import type { DesktopRuntimeDeps, RuntimeContext } from "./runtime";
import { CoreError } from "./wire";
import { createAgentBackend } from "../services/agent";
import { createCatalogHandlers, loadLeadDto } from "../services/catalog";
import { handleNegativeFeedbackOnRuleEval } from "../services/catalog-leads";
import { persistRadarDraft, radarGet, radarUpdate } from "../services/catalog-radars";
import { dEngineRulesetBody } from "../services/catalog-rules";
import { parseRulesetBody, rulesetBodyToJson, validateRuleset, RulesetValidationError as EngineValidationError } from "../rules/engine";
import { evaluateGateWithFields } from "../rules/gate";
import { RulesetValidationError, type CatalogServices } from "../services/catalog-runtime";
import { parseArg } from "../services/catalog-serde";
import { getTemplate } from "../services/catalog-templates";
import { dCreateRadarDraftInput, dUpdateRadarInput } from "../services/catalog-types";
import {
  currentLicenseStatus, enforcePlanLimitsOnStore, flushDigestForRadar, INTEGRATION_HANDLERS,
  queueSystemIncidentAlert, routeLeadNotifications, runNotifyLeadJob, shutdownIntegrations,
  startIntegrations,
} from "../services/integrations";
import { PipelineService } from "../services/pipeline";
import { PIPELINE_HANDLERS } from "../services/pipeline-handlers";
import { isSilentOrPreview, repostAfter72h } from "../pipeline/types";
import { makeEnvelope } from "../pipeline/runtime";
import { chromeBoundaryFromEnv, createChromeHandlers, refreshNativeHostManifestIfPaired, type ChromeConnectDeps, type ChromeProvisioning } from "../services/protocol-chrome";
import { EnvelopeParseError, errorEnvelope, parseEnvelope } from "../services/protocol-envelope";
import { isExtensionToDesktop } from "../services/protocol-types";

const pipeline = (ctx: RuntimeContext) => PipelineService.for(ctx);
const bumpAndPushConfig = (ctx: RuntimeContext) => pipeline(ctx).runtime.bumpAndPushConfig();
const wakeJobs = (ctx: RuntimeContext) => pipeline(ctx).runtime.wakeJobs();

const catalog: CatalogServices = {
  licenseView: currentLicenseStatus,
  configChanged: bumpAndPushConfig,
  wakeJobs,
  rules: {
    validateRuleset(body) {
      try {
        validateRuleset(parseRulesetBody(body));
      } catch (error) {
        if (error instanceof EngineValidationError) throw new RulesetValidationError(error.message);
        throw error;
      }
    },
    evaluateGate(body, fields, samples) {
      const report = evaluateGateWithFields(parseRulesetBody(body), fields, samples);
      return { ...report, pruned_ruleset: dEngineRulesetBody(rulesetBodyToJson(report.pruned_ruleset)) };
    },
  },
};

export function createDesktopServices(
  host: HostBindings,
  env: Env,
  provisioning?: ChromeProvisioning,
  log?: (message: string) => void,
): Partial<DesktopRuntimeDeps> {
  const boundary = chromeBoundaryFromEnv(env);
  const chromeDeps = (ctx: RuntimeContext): ChromeConnectDeps => {
    if (!provisioning) throw CoreError.internal("Native Messaging provisioning is unavailable");
    const svc = pipeline(ctx);
    const rt = svc.runtime;
    return {
      env, provisioning, boundary, logger: log,
      protocol: {
        now: () => rt.now(),
        hub: { get crawlPaused() { return rt.crawlPaused; }, healthSnapshot: (now) => rt.ipcSnapshot(now) },
        hooks: { emitHealthIfChanged: (now) => rt.emitHealthSoon(now) },
        resumeCrawlAfterReconnect: () => {
          if (!rt.crawlPaused) return false;
          rt.facebookSession = "ok";
          void svc.setCrawlPaused(false).catch((error: unknown) => log?.(String(error)));
          return true;
        },
        setCrawlPaused: (paused) => {
          const changed = rt.crawlPaused !== paused;
          void svc.setCrawlPaused(paused).catch((error: unknown) => log?.(String(error)));
          return changed;
        },
      },
    };
  };

  return {
    handlers: {
      ...createCatalogHandlers(catalog),
      ...INTEGRATION_HANDLERS,
      ...PIPELINE_HANDLERS,
      chrome_connect: (ctx, args) => createChromeHandlers(chromeDeps(ctx)).chrome_connect!(ctx, args),
      telegram_set_token: async (ctx, args) => {
        const result = await INTEGRATION_HANDLERS.telegram_set_token!(ctx, args);
        const rt = pipeline(ctx).runtime;
        rt.invalidateTelegramTokenCache();
        rt.emitHealthSoon(rt.now());
        return result;
      },
    },
    onStarted: async (ctx) => {
      const svc = pipeline(ctx);
      const rt = svc.runtime;
      svc.configure({
        log,
        templates: { get: (id) => getTemplate(id) },
        license: {
          limits: (now) => {
            const status = currentLicenseStatus(ctx, now);
            return { ...status.limits, plan: status.plan === "pro" ? "Pro" : "Personal" };
          },
          enforcePlanLimits: (now) => enforcePlanLimitsOnStore(ctx.store, currentLicenseStatus(ctx, now).limits, now),
        },
        notify: {
          queueSystemIncident: (incident, resolved, now) => { queueSystemIncidentAlert(ctx, incident, resolved, now); },
          routeLead: ({ mode, ...input }) => routeLeadNotifications(ctx, {
            ...input, isSilentOrPreview: isSilentOrPreview(mode), repostAfter72h: repostAfter72h(mode),
          }, { notifyDesktop: false }),
          runJob: async (kind, payload) => {
            if (kind === "notify_lead") await runNotifyLeadJob(ctx);
            else if (typeof payload.radar_id === "string") flushDigestForRadar(ctx, payload.radar_id);
            else throw CoreError.validation("flush_digest requires radar_id");
          },
        },
      });
      startIntegrations(ctx, { log, aiHealth: rt.aiHealth, hooks: {
        emitHealthIfChanged: (now) => rt.emitHealthIfChanged(now),
        ipcSnapshot: () => rt.ipcSnapshot(rt.now()),
        resumeCrawl: () => {
          if (!rt.crawlPaused || rt.facebookSession !== "ok") return false;
          void svc.setCrawlPaused(false).catch((error: unknown) => log?.(String(error)));
          return true;
        },
        bumpAndPushConfig, wakeJobs, loadLeadDto,
        onNegativeFeedback: (_ctx, evaluation, now) => { handleNegativeFeedbackOnRuleEval(ctx, catalog, evaluation, now); },
        onDataDeleted: () => { rt.previews.clear(); rt.latestPreviewByRadar.clear(); },
        radar: { get: radarGet, update: (ctx, input) => radarUpdate(ctx, catalog, parseArg({ input }, "input", dUpdateRadarInput)) },
      } });
      if (provisioning) {
        await refreshNativeHostManifestIfPaired(ctx, chromeDeps(ctx)).catch(() => {
          log?.("Could not refresh the Chrome Native Messaging manifest");
        });
      }
      svc.start();
    },
    onStopping: async (ctx) => {
      const results = await Promise.allSettled([pipeline(ctx).stop(), shutdownIntegrations(ctx)]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
    agentBackend: (ctx) => createAgentBackend(ctx, {
      AgentError: host.AgentError,
      hooks: {
        licenseLimits: (now) => currentLicenseStatus(ctx, now).limits,
        persistRadarDraft: (draft, id) => persistRadarDraft(ctx, catalog, dCreateRadarDraftInput(draft), id).rw,
        getRadarPreview: (radarId) => pipeline(ctx).radarPreviewGet(radarId, null),
        startRadarPreview: (radarId) => pipeline(ctx).radarPreviewStart({ radar_id: radarId }),
      },
    }),
    onExtensionConnection: (ctx, connection) => {
      const send = (envelope: unknown) => { void connection.sendEnvelope(envelope).catch(() => connection.close()); };
      const peer = pipeline(ctx).attachPeer({ send });
      connection.onClose(() => peer.detach());
      connection.onFrame((bytes) => {
        try {
          const envelope = parseEnvelope(bytes);
          if (!isExtensionToDesktop(envelope.type)) {
            send(errorEnvelope(envelope.id, "unknown_type", `unexpected message direction for type '${envelope.type}'`, false));
            return;
          }
          peer.consume({ ...envelope, payload: { ...envelope.payload } });
        } catch (error) {
          if (error instanceof EnvelopeParseError) send(error.toErrorEnvelope());
          else {
            log?.("Could not process native messaging frame");
            send(makeEnvelope("error", { code: "internal", message: "Could not process native messaging frame", retryable: true }));
          }
        }
      });
    },
  };
}
