# Quyết định kiến trúc (ADR)

Trạng thái: nháp v0.1 · 2026-11-11

Mỗi mục ghi bối cảnh, quyết định, phương án đã cân nhắc và hệ quả. Trạng thái **Đã chốt** là ràng buộc bạn đã nêu; **Đề xuất** là lựa chọn của tôi, cần bạn duyệt.

---

## ADR-001: Chạy hoàn toàn tại máy, không backend

**Trạng thái:** Đã chốt (ràng buộc đầu vào).

**Bối cảnh.** Sản phẩm đọc nội dung group kín bằng phiên của người dùng và lưu thông tin liên hệ xuất hiện trong bài.

**Quyết định.** Toàn bộ thu thập, xử lý, lưu trữ nằm trên máy người dùng.

**Hệ quả.**
- (+) Dữ liệu không tập trung về một nơi; không có kho dữ liệu cá nhân để bị lộ hoặc bị yêu cầu cung cấp. Chi phí vận hành gần bằng không.
- (+) Mỗi người chỉ thấy tin từ group chính họ tham gia là hệ quả tự nhiên, không cần cơ chế phân quyền.
- (−) Radar chỉ chạy khi máy bật và Chrome mở.
- (−) Không đo được hành vi người dùng; không đếm được mức dùng để tính tiền.
- (−) Tính năng nhóm (chia tin, kho chung) không làm được nếu không thêm một dạng đồng bộ.
- (−) Bot Telegram dùng chung và kiểm tra bản quyền trực tuyến đều cần máy chủ, nên phải chọn cách khác (ADR-007, D-1).

---

## ADR-002: Native Messaging và IPC cục bộ giữa extension và desktop

**Trạng thái:** Đề xuất (repo đã đi theo hướng này).

**Bối cảnh.** Extension cần gửi bài về desktop và nhận cấu hình ngược lại.

**Phương án.**

| Phương án | Ưu | Nhược |
|---|---|---|
| **A. Native Messaging → native host → IPC cục bộ** | Không mở cổng mạng; Chrome xác thực extension qua `allowed_origins`; cổng native giữ service worker sống | Cần cài file khai báo trên từng hệ điều hành; giới hạn 1 MB cho message từ host về extension |
| B. WebSocket tới `localhost` do desktop mở | Đơn giản, không cần native host | Mọi trang web và tiến trình trên máy đều thử kết nối được; phải tự làm xác thực; phần mềm bảo mật hay chặn |
| C. Extension ghi file, desktop theo dõi thư mục | Rất đơn giản | Extension không ghi file tuỳ ý được; một chiều |

**Quyết định.** Phương án A. Native host là tiến trình chuyển tiếp không trạng thái; app desktop là tiến trình sống lâu sở hữu cơ sở dữ liệu.

**Vì sao không để native host tự làm hết.** Chrome khởi chạy và tắt native host theo vòng đời của extension; nhiều profile sinh nhiều tiến trình. App cần một tiến trình duy nhất giữ SQLite, hàng đợi AI và giao diện.

