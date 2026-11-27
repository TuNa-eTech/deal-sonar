// Made-up participants that check the scoring rules only. They are not pilot results.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluate as evaluateAccounts } from "./account-safety-report.mjs";
import {
  PILOT_RULES, computeMetrics, deriveParticipant, evaluateDecision, evaluateGate, evaluatePilot, renderDecision, renderGate, renderReport, validateParticipant,
} from "./pilot-report.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ENROLLED = "2027-01-04";
const T0 = Date.parse("2027-01-04T08:00:00Z");
const AS_OF_WEEK4 = "2027-02-10";

function snapshot({ installed = T0, activatedAfterMin = 30, leadAfterHours = 5, notified = 4, wrong = 0, activeRadars = 1, on = AS_OF_WEEK4 } = {}) {
  const activated = activatedAfterMin == null ? null : installed + activatedAfterMin * 60_000;
  return {
    schema: 1,
    taken_on: on,
    first_news: {
      installed_at: installed,
      first_radar_activated_at: activated,
      first_lead_at: leadAfterHours == null || activated == null ? null : activated + leadAfterHours * HOUR,
      leads_notified: notified,
      leads_flagged_wrong: wrong,
      active_radars: activeRadars,
    },
  };
}

function person(index, patch = {}) {
  return {
    id: `U${String(index).padStart(2, "0")}`,
    segment: ["bds", "dich-vu-nha-cua", "xe-cu"][index % 3],
    enrolled_on: ENROLLED,
    consent: true,
    install_completed: true,
    snapshots: [snapshot()],
    ...patch,
  };
}

const group = (count, patch = () => ({})) => Array.from({ length: count }, (_, i) => person(i + 1, patch(i)));

test("an empty pilot concludes nothing", () => {
  const pilot = evaluatePilot([], AS_OF_WEEK4);
  assert.equal(pilot.overall.installed, 0);
  for (const check of Object.values(pilot.overall.checks)) assert.equal(check.status, "insufficient");
  assert.match(renderReport(pilot), /ghi danh 0, cài xong 0/);
});

test("ten installs meeting every PRD threshold pass all four metrics", () => {
  // 7/10 activated in the first session, first lead 5h after enabling, 40 leads with 4 wrong, all at week 4 with a radar.
  const people = group(10, (i) => ({ snapshots: [snapshot({ activatedAfterMin: i < 7 ? 30 : 600, notified: 4, wrong: i < 4 ? 1 : 0, activeRadars: i < 5 ? 1 : 0 })] }));
  const { checks } = evaluatePilot(people, AS_OF_WEEK4).overall;
  assert.equal(checks.activation.value, 0.7);
  assert.equal(checks.activation.status, "pass");
  assert.equal(checks.firstLead.value, 5);
  assert.equal(checks.firstLead.status, "pass");
  assert.equal(checks.wrongRate.value, 0.1);
  assert.equal(checks.wrongRate.status, "pass");
  assert.equal(checks.retention.value, 0.5);
  assert.equal(checks.retention.status, "pass");
});

test("a radar switched on after the first session does not count as activation", () => {
  const derived = deriveParticipant(person(1, { snapshots: [snapshot({ activatedAfterMin: 3 * 60 })] }), AS_OF_WEEK4);
  assert.equal(derived.activated_first_session, false);
  assert.equal(deriveParticipant(person(1, { snapshots: [snapshot({ activatedAfterMin: 119 })] }), AS_OF_WEEK4).activated_first_session, true);
  assert.equal(deriveParticipant(person(1, { snapshots: [snapshot({ activatedAfterMin: 5 })], install_completed: false }), AS_OF_WEEK4).activated_first_session, false);
  assert.equal(deriveParticipant(person(1, { activated_first_session: true, snapshots: [] }), AS_OF_WEEK4).activated_first_session, true, "an observed fact overrides the snapshot");
});

test("activation below 60% fails and the denominator is people who finished installing", () => {
  const people = group(12, (i) => ({ install_completed: i < 10, snapshots: [snapshot({ activatedAfterMin: i < 5 ? 20 : 600 })] }));
  const { overall } = evaluatePilot(people, AS_OF_WEEK4);
  assert.equal(overall.enrolled, 12);
  assert.equal(overall.installed, 10);
  assert.equal(overall.checks.activation.denominator, 10);
  assert.equal(overall.checks.activation.value, 0.5);
  assert.equal(overall.checks.activation.status, "fail");
});

