# PRD: DealSonar

Trạng thái: nháp v0.1 · 2026-11-11

## 1. Tóm tắt

DealSonar cho phép bất kỳ ai tạo "radar" trên các group Facebook họ đã tham gia: mô tả bằng lời thứ cần tìm, hệ thống tự đọc bài mới, trích thông tin theo đúng các trường họ muốn, và báo qua Telegram khi có tin khớp. Tin được lưu thành bảng có cấu trúc để theo dõi như một CRM nhỏ.

Sản phẩm gồm hai ứng dụng chạy trên máy người dùng và không có backend:

- **Extension Chrome** thu bài bằng phiên đăng nhập Facebook của chính người dùng.
- **App desktop (Rust)** giữ cơ sở dữ liệu, chạy chuỗi xử lý, gọi AI qua CLI người dùng đã cài (`claude`, `codex`, `agy`), và gửi thông báo.

## 2. Vấn đề

1. Cơ hội kinh doanh (khách cần mua, hàng cần bán, người cần thuê, việc cần người) xuất hiện dưới dạng bài viết tự do trong group và trôi rất nhanh. Người thấy trước thường là người chốt.
2. Mỗi ngành cần những trường khác nhau: môi giới cần giá và quận, thợ cần loại việc và địa chỉ, tuyển dụng cần vị trí và mức lương.
3. Công cụ hiện có chỉ khớp từ khoá hoặc xuất CSV thô. Không công cụ nào cho người dùng tự định nghĩa "tin tốt với tôi là gì".

## 3. Người dùng mục tiêu

| Chân dung | Việc cần làm | Trường hay cần | Nỗi đau hiện tại |
|---|---|---|---|
| **Môi giới BĐS** | Bắt khách cần thuê/mua theo khu vực và tầm giá trước đồng nghiệp | Nhu cầu, khu vực, giá, diện tích, SĐT | Lướt 20–50 group mỗi ngày; phần lớn bài là của môi giới khác |
| **Thợ / dịch vụ nhà cửa** | Nhận việc từ bài "ai biết thợ…" | Loại việc, địa chỉ, mức gấp | Không có thời gian lướt group khi đang làm |
| **Người buôn xe, đồ cũ** | Mua được hàng dưới giá thị trường | Dòng, đời, giá, tình trạng, khu vực | Tin tốt bị mua trong vài chục phút |
| **Người tuyển dụng** | Tìm ứng viên đang tìm việc | Vị trí, kinh nghiệm, khu vực, mức lương | Bài tìm việc lẫn trong bài tuyển |
| **Vận tải, ghép hàng** | Ghép chuyến, lấp xe trống | Tuyến, ngày, tải trọng, loại hàng | Tin hết hạn trong vài giờ |
| **Người bán hàng, order** | Bắt bài hỏi mua một loại sản phẩm | Sản phẩm, số lượng, ngân sách | Từ khoá đơn giản bắt nhầm bài bán |

Điểm chung: không rành kỹ thuật, dùng máy tính cá nhân, đã có Telegram hoặc sẵn sàng cài, đang tự lướt group bằng tay.

## 4. Mục tiêu và phi mục tiêu

**Mục tiêu MVP**

- G1. Người không rành kỹ thuật tạo được radar dùng được trong dưới 5 phút (không tính thời gian cài đặt lần đầu).
- G2. Tin khớp tới Telegram với trung vị dưới 10 phút kể từ lúc bài đăng, ở cấu hình mặc định.
- G3. Dưới 15% tin được báo bị người dùng đánh dấu "sai".
- G4. Sau khi bộ luật đã học, dưới 15% số bài phải gọi AI.

**Phi mục tiêu**

- Không tự bình luận, nhắn tin, hay tương tác thay người dùng trên Facebook.
- Không thu thập danh sách thành viên, không quét trang cá nhân, không bán dữ liệu.
- Không đọc group người dùng chưa tham gia.
- Không có tài khoản đám mây, đồng bộ nhiều máy, hay tính năng nhóm trong MVP.
- Không hỗ trợ nền tảng ngoài Facebook trong MVP (kiến trúc để sẵn chỗ mở rộng).

## 5. Ràng buộc sản phẩm phát sinh từ kiến trúc

Việc không có backend là lựa chọn của bạn và mang lại lợi thế về riêng tư lẫn chi phí vận hành. Nó cũng tạo ba giới hạn mà người dùng sẽ cảm nhận được, cần nói rõ trong onboarding:

1. **Máy phải bật.** Radar chỉ chạy khi máy tính mở, Chrome đang chạy và đã đăng nhập Facebook, app desktop đang chạy (ở khay hệ thống). Tắt máy là mất tin trong khoảng đó, trừ phần còn hiển thị khi quét lại.
2. **Người dùng tự có AI.** Cần ít nhất một trong các CLI `claude`, `codex`, `agy` đã cài và đăng nhập. Đây là rào cản lớn với người không rành kỹ thuật và mâu thuẫn trực tiếp với G1 nếu không có trình cài đặt dẫn từng bước.
3. **Người dùng tự tạo bot Telegram** (xem D-2). Thêm khoảng 2 phút vào lần cài đầu.

