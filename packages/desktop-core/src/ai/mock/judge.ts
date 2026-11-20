// Heuristic `judge_extract` responses parsed from the judge prompt (port of
// crates/ai-bridge/src/adapters/mock/judge.rs). The prompt layout is the one produced by the
// judge prompt builder: `[1] ĐỊNH NGHĨA RADAR` header blocks, then `--- Post ref=N ---` blocks
// wrapped in `<<<DEALSONAR_UNTRUSTED_POST_nonce>>>` tags.

import { type FieldExtraction, PostText, detectLocation, extractFieldForSchema, extractMoneyField } from "./extract";
import { type JsonObject, buildShortSummary, foldVi, isJsonObject } from "./text";

const POST_MARKER = "--- Post ref=";
const POSTS_SECTION_MARKER = "[4] CÁC BÀI CẦN CHẤM";
const CLOSE_TAG_PREFIX = "<<</DEALSONAR_UNTRUSTED_POST_";
const CONTENT_MARKER = "\ncontent:\n";
const U32_MAX = 4_294_967_295;

export interface ParsedPromptPost {
  ref: number;
  text: string;
}

/** Posts of a judge prompt in order (only the `[4]` section is scanned when present). */
export function parsePostsFromJudgePrompt(prompt: string): ParsedPromptPost[] {
  const sectionAt = prompt.indexOf(POSTS_SECTION_MARKER);
  let rest = sectionAt >= 0 ? prompt.slice(sectionAt + POSTS_SECTION_MARKER.length) : prompt;
  const posts: ParsedPromptPost[] = [];

  for (;;) {
    const pos = rest.indexOf(POST_MARKER);
    if (pos < 0) break;
    const after = rest.slice(pos + POST_MARKER.length);
    const endRef = after.indexOf(" ---");
    if (endRef < 0) break;
    const refStr = after.slice(0, endRef).trim();
    const refNum = /^\d+$/.test(refStr) ? Number(refStr) : Number.NaN;
    if (!Number.isInteger(refNum) || refNum > U32_MAX) {
      rest = after.slice(endRef);
      continue;
    }

    const body = after.slice(endRef + 4);
    let section: string;
    const closeIdx = body.indexOf(CLOSE_TAG_PREFIX);
    if (closeIdx >= 0) {
      section = body.slice(0, closeIdx);
      rest = body.slice(closeIdx + CLOSE_TAG_PREFIX.length);
    } else {
      const nextIdx = body.indexOf(POST_MARKER);
      if (nextIdx >= 0) {
        section = body.slice(0, nextIdx);
        rest = body.slice(nextIdx);
      } else {
        section = body;
        rest = "";
      }
    }

    const contentIdx = section.indexOf(CONTENT_MARKER);
    const text =
      contentIdx >= 0 ? section.slice(contentIdx + CONTENT_MARKER.length).replace(/\n+$/, "") : section.trim();
    posts.push({ ref: refNum, text });
  }
  return posts;
}

const PEER_SIGNALS = [
  "hoa hong", "hh 1 thang", "hh nua thang", "ben em co", "ben minh co", "quy can", "gio hang", "nhan ky gui",
  "ky gui", "ib em tu van", "inbox em gui anh", "lien he em xem nha", "tuyen ctv", "salon cam ket",
  "doi tho chuyen", "nhan sua chua tai nha", "khach net", "co khach net", "ket hop a e", "anh em mg",
  "ace mg co can",
];
const DEMAND_SIGNALS = [
  "can thue", "tim thue", "muon thue", "tim can ho", "tim phong", "tim nha", "can mua", "tim mua", "hoi mua",
  "ai biet tho", "can tim tho", "gia dinh minh can", "vo chong minh can", "em can thue", "minh can thue",
];
const SUPPLY_SIGNALS = [
  "cho thue", "can ban", "chinh chu cho thue", "chinh chu ban", "nhuong lai", "pass lai", "sang nhuong",
  "thanh ly", "con trong phong",
];
const SPAM_SIGNALS = ["vay von nhanh", "kiem tien online", "game bai", "tang tuong tac"];

type Intent = "demand" | "supply" | "other";
type WantIntent = "demand" | "supply" | "any";
type AuthorRole = "end_user" | "peer" | "unknown";

const hasAny = (haystack: string, needles: readonly string[]): boolean => needles.some((n) => haystack.includes(n));
const indexOrMax = (haystack: string, needle: string): number => {
  const i = haystack.indexOf(needle);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
};

/** Per-field `value` schemas of `results[].fields` (keys sorted for deterministic evaluation order). */
function judgeFieldSchemas(schema: unknown): Array<[string, unknown]> {
  let node: unknown = schema;
  for (const key of ["properties", "results", "items", "properties", "fields", "properties"]) {
    if (!isJsonObject(node)) return [];
    node = node[key];
  }
  if (!isJsonObject(node)) return [];
  const fieldProps: JsonObject = node;
  return Object.keys(fieldProps)
    .sort()
    .map((key) => {
      const fieldSchema = fieldProps[key];
      const props = isJsonObject(fieldSchema) && isJsonObject(fieldSchema.properties) ? fieldSchema.properties : null;
      return [key, props ? props.value : undefined] as [string, unknown];
    });
}

