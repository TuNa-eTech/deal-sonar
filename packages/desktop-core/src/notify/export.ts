// Port of crates/notify/src/export.rs: CSV (UTF-8 BOM, CRLF, flattened composite columns,
// spreadsheet formula-injection guard) and XLSX (frozen bold header, typed numbers, clickable
// Facebook URLs, safe plain-text cells) lead exports.

import type { FieldDef } from "../store/domain";
import { NotifyError } from "./errors";
import { type NotifyExtractedField, isValidFacebookHttpsUrl, roundHalfAway, rustFixed } from "./format";
import { formatLocalRfc3339 } from "./webhook";
import { createZip } from "./zip";

/** UTF-8 BOM so Microsoft Excel opens Vietnamese CSVs cleanly. */
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface ExportOptions {
  include_post_text: boolean;
}

export interface ExportLeadRow {
  post_created_at: number | null;
  radar_name: string;
  status: string;
  score: number;
  summary: string;
  group_name: string;
  author_name: string;
  permalink: string;
  post_text: string | null;
  fields: Readonly<Record<string, NotifyExtractedField>>;
}

type TypedCell =
  | { t: "empty" }
  | { t: "text"; v: string }
  | { t: "number"; v: number }
  | { t: "link"; v: string };

const EMPTY: TypedCell = { t: "empty" };
type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asF64 = (v: Json): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Prefix `'` when the first character, or the first non-whitespace character, is one of
 * `= + - @ \t \r` so a spreadsheet never evaluates the cell as a formula.
 */
export function sanitizeSpreadsheetCell(value: string): string {
  if (value === "") return "";
  const dangerous = new Set(["=", "+", "-", "@", "\t", "\r"]);
  const firstRaw = [...value][0];
  const firstNonWs = [...value].find((c) => !/\s/u.test(c));
  if ((firstRaw !== undefined && dangerous.has(firstRaw)) || (firstNonWs !== undefined && dangerous.has(firstNonWs))) {
    return `'${value}`;
  }
  return value;
}

/** Local ISO 8601 (`YYYY-MM-DDTHH:MM:SS+HH:MM`); empty when the timestamp is invalid. */
export function formatLocalIso8601(tsMs: number): string {
  return formatLocalRfc3339(tsMs) ?? "";
}