test("no lead after 24 hours counts against time to first lead; inside the window it is pending", () => {
  const long = Date.parse(`${AS_OF_WEEK4}T00:00:00Z`) - 2 * DAY;
  const people = group(10, (i) => ({
    snapshots: [snapshot({ installed: long + i, activatedAfterMin: 10, leadAfterHours: i < 4 ? 3 : null })],
  }));
  const { checks } = evaluatePilot(people, AS_OF_WEEK4).overall;
  assert.equal(checks.firstLead.denominator, 10);
  assert.equal(checks.firstLead.numerator, 4);
  assert.equal(checks.firstLead.value, Infinity);
  assert.equal(checks.firstLead.status, "fail");
  const recent = group(10, (i) => ({ snapshots: [snapshot({ installed: Date.parse("2027-02-10T09:00:00Z"), activatedAfterMin: 10, leadAfterHours: null, on: "2027-02-10" })] }));
  const early = evaluatePilot(recent, "2027-02-10").overall.checks.firstLead;
  assert.equal(early.pending, 10);
  assert.equal(early.status, "insufficient");
});

test("the wrong-lead rate needs 30 notified leads before it says anything", () => {
  const few = evaluatePilot(group(10, () => ({ snapshots: [snapshot({ notified: 2, wrong: 2 })] })), AS_OF_WEEK4).overall.checks.wrongRate;
  assert.equal(few.denominator, 20);
  assert.equal(few.status, "insufficient");
  const enough = evaluatePilot(group(10, () => ({ snapshots: [snapshot({ notified: 4, wrong: 1 })] })), AS_OF_WEEK4).overall.checks.wrongRate;
  assert.equal(enough.value, 0.25);
  assert.equal(enough.status, "fail");
});

test("week-4 retention waits for everyone and never guesses missing data", () => {
  const notDue = evaluatePilot(group(10), "2027-01-20").overall.checks.retention;
  assert.equal(notDue.status, "insufficient");
  const missing = evaluatePilot(group(10, (i) => ({ snapshots: i === 0 ? [] : [snapshot()] })), AS_OF_WEEK4).overall.checks.retention;
  assert.deepEqual(missing.missing, ["U01"]);
  assert.equal(missing.status, "insufficient");
  const dropped = evaluatePilot(group(10, (i) => (i < 7
    ? { snapshots: [snapshot({ activeRadars: 0 })], dropout: { on: "2027-01-20", stage: "ongoing", reason: "no_leads" } }
    : {})), AS_OF_WEEK4).overall.checks.retention;
  assert.equal(dropped.numerator, 3);
  assert.equal(dropped.status, "fail");
});

test("dropouts are listed with stage, reason and the enrolled denominator", () => {
  const people = group(6, (i) => (i === 0 ? { install_completed: false, snapshots: [], dropout: { on: "2027-01-05", stage: "install", reason: "ai_setup", note: "không đăng nhập được CLI" } }
    : i === 1 ? { dropout: { on: "2027-01-12", stage: "first_lead", reason: "no_leads" } } : {}));
  const { dropouts } = evaluatePilot(people, AS_OF_WEEK4);
  assert.equal(dropouts.dropped, 2);
  assert.equal(dropouts.enrolled, 6);
  assert.deepEqual(dropouts.byReason, { ai_setup: 1, no_leads: 1 });
  assert.deepEqual(dropouts.byStage, { first_lead: 1, install: 1 });
  assert.match(renderReport(evaluatePilot(people, AS_OF_WEEK4)), /lý do ai_setup: 1/);
});

test("the two-week interview records handled work and AI cost, and flags quota problems", () => {
  const interview = (extra) => ({ on: "2027-01-19", handled: 2, ai_plan: "had_before", ai_monthly_cost_vnd: 500_000, ai_limit_hit: false, ai_affected_other_use: false, ...extra });
  const people = group(4, (i) => (i < 3 ? { interview_week2: interview(i === 2 ? { ai_plan: "bought_for_this", ai_limit_hit: true, handled: 0, ai_monthly_cost_vnd: 700_000 } : {}) } : {}));
  const { interviews } = evaluatePilot(people, AS_OF_WEEK4);
  assert.equal(interviews.eligible, 4);
  assert.equal(interviews.done, 3);
  assert.deepEqual(interviews.missing, ["U04"]);
  assert.equal(interviews.handledTotal, 4);
  assert.equal(interviews.handledAny, 2);
  assert.equal(interviews.boughtAiForThis, 1);
  assert.deepEqual(interviews.aiLimitHit, ["U03"]);
  assert.equal(interviews.aiMonthlyCostVnd.median, 500_000);
  const decision = evaluateDecision({ pilot: evaluatePilot(people, AS_OF_WEEK4), h5: evaluateAccounts([]), prerequisites: {} });
  assert.ok(decision.needsFix.includes("ai-quota"));
});