export interface JudgeResultItem {
  ref: number;
  match: boolean;
  score: number;
  intent: Intent;
  author_role: AuthorRole;
  is_spam: boolean;
  summary: string;
  reason: string;
  fields: Record<string, { raw: string | null; value: unknown; confidence: number }>;
}

export function heuristicJudgeExtract(prompt: string, schema: unknown): { results: JudgeResultItem[] } {
  const headerPart = prompt.split(POSTS_SECTION_MARKER)[0];
  const headerFold = foldVi(headerPart);

  const wantIntent: WantIntent = headerFold.includes("want_intent): supply")
    ? "supply"
    : headerFold.includes("want_intent): any")
      ? "any"
      : "demand";
  // Same predicate as the Rust mock (the profession line is always present in the header).
  const excludePeer = headerFold.includes("exclude_roles): peer") || headerFold.includes("nghe cua nguoi dung:");

  const radarDescLine = headerPart.split("\n").find((l) => l.startsWith("- Mô tả:")) ?? "";
  const radarDescFold = foldVi(radarDescLine);
  const radarDesc = new PostText(radarDescLine);

  const targetDistrictRaw = detectLocation(radarDesc)?.value.district ?? null;
  const targetDistrict = targetDistrictRaw === null ? null : foldVi(targetDistrictRaw);
  let targetMaxBudget: number | null = null;
  if (radarDescFold.includes("duoi ") || radarDescFold.includes("toi da")) {
    const max = (extractMoneyField(radarDesc).value as { max?: unknown } | null)?.max;
    targetMaxBudget = typeof max === "number" ? max : null;
  }

  const fieldSchemas = judgeFieldSchemas(schema);
  const results: JudgeResultItem[] = [];

  for (const parsed of parsePostsFromJudgePrompt(prompt)) {
    const post = new PostText(parsed.text);
    const postFold = foldVi(parsed.text);

    const isSpam = hasAny(postFold, SPAM_SIGNALS);
    const isPeer = hasAny(postFold, PEER_SIGNALS);
    const hasDemand = hasAny(postFold, DEMAND_SIGNALS);
    const hasSupply = hasAny(postFold, SUPPLY_SIGNALS);

    let intent: Intent;
    if (isSpam) intent = "other";
    else if (hasDemand && !hasSupply) intent = "demand";
    else if (hasSupply && !hasDemand) intent = "supply";
    else if (hasDemand && indexOrMax(postFold, "can thue") < indexOrMax(postFold, "cho thue")) intent = "demand";
    else if (hasSupply) intent = "supply";
    else intent = "other";

    const authorRole: AuthorRole = isPeer ? "peer" : intent === "demand" || postFold.includes("chinh chu") ? "end_user" : "unknown";

    const fields: JudgeResultItem["fields"] = {};
    let foundDistrictFold: string | null = null;
    let foundPriceMin: number | null = null;
    for (const [fieldKey, valueSchema] of fieldSchemas) {
      const ex: FieldExtraction = extractFieldForSchema(fieldKey, valueSchema, post);
      const value = ex.value;
      if (fieldKey.includes("location") || fieldKey.includes("district")) {
        const district = isJsonObject(value) ? value.district : undefined;
        if (typeof district === "string") foundDistrictFold = foldVi(district);
      }
      if (fieldKey.includes("price") || fieldKey.includes("budget")) {
        const min = isJsonObject(value) ? value.min : undefined;
        if (typeof min === "number") foundPriceMin = min;
      }
      fields[fieldKey] = { raw: ex.raw, value, confidence: ex.confidence };
    }

    const intentOk = wantIntent === "any" || intent === wantIntent;
    const roleOk = !(excludePeer && authorRole === "peer");
    let districtOk: boolean;
    if (targetDistrict === null) districtOk = true;
    else if (foundDistrictFold !== null) districtOk = targetDistrict === foundDistrictFold;
    else districtOk = postFold.includes(targetDistrict);
    const budgetOk = targetMaxBudget !== null && foundPriceMin !== null ? foundPriceMin <= targetMaxBudget * 1.05 : true;

    const isMatch = !isSpam && intentOk && roleOk && districtOk && budgetOk;
    let score: number;
    if (isMatch) score = 0.88;
    else if (!isSpam && intentOk && !roleOk) score = 0.22;
    else if (!isSpam && intentOk && (!districtOk || !budgetOk)) score = 0.35;
    else score = 0.08;

    let reason: string;
    if (isSpam) reason = "Bài quảng cáo/rác không liên quan nhu cầu radar.";
    else if (!roleOk) reason = "Dấu hiệu môi giới/người cùng nghề đăng bài tìm nguồn hoặc câu khách.";
    else if (!intentOk) reason = `Ý định bài là '${intent}', không khớp yêu cầu '${wantIntent}'.`;
    else if (!districtOk) reason = "Khu vực trong bài không thuộc địa bàn radar theo dõi.";
    else if (!budgetOk) reason = "Mức giá/ngân sách vượt ngưỡng mô tả của radar.";
    else reason = "Khách thực có nhu cầu, khu vực và thông tin phù hợp mô tả radar.";

    results.push({
      ref: parsed.ref,
      match: isMatch,
      score,
      intent,
      author_role: authorRole,
      is_spam: isSpam,
      summary: buildShortSummary(parsed.text, 130),
      reason,
      fields,
    });
  }
  return { results };
}