## 6. Phạm vi

### 6.1 MVP (P0)

| Nhóm | Tính năng |
|---|---|
| Thu tin | Theo dõi group đã tham gia, kể cả group kín; quét định kỳ tần suất thấp; phát hiện phiên đăng nhập hỏng |
| Radar | Tạo từ mẫu hoặc từ mô tả; AI đề xuất trường; sửa trường; chọn nguồn; xem thử trên bài thật; bật/tạm dừng |
| Hiểu tin | AI chấm khớp và trích trường theo radar; đa ngôn ngữ; tóm tắt một dòng |
| Lọc | Trùng giữa các group; rác; người cùng nghề; danh sách chặn tác giả/SĐT |
| Báo | Telegram tức thời, kèm trường đã trích và link bài gốc |
| Lưu | Hộp tin, bảng tin có cột theo trường, tìm kiếm, lọc, xuất CSV |
| Phản hồi | Nút "đúng / sai" kèm lý do; dùng làm ví dụ cho AI ở lần chấm sau |
| Vận hành | Trang sức khoẻ (kết nối extension, phiên Facebook, AI, Telegram); nhật ký quét |

### 6.2 Ngay sau MVP (P1)

- AI sinh bộ luật để lọc và trích không cần AI (xem [Pipeline §6](../specs/05-pipeline-rules.md#6-bộ-luật-ruleset)).
- CRM nhẹ: trạng thái tin, ghi chú, nhãn, nhắc việc, danh bạ gộp theo SĐT.
- Phản hồi "đúng / sai" ngay trên Telegram.
- Chế độ gửi gộp (digest) và giờ yên lặng.
- Xuất XLSX, webhook.
- Thư viện mẫu cho đủ 6 ngành.

### 6.3 Để sau (P2)

- Nhóm: chia tin cho thành viên, kho tin chung (cần máy chủ hoặc đồng bộ ngang hàng).
- Nền tảng khác (page Facebook, Zalo, Telegram, diễn đàn).
- Đọc bình luận, đọc ảnh (OCR).
- Mô hình AI chạy tại máy.

## 7. Câu chuyện người dùng và tiêu chí chấp nhận

**US-1. Tạo radar từ mô tả.** Là môi giới, tôi gõ "khách cần thuê căn hộ 2 phòng ngủ ở Cầu Giấy, dưới 15 triệu" và nhận được radar chạy được.

- Hệ thống đề xuất ít nhất các trường: nhu cầu, khu vực, giá, số phòng ngủ, SĐT.
- Tôi thêm, xoá, đổi tên, đổi kiểu trường được trước khi lưu.
- Toàn bộ quá trình từ lúc bấm "Tạo radar" tới lúc radar ở trạng thái đang chạy mất dưới 5 phút với người dùng lần đầu.

**US-2. Xem thử trước khi bật.** Trước khi bật, tôi thấy radar xử lý bài thật ra sao.

- Hiển thị tối thiểu 20 bài gần nhất từ các group đã chọn, chia thành "khớp" và "không khớp", kèm trường đã trích.
- Tôi đánh dấu được bài nào bị chấm sai; đánh dấu đó được dùng ngay cho lần chấm tiếp theo.
- Nếu chưa có bài nào trong kho cho group đã chọn, hệ thống quét thử và báo tiến độ.

**US-3. Nhận tin.** Khi có bài khớp, tôi nhận tin Telegram.

- Tin gồm: tên radar, tóm tắt một dòng, các trường đã trích, tên group, thời điểm đăng, link bài gốc.
- Một bài đăng lại ở nhiều group chỉ báo một lần, ghi chú "cũng xuất hiện ở N group".
- Bài của tác giả trong danh sách chặn không được báo.

**US-4. Sửa sai.** Khi tin sai, tôi báo lại trong một lần bấm.

- Lý do chọn sẵn: không liên quan, trích sai trường, người cùng nghề, trùng, rác.
- Với "người cùng nghề", có lựa chọn chặn luôn tác giả.

**US-5. Tìm lại.** Tôi mở bảng tin, lọc theo radar, khoảng giá, khu vực, thời gian, và xuất ra file.

- Cột của bảng là các trường của radar đang chọn.
- Tìm toàn văn trên nội dung bài và tóm tắt.

**US-6. Biết khi hệ thống ngừng chạy.** Nếu Facebook đăng xuất, extension mất kết nối, hoặc AI không gọi được, tôi được báo.

- App hiện trạng thái rõ ở khay hệ thống và trang sức khoẻ.
- Gửi một tin Telegram duy nhất cho mỗi sự cố, không lặp.

## 8. Chỉ số thành công

| Chỉ số | Định nghĩa | Ngưỡng MVP |
|---|---|---|
| Kích hoạt | % người cài xong có ít nhất 1 radar đang chạy trong phiên đầu | ≥ 60% |
| Thời gian tạo radar | Trung vị từ "Tạo radar" đến "đang chạy" | < 5 phút |
| Thời gian tới tin đầu tiên | Từ lúc bật radar đến tin khớp đầu tiên | < 24 giờ |
| Độ trễ báo tin | Trung vị từ giờ đăng đến giờ gửi Telegram | < 10 phút |
| Tỉ lệ tin sai | Tin bị đánh dấu sai / tin đã báo | < 15% |
| Tỉ lệ gọi AI | Bài phải gọi AI / bài đã thu (sau khi có bộ luật) | < 15% |
| Giữ chân | % người dùng còn radar chạy ở tuần thứ 4 | ≥ 40% |

Vì không có backend, các chỉ số này chỉ đo được qua (a) phỏng vấn và quan sát trong giai đoạn thử nghiệm, hoặc (b) tính năng gửi số liệu ẩn danh do người dùng chủ động bật. MVP dùng (a) và có trang "Thống kê" trong app để người dùng tự xem và gửi ảnh chụp.

## 9. Mô hình doanh thu

Bản ý tưởng đề xuất tính theo mức dùng "vì chi phí AI tỉ lệ với số bài xử lý". Với kiến trúc đã chọn (AI chạy qua CLI và tài khoản của chính người dùng), **chi phí AI không rơi vào sản phẩm mà rơi vào gói thuê bao AI của người dùng.** Lý do tính theo mức dùng vì thế không còn, và không có máy chủ nào để đếm mức dùng.

Đề xuất thay thế (D-1):

| Gói | Giới hạn | Tính năng |
|---|---|---|
| **Cá nhân** | 2 radar, 10 group | Toàn bộ MVP |
| **Chuyên nghiệp** | Không giới hạn radar, 50 group | Thêm webhook, xuất XLSX, bộ luật tự học, CRM nhẹ |
| **Nhóm** | Để sau | Chia tin, kho tin chung |

- Giới hạn được kiểm tra tại máy bằng khoá bản quyền ký số (Ed25519), không cần máy chủ lúc chạy. Việc bán và phát khoá cần một dịch vụ thanh toán bên ngoài hoặc quy trình thủ công; đó là phần duy nhất nằm ngoài máy người dùng.
- Giới hạn 50 group ở gói Chuyên nghiệp đến từ ngưỡng an toàn tài khoản Facebook ([Extension §6](../specs/02-extension.md#6-chính-sách-tần-suất)), không phải từ chi phí.
- Giả thuyết 3 ("chi phí AI thấp hơn rõ rệt so với giá họ chịu trả") đổi thành: **tổng chi phí người dùng phải trả (gói AI + DealSonar) có đáng không, và radar có ăn hết hạn mức gói AI của họ không.** Cách đo ở [Kế hoạch kiểm chứng](../delivery/02-validation-plan.md).

Mức giá cụ thể chưa đề xuất, chờ kết quả đo.

## 10. So với đối thủ

| | Scraper thô | Devi AI | DealSonar |
|---|---|---|---|
| Định nghĩa nhu cầu | Không có | Danh sách từ khoá | Mô tả bằng lời + trường tuỳ chọn |
| Đầu ra | CSV | Bài khớp từ khoá | Tin có cấu trúc theo trường của người dùng |
| Phục vụ ngành mới | Không | Có, nhưng nông | Có, không cần viết thêm code |
| Ngôn ngữ | Bất kỳ | Chủ yếu tiếng Anh | Bất kỳ |
| Dữ liệu nằm ở đâu | Máy người dùng | Máy chủ nhà cung cấp | Máy người dùng |
| Chi phí AI | Không có | Gộp trong giá | Người dùng tự có gói AI |

Hai dòng cuối là hệ quả của kiến trúc không backend: điểm mạnh về riêng tư, điểm yếu về độ dễ cài.

## 11. Chiến lược ra thị trường

Sản phẩm đa ngành nhưng quảng bá đi từng ngành một, mỗi ngành một mẫu radar và một trang giới thiệu riêng. Thứ tự đề xuất:

1. **Bất động sản** trước, vì đã có bộ luật tiếng Việt làm tầng lọc rẻ và mốc so sánh, và vì vấn đề "môi giới giả khách" là thứ từ khoá không giải được.
2. **Dịch vụ nhà cửa** và **xe cũ** tiếp theo, vì tin có giá trị cao và hết hạn nhanh.
3. Các ngành còn lại theo nhu cầu thực tế từ người dùng tự tạo radar.

## 12. Giả thuyết phải kiểm chứng

1. Người không rành kỹ thuật tạo được radar dùng được trong dưới 5 phút.
2. AI trích đúng trường trên bài viết tắt, sai chính tả, đa ngôn ngữ ở mức người dùng chấp nhận.
3. Tổng chi phí người dùng bỏ ra thấp hơn rõ rệt so với giá trị họ nhận, và radar không làm cạn hạn mức gói AI.
4. *(Thêm, do kiến trúc)* Người dùng mục tiêu cài được một CLI AI và đăng nhập thành công với trình hướng dẫn.
5. *(Thêm, do kiến trúc)* Quét ở tần suất mặc định không khiến tài khoản Facebook bị hạn chế trong 30 ngày.

Cách kiểm chứng từng giả thuyết: [delivery/02-validation-plan.md](../delivery/02-validation-plan.md).
