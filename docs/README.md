# Tài liệu DealSonar

DealSonar là nền tảng "radar tin" chạy hoàn toàn trên máy người dùng: một extension Chrome đọc bài mới trong các group Facebook người dùng đã tham gia, và một ứng dụng desktop (Rust) hiểu bài bằng AI, trích thông tin theo trường người dùng tự định nghĩa, lưu thành bảng tin kiểu CRM và báo qua Telegram. Không có backend.

Bộ tài liệu này mô tả sản phẩm và đặc tả kỹ thuật đủ để bắt đầu xây. Trạng thái chung: **bản nháp v0.1 (2026-11-11), chưa có quyết định nào được chốt** ngoài các ràng buộc bạn đã nêu (2 ứng dụng, không backend, AI qua CLI).

## Thứ tự đọc

| # | Tài liệu | Trả lời câu hỏi |
|---|---|---|
| 1 | [product/01-prd.md](product/01-prd.md) | Làm cái gì, cho ai, phạm vi MVP, đo thành công thế nào |
| 2 | [product/02-radar-spec.md](product/02-radar-spec.md) | Một radar gồm những gì, kiểu trường, vòng đời, thư viện mẫu |
| 3 | [product/03-ux-flows.md](product/03-ux-flows.md) | Người dùng đi qua những màn hình nào |
| 4 | [architecture/01-overview.md](architecture/01-overview.md) | Các thành phần, luồng dữ liệu, cấu trúc repo |
| 5 | [architecture/02-decisions.md](architecture/02-decisions.md) | Vì sao chọn từng phương án kỹ thuật (ADR) |
| 6 | [specs/01-protocol.md](specs/01-protocol.md) | Extension và desktop nói chuyện với nhau thế nào |
| 7 | [specs/02-extension.md](specs/02-extension.md) | Extension thu bài ra sao, giới hạn tần suất |
| 8 | [specs/03-desktop.md](specs/03-desktop.md) | Module của app desktop, lệnh UI, vận hành |
| 9 | [specs/04-data-model.md](specs/04-data-model.md) | Lược đồ SQLite |
| 10 | [specs/05-pipeline-rules.md](specs/05-pipeline-rules.md) | Chuỗi xử lý bài, lọc trùng, bộ luật do AI sinh |
| 11 | [specs/06-ai-bridge.md](specs/06-ai-bridge.md) | Gọi Claude / Codex / Antigravity CLI, prompt, schema |
| 12 | [specs/07-notifications-export.md](specs/07-notifications-export.md) | Telegram, xuất file, webhook |
| 13 | [delivery/01-roadmap.md](delivery/01-roadmap.md) | Thứ tự xây, tiêu chí xong của từng mốc |
| 14 | [delivery/02-validation-plan.md](delivery/02-validation-plan.md) | Kiểm chứng 3 giả thuyết bằng cách nào |
| 15 | [delivery/03-risks-compliance.md](delivery/03-risks-compliance.md) | Rủi ro, nguyên tắc an toàn, pháp lý |

## Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **Radar** | Một định nghĩa "tin tốt với tôi là gì": nguồn + mô tả + trường cần trích + kênh báo |
| **Nguồn (source)** | Một group/page được theo dõi. MVP chỉ có group Facebook |
| **Bài (post)** | Bài viết thô thu từ nguồn, chưa qua đánh giá |
| **Đánh giá (evaluation)** | Kết quả chấm một bài theo một phiên bản radar |
| **Tin (lead)** | Bài đã khớp một radar, kèm các trường đã trích. Đây là đối tượng người dùng làm việc trong CRM |
| **Bộ luật (ruleset)** | Luật lọc/trích dạng khai báo do AI sinh từ dữ liệu đã gán nhãn, chạy không cần AI |
| **AI bridge** | Lớp gọi AI qua CLI có sẵn trên máy người dùng (`claude`, `codex`, `agy`) |
| **Native host** | Tiến trình nhỏ Chrome khởi chạy để nối extension với app desktop |
| **Người cùng nghề (peer)** | Người đăng bài cùng ngành với người dùng, giả làm khách (ví dụ môi giới đăng "cần thuê") |

## Quyết định còn mở

Đây là những chỗ tôi đã chọn một phương án mặc định để tài liệu nhất quán, nhưng bạn nên xem lại trước khi xây. Chi tiết nằm ở tài liệu được dẫn.

| Mã | Câu hỏi | Mặc định trong tài liệu | Xem |
|---|---|---|---|
| D-1 | Tính tiền thế nào khi AI chạy bằng tài khoản của chính người dùng? | Giá theo gói tính năng, khoá bản quyền ký số, kiểm tra offline | [PRD §9](product/01-prd.md#9-mô-hình-doanh-thu) |
| D-2 | Telegram: người dùng tự tạo bot hay dùng bot chung? | Tự tạo bot (bot chung cần một máy chủ chuyển tiếp) | [Thông báo §2](specs/07-notifications-export.md#2-telegram) |
| D-3 | Khung giao diện desktop | Tauri 2 + React/TypeScript | [ADR-003](architecture/02-decisions.md#adr-003-giao-diện-desktop-bằng-tauri-2) |
| D-4 | Thu bài bằng đọc phản hồi mạng hay đọc DOM | Đọc phản hồi mạng là chính, DOM dự phòng; chốt sau spike S1 | [Extension §4](specs/02-extension.md#4-chiến-lược-trích-bài) |
| D-5 | Phát hành extension qua Chrome Web Store hay cài thủ công | Chưa chốt; đây là rủi ro phân phối lớn nhất | [Rủi ro R-2](delivery/03-risks-compliance.md#2-sổ-rủi-ro) |
| D-6 | Giữ nội dung bài không khớp bao lâu | 30 ngày rồi xoá nội dung, giữ lại mã băm | [Dữ liệu §5](specs/04-data-model.md#5-lưu-giữ-và-dọn-dẹp) |
| D-7 | Có hỗ trợ gọi AI bằng API key ngay từ MVP không | Không; chỉ CLI. Thiết kế sẵn chỗ cắm | [AI bridge §2](specs/06-ai-bridge.md#2-giao-diện-provider) |
| D-8 | Có đọc bình luận không | Không trong MVP | [Extension §3](specs/02-extension.md#3-dữ-liệu-thu) |

## Đầu vào chưa có trong repo

Bản ý tưởng nhắc tới hai thứ tôi không tìm thấy ở đây, nên tài liệu chỉ tham chiếu chứ không chép lại nội dung:

- **"Nguyên tắc để sống lâu" của bản trước.** Tôi đã viết lại thành các nguyên tắc cụ thể ở [Rủi ro §1](delivery/03-risks-compliance.md#1-nguyên-tắc-an-toàn), dựa trên một câu tóm tắt trong bản ý tưởng. Nếu bản trước có điều khoản khác, hãy đối chiếu.
- **Bộ luật bất động sản tiếng Việt.** Tài liệu dùng nó ở hai chỗ: tầng lọc rẻ cho mẫu radar BĐS và mốc so sánh độ chính xác của AI. Khi có, đặt vào `docs/inputs/` để chuyển sang định dạng bộ luật ở [Pipeline §6](specs/05-pipeline-rules.md#6-bộ-luật-ruleset).

## Quy ước

- Tài liệu viết bằng tiếng Việt; tên định danh trong code, tên bảng, tên message giữ tiếng Anh.
- Mức ưu tiên: **P0** phải có trong MVP, **P1** nên có ngay sau MVP, **P2** để sau.
- Con số ngưỡng (tần suất, kích thước lô, điểm cắt) là giá trị khởi điểm để đo, không phải kết quả đã kiểm chứng.
