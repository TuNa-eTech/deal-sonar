# DealSonar — Đánh giá toàn diện UI/UX và logic hành trình người dùng

Ngày: 13/11/2026. Nền mã: `ae9cb5a` cộng các thay đổi chưa commit đang có trong workspace tại thời điểm đánh giá.

## 1. Kết luận điều hành

**DealSonar cần thiết kế lại cách tổ chức công việc và trạng thái sản phẩm, không chỉ chỉnh màu, khoảng cách hay làm lại sidebar.** Ứng dụng có nền chức năng đáng kể, nhưng trải nghiệm hiện tại nghiêng về bảng điều khiển pipeline thu thập và phân loại bài viết. Người dùng phải tự ghép các mảnh Chrome, Facebook, AI, nguồn, radar, bộ luật, thông báo và CRM thành một quy trình làm việc.

Ba câu hỏi quan trọng nhất chưa được trả lời nhất quán:

1. **Hôm nay tôi cần xử lý cơ hội nào trước?** Hộp tin ưu tiên thời gian tạo và thông tin trích xuất; chưa có hàng đợi công việc đến hạn rõ ràng.
2. **Radar của tôi có thực sự tìm tin không?** “Đang chạy” hiện chủ yếu là trạng thái bật radar, khác với khả năng quét tự động thực tế của Extension.
3. **Nếu chưa có tin hoặc tin không đúng, tôi nên sửa gì?** Người dùng bị đưa sang bài bị loại, ruleset hoặc health, nhưng thiếu chẩn đoán gắn với radar và hành động kế tiếp.

Hướng cải tổ đề xuất: **từ “quản lý bộ máy quét tin” thành “không gian tìm và xử lý cơ hội có thể tin cậy”.** Giữ sức mạnh kỹ thuật bên dưới, nhưng tổ chức giao diện theo mục tiêu, quyết định và việc cần làm của người dùng.

Không nên triển khai một đợt đổi giao diện lớn trước khi sửa các sai lệch dữ liệu, trạng thái vận hành và mất nội dung đang nhập. Một giao diện đẹp hơn sẽ không bù được việc lưu sai giá hay hẹn sai giờ.

### Phạm vi và mức độ bằng chứng

| Khu vực | Đã kiểm tra | Giới hạn |
|---|---|---|
| Desktop UI | Cả 7 màn chính, onboarding 5 bước, wizard radar 4 bước, chi tiết tin, bảng, cài đặt | Chạy React trong trình duyệt với mock backend của dự án |
| Bố cục | Quan sát ảnh và kích thước DOM tại 1366×768, 1024×768 | Chưa kiểm chứng trực tiếp Tauri WebView trên Windows/macOS |
| Logic | Đối chiếu UI → IPC client → core/store ở các vấn đề quan trọng | Không chạy toàn bộ backend integration suite trong đợt audit này |
| Extension | Đọc popup/side panel, cấu hình mặc định và nhánh scheduler | Chưa thao tác trên phiên Facebook thật |
| Thông báo | Đọc cấu hình, định tuyến kênh, worker và UI | Không gửi Telegram/webhook hoặc thay đổi dữ liệu thật |
| Kiểm thử | `pnpm ui:test`: **5 file, 12 test đều pass** | Đây không phải chứng nhận usability hay live acceptance |

Ký hiệu trong báo cáo: **[UI]** tái hiện trên giao diện mock; **[CODE]** xác minh bằng mã nguồn; **[DESIGN]** nhận định thiết kế cần kiểm chứng với người dùng. Không có số liệu đo conversion/retention thực tế; các tác động kinh doanh là giả thuyết có lý do, chưa phải kết quả nghiên cứu.

## 2. Những điểm cần giữ và phát triển

- Có mẫu theo ngành, mô tả bằng tiếng Việt và nguồn Facebook gắn với radar: nền tốt để giảm thao tác ban đầu.
- Preview có bài khớp/không khớp, lý do và bằng chứng nguyên văn. Đây nên là trung tâm kiểm tra chất lượng radar.
- Bản workspace hiện tại đã có trạng thái tiến độ, hủy preview, polling khôi phục sự kiện bị lỡ và hiển thị lỗi. Không cần xây lại phần này từ đầu.
- Có xử lý trùng, phản hồi đúng/sai/bỏ sót, dữ liệu liên hệ, trạng thái CRM và xuất dữ liệu.
- Nội dung bài được render dạng văn bản; liên kết được kiểm tra; có xác nhận xóa toàn bộ và giới hạn vận hành.
- CSS có token cơ bản, focus-visible và panel cuộn riêng; có thể xây tiếp thành hệ thống thiết kế thống nhất.

Vấn đề chính là thứ tự ưu tiên và sự kết nối giữa các năng lực này.

## 3. Các vấn đề ưu tiên cao có bằng chứng cụ thể

Mức ưu tiên của báo cáo: **P0** = sai dữ liệu hoặc phá vỡ cam kết cốt lõi; **P1** = cản trở hành trình chính/khả năng hiểu hệ thống; **P2** = hoàn thiện hiệu suất và chất lượng sau khi nền đã đúng. Đây là mức ưu tiên sản phẩm, không phải phân loại lỗ hổng bảo mật.

### F01 — P0: Nhập tiền theo cách tự nhiên làm sai giá trị lưu

**[UI + CODE]** Mở tin, sửa “Giá / Ngân sách”, nhập `15 triệu/tháng`, bấm Lưu. UI hiển thị **`15/tháng`**; Bảng tin cũng hiển thị giá trị này. Hàm parse loại bỏ ký tự chữ rồi gọi `Number`, không nhân đơn vị triệu/tỷ. Chuỗi có khoảng hoặc dấu phân cách Việt Nam còn có thể đi vào nhánh trả lại chuỗi thay vì đối tượng tiền.

Đây là vấn đề dữ liệu, không phải riêng trình bày: giá sai ảnh hưởng lọc, xuất file và quyết định liên hệ. Backend đang kiểm tra field key thuộc radar, nhưng đường cập nhật được đọc không kiểm tra đầy đủ hình dạng giá trị theo loại trường.

