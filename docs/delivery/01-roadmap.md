# Lộ trình

Trạng thái: nháp v0.1 · 2026-11-11

Lộ trình sắp theo thứ tự giảm rủi ro: thứ gì có thể khiến cả sản phẩm không khả thi thì kiểm tra trước, bằng cách rẻ nhất. Tôi không đưa ước lượng thời gian theo lịch vì chưa biết số người làm và thời lượng mỗi tuần; mỗi mốc có cỡ tương đối (S, M, L) và tiêu chí xong.

## 1. Điểm xuất phát

Repo đã có: extension MV3 với popup gửi `ping`; native host trả `pong`; app desktop in một dòng; crate giao thức v1. Chưa có: IPC tới desktop, giao diện, cơ sở dữ liệu, thu bài, AI, thông báo.

## 2. Mốc 0: Spike (cỡ M, làm trước mọi thứ)

Bốn câu hỏi quyết định sản phẩm có làm được theo kiến trúc đã chọn không. Mỗi spike là mã thử nghiệm bỏ đi, kết quả ghi vào `docs/spikes/`.

| Mã | Câu hỏi | Cách làm | Đạt khi | Nếu không đạt |
|---|---|---|---|---|
| **S1** | Extension có đọc được bài mới của group trong tab không hiển thị, đủ ID, giờ đăng, nội dung, liên kết không? | Thử ba chiến lược ở [Extension §4](../specs/02-extension.md#4-chiến-lược-trích-bài) trên 5 group thật (công khai và kín, sôi động và vắng) trong 3 ngày | Lấy được ≥ 95% bài mới so với đếm tay, có `post_id` và liên kết cho mọi bài, trong ngân sách tần suất mặc định | Thử cửa sổ riêng thu nhỏ; nếu vẫn không, chỉ thu thụ động khi người dùng tự mở group, và định vị lại sản phẩm |
| **S2** | Ba CLI có trả JSON đúng schema ổn định, với mọi công cụ bị tắt không? Mất bao lâu, bao nhiêu token mỗi bài? | Viết adapter tối thiểu cho từng CLI; chạy `judge_extract` trên 100 bài với lô 5, 10, 20, 40 | ≥ 99% lời gọi trả đầu ra hợp lệ sau một lần thử lại; có số đo thời lượng và token theo kích thước lô; xác nhận được việc tắt công cụ | CLI nào không tắt được công cụ thì loại; nếu không CLI nào đạt, chuyển sang gọi API trực tiếp (D-7) |
| **S3** | Chuỗi extension → native host → desktop có cài và chạy được trên macOS và Windows không? | Thêm IPC vào native host; app desktop tối thiểu nhận message; tự ghi file khai báo | Gửi được 1.000 message liên tục cả hai chiều; sống sót qua việc tắt mở từng tiến trình | Chuyển sang WebSocket cục bộ (phương án B ở ADR-002) |
| **S4** | AI chấm và trích bài tiếng Việt thật tốt tới mức nào so với bộ luật BĐS có sẵn? | Gán nhãn tay 200 bài BĐS; chạy cả bộ luật và AI; so | Có bảng số liệu; AI đạt ngưỡng ở [Kế hoạch kiểm chứng §3](02-validation-plan.md#3-giả-thuyết-2-ai-trích-đúng-trường) hoặc biết rõ nó hụt ở đâu | Điều chỉnh prompt và schema; thu hẹp các kiểu trường hỗ trợ |

S1 và S3 làm song song được. S2 và S4 dùng chung adapter.

**Cổng quyết định sau mốc 0:** nếu S1 không đạt và không có phương án thay thế, dừng và xem lại ý tưởng. Đây là rủi ro lớn nhất của cả dự án.

## 3. Mốc 1: Bộ xương chạy được (cỡ M)

Một bài đi hết đường từ Facebook tới màn hình, chưa có AI.

- Giao thức v2: phong bì, `hello`, `config.update`, `posts.push`, `ack`, `crawl.report`.
- Native host chuyển tiếp qua IPC; desktop có máy chủ IPC.
- Vỏ Tauri, khay hệ thống, đơn thể, cài file khai báo native host.
- SQLite và migration cho `sources`, `posts`, `authors`, `crawl_runs`, `settings`.
- Extension: lập lịch, một chiến lược trích đã chọn từ S1, hàng đợi gửi, chặn cứng.
- Giao diện: danh sách nguồn, danh sách bài thô, trang Sức khoẻ tối thiểu.

**Xong khi:** theo dõi 3 group trong 24 giờ, bài hiện trong app, không vượt ngân sách tần suất, tắt mở desktop và Chrome không làm mất hay nhân đôi bài.

## 4. Mốc 2: Radar đầu tiên (cỡ L)

Giá trị cốt lõi: mô tả → trích → báo.

- `crates/ai-bridge` với ít nhất hai adapter đã qua S2; `probe`; kiểm tra đầu ra.
- Radar, phiên bản radar, trường; `suggest_fields`.
- Chuỗi xử lý T0, T1, T3 (bước 1–3), T5, T6, T7; hàng đợi công việc.
- `judge_extract` gom lô.
- Telegram: thiết lập, gửi tin, tin hệ thống.
- Giao diện: trình tạo radar bốn bước (chưa có xem thử), Hộp tin, chi tiết tin, cài đặt AI và Telegram.
- Bộ trích dựng sẵn tối thiểu: `vn_money`, `vn_phone`, `gazetteer`.

**Xong khi:** tạo radar BĐS từ mô tả, nhận tin Telegram cho bài khớp thật trong vòng 15 phút kể từ khi bài đăng.

## 5. Mốc 3: Chất lượng (cỡ L)

Biến bản chạy được thành bản dùng được hằng ngày.

- Xem thử trên bài thật.
- Phản hồi đúng/sai trong app; ví dụ từ phản hồi đi vào prompt.
- T2 lọc trùng (trùng hẳn và gần trùng), "cũng xuất hiện ở".
- Tín hiệu người cùng nghề ở T6; danh sách chặn.
- Bảng tin với cột động, lọc, tìm toàn văn, xuất CSV.
- Phễu đo từng tầng; trang Sức khoẻ đầy đủ; mức dùng AI và trần tự đặt.
- Trình cài đặt lần đầu năm bước.
- Dọn dữ liệu hết hạn.
- Mẫu radar BĐS (2 mẫu) kèm bộ luật khởi đầu chuyển từ bộ luật có sẵn.

**Xong khi:** đạt G1–G3 trong [PRD §4](../product/01-prd.md#4-mục-tiêu-và-phi-mục-tiêu) với 5 người dùng thử. **Đây là MVP.**

## 6. Mốc 4: Bộ luật tự học và chi phí (cỡ L)

- DSL đầy đủ và bộ máy trong `crates/rules`; các bộ trích dựng sẵn còn lại.
- `compile_rules`; tập kiểm định giữ riêng; cổng candidate → shadow → active; kiểm tra định kỳ.
- Hiển thị và sửa bộ luật trên giao diện.
- Phản hồi đúng/sai trên Telegram; gửi gộp; giờ yên lặng.
- Thư viện mẫu cho 5 ngành còn lại.

**Xong khi:** trên radar BĐS chạy 2 tuần, tỉ lệ bài lên AI dưới 15% (G4) mà tỉ lệ tin sai không tăng.

## 7. Mốc 5: Thương mại hoá (cỡ M)

- CRM nhẹ: trạng thái, ghi chú, nhãn, nhắc việc, danh bạ.
- Xuất XLSX, webhook.
- Bản quyền và giới hạn gói.
- Đóng gói và ký ứng dụng cho macOS và Windows; tự cập nhật.
- Phát hành extension (theo kết quả D-5).
- Trang giới thiệu cho ngành đầu tiên.

## 8. Để sau

Tính năng nhóm; nền tảng khác; đọc bình luận và ảnh; mô hình tại máy; trình duyệt nhân Chromium khác; gửi số liệu ẩn danh theo lựa chọn.

## 9. Phụ thuộc giữa các mốc

```
S1 ─┐
S3 ─┼─► Mốc 1 ─► Mốc 2 ─► Mốc 3 (MVP) ─► Mốc 4 ─► Mốc 5
S2 ─┤              ▲
S4 ─┘──────────────┘
```

Song song với mốc 2 và 3, không phụ thuộc mã: gán nhãn tập chuẩn cho ba ngành; viết hướng dẫn cài CLI AI và tạo bot Telegram có hình; tuyển người dùng thử.

## 10. Việc cần bạn quyết định trước khi bắt đầu

| Trước mốc | Quyết định |
|---|---|
| 0 | Dùng tài khoản Facebook nào để thử S1 (nên là tài khoản phụ, chấp nhận rủi ro bị hạn chế) |
| 1 | D-3: khung giao diện |
| 2 | D-2: Telegram tự tạo bot hay bot chung; D-7: có cần provider API trực tiếp không |
| 3 | D-6: thời gian giữ bài; D-8: có đọc bình luận không |
| 5 | D-1: mô hình giá; D-5: cách phát hành extension |
