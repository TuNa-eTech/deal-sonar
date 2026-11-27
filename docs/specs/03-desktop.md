# Đặc tả app desktop

Trạng thái: nháp v0.1 · 2026-11-11

App desktop là nơi mọi quyết định diễn ra: giữ dữ liệu, chấm bài, gọi AI, gửi thông báo, hiển thị giao diện. Viết bằng Rust, vỏ Tauri 2 ([ADR-003](../architecture/02-decisions.md#adr-003-giao-diện-desktop-bằng-tauri-2)).

## 1. Module

```
apps/desktop (vỏ)
  ├── khởi động, đơn thể, khay hệ thống, tự chạy cùng máy
  ├── lệnh cho giao diện (Tauri commands) và sự kiện đẩy lên giao diện
  └── cài file khai báo native host

crates/core
  ├── domain      kiểu miền: Radar, RadarVersion, Field, Post, Evaluation, Lead…
  ├── ingest      nhận message từ IPC, kiểm tra, ghi bài
  ├── pipeline    điều phối các tầng xử lý (xem 05-pipeline-rules.md)
  ├── scheduler   tính kế hoạch quét, công việc định kỳ
  ├── jobs        hàng đợi công việc bền trên SQLite
  └── license     kiểm tra khoá bản quyền và giới hạn gói

crates/store      SQLite: kết nối, migration, kho truy vấn theo từng tập hợp
crates/rules      chuẩn hoá, băm, lọc trùng, bộ máy bộ luật, bộ trích dựng sẵn
crates/ai-bridge  provider, adapter CLI, prompt, schema, kiểm tra đầu ra
crates/notify     Telegram, hộp gửi đi, xuất file, webhook
```

Quy tắc phụ thuộc: `core` phụ thuộc `store`, `rules`, `ai-bridge`, `notify`. Bốn crate đó không phụ thuộc lẫn nhau và không phụ thuộc `core`. Vỏ desktop chỉ phụ thuộc `core`. Giao diện không chứa nghiệp vụ.

## 2. Khởi động và vòng đời

1. Lấy khoá đơn thể; nếu đã có một bản đang chạy thì đưa cửa sổ của bản đó lên và thoát.
2. Mở SQLite, chạy migration còn thiếu. Sao lưu file trước khi chạy migration phá vỡ.
3. Khởi tạo các dịch vụ: máy chủ IPC, bộ chạy công việc, bộ lập lịch, bộ nhận Telegram (nếu đã cấu hình).
4. Kiểm tra file khai báo native host; ghi lại nếu thiếu hoặc trỏ sai đường dẫn (sau khi app được cập nhật hoặc di chuyển).
5. Hiện biểu tượng khay. Nếu khởi động cùng máy, không mở cửa sổ.

Đóng cửa sổ không thoát app; app tiếp tục chạy ở khay. "Thoát" nằm trong menu khay và dừng các dịch vụ theo thứ tự: ngừng nhận việc mới, chờ lời gọi AI đang chạy tối đa 10 giây, đóng IPC, đóng SQLite.

### 2.1 Thư mục dữ liệu

| Hệ điều hành | Đường dẫn |
|---|---|
| macOS | `~/Library/Application Support/DealSonar/` |
| Windows | `%APPDATA%\DealSonar\` |
| Linux | `~/.local/share/dealsonar/` |

```
dealsonar.db            cơ sở dữ liệu
dealsonar.db-wal, -shm  file WAL của SQLite
backups/                bản sao lưu tự động trước migration, giữ 5 bản gần nhất
logs/                   nhật ký xoay vòng, giữ 7 ngày
ai-workdir/             thư mục rỗng làm thư mục làm việc cho CLI AI
ipc.sock                socket (macOS; Linux dùng $XDG_RUNTIME_DIR)
```

### 2.2 File khai báo native host

App tự ghi khi người dùng bấm "Kết nối Chrome", và kiểm tra lại mỗi lần khởi động.

| Hệ điều hành | Vị trí |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.dealsonar.host.json` |
| Windows | Khoá registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host` trỏ tới file JSON trong thư mục dữ liệu |

```json
{
  "name": "com.dealsonar.host",
  "description": "DealSonar native host",
  "path": "/đường/dẫn/tuyệt/đối/tới/dealsonar-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<ID của extension>/"]
}
```

Tệp chạy `dealsonar-native-host` được đóng gói cùng app. Các trình duyệt nhân Chromium khác (Edge, Brave, Cốc Cốc) dùng vị trí khác; hỗ trợ ở P1.

## 3. Dịch vụ nền

| Dịch vụ | Việc | Chu kỳ |
|---|---|---|
| **Máy chủ IPC** | Nhận kết nối từ native host, bắt tay, chuyển message cho `ingest`, gửi cấu hình | Luôn chạy |
| **Bộ chạy công việc** | Lấy công việc đến hạn từ bảng `jobs`, chạy, thử lại khi lỗi | Vòng lặp, thức dậy khi có việc mới |
| **Bộ lập lịch** | Tính lại kế hoạch quét; lên lịch công việc định kỳ | Mỗi 5 phút và khi cấu hình đổi |
| **Bộ nhận Telegram** | Thăm dò dài `getUpdates` để nhận `/start` và nút bấm | Luôn chạy khi có token |
| **Giám sát sức khoẻ** | Tổng hợp trạng thái extension, phiên Facebook, AI, Telegram; phát cảnh báo | Mỗi phút |

### 3.1 Hàng đợi công việc

Mọi việc không tức thời là một dòng trong bảng `jobs`, nên sống sót qua việc app tắt đột ngột.

| Loại công việc | Sinh ra khi | Thử lại |
|---|---|---|
| `evaluate_batch` | Có bài chờ AI và đã đủ lô hoặc hết thời gian gom | 3 lần, lùi 1, 5, 15 phút; sau đó bài chuyển sang `ai_failed` và chờ AI khoẻ lại |
| `notify_lead` | Tạo tin đạt ngưỡng báo | 5 lần, lùi theo `retry_after` của Telegram |
| `preview_run` | Người dùng mở xem thử | Không thử lại; báo lỗi lên giao diện |
| `suggest_fields` | Người dùng qua bước mô tả trong trình tạo radar | 1 lần |
| `compile_ruleset` | Đủ dữ liệu gán nhãn mới (P1) | 1 lần mỗi ngày |
| `audit_ruleset` | Hằng ngày với radar có bộ luật đang chạy (P1) | Không |
| `purge_expired` | Hằng ngày | Không |
| `backup_db` | Hằng tuần và trước migration | Không |

Công việc có khoá khử trùng (ví dụ `evaluate_batch:<radar_version_id>`) để không chạy song song hai việc cùng loại trên cùng đối tượng.

### 3.2 Bộ lập lịch quét

Đầu vào: nguồn đang được ít nhất một radar `active` dùng; số bài mới mỗi lần quét trong 24 giờ qua của từng nguồn; chính sách người dùng đặt. Đầu ra: `CrawlPlan` gửi cho extension. Thuật toán ở [Extension §6.2](02-extension.md#62-phân-bổ-ngân-sách).

Nguồn không còn radar nào dùng bị bỏ khỏi kế hoạch nhưng không bị xoá.

## 4. Lệnh cho giao diện

Giao diện gọi nhân qua lệnh Tauri (yêu cầu–trả lời) và nhận sự kiện đẩy. Tên lệnh theo dạng `nhóm_hành_động`.

| Nhóm | Lệnh |
|---|---|
| Radar | `radar_list`, `radar_get`, `radar_create_draft`, `radar_update`, `radar_suggest_fields`, `radar_set_status`, `radar_preview_start`, `radar_preview_get`, `radar_stats` |
| Mẫu | `template_list`, `template_get` |
| Nguồn | `source_list`, `source_follow`, `source_unfollow`, `source_set_priority`, `source_crawl_now` |
| Tin | `lead_list` (lọc, sắp xếp, phân trang), `lead_get`, `lead_set_status`, `lead_update_field`, `lead_feedback`, `lead_export` |
| Bài | `post_get`, `post_search`, `evaluation_list_rejected` |
| Danh bạ (P1) | `contact_list`, `contact_get`, `contact_block`, `contact_note` |
| Cài đặt | `settings_get`, `settings_set`, `ai_probe`, `ai_set_provider`, `telegram_set_token`, `telegram_test`, `chrome_connect`, `license_set` |
| Sức khoẻ | `health_get`, `crawl_run_list`, `ai_usage_get` |
| Dữ liệu | `data_backup`, `data_purge`, `data_delete_all` |

Sự kiện đẩy lên giao diện: `lead:new`, `lead:updated`, `preview:progress`, `health:changed`, `crawl:finished`, `job:failed`.

`lead_list` nhận bộ lọc trên trường động:

```jsonc
{
  "radar_id": "01JCF3...",
  "status": ["new", "viewed"],
  "since": 1794297600000,
  "filters": [
    {"field": "price", "op": "lte", "value": 15000000},
    {"field": "district", "op": "in", "value": ["Cầu Giấy", "Nam Từ Liêm"]}
  ],
  "search": "ban công",
  "sort": {"by": "created_at", "dir": "desc"},
  "limit": 50, "cursor": null
}
```

Toán tử theo kiểu trường: `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `between`, `contains`, `is_empty`.

## 5. Bản quyền và giới hạn gói

- Khoá bản quyền là chuỗi gồm nội dung JSON (`plan`, `issued_at`, `expires_at`, `licensee`) và chữ ký Ed25519. Khoá công khai nằm trong tệp chạy.
- Kiểm tra hoàn toàn tại máy, lúc khởi động và mỗi 24 giờ. Không có khoá hoặc khoá hết hạn: app chạy ở gói Cá nhân.
- Giới hạn được áp ở tầng `core` (không cho đưa radar thứ ba sang `active`, không cho theo dõi group thứ mười một), không chỉ ở giao diện.
- Xuống gói không xoá dữ liệu; radar vượt giới hạn chuyển sang `paused`.

Cơ chế này không chống được người quyết tâm bẻ khoá, và không nhằm mục đích đó.

## 6. Quan sát và hỗ trợ

- Nhật ký có cấu trúc (`tracing`) ra file. Nội dung bài và token **không** được ghi vào nhật ký; chỉ ghi ID.
- Trang Sức khoẻ đọc từ `crawl_runs`, `ai_calls`, `jobs`, `outbox`.
- Nút "Tạo gói chẩn đoán" gom nhật ký, phiên bản, cấu hình đã xoá bí mật và thống kê bảng vào một file nén để người dùng tự gửi khi cần hỗ trợ.

## 7. Hiệu năng mục tiêu

| Thao tác | Mục tiêu |
|---|---|
| Khởi động tới khi sẵn sàng nhận bài | < 2 giây |
| Ghi một lô 100 bài (chuẩn hoá, băm, lọc trùng) | < 200 ms |
| Lọc sơ bộ và chạy bộ luật cho một bài | < 1 ms |
| `lead_list` với 100.000 tin, lọc theo hai trường | < 150 ms |
| Bộ nhớ khi chạy nền | < 150 MB |

## 8. Kiểm thử

| Tầng | Cách |
|---|---|
| `rules` | Kiểm thử đơn vị dày cho từng bộ trích (tiền, SĐT, địa danh) trên bảng ví dụ tiếng Việt; kiểm thử thuộc tính cho chuẩn hoá và băm |
| `store` | Kiểm thử trên SQLite trong bộ nhớ; kiểm thử migration từ mọi phiên bản cũ |
| `ai-bridge` | Adapter giả đọc phản hồi ghi sẵn; kiểm thử thật với CLI chạy tay, không trong CI |
| `core` | Kiểm thử chuỗi xử lý đầu cuối với provider giả và bộ bài mẫu có nhãn |
| Giao thức | Kiểm thử vòng tròn mã hoá–giải mã; kiểm thử tương thích với các mẫu message TypeScript |
| Chất lượng AI | Bộ đánh giá riêng trên tập chuẩn ([Kế hoạch kiểm chứng](../delivery/02-validation-plan.md)), chạy tay khi đổi prompt hoặc đổi provider |
