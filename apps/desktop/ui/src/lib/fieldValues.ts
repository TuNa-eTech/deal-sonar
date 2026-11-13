import type { FieldDef, ExtractedField } from "../types/ipc";

export function localDateTime(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseVietnameseNumber(text: string): number {
  let s = text.trim().toLowerCase().replace(/\s/g, "");
  const suffix = s.match(/(triệu|trieu|tr|tỷ|ty|tỉ|ti|nghìn|nghin|ngàn|ngan|k)$/)?.[0];
  const factor = suffix ? /^(tỷ|ty|tỉ|ti)$/.test(suffix) ? 1e9 : /^(triệu|trieu|tr)$/.test(suffix) ? 1e6 : 1e3 : 1;
  if (suffix) s = s.slice(0, -suffix.length);
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "");
  else if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  s = s.replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new Error("Nhập một số hợp lệ, ví dụ 15 triệu hoặc 15.000.000.");
  const n = Number(s) * factor;
  if (!Number.isFinite(n)) throw new Error("Giá trị vượt giới hạn.");
  return n;
}

export function editFieldText(fd: FieldDef, field?: ExtractedField): string {
  const v = field?.value;
  if (v == null) return "";
  if (fd.type === "money" || fd.type === "range" || fd.type === "location") return JSON.stringify(v);
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function parseFieldValue(fd: FieldDef, text: string, previous?: unknown): unknown {
  const s = text.trim();
  if (!s) return null;
  const prior = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
  if (fd.type === "number") return parseVietnameseNumber(s);
  if (fd.type === "boolean") {
    if (/^(true|có)$/i.test(s)) return true;
    if (/^(false|không)$/i.test(s)) return false;
    throw new Error("Chọn Có hoặc Không.");
  }
  if (fd.type === "enum" || fd.type === "multi_enum") {
    const values = fd.type === "enum" ? [s] : s.split(",").map(x=>x.trim()).filter(Boolean);
    if (fd.options?.length && values.some(v=>!fd.options!.includes(v))) throw new Error("Chọn giá trị trong danh sách.");
    return fd.type === "enum" ? s : [...new Set(values)];
  }
  if (fd.type === "money" || fd.type === "range") {
    if (s.startsWith("{")) {
      const v = JSON.parse(s) as Record<string, unknown>;
      if (typeof v.min !== "number" || typeof v.max !== "number" || !Number.isFinite(v.min) || !Number.isFinite(v.max) || v.min > v.max || (fd.type === "money" && v.min < 0)) throw new Error("Khoảng giá trị không hợp lệ.");
      return v;
    }
    const period = /\/\s*(tháng|th|month)$/i.test(s) ? "month" : /\/\s*(năm|year)$/i.test(s) ? "year" : /\/\s*(ngày|day)$/i.test(s) ? "day" : prior.period ?? null;
    const clean = s.replace(/\/\s*(tháng|th|month|năm|year|ngày|day)$/i, "").replace(/\s*(VNĐ|VND|đ)$/, "").trim();
    const parts = clean.split(/\s*[–—]\s*|(?<=\d)\s*-\s*(?=\d)/);
    if (parts.length > 2) throw new Error("Nhập giá trị hoặc khoảng từ – đến.");
    const unitSuffix = parts[parts.length-1]!.match(/(triệu|trieu|tr|tỷ|ty|tỉ|ti|nghìn|nghin|ngàn|ngan|k)$/i)?.[0] ?? "";
    const min = parseVietnameseNumber(parts[0]! + (parts.length===2 && !/[a-zà-ỹ]$/i.test(parts[0]!.trim()) ? unitSuffix : ""));
    const max = parts.length===2 ? parseVietnameseNumber(parts[1]!) : min;
    if (min > max || (fd.type === "money" && min < 0)) throw new Error("Giá trị từ phải không lớn hơn giá trị đến và giá tiền không âm.");
    return fd.type === "money" ? {min,max,currency:prior.currency ?? "VND",period} : {min,max,unit:prior.unit ?? ""};
  }
  if (fd.type === "location") {
    if (s.startsWith("{")) return JSON.parse(s);
    return {raw:s,province:null,district:null,ward:null};
  }
  if (fd.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s).toISOString().slice(0,10)!==s)) throw new Error("Ngày không hợp lệ.");
  if (fd.type === "url") { const u = new URL(s); if (!["http:","https:"].includes(u.protocol)) throw new Error("Chỉ hỗ trợ liên kết http hoặc https."); }
  return s;
}