**Thay đổi cần làm:** editor theo kiểu dữ liệu. Với tiền có giá từ/đến, đơn vị, chu kỳ; có thể hỗ trợ nhập `15tr` nhưng phải hiển thị bản chuẩn hóa trước khi lưu. Range, ngày, boolean, enum và location cần editor tương ứng, không cùng một input text.

**Nghiệm thu:** `15 triệu`, `15.000.000`, `15tr`, `12–14 triệu/tháng` phải lưu đúng hoặc báo không hiểu; không được âm thầm lưu giá trị khác. Mở và lưu lại khi không sửa không được thay đổi cấu trúc dữ liệu. Kiểm tra UI → IPC → store → export.

Nguồn: `apps/desktop/ui/src/components/LeadDetailPanel.tsx:77`, `crates/core/src/service.rs:1301`, `crates/store/src/leads.rs:684`.

### F02 — P0: Nhắc việc chưa có vòng đời hoàn chỉnh và có lỗi múi giờ

**[CODE + phép tái hiện biểu thức]** UI nạp `follow_up_at` bằng `toISOString().slice(0,16)` vào `datetime-local`, nhưng lưu bằng `new Date(input).getTime()` theo giờ địa phương. Với Asia/Ho_Chi_Minh: nhập 15:00 → lưu 08:00Z → mở lại thấy 08:00 → lưu tiếp thành 01:00Z. Mỗi lần đọc/lưu có thể làm lệch thêm giờ.

Tìm toàn bộ đường `follow_up` trong core, desktop và notify cho thấy chức năng lưu/đọc, nhưng **chưa thấy worker phát nhắc việc đến hạn**, hàng đợi “Hôm nay” hoặc thao tác hoàn tất/dời lịch. Vì vậy chữ “Nhắc liên hệ lại” đang hứa nhiều hơn luồng được triển khai. Kết luận này dựa trên source, chưa phải thử nhắc việc thật tới hạn.

**Thay đổi cần làm:** coi nhắc việc là một đối tượng công việc: thời điểm, múi giờ, trạng thái, hoàn tất, hoãn, quá hạn; có xử lý khi máy ngủ/tắt và khi chạy lại. Không nên để người dùng hiểu rằng chỉ lưu timestamp là đã có nhắc chủ động.

**Nghiệm thu:** giờ giữ nguyên sau mở/lưu; có hàng đợi đến hạn; phát đúng một lần theo chính sách; lịch quá hạn khi mở lại máy được xử lý minh bạch; phân biệt “đã đặt lịch” và “đã gửi nhắc”.

Nguồn: `LeadDetailPanel.tsx:42`, `LeadDetailPanel.tsx:168`, `crates/core/src/service.rs:1253`, `crates/core/src/workers.rs:41`.

### F03 — P0: “Radar đang chạy” chưa có nghĩa đang thu thập tin

**[CODE]** `active` được hiển thị là “Đang chạy”. Extension lại có `automatic_scanning: false` mặc định và từ chối quét theo lịch khi công tắc này tắt. `HealthStatus` không có trường mô tả trực tiếp công tắc quét tự động. Đèn tổng hợp ở sidebar dựa vào kết nối Extension, phiên Facebook và AI; không phản ánh đầy đủ trạng thái quét, Telegram hoặc độ mới dữ liệu.

**Hệ quả:** có thể bật radar, nhìn thấy trạng thái xanh nhưng không biết vì sao không có bài mới. Một hệ thống săn tin phải trả lời trạng thái hoạt động thực, không chỉ trạng thái cấu hình.

**Thay đổi cần làm:** hợp nhất mô hình trạng thái giữa Desktop và Extension. Tách “Radar đã bật” khỏi “Đang thu thập / Chỉ quét thủ công / Chờ đến lịch / Bị chặn / Đang xử lý”. Hiển thị lần nhận bài thành công gần nhất, lần quét kế tiếp nếu xác định được, và nguyên nhân không chạy.

**Nghiệm thu:** tắt tự động ở Extension phải làm Desktop hiện “Chỉ quét thủ công”; pause, ngoài giờ hoạt động, mất kết nối và chờ AI phải có tên trạng thái khác nhau. Bật radar lần đầu phải cho người dùng chọn chế độ chạy rõ ràng.

Nguồn: `apps/desktop/ui/src/lib/format.ts:34`, `apps/desktop/ui/src/App.tsx:175`, `apps/extension/src/background/storage.ts:94`, `apps/extension/src/background/index.ts:627`, `crates/core/src/dto.rs:907`.

### F04 — P1: “Kiểm tra AI” đang gọi lại kết nối Chrome

**[CODE]** Nút “Kiểm tra AI” trong GlobalHealthBanner gọi `onRetryConnect`; App truyền callback chạy `api.chromeConnect()` và `api.healthGet()`. Không gọi `aiProbe()` như nút kiểm tra ở màn Sức khoẻ.

**Thay đổi cần làm:** mỗi loại sự cố có action tương ứng, kèm trạng thái đang kiểm tra, kết quả và lối đi đến cấu hình liên quan. Không dùng chung callback chỉ vì giao diện nút giống nhau.

**Nghiệm thu:** nút AI gọi kiểm tra AI; nút Chrome gọi kết nối Chrome; thất bại được trình bày tại nơi vừa thao tác và không làm mất màn đang làm việc.

Nguồn: `GlobalHealthBanner.tsx:126`, `App.tsx:288`, `screens/HealthScreen.tsx:41`.

### F05 — P1: Lưu một mục cài đặt làm mất bản sửa ở mục khác

**[UI + CODE]** Trong Cài đặt, đổi trần AI từ `2000` thành `1234`, chưa lưu AI; bấm “Lưu tuỳ chọn thông báo”. Giá trị AI quay lại `2000`. `savePatch` nhận settings đã lưu rồi thay toàn bộ `draft`.

