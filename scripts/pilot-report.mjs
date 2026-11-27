#!/usr/bin/env node
/**
 * Four-week pilot: the evidence gate before it starts, the PRD §8 metrics while it runs, and the
 * evidence matrix behind the expansion decision.
 *
 *   node scripts/pilot-report.mjs gate               # what must exist before inviting pilot users
 *   node scripts/pilot-report.mjs report [--as-of YYYY-MM-DD] [--json]
 *   node scripts/pilot-report.mjs decision           # evidence for the expansion decision
 *
 * Thresholds mirror `docs/product/01-prd.md` §8 and are fixed in
 * `docs/delivery/studies/pilot-4w/README.md` before the first participant is enrolled. The tool
 * never says "go": it reports which evidence exists, which is missing and what failed, and it
 * flags a recorded decision that contradicts the evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate as evaluateAccounts } from "./account-safety-report.mjs";
import { platformReadiness, validateLedger } from "./distribution-evidence.mjs";
import { evaluate as evaluateSessions } from "./study-report.mjs";

export const PILOT_RULES = Object.freeze({
  /** PRD §8 thresholds. */
  activation: 0.6,
  firstLeadHours: 24,
  wrongRate: 0.15,
  retention: 0.4,
  /** Fixed before enrolment (proposal for the owner to approve). */
  minInstalled: 10,
  minNotified: 30,
  segmentMinInstalled: 3,
  segmentMinNotified: 10,
  /** "First session": the radar was switched on within this long of the first launch. */
  firstSessionMinutes: 120,
  retentionDays: 28,
  interviewDays: 14,
});

export const SEGMENTS = ["bds", "dich-vu-nha-cua", "xe-cu", "other"];
export const DROPOUT_STAGES = ["install", "activation", "first_lead", "ongoing"];
export const DROPOUT_REASONS = ["chrome_setup", "ai_setup", "facebook_setup", "no_leads", "wrong_leads", "account_risk", "cost", "no_time", "technical_fault", "other"];
export const AI_PLANS = ["had_before", "bought_for_this", "none"];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const dateMs = (value) => Date.parse(`${value}T00:00:00Z`);
const addDays = (value, days) => new Date(dateMs(value) + days * DAY_MS).toISOString().slice(0, 10);

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  const pair = [sorted[mid - 1], sorted[mid]];
  return pair[0] === pair[1] ? pair[0] : pair.includes(Infinity) ? Infinity : (pair[0] + pair[1]) / 2;
}

export function validateParticipant(p) {
  const errors = [];
  const where = p?.id ?? "(không có id)";
  const need = (ok, message) => { if (!ok) errors.push(`${where}: ${message}`); };
  need(/^U\d{2,3}$/.test(p?.id ?? ""), "id phải dạng U01…U999, không dùng tên, email hay số điện thoại");
  need(SEGMENTS.includes(p?.segment), `segment phải là một trong ${SEGMENTS.join(", ")}`);
  need(isDate(p?.enrolled_on), "enrolled_on phải là YYYY-MM-DD");
  need(p?.consent === true, "thiếu consent: true");
  need(typeof p?.install_completed === "boolean", "install_completed phải là true/false");
  for (const snap of p?.snapshots ?? []) {
    need(isDate(snap?.taken_on) && Number.isFinite(snap?.first_news?.installed_at), "mỗi snapshot cần taken_on và first_news.installed_at (dán JSON từ nút Sao chép số liệu pilot)");
  }
  if (p?.dropout) {
    need(isDate(p.dropout.on), "dropout.on phải là YYYY-MM-DD");
    need(DROPOUT_STAGES.includes(p.dropout.stage), `dropout.stage phải là một trong ${DROPOUT_STAGES.join(", ")}`);
    need(DROPOUT_REASONS.includes(p.dropout.reason), `dropout.reason phải là một trong ${DROPOUT_REASONS.join(", ")}`);
  }
  const iv = p?.interview_week2;
  if (iv) {
    need(isDate(iv.on), "interview_week2.on phải là YYYY-MM-DD");
    need(Number.isInteger(iv.handled) && iv.handled >= 0, "interview_week2.handled là số việc thực tế đã xử lý từ tin DealSonar");
    need(AI_PLANS.includes(iv.ai_plan), `interview_week2.ai_plan phải là một trong ${AI_PLANS.join(", ")}`);
    need(typeof iv.ai_limit_hit === "boolean" && typeof iv.ai_affected_other_use === "boolean", "ghi ai_limit_hit và ai_affected_other_use (true/false)");
  }
  return errors;
}

