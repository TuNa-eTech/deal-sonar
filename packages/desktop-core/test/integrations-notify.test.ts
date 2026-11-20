import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChatRateLimiter,
  NotifyError,
  TelegramClient,
  WebhookClient,
  buildFeedbackCallbackData,
  crc32,
  createZip,
  escapeHtml,
  evaluateNotifyPolicy,
  exportCsv,
  exportXlsx,
  formatDigestHtml,
  formatDomesticPhone,
  formatFieldValue,
  formatLeadAlert,
  formatRelativeTimeVi,
  formatSystemAlertHtml,
  formatVietnameseMoney,
  newLeadCreatedPayload,
  parseFeedbackCallbackData,
  sanitizeSpreadsheetCell,
  sendMessageHtml,
  signWebhookBody,
  telegramRetryBackoffS,
  validateWebhookUrl,
  verifyWebhookSignature,
  webhookRetryBackoffS,
  type ExportLeadRow,
  type NotifyPolicyCheck,
} from "../src/notify";
import { fd, startMockServer, type MockServer } from "./integrations-helpers";

// ---- formatting ---------------------------------------------------------------------------------

describe("value formatting", () => {
  it("formats domestic phones, money ranges and relative time like the Rust crate", () => {
    expect(formatDomesticPhone("+84912345678")).toBe("0912 345 678");
    expect(formatDomesticPhone("+842438123456")).toBe("024 3812 3456");
    expect(formatDomesticPhone("0912.345.678")).toBe("0912 345 678");
    expect(formatDomesticPhone("84912345678")).toBe("0912 345 678");
    expect(formatDomesticPhone("call me")).toBe("call me");

    expect(formatVietnameseMoney({ min: 12_000_000, max: 15_000_000, currency: "VND", period: "month" })).toBe("12–15 triệu/tháng");
    expect(formatVietnameseMoney({ min: 2_300_000_000, max: 2_300_000_000, currency: "VND" })).toBe("2,3 tỷ");
    expect(formatVietnameseMoney({ min: 500_000, max: 500_000 })).toBe("500 nghìn");
    expect(formatVietnameseMoney({ min: 900_000, max: 2_500_000 })).toBe("900 nghìn–2,5 triệu");
    expect(formatVietnameseMoney({ amount: 1000, currency: "USD" })).toBe("1000 USD");
    expect(formatVietnameseMoney({})).toBeNull();

    expect(formatFieldValue("range", { min: 50, max: 70, unit: "m2" })).toBe("50–70 m2");
    expect(formatFieldValue("boolean", true)).toBe("Có");
    expect(formatFieldValue("multi_enum", [" a ", "", "b"])).toBe("a, b");
    expect(formatFieldValue("number", 2.125)).toBe("2.12");
    expect(formatFieldValue("location", { district: "Q1", province: "HCM" })).toBe("Q1, HCM");
    expect(formatFieldValue("text", null)).toBeNull();

    const now = 10_000_000;
    expect(formatRelativeTimeVi(null, now)).toBe("vừa thấy");
    expect(formatRelativeTimeVi(now - 30_000, now)).toBe("vừa xong");
    expect(formatRelativeTimeVi(now - 5 * 60_000, now)).toBe("5 phút trước");
    expect(formatRelativeTimeVi(now - 3 * 3_600_000, now)).toBe("3 giờ trước");
    expect(formatRelativeTimeVi(now - 2 * 86_400_000, now)).toBe("2 ngày trước");
  });
});

