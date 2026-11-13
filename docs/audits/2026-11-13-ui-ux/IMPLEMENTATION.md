# Triển khai và xác minh — 13/11/2026

## Đã triển khai
- Chuẩn hóa tiền Việt Nam, editor theo kiểu dữ liệu, kiểm tra sửa tay tại store và trước khi ghi feedback.
- Giữ giờ địa phương khi mở/lưu lịch; bổ sung worker phát nhắc cục bộ, dấu giao nhận bền vững và danh sách việc đến hạn. Nhắc chủ động yêu cầu ứng dụng chạy; danh sách quá hạn được giữ lại.
- Migration 0003 tách read_at khỏi CRM; command đánh dấu đọc dùng chung tại chi tiết tin.
- Extension báo trạng thái quét tự động/tạm dừng/lịch qua protocol tùy chọn; Desktop hiển thị trạng thái không xác định khi thiếu báo cáo.
- Nút kiểm tra AI gọi AI probe.
- Cài đặt chia nhóm và giữ phần đang sửa khi lưu nhóm khác; ghi chú và bản nhập radar lưu cục bộ.
- Inbox có tổng đúng, trang trước/tiếp; bài bị loại lấy đúng phạm vi nhiều radar.
- Preview có snapshot định nghĩa riêng, không cập nhật metadata/nguồn live trước publish.
- Wizard cho xác nhận điều kiện cứng, trả lời câu hỏi làm rõ, chọn nguồn chủ động, thông báo theo radar và readiness trước bật.
- Hôm nay có việc đến hạn; Cơ hội dùng view danh sách/bảng, bộ lọc cơ bản chung, chọn cột và đánh dấu liên hệ nhiều tin.
- Chi tiết đưa việc tiếp theo lên trước, timeline hoạt động; mở cơ hội từ lịch sử liên hệ.
- Layout thích ứng cửa sổ hẹp; điều hướng bằng hash, giữ workspace; modal có xử lý focus/Tab/Escape.
- Export backend duyệt tất cả trang kết quả; sửa lỗi đếm tổng với dynamic sort.

## Kiểm chứng
- Rust workspace: 95 test đạt trước khi thêm một unit test validator; unit test bổ sung được chạy riêng.
- UI: 14 test đạt, gồm regression tiền và giờ địa phương.
- Extension: 55 test đạt.
- UI build/typecheck, Extension typecheck, 14 protocol fixtures, cargo clippy toàn workspace/all-targets với deny warnings: đạt.
- Browser mock: nhập 15 triệu/tháng lưu đúng; cài đặt AI 1234 không mất khi lưu Thông báo; detail 1024px có clientWidth=scrollWidth=810; tạo radar đầy đủ đến kích hoạt; Hôm nay render được.
- Ảnh: evidence/today-after.png. Browser console có favicon 404 và ghi chú password ngoài form, không thấy lỗi JavaScript trong các thao tác đã chạy.

## Cập nhật tiếp theo

Năm hạng mục onboarding, restore, rollback/so sánh, chẩn đoán và Undo đã được triển khai tiếp; xem [PHASE2.md](PHASE2.md) để biết kết quả và giới hạn.

## Các khoảng trống của bản trước (đối chiếu PHASE2 để biết phần đã xử lý)
- Chưa làm lại hoàn toàn onboarding theo mục tiêu và chưa ẩn hết thuật ngữ kỹ thuật trong các màn cũ.
- Chưa có restore backup, rollback phiên bản một nút, so sánh định lượng hai preview cùng mẫu.
- Chưa có chẩn đoán đầy đủ từng chặng crawl → đồng bộ → lọc → lead → delivery; chưa có Undo đầy đủ cho chặn/bỏ nguồn và cảnh báo toàn bộ radar bị ảnh hưởng.
- Filter nâng cao chỉ có ở bảng, chưa đồng bộ hoàn toàn với danh sách; chưa có thư viện saved views có tên và xuất theo lựa chọn hàng.
- Chưa có UI chỉnh mọi thuộc tính notification (giờ yên lặng riêng), và cần hoàn thiện semantics chọn không có kênh ngoài.
- Chưa có giao dịch backend riêng để lưu toàn bộ working draft metadata; draft UI lưu tại máy, snapshot định nghĩa lưu DB.
- Worker reminder dùng claim bền vững trước dispatch: tránh lặp theo lịch nhưng chưa bảo đảm giao nhận OS khi tiến trình chết giữa claim và dispatch; chưa phải exactly-once delivery.
- Chưa có nghiên cứu với người dùng thật, screen reader audit hay đo conversion.

## Chưa kiểm chứng trên vận hành thật
- Tauri WebView Windows/macOS, OS notification khi tới hạn/ngủ máy, Facebook và nhiều Chrome profile, AI CLI/provider thật, Telegram/webhook thật.
- Migration trên bản sao DB khách hàng, dataset lớn và phục hồi sau crash trong mọi điểm publish/reminder.

Mã và thay đổi có sẵn trước triển khai được giữ. Bản sao trước sửa nằm tại /tmp/dealsonar-before-ux-implementation.tar.gz. Không commit/push trong công việc này.
