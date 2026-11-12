# Tổng quan kiến trúc

Trạng thái: nháp v0.1 · 2026-11-11

## 1. Ràng buộc đầu vào

Ba ràng buộc này là của bạn và không được xem xét lại trong tài liệu:

1. **Hai ứng dụng.** Extension Chrome thu dữ liệu; app desktop viết bằng Rust làm mọi việc còn lại.
2. **Không backend.** Mọi dữ liệu và xử lý nằm trên máy người dùng. App desktop có cơ sở dữ liệu riêng, đóng vai CRM.
3. **AI qua bridge tới CLI.** App desktop gọi `claude`, `codex`, hoặc `agy` (Antigravity) đã cài trên máy.

## 2. Sơ đồ ngữ cảnh

```
┌──────────────────────────── Máy người dùng ────────────────────────────┐
│                                                                        │
│  ┌──────────────── Chrome ────────────────┐                            │
│  │  facebook.com (phiên của người dùng)   │                            │
│  │        ▲ đọc                           │                            │
│  │  ┌─────┴──────────────────────────┐    │                            │
│  │  │ Extension DealSonar (MV3)      │    │                            │
│  │  │  content scripts · service     │    │                            │
│  │  │  worker · popup                │    │                            │
│  │  └─────┬──────────────────────────┘    │                            │
│  └────────┼───────────────────────────────┘                            │
│           │ Native Messaging (stdio, JSON có tiền tố độ dài)           │
│  ┌────────▼─────────┐                                                  │
│  │ Native host      │  tiến trình chuyển tiếp, Chrome khởi chạy        │
│  └────────┬─────────┘                                                  │
│           │ IPC cục bộ (Unix socket / named pipe)                      │
│  ┌────────▼──────────────────────────────────────────────┐             │
│  │ App desktop DealSonar (Rust)                          │             │
│  │  ipc · ingest · pipeline · rules · ai-bridge ·        │   spawn     │
│  │  notify · store (SQLite) · UI                         ├──────────┐  │
│  └────────┬──────────────────────────────────────────────┘          │  │
│           │                                         ┌───────────────▼┐ │
│           │                                         │ claude / codex │ │
│           │                                         │ / agy (CLI)    │ │
│           │                                         └───────┬────────┘ │
└───────────┼─────────────────────────────────────────────────┼──────────┘
            │ HTTPS                                           │ HTTPS
     ┌──────▼───────┐                                 ┌───────▼────────┐
     │ Telegram     │                                 │ Nhà cung cấp   │
     │ Bot API      │                                 │ AI             │
     └──────────────┘                                 └────────────────┘
```

Hai kết nối mạng duy nhất rời máy do DealSonar khởi tạo: tới Telegram Bot API (nội dung tin báo) và, qua CLI, tới nhà cung cấp AI (nội dung bài cần chấm). Người dùng cần biết cả hai trong phần quyền riêng tư.

## 3. Thành phần và trách nhiệm

| Thành phần | Vị trí | Trách nhiệm | Không làm |
|---|---|---|---|
| **Extension** | `apps/extension` | Mở trang group theo lịch, trích bài, đệm và gửi về desktop, báo trạng thái phiên Facebook | Không quyết định bài nào khớp, không gọi AI, không giữ cấu hình radar |
| **Native host** | `crates/native-host` | Chuyển nguyên văn message giữa stdio và IPC cục bộ | Không diễn giải message ngoài `ping` |
| **Protocol** | `crates/protocol` | Kiểu message dùng chung; bản sao TypeScript ở `apps/extension/src/protocol.ts` | |
| **Desktop** | `apps/desktop` | Vỏ ứng dụng, giao diện, khay hệ thống, tự khởi động, cài native host | |
| **Core** | `crates/core` *(mới)* | Kiểu miền (radar, bài, tin), điều phối chuỗi xử lý, lập lịch | |
| **Store** | `crates/store` *(mới)* | SQLite, migration, truy vấn, tìm toàn văn | |
| **Rules** | `crates/rules` *(mới)* | Chuẩn hoá văn bản, lọc trùng, bộ máy chạy bộ luật, bộ trích dựng sẵn | |
| **AI bridge** | `crates/ai-bridge` *(mới)* | Giao diện provider, adapter cho từng CLI, prompt, kiểm tra đầu ra | |
| **Notify** | `crates/notify` *(mới)* | Telegram, hộp gửi đi, xuất file, webhook | |