describe("lead alert", () => {
  const defs = [
    fd("price", "money", { label: "Giá", order: 1 }),
    fd("phone", "phone", { label: "SĐT", order: 2 }),
    fd("note", "text", { label: "Ghi chú", order: 3 }),
    fd("hidden", "text", { label: "Ẩn", order: 4, show_in_alert: false }),
  ];
  const now = 1_700_000_000_000;
  const base = {
    lead_id: "01HZ0000000000000000000001",
    radar_name: "Tìm <nhà> & đất",
    summary: "Cần thuê <b>căn hộ</b>",
    field_defs: defs,
    extracted_fields: {
      price: { value: { min: 12_000_000, max: 15_000_000, period: "month" }, raw: "12-15tr", confidence: 1, source: "ai" },
      phone: { value: "+84912345678", raw: "0912345678", confidence: 1, source: "rule" },
      note: { value: "gần <metro>", raw: "x", confidence: 1, source: "ai" },
      hidden: { value: "secret", raw: "x", confidence: 1, source: "ai" },
    },
    group_name: "Nhóm A & B",
    author_name: null,
    post_created_at_ms: now - 5 * 60_000,
    now_ms: now,
    other_group_count: 2,
    permalink: "https://www.facebook.com/groups/1/posts/2",
  };

  it("renders the exact layout with escaping, keyboard and callback limits", () => {
    const alert = formatLeadAlert(base);
    expect(alert.html).toBe(
      [
        "🎯 <b>Tìm &lt;nhà&gt; &amp; đất</b>",
        "Cần thuê &lt;b&gt;căn hộ&lt;/b&gt;",
        "• Giá: 12–15 triệu/tháng\n• SĐT: 0912 345 678\n• Ghi chú: gần &lt;metro&gt;",
        "👥 Nhóm A &amp; B · Ẩn danh · 5 phút trước\n🔁 Cũng xuất hiện ở 2 group khác",
      ].join("\n\n"),
    );
    const [row] = alert.reply_markup.inline_keyboard;
    expect(row.map((b) => b.text)).toEqual(["Mở bài viết", "✅ Đúng", "❌ Sai"]);
    expect(row[0].url).toBe("https://www.facebook.com/groups/1/posts/2");
    expect(row[1].callback_data).toBe(`fb:${base.lead_id}:correct`);
    for (const b of row) if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThan(64);
  });

  it("truncates long summaries/text before escaping and never exceeds 4096 UTF-16 units", () => {
    const alert = formatLeadAlert({
      ...base,
      summary: "<".repeat(5000),
      extracted_fields: { ...base.extracted_fields, note: { value: "&".repeat(5000), raw: "x", confidence: 1, source: "ai" } },
    });
    expect(alert.html.length).toBeLessThanOrEqual(4096);
    expect(alert.html).toContain("•"); // bullets of other fields survive
    expect(alert.html).not.toMatch(/<(?!\/?b>)/); // every `<` that is not markup was escaped
    expect(alert.reply_markup.inline_keyboard[0][0].url).toBe(base.permalink);
  });

  it("rejects non-https permalinks and oversized callback data", () => {
    expect(() => formatLeadAlert({ ...base, permalink: "http://facebook.com/x" })).toThrowError(NotifyError);
    expect(() => formatLeadAlert({ ...base, permalink: "javascript:alert(1)" })).toThrowError(/invalid permalink/);
    expect(() => formatLeadAlert({ ...base, lead_id: "x".repeat(60) })).toThrowError(/callback_data/);
    expect(buildFeedbackCallbackData("L1", "spam")).toBe("fb:L1:spam");
    expect(parseFeedbackCallbackData("fb:L1:spam")).toEqual(["L1", "spam"]);
    expect(parseFeedbackCallbackData("fb:L1")).toBeNull();
    expect(parseFeedbackCallbackData("xx:L1:spam")).toBeNull();
  });
});

