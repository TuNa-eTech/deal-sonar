// Port of crates/notify/src/format/*: HTML escaping, URL validation, value formatting, Telegram
// keyboards, notification policy, digest/system-alert text and the lead-alert layout.

import type { ExtractedField, FieldDef, FieldType, QuietHours } from "../store/domain";
import { NotifyError } from "./errors";

/** Telegram `sendMessage` maximum message length (UTF-16 code units). */
export const MAX_TELEGRAM_HTML_LEN = 4096;
/** Telegram `callback_data` strict upper bound (`< 64` bytes). */
export const MAX_CALLBACK_DATA_BYTES = 64;
/** Radar hourly lead flood threshold triggering automatic digest mode. */
export const FLOOD_LEADS_PER_HOUR_THRESHOLD = 30;

/** Extracted field as the notify crate sees it (`raw` defaults to the empty string). */
export interface NotifyExtractedField {
  value: unknown;
  raw: string;
  confidence: number;
  source: string;
}

// ---- numeric rendering ------------------------------------------------------------------------

/** Rust `f64::round`: halves round away from zero. */
export const roundHalfAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/**
 * Rust `format!("{:.N}")`: JS `toFixed` rounds exact ties up, Rust rounds them to even.
 * Only meaningful for `digits >= 1` and `|x| < 1e21`.
 */
export function rustFixed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21 || digits < 1) return s;
  const long = x.toFixed(Math.min(100, digits + 40));
  const dot = long.indexOf(".");
  const tail = long.slice(dot + 1 + digits);
  if (!/^50*$/.test(tail)) return s;
  const truncated = long.slice(0, dot + 1 + digits);
  const lastDigit = Number(truncated[truncated.length - 1]);
  return lastDigit % 2 === 0 ? truncated : s;
}

const trimTrailingZerosAndDot = (s: string): string => s.replace(/0+$/, "").replace(/\.$/, "");

// ---- escaping / urls --------------------------------------------------------------------------

/** Strict HTML escaping for Telegram `parse_mode: "HTML"` (`&`, `<`, `>`). */
export function escapeHtml(input: string): string {
  let out = "";
  for (const ch of input) {
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
  }
  return out;
}

export function escapeHtmlAttr(input: string): string {
  let out = "";
  for (const ch of input) {
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch;
  }
  return out;
}

const CONTROL_OR_SPACE = /[\p{Cc}\s]/u;

/** A well-formed `https://` URL with a host and no control characters / whitespace. */
export function validateHttpsPermalink(permalink: string): URL {
  const trimmed = permalink.trim();
  if (trimmed === "" || CONTROL_OR_SPACE.test(trimmed)) throw NotifyError.invalidPermalink(permalink);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw NotifyError.invalidPermalink(permalink);
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") throw NotifyError.invalidPermalink(permalink);
  return parsed;
}

const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "fb.com",
  "www.fb.com",
]);

export function isValidFacebookHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = validateHttpsPermalink(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return FACEBOOK_HOSTS.has(parsed.hostname.toLowerCase());
}

// ---- value formatting -------------------------------------------------------------------------

/** E.164 / raw Vietnamese number to domestic click-to-call text (`+84912345678` -> `0912 345 678`). */
export function formatDomesticPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed === "") return "";

  let normalized: string | null = null;
  if (trimmed.startsWith("+84")) {
    const digits = trimmed.slice(3).replace(/[^0-9]/g, "");
    normalized = digits !== "" ? `0${digits}` : null;
  } else if (/^[0-9 .-]*$/.test(trimmed)) {
    const digits = trimmed.replace(/[^0-9]/g, "");
    if (digits.startsWith("84") && (digits.length === 11 || digits.length === 12)) normalized = `0${digits.slice(2)}`;
    else if (digits.startsWith("0")) normalized = digits;
  }

  if (normalized !== null) {
    if (normalized.length === 10) return `${normalized.slice(0, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 10)}`;
    if (normalized.length === 11) return `${normalized.slice(0, 3)} ${normalized.slice(3, 7)} ${normalized.slice(7, 11)}`;
    return normalized;
  }
  return trimmed;
}