Ngoài ra, App tải lại settings sau các sự kiện lead; SettingsScreen đồng bộ lại toàn bộ draft khi props settings đổi. Đây là đường có thể làm mất nội dung đang nhập khi dữ liệu nền cập nhật, chưa được tái hiện với backend thật trong audit.

**Thay đổi cần làm:** chia settings thành nhóm độc lập với dirty state riêng, hoặc một giao dịch Save/Cancel rõ ràng. Merge dữ liệu server chỉ vào phần chưa sửa. Chuyển màn phải giữ draft hoặc cảnh báo thay đổi chưa lưu.

**Nghiệm thu:** lưu Thông báo không đổi AI chưa lưu; lead mới đến không ghi đè draft; hiển thị rõ nhóm nào còn thay đổi.

Nguồn: `screens/SettingsScreen.tsx:143`, `screens/SettingsScreen.tsx:166`, `App.tsx:117`.

### F06 — P1: Điều kiện cứng AI đề xuất không được chuyển thành cấu hình mới

**[CODE]** Backend `radar_suggest_fields` trả `hard_filters`, `want_intent`, `prefilter_hint`. Wizard dùng fields, suggested_name và clarifying_questions; `currentMatchPolicy` giữ hard_filters của radar cũ hoặc `[]` với radar mới. Các đề xuất điều kiện cứng không được đưa vào luồng xác nhận.

Không có nghĩa toàn bộ mô tả bị bỏ qua: mô tả vẫn được gửi cho AI. Vấn đề là “dưới 15 triệu” trong câu mô tả không được trình bày như một điều kiện cứng có thể kiểm tra và điều chỉnh. Người dùng khó phân biệt yêu cầu bắt buộc với gợi ý mềm.

**Thay đổi cần làm:** thêm bước “Tôi hiểu bạn muốn tìm…” gồm ý định, đối tượng, địa bàn, điều kiện bắt buộc, ưu tiên và chính sách khi thiếu dữ liệu. AI chỉ đề xuất; người dùng nhìn và xác nhận.

**Nghiệm thu:** tiêu chí người dùng xác nhận được lưu đúng vào policy và preview dùng đúng policy đó; trường thiếu thông tin có lựa chọn “loại / giữ để xem” rõ ràng. Câu hỏi làm rõ có ô trả lời và cập nhật cấu hình, không chỉ hiện danh sách câu hỏi.

Nguồn: `RadarWizard.tsx:173`, `RadarWizard.tsx:304`, `RadarWizard.tsx:847`, `crates/core/src/service.rs:830`.

### F07 — P1: Hộp tin giới hạn 50 kết quả nhưng không có tải tiếp

**[CODE]** Inbox gọi `leadList(limit:50)` và chỉ dùng `items`, không dùng total/next_cursor. Đây là giới hạn của Inbox; Bảng tin có phân trang riêng. Với nhiều tin, người dùng không có dấu hiệu rõ rằng danh sách đang xem chưa đầy đủ.

**Thay đổi cần làm:** tải tiếp hoặc phân trang với tổng kết quả, giữ vị trí đã xử lý và bộ lọc. Không buộc người dùng biết phải đổi sang Bảng tin để tìm tin cũ hơn.

**Nghiệm thu:** tập 120 tin có thể duyệt hết trong Inbox; tìm kiếm/bộ lọc hiển thị tổng đúng; quay lại không mất vị trí.

Nguồn: `screens/InboxScreen.tsx:43`.

### F08 — P1: “Tất cả Radar” nhưng bài bị loại chỉ lấy radar đầu tiên

**[CODE]** `openRejectedModal` dùng `selectedRadarId || radars[0]?.id`. Khi Inbox đang chọn tất cả, modal vẫn có tên chung và chỉ lấy 30 đánh giá của radar đầu tiên.

**Thay đổi cần làm:** chọn radar rõ ràng trong modal hoặc truy vấn nhiều radar và ghi nhãn từng kết quả; có tổng/phân trang. Không âm thầm thay phạm vi người dùng đã chọn.

**Nghiệm thu:** mọi màn kết quả luôn hiển thị phạm vi đang áp dụng; không bỏ các radar khác khi bộ lọc là tất cả.

Nguồn: `screens/InboxScreen.tsx:75`.

### F09 — P1: Trạng thái “đã xem” không nhất quán giữa các cách mở tin

**[UI + CODE]** Inbox tự chọn tin đầu và render nội dung nhưng không đánh dấu đã xem. Click dòng Inbox mới gọi `leadSetStatus(viewed)`. Mở từ Bảng tin chỉ mở panel. Cùng một hành vi đọc tin có thể cho ba kết quả trạng thái khác nhau.

**Thay đổi cần làm:** tách trạng thái đọc khỏi trạng thái bán hàng. Một tin có thể đã đọc nhưng vẫn cần xử lý; “Mới/Đã xem” không nên dùng chung một enum với “Đang thương lượng/Chốt thành công”.

**Nghiệm thu:** quy tắc đánh dấu đọc thống nhất trên mọi điểm vào; số chưa đọc phản ánh quy tắc đó; xem tin không đổi giai đoạn CRM.

Nguồn: `screens/InboxScreen.tsx:62`, `screens/InboxScreen.tsx:239`, `screens/LeadTableScreen.tsx:428`, `lib/format.ts:24`.

### F10 — P1: Bản nháp và xem thử có tác dụng lưu chưa rõ ràng

**[CODE]** Trước preview, wizard đã gọi tạo/cập nhật radar. “Lưu nháp” chỉ xuất hiện ở bước 4; đóng ở bước 1–3 bỏ state đang nhập; đóng sau preview có thể đã để lại draft trong backend. Khi sửa radar active, candidate version tồn tại nhưng mở lại editor khởi tạo từ current_version_data. Cần kiểm chứng sâu việc phục hồi candidate qua toàn hành trình.

