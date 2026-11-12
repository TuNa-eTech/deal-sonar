# Báo cáo Spike S1: Thu thập bài viết Facebook Group qua Extension MV3

- **Mã spike:** `S1` ([Lộ trình §2](../delivery/01-roadmap.md#2-mốc-0-spike-cỡ-m-làm-trước-mọi-thứ))
- **Đặc tả đối chiếu:** [02-extension.md](../specs/02-extension.md), [01-protocol.md](../specs/01-protocol.md), [03-risks-compliance.md](../delivery/03-risks-compliance.md)
- ** Thành phần kiểm chứng:** `apps/extension/` (`@dealsonar/extension`)
- **Trạng thái kỹ thuật:** **ĐẠT phần kiến trúc, đóng gói MV3 và kiểm thử mẫu (27/27 test)** · Sẵn sàng chạy danh mục kiểm chứng thực địa 3 ngày trên 5 group thật.

---

## 1. Câu hỏi kiểm chứng & Tiêu chí đạt

> *Extension MV3 có đọc được bài mới của Facebook Group trong tab nền (`active: false`), lấy đủ `post_id`, giờ đăng (`created_at`), nội dung (`text`), liên kết (`permalink`), tác giả và đính kèm trong ngân sách tần suất an toàn không?*

| Tiêu chí ([01-roadmap.md §2](../delivery/01-roadmap.md)) | Ngưỡng yêu cầu | Kết quả kiểm chứng trên bộ mẫu & bản dựng |
|---|---|---|
| Đóng gói MV3 cho `MAIN` world & `ISOLATED` world | Không chứa câu lệnh ES module `import`/`export` trong content script | **ĐẠT** (`dist/tap.js` 2,1 KB IIFE; `dist/content.js` 28,7 KB IIFE; 0 câu lệnh `import`) |
| Quyền tối thiểu trong `manifest.json` | Chỉ `https://www.facebook.com/groups/*`, không `cookies`/`webRequest`/`debugger`/`<all_urls>` | **ĐẠT** (kiểm tra tự động trong suite build) |
| Chuỗi 3 chiến lược trích xuất (`network` → `embedded` → `dom`) | Tự động rơi về tầng sau khi tầng trước rỗng; gắn nhãn `strategy` cho từng `RawPost` | **ĐẠT** (đối chiếu đầy đủ JSON GraphQL, `for (;;);`, NDJSON nhiều dòng, `<script type="application/json">`, `[role="article"]`) |
| Chặn cứng tần suất bất biến trong extension | Trần `90/giờ`, `900/ngày`, tối thiểu `4 phút/nguồn`, dừng ngay khi `session.state != "ok"` | **ĐẠT** (không thể bị ghi đè bởi `config.update` từ desktop) |
| Độ phủ thực địa 3 ngày trên 5 group thật | Thu được `≥ 95%` bài mới so với đếm tay, `100%` có `post_id` & `permalink` | **Chờ chạy theo quy trình mục §5** trên tài khoản thử riêng |

---

## 2. Kiến trúc trích xuất 3 tầng đã hiện thực

Toàn bộ logic trích bài nằm trong `apps/extension/src/content/` và điều phối qua cấu hình dữ liệu `ExtractorProfile` (`rev: 1` mặc định, cho phép desktop cập nhật nóng qua `config.update` khi Facebook đổi cấu trúc mà không cần phát hành lại extension):

```
Trang Facebook Group (https://www.facebook.com/groups/*)
 │
 ├─► [Tầng 1: network]  tap.ts (MAIN world, document_start)
 │     Sao chép thụ động response.clone() của fetch / XMLHttpRequest
 │     khớp "/api/graphql/" hoặc "/ajax/bz" ─► postMessage sang content.ts
 │     Hỗ trợ: JSON đơn, tiền tố chống hijacking "for (;;);", luồng NDJSON nhiều dòng.
 │
 ├─► [Tầng 2: embedded] extract.ts (ISOLATED world, document_idle)
 │     Quét các thẻ <script type="application/json"> nhúng sẵn trong lần tải HTML đầu
 │     ─► lấy ngay các bài đầu feed mà không cần cuộn trang.
 │
 └─► [Tầng 3: dom]      extract.ts (ISOLATED world, dự phòng cuối)
       Duyệt các phần tử [role="article"] cấp bài viết (loại trừ [role="article"] lồng nhau
       của bình luận qua isCommentArticle), đọc nội dung, tác giả, permalink; bỏ trống
       created_at khi DOM không có mốc giờ chính xác để desktop dùng captured_at làm cận trên.
```

### Các chốt an toàn chỉ-đọc (P1–P5)

1. **Tap mạng hoàn toàn thụ động (`tap-core.ts`, `tap.ts`):** Bọc `window.fetch` và `XMLHttpRequest` bằng `WeakMap`, chỉ gọi `response.clone().text()` trên các URL khớp mẫu; **không sửa header/body, không chặn request, không tự phát sinh bất kỳ request mạng nào**.
2. **Mở rộng văn bản an toàn (`drive.ts`):** Bộ điều khiển trang chỉ bấm nút `"Xem thêm"` / `"See more"` nằm bên trong thân bài viết để lấy trọn nội dung dài (SĐT thường nằm ở cuối bài); tuyệt đối không bấm nút Thích, Bình luận, Chia sẻ, Tham gia nhóm hay đường dẫn ngoài.
3. **Chống giả mạo trạng thái phiên (`collectNonArticleText` trong `drive.ts`):** Bộ phát hiện `logged_out`, `checkpoint`, `rate_limited` chỉ đọc URL chuyển hướng, biểu mẫu xác minh và văn bản nằm **ngoài** `[role="article"]`. Một bài đăng có chữ *"Vui lòng đăng nhập lại"* hoặc *"Tài khoản bị tạm khoá"* không thể đánh lừa extension tự dừng quét.
4. **Tận dụng thụ động tab người dùng đang mở (`scheduler.ts`):** Nếu người dùng đang mở sẵn group mục tiêu ở một tab, extension thu thụ động (`reason: "passive"`) trên tab đó thay vì mở tab nền mới. Mọi tab nền do extension mở (`active: false`) đều được bảo đảm đóng trong vòng **60 giây** qua khối `finally` kèm báo thức an toàn dự phòng.

---

## 3. Chặn cứng tần suất & Hàng đợi bền vững

Thực thi độc lập trong `apps/extension/src/background/scheduler.ts` và `queue.ts`:

| Cơ chế bảo vệ | Giá trị cố định / Quy tắc | File kiểm chứng |
|---|---|---|
| Trần tải trang mỗi giờ (`HARD_MAX_LOADS_PER_HOUR`) | **90 lần/giờ** (mặc định chính sách: 60) | `src/background/scheduler.ts` |
| Trần tải trang mỗi ngày (`HARD_MAX_LOADS_PER_DAY`) | **900 lần/ngày** (mặc định chính sách: 600) | `src/background/scheduler.ts` |
| Chu kỳ tối thiểu mỗi nguồn (`HARD_MIN_SOURCE_INTERVAL_S`) | **240 giây (4 phút)** | `src/background/scheduler.ts` |
| Khóa an toàn `checkpoint` | Dừng toàn bộ lịch quét; **không tự chạy lại** cho tới khi người dùng xác nhận trên desktop | `src/background/scheduler.ts` |
| Phục hồi sau `rate_limited` | Tạm dừng cứng **24 giờ**, sau đó nhân đôi chu kỳ mọi nguồn trong **7 ngày** kế tiếp | `src/background/scheduler.ts` |
| Phát hiện bộ trích hỏng (`status: "empty"`) | 3 lần liên tiếp `posts_seen = 0` trên 3 nguồn khác nhau khi phiên vẫn `ok` → cảnh báo cập nhật `ExtractorProfile` | `src/background/scheduler.ts` |
| Hàng đợi gửi IndexedDB (`queue.ts`) | Chia gói `≤ 100 bài` VÀ `≤ 512 KB` UTF-8; giữ nguyên `Envelope.id` khi gửi lại (`5s → 5m`); giới hạn `5.000 bài / 7 ngày`, ghi nhận `dropped_posts` nếu tràn | `src/background/queue.ts` |

---

## 4. Kết quả kiểm chứng tự động trong kho mã

Chạy lại kiểm chứng bất kỳ lúc nào từ thư mục gốc dự án:

```bash
pnpm --filter @dealsonar/extension typecheck
pnpm --filter @dealsonar/extension test
pnpm --filter @dealsonar/extension build
```

- **Kiểm tra kiểu tĩnh (`tsc --noEmit`):** 0 lỗi.
- **Bộ kiểm thử đơn vị & tích hợp (`vitest`):** **7/7 suite đạt (27/27 bài kiểm thử)** — bao gồm đối chiếu dây giao thức v2, tap `fetch`/`XHR` thụ động, trích xuất mẫu `network` (JSON + `for (;;);` + NDJSON) / `embedded` / `dom`, phát hiện danh sách group đã tham gia, bảo vệ chống giả mạo phiên, đồng hồ giả cho chặn cứng `90/giờ` · `900/ngày` · `4 phút`, hàng đợi `fake-indexeddb`, giao diện popup tiếng Việt chỉ dùng `textContent`, và kiểm tra file build IIFE.

---

## 5. Danh mục kiểm chứng thực địa 3 ngày trên Facebook thật (Checklist vận hành)

Vì CI tuyệt đối không tự động hoá đăng nhập Facebook thật ([02-extension.md §10](../specs/02-extension.md#10-kiểm-thử)), bước nghiệm thu thực địa 72 giờ trước khi mở rộng Mốc 1–2 được thực hiện thủ công bằng **tài khoản phụ thử nghiệm** theo bảng kiểm sau:

### 5.1 Cấu hình 5 group thử nghiệm

| Ký hiệu | Loại group | Mức độ sôi động | Chu kỳ đặt | Mục đích kiểm tra |
|---|---|---|---|---|
| `G1` | Công khai (BĐS Hà Nội) | Cao (> 50 bài/giờ) | 5 phút (ưu tiên) | Kiểm tra `network` NDJSON khi cuộn 3 bước và dừng sớm theo `seen_post_ids` |
| `G2` | Kín / Riêng tư (Cư dân chung cư) | Trung bình (10–20 bài/giờ) | 15 phút | Kiểm tra quyền truy cập phiên người dùng trên group kín và bài đăng ẩn danh (`is_anonymous`) |
| `G3` | Công khai (Mua bán ô tô cũ) | Cao, nhiều ảnh đính kèm | 15 phút | Kiểm tra trích `attachments`, mở rộng nút `"Xem thêm"` trên bài dài > 1.500 ký tự |
| `G4` | Kín (Dịch vụ sửa chữa địa phương) | Thấp (< 10 bài/ngày) | 30–60 phút | Kiểm tra tầng `embedded` lấy trọn bài mới ở lần tải đầu không cần cuộn |
| `G5` | Công khai (Expat Housing EN/VI) | Trung bình | 15 phút | Kiểm tra bài song ngữ, ký tự Unicode/emoji và nhãn giờ chuẩn hoá Unix ms |

### 5.2 Các bước đo & nghiệm thu

- [ ] **Bước 1 — Cài đặt bản dựng:** Chạy `./scripts/install-native-host-dev.sh <EXTENSION_ID>`, nạp thư mục `apps/extension/dist` qua `chrome://extensions` (chế độ Developer Mode), xác nhận đèn popup báo *"Đã nối Desktop"*.
- [ ] **Bước 2 — Đối chiếu độ phủ bài mới (3 khung giờ x 3 ngày):** Mỗi ngày chọn ngẫu nhiên 2 khung giờ 30 phút trên `G1`–`G5`, đếm tay số bài mới xuất hiện trên trình duyệt và đối chiếu với bảng `posts` / `crawl_runs`:
  - Yêu cầu đạt: **tỉ lệ thu được ≥ 95%** số bài đếm tay; **100% bài thu được có `post_id` và `permalink` hợp lệ**.
- [ ] **Bước 3 — Theo dõi phân bố chiến lược trích:** Kiểm tra cột `strategy` trong `crawl_runs`:
  - Kỳ vọng: `network` + `embedded` chiếm `> 90%`; nếu `dom` vượt `20%` hoặc xuất hiện `empty`, lưu mẫu phản hồi đã xoá thông tin cá nhân vào fixtures để cập nhật đường dẫn trường trong `DEFAULT_NETWORK_CONFIG`.
- [ ] **Bước 4 — Kiểm toán ngân sách tần suất & an toàn tài khoản ([Giả thuyết H5](../delivery/02-validation-plan.md#6-giả-thuyết-5-an-toàn-tài-khoản)):**
  - Tổng `page_loads` mỗi giờ `≤ 60` (mặc định) và không bao giờ vượt trần cứng `90/giờ`, `900/ngày`.
  - Số lần gặp `checkpoint` hoặc `rate_limited` trong 72 giờ = **0**.
- [ ] **Bước 5 — Kiểm tra phục hồi mất kết nối:** Tắt ứng dụng desktop trong 20 phút khi extension vẫn chạy một lượt quét, sau đó bật lại desktop; xác nhận hàng đợi IndexedDB tự xả hết `posts.push` không mất và không nhân đôi bài.