/** Latest snapshot taken on or before `asOf`, and the first one taken on or after `day`. */
function snapshotsFor(p, asOf) {
  const usable = (p.snapshots ?? []).filter((s) => s.taken_on <= asOf).sort((a, b) => a.taken_on.localeCompare(b.taken_on));
  return usable;
}

/** Fill the measured fields from app snapshots; hand-entered values win. */
export function deriveParticipant(p, asOf, rules = PILOT_RULES) {
  const snaps = snapshotsFor(p, asOf);
  const latest = snaps.at(-1)?.first_news;
  const installedAt = latest?.installed_at ?? null;
  const activatedAt = latest?.first_radar_activated_at ?? null;
  const leadAt = latest?.first_lead_at ?? null;
  const weekFourDay = addDays(p.enrolled_on, rules.retentionDays);
  const weekFour = snaps.find((s) => s.taken_on >= weekFourDay);
  const activatedFirst = p.activated_first_session
    ?? (p.install_completed && installedAt != null && activatedAt != null && activatedAt - installedAt <= rules.firstSessionMinutes * MIN_MS);
  const due = asOf >= weekFourDay;
  let weekFourRunning = p.week4_radar_running ?? (weekFour ? (weekFour.first_news.active_radars ?? 0) > 0 : null);
  if (p.dropout && weekFourRunning === null) weekFourRunning = false;
  return {
    ...p,
    activated_first_session: Boolean(activatedFirst),
    activatedAt,
    leadAt,
    hoursToFirstLead: activatedAt != null && leadAt != null ? Math.max(0, (leadAt - activatedAt) / HOUR_MS) : null,
    hoursSinceActivation: activatedAt != null ? (dateMs(asOf) + DAY_MS - activatedAt) / HOUR_MS : null,
    leadsNotified: latest?.leads_notified ?? 0,
    leadsFlaggedWrong: latest?.leads_flagged_wrong ?? 0,
    hasSnapshot: Boolean(latest),
    weekFourDay,
    weekFourDue: due,
    weekFourRunning: due ? weekFourRunning : null,
    weekFourMissing: due && weekFourRunning === null,
  };
}

const rate = (num, den) => (den > 0 ? num / den : null);

/** Metrics for one group of participants. */
export function computeMetrics(group, asOf, rules = PILOT_RULES, minimums = { installed: rules.minInstalled, notified: rules.minNotified }) {
  const enrolled = group.length;
  const installed = group.filter((p) => p.install_completed);
  const activated = installed.filter((p) => p.activated_first_session);
  const enabled = installed.filter((p) => p.activatedAt != null || p.activated_first_session);
  // A participant who got no lead yet is still inside the 24-hour window: not counted either way.
  const leadResolved = enabled.filter((p) => p.hoursToFirstLead !== null || (p.hoursSinceActivation ?? 0) >= rules.firstLeadHours);
  const leadTimes = leadResolved.map((p) => (p.hoursToFirstLead === null ? Infinity : p.hoursToFirstLead));
  const medianHours = median(leadTimes);
  const notified = installed.reduce((sum, p) => sum + p.leadsNotified, 0);
  const wrong = installed.reduce((sum, p) => sum + p.leadsFlaggedWrong, 0);
  const due = installed.filter((p) => p.weekFourDue);
  const missingWeekFour = due.filter((p) => p.weekFourMissing).map((p) => p.id);
  const retained = due.filter((p) => p.weekFourRunning === true).length;
  const cohortComplete = installed.length > 0 && due.length === installed.length && missingWeekFour.length === 0;
  const need = { installed: minimums.installed };

  const checks = {
    activation: {
      value: rate(activated.length, installed.length), threshold: rules.activation, denominator: installed.length, numerator: activated.length,
      conclusive: installed.length >= need.installed,
    },
    firstLead: {
      value: medianHours, threshold: rules.firstLeadHours, denominator: leadResolved.length, numerator: leadTimes.filter((hours) => hours < rules.firstLeadHours).length,
      pending: enabled.length - leadResolved.length, conclusive: leadResolved.length >= need.installed && leadResolved.length === enabled.length,
    },
    wrongRate: {
      value: rate(wrong, notified), threshold: rules.wrongRate, denominator: notified, numerator: wrong,
      conclusive: notified >= minimums.notified,
    },
    retention: {
      value: rate(retained, due.length), threshold: rules.retention, denominator: due.length, numerator: retained,
      conclusive: cohortComplete && installed.length >= need.installed,
      missing: missingWeekFour,
    },
  };
  const passes = {
    activation: checks.activation.value !== null && checks.activation.value >= rules.activation,
    firstLead: checks.firstLead.value !== null && checks.firstLead.value < rules.firstLeadHours,
    wrongRate: checks.wrongRate.value !== null && checks.wrongRate.value < rules.wrongRate,
    retention: checks.retention.value !== null && checks.retention.value >= rules.retention,
  };
  for (const key of Object.keys(checks)) {
    const check = checks[key];
    check.status = !check.conclusive ? "insufficient" : passes[key] ? "pass" : "fail";
  }
  return { enrolled, installed: installed.length, activated: activated.length, checks };
}