Nguyên tắc phân chia: **extension càng mỏng càng tốt.** Extension là phần khó cập nhật nhất (duyệt cửa hàng, vòng đời service worker) và dễ vỡ nhất (Facebook đổi giao diện). Mọi quyết định có thể chuyển về desktop đều chuyển về desktop, kể cả lịch quét và cấu hình bộ trích.

## 4. Cấu trúc repo đề xuất

Phần đã có trong repo giữ nguyên; phần đánh dấu *(mới)* cần thêm.

```
apps/
  desktop/
    src/                    Vỏ Rust: khởi động, khay hệ thống, lệnh cho UI
    ui/                     (mới) Giao diện web: React + TypeScript + Vite
    templates/              (mới) Mẫu radar, mỗi mẫu một file JSON
  extension/
    src/
      background/           Service worker: kết nối native, lập lịch, hàng đợi gửi
      content/              (mới) Trích bài: tap.ts (MAIN world), extract.ts, dom.ts
      popup/                Popup trạng thái
      protocol.ts           Bản sao kiểu message
crates/
  protocol/                 Kiểu message dùng chung
  native-host/              Tiến trình chuyển tiếp
  core/                     (mới)
  store/                    (mới)
  rules/                    (mới)
  ai-bridge/                (mới)
  notify/                   (mới)
docs/                       Bộ tài liệu này
scripts/                    Cài file khai báo native host khi phát triển, sinh kiểu TS
```

Kiểu message TypeScript nên được sinh từ Rust (ví dụ bằng `ts-rs`) thay vì chép tay như hiện nay, để hai phía không lệch nhau.

## 5. Luồng dữ liệu chính

### 5.1 Từ bài đăng tới tin báo

```
 Facebook        Extension              Desktop                         Ngoài
    │                │                     │                              │
    │  trang group   │                     │                              │
    │◄───────────────┤ 1. mở tab theo lịch │                              │
    ├───────────────►│ 2. trích bài        │                              │
    │                ├────────────────────►│ 3. posts.push                │
    │                │◄────────────────────┤ 4. ack                       │
    │                │                     │ 5. chuẩn hoá, lọc trùng      │
    │                │                     │ 6. với mỗi radar đang chạy:  │
    │                │                     │    lọc sơ bộ ─► bộ luật ─►   │
    │                │                     │    (nếu chưa chắc) AI ──────►│ CLI AI
    │                │                     │◄─────────────────────────────┤
    │                │                     │ 7. lọc sau, tạo tin          │
    │                │                     │ 8. gửi thông báo ───────────►│ Telegram
```

Ngân sách độ trễ ở cấu hình mặc định:

| Chặng | Thời gian | Ghi chú |
|---|---|---|
| Bài đăng → được quét | 0–15 phút, trung vị ~7 phút | Chu kỳ quét mặc định 15 phút mỗi group |
| Quét → vào hàng đợi AI | dưới 5 giây | |
| Chờ gom lô | 0–45 giây | Gom để giảm số lần khởi chạy CLI |
| Gọi AI | 10–60 giây | Phụ thuộc CLI và kích thước lô |
| Gửi Telegram | dưới 2 giây | |
| **Tổng, trung vị** | **~9 phút** | Chặng đầu chiếm gần hết |

"Báo trong vài phút" theo nghĩa đen chỉ đạt được khi rút chu kỳ quét xuống 5 phút cho group ưu tiên, đổi lại tải lên Facebook cao hơn. Mặc định ưu tiên an toàn tài khoản.

### 5.2 Cấu hình đi ngược lại

Desktop là nguồn sự thật cho danh sách nguồn, lịch quét và cấu hình bộ trích. Mỗi khi thay đổi, desktop gửi `config.update` kèm số phiên bản tăng dần; extension lưu vào `chrome.storage.local` và dùng cho tới khi có bản mới.

## 6. Mô hình tiến trình

| Tiến trình | Vòng đời | Số lượng |
|---|---|---|
| App desktop | Chạy từ lúc đăng nhập máy, ẩn ở khay hệ thống | Đúng một (khoá đơn thể) |
| Native host | Chrome khởi chạy khi extension gọi `connectNative`, thoát khi cổng đóng | Một cho mỗi profile Chrome có extension |
| Service worker của extension | Được Chrome giữ sống khi cổng native còn mở | Một cho mỗi profile |
| CLI AI | Desktop khởi chạy cho từng lô, thoát khi xong | Tối đa 1 đồng thời (mặc định) |