export function formatVnDecimal(val: number): string {
  const rounded = roundHalfAway(val * 100) / 100;
  if (Math.abs(rounded - roundHalfAway(rounded)) < 1e-9) return String(roundHalfAway(rounded));
  return trimTrailingZerosAndDot(rustFixed(rounded, 2)).replace(".", ",");
}

export function formatPlainNumber(val: number): string {
  if (Math.abs(val - roundHalfAway(val)) < 1e-9) return String(roundHalfAway(val));
  return trimTrailingZerosAndDot(rustFixed(val, 2));
}

function vndUnitAndScale(amount: number): [string, number] {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return ["tỷ", 1_000_000_000];
  if (abs >= 1_000_000) return ["triệu", 1_000_000];
  if (abs >= 1_000) return ["nghìn", 1_000];
  return ["đ", 1];
}

function formatSingleVnd(amount: number): string {
  const [unit, scale] = vndUnitAndScale(amount);
  return `${formatVnDecimal(amount / scale)} ${unit}`;
}

function formatPeriodVi(period: unknown): string {
  const p = typeof period === "string" ? period.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()) : null;
  switch (p) {
    case "month":
    case "thang":
    case "tháng":
      return "/tháng";
    case "year":
    case "nam":
    case "năm":
      return "/năm";
    case "day":
    case "ngay":
    case "ngày":
      return "/ngày";
    case "week":
    case "tuan":
    case "tuần":
      return "/tuần";
    case "m2":
    case "sqm":
      return "/m2";
    default:
      return "";
  }
}

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asF64 = (v: Json): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonEmptyTrimmed = (v: Json): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** `{min,max,currency,period}` / number -> natural Vietnamese currency text. */
export function formatVietnameseMoney(value: Json): string | null {
  const num = asF64(value);
  if (num !== null) return formatSingleVnd(num);
  if (!isObject(value)) return null;

  const amount = asF64(value.amount);
  const minOpt = asF64(value.min) ?? amount;
  const maxOpt = asF64(value.max) ?? amount;
  let minVal: number;
  let maxVal: number;
  if (minOpt !== null && maxOpt !== null) [minVal, maxVal] = [minOpt, maxOpt];
  else if (minOpt !== null) [minVal, maxVal] = [minOpt, minOpt];
  else if (maxOpt !== null) [minVal, maxVal] = [maxOpt, maxOpt];
  else return null;

  const currency = nonEmptyTrimmed(value.currency) ?? "VND";
  const periodSuffix = formatPeriodVi(value.period);

  let base: string;
  if (currency.toLowerCase() === "vnd") {
    if (Math.abs(maxVal - minVal) < 0.5) {
      base = formatSingleVnd(minVal);
    } else {
      const [uMin, sMin] = vndUnitAndScale(minVal);
      const [uMax, sMax] = vndUnitAndScale(maxVal);
      base =
        uMin === uMax
          ? `${formatVnDecimal(minVal / sMin)}–${formatVnDecimal(maxVal / sMax)} ${uMax}`
          : `${formatSingleVnd(minVal)}–${formatSingleVnd(maxVal)}`;
    }
  } else if (Math.abs(maxVal - minVal) < 0.01) {
    base = `${formatVnDecimal(minVal)} ${currency}`;
  } else {
    base = `${formatVnDecimal(minVal)}–${formatVnDecimal(maxVal)} ${currency}`;
  }
  return `${base}${periodSuffix}`;
}

