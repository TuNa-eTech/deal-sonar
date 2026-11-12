# Rủi ro, nguyên tắc an toàn và tuân thủ

Trạng thái: nháp v0.1 · 2026-11-11

> Tôi không phải luật sư. Phần pháp lý dưới đây chỉ nêu các vấn đề cần người có chuyên môn xem xét trước khi phát hành thương mại, không phải ý kiến pháp lý.

## 1. Nguyên tắc an toàn

Bản ý tưởng tóm tắt: "chỉ đọc với tần suất thấp, không tự comment hay inbox, không thu thập và bán danh sách cá nhân, mỗi người chỉ thấy tin từ group chính họ tham gia". Dưới đây là cách mỗi nguyên tắc được thực thi trong thiết kế, để chúng là tính chất của hệ thống chứ không chỉ là lời hứa.

| # | Nguyên tắc | Thực thi bằng |
|---|---|---|
| P1 | **Chỉ đọc.** Extension không bao giờ đăng, bình luận, nhắn tin, bày tỏ cảm xúc, hay gửi yêu cầu tham gia | Mã extension không chứa thao tác ghi nào lên Facebook; `tap.ts` chỉ sao chép phản hồi; kiểm tra trong đánh giá mã rằng không có lời gọi mạng nào do extension tự phát tới Facebook ngoài việc mở trang |
| P2 | **Tần suất thấp.** Hành vi gần với một người thỉnh thoảng mở group | Chặn cứng trong extension, không tắt được từ xa ([Extension §6.3](../specs/02-extension.md#63-chặn-cứng-trong-extension)) |
| P3 | **Dừng khi có dấu hiệu.** Không cố vượt qua trang xác minh hay hạn chế | Dừng toàn bộ và chờ người dùng ([Extension §6.4](../specs/02-extension.md#64-phản-ứng-với-dấu-hiệu-bất-thường)); không có mã giải captcha hay né phát hiện |
| P4 | **Chỉ group đã tham gia.** | Extension dùng phiên của người dùng và chỉ mở group trong kế hoạch quét; group không truy cập được bị bỏ khỏi lịch |
| P5 | **Không lập danh sách cá nhân.** Không thu danh sách thành viên, không đọc trang cá nhân | Không có bộ trích nào cho các trang đó; `host_permissions` và `matches` của content script đều chỉ gồm `/groups/*`, nên extension không có quyền chạy trên trang cá nhân |
| P6 | **Dữ liệu ở lại máy.** Không có máy chủ nhận dữ liệu người dùng | Kiến trúc không backend; hai luồng ra duy nhất được nêu rõ cho người dùng ([Kiến trúc §2](../architecture/01-overview.md#2-sơ-đồ-ngữ-cảnh)) |
| P7 | **Giữ tối thiểu.** Bài không khớp bị xoá nội dung sau 30 ngày | Công việc `purge_expired` ([Dữ liệu §5](../specs/04-data-model.md#5-lưu-giữ-và-dọn-dẹp)) |
| P8 | **Không bán dữ liệu.** Sản phẩm không có tính năng xuất hàng loạt thông tin liên hệ độc lập với tin | Xuất file luôn theo tin của một radar; không có màn "xuất mọi số điện thoại" |

Nguyên tắc P8 có một vùng xám cần bạn quyết định: bảng tin có cột số điện thoại và xuất được ra CSV, nên về mặt kỹ thuật người dùng tự tạo được danh sách liên hệ. Thiết kế hiện tại giữ tính năng này vì nó là giá trị cốt lõi (gọi cho khách), nhưng không thêm công cụ nào để gom và khử trùng liên hệ hàng loạt ngoài danh bạ CRM.

## 2. Sổ rủi ro

Khả năng và tác động: Thấp / Vừa / Cao.

| Mã | Rủi ro | Khả năng | Tác động | Giảm thiểu | Còn lại |
|---|---|---|---|---|---|
| **R-1** | **Facebook hạn chế hoặc khoá tài khoản người dùng** vì hành vi tự động | Vừa | Cao | Nguyên tắc P1–P3; mặc định thận trọng; đo ở H5; nói rõ rủi ro khi cài; khuyến nghị không dùng tài khoản duy nhất không thể mất | Không loại bỏ được. Điều khoản của Meta cấm thu thập tự động khi chưa được phép, và việc phát hiện nằm ngoài tầm kiểm soát |
| **R-2** | **Extension bị gỡ khỏi Chrome Web Store**, hoặc không được duyệt | Cao | Cao | Mô tả trung thực chức năng; quyền tối thiểu; không mã từ xa. Phương án dự phòng: phát hành ngoài cửa hàng | Trên Windows và macOS, Chrome chặn cài extension ngoài cửa hàng với người dùng thường; chỉ còn "Load unpacked" ở chế độ nhà phát triển, không khả thi với người không rành kỹ thuật. **Đây là rủi ro phân phối chưa có lời giải (D-5)** |
| **R-3** | **Facebook đổi cấu trúc trang**, bộ trích hỏng | Cao | Vừa | Ba chiến lược trích; cấu hình bộ trích cập nhật qua desktop không cần phát hành lại extension; phát hiện tự động và cảnh báo; mẫu kiểm thử | Mỗi lần hỏng vẫn cần người sửa và phát hành; trong lúc đó sản phẩm ngừng hoạt động |
| **R-4** | **Meta có hành động pháp lý** với sản phẩm | Thấp–Vừa | Cao | Chỉ đọc bằng phiên của chính người dùng, trong group họ tham gia; không máy chủ thu dữ liệu; không dùng thương hiệu Facebook trong tên và quảng cáo | Meta từng có hành động với các bên làm extension thu thập dữ liệu. Cần tư vấn pháp lý trước khi thương mại hoá |
| **R-5** | **Chèn chỉ dẫn qua nội dung bài** khiến agent AI làm việc ngoài ý muốn trên máy người dùng | Vừa | Cao | Tắt mọi công cụ, hộp cát, thư mục rỗng, kiểm tra schema; adapter không tắt được công cụ thì không bật ([AI bridge §6](../specs/06-ai-bridge.md#6-bảo-mật)) | Phụ thuộc vào việc CLI thực thi đúng các cờ hạn chế; cần kiểm thử lại mỗi phiên bản CLI |
| **R-6** | **Điều khoản của nhà cung cấp AI** không cho dùng gói thuê bao cá nhân cho tác vụ tự động chạy nền, hoặc đổi điều khoản | Vừa | Cao | Đọc điều khoản của từng nhà cung cấp trước mốc 2; mỗi người dùng dùng tài khoản của chính họ trên máy của họ; giữ sẵn chỗ cắm provider API trực tiếp | Nếu một nhà cung cấp cấm, adapter đó phải gỡ. Nếu tất cả cấm, ràng buộc "AI qua CLI" không còn đứng được |
| **R-7** | **Cờ và đầu ra của CLI thay đổi** giữa các phiên bản | Cao | Vừa | `probe` kiểm tra cờ lúc chạy; bảng phiên bản đã kiểm thử; thông báo rõ khi phiên bản không hỗ trợ | Người dùng tự cập nhật CLI và làm hỏng tích hợp cho tới khi app cập nhật |
| **R-8** | **Người dùng không cài nổi CLI AI** | Cao | Cao | Trình hướng dẫn; đo ở H4; ba hướng xử lý đã nêu | Có thể buộc phải nới ràng buộc kiến trúc |
| **R-9** | **Chi phí AI**: radar làm cạn hạn mức gói của người dùng | Vừa | Vừa | Lọc sơ bộ, bộ luật, trần bài mỗi ngày, gom lô; đo ở H3 | Group rất sôi động vẫn có thể vượt trước khi bộ luật kịp học |
| **R-10** | **Chất lượng radar không đồng đều** do người dùng tự mô tả | Cao | Vừa | Xem thử bắt buộc; phản hồi đúng/sai; cảnh báo khi khớp quá nhiều hoặc không khớp gì; mẫu theo ngành | Mô tả mơ hồ vẫn cho kết quả kém; người dùng có thể đổ lỗi cho sản phẩm |
| **R-11** | **Bỏ sót tin** vì máy tắt, Chrome đóng, hoặc lỗi âm thầm | Cao | Vừa | Trang Sức khoẻ; tin hệ thống khi ngừng; quét bù khi chạy lại (trong giới hạn bài còn ở đầu feed) | Hệ quả trực tiếp của việc không có backend; phải nói rõ với người dùng |
| **R-12** | **Dữ liệu cá nhân của bên thứ ba** (tên, số điện thoại người đăng) nằm trên máy người dùng và được gửi tới nhà cung cấp AI | Chắc chắn xảy ra | Vừa | Giữ tối thiểu; không gửi ID tác giả cho AI; xoá theo hạn; nút xoá toàn bộ; xem §3 | Người dùng là bên kiểm soát dữ liệu trên máy họ; trách nhiệm của sản phẩm cần được làm rõ về pháp lý |
| **R-13** | **Lọc trùng và lọc người cùng nghề loại nhầm** khách thật | Vừa | Vừa | Xem được bài bị loại và lý do; nhãn "bị bỏ sót"; ngưỡng thận trọng | |
| **R-14** | **Khó bán** khi nói với mọi ngành cùng lúc | Vừa | Vừa | Ra thị trường từng ngành; mẫu và trang giới thiệu riêng | |
| **R-15** | **Mất dữ liệu** do hỏng file, hỏng máy | Thấp | Cao | WAL; sao lưu tự động hằng tuần và trước migration; nút sao lưu tay | Không có bản sao ngoài máy trừ khi người dùng tự chép |

Bốn rủi ro có thể chặn đứng sản phẩm, theo thứ tự cần giải quyết: **R-2** (phân phối extension), **R-1** (an toàn tài khoản), **R-8** (cài CLI AI), **R-6** (điều khoản AI). R-1 và R-8 được đo trong lộ trình (giả thuyết H5 từ mốc 1, H4 ở mốc 3). R-2 và R-6 không đo được bằng mã: cần bạn đọc chính sách hiện hành của Chrome Web Store và của từng nhà cung cấp AI, và có thể cần tư vấn, trước khi đầu tư vào mốc 2.

## 3. Dữ liệu cá nhân và pháp lý

### 3.1 Dữ liệu được xử lý

| Loại | Của ai | Nằm ở đâu | Rời máy? |
|---|---|---|---|
| Nội dung bài viết | Người đăng trong group | SQLite trên máy người dùng | Có: tới nhà cung cấp AI (để chấm), tới Telegram (tóm tắt và trường), tới webhook nếu bật |
| Tên hiển thị và ID tài khoản người đăng | Người đăng | SQLite | Tên: tới AI và Telegram. ID: không |
| Số điện thoại trong bài | Người đăng tự công bố trong bài | SQLite | Tới AI (nằm trong nội dung), tới Telegram |
| Danh sách group đã tham gia | Người dùng | SQLite | Không |
| Cấu hình radar, ghi chú CRM | Người dùng | SQLite | Mô tả radar: tới AI |

### 3.2 Vấn đề cần chuyên gia pháp lý xem

1. **Pháp luật Việt Nam về bảo vệ dữ liệu cá nhân.** Nghị định 13/2023/NĐ-CP và Luật Bảo vệ dữ liệu cá nhân (theo hiểu biết của tôi là có hiệu lực từ 01/01/2026; cần xác nhận văn bản và hướng dẫn hiện hành). Câu hỏi: người dùng thu và lưu số điện thoại người khác công bố trong group kín để liên hệ chào hàng có cần cơ sở pháp lý nào; vai trò của nhà phát triển phần mềm khi không tiếp cận dữ liệu; việc gửi nội dung bài tới nhà cung cấp AI ở nước ngoài có thuộc diện chuyển dữ liệu ra nước ngoài không.
2. **Điều khoản của Meta.** Thu thập tự động; việc dùng phiên của người dùng qua extension.
3. **Chính sách Chrome Web Store.** Yêu cầu về mục đích sử dụng dữ liệu người dùng, công bố quyền riêng tư, và các hạn chế với extension thao tác trên trang bên thứ ba.
4. **Điều khoản của từng nhà cung cấp AI** về dùng gói thuê bao cho tác vụ tự động (R-6).
5. **Quy định về liên hệ thương mại không mong muốn** (cuộc gọi, tin nhắn quảng cáo): sản phẩm giúp tìm người có nhu cầu đã tự đăng bài, nhưng cách người dùng liên hệ sau đó là trách nhiệm của họ; cần nêu trong điều khoản sử dụng.

### 3.3 Việc sản phẩm phải làm bất kể kết quả tư vấn

- Màn hình đồng ý khi cài lần đầu, nói bằng lời thường: dữ liệu gì được đọc, lưu ở đâu, gửi đi đâu, rủi ro với tài khoản Facebook.
- Chính sách quyền riêng tư và điều khoản sử dụng, trong đó người dùng cam kết chỉ dùng với group họ là thành viên hợp lệ và chịu trách nhiệm về cách liên hệ người khác.
- Nút "Xoá toàn bộ dữ liệu" hoạt động thật.
- Không gửi số liệu sử dụng ra ngoài khi người dùng chưa chủ động bật.
- Tên sản phẩm, biểu tượng và tài liệu quảng bá không dùng thương hiệu Facebook hay Meta theo cách gợi ý có liên kết chính thức.

## 4. Bảo mật ứng dụng

| Mối đe doạ | Biện pháp |
|---|---|
| Tiến trình khác trên máy giả làm extension để bơm bài giả | IPC chỉ mở cho người dùng hiện tại; native host chỉ được Chrome khởi chạy cho đúng ID extension. Phần mềm độc hại chạy dưới cùng tài khoản người dùng nằm ngoài phạm vi phòng vệ |
| Trang web giả làm desktop hoặc đọc dữ liệu | Không có cổng mạng nào được mở |
| Nội dung bài chứa mã hoặc đánh dấu | Giao diện hiển thị nội dung bài dưới dạng văn bản thuần, không bao giờ dạng HTML; chính sách bảo mật nội dung của Tauri chặn tài nguyên ngoài; Telegram và CSV có thoát ký tự ([Thông báo §2.2, §5](../specs/07-notifications-export.md)) |
| Chèn chỉ dẫn vào AI | R-5 |
| Biểu thức chính quy do AI sinh gây treo | Dùng bộ máy `regex` của Rust (thời gian tuyến tính, không quay lui); giới hạn kích thước mẫu; đo thời gian ở cổng kiểm định |
| Chèn SQL qua tên trường động | Tên trường được đối chiếu với định nghĩa radar trước khi ghép đường dẫn JSON; giá trị luôn truyền qua tham số |
| Lộ token Telegram | Kho khoá hệ điều hành; không ghi vào nhật ký hay gói chẩn đoán |
| Bản cập nhật giả | Bản cập nhật desktop được ký; khoá công khai nằm trong tệp chạy |
| Liên kết trong bài dẫn tới trang độc hại | App chỉ mở `permalink` thuộc tên miền của nền tảng; liên kết khác trong nội dung bài hiển thị dạng chữ, không bấm được |

## 5. Giới hạn đã biết của thiết kế

Những điều thiết kế này **không** làm được, để không ai kỳ vọng sai:

- Không báo tin khi máy tắt hoặc Chrome đóng.
- Không bảo đảm thấy mọi bài: bài bị đẩy khỏi phần đầu feed giữa hai lần quét của một group rất sôi động có thể bị sót.
- Không đọc nội dung trong ảnh; nhiều tin BĐS và xe cũ để thông tin chính trong ảnh.
- Không đọc bình luận; ở một số group, nhu cầu thật nằm trong bình luận.
- Không đồng bộ giữa hai máy của cùng một người.
- Không chống được người quyết tâm bẻ khoá bản quyền.