describe("notification policy, digest and system alerts", () => {
  const check = (over: Partial<NotifyPolicyCheck> = {}): NotifyPolicyCheck => ({
    radarActive: true,
    hasChannels: true,
    digestMode: false,
    score: 0.9,
    minScore: 0.6,
    isClusterHead: true,
    repostAfter72h: false,
    capturedAtMs: 1_000,
    decidedAtMs: 2_000,
    quietHours: null,
    localHour: 12,
    localMinute: 0,
    isPreviewOrBackfill: false,
    leadsInLastHour: 0,
    ...over,
  });

  it("applies skip rules, quiet hours across midnight and the flood guard", () => {
    expect(evaluateNotifyPolicy(check())).toEqual({ kind: "send_instant", triggerFloodAutoDigest: false });
    expect(evaluateNotifyPolicy(check({ radarActive: false }))).toEqual({ kind: "skip", reason: "radar_not_active" });
    expect(evaluateNotifyPolicy(check({ score: 0.5 }))).toEqual({ kind: "skip", reason: "below_min_score" });
    expect(evaluateNotifyPolicy(check({ isClusterHead: false }))).toEqual({ kind: "skip", reason: "duplicate_cluster_member" });
    expect(evaluateNotifyPolicy(check({ isClusterHead: false, repostAfter72h: true })).kind).toBe("send_instant");
    expect(evaluateNotifyPolicy(check({ decidedAtMs: 7 * 3_600_000 }))).toEqual({ kind: "skip", reason: "stale_evaluation" });
    expect(evaluateNotifyPolicy(check({ isPreviewOrBackfill: true }))).toEqual({ kind: "skip", reason: "preview_or_backfill" });
    const quiet = { from: "22:30", to: "06:30" };
    expect(evaluateNotifyPolicy(check({ quietHours: quiet, localHour: 23 })).kind).toBe("queue_digest");
    expect(evaluateNotifyPolicy(check({ quietHours: quiet, localHour: 5, localMinute: 59 })).kind).toBe("queue_digest");
    expect(evaluateNotifyPolicy(check({ quietHours: quiet, localHour: 6, localMinute: 30 })).kind).toBe("send_instant");
    expect(evaluateNotifyPolicy(check({ leadsInLastHour: 31 }))).toEqual({ kind: "queue_digest", triggerFloodAutoDigest: true });
    expect(evaluateNotifyPolicy(check({ leadsInLastHour: 31, digestMode: true }))).toEqual({
      kind: "queue_digest",
      triggerFloodAutoDigest: false,
    });
  });

  it("formats digests (top 10 + overflow) and system alerts", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      lead_id: `L${i}`,
      summary: `Tin <${i}>`,
      score: 1,
      source_name: "Nhóm",
      permalink: i === 0 ? "https://fb.com/p/0" : "ftp://nope",
    }));
    const html = formatDigestHtml("Radar & Co", items, 3);
    expect(html.split("\n")[0]).toBe("📋 <b>Gộp tin: Radar &amp; Co</b>");
    expect(html).toContain('1. Tin &lt;0&gt; · <i>Nhóm</i> (<a href="https://fb.com/p/0">Mở</a>)');
    expect(html).not.toContain("11.");
    expect(html.endsWith("… và 5 tin khác")).toBe(true);

    expect(formatSystemAlertHtml({ kind: "ai_unavailable", pending_posts: 4 }, false)).toBe(
      "⚠️ <b>Cảnh báo hệ thống</b>\n\nKhông gọi được AI. 4 bài đang chờ",
    );
    expect(formatSystemAlertHtml({ kind: "radar_flood_auto_digest", radar_name: "<R>", leads_last_hour: 40 }, true)).toBe(
      "✅ <b>Đã khôi phục: &lt;R&gt;</b>\n\nLượng tin của radar đã ổn định trở lại.",
    );
    expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });
});

// ---- export ---------------------------------------------------------------------------------------