/** Format an extracted value by field type; `null` means "skip this bullet". */
export function formatFieldValue(fieldType: FieldType, value: Json): string | null {
  if (value === null || value === undefined) return null;
  let rendered: string;
  switch (fieldType) {
    case "money": {
      const m = formatVietnameseMoney(value);
      if (m === null) return null;
      rendered = m;
      break;
    }
    case "phone": {
      if (typeof value !== "string") return null;
      rendered = formatDomesticPhone(value);
      break;
    }
    case "location": {
      if (typeof value === "string") {
        rendered = value.trim();
      } else if (isObject(value)) {
        const district = nonEmptyTrimmed(value.district);
        const province = nonEmptyTrimmed(value.province);
        const ward = nonEmptyTrimmed(value.ward);
        const raw = nonEmptyTrimmed(value.raw);
        if (district && province) rendered = `${district}, ${province}`;
        else if (district) rendered = district;
        else if (province) rendered = ward ? `${ward}, ${province}` : province;
        else {
          const fallback = ward ?? raw;
          if (fallback === null) return null;
          rendered = fallback;
        }
      } else return null;
      break;
    }
    case "range": {
      if (typeof value === "string") {
        rendered = value.trim();
      } else if (isObject(value)) {
        const min = asF64(value.min);
        const max = asF64(value.max);
        const unit = nonEmptyTrimmed(value.unit);
        let nums: string;
        if (min !== null && max !== null) {
          nums = Math.abs(max - min) < 1e-9 ? formatPlainNumber(min) : `${formatPlainNumber(min)}–${formatPlainNumber(max)}`;
        } else if (min !== null) nums = formatPlainNumber(min);
        else if (max !== null) nums = formatPlainNumber(max);
        else return null;
        rendered = unit ? `${nums} ${unit}` : nums;
      } else return null;
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") return null;
      rendered = value ? "Có" : "Không";
      break;
    }
    case "multi_enum": {
      if (!Array.isArray(value)) return null;
      const items = value
        .map((v) => (typeof v === "string" ? v.trim() : null))
        .filter((s): s is string => s !== null && s !== "");
      if (items.length === 0) return null;
      rendered = items.join(", ");
      break;
    }
    case "number": {
      const n = asF64(value);
      if (n !== null) rendered = formatPlainNumber(n);
      else if (typeof value === "string") rendered = value.trim();
      else return null;
      break;
    }
    default: {
      // text | enum | date | url
      if (typeof value === "string") rendered = value.trim();
      else if (asF64(value) !== null) rendered = formatPlainNumber(value as number);
      else if (typeof value === "boolean") rendered = String(value);
      else return null;
    }
  }
  return rendered === "" ? null : rendered;
}

/** `post.created_at` relative to `nowMs` in Vietnamese (`vừa thấy` when unknown). */
export function formatRelativeTimeVi(createdAtMs: number | null | undefined, nowMs: number): string {
  if (createdAtMs === null || createdAtMs === undefined) return "vừa thấy";
  const diffS = Math.max(0, Math.trunc((nowMs - createdAtMs) / 1000));
  if (diffS < 60) return "vừa xong";
  if (diffS < 3600) return `${Math.trunc(diffS / 60)} phút trước`;
  if (diffS < 86_400) return `${Math.trunc(diffS / 3600)} giờ trước`;
  return `${Math.trunc(diffS / 86_400)} ngày trước`;
}

// ---- keyboards --------------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export function validateCallbackDataBytes(data: string): void {
  const len = Buffer.byteLength(data, "utf8");
  if (len === 0 || len >= MAX_CALLBACK_DATA_BYTES) throw NotifyError.invalidCallbackData(len);
}

export function urlButton(text: string, url: string): InlineKeyboardButton {
  const parsed = validateHttpsPermalink(url);
  return { text, url: parsed.href };
}

export function callbackButton(text: string, callbackData: string): InlineKeyboardButton {
  validateCallbackDataBytes(callbackData);
  return { text, callback_data: callbackData };
}

/** `fb:{lead_id}:{label}`, enforcing the `< 64` byte limit. */
export function buildFeedbackCallbackData(leadId: string, label: string): string {
  const lead = leadId.trim();
  const lab = label.trim();
  if (lead === "" || lab === "" || lead.includes(":") || lab.includes(":")) {
    throw NotifyError.invalidCallbackData(Buffer.byteLength(leadId) + Buffer.byteLength(label) + 4);
  }
  const data = `fb:${lead}:${lab}`;
  validateCallbackDataBytes(data);
  return data;
}