Ngoài ra, preview gọi cập nhật tên/nguồn trước khi người dùng bấm áp dụng. Core cập nhật metadata/source riêng với xác nhận phiên bản; source đổi trên active radar có thể đẩy config. Cần làm rõ hoặc loại bỏ side effect này để “Xem thử” không gây bất ngờ cho radar đang chạy.

**Thay đổi cần làm:** tách cấu hình đã xuất bản và working draft. Autosave draft, preview một snapshot không thay đổi cấu hình live; khi Publish hiển thị khác biệt, nguồn bị tác động và thời điểm hiệu lực. Đóng rồi mở lại phải tiếp tục được.

**Nghiệm thu:** preview không làm đổi nguồn radar đang chạy; draft phục hồi đầy đủ; Publish là điểm duy nhất áp dụng thay đổi; lỗi/hủy preview không làm mất cấu hình.

Nguồn: `RadarWizard.tsx:310`, `RadarWizard.tsx:481`, `RadarWizard.tsx:626`, `crates/core/src/service.rs:728`.

### F11 — P1: Có “Bật radar” nhưng thiếu bước xác nhận khả năng vận hành

**[CODE]** Footer chỉ disable theo saving/previewBusy, không theo preview thành công. `radar_set_status` kiểm tra giới hạn gói, cập nhật trạng thái và config; đường này không cung cấp một checklist readiness hoàn chỉnh.

Không nên cấm bật chỉ vì mẫu preview không có bài khớp. Cần phân biệt **0 kết quả hợp lệ** với **preview lỗi / chưa có dữ liệu / chưa cấu hình AI / nguồn chưa sẵn sàng**.

**Thay đổi cần làm:** sau preview, summary “sẵn sàng ở mức nào”, mẫu đã kiểm tra, giới hạn mẫu, nguồn, chế độ quét, kênh nhận và lịch hoạt động. Cho lưu draft hoặc bật ở chế độ giới hạn với giải thích cụ thể.

**Nghiệm thu:** không báo thành công chung cho trạng thái chưa vận hành; sau bật có trang theo dõi lượt quét đầu tiên và CTA xử lý blocker.

Nguồn: `RadarWizard.tsx:1362`, `crates/core/src/service.rs:866`.

### F12 — P1: Bố cục chưa thích ứng tốt khi cửa sổ desktop hẹp

**[UI + CODE]** Ở 1366×768, panel danh sách 380px, panel detail khoảng 702px; thông tin hành động CRM nằm dưới phần trích xuất dài. Ở 1024×768, detail chỉ còn khoảng **360px nhưng nội dung rộng 401px**; chiều cao nội dung khoảng **1671px** trong vùng 616px. Main cũng phát sinh cuộn dọc (842px nội dung/768px khung). Nhãn và giá trị vỡ dòng nặng.

Đây là bài toán cửa sổ desktop/laptop, không cần giả định sản phẩm phải có mobile app. CSS hiện chưa có media query cho các bố cục cố định này.

**Thay đổi cần làm:** sidebar thu gọn; master/detail co giãn; ở cửa sổ hẹp mở detail thành một trang/panel đầy đủ; một vùng cuộn chính có chủ đích; action liên hệ và trạng thái luôn dễ tiếp cận. Trích xuất ưu tiên 3–5 trường quan trọng, bằng chứng kỹ thuật thu gọn.

**Nghiệm thu:** 1024×768 và 1366×768 không tràn ngang ở detail, không chữ bị ép thành cột hẹp; có thể mở bài, lấy số liên hệ, đặt lịch và đổi trạng thái mà không cuộn qua toàn bộ metadata.

Ảnh: [1366×768](evidence/inbox-1366.png), [1024×768](evidence/inbox-1024.png). Nguồn: `styles/app.css` — `.sidebar`, `.inbox-split`, `.lead-detail-pane`.

## 4. Đánh giá và cải tổ từng khu vực

### 4.1 Onboarding: dẫn tới giá trị đầu tiên thay vì hoàn thành cài đặt

**Hiện trạng:** consent → Chrome → Facebook → CLI AI/model → Telegram/bot token → lưu ý vận hành → wizard radar thêm 4 bước. Người mới phải hiểu công cụ, cấu hình và kiểu dữ liệu trước khi nhìn thấy một cơ hội phù hợp. Nút bước tiếp theo không ràng buộc readiness, nên đi hết wizard không đồng nghĩa sẵn sàng.

**Cải tổ mạnh:**

1. Hỏi “Bạn muốn tìm ai/cơ hội gì?” và cho xem một ví dụ đầu ra ngay.
2. Kết nối nguồn bằng checklist tự phát hiện; chỉ yêu cầu thao tác khi thực sự thiếu.
3. Dùng cấu hình trích xuất mặc định của ngành; tùy chỉnh schema là nâng cao.
4. Chạy thử trên nguồn đã chọn, sửa cách hiểu và cho thấy kết quả đầu tiên.
5. Chọn chế độ hoạt động và nơi nhận thông báo. Telegram/webhook có thể thiết lập sau.

Consent cần giữ, nhưng thông tin kỹ thuật như file native manifest, PATH, tầng Fast/Smart, extension ID thủ công chỉ xuất hiện trong phần xử lý lỗi/nâng cao. Chưa có dữ liệu để khẳng định bỏ onboarding bao nhiêu phần trăm; cần đo thời gian tới kết quả hữu ích đầu tiên.

AI có thể bỏ qua cho trường hợp hỗ trợ rules-only, nhưng phải ghi rõ radar nào hoạt động được và radar nào cần AI. Không để dấu hoàn thành chung che mất giới hạn năng lực.

### 4.2 Điều hướng: tổ chức theo công việc, không theo bảng dữ liệu

**Hiện trạng:** Hộp tin và Bảng tin đều trình bày lead nhưng khác mặc định (Inbox ẩn weak, Table hiện weak và chọn radar đầu). Contacts nằm riêng, lịch sử lead không mở trực tiếp. Screen state là local component state, không có route/history theo ngữ cảnh đang làm.

