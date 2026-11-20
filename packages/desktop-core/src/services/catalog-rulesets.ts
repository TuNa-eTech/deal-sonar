// `ruleset_list` and `ruleset_save_user` (crates/core/src/service/rulesets.rs and
// `save_user_ruleset` in preview_rules/rulesets.rs). `ruleset_compile_now` belongs to the
// pipeline/AI port.

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CommandError, CoreError } from "../backend/wire";
import { nowMs } from "../store/util";
import {
  type RulesetBodyDto,
  dRulesetBodyDto,
  dtoBodyToEngine,
  rulesetRecordToWire,
} from "./catalog-rules";
import { type CatalogServices, type GateSample, RulesetValidationError, ensureNotShuttingDown } from "./catalog-runtime";
import { dString, parseArg, parseOptArg, sortedJson } from "./catalog-serde";

export function rulesetList(ctx: RuntimeContext, radarId: string, radarVersionId: string | null): unknown[] {
  let target: string;
  if (radarVersionId !== null && radarVersionId.trim() !== "") {
    target = radarVersionId;
  } else {
    const rw = ctx.store.radars.get(radarId);
    if (!rw) throw CoreError.notFound("radar", radarId);
    target = rw.current_version.id;
  }
  return ctx.store.radars.listRulesets(target).map(rulesetRecordToWire);
}

/**
 * `save_user_ruleset`: validate the DSL, then gate it against labeled samples when at least ten
 * exist (a passing gate activates it, otherwise it starts in `shadow`).
 */
export function saveUserRuleset(
  ctx: RuntimeContext,
  services: CatalogServices,
  radarVersionId: string,
  body: RulesetBodyDto,
  now: number,
): unknown {
  const version = ctx.store.radars.getVersion(radarVersionId);
  if (!version) throw CoreError.notFound("radar_version", radarVersionId);

  const rules = services.rules;
  if (!rules) throw CoreError.notImplemented("ruleset_save_user");

  const engineBody = dtoBodyToEngine(body);
  try {
    rules.validateRuleset(engineBody);
  } catch (err) {
    if (err instanceof RulesetValidationError) {
      throw new CommandError("validation_error", `bộ quy tắc không hợp lệ: ${err.message}`);
    }
    throw err;
  }

  const labeled = ctx.store.leads.getLabeledDataset(radarVersionId);
  let state = "active";
  let finalBody = engineBody;
  let metrics: unknown = null;
  if (labeled.length >= 10) {
    const samples: GateSample[] = labeled.map((s) => ({
      post_text: s.post_text,
      ref_ts_ms: now,
      is_match: s.is_match,
      expected_fields: Object.fromEntries(Object.entries(s.fields ?? {}).map(([k, v]) => [k, v.value])),
    }));
    const gate = rules.evaluateGate(engineBody, version.fields, samples);
    const pct = Math.round(gate.self_handled_rate * 100);
    metrics = sortedJson({
      rule_handled_pct: pct,
      ai_handled_pct: Math.max(100 - pct, 0),
      accept_precision: gate.accept_precision,
      false_negative_rate: gate.false_negative_rate,
      sample_size: gate.total_samples,
    });
    state = gate.passed ? "active" : "shadow";
    finalBody = gate.pruned_ruleset;
  }

  const saved = ctx.store.radars.insertRuleset({
    id: null,
    radar_version_id: radarVersionId,
    state,
    origin: "user",
    body: sortedJson(finalBody),
    metrics,
    now_ms: now,
  });
  return rulesetRecordToWire(saved);
}

export function rulesetSaveUser(
  ctx: RuntimeContext,
  services: CatalogServices,
  radarId: string,
  radarVersionId: string,
  body: RulesetBodyDto,
): unknown {
  ensureNotShuttingDown(ctx);
  const rw = ctx.store.radars.get(radarId);
  if (!rw) throw CoreError.notFound("radar", radarId);
  const belongs =
    rw.current_version.id === radarVersionId ||
    (rw.candidate_version !== null && rw.candidate_version.id === radarVersionId);
  if (!belongs) {
    throw CoreError.validation(`radar_version_id '${radarVersionId}' does not belong to radar '${radarId}'`);
  }
  return saveUserRuleset(ctx, services, radarVersionId, body, nowMs());
}

export function createRulesetHandlers(services: CatalogServices): HandlerTable {
  return {
    ruleset_list: (ctx, args) =>
      rulesetList(ctx, parseArg(args, "radar_id", dString), parseOptArg(args, "radar_version_id", dString)),
    ruleset_save_user: (ctx, args) =>
      rulesetSaveUser(
        ctx,
        services,
        parseArg(args, "radar_id", dString),
        parseArg(args, "radar_version_id", dString),
        parseArg(args, "body", dRulesetBodyDto),
      ),
  };
}
