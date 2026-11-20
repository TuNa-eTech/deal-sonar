// Handlers: license_get, license_set, diagnostic_bundle_create, data_backup, workspace_action,
// data_purge, data_delete_all. Ports crates/core/src/service/system.rs.

import * as fs from "node:fs";
import * as path from "node:path";

import type { HandlerTable, RuntimeContext } from "../backend/runtime";
import { CoreError } from "../backend/wire";
import { TELEGRAM_BOT_TOKEN_KEY, webhookChannelKey } from "../secrets/types";
import { Store } from "../store/store";
import { foldVi } from "../store/util";
import { argOptional, argRequired, asString, asU32 } from "./integrations-args";
import { type DiagnosticBundleResult, createDiagnosticBundle } from "./integrations-diagnostics";
import { LICENSE_TOKEN_SETTING_KEY, type LicenseStatus, enforcePlanLimitsOnStore } from "./integrations-license";
import { guarded } from "./integrations-outbox";
import {
  clearOutboxTrackerInMemory,
  computeHealthStatus,
  currentLicenseStatus,
  emitHealthIfChanged,
  ensureNotShuttingDown,
  getIntegrations,
  loadSettings,
  nowMs,
  tryGetSecret,
} from "./integrations-state";

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- license ------------------------------------------------------------------------------------

export function licenseGet(ctx: RuntimeContext): LicenseStatus {
  return currentLicenseStatus(ctx, nowMs());
}

/**
 * Install (or clear, with an empty key) a license. The Ed25519 signature is verified before the
 * token is stored; downgrades pause excess active radars without deleting data.
 */
export function licenseSet(ctx: RuntimeContext, licenseKey: string): LicenseStatus {
  ensureNotShuttingDown(ctx);
  const state = getIntegrations(ctx);
  const now = nowMs();
  const trimmed = licenseKey.trim();

  if (trimmed === "") {
    ctx.store.settings.delete(LICENSE_TOKEN_SETTING_KEY);
    const status = currentLicenseStatus(ctx, now);
    const paused = enforcePlanLimitsOnStore(ctx.store, status.limits, now);
    if (paused.length > 0) state.hooks.bumpAndPushConfig?.(ctx);
    return status;
  }

  const payload = state.licenseVerifier.verifyToken(trimmed);
  ctx.store.settings.set(LICENSE_TOKEN_SETTING_KEY, trimmed);
  const status = currentLicenseStatus(ctx, now);
  const paused = enforcePlanLimitsOnStore(ctx.store, status.limits, now);
  if (paused.length > 0 || (payload.expires_at !== null && payload.expires_at <= now)) {
    state.hooks.bumpAndPushConfig?.(ctx);
  }
  return status;
}

// ---- diagnostics / backup -----------------------------------------------------------------------

export async function diagnosticBundleCreate(ctx: RuntimeContext): Promise<DiagnosticBundleResult> {
  const now = nowMs();
  const settings = loadSettings(ctx.store);
  const health = await computeHealthStatus(ctx, now);
  const diagDir = path.join(ctx.config.dataDir, "diagnostics");
  fs.mkdirSync(diagDir, { recursive: true });
  const dest = path.join(diagDir, `dealsonar-diagnostics-${now}.zip`);

  // Secrets are read only to scrub accidental appearances in `.log` files.
  const extra: string[] = [];
  const bot = await tryGetSecret(ctx.secrets, TELEGRAM_BOT_TOKEN_KEY);
  if (bot !== null) extra.push(bot);
  const lic = ctx.store.settings.get<string>(LICENSE_TOKEN_SETTING_KEY);
  if (typeof lic === "string") extra.push(lic);
  for (const ch of ctx.store.channels.list()) {
    if (ch.kind !== "webhook") continue;
    const sec = await tryGetSecret(ctx.secrets, webhookChannelKey(ch.id));
    if (sec !== null) extra.push(sec);
  }

  return createDiagnosticBundle({
    store: ctx.store,
    health,
    settings,
    logsDir: ctx.config.logsDir,
    destPath: dest,
    extraSecretsToScrub: extra,
    nowMs: now,
    appVersion: ctx.config.appVersion,
  });
}

export async function dataBackup(ctx: RuntimeContext): Promise<{ path: string; created_at: number }> {
  const now = nowMs();
  const dir = path.join(ctx.config.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `dealsonar-backup-${now}.sqlite3`);
  await ctx.store.backupDatabase(dest);
  return { path: dest, created_at: now };
}

// ---- workspace actions --------------------------------------------------------------------------

const RESTORE_PENDING = "restore-pending.sqlite3";

function listBackups(ctx: RuntimeContext): { paths: string[]; pending: boolean } {
  const dir = path.join(ctx.config.dataDir, "backups");
  const files: string[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const ext = path.extname(name);
      if ((ext === ".sqlite3" || ext === ".db") && fs.statSync(p).isFile()) files.push(p);
    }
  }
  files.sort();
  files.reverse();
  return { paths: files, pending: fs.existsSync(path.join(ctx.config.dataDir, RESTORE_PENDING)) };
}

const inputField = (input: Json, key: string): Json => (isObject(input) ? input[key] : undefined);
const isI64 = (v: Json): v is number => typeof v === "number" && Number.isInteger(v);

