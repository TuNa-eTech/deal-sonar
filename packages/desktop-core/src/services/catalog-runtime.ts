// Runtime plumbing for the catalog handlers: the injectable services (license limits, extension
// config push, job wake-up, rules engine) and the `CoreRuntime` helper methods the Rust service
// methods call (settings-backed maps, `ensure_not_shutting_down`, monotonic radar timestamps).

import type { RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import type { FieldDef } from "../store/domain";
import { StoreError } from "../store/errors";
import { type Decoder, SerdeError, dMap, dString, dVec, isPlainObject } from "./catalog-serde";
import type { EngineRulesetBody } from "./catalog-rules";
import type { NotifyMode } from "./catalog-types";

// ---- injectable services -----------------------------------------------------------------------

export type PlanTier = "personal" | "pro";

/** `LicenseLimits` (crates/core/src/dto/system.rs). */
export interface LicenseLimits {
  max_active_radars: number | null;
  max_followed_groups: number;
  max_fields_per_radar: number;
  allow_xlsx_export: boolean;
  allow_webhooks: boolean;
  allow_auto_rulesets: boolean;
}

/** Subset of `LicenseStatus` the catalog commands read. */
export interface LicenseView {
  plan: PlanTier;
  limits: LicenseLimits;
}

/** `limits_for_plan` (crates/core/src/license.rs). */
export function limitsForPlan(plan: PlanTier): LicenseLimits {
  return plan === "pro"
    ? {
        max_active_radars: null,
        max_followed_groups: 50,
        max_fields_per_radar: 20,
        allow_xlsx_export: true,
        allow_webhooks: true,
        allow_auto_rulesets: true,
      }
    : {
        max_active_radars: 2,
        max_followed_groups: 10,
        max_fields_per_radar: 12,
        allow_xlsx_export: false,
        allow_webhooks: false,
        allow_auto_rulesets: false,
      };
}

/** Rust `{:?}` of `PlanTier`, used verbatim in limit error messages. */
export const planDebug = (plan: PlanTier): string => (plan === "pro" ? "Pro" : "Personal");

/** One labeled sample handed to the holdout gate (`dealsonar_rules::LabeledSample`). */
export interface GateSample {
  post_text: string;
  ref_ts_ms: number;
  is_match: boolean;
  expected_fields: Record<string, unknown>;
}

/** `dealsonar_rules::GateReport`, restricted to what `ruleset_save_user` reads. */
export interface GateReport {
  passed: boolean;
  self_handled_rate: number;
  accept_precision: number;
  false_negative_rate: number;
  total_samples: number;
  pruned_ruleset: EngineRulesetBody;
}

/** Thrown by a `RulesEngine` for schema/regex/latency failures (`RulesetValidationError`). */
export class RulesetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetValidationError";
  }
}

/** Port of the rules engine entry points `ruleset_save_user` depends on. */
export interface RulesEngine {
  /** `validate_ruleset`: throws `RulesetValidationError` when the body is rejected. */
  validateRuleset(body: EngineRulesetBody): void;
  /** `evaluate_gate_with_fields`. */
  evaluateGate(body: EngineRulesetBody, fields: FieldDef[], samples: GateSample[]): GateReport;
}

export interface CatalogServices {
  /**
   * `CoreRuntime::current_license_status`. The default only knows the unlicensed (Personal)
   * state and refuses to guess when a token is stored; compose the license port here.
   */
  licenseView(ctx: RuntimeContext, now: number): LicenseView;
  /** `CoreRuntime::bump_and_push_config`: re-plan crawling and push `config.update` to extensions. */
  configChanged(ctx: RuntimeContext): void;
  /** `CoreRuntime::job_wake`: nudge the durable job loop after enqueueing a due job. */
  wakeJobs(ctx: RuntimeContext): void;
  /** Rules engine port; `ruleset_save_user` answers `not_implemented` while this is `null`. */
  rules: RulesEngine | null;
}

export const LICENSE_TOKEN_SETTING_KEY = "license.token";

export function defaultCatalogServices(): CatalogServices {
  return {
    licenseView(ctx) {
      const token = ctx.store.settings.get<unknown>(LICENSE_TOKEN_SETTING_KEY);
      if (typeof token === "string" && token.trim() !== "") {
        throw CoreError.internal("chưa cấu hình bộ xác thực bản quyền cho catalog (CatalogServices.licenseView)");
      }
      return { plan: "personal", limits: limitsForPlan("personal") };
    },
    configChanged: () => undefined,
    wakeJobs: () => undefined,
    rules: null,
  };
}

// ---- CoreRuntime helpers -----------------------------------------------------------------------

export function ensureNotShuttingDown(ctx: RuntimeContext): void {
  if (ctx.isShuttingDown()) throw CoreError.shuttingDown();
}

let lastRadarMutationMs = 0;

/** `monotonic_radar_now_ms`: strictly increasing so creation order stays deterministic. */
export function monotonicRadarNowMs(): number {
  const next = Math.max(Date.now(), lastRadarMutationMs + 1);
  lastRadarMutationMs = next;
  return next;
}

/** `store.get_setting::<T>`: a stored value that does not match `T` is a JSON `StoreError`. */
export function readSetting<T>(ctx: RuntimeContext, key: string, dec: Decoder<T>, fallback: () => T): T {
  const raw = ctx.store.settings.get<unknown>(key);
  if (raw === null) return fallback();
  try {
    return dec(raw);
  } catch (err) {
    if (err instanceof SerdeError) throw new StoreError("json", `JSON serialization error: ${err.message}`);
    throw err;
  }
}

export const FEEDBACK_BY_EVAL_KEY = "runtime.feedback_by_eval";
export const SOURCE_LAST_ERRORS_KEY = "runtime.source_last_errors";
export const FLOOD_AUTO_DIGEST_KEY = "runtime.flood_auto_digest_radars";

const dStringMap = dMap(dString);

export const getEvalFeedbackLabels = (ctx: RuntimeContext): Record<string, string> =>
  readSetting(ctx, FEEDBACK_BY_EVAL_KEY, dStringMap, () => ({}));

export function setEvalFeedbackLabel(ctx: RuntimeContext, evaluationId: string, label: string): void {
  const map = { ...getEvalFeedbackLabels(ctx), [evaluationId]: label };
  ctx.store.settings.set(FEEDBACK_BY_EVAL_KEY, Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export const getSourceLastErrors = (ctx: RuntimeContext): Record<string, string> =>
  readSetting(ctx, SOURCE_LAST_ERRORS_KEY, dStringMap, () => ({}));

export const getFloodAutoDigestRadars = (ctx: RuntimeContext): Set<string> =>
  new Set(readSetting(ctx, FLOOD_AUTO_DIGEST_KEY, dVec(dString), (): string[] => []));

/** `Settings.default_notify_mode`; `Settings::default()` is `instant` when nothing is saved yet. */
export function defaultNotifyMode(ctx: RuntimeContext): NotifyMode {
  const saved = ctx.store.settings.get<unknown>("app.settings");
  if (isPlainObject(saved) && (saved.default_notify_mode === "instant" || saved.default_notify_mode === "digest")) {
    return saved.default_notify_mode;
  }
  return "instant";
}
