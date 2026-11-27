// Made-up records that check the scoring rules only. They are not observations.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { DEFAULT_CONFIG, evaluate, fromAppReport, observation, renderReport, validateAccount, withAppReports } from "./account-safety-report.mjs";

function days(start, count, skip = []) {
  const out = [];
  const base = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    if (!skip.includes(i)) out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function account(index, patch = {}) {
  return {
    id: `A${index}`,
    account_age: ["under-1y", "1-3y", "over-3y"][index % 3],
    activity: ["low", "medium", "high"][index % 3],
    groups: 10,
    started_on: "2026-12-01",
    config: DEFAULT_CONFIG,
    observed_days: days("2026-12-01", 30),
    incidents: [],
    ...patch,
  };
}

const incident = (kind, extra = {}) => ({
  at: "2026-12-10T08:00:00.000Z", kind, page_loads_24h: 180, scanning_paused: true, ...extra,
});

test("no accounts: nothing is concluded", () => {
  const result = evaluate([]);
  assert.equal(result.verdict, "outstanding");
  assert.match(renderReport(result), /0\/0 tài khoản bị hạn chế/);
});

test("three complete clean accounts pass with 0/3 restricted", () => {
  const result = evaluate([account(1), account(2), account(3)]);
  assert.equal(result.conclusive, true);
  assert.equal(result.restricted, 0);
  assert.equal(result.verdict, "pass");
});

test("a restricted account is counted even before it reached 30 days", () => {
  const early = account(1, { observed_days: days("2026-12-01", 9), incidents: [incident("restriction")] });
  const result = evaluate([early, account(2), account(3)]);
  assert.equal(result.counted, 3);
  assert.equal(result.restricted, 1);
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.missingDecisions, ["restriction"]);
});

test("accounts that are not watched long enough are not counted and the verdict stays open", () => {
  const short = account(3, { observed_days: days("2026-12-01", 20) });
  const result = evaluate([account(1), account(2), short]);
  assert.equal(result.counted, 2);
  assert.equal(result.verdict, "outstanding");
  assert.match(result.outstanding.join(" "), /A3: chưa đủ thời gian theo dõi/);
});

test("observation needs 30 days, 27 observed days and no gap over three days", () => {
  assert.equal(observation(account(1)).eligible, true);
  assert.equal(observation(account(1, { observed_days: days("2026-12-01", 30, [5, 6, 7, 8]) })).eligible, false, "four-day gap");
  assert.equal(observation(account(1, { observed_days: days("2026-12-01", 30, [3, 9, 15, 21]) })).eligible, false, "only 26 days observed");
  assert.equal(observation(account(1, { observed_days: days("2026-12-01", 30, [3, 9, 15]) })).eligible, true);
  assert.equal(observation(account(1, { observed_days: [] })).eligible, false);
});

test("accounts off the default scan config or the ten groups are listed but not counted", () => {
  const faster = account(1, { config: { ...DEFAULT_CONFIG, group_interval_minutes: 5 } });
  const five = account(2, { groups: 5 });
  const result = evaluate([faster, five, account(3)]);
  assert.equal(result.counted, 1);
  assert.match(result.outstanding.join(" "), /A1: không tính vào kết luận mặc định vì cấu hình quét khác mặc định/);
  assert.match(result.outstanding.join(" "), /A2: không tính .* 5 nhóm thay vì 10/);
});

test("more than one verification per account on average requires a recorded decision", () => {
  const verifying = (id) => account(id, { incidents: [incident("verification"), incident("verification", { at: "2026-12-12T08:00:00Z" })] });
  const open = evaluate([verifying(1), verifying(2), account(3)]);
  assert.equal(open.verificationMean, 4 / 3);
  assert.deepEqual(open.needsDecision, ["verification_rate"]);
  assert.deepEqual(open.missingDecisions, ["verification_rate"]);
  assert.match(renderReport(open), /CẦN GHI QUYẾT ĐỊNH/);
  const decided = evaluate([verifying(1), verifying(2), account(3)], [
    { date: "2026-12-31", trigger: "verification_rate", action: "halve_frequency", detail: "Chu kỳ nhóm 15 → 30 phút, đo lại từ 2027-01-02" },
  ]);
  assert.deepEqual(decided.missingDecisions, []);
  assert.match(renderReport(decided), /halve_frequency/);
  const calm = evaluate([account(1, { incidents: [incident("verification")] }), account(2), account(3)]);
  assert.deepEqual(calm.needsDecision, []);
});

test("every incident must record the previous 24 hours of page loads and that scanning stopped", () => {
  assert.ok(validateAccount(account(1, { incidents: [{ at: "2026-12-10T08:00:00Z", kind: "verification", scanning_paused: true }] })).length > 0);
  assert.ok(validateAccount(account(1, { incidents: [incident("verification", { scanning_paused: false })] })).length > 0);
  assert.ok(validateAccount(account(1, { id: "nguyenvana@mail.com" })).length > 0);
  assert.deepEqual(validateAccount(account(1)), []);
  assert.match(evaluate([account(1, { incidents: [{ at: "x", kind: "bad" }] })]).problems.join(" "), /ISO 8601/);
});

test("the app's report is merged without counting an incident twice", () => {
  const appReport = {
    crawl_policy: DEFAULT_CONFIG,
    followed_groups: 10,
    active_days: days("2026-12-01", 30).map((date) => ({ date, runs: 40, page_loads: 90, blocked_runs: 0 })),
    incidents: [
      { kind: "checkpoint", occurred_at: Date.parse("2026-12-10T08:00:00Z"), detail: "/checkpoint/", page_loads_24h: 212, page_loads_1h: 14, scanning_paused: true, resolved_at: Date.parse("2026-12-10T09:00:00Z") },
      { kind: "rate_limited", occurred_at: Date.parse("2026-12-11T08:00:00Z"), detail: "", page_loads_24h: 150, page_loads_1h: 11, scanning_paused: true, resolved_at: null },
    ],
  };
  assert.equal(fromAppReport(appReport).incidents[0].kind, "verification");
  const base = { id: "A1", account_age: "1-3y", activity: "medium", started_on: "2026-12-01" };
  const merged = withAppReports({ ...base, app_reports: [appReport, appReport] });
  assert.equal(merged.incidents.length, 2);
  assert.equal(merged.groups, 10);
  const result = evaluate([{ ...base, app_reports: [appReport] }, account(2), account(3)]);
  const row = result.accounts.find((entry) => entry.id === "A1");
  assert.equal(row.verifications, 1);
  assert.equal(row.rateLimitNotices, 1);
  assert.equal(row.restricted, false, "a rate-limit notice is not an account restriction until the owner confirms one");
  assert.equal(result.verdict, "pass");
});

test("the committed accounts file is valid and holds no unobserved data", () => {
  const data = JSON.parse(fs.readFileSync(new URL("../docs/delivery/studies/h5-account-safety/accounts.json", import.meta.url), "utf8"));
  const result = evaluate(data.accounts, data.decisions);
  assert.deepEqual(result.problems, []);
});