test("segments are classified as meeting, needing a fix, or lacking evidence", () => {
  // bds: 3 people all good; dich-vu: 3 people, nobody activated; xe-cu: 2 people only.
  const people = [
    ...[1, 2, 3].map((n) => person(n, { segment: "bds", snapshots: [snapshot({ notified: 4, wrong: 0 })] })),
    ...[4, 5, 6].map((n) => person(n, { segment: "dich-vu-nha-cua", snapshots: [snapshot({ activatedAfterMin: 900, notified: 4, wrong: 0 })] })),
    ...[7, 8].map((n) => person(n, { segment: "xe-cu" })),
  ];
  const { segments } = evaluatePilot(people, AS_OF_WEEK4);
  assert.equal(segments.bds.status, "meets");
  assert.equal(segments["dich-vu-nha-cua"].status, "needs_fix");
  assert.equal(segments["xe-cu"].status, "insufficient");
  assert.equal(segments.other.status, "none");
  const decision = evaluateDecision({ pilot: evaluatePilot(people, AS_OF_WEEK4), h5: evaluateAccounts([]), prerequisites: {} });
  const view = renderDecision(decision);
  assert.match(view, /Nhu cầu đạt: bds/);
  assert.match(view, /Nhu cầu cần sửa: dich-vu-nha-cua/);
  assert.match(view, /Chưa đủ bằng chứng: .*xe-cu/);
});

test("records are rejected when they carry no consent or an identifying id", () => {
  assert.ok(validateParticipant(person(1, { consent: false })).length > 0);
  assert.ok(validateParticipant(person(1, { id: "nguyen@mail.com" })).length > 0);
  assert.ok(validateParticipant(person(1, { dropout: { on: "2027-01-05", stage: "somewhere", reason: "other" } })).length > 0);
  assert.ok(validateParticipant(person(1, { snapshots: [{ taken_on: "2027-02-01" }] })).length > 0);
  assert.deepEqual(validateParticipant(person(1)), []);
  assert.ok(evaluatePilot([person(1), person(1)], AS_OF_WEEK4).problems.some((problem) => /trùng/.test(problem)));
});

// --- gate ---

const PLATFORM = { id: "p1", committed: true, requires: [] };
const ledgerEntry = {
  id: "e1", recorded_on: "2027-01-02", platform_id: "p1", release_tag: "v1.0.0", artifact_sha256: "a".repeat(64),
  channel: "customer_download", os_version: "x", browser: { name: "Chrome", version: "1" }, extension_source: "chrome_web_store",
  extension_id: "a".repeat(32), clean_machine: true, pairing_result: "paired", tester_ref: "t1", evidence_ref: "ref",
  signature_observed: { signed: true }, download_url: "https://example.test/dl",
};
const studySession = (n) => ({
  id: `P0${n}`, industry: ["bds", "bds", "dich-vu-nha-cua", "dich-vu-nha-cua", "xe-cu", "xe-cu", "bds", "xe-cu"][n - 1], technical: false, consent: true,
  cli: { succeeded: true, completed_unaided: true, minutes: 6 },
  radar: { activated: true, completed_unaided: true, minutes: 4, usable: { confirmed: 9, shown: 10 } },
});
const metItems = ["a", "b"].map((id) => ({ id, kind: "owner", title: id, status: "met", evidence_ref: "dated record" }));

function gateInput(patch = {}) {
  return {
    distribution: { platforms: [PLATFORM] },
    ledger: { schema: 1, entries: [ledgerEntry] },
    sessions: Array.from({ length: 8 }, (_, i) => studySession(i + 1)),
    h5: evaluateAccounts([]),
    prerequisites: { items: metItems, waivers: [] },
    ...patch,
  };
}

test("the gate opens only when distribution, the H1/H4 study and every listed item have evidence", () => {
  assert.equal(evaluateGate(gateInput()).ready, true);
  assert.match(renderGate(evaluateGate(gateInput())), /chưa phải quyết định mở pilot/);
  const noDist = evaluateGate(gateInput({ ledger: { schema: 1, entries: [] } }));
  assert.equal(noDist.ready, false);
  assert.deepEqual(noDist.open.map((item) => item.id), ["issue-7-distribution"]);
  const noStudy = evaluateGate(gateInput({ sessions: [] }));
  assert.deepEqual(noStudy.open.map((item) => item.id), ["issue-14-h1-h4"]);
  const unsettled = evaluateGate(gateInput({ prerequisites: { items: [{ id: "issue-8", kind: "evidence", title: "#8", status: "pending", evidence_ref: null }] } }));
  assert.deepEqual(unsettled.open.map((item) => item.id), ["issue-8"]);
});