**Kiến trúc đề xuất:**

| Mục chính | Mục tiêu người dùng | Nội dung |
|---|---|---|
| Hôm nay | Biết việc cần làm trước | Tin chưa xử lý, lịch đến hạn/quá hạn, radar bị gián đoạn |
| Cơ hội | Đọc, lọc và xử lý tin | Chế độ danh sách/bảng dùng chung phạm vi và bộ lọc |
| Radar | Đặt mục tiêu tìm tin, đo hiệu quả | Mô tả, điều kiện, nguồn, preview, phiên bản, thông báo |
| Nguồn | Kiểm soát nơi thu thập | Phát hiện, chọn, tình trạng, độ mới, radar đang sử dụng |
| Liên hệ | Quản lý quan hệ | Lịch sử cơ hội, ghi chú, công việc, liên kết mở lead |
| Kết nối & Cài đặt | Giữ hệ thống hoạt động | AI, Chrome, thông báo, dữ liệu, chẩn đoán nâng cao |

“Hôm nay” phải là hàng đợi có thể hành động, không phải dashboard thêm nhiều biểu đồ. Bộ lọc, lead đang chọn và vị trí cuộn nên sống theo workspace/route và được phục hồi khi quay lại. Quyết định có giữ Hôm nay thành mục riêng cần kiểm chứng bằng tần suất công việc thực tế; có thể là view mặc định của Cơ hội.

### 4.3 Tạo radar: chuyển từ cấu hình schema sang xác nhận ý định

Wizard hiện đưa bảng kiểu dữ liệu, key trường, required và Telegram vào bước bắt buộc. Người dùng kinh doanh thường biết “muốn khách thuê 2PN dưới 15 triệu”, không biết thiết kế `money/range/enum`.

Luồng mới nên là **Mục tiêu → Cách hệ thống hiểu → Nguồn → Kết quả thử → Bật**. Các trường trích xuất mặc định được trình bày bằng ví dụ của một tin, có mở “Tùy chỉnh thông tin cần lấy”.

Nguồn mặc định hiện chọn tất cả nguồn đang followed; radar ngành khác có thể bắt đầu với group không liên quan. Nên gợi ý theo chủ đề, hiển thị nguồn nào đã chọn và lý do; không tự giả định mọi group đều phù hợp.

Giới hạn gói cần hiện trước thao tác tốn thời gian. Khi không thể bật thêm radar, cho chọn tạm dừng radar khác hoặc lưu nháp ngay, thay vì tới cuối mới nhận lỗi giới hạn.

### 4.4 Preview và vòng phản hồi: giải thích tác động, không hứa AI học tức thì

Preview hai cột là nền tốt nhưng dài và khó đối chiếu. Nên có tổng hợp số bài, phạm vi mẫu, thời gian dữ liệu, số lỗi/chưa xử lý; tab “Khớp / Cần xem lại / Bị loại”, chọn từng bài để so bằng chứng và điều kiện.

Phản hồi hiện có tác dụng lưu ví dụ và ảnh hưởng bộ luật; backend cũng phục hồi bài bỏ sót ở origin app thành lead. Vì vậy không nên báo thiếu khả năng phục hồi. Tuy nhiên CTA chỉ “đưa vào tập học” chưa giải thích đầy đủ tác động. Sau đánh dấu bỏ sót, cần “Đã đưa về Cơ hội — Mở tin”. Preview cần nói rõ không tạo lead thật.

“Đánh dấu để dạy AI rồi chạy lại” dễ khiến người dùng kỳ vọng một lần bấm bảo đảm sửa mọi bài tương tự. Nên hiển thị trạng thái “đã ghi nhận ví dụ”, “đã dùng trong lần đánh giá này” hoặc “đang kiểm định bộ luật”, tùy điều hệ thống xác minh được. Không gọi điểm match là xác suất đúng nếu chưa được hiệu chuẩn.

Khi sửa radar active, cần so sánh cấu hình đang chạy và bản thử: thay đổi điều kiện gì, khác bao nhiêu kết quả trong cùng tập mẫu. Publish/rollback nên là thao tác sản phẩm rõ ràng.

### 4.5 Cơ hội và chi tiết tin: đặt quyết định liên hệ lên trước

Thứ tự đề xuất trong detail:

1. Nhu cầu chính, lý do phù hợp, thời gian đăng và độ mới.
2. Giá/khu vực/đặc điểm quyết định; thông tin liên hệ dễ sao chép hoặc mở hành động phù hợp.
3. CTA chính: mở bài gốc, đánh dấu đã liên hệ, đặt lịch.
4. Nội dung gốc với bằng chứng; tách vùng “cần kiểm tra” khi thông tin mâu thuẫn/thiếu.
5. Ghi chú và lịch sử hoạt động.
6. Chất lượng kết quả đúng/sai và chi tiết mô hình/bộ luật ở mức thứ cấp.

Nút chặn tác giả hiện nằm ngang hàng với hành động thường dùng. Đây là tác động rộng; nên chuyển vào menu, nêu rõ phạm vi radar/toàn bộ và có Undo phù hợp. Nút “Sai” không nên khiến người dùng khó phân biệt “không muốn xử lý tin này” với “hệ thống đánh giá sai”. Một lead không phù hợp lúc này chưa chắc là mẫu âm đúng cho hệ thống.

Nên tách bốn trục: **đã đọc**, **trạng thái xử lý**, **đánh giá độ phù hợp**, **công việc cần làm tiếp**. Dùng một trạng thái duy nhất cho tất cả sẽ tiếp tục gây lệch badge và hàng đợi.

### 4.6 Bảng tin: thành view làm việc thực sự

Hiện bảng hiện nhiều cột theo schema, có lọc, sort và export; nhưng thiếu view lưu sẵn, tùy chọn cột, xử lý hàng loạt, giữ ngữ cảnh khi chuyển màn. Pagination chỉ “trang đầu / trang tiếp” nên khó quay lại trang vừa xem.

