#!/usr/bin/env node
/**
 * Scores the H5 account-safety observation: at least three trial accounts, each following ten
 * groups on the default scan settings for 30 days, with how many were restricted.
 *
 * Rules mirror `docs/delivery/02-validation-plan.md` §6 and `docs/delivery/studies/h5-account-safety/README.md`
 * and are fixed before the observation starts. The report never calls a pass or a fail until at
 * least three accounts have been observed long enough.
 *
 * Usage: node scripts/account-safety-report.mjs [accounts.json] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default scan settings (`CrawlPolicySettings::default()` in crates/core/src/dto/system.rs). */
export const DEFAULT_CONFIG = Object.freeze({
  group_interval_minutes: 15,
  priority_interval_minutes: 5,
  hourly_page_load_budget: 60,
  daily_page_load_budget: 600,
  active_hours: { from: "07:00", to: "23:00" },
  max_scroll_steps: 3,
  max_posts_per_visit: 25,
  only_when_idle: false,
});

export const RULES = Object.freeze({
  accounts: 3,
  groupsPerAccount: 10,
  /** Calendar days from the first to the last observed day, inclusive. */
  observationDays: 30,
  /** At least this share of those days must have a real observation. */
  minObservedShare: 0.9,
  maxGapDays: 3,
  /** More than this many verifications per account, on average, triggers halving the frequency. */
  verificationsPerAccount: 1,
});

export const AGE_BUCKETS = ["under-1y", "1-3y", "over-3y"];
export const ACTIVITY_LEVELS = ["low", "medium", "high"];
/** `restriction` and `lock` mean Facebook restricted or locked the account; the others do not. */
export const INCIDENT_KINDS = ["verification", "logout", "rate_limit_notice", "restriction", "lock", "other"];
const RESTRICTING = new Set(["restriction", "lock"]);

const DAY_MS = 86_400_000;
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

export function sameConfig(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** Map the app's account-safety report (JSON from the Health screen or diagnostic bundle) to study fields. */
export function fromAppReport(report) {
  const kinds = { checkpoint: "verification", logged_out: "logout", rate_limited: "rate_limit_notice", unknown: "other" };
  const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    config: report.crawl_policy,
    groups: report.followed_groups,
    observed_days: (report.active_days ?? []).map((day) => day.date),
    incidents: (report.incidents ?? []).map((incident) => ({
      at: new Date(incident.occurred_at).toISOString(),
      kind: kinds[incident.kind] ?? "other",
      page_loads_24h: incident.page_loads_24h,
      scanning_paused: incident.scanning_paused,
      resolved_on: incident.resolved_at ? toDate(incident.resolved_at) : null,
      note: incident.detail ?? "",
      source: "app",
    })),
  };
}

/** Combine hand-entered facts with one or more app exports, without double counting. */
export function withAppReports(account) {
  const merged = { ...account, observed_days: [...(account.observed_days ?? [])], incidents: [...(account.incidents ?? [])] };
  for (const report of account.app_reports ?? []) {
    const mapped = fromAppReport(report);
    merged.config = merged.config ?? mapped.config;
    merged.groups = merged.groups ?? mapped.groups;
    merged.observed_days.push(...mapped.observed_days);
    for (const incident of mapped.incidents) {
      if (!merged.incidents.some((known) => known.at === incident.at && known.kind === incident.kind)) merged.incidents.push(incident);
    }
  }
  merged.observed_days = [...new Set(merged.observed_days)].sort();
  merged.incidents.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return merged;
}

export function validateAccount(account) {
  const errors = [];
  const where = account?.id ?? "(không có id)";
  const need = (ok, message) => { if (!ok) errors.push(`${where}: ${message}`); };
  need(/^A\d{1,2}$/.test(account?.id ?? ""), "id phải dạng A1…A99, không dùng tên hay email tài khoản");
  need(AGE_BUCKETS.includes(account?.account_age), `account_age phải là một trong ${AGE_BUCKETS.join(", ")}`);
  need(ACTIVITY_LEVELS.includes(account?.activity), `activity phải là một trong ${ACTIVITY_LEVELS.join(", ")}`);
  need(isDate(account?.started_on), "started_on phải là YYYY-MM-DD");
  need(Number.isInteger(account?.groups) && account.groups >= 0, "groups phải là số nhóm đang theo dõi");
  need(account?.config && typeof account.config === "object", "thiếu config (cấu hình quét đang dùng)");
  need((account?.observed_days ?? []).every(isDate), "observed_days chỉ gồm ngày YYYY-MM-DD");
  for (const incident of account?.incidents ?? []) {
    need(!Number.isNaN(Date.parse(incident?.at)), "mỗi sự cố cần at dạng ISO 8601");
    need(INCIDENT_KINDS.includes(incident?.kind), `kind của sự cố phải là một trong ${INCIDENT_KINDS.join(", ")}`);
    need(Number.isInteger(incident?.page_loads_24h) && incident.page_loads_24h >= 0, "mỗi sự cố cần page_loads_24h (số lần tải trong 24 giờ trước)");
    need(incident?.scanning_paused === true, "mỗi sự cố phải ghi scanning_paused: true, tức là quét đã dừng; nếu quét không dừng, ghi rõ trong note và sửa lỗi trước khi tiếp tục");
  }
  return errors;
}