export function dropoutSummary(group) {
  const dropped = group.filter((p) => p.dropout);
  const count = (items, key) => Object.fromEntries([...new Set(items.map((p) => p.dropout[key]))].sort().map((value) => [value, items.filter((p) => p.dropout[key] === value).length]));
  return {
    enrolled: group.length,
    dropped: dropped.length,
    byReason: count(dropped, "reason"),
    byStage: count(dropped, "stage"),
    list: dropped.map((p) => ({ id: p.id, segment: p.segment, stage: p.dropout.stage, reason: p.dropout.reason, note: p.dropout.note ?? "" })),
  };
}

export function interviewSummary(group, asOf, rules = PILOT_RULES) {
  const eligible = group.filter((p) => p.install_completed && asOf >= addDays(p.enrolled_on, rules.interviewDays));
  const done = group.filter((p) => p.interview_week2);
  const costs = done.map((p) => p.interview_week2.ai_monthly_cost_vnd).filter((value) => Number.isFinite(value));
  return {
    eligible: eligible.length,
    done: done.length,
    missing: eligible.filter((p) => !p.interview_week2).map((p) => p.id),
    handledTotal: done.reduce((sum, p) => sum + p.interview_week2.handled, 0),
    handledAny: done.filter((p) => p.interview_week2.handled > 0).length,
    boughtAiForThis: done.filter((p) => p.interview_week2.ai_plan === "bought_for_this").length,
    aiLimitHit: done.filter((p) => p.interview_week2.ai_limit_hit).map((p) => p.id),
    aiAffectedOtherUse: done.filter((p) => p.interview_week2.ai_affected_other_use).map((p) => p.id),
    aiMonthlyCostVnd: { reported: costs.length, median: median(costs) },
  };
}

export function evaluatePilot(rawParticipants, asOf, rules = PILOT_RULES) {
  const problems = rawParticipants.flatMap(validateParticipant);
  const ids = rawParticipants.map((p) => p.id);
  if (new Set(ids).size !== ids.length) problems.push("Có id người tham gia bị trùng.");
  const valid = rawParticipants.filter((p) => validateParticipant(p).length === 0).map((p) => deriveParticipant(p, asOf, rules));
  const overall = computeMetrics(valid, asOf, rules);
  const segments = Object.fromEntries(SEGMENTS.map((name) => {
    const group = valid.filter((p) => p.segment === name);
    const metrics = computeMetrics(group, asOf, rules, { installed: rules.segmentMinInstalled, notified: rules.segmentMinNotified });
    const states = Object.values(metrics.checks).map((check) => check.status);
    const status = group.length === 0 ? "none" : states.includes("fail") ? "needs_fix" : states.every((state) => state === "pass") ? "meets" : "insufficient";
    return [name, { ...metrics, status }];
  }));
  return { asOf, problems, overall, segments, dropouts: dropoutSummary(valid), interviews: interviewSummary(valid, asOf, rules) };
}

