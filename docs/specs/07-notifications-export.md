# Thông báo và xuất dữ liệu

Trạng thái: nháp v0.1 · 2026-11-11

## 1. Kênh

| Kênh | Mức | Ghi chú |
|---|---|---|
| Telegram | P0 | Kênh báo chính |
| Thông báo hệ điều hành | P0 | Luôn bật; là kênh duy nhất khi chưa cấu hình Telegram |
| Xuất CSV | P0 | Từ Bảng tin |
| Xuất XLSX | P1 | |
| Webhook | P1 | Gói Chuyên nghiệp |

Mọi kênh gửi đi đều qua bảng `outbox` ([Dữ liệu §2.6](04-data-model.md#26-vận-hành)): ghi trước, gửi sau, thử lại được.

## 2. Telegram

### 2.1 Thiết lập

Người dùng tự tạo bot ([ADR-007](../architecture/02-decisions.md#adr-007-telegram-bằng-bot-do-người-dùng-tự-tạo)). Trình hướng dẫn trong app:

1. Mở BotFather (app hiện nút mở liên kết), gửi `/newbot`, đặt tên.
2. Dán token vào app. App gọi `getMe` để kiểm tra và lấy tên bot.
3. App hiện liên kết tới bot; người dùng bấm **Start**.
4. App đang thăm dò `getUpdates` nhận được `/start`, lấy `chat_id`, tạo kênh, gửi tin chào.

Để nhận tin vào một nhóm Telegram: thêm bot vào nhóm rồi gửi `/start@tên_bot`; app tạo thêm một kênh với `chat_id` của nhóm.

Token lưu trong kho khoá hệ điều hành. `channels.config` chỉ chứa `chat_id`, tên bot và loại chat.

### 2.2 Định dạng tin

Dùng `sendMessage` với `parse_mode: "HTML"`, tắt xem trước liên kết. Mọi giá trị chèn vào phải được thoát ký tự `<`, `>`, `&`.

```
🎯 <b>Khách thuê căn hộ Cầu Giấy</b>

Cần thuê chung cư 2PN khu Cầu Giấy, 12–15 triệu, vào ở ngay

• Giá: 12–15 triệu/tháng
• Khu vực: Cầu Giấy, Hà Nội
• Phòng ngủ: 2
• SĐT: 0912 345 678

👥 Hội thuê nhà Cầu Giấy · Nguyễn Văn A · 5 phút trước
🔁 Cũng xuất hiện ở 2 group khác

[ Mở bài viết ]  [ ✅ Đúng ]  [ ❌ Sai ]
```

- Dòng đầu: tên radar. Dòng hai: `summary`.
- Danh sách trường: chỉ các trường có `show_in_alert` và có giá trị, theo thứ tự `order`, hiển thị bằng nhãn của trường và giá trị đã định dạng theo kiểu.
- Số điện thoại hiển thị ở dạng quốc nội để Telegram tự nhận thành liên kết gọi.
- Dòng nguồn: tên group, tên tác giả, thời gian tương đối tính từ `created_at` (hoặc "vừa thấy" nếu thiếu giờ đăng).
- "Cũng xuất hiện ở" chỉ hiện khi cụm trùng có hơn một nguồn.
- Nút: "Mở bài viết" là nút liên kết tới `permalink`. "Đúng" và "Sai" là nút gọi lại (P1).
- Tin dài quá 4.096 ký tự: cắt `summary` và giá trị trường kiểu `text`; không bao giờ cắt liên kết.

### 2.3 Nhận phản hồi từ Telegram (P1)

Bộ nhận Telegram thăm dò dài `getUpdates` (thời gian chờ 50 giây, lưu `offset` trong `settings`).

| Sự kiện | Xử lý |
|---|---|
| `/start` | Tạo kênh nếu chưa có |
| Bấm "Đúng" | Ghi `feedback(label = correct, origin = telegram)`; sửa tin để nút đổi thành "✅ Đã ghi nhận" |
| Bấm "Sai" | Sửa tin để hiện hàng nút lý do: Không liên quan · Cùng nghề · Trùng · Rác; bấm một lý do thì ghi `feedback` tương ứng |
| `/pause`, `/resume` | Tạm dừng hoặc bật lại mọi thông báo |
| `/status` | Trả lời trạng thái: số radar đang chạy, tin hôm nay, sức khoẻ |

Dữ liệu trong nút gọi lại có dạng `fb:<lead_id>:<label>` (dưới 64 byte, giới hạn của Telegram). Chỉ chấp nhận gọi lại từ `chat_id` đã đăng ký.

Khi máy tắt, lượt bấm nằm chờ ở Telegram (tối đa 24 giờ) và được xử lý khi app chạy lại.

### 2.4 Giới hạn và lỗi

- Tự giới hạn 1 tin mỗi giây cho mỗi chat và 20 tin mỗi phút cho chat nhóm.
- Lỗi 429: chờ đúng `retry_after` rồi gửi lại.
- Lỗi 401 hoặc 403 (token bị thu hồi, bot bị chặn): đặt `channels.state = error`, dừng gửi tới kênh đó, báo trong app và qua thông báo hệ điều hành.
- Lỗi mạng: thử lại 5 lần, lùi dần 10 giây → 10 phút. Tin chờ quá 2 giờ bị đặt `dropped`; tin vẫn nằm trong Hộp tin.

## 3. Quy tắc gửi

Một tin được xếp gửi khi thoả mãn tất cả:

1. Radar ở trạng thái `active` và có ít nhất một kênh.
2. `score ≥ notify.min_score`.
3. Bài là đầu cụm trùng, hoặc là bài đăng lại sau 72 giờ.
4. Bài được chấm trong vòng 6 giờ kể từ khi thu (bài chấm trễ chỉ vào Hộp tin).
5. Không trong giờ yên lặng của radar (P1); nếu trong giờ yên lặng, tin dồn vào bản gửi gộp đầu tiên sau đó.
6. Không phải kết quả xem thử hay chấm bù.

**Chống dồn dập.** Một radar tạo hơn 30 tin trong một giờ thì tự chuyển sang gửi gộp, và người dùng nhận một tin hệ thống đề nghị xem lại mô tả.

**Gửi gộp (P1).** Mỗi 30 phút (chỉnh được), một tin liệt kê tối đa 10 tin mới nhất dạng một dòng mỗi tin, kèm "và N tin khác" nếu còn.

**Tin hệ thống.** Gửi tối đa một tin cho mỗi sự cố, và một tin khi sự cố hết:

| Sự cố | Nội dung |
|---|---|
| Phiên Facebook có vấn đề | "DealSonar đã dừng quét vì Facebook yêu cầu đăng nhập lại / xác minh" |
| Extension mất kết nối trên 30 phút trong giờ hoạt động | "Không thấy Chrome. Radar đang tạm ngừng" |
| AI không gọi được trên 30 phút | "Không gọi được AI. N bài đang chờ" |
| Bộ trích không đọc được bài | "Facebook có thay đổi, cần cập nhật DealSonar" |

Tin "mất kết nối" không gửi khi máy vừa thức dậy sau ngủ, và có độ trễ 30 phút để tránh báo động khi người dùng chỉ đóng Chrome một lúc.

## 4. Thông báo hệ điều hành

Dùng plugin thông báo của Tauri. Nội dung: tên radar và `summary`. Bấm vào thì mở chi tiết tin trong app. Tự tắt khi Telegram đã cấu hình và người dùng không bật riêng.

## 5. Xuất file

Từ Bảng tin, xuất đúng tập đang lọc.

| Cột cố định | Nguồn |
|---|---|
| Thời điểm đăng | `posts.created_at`, giờ địa phương, ISO 8601 |
| Radar | `radars.name` |
| Trạng thái | `leads.status` |
| Điểm | `leads.score` |
| Tóm tắt | `leads.summary` |
| Group | `sources.name` |
| Tác giả | `authors.name` |
| Liên kết | `posts.permalink` |
| Nội dung | `posts.text` (tuỳ chọn, mặc định tắt) |

Sau đó là một cột cho mỗi trường của radar. Kiểu phức hợp được trải ra: `money` thành `giá_từ`, `giá_đến`, `giá_đơn_vị`; `location` thành `tỉnh`, `quận`, `phường`; `range` thành `_từ`, `_đến`.

- **CSV:** UTF-8 có BOM (để Excel mở đúng tiếng Việt), dấu phẩy, xuống dòng CRLF. Ô bắt đầu bằng `=`, `+`, `-`, `@` được thêm dấu nháy đơn phía trước để chống chèn công thức, vì nội dung do người lạ viết.
- **XLSX (P1):** kiểu ô đúng (số, ngày), cột liên kết bấm được, hàng tiêu đề cố định.

## 6. Webhook (P1)

Kênh kiểu `webhook` gửi `POST` JSON tới địa chỉ người dùng cấu hình, cho mỗi tin mới.

```jsonc
{
  "event": "lead.created",
  "id": "01JCG...",                       // ID sự kiện, dùng để khử trùng
  "created_at": "2026-11-11T08:15:05+07:00",
  "radar": {"id": "01JCF3...", "name": "Khách thuê căn hộ Cầu Giấy"},
  "lead": {
    "id": "01JCG...",
    "score": 0.91,
    "summary": "Cần thuê chung cư 2PN khu Cầu Giấy, 12–15 triệu, vào ở ngay",
    "fields": { "price": {"value": {"min": 12000000, "max": 15000000, "currency": "VND", "period": "month"}, "raw": "tầm 12-15tr"} },
    "post": {
      "permalink": "https://www.facebook.com/groups/123456789/posts/987654321/",
      "created_at": "2026-11-11T08:10:00+07:00",
      "source": "Hội thuê nhà Cầu Giấy",
      "author": "Nguyễn Văn A",
      "text": "…"
    }
  }
}
```

- Tiêu đề `X-DealSonar-Signature: sha256=<HMAC của thân bằng bí mật của kênh>`.
- Chỉ chấp nhận địa chỉ `https://`, trừ `http://localhost` cho mục đích tích hợp tại máy.
- Thành công là mã 2xx trong 10 giây. Thử lại 5 lần, lùi dần.
- Người dùng chịu trách nhiệm về nơi dữ liệu đi tới; app hiện cảnh báo một lần khi tạo webhook rằng nội dung bài và thông tin liên hệ sẽ rời máy.
