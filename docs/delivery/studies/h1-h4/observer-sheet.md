# Phiếu quan sát một người tham gia (H1 + H4)

Điền bằng bút hoặc bản sao của file này. Không ghi tên, số điện thoại hay nội dung bài của người khác. Sau phiên, chuyển sang một mục trong `sessions.json` (xem README §6).

| Mục | Giá trị |
|---|---|
| Mã người tham gia (`P01`…`P08`) | |
| Ngành (`bds` / `dich-vu-nha-cua` / `xe-cu`) | |
| Không làm nghề kỹ thuật (`technical: false`) | ☐ đã hỏi và xác nhận |
| Đồng ý ghi chép (`consent: true`) | ☐ |
| Mã commit bản dựng | |
| Người quan sát, ngày | |
| Nhu cầu thật họ mang tới (một câu, không thông tin cá nhân) | |

## A. Kết nối CLI AI (máy sạch)

| | |
|---|---|
| Giờ mở bước Kết nối | |
| Giờ dòng AI thành **Sẵn sàng** (hoặc bỏ cuộc / hết 30 phút) | |
| Tổng phút (`cli.minutes`) | |
| Thành công (`cli.succeeded`) | ☐ có ☐ không |
| Không cần trợ giúp (`cli.completed_unaided`) | ☐ có ☐ không |

| Giờ | Dừng / hỏi / mở trang ngoài ở đâu (`cli:cai-dat`, `cli:dang-ky`, `cli:dang-nhap`, `cli:thanh-toan`, `cli:khac`) | Họ nói gì | Làm gì để đi tiếp |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

## B. Tạo Radar từ nhu cầu thật (máy đã nối AI)

| | |
|---|---|
| Giờ bấm Tạo radar | |
| Giờ radar `active` (hoặc bỏ cuộc / hết 30 phút) | |
| Tổng phút (`radar.minutes`) | |
| Radar đã `active` (`radar.activated`) | ☐ có ☐ không |
| Không cần trợ giúp (`radar.completed_unaided`) | ☐ có ☐ không |
| Số từ trong mô tả họ viết (`description_words`) | |
| Số trường họ sửa sau khi AI đề xuất (`fields_edited`) | |
| Họ có hiểu màn xem thử không | |
| Bước họ dừng lâu nhất | |

### Giả định và câu hỏi của ứng dụng

| Ứng dụng đã hiển thị | Đúng ý họ? | Họ sửa thế nào | Bước (`describe`/`fields`/`sources`/`preview`) | Chặn bật? |
|---|---|---|---|---|
| Phía giao dịch: | ☐ đúng ☐ sai | | | |
| Đối tượng bị loại: | ☐ đúng ☐ sai | | | |
| Giả định 1: | ☐ đúng ☐ sai | | | |
| Giả định 2: | ☐ đúng ☐ sai | | | |
| Câu hỏi làm rõ (nếu có) và họ trả lời gì: | | | | |
| Nhóm Facebook ứng dụng chọn: | ☐ đúng ☐ sai | | | |

### Radar dùng được

Ở màn xem thử, với từng bài đang được chấm **khớp**, họ chọn "đúng, tôi muốn nhận" hoặc "không".

| Số bài khớp hiển thị (`shown`) | Số bài họ muốn nhận (`confirmed`) | Tỉ lệ | Dùng được (>= 70%) |
|---|---|---|---|
| | | | ☐ có ☐ không |

## C. Lỗi và chỗ cần trợ giúp

| `id` ngắn của lỗi | Bước | Mô tả | Chặn bật? | Cách xử lý / họ tự sửa thế nào |
|---|---|---|---|---|
| | | | ☐ | |
| | | | ☐ | |

## D. Đối chiếu số liệu của app (màn Kết nối, "Hành trình")

| Mốc | Giờ app ghi | Giờ đồng hồ | Lệch |
|---|---|---|---|
| Mở DealSonar lần đầu | | | |
| Tạo Radar đầu tiên | | | |
| Bật Radar đầu tiên | | | |

## E. Hậu phỏng vấn

- Chỗ nào khó nhất?
- Nếu không có người ngồi cạnh, bạn sẽ làm gì ở chỗ đó?
- Bạn có tin radar này sẽ báo đúng khách không? Vì sao?