/** `backups` | `restore` | `restore_cancel` | `rollback`. */
export function workspaceAction(ctx: RuntimeContext, action: string, input: Json): unknown {
  ensureNotShuttingDown(ctx);
  switch (action) {
    case "backups":
      return listBackups(ctx);

    case "restore": {
      if (inputField(input, "confirm") !== "KHOI PHUC") throw CoreError.validation("Nhập KHOI PHUC để xác nhận");
      const file = inputField(input, "path");
      if (typeof file !== "string") throw CoreError.validation("Chọn tệp sao lưu");
      Store.stageRestore(file, ctx.config.dataDir);
      return { restart_required: true };
    }

    case "restore_cancel": {
      const pending = path.join(ctx.config.dataDir, RESTORE_PENDING);
      if (fs.existsSync(pending)) fs.rmSync(pending);
      return { cancelled: true };
    }

    case "rollback": {
      const id = inputField(input, "radar_id");
      if (typeof id !== "string") throw CoreError.validation("Thiếu radar");
      const expected = inputField(input, "expected_version");
      if (!isI64(expected)) throw CoreError.validation("Thiếu phiên bản hiện tại");
      const target = inputField(input, "version");
      if (!isI64(target)) throw CoreError.validation("Chọn phiên bản");

      const state = getIntegrations(ctx);
      const radar = state.hooks.radar;
      if (!radar) throw CoreError.notImplemented("workspace_action:rollback");

      const current = radar.get(ctx, id) as {
        radar: { current_version: number };
        versions: Array<{
          version: number;
          description: string;
          user_profession: string | null;
          fields: unknown;
          match_policy: unknown;
        }>;
      };
      if (current.radar.current_version !== expected) {
        throw CoreError.validation("Radar đã thay đổi. Tải lại trước khi áp dụng.");
      }
      const version = current.versions.find((v) => v.version === target);
      if (!version) throw CoreError.validation("Phiên bản không thuộc radar");

      // Publish the old definition as a new immutable version, keeping all history.
      const result = radar.update(ctx, {
        id,
        description: version.description,
        user_profession: version.user_profession,
        fields: version.fields,
        match_policy: version.match_policy,
        confirm_version_upgrade: true,
      });
      state.hooks.bumpAndPushConfig?.(ctx);
      return result.detail;
    }

    default:
      throw CoreError.validation("Thao tác workspace không được hỗ trợ");
  }
}

// ---- data lifecycle -----------------------------------------------------------------------------

export function dataPurge(
  ctx: RuntimeContext,
  unmatchedRetentionDays: number | null,
): { posts_purged: number; evaluations_cleaned: number } {
  ensureNotShuttingDown(ctx);
  const now = nowMs();
  const days = unmatchedRetentionDays ?? loadSettings(ctx.store).unmatched_retention_days;
  const report = ctx.store.purgeExpired(now, days);
  const previewCleaned = ctx.store.leads.cleanupPreviewEvaluations(null, Math.max(0, now - 86_400_000));
  return { posts_purged: report.posts_purged, evaluations_cleaned: report.evaluations_scrubbed + previewCleaned };
}

/** Wipe every table, stored backups and the bot/webhook secrets after a typed confirmation. */
export async function dataDeleteAll(ctx: RuntimeContext, confirmPhrase: string): Promise<{ deleted: boolean }> {
  ensureNotShuttingDown(ctx);
  const state = getIntegrations(ctx);
  const normalized = foldVi(confirmPhrase).trim();
  if (normalized !== "xoa toan bo" && normalized !== "xoa tat ca") {
    throw CoreError.validation("Cụm xác nhận không khớp; vui lòng nhập đúng 'XOA TOAN BO'");
  }

  // Collect webhook secret keys before the database is wiped.
  let existingChannels: Array<{ id: string; kind: string }> = [];
  try {
    existingChannels = ctx.store.channels.list();
  } catch {
    existingChannels = [];
  }
  const pendingRestore = path.join(ctx.config.dataDir, RESTORE_PENDING);
  if (fs.existsSync(pendingRestore)) fs.rmSync(pendingRestore);
  ctx.store.deleteAllData();

  try {
    await ctx.secrets.deleteSecret(TELEGRAM_BOT_TOKEN_KEY);
  } catch {
    // `let _ =`
  }
  for (const ch of existingChannels) {
    if (ch.kind !== "webhook") continue;
    try {
      await ctx.secrets.deleteSecret(webhookChannelKey(ch.id));
    } catch {
      // `let _ =`
    }
  }

  clearOutboxTrackerInMemory(ctx);
  state.hooks.onDataDeleted?.(ctx);
  state.hooks.bumpAndPushConfig?.(ctx);
  await emitHealthIfChanged(ctx, nowMs());
  return { deleted: true };
}

/** `license_get`, `license_set`, `diagnostic_bundle_create`, `data_backup`, `workspace_action`, `data_purge`, `data_delete_all`. */
export const SYSTEM_HANDLERS: HandlerTable = {
  license_get: guarded((ctx) => licenseGet(ctx)),
  license_set: guarded((ctx, args) => licenseSet(ctx, argRequired(args, "license_key", asString))),
  diagnostic_bundle_create: guarded((ctx) => diagnosticBundleCreate(ctx)),
  data_backup: guarded((ctx) => dataBackup(ctx)),
  workspace_action: guarded((ctx, args) => {
    const action = argRequired(args, "action", asString);
    const input = argRequired(args, "input", (v) => v);
    return workspaceAction(ctx, action, input);
  }),
  data_purge: guarded((ctx, args) => dataPurge(ctx, argOptional(args, "unmatched_retention_days", asU32))),
  data_delete_all: guarded((ctx, args) => dataDeleteAll(ctx, argRequired(args, "confirm_phrase", asString))),
};