**Cải tổ:** dùng chung entity và bộ lọc với Inbox; cho chọn view “Chưa xử lý”, “Đã liên hệ”, “Cần gọi lại”, “Tin khớp yếu”; chọn/ghim cột trọng tâm; số lượng kết quả và lựa chọn export theo phạm vi rõ ràng.

Bộ lọc cần theo loại trường. Hiện có logic `Number(rawInput) || 0` với between, dùng chung danh sách toán tử và nhập text; lỗi nhập có thể biến thành 0 hoặc giá trị không mong muốn. Nên có đơn vị, validation hai đầu khoảng, enum multiselect, ngày giờ đúng kiểu và nút xóa toàn bộ bộ lọc. Không âm thầm áp dụng khoảng đang nhập dở.

### 4.7 Nguồn và Extension: hợp nhất vòng “chọn nguồn → thực sự có kết quả”

Nguồn hiện có bảng theo dõi, ưu tiên và quét ngay. Extension có chọn nhóm, quét tab hiện tại/nền, tiến độ và tạm dừng — đây là nền khá tốt. Điểm thiếu là chuyển tiếp trở lại radar/cơ hội ở Desktop.

Sau “Quét ngay”, người dùng cần thấy: **đã xếp hàng → đang đọc → đã đồng bộ → đang lọc → có N cơ hội**. “Đã gửi lệnh quét” chỉ là xác nhận nhận yêu cầu, chưa phải hoàn tất công việc. Nếu quét không ra gì phải phân biệt không có bài mới, trùng, không khớp, lỗi truy cập và chờ AI.

Trong mỗi nguồn nên có radar đang sử dụng, lần thành công gần nhất, hiệu quả cơ hội và lý do bị chặn. Bỏ theo dõi một nguồn cần chỉ ra radar nào bị ảnh hưởng; có thể Undo để tránh mất nguồn do click nhầm.

Khi nguồn rỗng, hướng dẫn một hành động cụ thể để phát hiện nhóm rồi tự cập nhật; không chỉ mở Facebook và để người dùng tự đoán bước tiếp theo. Thống nhất từ “Nhóm” thay vì trộn group/nguồn/tab ở nơi không cần thiết.

### 4.8 Liên hệ và CRM: từ danh sách phụ thành lịch sử quan hệ

Danh bạ hiện ưu tiên số điện thoại chuẩn hóa và chặn. Lịch sử lead là văn bản, chưa có đường mở trực tiếp. Chưa có mô hình công việc hoàn chỉnh ở UI.

Nên có timeline “tin nào → đã liên hệ khi nào → ghi chú gì → việc tiếp theo”; click lead mở đúng ngữ cảnh. Quy tắc gộp theo số điện thoại cần có giải thích và cơ chế sửa gộp sai khi sản phẩm mở rộng. Không cần vội xây CRM doanh nghiệp; ưu tiên một vòng cá nhân khép kín: **phát hiện → liên hệ → hẹn lại → kết quả**.

Blocklist nên là phần quản lý loại trừ, không chiếm vai trò chính của Danh bạ. Khi chặn, hiện rõ tác giả/số/keyword và phạm vi; khi bỏ chặn, đồng bộ trạng thái contact để người dùng không thấy badge cũ.

### 4.9 Thông báo: hiển thị cấu hình thực tế của từng radar

Backend có `notify.channel_ids`, `mode`, `min_score`; wizard hiện không có phần cấu hình tương ứng đầy đủ. Radar mới lấy default mode tại lúc tạo, và pipeline dùng cấu hình radar. Vì vậy thay “mặc định” không nên khiến người dùng nghĩ tất cả radar đang chạy đã đổi chế độ.

Nên có trang/cụm “Radar này sẽ báo ở đâu, khi nào, vì sao”: kênh, tức thời/gộp, ngưỡng, giờ yên lặng và override. Kèm xem trước mẫu tin và trạng thái gửi từng kênh. Đừng dùng một dòng “Đã báo Telegram” cho mọi trường hợp nếu thực tế có nhiều loại kênh.

Thay đổi default cần nói “áp dụng cho radar mới”, hoặc cho chọn áp dụng các radar hiện có với bản tóm tắt tác động. Không tự suy ra cần cập nhật hàng loạt.

### 4.10 Sức khoẻ: chẩn đoán theo triệu chứng người dùng

Màn hiện tại có nhiều số liệu vận hành hữu ích, nhưng người dùng thường hỏi “Vì sao hôm nay không có tin?” thay vì “Tỉ lệ gọi AI bao nhiêu?”.

Nên có chẩn đoán theo chuỗi: nguồn có bài mới không → đã thu thập chưa → có bị trùng/loại không → AI có chờ không → lead đã tạo chưa → thông báo đã gửi chưa. Cho mỗi điểm lỗi một CTA đúng nguyên nhân, không bắt đọc log.

Banner toàn cục nên gộp theo sự cố gốc, ưu tiên ảnh hưởng và tránh nhiều thông báo chồng nhau chiếm chiều cao. Giữ sự cố quan trọng, nhưng đưa token, extractor strategy, job kind, native manifest và ruleset origin vào phần chẩn đoán mở rộng.

### 4.11 Cài đặt và dữ liệu: chia nhóm có ranh giới lưu rõ ràng

Tách tab/nhóm AI & Kết nối; Thông báo; Lịch quét; Dữ liệu; Gói sử dụng. Nhóm nâng cao mặc định đóng. Mỗi nhóm có trạng thái đã lưu/chưa lưu, validation tại field và feedback gần nút bấm.

Sao lưu cần một vòng khôi phục có thể kiểm chứng, không chỉ “đã tạo file ở đường dẫn”. UI hiện không có hành trình restore tương ứng. Bổ sung chọn vị trí/mở thư mục, thông tin nội dung bản sao và kế hoạch restore khi cần; ưu tiên sau các lỗi dữ liệu đang có.