/** Parse `fb:<lead_id>:<action>`. */
export function parseFeedbackCallbackData(data: string): [string, string] | null {
  if (data === "" || Buffer.byteLength(data, "utf8") >= MAX_CALLBACK_DATA_BYTES) return null;
  if (!data.startsWith("fb:")) return null;
  const rest = data.slice(3);
  const idx = rest.indexOf(":");
  if (idx < 0) return null;
  const leadId = rest.slice(0, idx);
  const action = rest.slice(idx + 1);
  if (leadId === "" || action === "" || action.includes(":")) return null;
  return [leadId, action];
}

export function buildLeadAlertKeyboard(leadId: string, permalink: string): InlineKeyboardMarkup {
  // Pre-validate the longest reason callback so the follow-up buttons are guaranteed < 64 bytes.
  buildFeedbackCallbackData(leadId, "irrelevant");
  const open = urlButton("Mở bài viết", permalink);
  const correct = callbackButton("✅ Đúng", buildFeedbackCallbackData(leadId, "correct"));
  const wrong = callbackButton("❌ Sai", buildFeedbackCallbackData(leadId, "wrong"));
  return { inline_keyboard: [[open, correct, wrong]] };
}

export function buildWrongReasonsKeyboard(
  leadId: string,
  existingUrlButton: InlineKeyboardButton | null,
): InlineKeyboardMarkup {
  const irrelevant = callbackButton("Không liên quan", buildFeedbackCallbackData(leadId, "irrelevant"));
  const peer = callbackButton("Cùng nghề", buildFeedbackCallbackData(leadId, "peer"));
  const duplicate = callbackButton("Trùng", buildFeedbackCallbackData(leadId, "duplicate"));
  const spam = callbackButton("Rác", buildFeedbackCallbackData(leadId, "spam"));
  const rows: InlineKeyboardButton[][] = [];
  if (existingUrlButton) rows.push([existingUrlButton]);
  rows.push([irrelevant, peer], [duplicate, spam]);
  return { inline_keyboard: rows };
}

export function buildAcknowledgedKeyboard(
  ackLabel: string,
  existingUrlButton: InlineKeyboardButton | null,
): InlineKeyboardMarkup {
  const ack = callbackButton(ackLabel, "noop");
  return { inline_keyboard: [existingUrlButton ? [existingUrlButton, ack] : [ack]] };
}

// ---- policy -----------------------------------------------------------------------------------