/** Evidence to be settled before inviting pilot users. */
export function evaluateGate({ distribution, ledger, sessions, h5, prerequisites }) {
  const items = [];
  const waived = (id) => (prerequisites.waivers ?? []).find((waiver) => waiver.item === id);
  const add = (item) => items.push({ ...item, waiver: item.status === "met" ? null : (waived(item.id) ?? null) });

  const ledgerProblems = validateLedger(ledger, distribution);
  const readiness = platformReadiness(ledger, distribution).filter((p) => p.committed);
  const missingPlatforms = readiness.filter((p) => !p.customer_ready).map((p) => p.id);
  add({
    id: "issue-7-distribution", kind: "evidence", source: "auto",
    title: "#7 Bản cài khách hàng đã cài và ghép nối trên máy sạch, trên mọi nền tảng cam kết",
    status: ledgerProblems.length === 0 && readiness.length > 0 && missingPlatforms.length === 0 ? "met" : "pending",
    detail: ledgerProblems.length ? ledgerProblems.join("; ") : missingPlatforms.length ? `Chưa có bằng chứng tải về của khách cho: ${missingPlatforms.join(", ")}` : "",
  });

  const study = evaluateSessions(sessions);
  add({
    id: "issue-14-h1-h4", kind: "evidence", source: "auto",
    title: "#14 Quan sát 8 người: H4 tự kết nối CLI và H1 tạo Radar dùng được",
    status: study.h1.verdict === "pass" && study.h4.verdict === "pass" ? "met" : "pending",
    detail: study.h1.verdict === "outstanding" || study.h4.verdict === "outstanding"
      ? `Chưa đủ bằng chứng (${study.participants}/${study.required} phiên hợp lệ).`
      : `H1 ${study.h1.verdict}, H4 ${study.h4.verdict}. Không đạt cần quyết định của chủ dự án ghi trong waivers.`,
  });

  for (const item of prerequisites.items ?? []) {
    const evidence = Boolean(item.evidence_ref);
    add({
      id: item.id, kind: item.kind, source: "manual", title: item.title,
      status: item.status === "met" && evidence ? "met" : "pending",
      detail: item.status === "met" && !evidence ? "Đánh dấu đã đạt nhưng thiếu evidence_ref." : (item.note ?? ""),
      evidence_ref: item.evidence_ref ?? null,
    });
  }
  const open = items.filter((item) => item.status !== "met" && !item.waiver);
  return { items, open, ready: open.length === 0, h5: { counted: h5.counted, verdict: h5.verdict } };
}

/** Evidence behind the expansion decision: pilot results, quality, operations and account safety. */
export function evaluateDecision({ pilot, h5, prerequisites, decision }) {
  const checks = pilot.overall.checks;
  const rows = [
    ...Object.entries({ activation: "Kích hoạt >= 60%", firstLead: "Tới tin đầu < 24 giờ", wrongRate: "Tin báo bị đánh dấu sai < 15%", retention: "Giữ chân tuần 4 >= 40%" })
      .map(([key, label]) => ({ area: "pilot", id: key, label, status: checks[key].status })),
    { area: "account", id: "h5", label: "H5: 0/3 tài khoản bị hạn chế sau 30 ngày", status: h5.verdict === "pass" ? "pass" : h5.verdict === "fail" ? "fail" : "insufficient" },
  ];
  for (const item of prerequisites.expansion_evidence ?? []) {
    rows.push({ area: item.area, id: item.id, label: item.title, status: item.status === "met" && item.evidence_ref ? "pass" : item.status === "failed" && item.evidence_ref ? "fail" : "insufficient", evidence_ref: item.evidence_ref ?? null });
  }
  const interviews = pilot.interviews;
  rows.push({
    area: "pilot", id: "interviews", label: "Phỏng vấn sau 2 tuần (việc đã xử lý, chi phí AI)",
    status: interviews.eligible > 0 && interviews.missing.length === 0 ? "pass" : "insufficient",
  });
  if (interviews.aiLimitHit.length || interviews.aiAffectedOtherUse.length) {
    rows.push({ area: "pilot", id: "ai-quota", label: "Radar không làm cạn hạn mức gói AI", status: "fail" });
  }
  const meets = pilot.overall.installed > 0 && rows.every((row) => row.status === "pass");
  // A segment with nobody in it has no evidence either way.
  const segmentsView = Object.fromEntries(Object.entries(pilot.segments).map(([name, seg]) => [name, seg.status === "none" ? "insufficient" : seg.status]));
  const contradiction = decision && /^expand/.test(decision.decision ?? "") && !meets
    ? `Quyết định "${decision.decision}" (${decision.date ?? "?"}) được ghi khi bằng chứng chưa đủ hoặc có mục không đạt.`
    : null;
  return {
    rows,
    meetsAll: meets,
    needsFix: rows.filter((row) => row.status === "fail").map((row) => row.id),
    insufficient: rows.filter((row) => row.status === "insufficient").map((row) => row.id),
    segments: segmentsView,
    contradiction,
    recordedDecision: decision ?? null,
  };
}

