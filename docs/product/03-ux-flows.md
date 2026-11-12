# Luồng người dùng và màn hình

Trạng thái: nháp v0.1 · 2026-11-11

Tài liệu mô tả hành vi, không mô tả giao diện chi tiết. Mọi màn hình chính nằm trong app desktop; extension chỉ có popup trạng thái.

## 1. Cài đặt lần đầu

Mục tiêu: đưa người dùng từ "vừa tải về" tới "radar đầu tiên đang chạy" mà không cần đọc tài liệu. Trình hướng dẫn là một danh sách kiểm tra năm bước, mỗi bước tự phát hiện trạng thái và tự đánh dấu khi xong.

| Bước | App làm gì | Người dùng làm gì | Khi kẹt |
|---|---|---|---|
| 1. Kết nối Chrome | Tự ghi file khai báo native host; mở trang cài extension | Bấm cài extension | Nút "Kiểm tra lại"; hướng dẫn cho từng hệ điều hành |
| 2. Facebook | Hỏi extension trạng thái phiên đăng nhập | Đăng nhập Facebook trong Chrome nếu chưa | Link mở facebook.com |
| 3. AI | Dò `claude`, `codex`, `agy` trên máy, chạy lệnh thử | Chọn một CLI; nếu chưa có, làm theo hướng dẫn cài và đăng nhập | Hiện đúng lệnh cần chạy và nút "Thử lại" |
| 4. Telegram | Chờ tin `/start` gửi tới bot | Tạo bot qua BotFather, dán token, bấm Start trong bot | Nút "Gửi tin thử" |
| 5. Radar đầu tiên | Mở trình tạo radar | Xem §2 | |

Bước 3 và 4 là hai chỗ dễ mất người dùng nhất. Cả hai cho phép **bỏ qua**: thiếu AI thì radar chỉ chạy được bằng bộ luật có sẵn của mẫu (hiện chỉ có BĐS); thiếu Telegram thì tin chỉ hiện trong app và thông báo của hệ điều hành.

App nói rõ ràng buộc vận hành ngay ở cuối trình hướng dẫn: "Radar chỉ chạy khi máy bật, Chrome mở và DealSonar đang chạy ở khay hệ thống", kèm công tắc "Mở cùng máy tính" (mặc định bật).

## 2. Tạo radar

Đây là luồng phải đạt dưới 5 phút. Bốn bước trên một trang, có thể quay lại.

```
[1 Mô tả] ──► [2 Trường] ──► [3 Nguồn] ──► [4 Xem thử và bật]
```

**Bước 1. Mô tả.** Chọn một mẫu (lưới thẻ theo ngành) hoặc "Bắt đầu từ trang trắng". Với mẫu, điền các ô trống trong câu mô tả. Với trang trắng, gõ mô tả tự do; bên dưới có ba ví dụ tốt để bắt chước. Thêm một ô ngắn "Bạn làm nghề gì?" để hệ thống nhận ra người cùng nghề.

**Bước 2. Trường.** AI đề xuất danh sách trường từ mô tả (2–10 giây, có chỉ báo tiến độ). Người dùng thấy bảng: tên, kiểu, bắt buộc, hiện trong tin báo. Thao tác: sửa tên, đổi kiểu, xoá, thêm, kéo đổi thứ tự. Nếu AI thấy mô tả mơ hồ, nó trả về tối đa hai câu hỏi làm rõ, hiện dưới dạng gợi ý có thể bỏ qua.

**Bước 3. Nguồn.** Danh sách group người dùng đã tham gia (extension phát hiện), có ô tìm. Mỗi group hiện tên, số thành viên nếu biết, và số bài đã có trong kho. Hiện bộ đếm so với giới hạn gói.

