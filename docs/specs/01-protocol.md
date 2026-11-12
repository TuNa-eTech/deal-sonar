# Đặc tả giao thức extension ⇄ desktop

Trạng thái: nháp v0.1 · 2026-11-11 · Phiên bản giao thức mô tả ở đây: **2**

Repo hiện có giao thức v1 chỉ gồm `ping`/`pong` ([crates/protocol/src/lib.rs](../../crates/protocol/src/lib.rs)). Tài liệu này định nghĩa v2.

## 1. Tầng vận chuyển

```
extension ──(A)── native host ──(B)── desktop
```

**(A) Native Messaging.** Extension mở cổng lâu dài bằng `chrome.runtime.connectNative("com.dealsonar.host")`. Mỗi message là JSON UTF-8 đi sau 4 byte độ dài theo thứ tự byte của máy (little-endian trên mọi nền tảng được hỗ trợ). Giới hạn của Chrome: message từ host về extension tối đa 1 MB; từ extension tới host tối đa 64 MiB.

**(B) IPC cục bộ.** Cùng cách đóng khung (4 byte độ dài little-endian + JSON).

| Hệ điều hành | Điểm cuối |
|---|---|
| macOS | Unix socket `~/Library/Application Support/DealSonar/ipc.sock` |
| Linux | Unix socket `$XDG_RUNTIME_DIR/dealsonar/ipc.sock` |
| Windows | Named pipe `\\.\pipe\dealsonar-<SID người dùng>` |

Thư mục chứa socket có quyền 0700; named pipe có ACL chỉ cho người dùng hiện tại.

**Native host** chuyển nguyên văn từng khung theo cả hai chiều và không phân tích nội dung, với hai ngoại lệ:

- Nếu không nối được (B), nó tự trả `error` với mã `desktop_unavailable` cho mỗi message nhận được, và thử nối lại mỗi 5 giây.
- Khi stdin đóng (Chrome đóng cổng), nó đóng (B) và thoát.

## 2. Phong bì

Mọi message ở cả hai chiều có cùng dạng:

```jsonc
{
  "v": 2,                         // phiên bản giao thức
  "id": "01JCF7Z3K8...",          // ULID, duy nhất theo người gửi
  "type": "posts.push",
  "ts": 1794384000000,            // mili giây Unix lúc gửi
  "reply_to": null,               // id của message đang được trả lời, nếu có
  "payload": { }
}
```

Trong Rust, biểu diễn bằng một struct `Envelope` và enum `Body` gắn thẻ nội bộ theo `type`, giữ kiểu `serde` hiện có (`#[serde(tag = "type")]`, tên có dấu chấm đặt qua `#[serde(rename = "...")]`).

## 3. Bắt tay và phiên bản

1. Extension mở cổng và gửi `hello`.
2. Desktop trả `hello.ok` hoặc `error` mã `protocol_mismatch`.
3. Desktop gửi ngay `config.update` nếu `config_rev` của extension cũ hơn.

Quy tắc tương thích: hai phía chấp nhận nhau khi cùng số `v`. Trường lạ trong `payload` bị bỏ qua (cho phép thêm trường mà không tăng `v`). Kiểu message lạ được trả `error` mã `unknown_type` và không làm đứt kết nối. Thay đổi phá vỡ thì tăng `v`; khi lệch, cả hai phía hiện thông báo yêu cầu cập nhật phía cũ hơn.

## 4. Danh mục message

### 4.1 Extension → desktop

| Kiểu | Khi nào | Payload |
|---|---|---|
| `hello` | Ngay sau khi mở cổng | `{profile_id, ext_version, browser, config_rev}` |
| `posts.push` | Sau mỗi lần trích được bài | `{run_id, source_ref, posts: RawPost[]}` |
| `crawl.report` | Kết thúc một lần quét một nguồn | `{run_id, source_ref, reason, status, started_at, ended_at, posts_seen, posts_new, page_loads, strategy, error?}` |
| `sources.discovered` | Extension thấy danh sách group người dùng đã tham gia, hoặc người dùng bấm "Theo dõi group này" | `{sources: SourceInfo[], follow?: boolean}` |
| `session.status` | Khi trạng thái phiên Facebook đổi, và trong mỗi `crawl.report` có lỗi phiên | `{platform, state, detail?}` |
| `ping` | Kiểm tra sống, mỗi 25 giây khi không có lưu lượng | `{}` |

