// Catalog command handlers: the Store-backed desktop commands of the radar/source/lead/post/
// contact/blocklist/ruleset catalog, ported from crates/core/src/service/* and the
// `invoke_command_json` arms of apps/desktop/src/commands/dispatch.rs.
//
// Composition (backend/handlers.ts, owned by the coordinator):
//
//   import { CATALOG_HANDLERS } from "../services/catalog";
//   export const DEFAULT_HANDLERS: HandlerTable = { ...CATALOG_HANDLERS, ... };
//
// `CATALOG_HANDLERS` runs with the default `CatalogServices` (unlicensed Personal limits, no
// extension config push, no rules engine). Real wiring uses
// `createCatalogHandlers({ licenseView, configChanged, wakeJobs, rules })`.

import type { HandlerTable } from "../backend/runtime";
import { createContactHandlers } from "./catalog-contacts";
import { createLeadHandlers } from "./catalog-leads";
import { createPostHandlers } from "./catalog-posts";
import { createRadarHandlers } from "./catalog-radars";
import { createRulesetHandlers } from "./catalog-rulesets";
import { type CatalogServices, defaultCatalogServices } from "./catalog-runtime";
import { createSourceHandlers } from "./catalog-sources";

/** Every command this module answers. `source_crawl_now`, `radar_set_status` and `ruleset_compile_now` are pipeline-owned. */
export const CATALOG_COMMANDS = [
  "source_list",
  "source_follow",
  "source_unfollow",
  "source_set_priority",
  "radar_list",
  "radar_get",
  "radar_create_draft",
  "radar_update",
  "radar_stats",
  "template_list",
  "template_get",
  "lead_list",
  "lead_get",
  "lead_mark_read",
  "lead_set_status",
  "lead_update_field",
  "lead_feedback",
  "post_get",
  "post_list_by_source",
  "post_search",
  "evaluation_list_rejected",
  "contact_list",
  "contact_get",
  "contact_block",
  "contact_note",
  "blocklist_list",
  "blocklist_add",
  "blocklist_remove",
  "ruleset_list",
  "ruleset_save_user",
] as const;

export function createCatalogHandlers(overrides: Partial<CatalogServices> = {}): HandlerTable {
  const services: CatalogServices = { ...defaultCatalogServices(), ...overrides };
  return {
    ...createSourceHandlers(services),
    ...createRadarHandlers(services),
    ...createLeadHandlers(services),
    ...createPostHandlers(),
    ...createContactHandlers(),
    ...createRulesetHandlers(services),
  };
}

export const CATALOG_HANDLERS: HandlerTable = createCatalogHandlers();

export {
  AUDIT_DISAGREEMENT_DEMOTE_THRESHOLD,
  AUDIT_MIN_SAMPLES,
  enqueueAndWakeJob,
  handleNegativeFeedbackOnRuleEval,
  recordAuditEntriesAndMaybeDemote,
} from "./catalog-leads";
export { leadDetailToLeadDto, leadExpiresAt, loadLeadDto } from "./catalog-convert";
export { persistRadarDraft, buildRadarDetailDto } from "./catalog-radars";
export {
  type CatalogServices,
  type GateReport,
  type GateSample,
  type LicenseLimits,
  type LicenseView,
  type PlanTier,
  type RulesEngine,
  RulesetValidationError,
  defaultCatalogServices,
  limitsForPlan,
} from "./catalog-runtime";
export { seedRuleset, type EngineRulesetBody } from "./catalog-rules";
export { getTemplate, loadTemplates } from "./catalog-templates";
export { MAX_PRIORITY_SOURCES } from "./catalog-sources";
