# Hoàn thiện năm luồng còn thiếu — 13/11/2026

## Đã triển khai

1. **Onboarding theo mục tiêu:** consent → nhu cầu và ví dụ kết quả → checklist Chrome/Facebook/AI → lựa chọn xem thử hoặc vào workspace. Telegram không còn là bước bắt buộc; kết nối thiếu có xác nhận giới hạn. Nhu cầu đã nhập có thể đưa vào radar để AI đề xuất trường.
2. **Restore backup:** liệt kê bản sao, nhập đường dẫn ngoài, xác nhận chính xác; kiểm tra integrity, phiên bản schema và khóa ngoại; tạo bản staging riêng. Áp dụng trước khi mở store/worker lần kế tiếp, tạo bản sao dữ liệu hiện tại để phục hồi. Có hủy staging. Không phát lại outbox cũ; kênh gửi cần kiểm tra lại. Xóa toàn bộ dữ liệu cũng hủy staging để không khôi phục dữ liệu đã xóa ngoài ý muốn.
3. **Phiên bản radar:** API trả toàn bộ lịch sử thay vì chỉ current/candidate. So sánh mô tả, trường, policy và kết quả trên phần giao bài viết của hai lượt preview. Nêu rõ số bài ngoài phần giao và biến động mô hình. Quay lại sao chép định nghĩa cũ thành phiên bản mới; giữ nguồn/kênh hiện tại; từ chối nếu phiên bản đã đổi kể từ lúc mở.
4. **Chẩn đoán xuyên suốt:** sáu chặng nguồn → thu thập → tiếp nhận/lọc → đánh giá → cơ hội → giao thông báo. Mỗi chặng có bằng chứng, phạm vi thời gian, hướng xử lý và liên kết đến màn tương ứng. Không suy diễn số bài chưa đồng bộ trong tiện ích khi Desktop chưa có dữ liệu đó.
5. **Undo:** bỏ theo dõi nguồn có thông báo radar bị ảnh hưởng; hoàn tác khôi phục follow/priority. Chặn tác giả/liên hệ và mục blocklist có hoàn tác; không xóa block đã có trước thao tác. Bỏ chặn có thể hoàn tác. Trung tâm Undo tồn tại qua chuyển màn trong phiên, có retry khi thất bại và được xóa khi xóa toàn bộ dữ liệu. Hoàn tác chặn từ feedback chỉ bỏ block, không xóa nhãn phản hồi đã ghi.

## Kiểm thử

- Cargo workspace: 98 test đạt; có rollback thật giữ nguồn/notify và chặn expected_version cũ.
- Restore SQLite: staging không làm đổi dữ liệu đang mở; backup hỏng bị từ chối; apply khôi phục đúng nội dung; bản before-restore mở lại được; outbox cũ chuyển dropped và channel chuyển error.
- UI: 17 test đạt, thêm xác nhận/hủy restore, rollback và stale version, Undo retry; onboarding test đi qua consent và hành trình mới.
- Extension: 55 test đạt; UI build/typecheck, Extension typecheck, Clippy all-targets deny warnings và 14 protocol fixtures đạt.
- Desktop command contract chạy riêng: restore → xem pending → cancel qua đúng command facade đạt.
- Browser mock: onboarding đủ ba bước; chuẩn bị/hủy restore; bỏ nguồn rồi Undo; chẩn đoán đủ sáu chặng; preview so sánh 5 bài chung và quay lại v1 thành v3; cửa sổ 1024px không tràn ngang ở chẩn đoán.
- Phát hiện và sửa thêm ID mock bị trùng do cắt mất chữ số cuối; không còn cảnh báo key lặp khi đổi phiên bản. Ảnh ở evidence/diagnosis-after.png và evidence/diagnosis-1024.png.

## Giới hạn và phần chưa kiểm chứng

- Browser dùng mock, chưa chứng minh Tauri đóng/mở thật trên Windows/macOS, quyền OS, Facebook, AI CLI và Telegram/webhook thật.
- Restore đã test SQLite và command facade thật, nhưng chưa thử trên bản sao database khách hàng. Bản sao không bao gồm secret trong keychain và draft lưu trong WebView localStorage.
- So sánh dùng phần giao post_id của hai lượt preview tuần tự, không hứa mẫu nguồn luôn bất biến hoặc mô hình quyết định giống nhau. UI không chạy hai preview chồng nhau.
- Chẩn đoán là tổng hợp bằng chứng theo từng chặng, không phải trace định danh từng bài xuyên toàn hệ thống. Số hàng đợi chưa đồng bộ vẫn phải xem ở Extension. Phễu 7 ngày và crawl log gần nhất được ghi rõ là phạm vi khác nhau.
- Undo lưu trong bộ nhớ phiên, không tồn tại sau khi thoát ứng dụng; không đảo ngược thông báo đã gửi hoặc dữ liệu đã xuất. Bỏ nguồn/chặn có thể bỏ lỡ dữ liệu trong khoảng thời gian tắt; hoàn tác không bảo đảm lấy lại mọi bài.
- Các hạng mục khác của báo cáo gốc như named saved views, restore keychain, screen-reader audit và nghiên cứu người dùng không được coi là đã hoàn thành bởi đợt này.

Các thay đổi có sẵn vẫn được giữ, chưa commit/push. Không khôi phục database người dùng hoặc gửi thông báo ra ngoài trong khi kiểm tra.