`session.state`: `ok` · `logged_out` · `checkpoint` (Facebook yêu cầu xác minh) · `rate_limited` (thấy thông báo hạn chế tạm thời) · `unknown`.

`crawl.report.status`: `ok` · `empty` (trang tải được nhưng không trích được bài nào) · `blocked` (lỗi phiên) · `error`.

`crawl.report.reason`: `scheduled` (theo lịch) · `manual` · `preview` (hai giá trị này đến từ `crawl.request`) · `passive` (người dùng tự mở group, extension chỉ đọc theo).

### 4.2 Desktop → extension

| Kiểu | Khi nào | Payload |
|---|---|---|
| `hello.ok` | Trả lời `hello` | `{desktop_version, config_rev}` |
| `config.update` | Sau bắt tay nếu cần, và mỗi khi cấu hình đổi | `{rev, plan: CrawlPlan, policy: CrawlPolicy, extractor: ExtractorProfile}` |
| `crawl.request` | Người dùng bấm "Quét ngay" hoặc cần bài để xem thử | `{request_id, source_ref, reason: "manual" \| "preview", max_posts}` |
| `crawl.pause` | Người dùng tạm dừng, hoặc desktop phát hiện bất thường | `{until: number \| null, reason}` |
| `crawl.resume` | Bỏ tạm dừng | `{}` |
| `ack` | Trả lời `posts.push`, `crawl.report`, `sources.discovered` | `{accepted, duplicates}` |
| `pong` | Trả lời `ping` | `{}` |
| `error` | Bất kỳ lỗi nào | `{code, message, retryable}` |

Mã lỗi: `protocol_mismatch`, `unknown_type`, `invalid_payload`, `desktop_unavailable`, `busy`, `internal`.

### 4.3 Kiểu dữ liệu

```ts
type SourceRef = { platform: "facebook"; kind: "group"; external_id: string };

type SourceInfo = SourceRef & {
  name: string;
  url: string;
  privacy?: "public" | "private";
  member_count?: number;
};

type RawPost = {
  platform: "facebook";
  post_id: string;                 // ID bài của nền tảng; khoá bất biến cùng với platform
  source_external_id: string;
  permalink: string;
  author: { external_id?: string; name: string; is_anonymous: boolean };
  text: string;                    // nội dung đầy đủ, đã mở "Xem thêm" nếu lấy được
  text_truncated: boolean;         // true nếu chỉ lấy được phần rút gọn
  created_at?: number;             // mili giây Unix; có thể thiếu khi trích từ DOM
  captured_at: number;
  attachments: { kind: "photo" | "video" | "link" | "other"; url?: string; alt?: string }[];
  counts?: { comments?: number; reactions?: number };
  extraction: { strategy: "network" | "embedded" | "dom"; profile_rev: number };
};

type CrawlPlan = {
  entries: {
    source_ref: SourceRef;
    interval_s: number;            // chu kỳ mong muốn cho nguồn này
    priority: number;              // 0 = bình thường, 1 = ưu tiên
    max_posts_per_visit: number;
  }[];
};

type CrawlPolicy = {
  max_loads_per_hour: number;
  max_loads_per_day: number;
  active_hours: { from: string; to: string };   // "07:00"–"23:00", giờ máy
  jitter: number;                               // 0.3 = ±30%
  max_scroll_steps: number;
  only_when_idle: boolean;
};

type ExtractorProfile = {
  rev: number;
  strategies: ("network" | "embedded" | "dom")[];  // thứ tự thử
  network: unknown;                // quy tắc tìm bài trong phản hồi mạng; xem Extension §4
  dom: unknown;                    // bộ chọn và quy tắc DOM
  session_markers: unknown;        // dấu hiệu nhận biết đăng xuất, checkpoint, hạn chế
};
```

