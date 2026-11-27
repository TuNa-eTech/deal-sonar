#!/usr/bin/env node
/**
 * Scores the observed H1 (create a usable Radar in under 5 minutes) and H4 (connect an AI CLI
 * without help) study from per-participant session records.
 *
 * Thresholds mirror `docs/delivery/02-validation-plan.md` §2 and §5 and must not change after
 * data collection starts. With fewer than 8 valid sessions the report refuses to call a pass or
 * a fail: it lists what is still outstanding.
 *
 * Usage: node scripts/study-report.mjs [sessions.json] [--json] [--strict]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INDUSTRIES = ["bds", "dich-vu-nha-cua", "xe-cu"];
export const STEPS = ["cli", "describe", "fields", "sources", "preview", "activate"];

export const THRESHOLDS = Object.freeze({
  participants: 8,
  minPerIndustry: 2,
  /** A person who never succeeded counts as this many minutes when taking the median. */
  capMinutes: 30,
  h4: { unaided: 5, medianMinutes: 10 },
  h1: { medianMinutes: 5, fastMinutes: 7, fast: 6, unaided: 6, usable: 6, usableShare: 0.7 },
});

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const isMinutes = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const asList = (value) => (Array.isArray(value) ? value : []);

/** Returns a list of problems; an empty list means the record can be scored. */
export function validateSession(session) {
  const errors = [];
  const where = session?.id ?? "(không có id)";
  const need = (ok, message) => { if (!ok) errors.push(`${where}: ${message}`); };
  need(/^P\d{2}$/.test(session?.id ?? ""), "id phải dạng P01…P99, không dùng tên thật");
  need(INDUSTRIES.includes(session?.industry), `industry phải là một trong ${INDUSTRIES.join(", ")}`);
  need(session?.technical === false, "người tham gia phải xác nhận không làm nghề kỹ thuật (technical: false)");
  need(session?.consent === true, "thiếu consent: true");
  const cli = session?.cli;
  need(cli && typeof cli.completed_unaided === "boolean", "cli.completed_unaided phải là true/false");
  need(cli && typeof cli.succeeded === "boolean", "cli.succeeded phải là true/false");
  need(cli && isMinutes(cli.minutes), "cli.minutes phải là số phút >= 0 (tới lúc nối xong hoặc bỏ cuộc)");
  need(!(cli?.completed_unaided && cli?.succeeded === false), "cli: không thể tự hoàn thành mà không thành công");
  const radar = session?.radar;
  need(radar && typeof radar.completed_unaided === "boolean", "radar.completed_unaided phải là true/false");
  need(radar && typeof radar.activated === "boolean", "radar.activated phải là true/false");
  need(radar && isMinutes(radar.minutes), "radar.minutes phải là số phút >= 0 (từ bấm Tạo radar tới active hoặc bỏ cuộc)");
  need(!(radar?.completed_unaided && radar?.activated === false), "radar: không thể tự hoàn thành mà chưa bật");
  const usable = radar?.usable;
  if (radar?.activated) {
    need(usable && Number.isInteger(usable.confirmed) && Number.isInteger(usable.shown) && usable.shown >= 0
      && usable.confirmed >= 0 && usable.confirmed <= usable.shown,
    "radar.usable cần confirmed <= shown (số bài khớp người tham gia xác nhận / số bài khớp ở màn xem thử)");
  }
  for (const [list, label] of [[session?.blockers, "blockers"], [session?.wrong_assumptions, "wrong_assumptions"]]) {
    need(list === undefined || Array.isArray(list), `${label} phải là mảng`);
  }
  for (const blocker of asList(session?.blockers)) {
    need(typeof blocker?.id === "string" && blocker.id.length > 0, "mỗi blocker cần id ngắn, ví dụ cli-login");
    need(STEPS.includes(blocker?.step), `blocker.step phải là một trong ${STEPS.join(", ")}`);
    need(typeof blocker?.blocks_activation === "boolean", "blocker.blocks_activation phải là true/false");
  }
  return errors;
}