function parseHhMm(s: string): number | null {
  const idx = s.trim().indexOf(":");
  if (idx < 0) return null;
  const trimmed = s.trim();
  const hs = trimmed.slice(0, idx);
  const ms = trimmed.slice(idx + 1);
  if (!/^\+?\d+$/.test(hs) || !/^\+?\d+$/.test(ms)) return null;
  const h = Number(hs);
  const m = Number(ms);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

export function isInQuietHours(quiet: QuietHours, hour: number, minute: number): boolean {
  const from = parseHhMm(quiet.from);
  const to = parseHhMm(quiet.to);
  if (from === null || to === null) return false;
  const cur = hour * 60 + minute;
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

export type NotifySkipReason =
  | "radar_not_active"
  | "no_channels_configured"
  | "below_min_score"
  | "duplicate_cluster_member"
  | "stale_evaluation"
  | "preview_or_backfill";

export type NotifyDecision =
  | { kind: "send_instant"; triggerFloodAutoDigest: boolean }
  | { kind: "queue_digest"; triggerFloodAutoDigest: boolean }
  | { kind: "skip"; reason: NotifySkipReason };

export interface NotifyPolicyCheck {
  radarActive: boolean;
  hasChannels: boolean;
  digestMode: boolean;
  score: number;
  minScore: number;
  isClusterHead: boolean;
  repostAfter72h: boolean;
  capturedAtMs: number;
  decidedAtMs: number;
  quietHours: QuietHours | null;
  localHour: number;
  localMinute: number;
  isPreviewOrBackfill: boolean;
  leadsInLastHour: number;
}

/** The six notification rules + quiet hours + `> 30/hr` flood guard (`07-notifications-export.md §3`). */
export function evaluateNotifyPolicy(c: NotifyPolicyCheck): NotifyDecision {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  if (!c.radarActive) return { kind: "skip", reason: "radar_not_active" };
  if (!c.hasChannels) return { kind: "skip", reason: "no_channels_configured" };
  if (c.isPreviewOrBackfill) return { kind: "skip", reason: "preview_or_backfill" };
  if (c.score < c.minScore) return { kind: "skip", reason: "below_min_score" };
  if (!c.isClusterHead && !c.repostAfter72h) return { kind: "skip", reason: "duplicate_cluster_member" };
  if (c.decidedAtMs - c.capturedAtMs > SIX_HOURS_MS) return { kind: "skip", reason: "stale_evaluation" };

  const flood = c.leadsInLastHour > FLOOD_LEADS_PER_HOUR_THRESHOLD;
  const inQuiet = c.quietHours !== null && isInQuietHours(c.quietHours, c.localHour, c.localMinute);
  if (c.digestMode || flood || inQuiet) {
    return { kind: "queue_digest", triggerFloodAutoDigest: flood && !c.digestMode };
  }
  return { kind: "send_instant", triggerFloodAutoDigest: false };
}

// ---- digest & system alerts -------------------------------------------------------------------

export interface DigestLeadItem {
  lead_id: string;
  summary: string;
  score: number;
  source_name: string | null;
  permalink: string | null;
}

export function truncateCharsRaw(s: string, maxChars: number): string {
  const chars = [...s];
  if (chars.length <= maxChars) return s;
  if (maxChars === 0) return "";
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

export const telegramLen = (html: string): number => html.length;

/** Up to 10 leads in a compact digest HTML message. */
export function formatDigestHtml(radarName: string, leadsTop10: readonly DigestLeadItem[], remainingCount: number): string {
  const shown = leadsTop10.slice(0, 10);
  const overflow = Math.max(0, leadsTop10.length - 10);
  const totalRemaining = remainingCount + overflow;

  const render = (summaryCap: number): string => {
    const lines: string[] = [`📋 <b>Gộp tin: ${escapeHtml(radarName)}</b>`, ""];
    shown.forEach((item, idx) => {
      let line = `${idx + 1}. ${escapeHtml(truncateCharsRaw(item.summary, summaryCap))}`;
      const src = item.source_name?.trim();
      if (src) line += ` · <i>${escapeHtml(src)}</i>`;
      if (item.permalink !== null && item.permalink !== undefined) {
        try {
          const parsed = validateHttpsPermalink(item.permalink);
          line += ` (<a href="${escapeHtmlAttr(parsed.href)}">Mở</a>)`;
        } catch {
          // invalid links are omitted
        }
      }
      lines.push(line);
    });
    if (totalRemaining > 0) {
      lines.push("", `… và ${totalRemaining} tin khác`);
    }
    return lines.join("\n");
  };

  const full = render(140);
  if (telegramLen(full) <= MAX_TELEGRAM_HTML_LEN) return full;
  for (const cap of [100, 70, 45, 25, 12]) {
    const candidate = render(cap);
    if (telegramLen(candidate) <= MAX_TELEGRAM_HTML_LEN) return candidate;
  }
  return render(8);
}

export type SystemIncidentKind =
  | { kind: "facebook_session_issue" }
  | { kind: "extension_disconnected" }
  | { kind: "ai_unavailable"; pending_posts: number }
  | { kind: "extractor_broken" }
  | { kind: "radar_flood_auto_digest"; radar_name: string; leads_last_hour: number };

export function formatSystemAlertHtml(incident: SystemIncidentKind, resolved: boolean): string {
  if (!resolved) {
    switch (incident.kind) {
      case "facebook_session_issue":
        return "⚠️ <b>Cảnh báo hệ thống</b>\n\nDealSonar đã dừng quét vì Facebook yêu cầu đăng nhập lại / xác minh";
      case "extension_disconnected":
        return "⚠️ <b>Cảnh báo hệ thống</b>\n\nKhông thấy Chrome. Radar đang tạm ngừng";
      case "ai_unavailable":
        return `⚠️ <b>Cảnh báo hệ thống</b>\n\nKhông gọi được AI. ${incident.pending_posts} bài đang chờ`;
      case "extractor_broken":
        return "⚠️ <b>Cảnh báo hệ thống</b>\n\nFacebook có thay đổi, cần cập nhật DealSonar";
      case "radar_flood_auto_digest":
        return `⚠️ <b>Chống dồn dập: ${escapeHtml(incident.radar_name)}</b>\n\nRadar đã tạo ${incident.leads_last_hour} tin trong 1 giờ qua (vượt ngưỡng ${FLOOD_LEADS_PER_HOUR_THRESHOLD} tin/giờ) nên tự chuyển sang gửi gộp. Đề nghị xem lại mô tả radar.`;
    }
  }
  switch (incident.kind) {
    case "facebook_session_issue":
      return "✅ <b>Đã khôi phục</b>\n\nPhiên Facebook đã hoạt động bình thường trở lại. DealSonar đã tiếp tục quét.";
    case "extension_disconnected":
      return "✅ <b>Đã khôi phục</b>\n\nĐã kết nối lại với Chrome. Radar tiếp tục hoạt động.";
    case "ai_unavailable":
      return "✅ <b>Đã khôi phục</b>\n\nKết nối AI đã hoạt động trở lại. Đang xử lý các bài chờ.";
    case "extractor_broken":
      return "✅ <b>Đã khôi phục</b>\n\nBộ trích đã đọc lại được bài viết bình thường.";
    case "radar_flood_auto_digest":
      return `✅ <b>Đã khôi phục: ${escapeHtml(incident.radar_name)}</b>\n\nLượng tin của radar đã ổn định trở lại.`;
  }
}

// ---- lead alert -------------------------------------------------------------------------------

export interface LeadAlertInput {
  lead_id: string;
  radar_name: string;
  summary: string;
  field_defs: readonly FieldDef[];
  extracted_fields: Readonly<Record<string, NotifyExtractedField | ExtractedField>>;
  group_name: string;
  author_name: string | null;
  post_created_at_ms: number | null;
  now_ms: number;
  other_group_count: number;
  permalink: string;
}

export interface FormattedLeadAlert {
  html: string;
  reply_markup: InlineKeyboardMarkup;
}

interface PreparedBullet {
  label: string;
  value: string;
  isText: boolean;
}

function assembleLeadHtml(
  radarNameRaw: string,
  summaryRaw: string,
  bullets: readonly PreparedBullet[],
  textFieldCap: number | null,
  groupNameRaw: string,
  authorNameRaw: string,
  relTimeRaw: string,
  otherGroupCount: number,
): string {
  const parts: string[] = [`🎯 <b>${escapeHtml(radarNameRaw)}</b>`, escapeHtml(summaryRaw)];
  const bulletLines: string[] = [];
  for (const b of bullets) {
    const val = b.isText && textFieldCap !== null ? truncateCharsRaw(b.value, textFieldCap) : b.value;
    if (val !== "") bulletLines.push(`• ${escapeHtml(b.label)}: ${escapeHtml(val)}`);
  }
  if (bulletLines.length > 0) parts.push(bulletLines.join("\n"));

  let footer = `👥 ${escapeHtml(groupNameRaw)} · ${escapeHtml(authorNameRaw)} · ${escapeHtml(relTimeRaw)}`;
  if (otherGroupCount > 0) footer += `\n🔁 Cũng xuất hiện ở ${otherGroupCount} group khác`;
  parts.push(footer);
  return parts.join("\n\n");
}

/**
 * Lead alert -> escaped Telegram HTML + inline keyboard (`07-notifications-export.md §2.2`).
 * Dynamic strings are escaped, the permalink is validated and never truncated, every callback is
 * `< 64` bytes, and over-long summaries/text fields are truncated *before* escaping.
 */
export function formatLeadAlert(input: LeadAlertInput): FormattedLeadAlert {
  const parsedPermalink = validateHttpsPermalink(input.permalink);
  const replyMarkup = buildLeadAlertKeyboard(input.lead_id, parsedPermalink.href);

  const sortedDefs = input.field_defs
    .filter((f) => f.show_in_alert)
    .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let bullets: PreparedBullet[] = [];
  for (const def of sortedDefs) {
    const extracted = Object.prototype.hasOwnProperty.call(input.extracted_fields, def.key)
      ? input.extracted_fields[def.key]
      : undefined;
    if (!extracted) continue;
    const formatted = formatFieldValue(def.type, extracted.value);
    if (formatted !== null) bullets.push({ label: def.label, value: formatted, isText: def.type === "text" });
  }

  const authorRaw = input.author_name?.trim() ? input.author_name.trim() : "Ẩn danh";
  const relTime = formatRelativeTimeVi(input.post_created_at_ms, input.now_ms);
  const assemble = (summary: string, bl: readonly PreparedBullet[], cap: number | null): string =>
    assembleLeadHtml(input.radar_name, summary, bl, cap, input.group_name, authorRaw, relTime, input.other_group_count);

  const initial = assemble(input.summary, bullets, null);
  if (telegramLen(initial) <= MAX_TELEGRAM_HTML_LEN) return { html: initial, reply_markup: replyMarkup };

  // Step 1: truncate only text-type field values.
  const maxTextChars = bullets.filter((b) => b.isText).reduce((m, b) => Math.max(m, [...b.value].length), 0);
  if (maxTextChars > 0) {
    const minText = assemble(input.summary, bullets, 0);
    if (telegramLen(minText) <= MAX_TELEGRAM_HTML_LEN) {
      let lo = 0;
      let hi = maxTextChars;
      let best = minText;
      while (lo <= hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const candidate = assemble(input.summary, bullets, mid);
        if (telegramLen(candidate) <= MAX_TELEGRAM_HTML_LEN) {
          best = candidate;
          lo = mid + 1;
        } else if (mid === 0) break;
        else hi = mid - 1;
      }
      return { html: best, reply_markup: replyMarkup };
    }
  }

  // Step 2: jointly truncate summary and text-type values.
  const summaryChars = [...input.summary].length;
  const maxJoint = Math.max(summaryChars, maxTextChars);
  const zeroJoint = assemble("", bullets, 0);
  if (telegramLen(zeroJoint) <= MAX_TELEGRAM_HTML_LEN) {
    let lo = 0;
    let hi = maxJoint;
    let best = zeroJoint;
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const candidate = assemble(truncateCharsRaw(input.summary, mid), bullets, mid);
      if (telegramLen(candidate) <= MAX_TELEGRAM_HTML_LEN) {
        best = candidate;
        lo = mid + 1;
      } else if (mid === 0) break;
      else hi = mid - 1;
    }
    return { html: best, reply_markup: replyMarkup };
  }

  // Step 3: defensive fallback when non-text fields / metadata alone exceed the limit.
  bullets = [...bullets];
  while (bullets.length > 0) {
    bullets.pop();
    const candidate = assemble("", bullets, 0);
    if (telegramLen(candidate) <= MAX_TELEGRAM_HTML_LEN) return { html: candidate, reply_markup: replyMarkup };
  }
  const fallback = assembleLeadHtml(
    truncateCharsRaw(input.radar_name, 200),
    "",
    [],
    0,
    truncateCharsRaw(input.group_name, 120),
    truncateCharsRaw(authorRaw, 80),
    relTime,
    input.other_group_count,
  );
  return { html: fallback, reply_markup: replyMarkup };
}

/** Store extracted fields -> notify fields (`raw` defaults to ""). */
export function extractedFieldsStoreToNotify(
  fields: Readonly<Record<string, ExtractedField>>,
): Record<string, NotifyExtractedField> {
  const out: Record<string, NotifyExtractedField> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = { value: v.value, raw: v.raw ?? "", confidence: v.confidence, source: v.source };
  }
  return out;
}