Thông điệp “Dữ liệu 100% lưu tại máy” cần viết chính xác hơn với luồng dữ liệu: cơ sở dữ liệu lưu cục bộ, nội dung cần xử lý có thể được gửi tới AI/kênh đã chọn. Consent và Settings đã có giải thích, nhưng câu ngắn thường trực ở sidebar dễ tạo kỳ vọng quá rộng. Đây là vấn đề nhất quán thông điệp, không kết luận vi phạm pháp lý.

### 4.12 Hệ thống UI, tương tác và ngôn ngữ

- Chuẩn hóa component cho page header, toolbar, empty state, async action, dialog, drawer, field editor và confirmation có Undo.
- Bỏ thuật ngữ nội bộ khỏi luồng chính: `origin: user`, `source: user`, `FTS5`, `T3`, `raw`, `E.164`, “Webhook (P1)”. Thay bằng ngôn ngữ mục đích; giữ chi tiết kỹ thuật trong vùng nâng cao.
- Sử dụng hệ icon thống nhất thay vì emoji theo nền tảng cho hành động chính. Không cần đổi toàn bộ brand để giải quyết flow.
- Dùng hierarchy có chủ đích: tiêu đề, giá trị kinh doanh, hành động tiếp theo, metadata. Giảm badge không giúp ra quyết định; không giảm mọi cỡ chữ chỉ để nhét thêm nội dung.
- Mọi thao tác async có pending/error/retry rõ ràng. Nhiều handler hiện chỉ await hoặc `void` và không có catch cục bộ; UI có thể im lặng hoặc giữ trạng thái tải khi lỗi.
- Cần hủy/bỏ qua response cũ khi đổi radar, tìm kiếm hoặc chọn lead nhanh. Hiện nhiều effect không có bảo vệ stale response; đây là rủi ro source-level, chưa chứng minh tần suất trên runtime thật.
- Row có click cần hành vi bàn phím tương đương; nhiều row/div/th hiện chưa có. Modal có aria-modal nhưng chưa thấy focus trap/Escape/restore focus; cần kiểm chứng keyboard và screen reader, không chỉ check attribute.
- Input cần label được gắn đúng, trạng thái active nav có semantics, thay đổi trạng thái cần được thông báo phù hợp cho công nghệ hỗ trợ.

## 5. Các luồng đích cần thiết kế lại

### Luồng A — Người mới tới kết quả hữu ích đầu tiên

`Chọn mục tiêu → xác nhận dữ liệu/kết nối cần dùng → mô tả nhu cầu → xem cách hệ thống hiểu → chọn nguồn → xem thử → chỉnh tiêu chí → chọn chế độ chạy & nhận tin → theo dõi lượt đầu`

Đầu ra thành công: người dùng nhìn thấy một cơ hội có lý do phù hợp hoặc hiểu chính xác vì sao mẫu chưa có cơ hội; biết radar có đang thu thập thật hay chưa. Không lấy “đã hoàn thành wizard” làm tiêu chí thành công.

### Luồng B — Xử lý công việc hằng ngày

`Hôm nay → tin chưa xử lý/nhắc việc đến hạn → đọc tóm tắt & bằng chứng → mở bài/liên hệ → ghi kết quả → hẹn lại hoặc đóng → tin tiếp theo`

Giữ vị trí, bộ lọc và draft ghi chú. Một hành động có tác động mạnh như block hoặc đổi hàng loạt phải có phạm vi rõ và khả năng phục hồi.

### Luồng C — Không có tin mới

`Mở radar → xem độ mới dữ liệu và trạng thái thực → biết điểm đang tắc → thực hiện CTA sửa → thấy tiến độ phục hồi → xem kết quả`

Phân biệt ít nhất: chưa chọn nguồn, chỉ quét thủ công, tạm dừng, mất Chrome, chưa có bài mới, toàn bài trùng, tiêu chí quá hẹp, chờ AI và lỗi gửi thông báo. Trạng thái rỗng phải dựa vào đúng radar/filter, không cộng tổng tất cả radar rồi kết luận chung.

### Luồng D — Cải thiện chất lượng radar đang chạy

`Chọn tin sai/bài bỏ sót → xác định lý do → tạo bản sửa → xem thay đổi tiêu chí → preview cùng mẫu → so sánh → áp dụng phiên bản → theo dõi kết quả`

Tách phản hồi ví dụ, chỉnh điều kiện và chặn nguồn/tác giả. Mỗi thao tác giải quyết một loại vấn đề, tránh dùng block thay cho sửa mô tả hoặc dùng feedback thay cho “bỏ qua tin này”.

### Luồng E — Cửa sổ đóng, máy ngủ hoặc mất kết nối

`Phát hiện gián đoạn → giữ công việc đang nhập → lưu trạng thái chờ → khi hoạt động lại hiển thị khoảng trống dữ liệu → backfill theo chính sách → thông báo trạng thái đã bắt kịp/chưa bắt kịp`

Core đã có backfill im lặng cho Paused → Active; cần trình bày phạm vi và tiến độ của khả năng này, không hứa rằng mọi dữ liệu trong thời gian offline luôn được lấy lại.

## 6. Thứ tự triển khai đề xuất

| Đợt | Kết quả phải đạt | Phạm vi |
|---|---|---|
| 0 — Khôi phục độ tin cậy | Dữ liệu đúng, không mất draft, trạng thái vận hành trung thực | F01–F05; kiểm tra reminder; hợp nhất trạng thái automatic/pause; sửa loading/error ở thao tác chính |
| 1 — Làm lại hành trình kích hoạt | Từ nhu cầu tới một radar thực sự hoạt động | Ý định có cấu trúc, điều kiện cứng, nguồn, working draft, preview/publish, readiness và thông báo |
| 2 — Làm lại không gian xử lý cơ hội | Có vòng xử lý hằng ngày khép kín | Inbox/Table dùng chung view state; read vs CRM; tải tiếp; detail mới; công việc và liên hệ |
| 3 — Hoàn thiện vận hành | Người dùng tự giải quyết sự cố và quản lý dài hạn | Chẩn đoán theo nguyên nhân, nguồn/Extension đồng bộ, cấu hình notification theo radar, data restore, keyboard/accessibility |