/** How long and how completely an account was watched. */
export function observation(account) {
  const days = [...new Set(account.observed_days ?? [])].sort();
  if (!days.length) return { observedDays: 0, spanDays: 0, longestGap: 0, eligible: false, reason: "chưa có ngày quan sát nào" };
  const numbers = days.map(dayNumber);
  const spanDays = numbers.at(-1) - numbers[0] + 1;
  let longestGap = 0;
  for (let i = 1; i < numbers.length; i += 1) longestGap = Math.max(longestGap, numbers[i] - numbers[i - 1] - 1);
  const needDays = Math.ceil(RULES.observationDays * RULES.minObservedShare);
  const reasons = [];
  if (spanDays < RULES.observationDays) reasons.push(`mới trải ${spanDays}/${RULES.observationDays} ngày`);
  if (days.length < needDays) reasons.push(`mới có ${days.length}/${needDays} ngày quan sát`);
  if (longestGap > RULES.maxGapDays) reasons.push(`có khoảng trống ${longestGap} ngày liên tiếp không quan sát`);
  return { observedDays: days.length, spanDays, longestGap, eligible: reasons.length === 0, reason: reasons.join("; ") };
}

const countKind = (account, kind) => (account.incidents ?? []).filter((incident) => incident.kind === kind).length;
const isRestricted = (account) => (account.incidents ?? []).some((incident) => RESTRICTING.has(incident.kind));

export function evaluate(rawAccounts, decisions = []) {
  const accounts = rawAccounts.map(withAppReports);
  const problems = accounts.flatMap(validateAccount);
  const ids = accounts.map((account) => account.id);
  if (new Set(ids).size !== ids.length) problems.push("Có id tài khoản bị trùng.");
  const valid = accounts.filter((account) => validateAccount(account).length === 0);

  const rows = valid.map((account) => {
    const watch = observation(account);
    const restricted = isRestricted(account);
    return {
      id: account.id,
      account_age: account.account_age,
      activity: account.activity,
      groups: account.groups,
      defaultConfig: sameConfig(account.config, DEFAULT_CONFIG),
      groupsOk: account.groups === RULES.groupsPerAccount,
      ...watch,
      restricted,
      // A restricted account is counted at once: it must not drop out for being "too short".
      counted: restricted || watch.eligible,
      verifications: countKind(account, "verification"),
      logouts: countKind(account, "logout"),
      rateLimitNotices: countKind(account, "rate_limit_notice"),
      incidents: (account.incidents ?? []).map((incident) => ({
        at: incident.at,
        kind: incident.kind,
        page_loads_24h: incident.page_loads_24h,
        note: incident.note ?? "",
      })),
    };
  });

  const counted = rows.filter((row) => row.counted && row.defaultConfig && row.groupsOk);
  const excluded = rows.filter((row) => row.counted && !(row.defaultConfig && row.groupsOk));
  const restrictedCount = counted.filter((row) => row.restricted).length;
  const verificationMean = counted.length ? counted.reduce((sum, row) => sum + row.verifications, 0) / counted.length : null;
  const conclusive = counted.length >= RULES.accounts && problems.length === 0;

  const needs = [];
  if (counted.length && restrictedCount > 0) needs.push("restriction");
  if (verificationMean !== null && verificationMean > RULES.verificationsPerAccount) needs.push("verification_rate");
  const missingDecisions = needs.filter((trigger) => !decisions.some((decision) => decision.trigger === trigger));

  const outstanding = [];
  if (counted.length < RULES.accounts) {
    outstanding.push(`Mới có ${counted.length}/${RULES.accounts} tài khoản đủ điều kiện (cấu hình mặc định, ${RULES.groupsPerAccount} nhóm, theo dõi đủ ${RULES.observationDays} ngày hoặc đã bị hạn chế).`);
  }
  for (const row of rows.filter((entry) => !entry.counted)) outstanding.push(`${row.id}: chưa đủ thời gian theo dõi (${row.reason}).`);
  for (const row of excluded) {
    outstanding.push(`${row.id}: không tính vào kết luận mặc định vì ${!row.defaultConfig ? "cấu hình quét khác mặc định" : `theo dõi ${row.groups} nhóm thay vì ${RULES.groupsPerAccount}`}.`);
  }
  if (problems.length) outstanding.push("Có bản ghi lỗi cần sửa trước khi kết luận.");

  const warnings = [];
  if (counted.length >= 2 && new Set(counted.map((row) => `${row.account_age}/${row.activity}`)).size < 2) {
    warnings.push("Các tài khoản có cùng tuổi và mức hoạt động; kế hoạch yêu cầu khác nhau.");
  }
  return {
    accounts: rows,
    counted: counted.length,
    restricted: restrictedCount,
    required: RULES.accounts,
    verificationMean,
    conclusive,
    verdict: !conclusive ? "outstanding" : restrictedCount === 0 ? "pass" : "fail",
    needsDecision: needs,
    missingDecisions,
    decisions,
    outstanding,
    warnings,
    problems,
  };
}