function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe("zip writer", () => {
  it("round-trips entries with valid CRCs and rejects unsafe names", () => {
    const zip = createZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/tệp.json", data: Buffer.from('{"k":1}') },
    ]);
    const files = readZip(zip);
    expect(files.get("a.txt")?.toString()).toBe("hello");
    expect(files.get("dir/tệp.json")?.toString()).toBe('{"k":1}');
    expect(() => createZip([{ name: "../evil", data: "x" }])).toThrowError(/invalid zip entry name/);
    expect(() => createZip([{ name: "a", data: "x" }, { name: "a", data: "y" }])).toThrowError(/duplicate/);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("lead export", () => {
  const defs = [
    fd("price", "money", { label: "Giá", order: 1 }),
    fd("where", "location", { label: "Khu vực", order: 2 }),
    fd("area", "range", { label: "Diện tích", order: 3 }),
    fd("pets", "boolean", { label: "Thú cưng", order: 4 }),
  ];
  const row = (over: Partial<ExportLeadRow> = {}): ExportLeadRow => ({
    post_created_at: 1_700_000_000_000,
    radar_name: "Radar",
    status: "new",
    score: 0.85,
    summary: "=HYPERLINK(\"http://evil\")",
    group_name: "Nhóm, \"A\"",
    author_name: "Ẩn danh",
    permalink: "https://www.facebook.com/groups/1/posts/2",
    post_text: "dòng 1\ndòng 2",
    fields: {
      price: { value: { min: 12_000_000, max: 15_000_000, currency: "VND", period: "month" }, raw: "", confidence: 1, source: "ai" },
      where: { value: { province: "HCM", district: "Q1" }, raw: "", confidence: 1, source: "ai" },
      area: { value: { min: 40, max: 60.5 }, raw: "", confidence: 1, source: "ai" },
      pets: { value: false, raw: "", confidence: 1, source: "ai" },
    },
    ...over,
  });

  it("writes BOM, CRLF, flattened composite columns, RFC 4180 quoting and formula protection", () => {
    const bytes = exportCsv({ include_post_text: true }, defs, [row(), row({ summary: "  +cmd", fields: {} })]);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").split("\r\n");
    expect(lines[0]).toBe(
      "Thời điểm đăng,Radar,Trạng thái,Điểm,Tóm tắt,Group,Tác giả,Liên kết,Nội dung,Giá (từ),Giá (đến),Giá (đơn vị),Khu vực (tỉnh),Khu vực (quận),Khu vực (phường),Diện tích (từ),Diện tích (đến),Thú cưng",
    );
    // multi-line cell stays inside one quoted record
    const text = bytes.subarray(3).toString("utf8");
    expect(text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(text).toContain('"Nhóm, ""A"""');
    expect(text).toContain('"dòng 1\ndòng 2"');
    expect(text).toContain(",12000000,15000000,VND/month,HCM,Q1,,40,60.5,Không\r\n");
    expect(text).toContain("'  +cmd");
    // empty second row still has one cell per column
    const records = text.split("\r\n").filter((l) => l !== "");
    expect(records[records.length - 1]!.split(",").length).toBeGreaterThanOrEqual(18);
  });

  it("builds an XLSX package with frozen bold header, typed numbers and a safe hyperlink", () => {
    const bytes = exportXlsx({ include_post_text: false }, defs, [row({ summary: "=1+1" })]);
    const files = readZip(bytes);
    expect([...files.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(files.get("xl/workbook.xml")!.toString()).toContain('name="Bảng tin"');
    const sheet = files.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">'); // bold header
    expect(sheet).toContain('<c r="D2"><v>0.85</v></c>'); // typed number
    expect(sheet).toContain('<c r="E2" t="inlineStr" s="0"><is><t xml:space="preserve">=1+1</t></is></c>'); // text, not a formula
    expect(sheet).toContain('<hyperlink ref="H2" r:id="rId1"/>');
    expect(files.get("xl/worksheets/_rels/sheet1.xml.rels")!.toString()).toContain(
      'Target="https://www.facebook.com/groups/1/posts/2" TargetMode="External"',
    );
    // non-Facebook link: plain text, no hyperlink part
    const plain = readZip(exportXlsx({ include_post_text: false }, defs, [row({ permalink: "https://example.com/x" })]));
    expect(plain.has("xl/worksheets/_rels/sheet1.xml.rels")).toBe(false);
    expect(() => exportXlsx({ include_post_text: false }, defs, [row({ summary: "x".repeat(40_000) })])).toThrowError(/xlsx export error/);
  });

  it("guards spreadsheet cells", () => {
    for (const bad of ["=A1", "+1", "-1", "@x", "\tx", "\rx", "  =x"]) expect(sanitizeSpreadsheetCell(bad)).toBe(`'${bad}`);
    expect(sanitizeSpreadsheetCell("safe")).toBe("safe");
    expect(sanitizeSpreadsheetCell("")).toBe("");
  });
});

// ---- webhook --------------------------------------------------------------------------------------

describe("webhook signing and URL policy", () => {
  it("matches the HMAC-SHA256 reference vector and verifies in constant time", () => {
    const sig = signWebhookBody("key", "The quick brown fox jumps over the lazy dog");
    expect(sig).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(verifyWebhookSignature("key", "The quick brown fox jumps over the lazy dog", sig)).toBe(true);
    expect(verifyWebhookSignature("key", "The quick brown fox jumps over the lazy cog", sig)).toBe(false);
    expect(verifyWebhookSignature("other", "The quick brown fox jumps over the lazy dog", sig)).toBe(false);
    expect(verifyWebhookSignature("key", "x", "md5=abc")).toBe(false);
    expect(verifyWebhookSignature("key", "x", "sha256=zz")).toBe(false);
    expect(verifyWebhookSignature("key", "x", "sha256=ab")).toBe(false);
    expect(verifyWebhookSignature("key", "The quick brown fox jumps over the lazy dog", ` ${sig.toUpperCase().replace("SHA256", "sha256")} `)).toBe(true);
  });

  it("accepts https and loopback http only, rejecting spoofed hosts", () => {
    for (const ok of ["https://example.com/hook", "http://localhost:3000/x", "http://127.0.0.1/x", "HTTP://LOCALHOST/x"]) {
      expect(() => validateWebhookUrl(ok)).not.toThrow();
    }
    for (const bad of [
      "http://example.com",
      "http://localhost@evil.com/",
      "http://localhost.evil.com/",
      "https://user:pw@example.com/",
      "ftp://example.com",
      "https://exa mple.com",
      "",
      "not a url",
    ]) {
      expect(() => validateWebhookUrl(bad), bad).toThrowError(/insecure or invalid webhook URL/);
    }
    expect([0, 1, 2, 3, 4, 5].map(webhookRetryBackoffS)).toEqual([10, 30, 120, 300, 600, null]);
    expect([0, 1, 2, 3, 4, 5].map(telegramRetryBackoffS)).toEqual([10, 30, 120, 300, 600, null]);
  });
});

describe("webhook client", () => {
  let server: MockServer;
  afterEach(async () => {
    await server.close();
  });

  const payload = () =>
    newLeadCreatedPayload({
      eventCreatedAtMs: 1_700_000_000_000,
      radarId: "r1",
      radarName: "Radar",
      leadId: "l1",
      score: 0.9,
      summary: "tóm tắt",
      extractedFields: { price: { value: 5, raw: "5tr", confidence: 1, source: "ai" } },
      permalink: "https://www.facebook.com/p/1",
      postCreatedAtMs: null,
      sourceName: "Nhóm",
      authorName: "A",
      postText: null,
    });

  it("POSTs a signed body that the receiver can verify, and classifies failures", async () => {
    server = await startMockServer();
    const client = new WebhookClient({ timeout_ms: 2_000 });
    const body = payload();
    expect(body).toMatchObject({ event: "lead.created", radar: { id: "r1", name: "Radar" } });
    expect(body.lead.post).toEqual({ permalink: "https://www.facebook.com/p/1", source: "Nhóm", author: "A" });
    expect(body.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);

    server.respondWith({ status: 204 });
    expect(await client.sendOnce(`${server.url}/hook`, "whsec_test", body, 0)).toEqual({ kind: "sent", status_code: 204 });
    const req = server.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(verifyWebhookSignature("whsec_test", req.body, String(req.headers["x-dealsonar-signature"]))).toBe(true);
    expect(verifyWebhookSignature("wrong", req.body, String(req.headers["x-dealsonar-signature"]))).toBe(false);
    expect(JSON.parse(req.body).id).toBe(body.id);

    server.respondWith({ status: 500 });
    expect(await client.sendOnce(`${server.url}/hook`, "s", body, 1)).toEqual({ kind: "retryable", next_delay_s: 30, reason: "HTTP 500" });
    expect(await client.sendOnce(`${server.url}/hook`, "s", body, 5)).toEqual({ kind: "exhausted", reason: "HTTP 500" });

    // redirects are never followed with the signed body
    server.respondWith({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    expect(await client.sendOnce(`${server.url}/hook`, "s", body, 0)).toMatchObject({ kind: "retryable", reason: "HTTP 302" });
    expect(server.requests.every((r) => r.url === "/hook")).toBe(true);

    await expect(client.sendOnce("http://evil.example/hook", "s", body, 0)).rejects.toBeInstanceOf(NotifyError);
  });

  it("times out slow receivers and redacts the secret from transport errors", async () => {
    server = await startMockServer();
    const client = new WebhookClient({ timeout_ms: 150 });
    server.respondWith({ status: 200, delayMs: 800 });
    const slow = await client.sendOnce(`${server.url}/hook`, "whsec_secret", payload(), 0);
    expect(slow).toMatchObject({ kind: "retryable", reason: "request timed out" });

    const failing = new WebhookClient({
      fetch: (async () => {
        throw new Error("connect failed for whsec_secret");
      }) as unknown as typeof fetch,
    });
    const res = await failing.sendOnce("https://example.com/h", "whsec_secret", payload(), 0);
    expect(res).toMatchObject({ kind: "retryable" });
    expect(JSON.stringify(res)).not.toContain("whsec_secret");
  });
});

// ---- telegram -------------------------------------------------------------------------------------

describe("telegram client", () => {
  const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789";
  let server: MockServer;
  afterEach(async () => {
    await server.close();
  });
  const make = () => new TelegramClient({ api_base_url: server.url, enforce_rate_limits: false, request_timeout_ms: 2_000 });

  it("verifies tokens with getMe and never leaks the token in errors", async () => {
    server = await startMockServer();
    const tg = make();
    server.respondWith({ body: { ok: true, result: { id: 7, username: "deal_bot", first_name: "Deal" } } });
    expect(await tg.getMe(TOKEN)).toEqual({ id: 7, username: "deal_bot", first_name: "Deal" });
    expect(server.requests[0]).toMatchObject({ method: "GET", url: `/bot${TOKEN}/getMe` });

    server.respondWith({ status: 401, body: { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` } });
    const err = await tg.getMe(TOKEN).catch((e: unknown) => e as NotifyError);
    expect(err).toBeInstanceOf(NotifyError);
    expect((err as NotifyError).message).toBe("telegram API error (code 401): Unauthorized [REDACTED]");

    const down = new TelegramClient({ api_base_url: "http://127.0.0.1:1", request_timeout_ms: 500 });
    const netErr = await down.getMe(TOKEN).catch((e: unknown) => e as NotifyError);
    expect((netErr as NotifyError).message).toMatch(/^telegram HTTP failure: /);
    expect((netErr as NotifyError).message).not.toContain(TOKEN);
  });

  it("classifies sendMessage outcomes", async () => {
    server = await startMockServer();
    const tg = make();
    const req = sendMessageHtml(42, "<b>hi</b>", null);

    server.respondWith({ body: { ok: true, result: { message_id: 99 } } });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 0)).toEqual({ kind: "sent", message_id: 99 });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      chat_id: 42,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    server.respondWith({ status: 429, body: { ok: false, error_code: 429, description: "Too Many", parameters: { retry_after: 7 } } });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 0)).toEqual({ kind: "rate_limited", retry_after_s: 7 });
    server.respondWith({ status: 429, headers: { "retry-after": "3" }, body: {} });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 0)).toEqual({ kind: "rate_limited", retry_after_s: 3 });
    server.respondWith({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" } });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 0)).toEqual({ kind: "auth_revoked" });
    server.respondWith({ status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 2, 0)).toEqual({ kind: "retryable_network", next_delay_s: 120 });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 5, 0)).toEqual({
      kind: "dropped",
      reason: "exhausted 5 retries: Bad Gateway",
    });
    server.respondWith({ status: 400, body: { ok: false, error_code: 400, description: `Bad Request: ${TOKEN}` } });
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 0)).toEqual({
      kind: "permanent_failure",
      status_code: 400,
      description: "Bad Request: [REDACTED]",
    });
    const before = server.requests.length;
    expect(await tg.deliverOutboxMessage(TOKEN, req, 0, 2 * 3_600_000 + 1)).toMatchObject({ kind: "dropped" });
    expect(server.requests.length).toBe(before);
  });

  it("limits per-chat sends to 1/s and groups to 20/min", () => {
    const lim = new ChatRateLimiter();
    expect(lim.checkAndRecord(5, 0)).toBeNull();
    expect(lim.checkAndRecord(5, 400)).toBe(600);
    expect(lim.checkAndRecord(5, 1_000)).toBeNull();
    expect(lim.checkAndRecord(6, 1_001)).toBeNull();
    for (let i = 0; i < 20; i += 1) expect(lim.checkAndRecord(-100, i * 1_000)).toBeNull();
    expect(lim.checkAndRecord(-100, 21_000)).toBe(39_000);
    expect(lim.checkAndRecord(-100, 60_000)).toBeNull();
  });

  it("turns updates into commands/feedback, enforcing chat registration and bot mentions", async () => {
    server = await startMockServer();
    const tg = make();
    const msg = (id: number, chatId: number, text: string, type = "private") => ({
      update_id: id,
      message: { message_id: id, chat: { id: chatId, type, title: type === "private" ? undefined : "Nhóm G", first_name: "An", last_name: "Bình" }, text },
    });
    const callback = (id: number, chatId: number, data: string) => ({
      update_id: id,
      callback_query: {
        id: `cb${id}`,
        data,
        message: {
          message_id: 500 + id,
          chat: { id: chatId, type: "private" },
          reply_markup: { inline_keyboard: [[{ text: "Mở bài viết", url: "https://www.facebook.com/p/1" }]] },
        },
      },
    });
    server.route(
      (r) => r.url.endsWith("/getUpdates"),
      () => ({
        body: {
          ok: true,
          result: [
            msg(10, 111, "/start"), // any chat may start
            msg(11, -200, "/start@deal_bot", "supergroup"),
            msg(12, 111, "/start@other_bot"), // another bot's command
            msg(13, 999, "/pause"), // unregistered
            msg(14, 111, "/status"),
            msg(15, 111, "hello"),
            callback(16, 111, "fb:L1:correct"),
            callback(17, 111, "fb:L1:wrong"),
            callback(18, 111, "fb:L1:spam"),
            callback(19, 999, "fb:L1:correct"), // unregistered
            callback(20, 111, "noop"),
          ],
        },
      }),
    );
    server.route(
      (r) => !r.url.endsWith("/getUpdates"),
      () => ({ body: { ok: true, result: true } }),
    );

    const res = await tg.pollUpdates(TOKEN, {
      offset: 5,
      timeout_s: 1,
      bot_username: "@Deal_Bot",
      registered_chat_ids: new Set([111]),
    });
    expect(res.next_offset).toBe(21);
    expect(res.rejected_unregistered_count).toBe(2);
    expect(res.events).toEqual([
      { kind: "start_command", chat_id: 111, chat_title: "An Bình", is_group: false },
      { kind: "start_command", chat_id: -200, chat_title: "Nhóm G", is_group: true },
      { kind: "status_command", chat_id: 111 },
      { kind: "lead_feedback", chat_id: 111, lead_id: "L1", label: "correct" },
      { kind: "lead_feedback", chat_id: 111, lead_id: "L1", label: "spam" },
    ]);

    const getUpdates = JSON.parse(server.requests[0].body);
    expect(getUpdates).toEqual({ offset: 5, timeout: 1, allowed_updates: ["message", "callback_query"] });

    const edits = server.requests.filter((r) => r.url.endsWith("/editMessageReplyMarkup")).map((r) => JSON.parse(r.body));
    expect(edits).toHaveLength(3);
    expect(edits[0].reply_markup.inline_keyboard[0].map((b: { text: string }) => b.text)).toEqual(["Mở bài viết", "✅ Đã ghi nhận"]);
    expect(edits[1].reply_markup.inline_keyboard.map((r: unknown[]) => r.length)).toEqual([1, 2, 2]); // url row + reasons
    expect(edits[2].reply_markup.inline_keyboard[0][1].text).toBe("📝 Đã ghi nhận");
    const answers = server.requests.filter((r) => r.url.endsWith("/answerCallbackQuery")).map((r) => JSON.parse(r.body));
    expect(answers.map((a) => a.text)).toEqual(["✅ Đã ghi nhận", "Chọn lý do tin chưa đúng", "📝 Đã ghi nhận", undefined]);
  });
});