test("an item marked met without evidence stays open, and a recorded waiver is shown not hidden", () => {
  const claimed = evaluateGate(gateInput({ prerequisites: { items: [{ id: "x", kind: "owner", title: "x", status: "met", evidence_ref: null }] } }));
  assert.equal(claimed.ready, false);
  assert.match(claimed.items.find((item) => item.id === "x").detail, /thiếu evidence_ref/);
  const waived = evaluateGate(gateInput({ prerequisites: { items: [{ id: "x", kind: "owner", title: "x", status: "pending" }], waivers: [{ item: "x", date: "2027-01-03", by: "owner", rationale: "không cần cho pilot nội bộ" }] } }));
  assert.equal(waived.ready, true);
  assert.match(renderGate(waived), /MIỄN \(waiver\)/);
});

test("the committed prerequisite list cannot claim evidence that does not exist", () => {
  const file = JSON.parse(fs.readFileSync(new URL("../docs/delivery/studies/pilot-4w/prerequisites.json", import.meta.url), "utf8"));
  for (const item of [...file.items, ...file.expansion_evidence]) {
    if (item.status === "met") assert.ok(item.evidence_ref, `${item.id} is met without evidence_ref`);
  }
  const participants = JSON.parse(fs.readFileSync(new URL("../docs/delivery/studies/pilot-4w/participants.json", import.meta.url), "utf8"));
  assert.deepEqual(evaluatePilot(participants.participants, AS_OF_WEEK4).problems, []);
});

// --- decision ---

test("a recorded expansion decision that the evidence does not support is flagged", () => {
  const pilot = evaluatePilot([], AS_OF_WEEK4);
  const result = evaluateDecision({
    pilot, h5: evaluateAccounts([]), prerequisites: { expansion_evidence: [] },
    decision: { date: "2027-02-12", decision: "expand", by: "owner", rationale: "…" },
  });
  assert.equal(result.meetsAll, false);
  assert.match(result.contradiction, /bằng chứng chưa đủ/);
  assert.match(renderDecision(result), /MÂU THUẪN/);
  const cautious = evaluateDecision({ pilot, h5: evaluateAccounts([]), prerequisites: {}, decision: { date: "2027-02-12", decision: "fix_then_remeasure" } });
  assert.equal(cautious.contradiction, null);
});

test("expansion evidence is complete only when pilot, accounts, quality and operations all pass", () => {
  const people = group(10, (i) => ({
    interview_week2: { on: "2027-01-19", handled: 1, ai_plan: "had_before", ai_limit_hit: false, ai_affected_other_use: false },
    snapshots: [snapshot({ activatedAfterMin: 20, notified: 4, wrong: 0, activeRadars: i < 5 ? 1 : 0 })],
  }));
  const pilot = evaluatePilot(people, AS_OF_WEEK4);
  const accounts = Array.from({ length: 3 }, (_, i) => ({
    id: `A${i + 1}`, account_age: ["under-1y", "1-3y", "over-3y"][i], activity: ["low", "medium", "high"][i], groups: 10, started_on: "2027-01-01",
    config: { group_interval_minutes: 15, priority_interval_minutes: 5, hourly_page_load_budget: 60, daily_page_load_budget: 600, active_hours: { from: "07:00", to: "23:00" }, max_scroll_steps: 3, max_posts_per_visit: 25, only_when_idle: false },
    observed_days: Array.from({ length: 30 }, (_, d) => new Date(Date.parse("2027-01-01T00:00:00Z") + d * DAY).toISOString().slice(0, 10)), incidents: [],
  }));
  const metEvidence = ["quality-h2-eval", "ops-latency", "ops-ai-call-share"].map((id) => ({ id, area: "x", title: id, status: "met", evidence_ref: "dated record" }));
  const done = evaluateDecision({ pilot, h5: evaluateAccounts(accounts), prerequisites: { expansion_evidence: metEvidence } });
  assert.equal(done.meetsAll, true);
  const missingQuality = evaluateDecision({ pilot, h5: evaluateAccounts(accounts), prerequisites: { expansion_evidence: [{ ...metEvidence[0], status: "pending", evidence_ref: null }] } });
  assert.equal(missingQuality.meetsAll, false);
  assert.deepEqual(missingQuality.insufficient, ["quality-h2-eval"]);
});