**Hệ quả.** Cần bước "Kết nối Chrome" trong trình cài đặt để ghi file khai báo. Message lớn phải chia nhỏ ([Giao thức §5](../specs/01-protocol.md#5-giao-nhận)).

---

## ADR-003: Giao diện desktop bằng Tauri 2

**Trạng thái:** Đề xuất. `apps/desktop/Cargo.toml` ghi rõ chưa chọn (egui / Tauri / Slint).

**Bối cảnh.** Giao diện chủ yếu là bảng dữ liệu có cột động, form nhiều bước, danh sách có lọc và tìm kiếm, văn bản tiếng Việt có tô sáng.

| Phương án | Ưu | Nhược |
|---|---|---|
| **Tauri 2 + React/TS** | Hệ sinh thái bảng, form, i18n có sẵn; chung công cụ với extension; có sẵn khay hệ thống, tự khởi động, tự cập nhật, đơn thể | Hai ngôn ngữ; phụ thuộc WebView của hệ điều hành |
| egui | Thuần Rust, một tệp chạy | Bảng lớn, form phức tạp, chữ có dấu và tô sáng đều phải tự làm; giao diện kém quen thuộc với người dùng phổ thông |
| Slint | Thuần Rust, khai báo | Hệ sinh thái thành phần nhỏ; giấy phép cần xem cho sản phẩm thương mại |

**Quyết định.** Tauri 2, giao diện React + TypeScript + Vite đặt ở `apps/desktop/ui`.

**Hệ quả.** Toàn bộ nghiệp vụ nằm trong các crate Rust, giao diện chỉ gọi lệnh ([Desktop §4](../specs/03-desktop.md#4-lệnh-cho-giao-diện)). Nếu sau này đổi khung giao diện, phần nhân không đổi.

---

## ADR-004: SQLite làm kho dữ liệu duy nhất

**Trạng thái:** Đề xuất.

**Quyết định.** Một file SQLite trong thư mục dữ liệu của app, truy cập qua `rusqlite` (tính năng `bundled`), chế độ WAL, FTS5 cho tìm toàn văn, migration đánh số trong `crates/store/migrations/`.

**Vì sao.** Không cần cài đặt hay tiến trình riêng; sao lưu là chép một file; đủ nhanh cho quy mô một người dùng (ước tính dưới 5 triệu bài sau một năm ở gói cao nhất); FTS5 hỗ trợ tách từ không dấu qua `remove_diacritics`.

**Đã cân nhắc.** `sqlx` (kiểm tra truy vấn lúc biên dịch, nhưng bất đồng bộ không mang lại gì cho SQLite cục bộ và làm việc build phức tạp hơn); kho nhúng dạng khoá–giá trị (mất khả năng truy vấn linh hoạt mà bảng tin cần).

**Hệ quả.** Trường của radar là động nên giá trị đã trích lưu dạng JSON và truy vấn bằng hàm JSON của SQLite; cột lọc thường dùng có thể thêm chỉ mục biểu thức. Mọi thao tác ghi đi qua một luồng ghi duy nhất.

---

## ADR-005: AI qua tiến trình con gọi CLI

**Trạng thái:** Đã chốt (ràng buộc đầu vào); cách thực hiện là đề xuất.

**Bối cảnh.** App phải dùng được AI qua `claude`, `codex`, `agy` có sẵn trên máy người dùng.

**Quyết định.** Một giao diện `AiProvider` với một adapter cho mỗi CLI. Mỗi lần gọi là một tiến trình con chạy chế độ không tương tác, đầu ra JSON có ràng buộc bằng JSON Schema, mọi công cụ của agent bị tắt, thư mục làm việc là thư mục rỗng do app tạo.

**Hệ quả.**
- (+) Không quản lý API key; người dùng dùng gói thuê bao sẵn có.
- (−) Mỗi lần gọi tốn vài giây khởi động, nên bắt buộc gom lô và hàng đợi.
- (−) Hạn mức theo gói của người dùng; radar nhiều bài có thể làm cạn hạn mức họ cần cho việc khác. Đây là lý do tầng bộ luật (ADR-006) là thiết yếu chứ không phải tối ưu.
- (−) Cờ dòng lệnh thay đổi theo phiên bản CLI; adapter phải dò khả năng lúc chạy.
- (−) Điều khoản của từng nhà cung cấp về việc dùng gói thuê bao cho tác vụ tự động cần được kiểm tra; xem [Rủi ro R-6](../delivery/03-risks-compliance.md#2-sổ-rủi-ro).
- Giao diện provider để sẵn chỗ cho adapter gọi API trực tiếp bằng khoá và mô hình chạy tại máy (D-7).

---

## ADR-006: Bộ luật là DSL khai báo, không phải mã do AI sinh

**Trạng thái:** Đề xuất.

**Bối cảnh.** Bản ý tưởng muốn "AI phân tích và gen ra code có khả năng lọc/phân loại nội dung tin cho các lần sau mà không cần AI can thiệp nữa nếu có thể".

| Phương án | Ưu | Nhược |
|---|---|---|
| A. AI sinh mã (JS/Python/Rust) rồi chạy | Diễn đạt được mọi thứ | Chạy mã không tin cậy trên máy người dùng; không kiểm tra tĩnh được; khó giải thích cho người dùng; cần môi trường chạy kèm |
| **B. AI sinh bộ luật JSON theo DSL cố định, bộ máy Rust thực thi** | An toàn; kiểm tra được bằng schema; đo được từng luật; hiển thị và sửa được trên giao diện; nhanh | Chỉ diễn đạt được thứ DSL hỗ trợ |
| C. Mã kịch bản trong hộp cát (Rhai, WASM) | Linh hoạt hơn B, an toàn hơn A | Phức tạp; vẫn khó giải thích |

**Quyết định.** Phương án B. DSL gồm ba phần: lọc sơ bộ, phân loại, trích trường, dựa trên từ khoá, biểu thức chính quy và các bộ trích dựng sẵn (tiền, SĐT, địa danh, diện tích). Nếu về sau có trường hợp DSL không diễn đạt được, mở rộng DSL trước, và chỉ xét phương án C khi việc đó lặp lại nhiều lần.

**Hệ quả.** Bộ luật không thay thế hẳn AI. Mục tiêu thực tế: loại chắc chắn phần lớn bài không liên quan, tự trích các trường có dạng cố định, và chỉ đẩy lên AI phần mơ hồ. Bộ luật BĐS tiếng Việt có sẵn được chuyển sang cùng định dạng làm bộ luật khởi đầu.

---

## ADR-007: Telegram bằng bot do người dùng tự tạo

**Trạng thái:** Đề xuất (D-2).

**Bối cảnh.** Bot API của Telegram yêu cầu token của bot để gửi tin. Một bot dùng chung cho mọi người dùng nghĩa là token đó phải nằm ở nơi người dùng không đọc được, tức là một máy chủ.

**Quyết định.** Mỗi người dùng tạo bot riêng qua BotFather và dán token vào app. App gọi thẳng Bot API từ máy người dùng.

**Hệ quả.**
- (+) Giữ đúng ràng buộc không backend. Nội dung tin đi thẳng từ máy người dùng tới Telegram.
- (+) App đọc được nút bấm trên tin (qua `getUpdates`), cho phép phản hồi đúng/sai từ điện thoại.
- (−) Thêm khoảng 2 phút và 4 thao tác vào lần cài đầu; cần hướng dẫn có hình.
- Nếu đo thấy bước này làm rơi nhiều người dùng, phương án lùi là một dịch vụ chuyển tiếp tối thiểu chỉ nhận tin đã mã hoá và gửi đi, tức là chấp nhận một backend rất mỏng. Quyết định đó để sau khi có số liệu.

---

## ADR-008: Desktop quyết định lịch quét, extension thực thi

**Trạng thái:** Đề xuất.

**Bối cảnh.** Lịch quét phụ thuộc vào radar nào đang chạy, group nào sôi động, và ngân sách an toàn toàn cục.

**Quyết định.** Desktop tính và đẩy xuống một **kế hoạch quét** (danh sách nguồn kèm chu kỳ và ngân sách). Extension tự đặt báo thức theo kế hoạch và thực thi, kể cả khi tạm thời không nhận được lệnh mới, miễn là kết nối còn. Extension tự áp dụng các chặn cứng (trần tải mỗi giờ và mỗi ngày, giờ hoạt động, dừng khi phát hiện phiên có vấn đề) để một lỗi ở desktop không thể khiến extension quét quá mức.

**Hệ quả.** Chính sách an toàn được thực thi ở hai lớp. Thay đổi chính sách không cần phát hành lại extension, trừ các chặn cứng.
