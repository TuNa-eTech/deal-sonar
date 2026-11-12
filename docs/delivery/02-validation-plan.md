# Kế hoạch kiểm chứng giả thuyết

Trạng thái: nháp v0.1 · 2026-11-11

Bản ý tưởng nêu ba giả thuyết. Kiến trúc đã chọn thêm hai giả thuyết nữa ([PRD §12](../product/01-prd.md#12-giả-thuyết-phải-kiểm-chứng)). Tài liệu này nói cách kiểm chứng từng cái, ngưỡng đạt, và làm gì khi không đạt.

Mọi ngưỡng dưới đây là đề xuất khởi điểm. Chúng cần được bạn duyệt **trước** khi đo, để kết quả không bị diễn giải theo hướng thuận lợi.

## 1. Tổng quan

| # | Giả thuyết | Kiểm chứng ở | Phương pháp |
|---|---|---|---|
| H1 | Người không rành kỹ thuật tạo được radar dùng được trong dưới 5 phút | Mốc 3 | Thử nghiệm khả dụng có quan sát |
| H2 | AI trích đúng trường trên bài viết tắt, sai chính tả, đa ngôn ngữ ở mức chấp nhận được | Mốc 0 (S4), lặp lại ở mốc 2 và 3 | Đo trên tập chuẩn có nhãn |
| H3 | Chi phí người dùng bỏ ra thấp hơn rõ rệt so với giá trị nhận được; radar không làm cạn hạn mức gói AI | Mốc 0 (S2), mốc 3, mốc 4 | Đo token và hạn mức; phỏng vấn sẵn lòng trả |
| H4 | Người dùng mục tiêu cài được một CLI AI với trình hướng dẫn | Mốc 3 | Thử nghiệm khả dụng có quan sát |
| H5 | Quét ở tần suất mặc định không khiến tài khoản bị hạn chế trong 30 ngày | Mốc 1 trở đi | Theo dõi tài khoản thử |

## 2. Giả thuyết 1: tạo radar dưới 5 phút

**Người tham gia.** 8 người, không ai làm nghề kỹ thuật, ít nhất 2 người mỗi ngành trong ba ngành đầu (BĐS, dịch vụ nhà cửa, xe cũ). Họ đang tự lướt group để tìm khách.

**Điều kiện.** App đã cài sẵn, AI và Telegram đã nối (để tách H1 khỏi H4). Trong kho đã có bài từ các group liên quan tới ngành của họ.

**Nhiệm vụ.** "Hãy làm cho ứng dụng báo cho bạn khi có [thứ bạn thường tìm]." Không hướng dẫn thêm. Người quan sát không trợ giúp trừ khi người tham gia bỏ cuộc.

**Đo.**

| Phép đo | Ngưỡng đạt |
|---|---|
| Thời gian từ bấm "Tạo radar" tới radar `active` | Trung vị < 5 phút; ít nhất 6/8 người dưới 7 phút |
| Hoàn thành không cần trợ giúp | ≥ 6/8 |
| Radar "dùng được": trong màn xem thử, ≥ 70% bài được chấm khớp là bài người tham gia xác nhận muốn nhận | ≥ 6/8 |
| Số trường người tham gia sửa sau khi AI đề xuất | Ghi nhận, không đặt ngưỡng |

**Ghi lại định tính:** bước nào khiến họ dừng lại lâu nhất; họ viết mô tả thế nào (độ dài, từ ngữ); họ có hiểu màn xem thử không.

**Nếu không đạt.**
- Kẹt ở viết mô tả: đẩy mạnh mẫu, thêm ví dụ, hoặc chuyển sang hỏi đáp từng câu.
- Kẹt ở trường: ẩn bước trường mặc định, chỉ hiện khi người dùng muốn sửa.
- Kẹt ở xem thử vì chờ: giảm số bài xem thử, hiện dần.

## 3. Giả thuyết 2: AI trích đúng trường

### 3.1 Tập chuẩn

| Ngành | Số bài | Thành phần |
|---|---|---|
| Bất động sản | 300 | ~30% khớp thật, ~30% người cùng nghề giả khách, ~40% không liên quan |
| Dịch vụ nhà cửa | 200 | ~30% khớp, còn lại quảng cáo dịch vụ và bài khác |
| Xe cũ | 200 | ~30% khớp, còn lại tin mua, tin salon, bài khác |

- Lấy từ group thật mà người gán nhãn là thành viên. Xoá tên và số điện thoại thật, thay bằng giá trị giả cùng định dạng, trước khi lưu vào repo.
- Cố ý lấy đủ các dạng khó: viết tắt ("2pn", "nt cb", "tc 3 tỷ"), không dấu, sai chính tả, lẫn tiếng Anh, emoji dày, bài rất ngắn, bài rất dài, bài nhiều tin trong một.
- Mỗi bài có nhãn: khớp hay không cho một radar cố định của ngành; vai trò tác giả; giá trị đúng của từng trường.
- Hai người gán nhãn độc lập trên 20% số bài để đo độ đồng thuận; bất đồng được giải quyết và ghi lại quy ước.
- Thêm 50 bài không phải tiếng Việt (tiếng Anh và một ngôn ngữ nữa) để kiểm tra phần "đa ngôn ngữ".

Tập chuẩn nằm ở `docs/eval/golden/` dạng JSONL, kèm định nghĩa radar dùng để chấm.

### 3.2 Phép đo và ngưỡng

| Phép đo | Định nghĩa | Ngưỡng đạt |
|---|---|---|
| Độ chính xác khớp | Trong các bài AI chấm khớp, bao nhiêu % là khớp thật | ≥ 85% |
| Độ phủ khớp | Trong các bài khớp thật, bao nhiêu % AI tìm ra | ≥ 90% |
| Nhận diện người cùng nghề | Độ chính xác và độ phủ trên nhãn `peer` | Cả hai ≥ 75% |
| Độ đúng trường bắt buộc | Giá trị chuẩn hoá trùng nhãn | ≥ 90% mỗi trường |
| Độ đúng trường tuỳ chọn | Như trên | ≥ 80% mỗi trường |
| Tỉ lệ bịa | Giá trị có `raw` không nằm trong bài | ≤ 1% |
| Ổn định | Chạy 3 lần, tỉ lệ bài đổi quyết định khớp | ≤ 3% |

Độ phủ được đặt cao hơn độ chính xác vì bỏ sót một khách thật tốn hơn nhận một tin thừa (tin thừa bấm "sai" là xong).

Ngưỡng nhận diện người cùng nghề thấp hơn vì đây là bài toán khó cả với người; phần còn lại dựa vào tín hiệu hành vi ở [Pipeline §8](../specs/05-pipeline-rules.md#8-t6-lọc-sau) và danh sách chặn.

### 3.3 So sánh

Chạy cùng tập chuẩn trên:

1. Bộ luật BĐS có sẵn (mốc so sánh, chỉ cho ngành BĐS).
2. Từng CLI ở tầng `Fast`.
3. Từng CLI ở tầng `Smart` (để biết còn bao nhiêu dư địa).
4. Kích thước lô 5, 10, 20, 40.
5. Có và không có 8 ví dụ từ phản hồi.

Kết quả là một bảng. Từ bảng đó quyết định: provider và tầng mặc định, kích thước lô, và kiểu trường nào chưa đủ tin cậy để đưa vào MVP.

**Nếu không đạt.**
- Trường cụ thể hụt: chuyển việc chuẩn hoá sang bộ trích dựng sẵn (AI chỉ chỉ ra `raw`); hoặc bỏ kiểu trường đó khỏi MVP.
- Độ chính xác khớp hụt: thêm bước hỏi làm rõ khi tạo radar; bắt buộc xem thử và gán nhãn tối thiểu 5 bài trước khi bật.
- Tầng `Fast` hụt nhưng `Smart` đạt: dùng `Smart` cho bài tầng `Fast` chấm điểm 0,4–0,7 (chấm hai lượt).

### 3.4 Sự chấp nhận của người dùng

Con số trên tập chuẩn chưa nói người dùng có chấp nhận không. Ở mốc 3, với 5 người dùng thử trong 2 tuần: tỉ lệ tin đã báo bị đánh dấu sai phải dưới 15% (G3), và hỏi trực tiếp: "Bạn có tin vào các trường đã trích đủ để không cần mở bài gốc không?"

## 4. Giả thuyết 3: chi phí

Với AI chạy bằng gói của người dùng, câu hỏi tách làm ba.

### 4.1 Mỗi bài tốn bao nhiêu

Đo ở S2 và ghi vào `ai_calls` từ mốc 2:

- Token vào và ra mỗi bài, theo kích thước lô và số trường.
- Thời lượng mỗi lời gọi.
- Quy đổi ra chi phí tương đương nếu trả theo giá API công bố của từng nhà cung cấp tại thời điểm đo. Con số này dùng để so sánh và để định giá nếu sau này thêm provider API.

### 4.2 Radar có làm cạn hạn mức gói AI không

Chạy thật trong 7 ngày trên ba cấu hình: 5 group vắng; 10 group trung bình; 10 group sôi động.

| Phép đo | Ngưỡng đạt |
|---|---|
| Số bài lên AI mỗi ngày, trước khi có bộ luật | Ghi nhận |
| Số bài lên AI mỗi ngày, sau khi bộ luật `active` | ≤ 15% số bài thu được (G4) |
| Số lần chạm giới hạn hạn mức của gói AI rẻ nhất có CLI | 0 lần trong 7 ngày ở cấu hình trung bình |
| Người dùng thử có nhận thấy gói AI của họ bị ảnh hưởng khi dùng cho việc khác không | Không ai báo |

**Nếu không đạt:** đẩy việc sinh bộ luật lên sớm hơn (ít mẫu hơn, cổng lỏng hơn ở chế độ chỉ lọc sơ bộ); hạ trần bài mỗi ngày mặc định; cân nhắc provider mô hình tại máy cho tầng `Fast`.

### 4.3 Người dùng có sẵn lòng trả không

Sau 2 tuần dùng thử ở mốc 3, phỏng vấn từng người:

- Trong 2 tuần, bạn chốt được bao nhiêu việc từ tin DealSonar báo? Mỗi việc đáng bao nhiêu?
- Bạn đang trả bao nhiêu cho gói AI? Bạn có sẵn gói đó trước khi dùng DealSonar không?
- Thang giá: ở mức nào bạn thấy quá rẻ để tin, rẻ, bắt đầu đắt, quá đắt?

**Đạt khi:** ít nhất 3/5 người nêu mức "bắt đầu đắt" cao hơn đáng kể so với tổng chi phí hằng tháng họ phải bỏ ra (gói AI nếu phải mua riêng cho việc này, cộng giá DealSonar dự kiến).

Điểm cần chú ý: với người chưa có gói AI, giá gói AI có thể cao hơn nhiều so với giá phần mềm họ quen trả. Nếu phần lớn người dùng thử rơi vào nhóm này, đó là tín hiệu mạnh để xem lại ràng buộc "chỉ CLI" (D-7).

## 5. Giả thuyết 4: cài được CLI AI

Cùng 8 người ở H1, làm trước H1, trên máy sạch.

**Nhiệm vụ.** Đi qua bước 3 của trình cài đặt lần đầu (chọn và nối AI) chỉ với hướng dẫn trong app.

| Phép đo | Ngưỡng đạt |
|---|---|
| Hoàn thành không cần trợ giúp | ≥ 5/8 |
| Thời gian | Trung vị < 10 phút |

Tôi dự đoán đây là giả thuyết dễ trượt nhất: cài một công cụ dòng lệnh, đăng ký tài khoản và trả tiền gói thuê bao là ba rào cản liên tiếp với người không rành kỹ thuật. **Nếu không đạt**, các hướng xử lý theo thứ tự ưu tiên: app tự tải và cài CLI giúp người dùng; thêm provider API trực tiếp với khoá do người dùng dán vào; thêm một dịch vụ AI do sản phẩm cung cấp (từ bỏ một phần ràng buộc không backend).

## 6. Giả thuyết 5: an toàn tài khoản

- Từ mốc 1, chạy liên tục trên ít nhất 3 tài khoản thử (tuổi tài khoản và mức hoạt động khác nhau), mỗi tài khoản theo dõi 10 group ở cấu hình mặc định.
- Ghi lại mọi lần gặp trang xác minh, thông báo hạn chế, hoặc đăng xuất bất thường, kèm số lần tải trang trong 24 giờ trước đó.

| Phép đo | Ngưỡng đạt |
|---|---|
| Tài khoản bị hạn chế hoặc khoá trong 30 ngày | 0/3 |
| Số lần gặp trang xác minh | Ghi nhận; nếu trên 1 lần mỗi tài khoản thì giảm tần suất mặc định một nửa và đo lại |

Ba tài khoản không đủ để kết luận thống kê; kết quả này chỉ loại được trường hợp tệ nhất. Trong giai đoạn dùng thử, mọi người dùng được nói rõ rủi ro và được khuyên dùng tần suất mặc định.

## 7. Tiêu chí dừng

Dừng hoặc đổi hướng lớn nếu:

- S1 không đạt và không có cách thu bài nào khác trong giới hạn an toàn.
- H5 không đạt ở tần suất thấp tới mức tin tới chậm hơn 30 phút.
- H2 không đạt ngưỡng khớp ở cả tầng `Smart` trên ngành BĐS.
- H4 không đạt và bạn không chấp nhận phương án nào trong ba hướng xử lý.