**Bước 4. Xem thử và bật.** Theo [Đặc tả radar §5](02-radar-spec.md#5-xem-thử). Nút chính "Bật radar"; nút phụ "Lưu nháp".

Nếu danh sách group còn trống (extension chưa kịp thấy), bước 3 hiện nút "Mở trang group của tôi trên Facebook" để extension đọc danh sách khi người dùng mở trang đó.

## 3. Màn hình chính

Thanh bên trái cố định. Thứ tự phản ánh tần suất dùng.

| Màn hình | Nội dung | Thao tác chính |
|---|---|---|
| **Hộp tin** | Tin mới nhất của mọi radar, dạng danh sách; bộ lọc theo radar và trạng thái | Mở tin, đúng/sai, đổi trạng thái, mở bài gốc |
| **Bảng tin** | Chọn một radar, hiện bảng với cột là các trường của radar đó | Lọc theo trường, sắp xếp, tìm toàn văn, xuất file |
| **Radar** | Danh sách radar với trạng thái, số tin 24 giờ, tỉ lệ sai | Tạo, sửa, tạm dừng, lưu trữ, xem thử lại |
| **Nguồn** | Danh sách group, lần quét cuối, số bài mỗi ngày, lỗi | Thêm, bỏ, quét ngay, đặt ưu tiên |
| **Danh bạ** (P1) | Người đăng và SĐT đã gặp, gộp theo SĐT | Xem lịch sử tin, chặn, ghi chú |
| **Sức khoẻ** | Bốn đèn: extension, Facebook, AI, Telegram; nhật ký quét; mức dùng AI | Chạy lại kiểm tra, xem lỗi |
| **Cài đặt** | AI, Telegram, tần suất quét, giờ hoạt động, dữ liệu, bản quyền | |

### 3.1 Chi tiết một tin

- Đầu trang: tên radar, điểm khớp, thời điểm đăng, tên group, tên tác giả.
- Khối trường đã trích: mỗi trường một dòng; bấm vào giá trị để sửa tay (đánh dấu `source: user`).
- Nội dung bài gốc với các đoạn `raw` được tô sáng.
- "Cũng xuất hiện ở": các group khác có bài trùng.
- Thanh thao tác: Mở trên Facebook · Đúng · Sai ▾ · Chặn tác giả · Trạng thái ▾ · Ghi chú.
- Lịch sử: bài được chấm bằng AI hay bộ luật, phiên bản radar nào.

### 3.2 Trạng thái tin (CRM)

```
new ──► viewed ──► contacted ──► negotiating ──► won
  │                    │               │
  └────────────────────┴───────────────┴──────► lost / ignored
```

MVP có `new`, `viewed`, `ignored`. Các trạng thái còn lại, ghi chú, nhãn và nhắc việc thuộc P1.

## 4. Popup của extension

Một màn hình duy nhất, không có cấu hình:

- Đèn kết nối với app desktop; nếu mất, nút "Mở DealSonar".
- Trạng thái phiên Facebook.
- Lần quét gần nhất và lần kế tiếp; số group đang theo dõi.
- Công tắc "Tạm dừng quét" (1 giờ / tới khi bật lại).
- Khi đang ở một trang group: nút "Theo dõi group này" hoặc nhãn "Đang theo dõi".

## 5. Trạng thái rỗng và lỗi

| Tình huống | App hiện gì |
|---|---|
| Chưa có radar | Lưới mẫu theo ngành ngay trên Hộp tin |
| Radar đã bật, chưa có tin | "Đã đọc N bài, chưa bài nào khớp" kèm link xem các bài bị loại gần nhất |
| Extension mất kết nối | Dải cảnh báo đỏ trên mọi màn hình; hướng dẫn mở Chrome |
| Facebook đăng xuất hoặc bị chặn tạm | Dừng quét toàn bộ; giải thích; nút "Tiếp tục" chỉ bật sau khi phiên ổn |
| AI không gọi được | Bài xếp hàng chờ; hiện số bài đang chờ; tự xử lý khi AI trở lại |
| Hết hạn mức gói AI | Như trên, kèm thời điểm dự kiến hạn mức hồi phục nếu CLI có báo |
| Radar khớp quá nhiều (trên 30 tin/giờ) | Tự chuyển radar sang gửi gộp, báo người dùng xem lại mô tả |

## 6. Kiểm tra dưới 5 phút

Phép đo cho giả thuyết 1 tính từ lúc bấm "Tạo radar" tới lúc radar ở trạng thái `active`. Ngân sách thời gian mong đợi:

| Bước | Ngân sách |
|---|---|
| Chọn mẫu hoặc viết mô tả | 60 giây |
| Chờ AI đề xuất trường và xem lại | 45 giây |
| Chọn nguồn | 45 giây |
| Xem thử (chờ chấm 20–50 bài) và đánh dấu vài bài | 120 giây |
| Bật | 10 giây |

Bước xem thử là rủi ro lớn nhất về thời gian: chấm 50 bài qua CLI có thể mất 30–90 giây. Giao diện phải hiện kết quả dần theo lô thay vì chờ xong hết.