const timeFor = (succeeded, minutes, cap) => (succeeded ? minutes : cap);
const usableRun = (session, share) => {
  const usable = session.radar.usable;
  return Boolean(session.radar.activated && usable && usable.shown > 0 && usable.confirmed / usable.shown >= share);
};

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/** Blockers ranked by whether they stop activation, then by how many different people hit them. */
export function rankBlockers(sessions) {
  const rows = [];
  for (const session of sessions) {
    for (const blocker of asList(session.blockers)) rows.push({ ...blocker, participant: session.id });
  }
  const ranked = [...groupBy(rows, (row) => row.id)].map(([id, hits]) => ({
    id,
    step: hits[0].step,
    summary: hits.find((hit) => hit.summary)?.summary ?? "",
    blocks_activation: hits.some((hit) => hit.blocks_activation),
    participants: [...new Set(hits.map((hit) => hit.participant))].sort(),
    fixes: [...new Set(hits.map((hit) => hit.fix).filter(Boolean))],
  }));
  return ranked.sort((a, b) =>
    Number(b.blocks_activation) - Number(a.blocks_activation)
    || b.participants.length - a.participants.length
    || a.id.localeCompare(b.id));
}

/** Where people asked for help, counted by distinct people per step. */
export function helpPlaces(sessions) {
  const rows = [];
  for (const session of sessions) {
    for (const part of ["cli", "radar"]) {
      for (const request of asList(session[part]?.help_requests)) {
        rows.push({ where: request.where ?? `${part}:khác`, participant: session.id, note: request.note ?? "" });
      }
    }
  }
  return [...groupBy(rows, (row) => row.where)]
    .map(([where, hits]) => ({ where, participants: [...new Set(hits.map((hit) => hit.participant))].sort() }))
    .sort((a, b) => b.participants.length - a.participants.length || a.where.localeCompare(b.where));
}

/** Assumptions the app showed that the participant had to correct, and how they fixed them. */
export function wrongAssumptions(sessions) {
  const rows = [];
  for (const session of sessions) {
    for (const item of asList(session.wrong_assumptions)) rows.push({ ...item, participant: session.id });
  }
  return [...groupBy(rows, (row) => String(row.assumption ?? "").trim().toLowerCase())]
    .map(([, hits]) => ({
      assumption: hits[0].assumption,
      step: hits[0].step ?? null,
      participants: [...new Set(hits.map((hit) => hit.participant))].sort(),
      fixes: [...new Set(hits.map((hit) => hit.fix).filter(Boolean))],
      blocks_activation: hits.some((hit) => hit.blocks_activation === true),
    }))
    .sort((a, b) => b.participants.length - a.participants.length);
}

/** Pass/fail only when all eight sessions are valid and the industry mix is as planned. */
export function evaluate(sessions, thresholds = THRESHOLDS) {
  const problems = sessions.flatMap(validateSession);
  const ids = sessions.map((session) => session?.id);
  if (new Set(ids).size !== ids.length) problems.push("Có id người tham gia bị trùng.");
  const usableSessions = sessions.filter((session) => validateSession(session).length === 0);
  const n = usableSessions.length;
  const byIndustry = Object.fromEntries(INDUSTRIES.map((name) => [name, usableSessions.filter((s) => s.industry === name).length]));
  const mixOk = INDUSTRIES.every((name) => byIndustry[name] >= thresholds.minPerIndustry);

  const { capMinutes } = thresholds;
  const cliTimes = usableSessions.map((s) => timeFor(s.cli.succeeded, s.cli.minutes, capMinutes));
  const radarTimes = usableSessions.map((s) => timeFor(s.radar.activated, s.radar.minutes, capMinutes));
  const h4 = {
    unaided: usableSessions.filter((s) => s.cli.completed_unaided).length,
    medianMinutes: median(cliTimes),
  };
  const h1 = {
    unaided: usableSessions.filter((s) => s.radar.completed_unaided).length,
    medianMinutes: median(radarTimes),
    fast: radarTimes.filter((minutes, i) => usableSessions[i].radar.activated && minutes < thresholds.h1.fastMinutes).length,
    usable: usableSessions.filter((s) => usableRun(s, thresholds.h1.usableShare)).length,
    fieldsEdited: median(usableSessions.map((s) => s.radar.fields_edited).filter(isMinutes)),
  };
  const checks = {
    h4: [
      { name: `Tự kết nối CLI >= ${thresholds.h4.unaided}/${thresholds.participants}`, value: h4.unaided, ok: h4.unaided >= thresholds.h4.unaided },
      { name: `Trung vị kết nối CLI < ${thresholds.h4.medianMinutes} phút`, value: h4.medianMinutes, ok: h4.medianMinutes !== null && h4.medianMinutes < thresholds.h4.medianMinutes },
    ],
    h1: [
      { name: `Trung vị tạo Radar < ${thresholds.h1.medianMinutes} phút`, value: h1.medianMinutes, ok: h1.medianMinutes !== null && h1.medianMinutes < thresholds.h1.medianMinutes },
      { name: `>= ${thresholds.h1.fast}/${thresholds.participants} người dưới ${thresholds.h1.fastMinutes} phút`, value: h1.fast, ok: h1.fast >= thresholds.h1.fast },
      { name: `Tự hoàn thành >= ${thresholds.h1.unaided}/${thresholds.participants}`, value: h1.unaided, ok: h1.unaided >= thresholds.h1.unaided },
      { name: `Radar dùng được (>= ${thresholds.h1.usableShare * 100}% bài khớp được xác nhận) >= ${thresholds.h1.usable}/${thresholds.participants}`, value: h1.usable, ok: h1.usable >= thresholds.h1.usable },
    ],
  };
  const conclusive = n === thresholds.participants && mixOk && problems.length === 0;
  const verdict = (list) => (!conclusive ? "outstanding" : list.every((check) => check.ok) ? "pass" : "fail");
  const outstanding = [];
  if (n < thresholds.participants) outstanding.push(`Mới có ${n}/${thresholds.participants} phiên hợp lệ.`);
  if (n === thresholds.participants && !mixOk) outstanding.push(`Chưa đủ ${thresholds.minPerIndustry} người mỗi ngành (${INDUSTRIES.map((name) => `${name}: ${byIndustry[name]}`).join(", ")}).`);
  if (problems.length) outstanding.push("Có bản ghi lỗi cần sửa trước khi kết luận.");
  return {
    participants: n,
    required: thresholds.participants,
    byIndustry,
    conclusive,
    outstanding,
    problems,
    h4: { ...h4, checks: checks.h4, verdict: verdict(checks.h4) },
    h1: { ...h1, checks: checks.h1, verdict: verdict(checks.h1) },
    blockers: rankBlockers(usableSessions),
    helpPlaces: helpPlaces(usableSessions),
    wrongAssumptions: wrongAssumptions(usableSessions),
  };
}