Không ước lượng tuần/ngày khi chưa chốt đội ngũ và phạm vi native/backend. Mỗi đợt phải là một lát cắt hoàn chỉnh UI → IPC → core/store → Extension/notify khi liên quan. Tránh triển khai frontend mới rồi để các trạng thái nghiệp vụ suy đoán từ dữ liệu cũ.

**Các hợp đồng dữ liệu cần thiết kế trước UI mới:**

- Trạng thái vận hành có nguyên nhân, độ mới, thời điểm cập nhật, lần quét kế tiếp; một nguồn sự thật cho Desktop/Extension.
- Radar published version và working draft độc lập; preview định danh snapshot.
- Editor và validator theo field type ở cả client/server.
- Read state độc lập CRM; feedback độc lập công việc.
- Follow-up có vòng đời và worker/idempotency, không chỉ timestamp.
- Notification effective config theo radar và delivery state theo kênh.
- View state và pagination thống nhất, có bảo vệ response cũ và draft chưa lưu.

## 7. Cách kiểm chứng hiệu quả của cuộc cải tổ

Các con số dưới đây là **mục tiêu đề xuất**, không phải baseline đã đo:

| Chỉ số | Cách đo | Mục tiêu ban đầu |
|---|---|---|
| Hiểu trạng thái radar | Hỏi người dùng “có đang tự quét không, vì sao?” | Ít nhất 4/5 người thử trả lời đúng không cần mở log |
| Tới kết quả đầu tiên | Từ bắt đầu tới xem được preview hữu ích khi kết nối đã sẵn sàng | Thử mục tiêu dưới 5 phút; đo riêng thời gian cài phụ thuộc |
| Xử lý một cơ hội | Mở tin → hành động liên hệ → ghi kết quả/đặt lịch | Hoàn tất trong một ngữ cảnh, không chuyển qua màn cấu hình |
| Độ đúng dữ liệu | Roundtrip tiền/range/date và export | Không sai giá trị/đơn vị trong tập chấp nhận đã định nghĩa |
| Giữ công việc | Chuyển màn, nhận event, lưu một nhóm settings | Không mất draft ngoài hành động bỏ thay đổi có chủ đích |
| Phục hồi lỗi | Ngắt Chrome/AI, tắt auto, preview lỗi | Luôn chỉ rõ trạng thái và hành động tiếp theo phù hợp |
| Khả năng duyệt | Dataset trên 50/100 lead và nhiều radar | Không có giới hạn ẩn; phạm vi và tổng nhất quán |

Nên thử với 5 người đúng nhóm mục tiêu, gồm người chưa quen CLI và người đã có workflow săn tin. Giao nhiệm vụ, không chỉ hỏi thích màu nào: tạo radar, tìm lý do chưa có tin, xử lý một khách, sửa ngân sách, đặt lịch, tìm lại tin cũ, bỏ sót và khôi phục một nguồn.

### Bộ tình huống nghiệm thu tối thiểu

1. Cài lần đầu chưa có Chrome/AI/Telegram; mỗi trường hợp có lối đi phù hợp và không báo sẵn sàng giả.
2. Extension kết nối nhưng automatic scanning tắt; Desktop phản ánh đúng.
3. Radar active nhưng không có nguồn sử dụng được; chẩn đoán rõ.
4. Preview lỗi, hủy, mất event, hoàn tất 0 bài; không treo và không publish ngầm.
5. Đóng/mở lại draft; thay đổi source trong preview không tác động cấu hình live.
6. Nhập tiền Việt Nam, khoảng, enum và ngày; lưu/mở lại/export đúng kiểu.
7. Đặt 15:00 theo giờ địa phương; mở lại/lưu lại giữ nguyên; nhắc việc thật được kiểm chứng.
8. Có trên 50 tin và nhiều radar; Inbox tải hết, rejected không sai phạm vi.
9. Đang gõ ghi chú/settings thì lead mới đến; nội dung không bị ghi đè.
10. Mở cùng lead từ Inbox/Bảng/Liên hệ; read state và CRM nhất quán.
11. Thiếu hoặc lỗi kênh thông báo; phân biệt lead đã tạo với tin đã gửi.
12. 1024×768, 1366×768; keyboard-only qua navigation, danh sách, modal và form.

## 8. Bằng chứng và giới hạn cuối cùng

Ảnh chụp từ mock UI, dữ liệu nhân vật/tin là fixture:

- [Inbox tại 1366×768](evidence/inbox-1366.png).
- [Inbox tại 1024×768](evidence/inbox-1024.png).
- [Settings tại 1366×768](evidence/settings-1366.png).

Tái hiện đã ghi nhận:

| Thử nghiệm | Kết quả |
|---|---|
| Sửa tiền thành `15 triệu/tháng` | Hiển thị `15/tháng`, cả detail và Table |
| Sửa trần AI thành 1234 rồi lưu Thông báo | Trở về 2000 |
| Biểu thức chuyển giờ hiện tại, timezone Việt Nam | 15:00 nhập → 08:00 hiện lại → lưu lại thành 01:00Z |
| Đo DOM detail tại 1024×768 | clientWidth 360, scrollWidth 401; clientHeight 616, scrollHeight 1671 |
| UI suite hiện có | 12/12 test pass; không chứng minh các vấn đề trên đã được bao phủ |

Audit không sửa source ứng dụng, không gọi AI trả phí, không gửi tin ra ngoài, không thao tác Facebook thật. Các thay đổi source đã có trước audit được giữ nguyên. Các đề xuất cấu trúc sản phẩm cần prototype và thử nhiệm vụ trước khi mở rộng triển khai; các lỗi logic đã chỉ ra có thể bắt đầu sửa ngay với kiểm chứng theo đường dữ liệu tương ứng.