function sortedFields(fields: readonly FieldDef[]): FieldDef[] {
  return [...fields].sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function buildHeaders(options: ExportOptions, defs: readonly FieldDef[]): string[] {
  const headers = ["Thời điểm đăng", "Radar", "Trạng thái", "Điểm", "Tóm tắt", "Group", "Tác giả", "Liên kết"];
  if (options.include_post_text) headers.push("Nội dung");
  for (const def of defs) {
    const label = def.label;
    switch (def.type) {
      case "money":
        headers.push(`${label} (từ)`, `${label} (đến)`, `${label} (đơn vị)`);
        break;
      case "location":
        headers.push(`${label} (tỉnh)`, `${label} (quận)`, `${label} (phường)`);
        break;
      case "range":
        headers.push(`${label} (từ)`, `${label} (đến)`);
        break;
      default:
        headers.push(label);
    }
  }
  return headers;
}

const textOrEmpty = (v: Json): TypedCell => {
  if (typeof v !== "string") return EMPTY;
  const t = v.trim();
  return t === "" ? EMPTY : { t: "text", v: t };
};
const numberOrEmpty = (n: number | null): TypedCell =>
  n !== null && Number.isFinite(n) ? { t: "number", v: n } : EMPTY;
const nonEmptyTrimmed = (v: Json): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NON_FINITE_RE = /^[+-]?(inf|infinity|nan)$/i;

function appendDynamicCells(out: TypedCell[], def: FieldDef, extracted: NotifyExtractedField | undefined): void {
  if (!extracted) {
    const width = def.type === "money" || def.type === "location" ? 3 : def.type === "range" ? 2 : 1;
    for (let i = 0; i < width; i += 1) out.push(EMPTY);
    return;
  }
  const val = extracted.value;
  switch (def.type) {
    case "money": {
      if (isObject(val)) {
        const amount = asF64(val.amount);
        const minV = asF64(val.min) ?? amount;
        const maxV = asF64(val.max) ?? amount;
        const currency = nonEmptyTrimmed(val.currency);
        const period = nonEmptyTrimmed(val.period);
        let unit: string | null;
        if (currency && period) unit = `${currency}/${period}`;
        else if (currency) unit = currency;
        else if (period) unit = `VND/${period}`;
        else unit = minV !== null || maxV !== null ? "VND" : null;
        out.push(numberOrEmpty(minV), numberOrEmpty(maxV), unit !== null ? { t: "text", v: unit } : EMPTY);
      } else if (asF64(val) !== null) {
        const n = asF64(val);
        out.push(numberOrEmpty(n), numberOrEmpty(n), { t: "text", v: "VND" });
      } else {
        out.push(EMPTY, EMPTY, EMPTY);
      }
      return;
    }
    case "location": {
      if (isObject(val)) out.push(textOrEmpty(val.province), textOrEmpty(val.district), textOrEmpty(val.ward));
      else out.push(EMPTY, EMPTY, EMPTY);
      return;
    }
    case "range": {
      if (isObject(val)) out.push(numberOrEmpty(asF64(val.min)), numberOrEmpty(asF64(val.max)));
      else out.push(EMPTY, EMPTY);
      return;
    }
    case "number": {
      const n = asF64(val);
      if (n !== null) {
        out.push(numberOrEmpty(n));
      } else if (typeof val === "string" && (FLOAT_RE.test(val.trim()) || NON_FINITE_RE.test(val.trim()))) {
        out.push(FLOAT_RE.test(val.trim()) ? numberOrEmpty(Number(val.trim())) : EMPTY);
      } else {
        out.push(textOrEmpty(val));
      }
      return;
    }
    case "boolean": {
      out.push(typeof val === "boolean" ? { t: "text", v: val ? "Có" : "Không" } : EMPTY);
      return;
    }
    case "multi_enum": {
      if (Array.isArray(val)) {
        const items = val
          .map((v) => (typeof v === "string" ? v.trim() : null))
          .filter((s): s is string => s !== null && s !== "");
        out.push(items.length === 0 ? EMPTY : { t: "text", v: items.join(", ") });
      } else {
        out.push(textOrEmpty(val));
      }
      return;
    }
    default: {
      // text | phone | enum | date | url
      if (typeof val === "string") out.push(val === "" ? EMPTY : { t: "text", v: val });
      else if (asF64(val) !== null) out.push(numberOrEmpty(asF64(val)));
      else out.push(EMPTY);
    }
  }
}

function buildRowCells(options: ExportOptions, defs: readonly FieldDef[], row: ExportLeadRow): TypedCell[] {
  const cells: TypedCell[] = [];
  if (row.post_created_at !== null) {
    const iso = formatLocalIso8601(row.post_created_at);
    cells.push(iso === "" ? EMPTY : { t: "text", v: iso });
  } else cells.push(EMPTY);
  cells.push({ t: "text", v: row.radar_name });
  cells.push({ t: "text", v: row.status });
  cells.push(numberOrEmpty(row.score));
  cells.push({ t: "text", v: row.summary });
  cells.push({ t: "text", v: row.group_name });
  cells.push({ t: "text", v: row.author_name });
  cells.push({ t: "link", v: row.permalink });
  if (options.include_post_text) {
    cells.push(row.post_text !== null && row.post_text !== "" ? { t: "text", v: row.post_text } : EMPTY);
  }
  for (const def of defs) {
    appendDynamicCells(cells, def, Object.prototype.hasOwnProperty.call(row.fields, def.key) ? row.fields[def.key] : undefined);
  }
  return cells;
}

export function formatCsvNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - roundHalfAway(n)) < 1e-9 && Math.abs(n) < 1e16) return String(roundHalfAway(n));
  return rustFixed(n, 6).replace(/0+$/, "").replace(/\.$/, "");
}

export function encodeRfc4180Field(raw: string): string {
  if (!/[,"\r\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

const csvRecord = (fields: readonly string[]): string => `${fields.map(encodeRfc4180Field).join(",")}\r\n`;

/** UTF-8 CSV with BOM and CRLF line endings. */
export function exportCsv(options: ExportOptions, fields: readonly FieldDef[], rows: readonly ExportLeadRow[]): Buffer {
  const defs = sortedFields(fields);
  let text = csvRecord(buildHeaders(options, defs).map(sanitizeSpreadsheetCell));
  for (const row of rows) {
    text += csvRecord(
      buildRowCells(options, defs, row).map((cell) => {
        switch (cell.t) {
          case "empty":
            return "";
          case "number":
            return formatCsvNumber(cell.v);
          default:
            return sanitizeSpreadsheetCell(cell.v);
        }
      }),
    );
  }
  return Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]);
}

// ---- XLSX -------------------------------------------------------------------------------------

const MAX_XLSX_STRING_CHARS = 32_767;
const MAX_XLSX_URL_CHARS = 2_080;

function xmlEscape(s: string): string {
  // Excel escapes control characters as `_xHHHH_` and literal `_xHHHH_` as `_x005F_xHHHH_`.
  const protectedText = s.replace(/_x([0-9A-Fa-f]{4})_/g, "_x005F_x$1_");
  let out = "";
  for (const ch of protectedText) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) out += `_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`;
    else if (cp === 0xfffe || cp === 0xffff) out += `_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`;
    else out += ch;
  }
  return out;
}

function xmlAttrEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function checkString(s: string): void {
  if ([...s].length > MAX_XLSX_STRING_CHARS) {
    throw NotifyError.xlsx(`string length exceeds Excel's limit of ${MAX_XLSX_STRING_CHARS} characters`);
  }
}

const STYLE_DEFAULT = 0;
const STYLE_BOLD = 1;
const STYLE_LINK = 2;

/** `.xlsx` workbook: sheet "Bảng tin", frozen bold header row, typed numbers, safe text cells. */
export function exportXlsx(options: ExportOptions, fields: readonly FieldDef[], rows: readonly ExportLeadRow[]): Buffer {
  const defs = sortedFields(fields);
  const headers = buildHeaders(options, defs);
  if (headers.length > 16_384) throw NotifyError.xlsx("too many columns");
  if (rows.length + 1 > 1_048_576) throw NotifyError.xlsx("too many rows");

  const sheetRows: string[] = [];
  const links: Array<{ ref: string; url: string }> = [];

  const headerCells = headers
    .map((h, c) => {
      checkString(h);
      return `<c r="${columnName(c)}1" t="inlineStr" s="${STYLE_BOLD}"><is><t xml:space="preserve">${xmlEscape(h)}</t></is></c>`;
    })
    .join("");
  sheetRows.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, rowOffset) => {
    const excelRow = rowOffset + 2;
    const cells = buildRowCells(options, defs, row);
    if (cells.length > 16_384) throw NotifyError.xlsx("too many columns");
    let xml = "";
    cells.forEach((cell, c) => {
      const ref = `${columnName(c)}${excelRow}`;
      if (cell.t === "empty") return;
      if (cell.t === "number") {
        xml += `<c r="${ref}"><v>${String(cell.v)}</v></c>`;
        return;
      }
      if (cell.t === "link") {
        if (cell.v === "") return;
        checkString(cell.v);
        if (isValidFacebookHttpsUrl(cell.v)) {
          if ([...cell.v].length > MAX_XLSX_URL_CHARS) throw NotifyError.xlsx("URL exceeds Excel's limit of 2080 characters");
          links.push({ ref, url: cell.v });
          xml += `<c r="${ref}" t="inlineStr" s="${STYLE_LINK}"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
        } else {
          xml += `<c r="${ref}" t="inlineStr" s="${STYLE_DEFAULT}"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
        }
        return;
      }
      if (cell.v === "") return;
      checkString(cell.v);
      xml += `<c r="${ref}" t="inlineStr" s="${STYLE_DEFAULT}"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
    });
    sheetRows.push(`<row r="${excelRow}">${xml}</row>`);
  });

  const lastCol = columnName(Math.max(0, headers.length - 1));
  const lastRow = rows.length + 1;
  const hyperlinks =
    links.length > 0
      ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>`
      : "";
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${sheetRows.join("")}</sheetData>${hyperlinks}</worksheet>`;

  const sheetRels =
    links.length > 0
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links
          .map(
            (l, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlAttrEscape(l.url)}" TargetMode="External"/>`,
          )
          .join("")}</Relationships>`
      : null;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><u/><sz val="11"/><color theme="10"/><name val="Calibri"/><family val="2"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const entries = [
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<bookViews><workbookView xWindow="240" yWindow="15" windowWidth="16095" windowHeight="9660"/></bookViews>` +
        `<sheets><sheet name="Bảng tin" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    ...(sheetRels ? [{ name: "xl/worksheets/_rels/sheet1.xml.rels", data: sheetRels }] : []),
  ];
  try {
    return createZip(entries, { unixMode: 0o644 });
  } catch (e) {
    throw NotifyError.xlsx((e as Error).message);
  }
}