`ExtractorProfile` là **dữ liệu**, không phải mã: chỉ gồm đường dẫn, bộ chọn, mẫu chuỗi. Chính sách Manifest V3 cấm tải mã từ xa; cấu hình thì được phép.

## 5. Giao nhận

**Ít nhất một lần, bất biến.**

- Extension giữ mỗi `posts.push`, `crawl.report`, `sources.discovered` trong hàng đợi bền (IndexedDB) cho tới khi nhận `ack` có `reply_to` khớp.
- Không có `ack` sau 30 giây, hoặc nhận `error` có `retryable: true`: gửi lại với cùng `id`, lùi dần 5 giây → 5 phút.
- Desktop khử trùng bài theo `(platform, post_id)` và khử trùng message theo `id`. `ack.duplicates` báo số bài đã có.

**Kích thước.** Một `posts.push` chứa tối đa 100 bài hoặc 512 KB sau khi mã hoá, cái nào tới trước. `config.update` phải dưới 1 MB (giới hạn chiều host → extension); với 50 nguồn, kích thước thực tế cỡ vài chục KB.

**Hàng đợi của extension.** Tối đa 5.000 bài hoặc 7 ngày; khi đầy, bỏ bài cũ nhất và ghi nhận trong `crawl.report` kế tiếp.

**Thứ tự.** Không đảm bảo thứ tự giữa các message. Desktop không được giả định bài tới theo thứ tự thời gian.

## 6. Ví dụ một phiên

```jsonc
// → extension gửi
{"v":2,"id":"01A","type":"hello","ts":1794384000000,"reply_to":null,
 "payload":{"profile_id":"p_7f3a","ext_version":"0.2.0","browser":"chrome/142","config_rev":11}}

// ← desktop trả
{"v":2,"id":"01B","type":"hello.ok","ts":1794384000050,"reply_to":"01A",
 "payload":{"desktop_version":"0.2.0","config_rev":12}}

// ← desktop đẩy cấu hình mới hơn
{"v":2,"id":"01C","type":"config.update","ts":1794384000060,"reply_to":null,
 "payload":{"rev":12,"plan":{"entries":[{"source_ref":{"platform":"facebook","kind":"group","external_id":"123456789"},
   "interval_s":900,"priority":0,"max_posts_per_visit":30}]},
   "policy":{"max_loads_per_hour":60,"max_loads_per_day":600,"active_hours":{"from":"07:00","to":"23:00"},
   "jitter":0.3,"max_scroll_steps":3,"only_when_idle":false},
   "extractor":{"rev":4,"strategies":["network","embedded","dom"],"network":{},"dom":{},"session_markers":{}}}}

// → extension gửi bài
{"v":2,"id":"01D","type":"posts.push","ts":1794384905000,"reply_to":null,
 "payload":{"run_id":"r_01","source_ref":{"platform":"facebook","kind":"group","external_id":"123456789"},
   "posts":[{"platform":"facebook","post_id":"987654321","source_external_id":"123456789",
     "permalink":"https://www.facebook.com/groups/123456789/posts/987654321/",
     "author":{"name":"Nguyễn Văn A","is_anonymous":false},
     "text":"E cần thuê chung cư 2pn khu Cầu Giấy, tầm 12-15tr, vào ở luôn. Lh 0912.345.678",
     "text_truncated":false,"created_at":1794384600000,"captured_at":1794384900000,
     "attachments":[],"extraction":{"strategy":"network","profile_rev":4}}]}}

// ← desktop xác nhận
{"v":2,"id":"01E","type":"ack","ts":1794384905020,"reply_to":"01D","payload":{"accepted":1,"duplicates":0}}
```

## 7. Chuyển từ v1

- Giữ `ping`/`pong` làm kiểm tra sống, đặt vào phong bì mới.
- `Request`/`Response` hiện tại được thay bằng `Envelope` + `Body`; native host thôi tự trả lời `ping` và trở thành bộ chuyển tiếp thuần.
- `background/index.ts` đổi từ `sendNativeMessage` (một lần) sang `connectNative` (cổng lâu dài).
- Kiểu TypeScript sinh từ Rust để hai bản không lệch nhau.