const LABEL = { pass: "ĐẠT", fail: "KHÔNG ĐẠT", outstanding: "CHƯA CÓ ĐỦ BẰNG CHỨNG" };
const fmt = (value) => (value === null || value === undefined ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(1));

export function renderReport(result) {
  const lines = [];
  lines.push(`Phiên hợp lệ: ${result.participants}/${result.required}. Ngành: ${INDUSTRIES.map((name) => `${name} ${result.byIndustry[name]}`).join(", ")}.`);
  for (const text of result.outstanding) lines.push(`CÒN THIẾU: ${text}`);
  for (const text of result.problems) lines.push(`LỖI DỮ LIỆU: ${text}`);
  for (const [key, title] of [["h4", "H4 · Tự kết nối CLI AI"], ["h1", "H1 · Tạo Radar dùng được"]]) {
    const section = result[key];
    lines.push("", `${title}: ${LABEL[section.verdict]}`);
    for (const check of section.checks) {
      const mark = result.conclusive ? (check.ok ? "ĐẠT" : "TRƯỢT") : "chưa kết luận";
      lines.push(`  - ${check.name}: ${fmt(check.value)} (${mark})`);
    }
  }
  lines.push("", "Lỗi cản kích hoạt và lỗi khác, xếp theo mức chặn rồi theo số người gặp:");
  if (!result.blockers.length) lines.push("  (chưa ghi lỗi nào)");
  for (const blocker of result.blockers) {
    lines.push(`  - [${blocker.blocks_activation ? "CHẶN BẬT" : "gây chậm"}] ${blocker.id} (${blocker.step}) · ${blocker.participants.length} người: ${blocker.participants.join(", ")}${blocker.summary ? ` · ${blocker.summary}` : ""}`);
  }
  lines.push("", "Nơi cần trợ giúp (số người):");
  if (!result.helpPlaces.length) lines.push("  (chưa ghi)");
  for (const place of result.helpPlaces) lines.push(`  - ${place.where}: ${place.participants.length}`);
  lines.push("", "Giả định sai và cách khách sửa:");
  if (!result.wrongAssumptions.length) lines.push("  (chưa ghi)");
  for (const item of result.wrongAssumptions) {
    lines.push(`  - ${item.assumption} · ${item.participants.length} người · cách sửa: ${item.fixes.join("; ") || "chưa ghi"}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = args.find((arg) => !arg.startsWith("--")) ?? path.join(here, "../docs/delivery/studies/h1-h4/sessions.json");
  const sessions = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(sessions)) throw new Error(`${file} phải là một mảng các phiên.`);
  const result = evaluate(sessions);
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderReport(result));
  if (args.includes("--strict") && !(result.h1.verdict === "pass" && result.h4.verdict === "pass")) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