Nhiều profile Chrome nghĩa là nhiều tài khoản Facebook. Desktop chấp nhận nhiều kết nối, mỗi kết nối mang một `profile_id` do extension tự sinh; nguồn được gắn với profile đã thấy nó.

**Khi desktop không chạy:** native host không nối được IPC và trả `desktop_unavailable`. Extension ngừng quét chủ động (quét mà không ai xử lý chỉ tạo tải vô ích lên Facebook), hiện huy hiệu cảnh báo, và thử lại theo chu kỳ. Bài đã trích nhưng chưa gửi nằm trong hàng đợi của extension.

## 7. Công nghệ

| Lớp | Lựa chọn | Lý do ngắn | ADR |
|---|---|---|---|
| Extension | Manifest V3, TypeScript, Vite | Đã có trong repo | |
| Kênh extension–desktop | Native Messaging + IPC cục bộ | Không mở cổng mạng, Chrome hỗ trợ chính thức | ADR-002 |
| Vỏ desktop | Tauri 2 | UI dạng bảng và form dễ làm bằng web; nhân Rust giữ nguyên | ADR-003 |
| Giao diện | React + TypeScript | Dùng chung công cụ với extension | ADR-003 |
| Cơ sở dữ liệu | SQLite (`rusqlite`, bundled, WAL, FTS5) | Một file, không cần cài, có tìm toàn văn | ADR-004 |
| Bất đồng bộ | `tokio` | Chuẩn thực tế | |
| IPC | crate `interprocess` | Unix socket và named pipe sau cùng một API | |
| HTTP | `reqwest` (rustls) | Telegram, webhook | |
| Bí mật | crate `keyring` | Token Telegram nằm trong kho khoá hệ điều hành | |
| AI | Tiến trình con gọi CLI | Ràng buộc đầu vào | ADR-005 |
| Bộ luật | DSL khai báo, bộ máy bằng Rust | Không chạy mã do AI sinh | ADR-006 |

## 8. Vấn đề xuyên suốt

**Bảo mật.**
- IPC chỉ mở cho người dùng hiện tại (thư mục quyền 0700 trên Unix; ACL theo người dùng trên Windows). Không có cổng TCP nào.
- File khai báo native host giới hạn `allowed_origins` ở đúng ID của extension.
- Nội dung bài là dữ liệu không tin cậy: không bao giờ được thực thi, và khi đưa cho AI thì CLI chạy với mọi công cụ bị tắt ([AI bridge §6](../specs/06-ai-bridge.md#6-bảo-mật)).
- Token Telegram nằm trong kho khoá hệ điều hành, không nằm trong SQLite hay file cấu hình.

**Riêng tư.** Dữ liệu không rời máy trừ hai luồng ở §2. Bài không khớp bị xoá nội dung sau 30 ngày. Không thu danh sách thành viên, không đọc trang cá nhân.

**Khả năng chịu lỗi.** Giao nhận ít nhất một lần giữa extension và desktop, bất biến theo `(platform, post_id)`. Mọi việc dài (gọi AI, gửi thông báo) là hàng đợi bền trong SQLite, chạy lại được sau khi app tắt đột ngột.

**Quan sát.** Nhật ký có cấu trúc ra file xoay vòng; bảng `crawl_runs` và `ai_calls` là nguồn cho trang Sức khoẻ. Không gửi số liệu ra ngoài trừ khi người dùng bật.

**Mở rộng nền tảng.** Mọi bảng và message mang trường `platform`. Thêm nền tảng mới nghĩa là thêm một bộ trích trong extension và một giá trị `platform`; chuỗi xử lý không đổi.

**Cập nhật.** Desktop tự cập nhật qua cơ chế của Tauri (file tĩnh trên một máy chủ phát hành; đây là hạ tầng phân phối, không phải backend xử lý dữ liệu). Cấu hình bộ trích đi theo bản desktop và được đẩy xuống extension, nên phần lớn thay đổi giao diện của Facebook sửa được mà không phải phát hành lại extension.
