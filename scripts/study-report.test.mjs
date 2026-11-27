// Tests use made-up records to check the scoring rules only. They are not study results.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluate, helpPlaces, median, rankBlockers, renderReport, validateSession, wrongAssumptions } from "./study-report.mjs";

const INDUSTRY_CYCLE = ["bds", "bds", "dich-vu-nha-cua", "dich-vu-nha-cua", "xe-cu", "xe-cu", "bds", "xe-cu"];

function session(index, patch = {}) {
  return {
    id: `P0${index + 1}`,
    industry: INDUSTRY_CYCLE[index],
    technical: false,
    consent: true,
    cli: { succeeded: true, completed_unaided: true, minutes: 6, help_requests: [] },
    radar: {
      activated: true, completed_unaided: true, minutes: 4, fields_edited: 1,
      usable: { confirmed: 8, shown: 10 }, help_requests: [],
    },
    blockers: [],
    wrong_assumptions: [],
    ...patch,
  };
}

const eight = (patch = () => ({})) => Array.from({ length: 8 }, (_, i) => session(i, patch(i)));

test("median of odd and even lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("no sessions: nothing is concluded", () => {
  const result = evaluate([]);
  assert.equal(result.participants, 0);
  assert.equal(result.h1.verdict, "outstanding");
  assert.equal(result.h4.verdict, "outstanding");
  assert.match(renderReport(result), /Phiên hợp lệ: 0\/8/);
});

test("seven good sessions are still outstanding, never a pass", () => {
  const result = evaluate(eight().slice(0, 7));
  assert.equal(result.h1.verdict, "outstanding");
  assert.equal(result.h4.verdict, "outstanding");
  assert.match(result.outstanding[0], /7\/8/);
});

test("eight sessions meeting every threshold pass both hypotheses", () => {
  const result = evaluate(eight());
  assert.equal(result.conclusive, true);
  assert.equal(result.h4.verdict, "pass");
  assert.equal(result.h1.verdict, "pass");
});

test("H4 fails with four unaided CLI connections even when H1 passes", () => {
  const result = evaluate(eight((i) => (i < 4 ? {} : { cli: { succeeded: true, completed_unaided: false, minutes: 9, help_requests: [{ where: "cli:dang-nhap" }] } })));
  assert.equal(result.h4.unaided, 4);
  assert.equal(result.h4.verdict, "fail");
  assert.equal(result.h1.verdict, "pass");
});

test("people who never connect count as the cap in the median", () => {
  const result = evaluate(eight((i) => (i < 4 ? { cli: { succeeded: false, completed_unaided: false, minutes: 12 } } : { cli: { succeeded: true, completed_unaided: true, minutes: 2 } })));
  // Four times of 2 and four of 30: the median is 16, not the 12 minutes they gave up at.
  assert.equal(result.h4.medianMinutes, 16);
  assert.equal(result.h4.verdict, "fail");
});

test("H1 needs a usable Radar: 70% of shown matches confirmed", () => {
  const unusable = { confirmed: 6, shown: 10 };
  const result = evaluate(eight((i) => (i < 3 ? { radar: { ...session(i).radar, usable: unusable } } : {})));
  assert.equal(result.h1.usable, 5);
  assert.equal(result.h1.verdict, "fail");
  assert.equal(result.h4.verdict, "pass");
});

test("H1 fails when the median is five minutes or more", () => {
  const result = evaluate(eight(() => ({ radar: { ...session(0).radar, minutes: 5.5 } })));
  assert.equal(result.h1.medianMinutes, 5.5);
  assert.equal(result.h1.verdict, "fail");
});

test("a wrong industry mix is not conclusive", () => {
  const result = evaluate(eight((i) => ({ industry: i >= 4 ? "bds" : session(i).industry })));
  assert.equal(result.conclusive, false);
  assert.equal(result.h1.verdict, "outstanding");
  assert.match(result.outstanding.join(" "), /mỗi ngành/);
});

test("records are rejected unless the participant is non-technical, consented and pseudonymous", () => {
  assert.ok(validateSession(session(0, { technical: true })).length > 0);
  assert.ok(validateSession(session(0, { consent: false })).length > 0);
  assert.ok(validateSession(session(0, { id: "Nguyen Van A" })).length > 0);
  assert.ok(validateSession(session(0, { cli: { succeeded: false, completed_unaided: true, minutes: 3 } })).length > 0);
  assert.ok(validateSession(session(0, { radar: { ...session(0).radar, usable: { confirmed: 11, shown: 10 } } })).length > 0);
  assert.deepEqual(validateSession(session(0)), []);
  const duplicated = evaluate([session(0), session(0)]);
  assert.ok(duplicated.problems.some((problem) => /trùng/.test(problem)));
});

test("blockers rank activation blockers first, then by the number of people hit", () => {
  const blocker = (id, blocks_activation) => ({ id, step: "cli", summary: id, blocks_activation });
  const sessions = [
    session(0, { blockers: [blocker("cli-login", false), blocker("scan-off", true)] }),
    session(1, { blockers: [blocker("cli-login", false)] }),
    session(2, { blockers: [blocker("cli-login", false), blocker("no-group", true)] }),
    session(3, { blockers: [blocker("scan-off", true), blocker("no-group", true)] }),
    session(4, { blockers: [blocker("no-group", true)] }),
  ];
  const ranked = rankBlockers(sessions);
  assert.deepEqual(ranked.map((row) => [row.id, row.participants.length, row.blocks_activation]), [
    ["no-group", 3, true],
    ["scan-off", 2, true],
    ["cli-login", 3, false],
  ]);
});

test("help places and wrong assumptions count distinct people and keep the fixes", () => {
  const sessions = [
    session(0, {
      cli: { succeeded: true, completed_unaided: false, minutes: 11, help_requests: [{ where: "cli:dang-nhap" }, { where: "cli:dang-nhap" }] },
      wrong_assumptions: [{ assumption: "Loại bài của người cùng nghề", step: "fields", fix: "Bỏ chọn ô loại người cùng nghề" }],
    }),
    session(1, {
      cli: { succeeded: true, completed_unaided: false, minutes: 8, help_requests: [{ where: "cli:dang-nhap" }] },
      wrong_assumptions: [{ assumption: "loại bài của người cùng nghề ", fix: "Sửa lại câu giả định" }],
    }),
  ];
  assert.deepEqual(helpPlaces(sessions), [{ where: "cli:dang-nhap", participants: ["P01", "P02"] }]);
  const assumptions = wrongAssumptions(sessions);
  assert.equal(assumptions.length, 1);
  assert.deepEqual(assumptions[0].participants, ["P01", "P02"]);
  assert.equal(assumptions[0].fixes.length, 2);
});

test("the committed session file holds only valid, unscored-by-hand records", () => {
  const file = new URL("../docs/delivery/studies/h1-h4/sessions.json", import.meta.url);
  const sessions = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(sessions));
  assert.deepEqual(evaluate(sessions).problems, []);
});
