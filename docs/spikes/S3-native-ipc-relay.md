# Báo cáo Spike S3: Cầu nối Native Messaging & IPC hai chiều chịu tải

- **Mã spike:** `S3` ([Lộ trình §2](../delivery/01-roadmap.md#2-mốc-0-spike-cỡ-m-làm-trước-mọi-thứ))
- **Đặc tả đối chiếu:** [01-protocol.md](../specs/01-protocol.md), [ADR-002](../architecture/02-decisions.md)
- **Thành phần kiểm chứng:** `crates/protocol/`, `crates/native-host/`, `scripts/install-native-host-dev.{sh,ps1}`
- **Trạng thái kỹ thuật:** **ĐẠT (1.200+ khung tin hai chiều đồng thời, tự động nối lại sau sự cố, 14/14 mẫu dây giao thức v2)**

---

## 1. Câu hỏi kiểm chứng & Tiêu chí đạt

> *Chuỗi truyền dẫn `Chrome Extension (MV3) ↔ Native Messaging (stdio) ↔ dealsonar-native-host ↔ Local IPC ↔ Desktop App` có cài đặt tự động được khai báo host, truyền liên tục ≥ 1.000 message hai chiều không mất mát, và tự phục hồi khi tắt/mở lại tiến trình desktop không?*

| Tiêu chí ([01-roadmap.md §2 S3](../delivery/01-roadmap.md)) | Ngưỡng yêu cầu | Kết quả thực nghiệm |
|---|---|---|
| Chuyển tiếp liên tục hai chiều | `≥ 1.000` message liên tục cả hai chiều không hỏng khung, không rớt tin | **ĐẠT — 1.200 khung chiều đi + 1.200 khung chiều về đồng thời (tổng 2.400 khung)** + kiểm thử nhị phân tiến trình con **1.000 vòng `Ping` → `Ack`** |
| Desktop chưa chạy hoặc sập giữa chừng | Không treo extension; trả lỗi có cấu trúc `desktop_unavailable` (`retryable: true`) và tự nối lại | **ĐẠT** (`reply_to` được bảo toàn chính xác; tự nối lại ngay khi máy chủ IPC mở lại) |
| Đóng trình duyệt / đóng cổng Native Messaging | Khi `stdin` nhận `EOF`, đóng kết nối IPC gọn gàng, xả hết `stdout` và thoát mã `0` | **ĐẠT** (kiểm chứng trên tiến trình thực `CARGO_BIN_EXE_dealsonar-native-host`) |
| Tự ghi file khai báo Native Host đa nền tảng | Hỗ trợ macOS, Linux và Windows | **ĐẠT** (`NativeHostManifest` trong `crates/protocol` + script cài đặt `.sh` / `.ps1`) |
| Khớp tuyệt đối định dạng dây Protocol v2 giữa Rust & TypeScript | Cùng phong bì, cùng giới hạn kích thước khung, cùng bộ mẫu JSON | **ĐẠT** (`14/14` mẫu trong `node scripts/verify-protocol-fixtures.mjs`) |

**Quyết định kiến trúc từ S3:** Giữ nguyên kiến trúc **Native Messaging + Local IPC** ([ADR-002](../architecture/02-decisions.md)), không cần chuyển sang phương án dự phòng WebSocket cục bộ.

---

## 2. Kiến trúc Cầu nối Không trạng thái & Bảo mật IPC cục bộ

`dealsonar-native-host` được giữ hoàn toàn **không trạng thái nghiệp vụ**: nó không mở SQLite, không giữ cấu hình radar, mà chỉ chuyển tiếp nguyên văn các khung nhị phân `4-byte little-endian length + UTF-8 JSON` giữa `stdio` của Chrome và đường ống IPC của ứng dụng desktop.

```
┌──────────────────┐   stdio (4B LE + JSON)   ┌───────────────────────┐   Unix Socket (0700) /   ┌───────────────────┐
│ Chrome Extension │ ───────────────────────► │ dealsonar-native-host │ ───────────────────────► │ DealSonar Desktop │
│  (Service Worker)│ ◄─────────────────────── │   (Stateless Relay)   │ ◄─────────────────────── │   (IPC Server)    │
└──────────────────┘  Ext→Host ≤64MB          └───────────────────────┘     Named Pipe (Win)     └───────────────────┘
                      Host→Ext ≤1MB                     │
                                                        └─ Khi IPC đứt: trả ngay Error { code: "desktop_unavailable",
                                                           retryable: true, reply_to } + hẹn giờ nối lại nền (mặc định 5s)
```

### Địa chỉ điểm cuối & Quyền truy cập (`crates/protocol/src/ipc.rs`)

| Hệ điều hành | Đường dẫn IPC mặc định | Cơ chế phân quyền & dọn dẹp |
|---|---|---|
| **macOS** | `~/Library/Application Support/DealSonar/ipc.sock` | Thư mục cha được tạo/siết quyền **`0700`** (chỉ chủ sở hữu tài khoản đọc/ghi); tự phát hiện và xoá socket mồ côi từ lần tắt bất thường trước khi `bind` |
| **Linux** | `$XDG_RUNTIME_DIR/dealsonar/ipc.sock` (dự phòng `~/.local/share/dealsonar/ipc.sock`) | Thư mục cha **`0700`**; tự dọn tệp socket cũ nếu không còn tiến trình lắng nghe |
| **Windows** | `\\.\pipe\dealsonar-<username>` | Named Pipe bất đồng bộ theo tên người dùng hiện tại (`tokio::net::windows::named_pipe`) |
| **Ghi đè kiểm thử** | Biến môi trường `DEALSONAR_IPC_PATH` | Cho phép chạy nhiều kiểm thử tích hợp song song hoàn toàn cô lập |

### Giới hạn kích thước khung (`crates/protocol/src/framing.rs`)

- **Chiều `Extension → Native Host / Desktop` (`MAX_EXT_TO_HOST_BYTES`):** `64 MiB` (extension vẫn chủ động cắt gói `posts.push` ở mức `≤ 100 bài` và `≤ 512 KB`).
- **Chiều `Desktop / Native Host → Extension` (`MAX_HOST_TO_EXT_BYTES`):** `1 MiB` (tuân thủ giới hạn cứng 1 MB của Chrome Native Messaging ở chiều trả về; ngay cả khi nhận khung đầu vào có `id` dị thường, `build_desktop_unavailable_bytes` vẫn đảm bảo gói lỗi trả ra luôn `≤ 1 MiB`).

---

## 3. Kết quả Kiểm thử Chịu tải & Phục hồi Sự cố

Tất cả kịch bản của S3 được tự động hoá trong `crates/native-host/tests/s3_relay_integration.rs` và `crates/protocol/`:

### 3.1 Kịch bản vòng đời 5 pha (`s3_relay_full_lifecycle_1200_bidirectional_frames_and_recovery`)

1. **Pha 1 — Khởi động khi Desktop đang tắt:** Extension gửi `hello` (`v = 2`) và một khung phi-JSON hỏng; relay lập tức phản hồi phong bì lỗi `code = "desktop_unavailable"`, `retryable = true`, giữ đúng `reply_to = hello.id` (hoặc `reply_to = null` cho khung hỏng) mà không làm sập tiến trình.
2. **Pha 2 — Tự động kết nối nền:** Máy chủ IPC Desktop khởi động và `bind` vào `ipc.sock`; vòng lặp nền của relay tự bắt kết nối thành công mà không cần Chrome khởi động lại `native-host`.
3. **Pha 3 — Chịu tải 1.200 khung đồng thời hai chiều:**
   - Luồng ghi từ Desktop bắn liên tục **1.200 gói `crawl.request`** (`req_0` .. `req_1199`) xuống Extension.
   - Cùng lúc đó, luồng ghi từ Extension bắn liên tục **1.200 gói `crawl.report`** (`run_0` .. `run_1199`) lên Desktop.
   - **Kết quả:** Cả **2.400 khung** đến đích nguyên vẹn 100%, đúng thứ tự từng chiều, không nghẽn đường ống (`deadlock`), hoàn tất trong vài chục mili-giây.
4. **Pha 4 — Desktop sập giữa phiên rồi bật lại:** Máy chủ IPC 1 đóng đột ngột → gói `ping` kế tiếp từ Extension nhận ngay `desktop_unavailable` (`retryable: true`) → Máy chủ IPC 2 khởi động lại trên cùng đường dẫn socket → relay tự nối lại và chuyển tiếp thành công cặp `ping` / `pong` mới.
5. **Pha 5 — Đóng trình duyệt (`stdin` EOF):** Luồng vào đóng → relay đóng chiều ghi IPC gọn gàng, xả hết kênh ra và thoát với `Ok(())`.

### 3.2 Kiểm thử tiến trình nhị phân thực (`subprocess_binary_relays_1000_frames_and_exits_zero_on_stdin_eof`)

- Khởi chạy tệp thực thi biên dịch thật `dealsonar-native-host` qua `tokio::process::Command` với `stdin`/`stdout` hệ điều hành.
- Đẩy **1.000 khung `Ping`** liên tiếp, đối chiếu từng gói `Ack` trả về qua `reply_to`, đóng `stdin`, xác nhận tiến trình thoát mã `0` tức thì.

### 3.3 Kiểm thử đăng ký Native Host Manifest

- `NativeHostManifest::for_chrome` sinh đúng cấu trúc JSON chuẩn của Chrome (`name: "com.dealsonar.host"`, `type: "stdio"`, `path` tuyệt đối, `allowed_origins: ["chrome-extension://<32_char_id>/"]`) và định vị đúng thư mục khai báo trên macOS (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), Linux (`~/.config/google-chrome/NativeMessagingHosts/`) và khóa Registry Windows (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host`).

---

## 4. Lệnh chạy lại kiểm chứng S3

```bash
cargo test -p dealsonar-protocol
cargo test -p dealsonar-native-host
node scripts/verify-protocol-fixtures.mjs
```