const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(0)}%`);
const hours = (value) => (value === null ? "—" : value === Infinity ? "không có tin trong 24 giờ" : `${value.toFixed(1)} giờ`);
const STATUS = { pass: "ĐẠT", fail: "KHÔNG ĐẠT", insufficient: "CHƯA ĐỦ BẰNG CHỨNG" };

function metricLines(metrics) {
  const { checks } = metrics;
  return [
    `  - Kích hoạt (cài xong có radar chạy trong phiên đầu): ${checks.activation.numerator}/${checks.activation.denominator} = ${pct(checks.activation.value)}; ngưỡng >= 60% → ${STATUS[checks.activation.status]}`,
    `  - Thời gian tới tin đầu (trung vị, từ lúc bật radar): ${hours(checks.firstLead.value)}; ngưỡng < 24 giờ; ${checks.firstLead.numerator}/${checks.firstLead.denominator} dưới 24 giờ, ${checks.firstLead.pending} còn trong cửa sổ 24 giờ → ${STATUS[checks.firstLead.status]}`,
    `  - Tỉ lệ tin sai (bị đánh dấu sai / đã báo): ${checks.wrongRate.numerator}/${checks.wrongRate.denominator} = ${pct(checks.wrongRate.value)}; ngưỡng < 15% → ${STATUS[checks.wrongRate.status]}`,
    `  - Giữ chân tuần 4 (còn radar chạy / đã tới tuần 4): ${checks.retention.numerator}/${checks.retention.denominator} = ${pct(checks.retention.value)}; ngưỡng >= 40%${checks.retention.missing.length ? `; THIẾU số liệu: ${checks.retention.missing.join(", ")}` : ""} → ${STATUS[checks.retention.status]}`,
  ];
}

export function renderReport(pilot) {
  const o = pilot.overall;
  const lines = [`Pilot đến ngày ${pilot.asOf}: ghi danh ${o.enrolled}, cài xong ${o.installed}, bật radar ở phiên đầu ${o.activated}.`];
  for (const problem of pilot.problems) lines.push(`LỖI DỮ LIỆU: ${problem}`);
  lines.push("", "Chỉ số PRD §8 (cả nhóm):", ...metricLines(o));
  lines.push("", `Người bỏ cuộc: ${pilot.dropouts.dropped}/${pilot.dropouts.enrolled} đã ghi danh.`);
  for (const [reason, n] of Object.entries(pilot.dropouts.byReason)) lines.push(`  - lý do ${reason}: ${n}`);
  for (const [stage, n] of Object.entries(pilot.dropouts.byStage)) lines.push(`  - giai đoạn ${stage}: ${n}`);
  const iv = pilot.interviews;
  lines.push("", `Phỏng vấn sau 2 tuần: ${iv.done}/${iv.eligible} người đến hạn${iv.missing.length ? `; chưa phỏng vấn: ${iv.missing.join(", ")}` : ""}.`);
  lines.push(`  - việc thực tế đã xử lý: ${iv.handledTotal} (${iv.handledAny} người có ít nhất một việc)`);
  lines.push(`  - chi phí AI/tháng: ${iv.aiMonthlyCostVnd.reported} người khai, trung vị ${iv.aiMonthlyCostVnd.median ?? "—"} VND; mua gói AI riêng cho việc này: ${iv.boughtAiForThis}`);
  lines.push(`  - chạm giới hạn gói AI: ${iv.aiLimitHit.length ? iv.aiLimitHit.join(", ") : "không ai"}; ảnh hưởng việc dùng AI khác: ${iv.aiAffectedOtherUse.length ? iv.aiAffectedOtherUse.join(", ") : "không ai"}`);
  lines.push("", "Theo nhu cầu (ngành):");
  for (const name of SEGMENTS) {
    const seg = pilot.segments[name];
    lines.push(`  - ${name}: ${{ none: "chưa có người", meets: "ĐẠT", needs_fix: "CẦN SỬA", insufficient: "CHƯA ĐỦ BẰNG CHỨNG" }[seg.status]} (cài xong ${seg.installed})`);
    if (seg.installed) lines.push(...metricLines(seg).map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

export function renderGate(gate) {
  const lines = [gate.ready
    ? "Đủ bằng chứng điều kiện tiên quyết để MỜI người dùng pilot (đây chưa phải quyết định mở pilot; chủ dự án quyết định)."
    : `CHƯA ĐỦ điều kiện để mời người dùng pilot. Còn ${gate.open.length} mục:`];
  for (const item of gate.items) {
    const mark = item.status === "met" ? "ĐÃ CÓ" : item.waiver ? "MIỄN (waiver)" : "CÒN THIẾU";
    lines.push(`  [${mark}] ${item.id} · ${item.title}${item.detail ? ` — ${item.detail}` : ""}${item.evidence_ref ? ` · bằng chứng: ${item.evidence_ref}` : ""}${item.waiver ? ` · ${item.waiver.date}: ${item.waiver.rationale}` : ""}`);
  }
  lines.push("", `H5 tài khoản (không chặn việc mời pilot, nhưng cần trước quyết định mở rộng): ${gate.h5.counted}/3 tài khoản đủ điều kiện, kết luận ${gate.h5.verdict}.`);
  return lines.join("\n");
}

export function renderDecision(result) {
  const lines = [`Bằng chứng cho quyết định mở rộng: ${result.meetsAll ? "ĐỦ VÀ ĐẠT TẤT CẢ" : "CHƯA ĐỦ để đề xuất mở rộng"}.`];
  for (const row of result.rows) lines.push(`  - [${row.area}] ${row.label}: ${STATUS[row.status]}${row.evidence_ref ? ` · ${row.evidence_ref}` : ""}`);
  lines.push("", `Nhu cầu đạt: ${Object.entries(result.segments).filter(([, status]) => status === "meets").map(([name]) => name).join(", ") || "(chưa có)"}`);
  lines.push(`Nhu cầu cần sửa: ${Object.entries(result.segments).filter(([, status]) => status === "needs_fix").map(([name]) => name).join(", ") || "(chưa có)"}`);
  lines.push(`Chưa đủ bằng chứng: ${Object.entries(result.segments).filter(([, status]) => status === "insufficient").map(([name]) => name).join(", ") || "(không)"}${result.insufficient.length ? ` · mục: ${result.insufficient.join(", ")}` : ""}`);
  if (result.needsFix.length) lines.push(`Mục không đạt: ${result.needsFix.join(", ")}`);
  if (result.contradiction) lines.push(`MÂU THUẪN: ${result.contradiction}`);
  lines.push(result.recordedDecision ? `Quyết định đã ghi: ${result.recordedDecision.decision} (${result.recordedDecision.date ?? "?"})` : "Chưa có quyết định ghi trong decision.json. Quyết định thuộc về chủ dự án, không do công cụ đưa ra.");
  return lines.join("\n");
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function main(argv) {
  const [command = "report", ...rest] = argv.slice(2);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const study = path.join(root, "docs/delivery/studies");
  const asOfArg = rest.indexOf("--as-of");
  const asOf = asOfArg >= 0 ? rest[asOfArg + 1] : new Date().toISOString().slice(0, 10);
  if (!isDate(asOf)) throw new Error("--as-of phải là YYYY-MM-DD");
  const pilotFile = readJson(path.join(study, "pilot-4w/participants.json"), { participants: [] });
  const prerequisites = readJson(path.join(study, "pilot-4w/prerequisites.json"), { items: [], waivers: [], expansion_evidence: [] });
  const h5File = readJson(path.join(study, "h5-account-safety/accounts.json"), { accounts: [], decisions: [] });
  const h5 = evaluateAccounts(h5File.accounts, h5File.decisions);
  const json = rest.includes("--json");
  let result;
  let text;
  if (command === "gate") {
    result = evaluateGate({
      distribution: readJson(path.join(root, "docs/delivery/distribution.json")),
      ledger: readJson(path.join(root, "docs/delivery/distribution-evidence.json")),
      sessions: readJson(path.join(study, "h1-h4/sessions.json"), []),
      h5, prerequisites,
    });
    text = renderGate(result);
  } else if (command === "report") {
    result = evaluatePilot(pilotFile.participants, asOf);
    text = renderReport(result);
  } else if (command === "decision") {
    const pilot = evaluatePilot(pilotFile.participants, asOf);
    result = evaluateDecision({ pilot, h5, prerequisites, decision: readJson(path.join(study, "pilot-4w/decision.json"), null) });
    text = renderDecision(result);
  } else {
    throw new Error("Dùng: pilot-report.mjs gate | report | decision [--as-of YYYY-MM-DD] [--json]");
  }
  console.log(json ? JSON.stringify(result, null, 2) : text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