const LABEL = { pass: "ĐẠT (0 tài khoản bị hạn chế)", fail: "KHÔNG ĐẠT", outstanding: "CHƯA CÓ ĐỦ BẰNG CHỨNG" };
const KIND_LABEL = { verification: "xác minh", logout: "đăng xuất", rate_limit_notice: "báo giới hạn tốc độ", restriction: "HẠN CHẾ", lock: "KHOÁ", other: "khác" };

export function renderReport(result) {
  const lines = [`Báo cáo H5: ${result.restricted}/${result.counted} tài khoản bị hạn chế trên số tài khoản đủ thời gian theo dõi (mục tiêu 0/${result.required}).`];
  lines.push(`Kết luận: ${LABEL[result.verdict]}`);
  for (const text of result.outstanding) lines.push(`CÒN THIẾU: ${text}`);
  for (const text of result.problems) lines.push(`LỖI DỮ LIỆU: ${text}`);
  for (const text of result.warnings) lines.push(`LƯU Ý: ${text}`);
  lines.push("", "Từng tài khoản:");
  if (!result.accounts.length) lines.push("  (chưa có tài khoản)");
  for (const row of result.accounts) {
    lines.push(`  - ${row.id} (${row.account_age}, hoạt động ${row.activity}) · ${row.groups} nhóm · ${row.observedDays} ngày quan sát trong ${row.spanDays} ngày${row.eligible ? "" : ` (chưa đủ: ${row.reason})`} · ${row.restricted ? "BỊ HẠN CHẾ" : "không bị hạn chế"} · xác minh ${row.verifications}, đăng xuất ${row.logouts}, báo giới hạn ${row.rateLimitNotices}${row.defaultConfig ? "" : " · cấu hình KHÁC mặc định"}`);
    for (const incident of row.incidents) {
      lines.push(`      ${incident.at} · ${KIND_LABEL[incident.kind]} · ${incident.page_loads_24h} lượt tải trong 24 giờ trước${incident.note ? ` · ${incident.note}` : ""}`);
    }
  }
  lines.push("", `Số lần xác minh trung bình mỗi tài khoản: ${result.verificationMean === null ? "—" : result.verificationMean.toFixed(1)} (ngưỡng: trên ${RULES.verificationsPerAccount} thì giảm một nửa tần suất mặc định và đo lại).`);
  for (const trigger of result.missingDecisions) lines.push(`CẦN GHI QUYẾT ĐỊNH: điều kiện "${trigger}" đã xảy ra nhưng chưa có mục decisions tương ứng.`);
  for (const decision of result.decisions) lines.push(`Quyết định ${decision.date ?? "?"} (${decision.trigger}): ${decision.action ?? ""} ${decision.detail ?? ""}`.trim());
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = args.find((arg) => !arg.startsWith("--")) ?? path.join(here, "../docs/delivery/studies/h5-account-safety/accounts.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const accounts = Array.isArray(data) ? data : data.accounts;
  if (!Array.isArray(accounts)) throw new Error(`${file} cần một mảng accounts.`);
  const result = evaluate(accounts, Array.isArray(data) ? [] : (data.decisions ?? []));
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderReport(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
